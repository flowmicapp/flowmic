// SPEC-REF:
//   src/socket/handlers/mobile.handler.ts (the primary caller)
//   src/socket/handlers/mobile-reconnect.ts (the second caller)
//
// 2026-09-09 — MOVED VERBATIM out of mobile.handler.ts (800-line cap split).
// `MobileHandlerDeps` and `refuseRestricted` both had to leave that file
// together: mobile-reconnect.ts (the mobile:reconnect handler, also split out
// of mobile.handler.ts today) needs both, and importing either straight from
// mobile.handler.ts would close a cycle (mobile.handler.ts imports
// mobile-reconnect.ts's factory; verify/lint/circular.mjs catches exactly
// this). One shared home, imported by both — no back-edge either way.
// mobile.handler.ts re-exports both names, so every external consumer that
// already does `import { MobileHandlerDeps } from './mobile.handler'` needs
// no change. Every comment travelled with the code it explains; nothing about
// behaviour changed by this move.

import type { Server, Socket } from 'socket.io';
import type { ServerMode } from '@flowmic/protocol';
import type { Registry } from '../../room/registry';
import type { RoomStore } from '../../room/store';
import type { PairRateLimiter } from '../../room/pair-rate-limit';
import type { ReleaseSuppression } from '../../room/release-suppression';
import type { WriterOnlyGuard } from '../../node/writer-only';
import type { TokenReadThroughSeam } from '../../auth/middleware';
import { restrictionRefusalBody, restrictionVerdict, type RestrictionReader } from '../../auth/account-restriction';
import type { AnonymousRowReader } from '../../auth/metering-principal';
import type { WebTrialIdentities } from '../../auth/web-trial-identity';
import type { WebLivenessArmer } from '../web-liveness-watchdog';
import type { BudgetHandlerDeps } from './budget-frames';
import { safeAck, type ActingIdentity } from '../wire';
import { logAuthRefusal } from '../../auth/refusal-log';

