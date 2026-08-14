// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:pair / mobile:reconnect /
//     mobile:list-pcs; acks = MobilePairAck; pc:mobile-joined / -left presence)
//   docs/rebuild/05-DATA-MODEL.md §1/§7 (mobile_pairings row, mobile_token)
//   docs/strategy/2026-08-12-a2-3-restricted-use-design.md §5 (F1: the ADMISSION
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

import type { Server, Socket } from 'socket.io';
import { safeParseEvent, type MobileReconnectAckAudioFields, type ServerMode } from '@flowmic/protocol';
import type { Registry } from '../../room/registry';
import type { RoomStore } from '../../room/store';
import type { PairRateLimiter } from '../../room/pair-rate-limit';
import type { ReleaseSuppression } from '../../room/release-suppression';
import { errorPayload } from '../../errors';
import { restrictionRefusalBody, restrictionVerdict, type RestrictionReader } from '../../auth/account-restriction';
import { getAuth, safeAck, setAuth, setCloudSession, setRoomUuid, type ActingIdentity } from '../wire';
import { adoptAudioSession, peekAudioLastContiguousSeq } from '../../engine/audio-registry';
import { clientIpFromHandshake } from '../../http/trusted-proxy';

export interface MobileHandlerDeps {
  io: Server;
  registry: Registry;
  store: RoomStore<Socket>;
  /** 4-digit-code brute-force guard (WP-R23-1). In-memory, shared across sockets. */
  pairLimiter: PairRateLimiter;
  /** GA-08: the reconnect-suppression window that "disconnect" (pc:release-mobile)
   *  writes. The SAME instance the PC handler holds — that sharing is the whole
   *  mechanism. Omitted → no suppression (pre-GA-08 behaviour). */
  suppression?: ReleaseSuppression;
  /** Deployment mode — the cloud-instance admission variant is saas-only. */
  mode: ServerMode;
  /** A2-3 "restricted use" — the row reader every ADMISSION below asks before it lets a
   *  phone in (see `refuseRestricted`).
   *
   *  🔴 REQUIRED, NEVER OPTIONAL. An `restriction?:` here would be a friendly
   *  empty default that switches the gate off with no compile error, no log line
   *  and a green test suite — the DI shape book 13 §7 F1 ② forbids by name. A
   *  future caller that forgets it fails to compile, which is the whole point.
   *
   *  bootstrap hands over the SAME `AuthService` instance
   *  `console-routes.refuseRestricted` reads through, so the HTTP gate and this
   *  one cannot disagree about whether an account is restricted, and "once lifted,
   *  the very next connection attempt recovers" is a property of a real row read rather than a hope.
   *
   *  ⚠️ Wired in BOTH modes on purpose. Standalone has no account layer at all,
   *  so its single 'default' row is never restricted (nothing can write that
   *  column there) — the gate is inert BY FACT, not by being unwired. Making it
   *  saas-only would put a mode branch between an auth decision and its reader. */
  restriction: RestrictionReader;
  /** Acting-user resolution for the cloud-instance variant (saas: handshake-JWT
   *  sub / in-session login; standalone never reaches this — it fails earlier). */
  resolveActingUser(socket: Socket): ActingIdentity;
}

