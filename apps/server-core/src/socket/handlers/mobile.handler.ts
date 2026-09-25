// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:pair / mobile:reconnect /
//     mobile:list-pcs; acks = MobilePairAck; pc:mobile-joined / -left presence)
//   docs/rebuild/05-DATA-MODEL.md §1/§7 (mobile_pairings row, mobile_token)
//   docs/archive/strategy/2026-08-12-a2-3-restricted-use-design.md §5 (F1: the ADMISSION
//     gate for "restricted use" — §5 row ③ is the hole this file used to be)
//   src/auth/account-restriction.ts (the ONE conversion site this file asks)
//   *** HUMAN-AUDIT SENSITIVE (auth/pairing/slot) — reviewable in isolation ***
//
// The mobile side of pairing. mobile:pair via a 4-digit short_code or a QR
// payload resolves the ACTIVE PC (short-code governor) and mints a pairing row.
// mobile:reconnect resumes by token. On a NEW arrival the PC peer is notified via
// pc:mobile-joined (a same-pairing socket swap is not an arrival — see
// joinAndNotify / GA-26); on a real departure (bootstrap disconnect hook) the PC
// gets pc:mobile-left.
//
// Room-slot governance is simplified for R1-2 (single owner + free join): the
// full owner/observer slot arbitration remains deferred (reported as cut). The
// `mobile:switch-pc` event that used to be named here was DELETED from the
// whitelist on 2026-07-31 — switching PCs is a disconnect/reconnect through the
// connection page, so it was never a deferred feature, only an unused name.
// cloud_instance admission is LIVE (WP-R4-1): the saas-only
// find-or-create virtual-PC pairing variant is handled below. Every failure is a
// whitelisted code.

import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import { pcPresence } from '../../room/pc-presence';
import { RECOVERY_CAPABILITY_ACK, targetCapsAck } from './mobile-ack-fields';
import type { PcRecord } from '../../db/repos/pc.repo';
import { errorPayload } from '../../errors';
import { logAuthRefusal } from '../../auth/refusal-log';
import { getAccount, getAuth, safeAck, setAuth, setClientCaps, setCloudSession, setRoomUuid } from '../wire';
import { pushJoinBudget, pushMeteringSwitchBudget, withTarget } from './budget-frames';
import { meteringPrincipal, roomKindOf, type MeteringPrincipalInput, type RoomKind } from '../../auth/metering-principal';
import { clientIpFromHandshake } from '../../http/trusted-proxy';
import { joinAndNotify, liveContender } from './mobile-room-admission';
import { makeMobileReconnectHandler } from './mobile-reconnect';
import { type MobileHandlerDeps, refuseRestricted } from './mobile-handler-deps';
import { log } from '../../log';
import { assertIntegratorOrigin } from '../integrator-origin';
import { dropRetiredPairingOnReplica } from '../../node/replica-row-reconcile';

export { type MobileHandlerDeps, refuseRestricted };

/** The client IP behind the socket, for the pair limiter's per-IP window
 *  (0.3.0 M3). On the LAN the handshake address is the phone directly; behind a
 *  trusted nginx (FLOWMIC_TRUSTED_PROXIES) every handshake address is
 *  127.0.0.1, which used to fold every phone into ONE 10-failure/60s bucket —
 *  the shared derivation (http/trusted-proxy.ts) reads the real client from the
 *  proxy-appended X-Forwarded-For instead, and ignores the header entirely when
 *  the peer is not a configured proxy. Empty string when unavailable so the
 *  rate limiter still buckets deterministically.
 *
 *  🔴 IT-39 — THE `''` BUCKET, PUT ON THE RECORD (not fixed; made known).
 *  「Buckets deterministically」 above is true and says less than it sounds like.
 *  When no address can be derived — `clientIpFromHandshake` answers `''` for an
 *  absent handshake or an absent `handshake.address`, and the `|| ''` here folds
 *  a present-but-empty value onto the same key — the limiter key is the EMPTY
 *  STRING, and every such caller SHARES ONE BUDGET: 10 failures / 60 s for all
 *  of them together, not each. Two consequences, pointing opposite ways:
 *    · fail-SAFE against an attacker — becoming unidentifiable buys no fresh
 *      budget; `''` is a bucket, not a bypass;
 *    · fail-HARSH toward bystanders — if addresses were ever unavailable in
 *      bulk, unrelated phones would throttle one another.
 *  Left as-is on purpose: on every path we ship, engine.io populates
 *  `handshake.address`, so this bucket is empty in production, and the harsh
 *  direction only bites in a world we have never observed. Pinned by
 *  test/pair-code-budget.test.ts ("socketIp() folds empty values into one bucket") so it is a tested
 *  property rather than an accident nobody has measured.
 *  ⚠️ This comment is duplicated VERBATIM in scope at auth.handler.ts `socketIp`
 *  — the function is duplicated, so the record has to be too. */
