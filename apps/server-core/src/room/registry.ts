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
// GA-16 — device-count limits. PLAN_LIMITS.pcs/.mobiles (billing/plans.ts, the
// ONE place those numbers live) are enforced HERE and nowhere else, at exactly
// the two row-MINTING sites: registerPc's insert branch and pairMobile. Three
// deliberate short-circuits, mirroring QuotaGuard's shape:
//   · standalone NOOP — one user, no plans, no commercial boundary (mode gate);
//   · UNLOCK_ALL / subscription expiry / permanent_free — NOT re-decided here;
//     `limitsOf` is wired to billing.effectiveLimits, the single solver that
//     already resolves all three;
//   · reconnect/re-register never checks — an already-registered PC that comes
//     back would otherwise be locked out by its own slot (the classic off-by-one
//     that makes a limit un-recoverable). Only NEW rows consume a slot.
// This path only READS limits: no usage recorded, no ensureQuota call.
//
// 0.2.38 (D1 §6.1-bis) — the dep was `planOf: (u) => Plan` and this file called
// `planLimits(planOf(u))[kind]`. 🔴 That second derivation was a real hole, not a
// style point: `users.permanent_free` is an EXEMPTION with no tier to be
// expressed as, so an exempt owner resolves to `plan:'free'` (he bought nothing)
// and this file would have walled him at free's 2 PCs / 2 phones — a CAPABILITY
// wall, which is a product red line, and one that stays invisible until someone
// plugs in a third machine. Asking for the LIMITS deletes the second derivation.

import { randomInt, randomUUID } from 'node:crypto';
import type { ServerMode } from '@flowmic/protocol';
import { ServerError } from '../errors';
import { log } from '../log';
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
}

export interface PairInput {
  short_code?: string;
  qr_payload?: string;
  /** 0.2.66 — the PUBLIC 9-digit addressing id of the PC this phone means (04
   *  §3.1 PCID addressing). Only ever set on the short-code arm: the QR arm carries
   *  its own inside `qr_payload` and is parsed out of it in `resolvePcForPair`,
   *  so both arms reach the same code path (owner 2026-08-14: "scanning a QR
   *  and typing it by hand are the same logic"). Required in SAAS, ignored in standalone (no PCID on the LAN). */
  pcid?: string;
  mobile_name?: string;
  /** v0.2.4 — the handset's own machine-level id (protocol DeviceUid). The
   *  reuse key, in preference to the name; absent for a pre-0.2.4 phone. */
  device_uid?: string;
  user_id?: string | null;
}

// F-3140 (05 §1): the fixed "cloud instance" virtual PC row identity. Per-user,
// find-or-created on cloud admission; never online (pc_online:false), never a
// code-pairing target (its short_code is never stamped ACTIVE in the governor).
export const CLOUD_INSTANCE_ID = 'flowmic-cloud-instance';
export const CLOUD_INSTANCE_SHORT_CODE = '0000';
export const CLOUD_INSTANCE_PC_NAME = 'FlowMic Cloud';

/** 0.2.66 — the PCID shape, stated once so the arithmetic has a symbol to cite
 *  instead of a number retyped across the server, the desktop and the phone:
 *  `randomInt(0, PCID_SPACE)` zero-padded to PCID_DIGITS, so the alphabet is 0-9,
 *  the length is 9 and the space is exactly 10^9. Pinned (alphabet, length and
 *  bounds, by sampling) in test/pcid-pairing.test.ts.
 *
 *  🔴 THIS IS ADDRESSING, NOT A SECRET — do not reason about it the way
 *  SHORT_CODE_SPACE is reasoned about in short-code.ts. It is printed on the PC
 *  for anyone in the room to read, it never expires, and knowing one buys an
 *  attacker nothing on its own: pairing still requires a live 4-digit code, and
 *  that code keeps all three of its limits (5-minute TTL, per-issuance failure
 *  budget, per-IP window). The size is chosen so a PCID is comfortably typeable
 *  while a blind walk of the space is pointless, not because it is a password. */
export const PCID_DIGITS = 9;
export const PCID_SPACE = 1_000_000_000;
/** The one shape gate. Used by the resolve path AND by the tests; a second
 *  hand-written `/^\d{9}$/` somewhere else is how the desktop and the server end
 *  up disagreeing about what a PCID is. */
export const PCID_RE = /^\d{9}$/;