/**
 * Put this socket in the room AS this pairing, then answer TWO independent
 * questions with TWO named booleans — never one value for both:
 *
 *   needsJoinAnnounce — should the PC hear `pc:mobile-joined`?
 *                    Whenever a socket TAKES THE SLOT: a first arrival
 *                    (`previous === null`) or a same-pairing socket SWAP.
 *   needsFocusSeed — should THIS socket hear the room's last `focus:state`?
 *                    Yes for every new socket: it has never been on the wire,
 *                    so a CHANGE-only mirror would leave its header blank until
 *                    the user happens to alt-tab (A-1 / owner 2026-07-29).
 *
 * The bug that made A-1: the early-return on `previous !== null` answered
 * needsFocusSeed with the announce question's answer. Silent reconnect (EMUI /
 * WiFi↔4G) then left the phone's destination as `—` for the whole session.
 *
 * 🔴 fix-001 (P0 red line "the capsule allows only one phone") — THE SAME COLLAPSE, A THIRD TIME, and
 * this one had a red line on it. The announce boolean used to be `isNewPresence`
 * = `previous === null`, i.e. it answered 「is this phone newly PRESENT?」 and was
 * then reused for 「may this SOCKET speak into the capsule?」. Those come apart
 * for exactly one input, and it is the one the owner hit:
 *
 *   1. second phone B joins → announced → the desktop's `Admission` REFUSES it →
 *      `pc:release-mobile{reason:'busy'}` → B suppressed 8 s and disconnected;
 *   2. B's dead socket STAYS in the slot — `leaveMobile` is deferred to the end of
 *      the GA-04 mobile-drop grace (~30 s). Deliberate, and the precondition here;
 *   3. B's ladder returns after the 8 s hold-out but INSIDE that grace ⇒ admitted,
 *      and `previous !== null` (the corpse) ⇒ **no announce** ⇒ the capsule verdict
 *      never runs again. `Admission::join` is reachable from `PC_MOBILE_JOINED` and
 *      from NOWHERE else (presence.rs) — no pull, no poll, no watchdog for this;
 *   4. when the grace expires, `leaveMobile(room, B, OLD_id)` correctly returns
 *      false (GA-26's displaced-socket guard: the slot holds a NEWER socket) ⇒ no
 *      `pc:mobile-left` either.
 *
 * ⇒ B squats on the capsule, invisible to the only layer allowed to refuse it.
 *   Real-device forensics (2026-08-11): `mobiles=2` for EIGHT MINUTES, both phones
 *   on the transcription screen, and the server's `released:1` true the whole time
 *   — it counts 「I closed a socket」, never 「that phone gave up the capsule」.
 *
 * WHY WIDENING IS SAFE, i.e. why GA-26 narrowed the wrong thing: GA-26's actual
 * fix was making the desktop's presence a SET keyed by mobile_id, and its own
 * header says in as many words that 「a duplicate joined (server re-announced a
 * reconnecting phone)」 is thereby harmless — `Reconciler::on_join` is an
 * idempotent insert, and `Admission::join` GRANTS the holder re-joining
 * (admission.rs, 「The SAME phone re-joining (a reconnect) is not a second
 * phone」). The desktop was hardened for this frame; suppressing it here bought
 * nothing and cost the verdict.
 *
 * Scope: a socket swap is per-server, so this cannot make a phone refuse ITSELF
 * across channels — the two channels are two servers with two RoomStores, and a
 * same-channel swap always lands on `Admission`'s Granted arm.
 *
 * The displaced socket is dropped here as well — one live link per pairing —
 * so it can neither be probed as alive (GA-07) nor speak into the room.
 */
function joinAndNotify(
  store: RoomStore<Socket>,
  roomUuid: string,
  mobile: { id: string; mobile_name: string },
  socket: Socket,
): void {
  const { previous } = store.joinMobile(roomUuid, mobile.id, socket);
  // Named separately on purpose — do not collapse these into one boolean again.
  // 「Took the slot」, NOT 「is newly present」 — see the header: the capsule verdict
  // is a question about THIS SOCKET, and the difference is the P0 red line.
  const needsJoinAnnounce = previous === null || previous.id !== socket.id;
  const needsFocusSeed = true; // every fresh socket; independent of presence

  if (previous !== null && previous.id !== socket.id) {
    previous.disconnect(true);
  }

  if (needsJoinAnnounce) {
    const pc = store.getPc(roomUuid);
    pc?.emit('pc:mobile-joined', {
      mobile_id: mobile.id,
      mobile_name: mobile.mobile_name,
      room_uuid: roomUuid,
    });
  }

  if (needsFocusSeed) {
    // 2026-07-29 (owner: "the PC capsule shows the focus window, but it doesn't
    // show above the phone's transcription screen — only appears after exiting
    // and reconnecting"): `focus:state` is a CHANGE-only mirror, so a phone that arrives
    // (or re-arrives on a new socket) between two foreground switches never
    // learns the focus that is already true. The server replays what it holds
    // on the SAME event — no new protocol, no PC/phone build. "Pushed state must
    // also be pullable" — 0.2.x wrap-up §8-2.
    const focus = store.getLastFocus(roomUuid);
    if (focus) socket.emit('focus:state', focus);
  }
}

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

