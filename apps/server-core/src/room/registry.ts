// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:register/reconnect/refresh-code,
//     mobile:pair/reconnect, mobile:list-pcs)
//   docs/rebuild/05-DATA-MODEL.md §1/§7 (device rows, token model)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (short-code active-only lookup)
//   Ported mechanism from legacy room/registry.ts; error codes are protocol
//   ErrorCodes (ServerError), not a legacy RegistryError enum.
//
// Mints/looks up the persistent PcRecord / MobileRecord rows for pairing and
// reconnect. Pure over the repos + token/uuid deps; the in-memory RoomStore is
// updated by the socket handlers, not here.
//
import { randomInt, randomUUID } from 'node:crypto';
import type { ServerMode, TargetCaps } from '@flowmic/protocol';
import { ServerError } from '../errors';
import { log } from '../log';
import { reapCrossAccountSiblings } from './cross-account-reap';
import { newToken } from '../auth/token';
import type { PlanLimits } from '../billing/plans';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import type { MobileRecord, MobileRepo } from '../db/repos/mobile.repo';
import { ShortCodeAllocationError, ShortCodeGovernor, findActivePcByCode } from './short-code';

export interface RegistryDeps {
  pcs: PcRepo;
  mobiles: MobileRepo;
  now?: () => number;
  shortCodeTtlMs?: number;
  /** Deployment mode. Device limits are a saas-only commercial boundary;
   *  standalone NOOPs. Defaults to 'standalone' (the safe, unlimited side). */
  mode?: ServerMode;
  /** EFFECTIVE limits resolver — MUST be `billing.effectiveLimits`, the single
   *  point where subscription expiry, FLOWMIC_MOCK_UNLOCK_ALL and the
   *  `permanent_free` exemption are already resolved. Never re-derive any of them
   *  here. Required in saas (constructor throws without it, so a mis-wired
   *  deployment fails loud instead of silently unlimited). */
  limitsOf?: (user_id: string) => PlanLimits;
  /** card MP-1 — the room→key edge writer. Absent on a deployment with no
   *  integrator arm, in which case `mintIntegratorRoom` is never reached (the
   *  route refuses first) — never a room minted without its key recorded, which
   *  would be a room billed to T with no sub-quota ceiling. */
  integratorKeys?: { bindRoom(pcDeviceId: string, keyId: string, createdAt: number): void };
}

// 🔴 STRUCTURAL SPLIT (WP-9, 2026-09-02) — `PairInput` / `isRealPc` /
// `CLOUD_INSTANCE_*` / `PCID_*` moved VERBATIM to `registry-shared.ts` (the
// 800-line cap; see that file's header for the full account, including WHY a
// leaf file rather than either side importing from the other). Re-exported so
// every existing `import { isRealPc } from '../room/registry'`
// (console-routes.ts and others) keeps working unchanged.
export * from './registry-shared';
// card NR-29 (2026-09-10) - the GA-16 device-slot family (its header paragraph,
// `countMobileDevices`, and the six members that count and refuse) moved VERBATIM
// to `device-slots.ts`; see that file's header for what moved and why it moved
// now. Re-exported for the same reason `registry-shared` is: `console-routes.ts`
// imports `countMobileDevices` from HERE, and one arithmetic reached by two
// import paths is one arithmetic with two futures.
export * from './device-slots';
import { makeDeviceSlots, type DeviceSlots } from './device-slots';
import {
  isRealPc, occupiesMobileSlot, sanitizeClientInstanceId, type PairInput,
  CLOUD_INSTANCE_ID, CLOUD_INSTANCE_SHORT_CODE, CLOUD_INSTANCE_PC_NAME,
  PCID_DIGITS, PCID_SPACE,
} from './registry-shared';
import { resolvePcForPair as resolvePcForPairImpl } from './registry-pair-resolve';
import { serializeTargetCaps } from './target-caps';
import { ensureWebRoom, type WebRoomOutcome } from './web-room';
import { mintIntegratorRoom, type IntegratorRoomOutcome } from './integrator-room';

export class Registry {
  private readonly codes: ShortCodeGovernor;
  /** card S2-04b — the per-account gate `ensureWebRoom` chains through.
   *  IN-PROCESS ONLY: cross-node duplication is already impossible by
   *  construction (router.ts's replica guard answers every non-GET `/api/*`
   *  with 421 before this class is ever reached), so only two requests on the
   *  SAME writer can race. Self-cleaning: an entry drops once nothing chains
   *  after it, so size tracks in-flight calls, not accounts ever seen. */
  private readonly webRoomLocks = new Map<string, Promise<void>>();
  /** card NR-29 - the GA-16 ceilings, unchanged in behaviour and now next door. */
  private readonly slots: DeviceSlots;
  constructor(private readonly deps: RegistryDeps) {
    this.slots = makeDeviceSlots(deps);
    this.codes = new ShortCodeGovernor(deps.pcs, deps.now ?? Date.now, deps.shortCodeTtlMs);
    if (deps.mode === 'saas' && !deps.limitsOf) {
      throw new Error(
        'registry: saas mode requires limitsOf (billing.effectiveLimits) for GA-16 device limits ' +
          '(0.2.38 replaced planOf — a Plan can no longer express the permanent_free exemption)',
      );
    }
  }