function socketIp(socket: Socket): string {
  return clientIpFromHandshake(socket.handshake) || '';
}



export function registerMobileHandlers(socket: Socket, deps: MobileHandlerDeps): void {

  const { registry, store, pairLimiter } = deps;
  const now = deps.now ?? Date.now;
  /**
   * `pc_online` for one ack — the phone-facing half of「is my computer here」.
   *
   * 🔴 IT WAS `store.getPc(pc.room_uuid) !== null`, WRITTEN OUT AT EACH ACK, and
   * that expression answers a question about THIS PROCESS's room map. Rooms are
   * per-process (room/store.ts: "Live socket presence ONLY"), `mobile:pair` is
   * writer-only, and a PC settles on whichever node its own selection chose — so
   * a phone that paired on the writer while its PC lives on a replica was told
   * its computer is not there. Truthfully, and uselessly: the right answer to
   * the wrong question, with nothing to report because nothing had failed.
   *
   * One local function so both acks cannot drift apart, and it does nothing but
   * call the ONE author of this fact (room/pc-presence.ts) with what this node
   * knows about itself. `deps.nodeId` is the DOOR this socket arrived through
   * (bootstrap's `socketNodeId`), which is the same id `home_node` is stamped
   * with — comparing a door against a process id would call a PC on this very
   * process remote.
   */
  const pcOnline = (pc: PcRecord): boolean => pcPresence(store, pc, now(), deps.nodeId ?? null, {
    rowsFromReplicationPull: deps.rowsFromReplicationPull === true,
  });

  // ── card W4-05 · one metering principal for both admission legs ──
  //
  // ── card R-1 · and one place the unsigned-web TRIAL identity is resolved ──
  //
  // 🔴 `mayMint` IS THE LEG, NOT THE NODE ROLE READ TWICE. `mobile:pair` is
  // writer-only (this file refuses it on a replica before anything else runs),
  // so a pair always may write; `mobile:reconnect` can land on either node and
  // therefore only ever REUSES what the writer minted. Passing the flag in makes
  // 「which leg is this」 a caller's statement rather than a second inference
  // beside `deps.writerOnly()`, which answers a different question (may this
  // EVENT be served here) and would drift from this one the first time either
  // moved.
  /**
   * card MP-0 — WHICH FAR END this room is, resolved ONCE per admission and
   * handed to both readers below.
   *
   * 🔴 ONE CALL, TWO CONSUMERS, ON PURPOSE. The trial minter and the payer rule
   * both branch on it and they must branch on the SAME answer: a room that is a
   * third-party host for one and an ordinary web room for the other would mint a
   * FlowMic grant AND bill the integrator, which is both halves of design D3
   * wrong at once. It reads `pc_devices.room_kind` (server-minted, unreachable
   * from any client frame) plus `users.anonymous`.
   */
  const farEndKind = (pc: PcRecord): RoomKind | null => roomKindOf({
    roomKind: pc.room_kind, ownerUserId: pc.user_id,
    ...(deps.anonymousUser ? { reader: deps.anonymousUser } : {}),
  });
  const meteringInput = (
    pc: PcRecord,
    mobile: { id: string; user_id: string | null; client: string | null; trial_user_id: string | null; device_uid: string | null },
    opts: { mayMint: boolean },
  ): MeteringPrincipalInput => {
    const account = getAccount(socket);
    const roomKind = farEndKind(pc);
    const base = {
      account, pcUserId: pc.user_id, mobileUserId: mobile.user_id, roomKind,
      ...(deps.anonymousUser ? { reader: deps.anonymousUser } : {}),
    };
    const trialUserId = deps.webTrial?.resolve({
      account, client: mobile.client, roomKind, mobile, ip: socketIp(socket), mayMint: opts.mayMint,
    }) ?? null;
    // card MP-6 — the browser/device identity travels with the admission so the
    // ledger can say WHO SPOKE when nobody signed in. `mobile_pairings
    // .device_uid` is the `wb-…` value the browser keeps in localStorage (or a
    // handset's own uid); it is not an account and it is not an email.
    // card MP-1 — and WHICH key this room belongs to, read only when the far end
    // actually is an integrator room. Asked conditionally rather than always
    // because it is a database read on every admission, and on every other kind
    // of room the answer is known to be null by construction.
    const integratorKeyId = roomKind === 'integrator'
      ? deps.integratorKeyIdForRoom?.(pc.id) ?? null
      : null;
    return {
      ...base, trialUserId, deviceUid: mobile.device_uid,
      demoPayerUserId: deps.demoPayerUserId ?? null,
      integratorKeyId,
    };
  };
  /**
   * The admission this build cannot bill — design §5's failure direction.
   *
   * 🔴 IT REFUSES RATHER THAN GUESSING, and「guessing」here would mean charging
   * FlowMic's free grant or somebody's desktop for a third party's visitors. It
   * is reachable only from a `pc_devices` row written by a NEWER build than this
   * one; `node/token-rows.ts` already drops such a row before a replica can
   * serve it, so on a same-version deployment this is unreachable by
   * construction rather than by luck.
   *
   * ⚠️ THE CODE IS BORROWED AND MP-1 MUST REPLACE IT. The design asks for a
   * named `UNKNOWN_ROOM_KIND`; a new error code goes through the owner gate and
   * belongs to MP-1 with the rest of the third-party path, so this card spends
   * none. `PC_HANDSHAKE_PENDING` is the least wrong of the registered codes:
   * retryable, non-destructive (the phone keeps its token — `AUTH_TOKEN_INVALID`
   * would make it DELETE the pairing), and it blames neither the payload nor the
   * credential, both of which were fine.
   */
  const refuseUnbillableRoom = (pc: PcRecord, where: string, ack: unknown): boolean => {
    const kind = farEndKind(pc);
    // W6b: no key relation must not mean "no key ceiling". Bootstrap resolves
    // both the key row and its owner; a missing reader also refuses this kind.
    const unboundKey = kind === 'integrator' && !deps.integratorKeyIdForRoom?.(pc.id);
    if (kind !== null && !unboundKey) {
      assertIntegratorOrigin(deps.integratorOrigin, pc, socket, 'mobile');
      return false;
    }
    log.error('admission refused — this build cannot tell who pays for that room', {
      where, pc_id: pc.id, room_kind: pc.room_kind, unbound_key: unboundKey, node: deps.nodeId,
    });
    safeAck(ack, { error: 'PC_HANDSHAKE_PENDING' });
    return true;
  };
  /** Tell the room's TARGET end the meter changed hands — its only admission-time
   *  frame, only on a real switch (budget-frames.ts says why that matters). */
  const noteMeteringSwitch = (p: { userId: string; switched: boolean }, roomUuid: string): void => {
    if (p.switched) pushMeteringSwitchBudget(withTarget(store.getPc(roomUuid), p.userId), deps.budget);
  };

  // Free the per-socket backoff slot when the socket goes away (bounded memory).
  socket.on('disconnect', () => pairLimiter.forget(socket.id));

  socket.on('mobile:pair', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:pair', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    // 🔴 BEFORE all three admission variants, and before resolvePcForPair — that
    // resolve is not a read: it calls `codes.recordFailedGuess`, which IS the
    // 4-digit brute-force budget (IT-39). On a replica the ledger of failed
    // guesses is erased every thirty seconds, so the limiter that makes a 10^4
    // code space defensible would be present and void. The pairing itself is
    // erased too; this refusal covers both.
    const replica = deps.writerOnly();
    if (replica) return safeAck(ack, replica);
    if ('cloud_instance' in parsed.data) {
      // F-3140 "cloud-instance" solo session. saas-only; standalone fails loud (there
      // is no cloud account layer to admit against — never a silent standalone
      // fallback). The variant needs a verified account (handshake JWT or an
      // in-session mobile:login); missing → AUTH_TOKEN_INVALID, expired →
      // AUTH_TOKEN_EXPIRED (frozen contract). No 4-digit space → no pairLimiter.
      if (deps.mode !== 'saas') {
        return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD', message: 'cloud instance requires saas mode' });
      }
      const acting = deps.resolveActingUser(socket);
      if ('error' in acting) {
        logAuthRefusal({ code: acting.error, where: 'mobile:pair-cloud-instance', kind: 'mobile', node: deps.nodeId });
        return safeAck(ack, { error: acting.error });
      }
      // A2-3 — BEFORE admitCloudInstance, which INSERTS the virtual PC row and
      // its pairing on first use. A restricted account must not have rows minted
      // for it by a path it is not allowed to complete, and this is the one
      // admission where the account is known before any resolve.
      if (refuseRestricted(deps, acting.userId, ack)) return;
      try {
        const { pc, mobile, token } = registry.admitCloudInstance(acting.userId);
        // card MP-6 — `'self'` is a MEASUREMENT here, not a default: this
        // admission exists because a verified account asked for its OWN cloud
        // instance (`resolveActingUser` above), so `resolvePayer` step 1 is what
        // would answer, and there is no room whose kind could change it.
        setAuth(socket, {
          userId: acting.userId, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile',
          // card MP-10 — the LIGHT RECORD, and `'self'` is still a measurement
          // and not a default: `admitCloudInstance` mints the virtual PC row for
          // the SPEAKER'S OWN account, so this is owner's 「没有对端（手机轻
          // 记录）才扣自己」 and it is also what `resolvePayer` step 2 would
          // answer for it (an `'app'` far end whose owner IS the speaker).
          payerReason: 'self', speakerRef: acting.userId, speakerSignedIn: true,
        });
        setRoomUuid(socket, pc.room_uuid);
        setClientCaps(socket, parsed.data.client_caps); // card HANGUP-3
        setCloudSession(socket);
        // No desktop ever occupies a cloud-instance room, so the notify inside is
        // a no-op here; the displaced-socket handling is what this path wants.
        joinAndNotify(store, pc.room_uuid, mobile, socket, deps.armWebLiveness);
        return safeAck(ack, {
          // card RC-C (2026-09-24) — this arm never carried the recovery bits
          // (PR-1 put them on the code-pair arm and on reconnect only), so a
          // phone that had just entered its light record read "server too old"
          // and held every recovery candidate until its socket next reconnected.
          // Pinned by test/admission-ack-capabilities.test.ts. No `targetCapsAck`:
          // a virtual PC declares no target capabilities, and absence IS that.
          ...RECOVERY_CAPABILITY_ACK,
          pairing_id: mobile.id,
          mobile_token: token,
          pc_id: pc.id,
          pc_instance_id: pc.client_instance_id, // 'flowmic-cloud-instance'
          // Always null here, and that is the honest answer: the cloud-instance row is
          // a virtual PC, not a machine. Sent anyway so the phone reads the same
          // field on all three admission variants rather than special-casing.
          pc_machine_uid: pc.machine_uid,
          pc_name: pc.device_name,               // 'FlowMic Cloud'
          room_uuid: pc.room_uuid,
          pc_online: false,
          role: 'active',
        });
        return pushJoinBudget(socket, deps.budget); // card S2-02 — a room build too
      } catch (err) {
        return safeAck(ack, errorPayload(err));
      }
    }
    // Brute-force gate BEFORE resolving the code: a throttled attempt never even
    // probes the code space, and returns an honest, distinct PAIR_RATE_LIMITED
    // (never disguised as PAIR_INVALID_CODE).
    const ip = socketIp(socket);
    const decision = pairLimiter.check(socket.id, ip);
    if (!decision.allowed) {
      return safeAck(ack, { error: 'PAIR_RATE_LIMITED', retryable: true, retry_after_ms: decision.retryAfterMs });
    }
    try {
      // owner 2026-07-27: forward the phone's own name. registry.pairMobile has
      // always preferred one and nothing ever sent it — the branch was dead.
      const named = {
        // card S2-01 — which kind of end is pairing. Recorded so the desktop's
        // table can mark a browser; nothing here branches on it.
        ...(parsed.data.client !== undefined ? { client: parsed.data.client } : {}),
        ...(parsed.data.client_version !== undefined ? { client_version: parsed.data.client_version } : {}),
        ...(parsed.data.mobile_name ? { mobile_name: parsed.data.mobile_name } : {}),
        // v0.2.4: the handset's own id, which is what decides whether this is a
        // RETURNING phone or a new one (registry.pairMobile).
        ...(parsed.data.device_uid ? { device_uid: parsed.data.device_uid } : {}),
      };
      const input = 'short_code' in parsed.data
        ? {
            short_code: parsed.data.short_code,
            // 0.2.66 — the PCID rides ONLY the manual arm here. The QR arm's is
            // inside `qr_payload` and is parsed there (registry.resolvePcForPair),
            // so both arms converge on one code path. Threaded as omit-when-absent
            // rather than `pcid: parsed.data.pcid` so an old phone's frame carries
            // no key at all, and the saas gate sees 「missing」 rather than
            // 「undefined」 — one shape for one fact.
            ...(parsed.data.pcid ? { pcid: parsed.data.pcid } : {}),
            ...named,
          }
        : { qr_payload: parsed.data.qr_payload, ...named };
      // A2-3 — resolve the target PC WITHOUT minting, so the gate runs before
      // any write. `resolvePcForPair` is literally `pairMobile`'s own first
      // line, and on the success path it is read-only: its single side effect
      // (`recordFailedGuess`) is on the miss branch, which throws into the catch
      // below exactly as it does today, from exactly one charge.
      //
      // 🔴 WHICH ACCOUNT IS JUDGED: `pc.user_id`, and it is the same value the
      // socket would be given. The row `pairMobile` is about to write takes
      // `input.user_id ?? pc.user_id` (registry.ts `pairMobile`) and this
      // handler sends no `user_id`, so gate and identity are one value by
      // construction rather than by two agreeing readings.
      //
      // ⚠️ CHARGED TO NEITHER SIDE OF THE BRUTE-FORCE BUDGET, deliberately: the
      // code was RIGHT, so counting a failure would throttle the legitimate
      // owner of the account we just refused, and `recordSuccess` clears the
      // backoff for an attempt that produced no pairing. This is not a new
      // oracle either — a valid code was already distinguishable from an invalid
      // one (it pairs), and the per-code budget inside the resolve is untouched
      // in both directions.
      const target = registry.resolvePcForPair(input);
      if (refuseRestricted(deps, target.user_id, ack)) return;
      // card MP-0 — BEFORE `pairMobile` writes anything, for the same reason the
      // restriction check above is: a room nobody can be billed for must not
      // have rows minted against it by a path it is not allowed to complete.
      if (refuseUnbillableRoom(target, 'mobile:pair', ack)) return;
      const { mobile, pc, token } = registry.pairMobile(input);
      pairLimiter.recordSuccess(socket.id);
      // A12/F2-b — the pairing row is real and the token is good (the phone can
      // retry with it); the ROOM is what is occupied. Refused BEFORE `setAuth`/
      // `joinAndNotify`, so this socket never takes the slot and the PC never
      // hears a `pc:mobile-joined` it would only have to refuse a moment later.
      const contender = liveContender(store, pc.room_uuid, mobile.id);
      if (contender) {
        const suppressedMs = deps.suppression?.suppress(mobile.id, 'busy') ?? 0;
        return safeAck(ack, { error: 'PC_BUSY', retryable: true, retry_after_ms: suppressedMs });
      }
      // Card W4-05 — `mobile.user_id ?? pc.user_id` unless an ANONYMOUS demo
      // owner meets a verified handshake account. Nothing is written to
      // `mobile_pairings.user_id`; the rule is in auth/metering-principal.ts.
      //
      // 🔴 Card R-1 — AND THIS IS WHERE AN UNSIGNED WEB INSTANCE GETS ITS OWN
      // MINUTES, after the PC_BUSY refusal above and never before it: an
      // admission that is about to be turned away must not mint an identity, or
      // a visitor who is refused the room would silently spend one of that
      // network's three grants for the day.
      const principal = meteringPrincipal(meteringInput(pc, mobile, { mayMint: true }));
      // card MP-0 — `refuseUnbillableRoom` above already answered this for the row
      // `resolvePcForPair` returned, and `pairMobile` returns the same row; this
      // is the compiler's copy of that fact, not a second gate. Refusing here
      // rather than asserting keeps the failure direction 「nobody is billed」.
      if (principal === null) return safeAck(ack, { error: 'PC_HANDSHAKE_PENDING' });
      // card MP-6 — the payer BRANCH and the SPEAKER travel with the socket, so
      // the layer that later writes a `usage_events` row holds the facts the row
      // asserts instead of re-deriving them from rows that may since have moved.
      setAuth(socket, {
        userId: principal.userId, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile',
        payerReason: principal.reason,
        ...(principal.capUserId !== null ? { capUserId: principal.capUserId } : {}),
        ...(principal.integratorKeyId !== null ? { integratorKeyId: principal.integratorKeyId } : {}),
        ...(principal.speakerRef !== null ? { speakerRef: principal.speakerRef } : {}),
        // card MP-10 — WHICH SENTENCE the room owner's budget frame carries when
        // this socket speaks. Not derivable downstream: `payerReason:'peer'` now
        // covers a signed-in visitor and an unsigned one alike.
        speakerSignedIn: principal.speakerSignedIn,
      });
      setRoomUuid(socket, pc.room_uuid);
      setClientCaps(socket, parsed.data.client_caps); // card HANGUP-3
      joinAndNotify(store, pc.room_uuid, mobile, socket, deps.armWebLiveness);
      // 🔴 A HOP INSTRUCTION LEAVES A TRACE, because it is the one thing on this
      // path that later looks like nothing at all. If the phone does not act on
      // it, the symptom is 「the user speaks, the phone shows words, the PC gets
      // nothing」 with no error anywhere (`mirrorToPc` drops silently). Without
      // this line the server side of that story is a blank.
      //
      // Logged ONLY when the answer is 「not here」: a line on every pair would
      // be the alarm that fires every time, which is the alarm nobody reads
      // (0.3.26's `dropped_unrendered`, 36/36).
      if (pc.home_node && deps.nodeId && pc.home_node !== deps.nodeId) {
        log.info('pair.node_hint — the phone paired away from its PC', {
          pairing_id: mobile.id,
          pc_id: pc.id,
          home_node: pc.home_node,
          paired_on: deps.nodeId,
        });
      }
      safeAck(ack, {
        ...RECOVERY_CAPABILITY_ACK, // card PR-1
        ...targetCapsAck(pc),       // card S2-01
        pairing_id: mobile.id,
        mobile_token: token,
        pc_id: pc.id,
        pc_instance_id: pc.client_instance_id,
        // v0.2.4 — the MACHINE behind this pairing, distinct from the instance
        // id above (which is per channel). The phone stores it so its instance
        // list can show one PC once, with its two connections under it, instead
        // of two rows the user has to guess are the same computer.
        pc_machine_uid: pc.machine_uid,
        pc_name: pc.device_name,
        room_uuid: pc.room_uuid,
        pc_online: pcOnline(pc),
        // 🔴 2026-08-30 — THE PAIR LEG NEEDS THESE AS MUCH AS THE RECONNECT LEG,
        // and the asymmetry was a real defect rather than an omission of taste.
        //
        // `mobile:pair` is writer-only, so a phone always pairs on the WRITER.
        // Its PC may have settled on a replica (desktop node selection moves it
        // there once registered). Rooms are per-process, and nothing reconnects
        // after a successful pair — connections_controller goes straight to
        // `_rememberActive` → `onPaired` → `load()`. So the phone stayed in a
        // room on the writer that its PC will never join.
        //
        // ⚠️ AND THE FAILURE IS SILENT ON THE PATH THAT MATTERS MOST.
        // `audio.handler.ts` `mirrorToPc` is `const pc = store.getPc(room); if
        // (pc) send(pc);` — no PC in this node's room means the audio frame is
        // dropped with no error, no refusal and no log. The user speaks, the
        // phone shows the words, the PC receives nothing, and both halves look
        // correct forever.
        //
        // Same two fields, same meaning, same instant as the reconnect ack —
        // one question ("am I where my PC is?") must not have two answers with
        // two shapes. Both omitted on a single-node deployment.
        ...(pc.home_node ? { home_node: pc.home_node } : {}),
        ...(deps.nodeId ? { node: deps.nodeId } : {}),
      });
      pushJoinBudget(socket, deps.budget); // card S2-02 — the phone only, see budget-frames
      noteMeteringSwitch(principal, pc.room_uuid); // card W4-05
    } catch (err) {
      // A resolve miss (bad / expired code) is a brute-force signal → count it.
      pairLimiter.recordFailure(socket.id, ip);
      safeAck(ack, errorPayload(err));
    }
  });

  // ⚠️ ASYNC, and the only thing that awaits is the replica read-through below.
  // 2026-09-09 — moved VERBATIM to mobile-reconnect.ts (800-line cap).
  // Same behaviour, same comments, one call site.
  socket.on('mobile:reconnect', makeMobileReconnectHandler(socket, deps, { pcOnline, meteringInput, noteMeteringSwitch, refuseUnbillableRoom }));

  // ── v0.2.3 · mobile:unpair — the phone retires its OWN pairing ───────────
  //
  // owner 2026-07-29: "the connection instance that was previously 'deleted' was never really deleted". It was literally true —
  // deleting on the phone dropped the local token and nothing else, and no verb
  // in the protocol could remove a `mobile_pairings` row. The PC's device page
  // kept listing phones the user had removed, forever.
  //
  // The row to delete is the CALLER'S OWN, identified by the socket's auth. The
  // payload carries no id on purpose: an id would turn this into an
  // authorization question ("may I delete THAT one?"), which is a different and
  // much larger event than "I'm done using this computer".
  //
  // Distinct from GA-08 `pc:release-mobile`, which is the PC revoking a phone.
  // Same table, opposite direction, different authority — one cannot serve both.
  socket.on('mobile:unpair', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:unpair', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    // The phone's half of「a revoke that comes back」— same fact as
    // pc:release-mobile, and since 2026-09-02 (B4, WP-6) the same fix: forward
    // to the writer when there is one to ask, fall back to the honest refusal
    // otherwise.
    const replicaUnpair = deps.writerOnly();
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'mobile' || !auth.pairingId) {
      logAuthRefusal({ code: 'AUTH_TOKEN_INVALID', where: 'mobile:unpair', kind: auth?.kind ?? null, node: deps.nodeId, userId: auth?.userId });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    if (replicaUnpair) {
      const forward = deps.forwardUnpairMobile;
      if (!forward) return safeAck(ack, replicaUnpair);
      void forward(auth.pairingId)
        .then((outcome) => {
          if (outcome.status !== 'ok') return safeAck(ack, replicaUnpair);
          const { pc_room_uuid, mobile_id } = outcome.result;
          // Same local notify the direct path does — the writer cannot see
          // this node's room, so THIS node tells the PC if it happens to be
          // connected here (node/forward-sync.ts never touches sockets).
          if (pc_room_uuid && mobile_id) {
            store.leaveMobile(pc_room_uuid, mobile_id);
            store.getPc(pc_room_uuid)?.emit('pc:mobile-left', { mobile_id });
          }
          // 🔴 owner 2026-09-10 (the sibling of the pc:release-mobile hole, and
          // the reason this was fixed in two places rather than one): the two
          // lines above clear the live ROSTER, and `pc:list-mobiles` does not
          // read the roster — it reads the ROW. Without this the PC watching
          // this replica keeps listing a phone that has already unpaired
          // itself, until the next 30-second pull. See
          // node/replica-row-reconcile.ts.
          if (mobile_id) dropRetiredPairingOnReplica(registry, mobile_id);
          safeAck(ack, { ok: true });
        })
        .catch(() => safeAck(ack, replicaUnpair));
      return;
    }
    try {
      const mobile = registry.retireMobile(auth.pairingId);
      if (!mobile) {
        // Already gone. Idempotent on purpose: a retry after a dropped ack must
        // not read as a failure, or the phone can never finish removing it.
        return safeAck(ack, { ok: true });
      }
      const pc = registry.findPc(mobile.pc_device_id);
      // Leave the room and tell the PC, so its list and presence drop the row
      // NOW rather than at the next reconnect. Same notification the disconnect
      // hook sends — the PC has one way to learn a phone left.
      if (pc) {
        store.leaveMobile(pc.room_uuid, mobile.id);
        store.getPc(pc.room_uuid)?.emit('pc:mobile-left', { mobile_id: mobile.id });
      }
      safeAck(ack, { ok: true });
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  });

  // F7 (2026-09-02 audit) — `mobile:list-pcs` was DELETED here, not merely
  // trimmed: grep across apps/mobile (Dart), apps/desktop, and every test in
  // this package found no producer at all — no phone ever emits it, so the
  // handler served nobody. What it DID do was compute `is_online` via
  // `store.getPc(pc.room_uuid) !== null`, the direct-room-membership check
  // this repo's own `pcPresence()` was built to replace (a working computer
  // on a REPLICA reads as absent from this node's RoomStore). The event name
  // stays registered in packages/protocol/src/events.ts (event-registry
  // cleanup is not this card's scope); only the dead server handler and its
  // sole caller, `Registry.listPcsForUser`, are gone.
}