/**
 * A2-3 "restricted use" — refuse an ADMISSION for a restricted account, out loud.
 * Returns true when it answered, so every call site reads `if (…) return;`.
 *
 * 🔴 WHAT THIS CLOSES. `auth/account-restriction.ts` names this hole in its own
 * docstring: 「The phone is NOT refused anything yet … the pairing path never
 * reads `users` at all」. Until this existed the restriction reached the web
 * console and stopped there, so an already-paired phone went on typing into its
 * PC with NO UPPER BOUND (design §5 row ③) while the operator surface said
 * "restricted" — R11 in its purest form: a status word nobody had given the facts
 * to be true. The phone is the product; a restriction that never reaches it
 * restricts almost nothing.
 *
 * ⚠️ A MIRROR, NOT A SECOND GATE. Same name, same boolean contract, same ONE
 * conversion site (`isRestrictedAccount`) as `console-routes.refuseRestricted`,
 * per the design's first recommendation (§2.3: 「don't invent a second gate
 * shape」). Nothing here decides what 「restricted」 MEANS — it only asks.
 *
 * 🔴 THE CODE, AND WHY THE NEAREST ONE IS A TRAP. `AUTH_TOKEN_INVALID` is the
 * refusal this very handler already emits for a pairing that is genuinely gone,
 * and it makes the phone DELETE the pairing (`mobile_reconnect_flow.dart`:
 * `if (invalid) await tokenStorage.removeByToken(token)`). A restriction is
 * reversible — one operator request lifts it — and a wiped pairing is not
 * reversible by anyone except the user, who never asked for it: reversible
 * state, irreversible damage. `ACCOUNT_RESTRICTED` keeps the token, which is
 * also what makes "the pairing is still there after being lifted" testable rather than hoped for.
 *
 * 🔴 NO `retry_after_ms`, AND THE OMISSION IS THE BEHAVIOUR. The phone's
 * hold-out timer is armed by 「did the server hand over a budget」 and by nothing
 * else (`ptt_reconnect_ack.dart` `_noteHoldOut` → `HoldOutRetry.note`; a code
 * answered WITHOUT one is documented right there as 「not one dial」). The two
 * codes that do carry a budget carry a window somebody MEASURED
 * (`ReleaseSuppression.remainingMs`). A restriction has no window: only an
 * operator ends it and there is no appeal channel (owner ⑤), so any number here
 * would be invented — and worse, that loop is fact-driven (every answered
 * re-ask re-arms the timer, `HoldOutRetry` header), so a fabricated budget would
 * buy an unbounded re-ask against a fact that cannot change. Answering with no
 * budget leaves the phone quiet, still holding its token, and admitted on its
 * very next attempt once the restriction is lifted.
 *
 * ⚠️ No `retryable` either — measured, not assumed: `runMobileReconnect` reads
 * exactly `error` and `retry_after_ms` off this ack, and the only `retryable`
 * readers in apps/mobile/lib are `stt:error` and the image-upload route. A field
 * with no reader is a promise nobody keeps.
 *
 * 🔴 THE COPY GAP, STATED RATHER THAN SILENT. The phone has no `pairError` case
 * for this code yet, so today it lands in that switch's default arm as "Pairing
 * failed, please check your network and retry · diagnostic code ACCOUNT_RESTRICTED" — a bare identifier plus an
 * instruction that is false (the network is fine). The mobile string table is
 * another card's file; the proposed four-language copy went to the lead with
 * this one. Refusing with imperfect copy beats what it replaces, which was not
 * refusing at all.
 *
 * > 🔴 CORRECTED IN PLACE (2026-08-13, WP3 — the paragraph above is kept
 * > because it was true when written; it is stale now). The phone HAS the
 * > `pairError` case today: pairing_strings.dart (apps/mobile/lib/src/
 * > settings/strings/) carries `case 'ACCOUNT_RESTRICTED':` with
 * > four-language head copy, `restrictionReasonNote()` in the same file
 * > renders all five enumerated reason keys in four languages, and an
 * > unrecognised reason key is demoted to a labelled identifier rather than
 * > invented into a sentence. Two tests bind the mirror —
 * > apps/mobile/test/pair_error_account_restricted_test.dart and
 * > apps/mobile/test/restriction_reason_copy_mirror_test.dart (both green,
 * > 17 cases, re-run 2026-08-13) — and the Q2 real-device leg (2026-08-13)
 * > showed the two human sentences on the phone, no bare identifier.
 *
 * ⚠️ It is NOT the 0.2.48 P0 shape: that closed set
 * (`kPcInjectionVerdictCodes`) lives on `inject:result`, and this code never
 * rides that frame — an admission refusal settles the attempt, it does not
 * leave a queue item waiting for a verdict. (Still true after the correction
 * above — this sentence is about frame routing, not about copy.)
 */