export interface MobileHandlerDeps extends BudgetHandlerDeps {
  io: Server;
  /** NR-69 - the 7-second web liveness watch, handed to `joinAndNotify`.
   *  Omitted in production: `joinAndNotify` falls back to the REAL armer
   *  (`socket/web-liveness-watchdog.ts`), never to a no-op. Present only in
   *  tests, which inject a fake clock so no suite ever sleeps 7 seconds. */
  armWebLiveness?: WebLivenessArmer;
  registry: Registry;
  store: RoomStore<Socket>;
  /** 4-digit-code brute-force guard (WP-R23-1). In-memory, shared across sockets. */
  pairLimiter: PairRateLimiter;
  /** GA-08: the reconnect-suppression window that "disconnect" (pc:release-mobile)
   *  writes. The SAME instance the PC handler holds — that sharing is the whole
   *  mechanism. Omitted → no suppression (pre-GA-08 behaviour). */
  /** 2026-08-29 multi-node — this node's own id, echoed on the reconnect ack so
   *  the phone can compare where it is against where its PC is IN ONE ANSWER.
   *  Absent on a single-node deployment, and absent must keep meaning「there are
   *  no nodes」rather than「I do not know which node」— see the schema. */
  nodeId?: string;
  /** 2026-09-01 — true when this node's `pc_devices` rows arrive via the
   *  replication pull (role 'replica'). Handed straight to `pcPresence`, which
   *  carries the arithmetic on `PcPresenceOptions`: it widens the freshness
   *  window for a REMOTE PC only, because a replica's copy of somebody else's
   *  row advances at the 30 s pull rather than at the 5 s outbox drain.
   *
   *  OPTIONAL, and absent means「this node's rows are its own」— the writer, and
   *  every single-node deployment there is. It travels beside `nodeId` above
   *  and is optional for the same reason that one is: the branch it tunes only
   *  runs when `nodeId` is present AND the PC lives elsewhere, so on a
   *  deployment that omits `nodeId` this value cannot change any answer. The
   *  wiring is pinned instead by test/presence-wiring-source.test.ts, which
   *  reads bootstrap.ts and fails if the line stops being there. */
  rowsFromReplicationPull?: boolean;
  /** Server clock — injected so a test can state an instant instead of racing
   *  one. The default is the REAL clock, never a friendly no-op. */
  now?: () => number;
  /** 2026-08-29 multi-node — see PcHandlerDeps.writerOnly. REQUIRED for the same
   *  reason `restriction` below is: an optional gate is a gate that can be
   *  switched off by forgetting, with nothing red to show for it. */
  writerOnly: WriterOnlyGuard;
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
  /** Card W4-05 — `users.anonymous` for one row; the rule it feeds is in
   *  auth/metering-principal.ts. Absent ⇒ the pre-card answer (demo identity,
   *  mode 'trial') — a forgotten wiring cannot invent an allowance nobody
   *  bought. Wiring pinned by test/metering-principal-wiring-source.test.ts. */
  anonymousUser?: AnonymousRowReader;
  /** Card R-1 — mints/reuses the anonymous TRIAL identity an unsigned web
   *  pairing spends (auth/web-trial-identity.ts). Absent ⇒ no identity ⇒ the
   *  pre-card answer, i.e. the PC owner's allowance: an omission degrades to
   *  today and can never reach 「unlimited」. Never defaulted to a friendly stub
   *  (anti-façade ②) — an absent dependency is a wiring fact a test can drive. */
  webTrial?: WebTrialIdentities;
  /**
   * card MP-6 — `config.demoPayerUserId`, the account the SITE DEMO's minutes
   * are charged to (`FLOWMIC_DEMO_PAYER_USER_ID`).
   *
   * Absent / null ⇒ a site-demo admission is REFUSED rather than billed to
   * somebody nobody chose. See `auth/metering-principal.ts` `resolvePayer`
   * step 3; the refusal is the one this handler already performs for a room kind
   * it cannot read, which is why this card spends no error code.
   */
  demoPayerUserId?: string | null;
  /**
   * card MP-1 — WHICH publishable key minted this room (`integrator_rooms`), or
   * null for every room no key minted.
   *
   * 🔴 A READ OF A SERVER-MINTED EDGE, NEVER A CLIENT FRAME, and it is the same
   * argument `isWebRoom` makes for reading `room_kind` off the row: the value
   * decides whose money is spent and which ceiling applies, so a phone must not
   * be able to name it. Absent ⇒ every room resolves to 「no key」, which on an
   * integrator room means the sub-quota is not applied — so an integrator arm
   * is wired with this or not at all (bootstrap passes them together).
   */
  integratorKeyIdForRoom?: (pcDeviceId: string) => string | null;
  /**
   * Z4 (2026-09-01) — the SAME handshake read-through, on the one other seam
   * that resolves a pairing token against this node's local database.
   *
   * 🔴 WHY THE HANDSHAKE'S COPY WAS NOT ENOUGH. A phone dials with its token in
   * `handshake.auth`, so the middleware's read-through normally lands the rows
   * before this event is ever emitted. Two things get past that:
   *   · a socket admitted with NO token — `pc:register` / `mobile:pair` flows
   *     connect first and get their credential mid-session, so nothing ran a
   *     read-through for them;
   *   · the REPLICATION PULL RACING US. `replica-puller.ts` applies
   *     `DELETE FROM t; INSERT INTO t (cols…) SELECT cols… FROM snap.t` for
   *     every table, so a snapshot FETCHED before this pairing existed and
   *     APPLIED after we landed it erases the row again — underneath a socket
   *     that is still open. (The statement was `SELECT *` until 2026-09-14,
   *     card D5/NR-22; the race this paragraph describes is unchanged by that —
   *     it is the DELETE, not the projection.) The
   *     next `mobile:reconnect` (a rejoin, a presence self-heal re-probe) then
   *     misses locally, and THAT refusal is the one the phone deletes its local
   *     pairing on (`mobile_reconnect_flow.dart`, `removeByToken` — one of only
   *     two call sites in the whole app).
   *
   * ⚠️ Optional, unlike `writerOnly` and `restriction` right above, and for the
   * opposite reason: those are gates whose absence would silently switch them
   * off, while absence here is a LEGITIMATE DEPLOYMENT SHAPE — the writer and
   * every single-node deployment have nothing to ask. Same argument, same
   * spelling, as `PcHandlerDeps.mintCodeOnWriter`. With it absent this handler is
   * byte-for-byte the one that shipped before.
   *
   * ⚠️ The instance is the one bootstrap also hands `authMiddleware`. One budget,
   * one single-flight table; see the type's own doc for why two would be wrong.
   */
  resolveTokenOnWriter?: TokenReadThroughSeam;
  /** Acting-user resolution for the cloud-instance variant (saas: handshake-JWT
   *  sub / in-session login; standalone never reaches this — it fails earlier). */
  resolveActingUser(socket: Socket): ActingIdentity;
  /**
   * 2026-09-02 (WP-6, B4) — REPLICA ONLY: ask the writer to perform a
   * `mobile:unpair` this node cannot (node/writer-only.ts `registry.retireMobile`
   * row — the phone's half of "a revoke that comes back", same class of defect
   * `pc:release-mobile`'s `forwardReleaseMobile` closes for the PC's half).
   *
   * Before this existed, a phone that retired its own pairing on a replica was
   * refused `NODE_IS_REPLICA` and had to dial the writer directly through
   * `pairing.endpoint` — and if that endpoint pointed back at a replica after a
   * follow (the common case once a phone has been routed to its PC's home
   * node), the row survived forever with the phone told "did not reach server".
   *
   * Optional for the same reason `PcHandlerDeps.mintCodeOnWriter` is: absent
   * means "nobody to ask" (the writer, every single-node deployment), and the
   * caller falls back to the honest refusal.
   */
  forwardUnpairMobile?: (pairingId: string) => Promise<
    | { status: 'ok'; result: { unpaired: boolean; mobile_id: string | null; pc_room_uuid: string | null } }
    | { status: 'refused'; error: string }
  >;
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
export function refuseRestricted(deps: MobileHandlerDeps, userId: string, ack: unknown): boolean {
  // Q2 (owner 2026-08-12) — the ack now carries the ENUMERATED reason beside the
  // code, from the same ONE read and the same ONE body builder the console gate
  // uses. Additive: `error` is unchanged, so a phone that does not know the new
  // key behaves exactly as it did. 🔴 The operator's free text is not reachable
  // from this module at all — it lives in `ops_audit_log`, and that is why "a
  // sentence written by ops ending up on the user's screen" is impossible here rather than merely avoided.
  const verdict = restrictionVerdict(deps.restriction, userId);
  if (verdict === null) return false;
  // OPS-1 (2026-09-02) — the ONE call site for this refusal, so all three
  // admission points it guards (mobile:pair cloud-instance, mobile:reconnect,
  // mobile:unpair) log identically without each needing its own call.
  logAuthRefusal({ code: 'ACCOUNT_RESTRICTED', where: 'mobile:restricted', kind: 'mobile', node: deps.nodeId, userId });
  safeAck(ack, restrictionRefusalBody(verdict.reason));
  return true;
}