  private allocateCode(ownerId?: string): string {
    try {
      return this.codes.allocate(ownerId);
    } catch (err) {
      if (err instanceof ShortCodeAllocationError) throw new ServerError('PAIR_INVALID_CODE', err.message);
      throw err;
    }
  }

  // ── 0.2.66 PCID (owner 2026-08-14) ────────────────────────────────────────
  // docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
  //
  // A PCID is the PUBLIC half of a cloud pairing: it says WHICH PC, while the
  // 4-digit short code still says WHAT THE SECRET IS. Before it, the code was
  // both — and `pcs.listByShortCode` is a flat, tenant-wide 10^4 namespace, so a
  // guessed code landed on whichever tenant was pairing at that moment.

  /** Draw an unused 9-digit PCID and write it onto `pcId`.
   *
   *  🔴 UNIQUENESS IS THE DATABASE'S ANSWER, not ours. The write can throw
   *  SQLITE_CONSTRAINT on the partial unique index (connection.ts), and that
   *  throw IS the collision check — we retry with a fresh draw. The tempting
   *  shape (`findByPcid` first, then write) is a check-then-act race with no
   *  lock behind it: two registrations drawing the same number in the same tick
   *  would both see 「free」 and the second write would still fail, just later and
   *  somewhere less obvious.
   *
   *  Returns the PCID, or null when every attempt collided. Null is deliberately
   *  not fatal to a registration: a PC with no PCID is exactly a pre-0.2.66 PC
   *  (it simply cannot be addressed by PCID until its next register backfills
   *  one), whereas throwing here would take down a registration that has nothing
   *  wrong with it. At a fleet of N machines the chance of 8 consecutive
   *  collisions is (N/10^9)^8 — for any plausible N that is not a number this
   *  system will ever meet. */
  private mintPcid(pcId: string): string | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = String(randomInt(0, PCID_SPACE)).padStart(PCID_DIGITS, '0');
      try {
        this.deps.pcs.setPcid(pcId, candidate);
        return candidate;
      } catch {
        // Collided with a live PCID (or lost a race to one). Draw again.
      }
    }
    log.warn('pcid.mint_exhausted', { pc_id: pcId });
    return null;
  }

  /** Give this row a PCID if it should have one and does not yet.
   *
   *  Two conditions, both load-bearing:
   *  · SAAS ONLY — owner 2026-08-14: "the local LAN … has no PCID". Minting one in
   *    standalone would create a value with no reader anywhere in the product,
   *    which is this repo's #1 historical defect class (anti-façade), and it would
   *    make the LAN pairing dialog have to explain a number that means nothing.
   *  · REAL PCs ONLY — the F-3140 cloud-instance row is not a machine anyone can
   *    pair with by address (same reason its short code `'0000'` is never
   *    stamped active).
   *
   *  Backfill is LAZY BY DESIGN — this runs on BOTH connection legs (registerPc
   *  and reconnectPc, 0.3.1), so a row acquires its PCID the next time that PC
   *  connects, exactly like `stampMachineUid`. It originally ran on the register
   *  leg only, which left every established desktop (valid token ⇒ reconnects
   *  forever) without a PCID — see the reconnectPc call site. There is
   *  deliberately no table sweep: a row that has never reached the relay cannot
   *  be paired by PCID anyway, because its PCID has never been
   *  displayed to a human. */
  private stampPcid(pc: PcRecord): void {
    if (this.deps.mode !== 'saas') return;
    if (!isRealPc(pc)) return;
    if (pc.pcid) return;
    const minted = this.mintPcid(pc.id);
    // A backfill is a ONE-TIME event per row (the value never rotates), worth
    // its own line: 「这台 PC 的 pcid 是什么时候补上的」 is the first question
    // the 0.3.1 reconnect-leg fix gets asked in production. Doubles as the
    // OPS-4 deploy byte criterion for that fix.
    if (minted) log.info('pcid.backfilled', { pc_id: pc.id });
  }

  /** GA-10 — rename ONE pc_devices row (04 §3.7 F-3101). Caller has already
   *  proven ownership; this is the storage verb, deliberately with no policy in
   *  it. The same row backs the web console's device list, so a desktop rename
   *  reaches the console with no second write path. */
  renamePc(pc_device_id: string, device_name: string): void {
    this.deps.pcs.setDeviceName(pc_device_id, device_name);
  }

  /** v0.2.4 — "is this the same machine", resolved in a deliberate order.
   *
   *  ① `client_instance_id` — EXACTLY the pre-0.2.4 behaviour, first, always.
   *     Every already-installed desktop keeps landing on its own row, so this
   *     change cannot move an existing machine or orphan its pairings.
   *  ② `machine_uid` — the new fallback, and the case ① structurally cannot
   *     cover: a reinstall (or any lost credentials file) mints a BRAND NEW
   *     instance id, so ① misses and the machine used to become a second PC
   *     row while every phone paired to the first one was left pointing at a
   *     row nothing would ever connect to again.
   *  ③ neither ⇒ a genuinely new machine.
   *
   *  ② takes the NEWEST row when several share a uid, because a pre-0.2.4
   *  database can already contain the duplicates this exists to stop making.
   *
   *  Why the uid folds in the Windows user (pc_name.rs): without it, two
   *  Windows accounts on ONE machine under ONE FlowMic account would resolve
   *  to each other's row through ②, each rotating the other's token — an
   *  endless re-register ping-pong. The credential store is already
   *  user-scoped (DPAPI), so 「this Windows account on this machine」 is the
   *  honest unit anyway. */
  registerPc(input: {
    device_name: string;
    user_id: string;
    client_instance_id?: string;
    machine_uid?: string;
    /** card S2-01 — what the end holding this row says about itself. Recorded,
     *  never consulted: nothing in registration branches on any of the three,
     *  and `client_version` in particular is a claim the client makes about
     *  itself, so a decision taken on it is a decision taken on user text. */
    client?: string;
    client_version?: string;
    target_caps?: TargetCaps;
  }): { pc: PcRecord; token: string } {
    const { pcs } = this.deps;
    // SECURITY — `client_instance_id` on this leg is a CLIENT FRAME
    // (pc.handler.ts passes `parsed.data.client_instance_id` straight
    // through). Sanitize BEFORE it is used for lookup, adoption or insert:
    // see registry-shared.ts `sanitizeClientInstanceId` for why the reserved
    // `CLOUD_INSTANCE_ID` literal must never reach a write from here.
    const client_instance_id = sanitizeClientInstanceId(input.client_instance_id);
    const existing =
      (client_instance_id
        ? pcs.findByClientInstance(input.user_id, client_instance_id)
        : null) ??
      (input.machine_uid ? (pcs.listByMachineUid(input.user_id, input.machine_uid)[0] ?? null) : null);
    if (existing) {
      // Re-register the same physical PC: rotate token + short code, keep row.
      const token = newToken();
      pcs.setToken(existing.id, token);
      const shortCode = this.allocateCode(existing.id);
      pcs.setShortCode(existing.id, shortCode);
      this.codes.stamp(existing.id, shortCode);
      pcs.setOnline(existing.id, true);
      // Adopt the credentials this machine is presenting NOW, so the next
      // registration resolves through ① directly and ② stays the rare path.
      // Best-effort on both: losing the unique-index race must not fail a
      // registration (see PcRepo.adoptClientInstance).
      if (client_instance_id && existing.client_instance_id !== client_instance_id) {
        pcs.adoptClientInstance(existing.id, client_instance_id);
      }
      this.stampMachineUid(existing, input.machine_uid);
      // 0.2.66 — backfill a PCID onto a row that predates the column. No-op once
      // it has one: a PCID is STABLE for the life of the row, unlike the short
      // code two lines up which is rotated on purpose. Rotating it here would
      // silently invalidate a number the user may have written down.
      this.stampPcid(existing);
      // card S2-01 — the row now describes THIS occupant. Unconditional, and it
      // overwrites: see stampClientDeclaration.
      this.stampClientDeclaration(existing.id, input);
      return { pc: pcs.findById(existing.id) ?? existing, token };
    }
    // GA-16: past the `existing` return, this is a genuinely NEW device row —
    // the only registerPc path that consumes a plan slot.
    this.slots.ensurePcSlot(input.user_id);
    const token = newToken();
    const shortCode = this.allocateCode();
    const pc = pcs.insert({
      id: randomUUID(),
      user_id: input.user_id,
      device_name: input.device_name,
      client_instance_id: client_instance_id ?? null,
      machine_uid: input.machine_uid ?? null,
      client: input.client ?? null,
      client_version: input.client_version ?? null,
      target_caps: serializeTargetCaps(input.target_caps),
      device_token: token,
      room_uuid: randomUUID(),
      short_code: shortCode,
    });
    this.codes.stamp(pc.id, pc.short_code);
    pcs.setOnline(pc.id, true);
    this.stampPcid(pc); // 0.2.66 — a brand-new saas row gets its PCID here.
    return { pc: pcs.findById(pc.id) ?? pc, token };
  }

  /**
   * card S2-01 — record what the end holding this PC row just declared about
   * itself: which kind of client it is, its version, and what it can receive.
   *
   * 🔴 CALLED FROM BOTH ADMISSION LEGS, and the reconnect one is the one that
   * matters in production. A desktop registers when it FIRST pairs and
   * reconnects by token forever after, so a declaration collected only at
   * register would be collected from almost nobody — the exact trap `pcid` fell
   * into (「register-only backfill proved unreachable for established desktops」,
   * db/schema.ts), which cost a whole release to notice.
   *
   * 🔴 IT OVERWRITES, INCLUDING WITH NULL, and that is not carelessness. All
   * three fields describe the CURRENT occupant of the row, and a frame that says
   * nothing is a client saying「I make no claim」. Filling only NULLs would let a
   * row keep advertising `image:true` on behalf of a build that has since been
   * replaced by one that cannot take images — a capability nobody currently
   * present has declared. Absence has to be able to travel.
   */
  private stampClientDeclaration(
    pc_device_id: string,
    input: { client?: string; client_version?: string; target_caps?: TargetCaps },
  ): void {
    this.deps.pcs.setClientDeclaration(pc_device_id, {
      client: input.client ?? null,
      client_version: input.client_version ?? null,
      target_caps: serializeTargetCaps(input.target_caps),
    });
  }

  /**
   * card S2-01 — the `pc:reconnect` leg's way in. Public because the handler
   * calls it directly: reconnect resolves its row by token in the auth
   * middleware and never passes through `registerPc`.
   */
  notePcClientDeclaration(
    pc_device_id: string,
    input: { client?: string; client_version?: string; target_caps?: TargetCaps },
  ): void {
    this.stampClientDeclaration(pc_device_id, input);
  }

  /** Write the machine uid onto `pc` when the client claims one and the stored
   *  value differs. This is how a row that predates 0.2.4 acquires its uid —
   *  on the very next connection, with no migration that has to guess. */
  private stampMachineUid(pc: PcRecord, machine_uid?: string): void {
    if (!machine_uid || pc.machine_uid === machine_uid) return;
    this.deps.pcs.setMachineUid(pc.id, machine_uid);
  }

  /** card S2-04 — the browser target's room. Whole account (why it is not a
   *  branch of `registerPc`, what the TTL does and does not enforce, and the
   *  cascade ruling) in `room/web-room.ts`; this is only the seam that lends it
   *  the two private things it needs — the short-code governor and PCID minting.
   *
   *  🔴 THE FOUR CLOSURES ARE THE POINT. Handing that module the whole
   *  `Registry` would have given a row-minting helper the pairing surface, the
   *  device ceilings and the cross-account reaper as well; handing it four named
   *  capabilities means the list of things it can do is readable at its own
   *  `WebRoomDeps`. Same reason `reapCrossAccountSiblings` below takes two repos
   *  rather than `this`.
   *
   *  card S2-04b — SERIALIZED PER ACCOUNT on top of that seam: a repeat build
   *  call from the SAME account must never observe「no room yet」twice and mint
   *  two rows. The module function above is pure with no lock of its own, so
   *  the ONE writer of `pc_devices` for this account is serialized here,
   *  per-user_id rather than one global lock (two DIFFERENT accounts never wait
   *  on each other). Queued work is awaited first regardless of outcome
   *  (`.then(noop, noop)`) so one throw can never wedge later calls. DB
   *  backstop for what this misses: web-room.ts's insert catch + `idx_pc_devices_web_room_owner`. */
  ensureWebRoom(user_id: string, opts?: { ttlMs?: number }): Promise<WebRoomOutcome> {
    const prior = this.webRoomLocks.get(user_id) ?? Promise.resolve();
    const result = prior.then(() => ensureWebRoom({
      pcs: this.deps.pcs,
      mobiles: this.deps.mobiles,
      allocateCode: (ownerId) => this.allocateCode(ownerId),
      stampCode: (pcId, code) => this.codes.stamp(pcId, code),
      codeIsActive: (pcId) => this.codes.isActive(pcId),
      stampPcid: (pc) => this.stampPcid(pc),
      now: this.deps.now ?? Date.now,
    }, user_id, opts));
    const settled = result.then(() => undefined, () => undefined);
    this.webRoomLocks.set(user_id, settled);
    // Only drop if nothing newer replaced it — a call that arrived WHILE this
    // one was in flight already overwrote the map with its own `settled`.
    void settled.then(() => {
      if (this.webRoomLocks.get(user_id) === settled) this.webRoomLocks.delete(user_id);
    });
    return result;
  }

  /**
   * card MP-1 — a room for a third-party host page. ALWAYS MINTS (see
   * `room/integrator-room.ts` for why an integration cannot share one room), so
   * unlike `ensureWebRoom` it takes no per-account lock: there is nothing to
   * serialize when every call is meant to produce a different row.
   */
  mintIntegratorRoom(user_id: string, key_id: string, opts?: { ttlMs?: number; deviceName?: string }): IntegratorRoomOutcome {
    return mintIntegratorRoom({
      pcs: this.deps.pcs,
      allocateCode: (ownerId) => this.allocateCode(ownerId),
      stampCode: (pcId, code) => this.codes.stamp(pcId, code),
      stampPcid: (pc) => this.stampPcid(pc),
      bindRoom: (pcId, keyId, at) => {
        const sink = this.deps.integratorKeys;
        // 🔴 THROWS RATHER THAN SHRUGS. A room minted without its key edge is a
        // room billed to the integrator with NO sub-quota ceiling; refusing to
        // create it at all is the direction that costs a page load rather than
        // an unbounded bill.
        if (!sink) throw new Error("registry: mintIntegratorRoom needs an integratorKeys sink");
        sink.bindRoom(pcId, keyId, at);
      },
      now: this.deps.now ?? Date.now,
    }, user_id, key_id, opts);
  }

  /** card ACC-1 — full account, evidence and the release-vs-revoke argument in
   *  `room/cross-account-reap.ts`; this is only the registry-facing seam. */
  reapCrossAccountSiblings(machine_uid: string | undefined, keep_user_id: string):
    Array<{ room_uuid: string; pairing_ids: string[] }> {
    return reapCrossAccountSiblings({ pcs: this.deps.pcs, mobiles: this.deps.mobiles }, machine_uid, keep_user_id);
  }

  reconnectPc(
    token: string,
    client_instance_id?: string,
    machine_uid?: string,
    // B12 (2026-09-02, WP-6) — see the parameter's own doc below.
    opts?: { skipPcidBackfill?: boolean },
  ): { pc: PcRecord } | null {
    let pc = this.deps.pcs.findByToken(token);
    if (!pc) return null;
    // SECURITY — same wire-trust hole as registerPc's, on the backfill leg: a
    // token holder could otherwise claim the reserved CLOUD_INSTANCE_ID onto
    // an already-counted row (one with client_instance_id still NULL) and
    // walk it out of isRealPc/occupiesPcSlot after the fact. Same sanitizer,
    // same reason — see registry-shared.ts.
    const safeClientInstanceId = sanitizeClientInstanceId(client_instance_id);
    if (safeClientInstanceId && pc.client_instance_id === null) {
      this.deps.pcs.claimClientInstance(pc.id, safeClientInstanceId);
      pc = this.deps.pcs.findById(pc.id) ?? pc;
    }
    // The row is already resolved by token here, so the uid is never a LOOKUP
    // on this path — only a backfill. That is what makes it safe to do on a
    // reconnect: it cannot move this connection to a different row.
    this.stampMachineUid(pc, machine_uid);
    // 0.3.1 — the PCID backfill 0.2.66 wired onto the register leg only. An
    // established desktop holds a valid token and comes in HERE forever, never
    // through registerPc, so a row predating the pcid column stayed NULL: no
    // PCID in the dialog, no pcid= in the cloud QR, and the relay (which
    // enforces PAIR_PCID_REQUIRED) refused every scan of that QR. stampPcid is
    // a no-op once the row has one, so this can never rotate an address.
    //
    // 🔴 B12 (2026-09-02, WP-6) — EXCEPT on a replica, where `opts.
    // skipPcidBackfill` is set by the caller (pc.handler.ts, from the SAME
    // `writerOnly()` guard every other per-role decision here reads). Unlike
    // `stampMachineUid`/`setOnline` just above and below — genuinely idempotent
    // writes of a value the CLIENT already knows, so a replica's copy dying at
    // the next pull loses nothing new — `stampPcid` MINTS a fresh random value
    // when the row has none. Minting it locally on a replica does not merely
    // get erased: because the writer's own row is STILL null afterwards, the
    // NEXT reconnect (same replica after a pull, or any other node) mints a
    // DIFFERENT one — a pre-0.2.66 row that only ever reconnects through a
    // replica would churn a fresh PCID on every cycle, shown to the user in the
    // pairing dialog, none of which ever persist (findings-multinode.md F10).
    // Skipping leaves the row exactly as absent as it always was for that case
    // — the pre-0.2.66 behaviour this backfill exists to improve on, never
    // worse than it, and correct again the moment this PC reaches the writer.
    if (!opts?.skipPcidBackfill) this.stampPcid(pc);
    this.deps.pcs.setOnline(pc.id, true);
    return { pc: this.deps.pcs.findById(pc.id) ?? pc };
  }

  refreshShortCode(pc_id: string): string {
    const existing = this.deps.pcs.findById(pc_id);
    if (!existing) throw new ServerError('PAIR_PC_OFFLINE', 'pc not found');
    const code = this.allocateCode(pc_id);
    this.deps.pcs.setShortCode(pc_id, code);
    this.codes.stamp(pc_id, code);
    return code;
  }

  /** 🔴 STRUCTURAL SPLIT (WP-9) — delegates to `registry-pair-resolve.ts`'s
   *  free function, VERBATIM logic, only the seam changed (`this.deps` /
   *  `this.codes` become explicit arguments). See that file's header.
   *
   *  A second, independent extraction of this same family landed the same
   *  day (WP-6, `pairing-resolve.ts`) — byte-for-byte the same functions and
   *  constants, just combined into one file instead of split by concern. The
   *  WP-9 two-file split (registry-shared.ts + registry-pair-resolve.ts) is
   *  the one this tree keeps; WP-6's own pairing-resolve.ts was dropped at
   *  merge time rather than kept as a second copy of the same logic. */
  resolvePcForPair(input: PairInput): PcRecord {
    return resolvePcForPairImpl(this.deps, this.codes, input);
  }

  pairMobile(input: PairInput): { mobile: MobileRecord; pc: PcRecord; token: string } {
    const { mobiles } = this.deps;
    const pc = this.resolvePcForPair(input);

    // ── v0.2.3: RE-pairing the same handset reuses its row ────────────────
    //
    // This used to always mint. The comment even said so, and the reasoning was
    // that a phone coming back reconnects by token instead. True — but a phone
    // whose token is GONE (APK reinstall, the user deleted the entry, a fresh
    // scan of the same QR) comes back through here, and every one of those left
    // a second row behind. owner 2026-07-29 saw the result: three pairings on the
    // devices page for one handset, two of them dead, and no way to tell which.
    //
    // The PC side has never had this problem because `registerPc` recognises a
    // returning machine by `client_instance_id` and rotates its token in place.
    // This is the same move on the mobile side, keyed on the name the phone
    // sends — which since 0.1.10 is `<model>-<4-digit ANDROID_ID hash>` and therefore
    // survives a reinstall, the exact case that produced the duplicates.
    //
    // Deliberately NOT applied to the `Phone-<4>` fallback: that suffix is
    // derived from the pairing's own uuid, so it is unique per pairing and can
    // never identify a handset. A client that names nothing has no identity to
    // match on, and inventing one would merge two real phones into one row.
    //
    // v0.2.4 — the reuse key is now the handset's `device_uid` FIRST, with the
    // name kept as the fallback. v0.2.3 could only match on the name because
    // it was the only stable thing a phone sent, but a name is a label for
    // people: it may legitimately change, and matching on it silently couples
    // 「how this is displayed」 to 「which row this is」. The uid separates them.
    // The name branch stays for phones that predate the field — dropping it
    // would re-open the duplicate case for exactly the installs still on 0.2.3.
    const claimedUid = input.device_uid?.trim() ?? '';
    const claimedName = input.mobile_name?.trim() ?? '';
    if (claimedUid !== '' || claimedName !== '') {
      const onThisPc = mobiles.listByPc(pc.id);
      const existing =
        (claimedUid !== '' ? onThisPc.find((m) => m.device_uid === claimedUid) : undefined) ??
        // Only match by name when the row has NO uid of its own. A row that
        // already claims a DIFFERENT handset must not be captured because two
        // phones happen to share a label.
        (claimedName !== ''
          ? onThisPc.find((m) => m.mobile_name === claimedName && m.device_uid === null)
          : undefined);
      if (existing) {
        // A returning handset consumes NO new slot — it already had one. Same
        // reasoning as registerPc's existing branch: charging a device for
        // coming back is the off-by-one that makes a limit unrecoverable.
        const token = newToken();
        mobiles.setToken(existing.id, token);
        mobiles.touchLastSeen(existing.id, new Date().toISOString());
        // Backfill: a row matched by NAME (pre-0.2.4) now learns its uid, so
        // the next re-pair takes the ① path and the name stops being load-bearing.
        this.stampDeviceUid(existing, claimedUid);
        // card S2-01 — the SAME handset can come back as the app one day and as
        // a browser page the next (the reuse key is the device uid, not the
        // kind), so this overwrites rather than filling a NULL. A row that kept
        // the first end's answer would label a browser as a phone forever.
        mobiles.setClientOrigin(existing.id, input.client ?? null, input.client_version ?? null);
        const mobile = mobiles.findById(existing.id) ?? existing;
        return { mobile, pc, token };
      }
    }

    // Past here this is a genuinely NEW pairing — the only path that takes a slot.
    //
    // 🔴 card NR-29, REWORKED BY MP-6 — a browser tab is not a device on this
    // account, so it is not measured against the account's handset ceiling. It
    // asks `occupiesMobileSlot` about the row it is ABOUT TO WRITE, which is the
    // same predicate the count itself walks (`device-slots.ts`): one rule, one
    // reader, asked twice about the same fact.
    //
    // ⚠️ IT USED TO BE THE CALLER'S STATEMENT (`PairInput.trial_visitor`, fed by
    // `webTrialIdentities.willMint`), and that whole seam is gone. It existed for
    // a TIMING problem: the exemption was read off `trial_user_id`, which the
    // admission stamped a moment AFTER this line ran, so the ceiling judged a row
    // that would not be counted a millisecond later. MP-6 moved the predicate onto
    // `client`, which is written by this very insert — the timing problem, and
    // therefore the seam, no longer has anything to solve.
    if (occupiesMobileSlot({ client: input.client ?? null })) {
      this.slots.ensureMobileSlot(input.user_id ?? pc.user_id);
    }
    const token = newToken();
    const id = randomUUID();
    // owner 2026-07-27: the default used to be the bare literal 'Phone', so every
    // paired device on the devices page and in the "pairing succeeded" row read exactly the
    // same — with two phones the owner could not tell which row was which, nor
    // which one had just connected. Mirror the PC's own scheme (pc_name.rs:
    // FlowMic-<host>-<4>) by suffixing a short code from this pairing's uuid:
    // it is unique per pairing, stable for its lifetime, and needs no new wire
    // field. A name the phone sends itself still wins — this is only the
    // fallback for a client that names nothing.
    const shortId = id.replace(/-/g, '').slice(0, 4);
    const mobile = mobiles.insert({
      id,
      user_id: input.user_id ?? pc.user_id,
      pc_device_id: pc.id,
      mobile_token: token,
      // Store the TRIMMED name — the reuse lookup above matches on the trimmed
      // form, and storing an untrimmed one would let 「 X 」 and 「X」 fork a row.
      mobile_name: claimedName !== '' ? claimedName : `Phone-${shortId}`,
      device_uid: claimedUid !== '' ? claimedUid : null,
      client: input.client ?? null,
      client_version: input.client_version ?? null,
    });
    return { mobile, pc, token };
  }

  /** Mirror of [stampMachineUid] on the handset side. */
  private stampDeviceUid(mobile: MobileRecord, device_uid?: string): void {
    if (!device_uid || mobile.device_uid === device_uid) return;
    this.deps.mobiles.setDeviceUid(mobile.id, device_uid);
  }

  /** RV-98 — token → its pairing row and the PC that owns it, with **NO writes**.
   *
   *  Extracted as the pure core of [reconnectMobile] the moment a second caller
   *  needed the same resolution WITHOUT its side effects: `GET /api/pc/presence`
   *  (http/presence-routes.ts) is a resting instance list asking "is my computer
   *  up", which is not the phone having a session. Routing it through
   *  `reconnectMobile` would stamp `last_seen_at` on every poll — making that
   *  column answer two questions ("really connected last time" vs "just polled
   *  last time"), which is this
   *  repo's #1 bug shape. `pairing-auth.ts` already warns that reconnectMobile
   *  "must not be called speculatively"; this is the non-speculative half.
   *
   *  ONE definition, not a copy: reconnectMobile now calls this and then does its
   *  writes, so 「this token belongs to that pairing」 can never have two answers. */
  findPairingByToken(token: string): { mobile: MobileRecord; pc: PcRecord } | null {
    const mobile = this.deps.mobiles.findByToken(token);
    if (!mobile) return null;
    const pc = this.deps.pcs.findById(mobile.pc_device_id);
    if (!pc) return null;
    return { mobile, pc };
  }

  reconnectMobile(token: string, device_uid?: string): { mobile: MobileRecord; pc: PcRecord } | null {
    const resolved = this.findPairingByToken(token);
    if (!resolved) return null;
    const { mobile: found, pc } = resolved;
    this.deps.mobiles.touchLastSeen(found.id, new Date().toISOString());
    // Backfill only — the row was resolved by token, so this can never move the
    // connection to a different pairing (same argument as reconnectPc).
    this.stampDeviceUid(found, device_uid);
    const mobile = this.deps.mobiles.findById(found.id) ?? found;
    return { mobile, pc };
  }

  /** F-3140: admit a per-user cloud-instance solo session. Find-or-creates the
   *  virtual PC row + its single mobile pairing; STRICTLY idempotent — a second
   *  admission for the same user returns the SAME pc/pairing/token, never a
   *  duplicate row (the partial unique index on (user_id, client_instance_id)
   *  is the DB backstop; the find-first-then-insert here is the fast path). */
  admitCloudInstance(user_id: string): { pc: PcRecord; mobile: MobileRecord; token: string } {
    const { pcs, mobiles } = this.deps;
    let pc = pcs.findByClientInstance(user_id, CLOUD_INSTANCE_ID);
    if (!pc) {
      pc = pcs.insert({
        id: randomUUID(),
        user_id,
        device_name: CLOUD_INSTANCE_PC_NAME,
        client_instance_id: CLOUD_INSTANCE_ID,
        device_token: newToken(),
        room_uuid: randomUUID(),
        short_code: CLOUD_INSTANCE_SHORT_CODE,
      });
    }
    const existing = mobiles.listByPc(pc.id)[0];
    if (existing) return { pc, mobile: existing, token: existing.mobile_token };
    const token = newToken();
    const mobile = mobiles.insert({
      id: randomUUID(),
      user_id,
      pc_device_id: pc.id,
      mobile_token: token,
      mobile_name: 'Phone',
    });
    return { pc, mobile, token };
  }

  /** The pc_devices row behind an id, or null. Used by the ownership gate on
   *  `pc:list-mobiles` — a query is only answered after the socket's OWN device
   *  row is resolved and its user matched. */
  findPc(pc_id: string): PcRecord | null {
    return this.deps.pcs.findById(pc_id);
  }

  /** Read-only token → row. Used by IT-13 to grade pc-absence writes on the
   *  AUTH_TOKEN_EXPIRED refusal of pc:reconnect: an unresolved token must not
   *  claim a slot. Deliberately NOT reconnectPc — that path setOnline(true) and
   *  would mark a refused PC present. */
  findPcByToken(token: string): PcRecord | null {
    return this.deps.pcs.findByToken(token);
  }

  /** R6 T-8: the mobile_pairings rows belonging to ONE pc device. Returns the
   *  RAW records (mobile_token included) — the caller MUST project to the public
   *  shape before anything crosses the wire (see pc.handler `pc:list-mobiles`). */
  listMobilesForPc(pc_device_id: string): MobileRecord[] {
    return this.deps.mobiles.listByPc(pc_device_id);
  }

  /** GA-08 "revoke" — PERMANENTLY kill one pairing (05 §7: deleting the row IS
   *  the revocation; the row IS
   *  the credential, so deleting it is what makes the mobile_token dead).
   *
   *  OWNERSHIP IS ENFORCED HERE, not at the caller: the row must belong to the
   *  `pc_device_id` the socket authenticated as. A pairing of another PC — of
   *  this user or any other — is left untouched and reported as `false`, which
   *  is the SAME answer as an id that never existed (no existence oracle) and the
   *  same answer a second revoke of the same id gets (idempotent).
   *
   *  Returns whether a row was actually deleted, so the caller can report an
   *  honest count without learning WHY it was zero. */
  revokeMobile(pc_device_id: string, pairing_id: string): boolean {
    const row = this.deps.mobiles.findById(pairing_id);
    if (!row || row.pc_device_id !== pc_device_id) return false;
    this.deps.mobiles.remove(pairing_id);
    return true;
  }

  /** v0.2.3 "phone-side unpair" — the phone deletes its OWN row (mobile:unpair).
   *
   *  The mirror of [revokeMobile], and deliberately a SEPARATE method rather
   *  than a flag on it: that one authorises by "this PC owns this row", this one by
   *  "this row is the caller itself". Same table, opposite direction, different proof —
   *  folding them together would mean one of the two authorisations is being
   *  checked for the other's callers.
   *
   *  Returns the row it deleted (so the caller can notify that PC's room), or
   *  null when there was nothing to delete — the same answer a second call gets,
   *  because a retry after a dropped ack must not read as a failure.
   */
  retireMobile(pairing_id: string): MobileRecord | null {
    const row = this.deps.mobiles.findById(pairing_id);
    if (!row) return null;
    this.deps.mobiles.remove(pairing_id);
    return row;
  }

  /** Expose active-code check for the mobile-slot / observability paths. */
  isCodeActive(pc_id: string): boolean {
    return this.codes.isActive(pc_id);
  }

  /** GA-18: remaining ACTIVE lifetime of this PC's short code, in ms (0 = none).
   *  Read straight from the governor so the modal's countdown and the pairing
   *  gate agree by construction. */
  shortCodeExpiresInMs(pc_id: string): number {
    return this.codes.remainingMs(pc_id);
  }
}