function refuseRestricted(deps: MobileHandlerDeps, userId: string, ack: unknown): boolean {
  // Q2 (owner 2026-08-12) — the ack now carries the ENUMERATED reason beside the
  // code, from the same ONE read and the same ONE body builder the console gate
  // uses. Additive: `error` is unchanged, so a phone that does not know the new
  // key behaves exactly as it did. 🔴 The operator's free text is not reachable
  // from this module at all — it lives in `ops_audit_log`, and that is why "a
  // sentence written by ops ending up on the user's screen" is impossible here rather than merely avoided.
  const verdict = restrictionVerdict(deps.restriction, userId);
  if (verdict === null) return false;
  safeAck(ack, restrictionRefusalBody(verdict.reason));
  return true;
}

export function registerMobileHandlers(socket: Socket, deps: MobileHandlerDeps): void {
  const { registry, store, pairLimiter } = deps;

  // Free the per-socket backoff slot when the socket goes away (bounded memory).
  socket.on('disconnect', () => pairLimiter.forget(socket.id));

  socket.on('mobile:pair', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:pair', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
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
      if ('error' in acting) return safeAck(ack, { error: acting.error });
      // A2-3 — BEFORE admitCloudInstance, which INSERTS the virtual PC row and
      // its pairing on first use. A restricted account must not have rows minted
      // for it by a path it is not allowed to complete, and this is the one
      // admission where the account is known before any resolve.
      if (refuseRestricted(deps, acting.userId, ack)) return;
      try {
        const { pc, mobile, token } = registry.admitCloudInstance(acting.userId);
        setAuth(socket, { userId: acting.userId, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile' });
        setRoomUuid(socket, pc.room_uuid);
        setCloudSession(socket);
        // No desktop ever occupies a cloud-instance room, so the notify inside is
        // a no-op here; the displaced-socket handling is what this path wants.
        joinAndNotify(store, pc.room_uuid, mobile, socket);
        return safeAck(ack, {
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
      const { mobile, pc, token } = registry.pairMobile(input);
      pairLimiter.recordSuccess(socket.id);
      setAuth(socket, { userId: mobile.user_id ?? pc.user_id, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile' });
      setRoomUuid(socket, pc.room_uuid);
      joinAndNotify(store, pc.room_uuid, mobile, socket);
      safeAck(ack, {
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
        pc_online: store.getPc(pc.room_uuid) !== null,
      });
    } catch (err) {
      // A resolve miss (bad / expired code) is a brute-force signal → count it.
      pairLimiter.recordFailure(socket.id, ip);
      safeAck(ack, errorPayload(err));
    }
  });

  socket.on('mobile:reconnect', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:reconnect', payload);
    if (!parsed.success) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    try {
      const result = registry.reconnectMobile(parsed.data.token, parsed.data.device_uid);
      if (!result) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      const { mobile, pc } = result;
      // A2-3 — the identity this socket is ABOUT to be given, computed ONCE and
      // read by both the gate below and `setAuth` further down. A gate that
      // judges a different value from the one it then admits is a gate on paper.
      const actingUserId = mobile.user_id ?? pc.user_id;
      // 🔴 A2-3, AND IT OUTRANKS THE HOLD-OUT CHECK BELOW — the order is a
      // decision, not the order I happened to type. Both can be true of one
      // phone and only one can be the answer: `PAIR_RELEASED` / `PC_BUSY` say
      // 「come back in N ms」, which for a restricted account promises a recovery
      // that will not arrive, costs a round trip to disprove, and (because those
      // two are the codes that carry a budget) arms the phone's hold-out timer
      // to go and be refused again. This is the same ordering argument
      // console-routes.ts makes for restriction-before-verification: the true
      // sentence that names an action the user cannot complete is the wrong one.
      //
      // ⚠️ It runs AFTER `reconnectMobile`, so `last_seen_at` is still stamped —
      // deliberate and identical to the hold-out refusal below: a refused
      // reconnect is still a genuine contact from that phone.
      if (refuseRestricted(deps, actingUserId, ack)) return;
      // GA-08 "disconnect": the PC ended this session moments ago. The pairing is
      // still VALID — this is a pause, not a revocation — so the refusal carries
      // PAIR_RELEASED and never AUTH_TOKEN_INVALID: the mobile ladder keeps its
      // token on an unknown code and backs off, and would DELETE the pairing on
      // AUTH_TOKEN_INVALID (mobile_reconnect_flow.dart). `retry_after_ms` is the
      // real remaining window, so the phone is told when, not just no.
      // Refused BEFORE joining the room: a suppressed phone must not be present,
      // must not adopt a lingering audio session, and must not raise
      // pc:mobile-joined. (It does keep last_seen_at's touch from the lookup
      // above — a refused reconnect is still a genuine contact from that phone.)
      const suppressedFor = deps.suppression?.remainingMs(mobile.id) ?? 0;
      if (suppressedFor > 0) {
        // GA-29: the two hold-out reasons are two different facts and must not
        // share a sentence. "The computer just disconnected this phone" tells the user someone
        // pressed a button; "another phone is already in use" tells them to wait their turn.
        // Both are retryable and both keep the token — only the words and the
        // window differ.
        const busy = deps.suppression?.reasonFor(mobile.id) === 'busy';
        return safeAck(ack, {
          error: busy ? 'PC_BUSY' : 'PAIR_RELEASED',
          retryable: true,
          retry_after_ms: suppressedFor,
        });
      }
      setAuth(socket, { userId: actingUserId, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile' });
      setRoomUuid(socket, pc.room_uuid);
      joinAndNotify(store, pc.room_uuid, mobile, socket);
      // GA-04: re-bind an audio session still inside its mobile-drop grace, so a
      // sub-30s blip resumes on the SAME orchestrator (SeqTracker intact) and the
      // PC never learns the phone was gone. mobile:pair does not need this — it
      // mints a new pairing row, so no session can be keyed to it yet.
      adoptAudioSession(socket, pc.room_uuid, mobile.id);
      // SEG-1 (R5, docs/strategy/2026-08-11-unified-transcription-session-design.md):
      // tell the returning phone how far the surviving session has already
      // contiguously observed, so its 30 s ring replay can trim to 「seq >
      // watermark」 (card SEG-2) instead of re-sending everything. ABSENCE is
      // the no-session signal — when the peek answers null the field is
      // OMITTED, never sent as null and never as a -1 sentinel; `-1` on the
      // wire only ever means 「session live, zero chunks observed yet」. A phone
      // that never sees the field (old server, stripped by an old relay,
      // pre-SEG-2 build) replays in full and hasObserved() dedupes server-side
      // — fail toward duplication, never loss (protocol-schemas-auth.ts, on
      // the field).
      const audioSeq = peekAudioLastContiguousSeq(socket, pc.room_uuid, mobile.id);
      const audioAckFields: MobileReconnectAckAudioFields =
        audioSeq === null ? {} : { audio_last_contiguous_seq: audioSeq };
      safeAck(ack, {
        pairing_id: mobile.id,
        pc_id: pc.id,
        pc_instance_id: pc.client_instance_id,
        pc_machine_uid: pc.machine_uid,
        pc_name: pc.device_name,
        room_uuid: pc.room_uuid,
        pc_online: store.getPc(pc.room_uuid) !== null,
        ...audioAckFields,
      });
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  });

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
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'mobile' || !auth.pairingId) {
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
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

  socket.on('mobile:list-pcs', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('mobile:list-pcs', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    const auth = (socket.data as { auth?: { userId: string } | null }).auth;
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const pcs = registry.listPcsForUser(auth.userId).map((pc) => ({
      pc_id: pc.id,
      pc_name: pc.device_name,
      room_uuid: pc.room_uuid,
      is_online: store.getPc(pc.room_uuid) !== null,
    }));
    safeAck(ack, { pcs });
  });
}
