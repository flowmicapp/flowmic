// apps/server-core/src/node/writer-only.ts
//
// Which socket events a read-only replica must REFUSE instead of serving.
//
// SPEC-REF: docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §10
//
// ── THE FACT THIS EXISTS FOR ────────────────────────────────────────────────
// A replica's database is REPLACED by the next pull (node/replica-puller.ts,
// PULL_INTERVAL_MS = 30_000). A row written locally between two pulls is not
// slow, not degraded, not eventually-consistent: it is gone inside thirty
// seconds, and every layer above it reported success. That is the silent-failure
// red line in its purest form — a success that was not true.
//
// http/router.ts already refuses this for HTTP, and it guards by METHOD because
// the method already says「this mutates」. The socket has no method. So the same
// property has to be stated, and the only defensible way to state it is to have
// MEASURED it rather than to have reasoned about which events "feel" like
// writes.
//
// ── 🔴 THE MEASUREMENT (2026-08-29, by reading every registry/repo call in
//    apps/server-core/src/socket/handlers/*.ts, not by assuming) ─────────────
//
// It found TEN write sites across SIX events, where the card that opened this
// work had named TWO. The card was wrong, and it was wrong in the direction that
// matters: shipping two of six would have left four losses in place under a
// commit message saying the problem was handled.
//
//   pc:register        registerPc → pcs.insert · setToken · setShortCode ·
//                      setOnline · adoptClientInstance · setMachineUid ·
//                      stampPcid  (SEVEN db writes; `codes.stamp` also runs and
//                      is in-memory — see the correction note below)
//                      ⇒ identity minted and lost. The PC also PRINTS the short
//                        code on screen, so the user reads a code whose row will
//                        not exist in thirty seconds.
//   pc:refresh-code    refreshShortCode → pcs.setShortCode (+ in-memory stamp)
//                      ⇒ same, minus the registration.
//   pc:release-mobile  revokeMobile → mobiles.remove
//                      🔴 A REVOKE THAT COMES BACK. The user removes a phone,
//                        both ends say OK, and the pairing returns on the next
//                        pull. A security control silently not applied is worse
//                        than one that visibly fails.
//   mobile:pair        pairMobile → mobiles.insert · setToken · touchLastSeen ·
//                      setDeviceUid; admitCloudInstance → pcs.insert ·
//                      mobiles.insert
//                      🔴 AND IT FAILS FOR A SECOND, WORSE REASON — see below.
//   mobile:unpair      retireMobile → mobiles.remove ⇒ as pc:release-mobile.
//   settings:update    settings.write · registry.renamePc → pcs.setDeviceName
//                      ⇒ a setting the user just changed, reverted silently.
//
// ── 🔴 CORRECTION TO MY OWN JUSTIFICATION (same day, measured) ──────────────
// The first version of this header said `resolvePcForPair` mattered here because
// `codes.recordFailedGuess` is the 4-digit brute-force budget (IT-39) and 「on a
// replica the ledger of failures resets every thirty seconds」.
//
// THAT IS FALSE, and it is false because I did not read the thing I was citing.
// `ShortCodeGovernor` holds `issuedAt` / `reserved` / `codeByPc` / `failures` as
// plain in-memory Maps (room/short-code.ts). A replication pull replaces the
// DATABASE; it does not touch a Map. The sentence described a mechanism that
// does not exist.
//
// What is ACTUALLY true is worse for the user and better as an argument:
//   · `resolvePcForPair` resolves a code as `findActivePcByCode(rows, id =>
//     this.codes.isActive(id))` — DB rows AND the in-memory governor;
//   · a replica's governor NEVER stamped anything (register/refresh happen on the
//     writer), so `isActive` is false for every PC it holds a row for;
//   ⇒ ON A REPLICA A CORRECT PAIRING CODE RESOLVES TO NOTHING AND THE USER IS
//     TOLD 「配对码无效」. They retype a code that is right and are told it is
//     wrong, forever. That is not a lost write, it is a false statement to the
//     user's face — and no amount of retrying fixes it, which is exactly why the
//     refusal has to be a NAMED one.
//   · `recordFailedGuess()` charges `mostExposedLiveIssuance()`, and with no live
//     issuance on that node it charges nothing. So the budget is not weakened
//     here either; it is simply absent along with everything else.
//
// ⚠️ Left in full rather than quietly rewritten, because the failure was the
// interesting part: a justification that SOUNDED like this repo's house style
// (a named mechanism, a number, a red line) and had not been checked. 先核你的尺子
// applies to one's own reasoning, not only to test harnesses.
//
// ── WHAT IS DELIBERATELY *NOT* HERE, AND WHY THAT IS NOT THE SAME AS SAFE ───
// The reconnect legs (`pc:reconnect`, `mobile:reconnect`) and `heartbeat` also
// write — claimClientInstance, setOnline, stampMachineUid, stampPcid,
// touchLastSeen, setDeviceUid — and those writes are lost too. They are NOT
// refused here, because refusing them would stop a replica from serving the live
// sessions that are its entire reason to exist: the cure would be worse than the
// disease, and「a node that refuses everything」 is not a replica.
//
// 🔴 SO THEY ARE AN OPEN ACCOUNT, NOT A CLEARED ONE. The honest state of the
// design today is「identity writes are refused; presence and last-seen writes are
// accepted and lost」. That second clause is written down in the design §10 and
// in the sensitive-surface audit queue, and it is one of the things that must be
// closed before srvjp is ever made selectable — see test/writer-only-census.test.ts
// which fails if a NEW write site appears in a handler without being classified,
// so this list cannot quietly go stale the way a hand-kept list does.
//
// ── WHY A GUARD OBJECT AND NOT AN `if (isReplica)` IN EACH HANDLER ─────────
// Six copies of the same condition is six places for the seventh to be forgotten,
// and the seventh is always the one that matters. One guard, constructed in ONE
// place (node/node-runtime.ts), handed to the handlers as a REQUIRED dep so that
// forgetting to wire it is a compile error rather than a silently disabled gate
// (book 13 §7 F1 ②: a DI default must never be a friendly no-op).