/** Is this a PC the USER actually registered?
 *
 *  v0.2.3 — the ONE definition. The F-3140 cloud-instance row is a virtual device
 *  the server mints on cloud admission (it has no focus window and nobody
 *  installed it), so it is not a machine anyone owns. The quota path has always
 *  known that; the console's device counter did not, and answered the same
 *  question — "how many PCs does this user have" — with `pcs.length`. owner 2026-07-29 read
 *  "Device 5 · PC 2" with exactly one PC.
 *
 *  Exported so there is nowhere left to disagree: two definitions of a real PC is
 *  how the display and the limit drift apart, and a device count that does not
 *  match the limit it is displayed next to is worse than no count. */
export function isRealPc(pc: { client_instance_id: string | null }): boolean {
  return pc.client_instance_id !== CLOUD_INSTANCE_ID;
}

export class Registry {
  private readonly codes: ShortCodeGovernor;
  constructor(private readonly deps: RegistryDeps) {
    this.codes = new ShortCodeGovernor(deps.pcs, deps.now ?? Date.now, deps.shortCodeTtlMs);
    if (deps.mode === 'saas' && !deps.limitsOf) {
      throw new Error(
        'registry: saas mode requires limitsOf (billing.effectiveLimits) for GA-16 device limits ' +
          '(0.2.38 replaced planOf — a Plan can no longer express the permanent_free exemption)',
      );
    }
  }

  // ── GA-16 device slots ────────────────────────────────────────────────────

  /** The user's REAL registered PCs. The F-3140 cloud-instance row is a virtual
   *  device the server mints on cloud admission — the user never registered it,
   *  so it must not eat a plan slot (nor may its lone auto-pairing eat a mobile
   *  slot; excluding the PC here excludes that pairing from the mobile count
   *  below too, since mobiles are counted through their owning PC). */
  private realPcs(user_id: string): PcRecord[] {
    return this.deps.pcs.listByUser(user_id).filter(isRealPc);
  }

  /** EFFECTIVE limit for one device dimension, or Infinity when unenforced.
   *  Infinity (not null) is the "unlimited" encoding so every callsite is a
   *  single `Number.isFinite` guard — identical to QuotaGuard's shape. */
  private deviceLimit(user_id: string, kind: 'pcs' | 'mobiles'): number {
    if (this.deps.mode !== 'saas') return Number.POSITIVE_INFINITY; // standalone NOOP
    const limitsOf = this.deps.limitsOf;
    // Unreachable (constructor guards it) — but never fall back to unlimited.
    if (!limitsOf) throw new Error('registry: limitsOf missing in saas mode');
    return limitsOf(user_id)[kind];
  }

  /** "Record" — owner 2026-08-02 asked for the instance limit to be "recorded
   *  and judged both on the billing page and when a PC instance connects".
   *  This is the RECORD half of the second one; the
   *  JUDGEMENT half is the throw at the callsite.
   *
   *  🔴 IT IS A SERVER LOG LINE, NOT AN `ops_audit_log` ROW, and that is a
   *  decision rather than an omission. `ops_audit_log` answers "what did **our
   *  own people** touch" (db/schema.ts table 10, verbatim): `actor_user_id` is NOT NULL and is
   *  defined as "a users.id already proven by a Bearer", and its only sanctioned writer is
   *  the admin gate (http/ops-audit-trail.ts, whose `route` parameter is a type
   *  fence over four admin-gated GETs). A user tripping his own plan ceiling on a
   *  socket handshake is not an operator action and there is no Bearer in sight;
   *  putting it in that table would make one table answer two questions — the
   *  exact defect its own DDL comment forbids one paragraph above the columns.
   *  ⚠️ Consequence, stated so nobody reads an absence as evidence: querying
   *  `ops_audit_log` for "who hit the limit" finds NOTHING, forever. It is in the server
   *  log (server.log / FLOWMIC_LOG_PATH), grep `device limit refused`.
   *
   *  `used`/`limit` both go in the line because "refused" without them cannot answer
   *  the only question worth asking next — "does he really have that many
   *  devices, or was the limit misconfigured". */
  private refuse(kind: 'pcs' | 'mobiles', user_id: string, used: number, limit: number): never {
    log.warn('device limit refused', { kind, user_id, used, limit });
    const code = kind === 'pcs' ? 'PCS_LIMIT_EXCEEDED' : 'MOBILES_LIMIT_EXCEEDED';
    const noun = kind === 'pcs' ? 'pc' : 'mobile';
    throw new ServerError(code, `${noun} limit reached (${used}/${limit})`);
  }

  /** Called ONLY before minting a new pc_devices row. */
  private ensurePcSlot(user_id: string): void {
    const limit = this.deviceLimit(user_id, 'pcs');
    if (!Number.isFinite(limit)) return;
    const used = this.realPcs(user_id).length;
    if (used >= limit) this.refuse('pcs', user_id, used, limit);
  }

  /** Called ONLY before minting a new mobile_pairings row via code pairing. */
  private ensureMobileSlot(user_id: string): void {
    const limit = this.deviceLimit(user_id, 'mobiles');
    if (!Number.isFinite(limit)) return;
    const used = this.realPcs(user_id).reduce((n, pc) => n + this.deps.mobiles.listByPc(pc.id).length, 0);
    if (used >= limit) this.refuse('mobiles', user_id, used, limit);
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
  }): { pc: PcRecord; token: string } {
    const { pcs } = this.deps;
    const existing =
      (input.client_instance_id
        ? pcs.findByClientInstance(input.user_id, input.client_instance_id)
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
      if (input.client_instance_id && existing.client_instance_id !== input.client_instance_id) {
        pcs.adoptClientInstance(existing.id, input.client_instance_id);
      }
      this.stampMachineUid(existing, input.machine_uid);
      // 0.2.66 — backfill a PCID onto a row that predates the column. No-op once
      // it has one: a PCID is STABLE for the life of the row, unlike the short
      // code two lines up which is rotated on purpose. Rotating it here would
      // silently invalidate a number the user may have written down.
      this.stampPcid(existing);
      return { pc: pcs.findById(existing.id) ?? existing, token };
    }
    // GA-16: past the `existing` return, this is a genuinely NEW device row —
    // the only registerPc path that consumes a plan slot.
    this.ensurePcSlot(input.user_id);
    const token = newToken();
    const shortCode = this.allocateCode();
    const pc = pcs.insert({
      id: randomUUID(),
      user_id: input.user_id,
      device_name: input.device_name,
      client_instance_id: input.client_instance_id ?? null,
      machine_uid: input.machine_uid ?? null,
      device_token: token,
      room_uuid: randomUUID(),
      short_code: shortCode,
    });
    this.codes.stamp(pc.id, pc.short_code);
    pcs.setOnline(pc.id, true);
    this.stampPcid(pc); // 0.2.66 — a brand-new saas row gets its PCID here.
    return { pc: pcs.findById(pc.id) ?? pc, token };
  }

  /** Write the machine uid onto `pc` when the client claims one and the stored
   *  value differs. This is how a row that predates 0.2.4 acquires its uid —
   *  on the very next connection, with no migration that has to guess. */
  private stampMachineUid(pc: PcRecord, machine_uid?: string): void {
    if (!machine_uid || pc.machine_uid === machine_uid) return;
    this.deps.pcs.setMachineUid(pc.id, machine_uid);
  }

  reconnectPc(token: string, client_instance_id?: string, machine_uid?: string): { pc: PcRecord } | null {
    let pc = this.deps.pcs.findByToken(token);
    if (!pc) return null;
    if (client_instance_id && pc.client_instance_id === null) {
      this.deps.pcs.claimClientInstance(pc.id, client_instance_id);
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
    this.stampPcid(pc);
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

  resolvePcForPair(input: PairInput): PcRecord {
    const { pcs } = this.deps;
    let code: string | undefined;
    let pcid: string | undefined;
    if (input.short_code) {
      if (!/^\d{4}$/.test(input.short_code)) throw new ServerError('PAIR_INVALID_CODE');
      code = input.short_code;
      pcid = input.pcid;
    } else if (input.qr_payload) {
      const m = /code=(\d{4})/.exec(input.qr_payload);
      if (!m) throw new ServerError('PAIR_INVALID_PAYLOAD');
      code = m[1];
      // 0.2.66 — the QR arm's PCID travels INSIDE the payload, appended after
      // `code=` (04 §3.1). Extracting it here rather than in a second parser is
      // what makes owner's "scanning a QR and typing it are the same logic" true in the code and not just
      // in the copy: from the next line on, the two arms are one path.
      // ⚠️ A phone built before 0.2.66 forwards the scanned link VERBATIM
      // (mobile wire_payloads.dart), so this finds the pcid in a new PC's QR
      // even though that phone knows nothing about PCIDs. That is not luck — it
      // is the append-after-`code=` discipline paying out (04 §3.1 rule 4).
      pcid = /pcid=(\d{9})/.exec(input.qr_payload)?.[1];
    } else {
      throw new ServerError('PAIR_INVALID_PAYLOAD');
    }
    // ── 0.2.66 · SAAS: address first, THEN check the secret ───────────────────
    // owner 2026-08-14: "the cloud relay does not support establishing a
    // connection by typing the pairing code directly". Standalone falls
    // through to the historical global-code path below — there is no PCID on the
    // LAN, and this branch must never make the LAN stricter.
    if (this.deps.mode === 'saas') return this.resolvePcByPcid(pcid, code as string);
    const rows = pcs.listByShortCode(code as string);
    const pc = findActivePcByCode(rows, (id) => this.codes.isActive(id));
    if (!pc) {
      // IT-39 — THE per-code brute-force charge, and the only one. Placed after
      // the resolve (so a legitimate pairing is never charged) and after the two
      // malformed-input throws above (so junk cannot burn codes), which makes
      // this line reachable by exactly one thing: a well-formed guess that
      // probed the code space and missed. `recordFailedGuess` decides which
      // issuance pays; see its comment in short-code.ts.
      this.codes.recordFailedGuess();
      // U3-EXPIRED-VS-INVALID (0.3.0) — the two misses are two different facts
      // and used to collapse into one code (the typo answer for an aged-out
      // code was the launch register's E4):
      //   · rows matched ⇒ this exact string IS some real PC's most recent
      //     issuance — pc_devices.short_code is a single overwritten column,
      //     so a row matches a code only while that code is the newest one —
      //     and the only way it stopped resolving is that its ACTIVE window
      //     lapsed: the TTL ran out (short-code.ts isActive), the governor's
      //     in-memory issuance table was lost to a restart, or — IT-39 — the
      //     issuance spent its failure budget and was BURNED
      //     (short-code.ts isBurned). Either way PAIR_EXPIRED_CODE's "please refresh"
      //     names the action that fixes it.
      //
      // IT-39 — HOW HONEST THIS PAIR OF ANSWERS IS, exactly, since a burn is a
      // third fact riding on a two-value vocabulary and no error code was added:
      //   · "guessed wrong" vs "this code got burned" ARE told apart, by the branch below: a
      //     string that matches nothing is PAIR_INVALID_CODE; the real, burned
      //     string is PAIR_EXPIRED_CODE. Different code, and the ACTION each
      //     names is the right one for its case.
      //   · "burned" vs "expired" are NOT told apart, and deliberately so even
      //     though isBurned could. Splitting them on the wire would tell a
      //     sprayer "your spray worked" — an oracle paid for with a red line
      //     (a new error code is an owner gate) to tell the attacker something
      //     only the attacker wants. The user-facing action is identical
      //     ("refresh") and correct in both. Recorded as a known limit of the
      //     vocabulary, not as an omission: the server-side line
      //     `short_code.burned` (short-code.ts) is where that distinction lives.
      //   · zero rows ⇒ the string matches nothing stored ⇒ PAIR_INVALID_CODE.
      // A SUPERSEDED code (its PC has since minted a newer one — re-register or
      // refreshShortCode) lands in the second bucket BY CONSTRUCTION: every
      // re-mint writes the new code over the same column (pc.repo.ts
      // setShortCode) in the same breath as it stamps the governor, so the old
      // string matches zero rows and is physically indistinguishable from one
      // that never existed. Deciding 「expired」 for it would need a
      // code-history table (a DB migration — an owner gate); we implement the
      // distinguishable subset and document the limit here.
      // The isRealPc filter is load-bearing twice over: the F-3140
      // cloud-instance rows hold the well-known constant '0000' and are never
      // stamped ACTIVE, so without it that constant would answer "expired,
      // please refresh" forever — false (no refresh can ever activate it) and an
      // existence oracle over a code every probe knows. EXPIRED is only
      // emitted when the probed string matches a real PC's stored issuance; a
      // guess that matches nothing keeps reading PAIR_INVALID_CODE, and the
      // brute-force gate (pair-rate-limit) throttles both answers alike.
      if (rows.some(isRealPc)) {
        throw new ServerError('PAIR_EXPIRED_CODE', 'code was issued but its active window lapsed');
      }
      throw new ServerError('PAIR_INVALID_CODE', 'no active PC for code');
    }
    return pc;
  }

  /** 0.2.66 — the SAAS resolve: the PCID says WHICH PC, the code says WHETHER.
   *
   *  🔴 WHAT THIS REPLACES, because the shape of the old bug is the whole point.
   *  The standalone path below asks `listByShortCode(code)` — the one PC lookup
   *  in this repo with no user dimension — and takes the newest ACTIVE row. On a
   *  single-machine deployment that is exactly right (there is one user). On the
   *  multi-tenant relay it meant the 4-digit code was the ONLY addressing the
   *  protocol had (short-code.ts says so in its own words), so a guessed code
   *  paired the guesser with whichever stranger happened to be pairing right
   *  then. One value was answering two questions — 「which PC」 and 「prove it」 —
   *  which is this repo's #1 documented defect shape.
   *
   *  ORDER IS LOAD-BEARING: address, then secret. Resolving the row first means
   *  the code is checked against ONE row's own issuance instead of probing a
   *  shared namespace, and it gives a wrong guess a victim to be charged to (see
   *  the recordFailedGuess call below, and IT-39-a in short-code.ts for why 「who
   *  pays」 was previously a heuristic).
   *
   *  WHAT DOES NOT CHANGE: the code keeps every limit it had (5-minute TTL,
   *  per-issuance failure budget, per-IP window in pair-rate-limit.ts). A PCID is
   *  public addressing — it is not a second factor and must never be described as
   *  one. */
  private resolvePcByPcid(pcid: string | undefined, code: string): PcRecord {
    // ① No PCID at all — the refusal owner's ruling exists to produce. It fires
    // BEFORE any lookup and before any failure accounting: nothing about this
    // frame probed the code space, so charging it would let a malformed client
    // burn a stranger's live code for free (the same reasoning that keeps the
    // malformed-input throws above the charge site on the standalone path).
    //
    // 🔴 This is the one refusal on this path the USER CAN FIX, so it must stay a
    // code of its own — the phone force-shows its PCID field on seeing it, which
    // is what rescues a user whose endpoint heuristic guessed 「LAN」 wrongly
    // (apps/mobile/lib/src/ui/add_pairing_sheet.dart).
    if (!pcid) throw new ServerError('PAIR_PCID_REQUIRED', 'cloud pairing requires a pcid');
    // ② Shape and existence collapse into ONE answer deliberately. Both mean
    // 「that PCID does not name a PC」 and both are fixed by the same action
    // (re-read the number on the PC); splitting them would only tell a prober
    // which of their guesses were well-formed.
    if (!PCID_RE.test(pcid)) throw new ServerError('PAIR_PCID_UNKNOWN', 'malformed pcid');
    const pc = this.deps.pcs.findByPcid(pcid);
    // `isRealPc` is load-bearing here for the same reason it is on the standalone
    // path: the F-3140 cloud-instance row must never be reachable by address.
    // Today it cannot even hold a pcid (stampPcid skips it), so this is a belt
    // on top of braces — kept because the cost is one call and the failure it
    // prevents is 「a phone pairs with a virtual PC that has no focus window」.
    if (!pc || !isRealPc(pc)) throw new ServerError('PAIR_PCID_UNKNOWN', 'no pc for pcid');
    // ③ Now, and only now, the secret — checked against THIS row's own issuance.
    const matches = pc.short_code === code;
    if (matches && this.codes.isActive(pc.id)) return pc;
    // A miss. Charge it to the PC that was actually attacked: unlike the
    // standalone path, a guess here CARRIES its victim, so IT-39-a's
    // "most-exposed live issuance" heuristic is not needed and not used. One
    // consequence worth stating: a sprayer can now aim a burn at a PC whose PCID
    // they know, where before they could not aim at all — but they can only ever
    // burn the code of the PC they name, never a bystander's, and the cure is
    // unchanged (press "refresh"). The cross-tenant blast radius IT-39-a was written
    // to bound is gone from this path entirely, because a bare code no longer
    // reaches a lookup at all (it dies at ① above).
    this.codes.recordFailedGuess(pc.id);
    // Same two-value vocabulary as the standalone path, same reasoning: the code
    // this row is CURRENTLY showing but which is no longer live (TTL lapsed,
    // governor restarted, or burned) is 「expired, refresh it」; anything else is
    // 「that code is not this PC's」. Burned vs expired stay indistinguishable on
    // the wire on purpose — see the long note on the standalone path.
    if (matches) throw new ServerError('PAIR_EXPIRED_CODE', 'code was issued but its active window lapsed');
    throw new ServerError('PAIR_INVALID_CODE', 'code does not match this pc');
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
        const mobile = mobiles.findById(existing.id) ?? existing;
        return { mobile, pc, token };
      }
    }

    // Past here this is a genuinely NEW pairing — the only path that takes a slot.
    this.ensureMobileSlot(input.user_id ?? pc.user_id);
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

  listPcsForUser(user_id: string): PcRecord[] {
    return this.deps.pcs.listByUser(user_id);
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