import { ERROR_CODES } from '@flowmic/protocol';

/**
 * The refusal payload, shaped to ride the existing `{error}` ack field so no
 * schema moved. `writer` is additive and ignored by every client that does not
 * know it.
 */
export interface WriterOnlyRefusal {
  error: 'NODE_IS_REPLICA';
  message: string;
  /**
   * Where the write CAN happen.
   *
   * 🔴 THIS IS A DIAGNOSTIC, NOT A REDIRECT, AND THE DIFFERENCE IS THE WHOLE
   * COMMENT. No client acts on it today: the desktop records it in forensic and
   * the phone never sees it. It is here because the operator question that
   * follows this refusal is always「then who should have answered?」 and the log
   * line that cannot answer it costs an hour.
   *
   * Making it a real redirect — a client re-dialling the URL an error ack handed
   * it — is a NEW primitive on the authenticated pairing path, and it needs its
   * own round and its own review: a node that can redirect a registering PC to
   * an arbitrary host is a different security object from a node that can only
   * say no. Recorded, deliberately not built. (The same field on the HTTP 421 in
   * http/router.ts is here for the same reason and with the same limit.)
   */
  writer: string;
}

/**
 * Answers「must this node refuse a writer-only event right now?」— a refusal, or
 * `null` when this node can write.
 */
export type WriterOnlyGuard = () => WriterOnlyRefusal | null;

/**
 * The guard for a node that can write: a single-node deployment, or the writer.
 *
 * Named rather than written as `() => null` at each call site so that reading
 * bootstrap tells you a decision was made, not that someone left a hole.
 */
export const NODE_CAN_WRITE: WriterOnlyGuard = () => null;

/**
 * The guard for a replica.
 *
 * The message is taken from the protocol registry rather than spelled here, so
 * the sentence a log carries and the sentence a client renders cannot drift into
 * two answers to one question.
 */
export function makeWriterOnlyGuard(writerUrl: string): WriterOnlyGuard {
  const refusal: WriterOnlyRefusal = {
    error: 'NODE_IS_REPLICA',
    message: ERROR_CODES.NODE_IS_REPLICA.en,
    writer: writerUrl,
  };
  return () => refusal;
}
