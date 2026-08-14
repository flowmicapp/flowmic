// card L2 (2026-08-02) — the flush-phase error verdict: an engine that already
// declared `retryable:false` keeps its own code and message; everything else
// answers the generic flush timeout.
//
// Extracted as a sibling module (repo's standing 800-line-cap move, same family
// as cold-open-verdict.ts / empty-final-verdicts.ts / terminal-final-text.ts):
// orchestrator-core.ts `handleFlushError` is the one caller, and it is now the
// latch plus the emit and nothing else.
//
// 🔴 WHAT MOVED AND WHAT CHANGED — enumerated, because a blanket "verbatim" is
// the claim that rots. BOTH doc blocks below are byte-for-byte what sat above
// `handleFlushError`, and the two branches decide exactly what they decided
// before. The deviations, all of them:
//   (1) the block is de-indented by two spaces (class member → module scope);
//   (2) `private handleFlushError(err: Error): void {` →
//       `export function flushErrorVerdict(err: Error): FlushErrorFrame {`;
//   (3) `this.flushErrored = true;` did NOT move. It is the LATCH, not the
//       verdict — `flushAndEmitFinal` reads it to suppress an empty final — and
//       a verdict function that reached back into the orchestrator would be one
//       function answering two questions;
//   (4) `this.emit('error', { … }); return;` → `return { … };` (the named-code
//       branch, whose bare `return;` folds into the frame) and
//       `this.emit('error', { … });` → `return { … };` (the fallback). THE
//       CALLER EMITS. Nothing else about either frame changed — same code, same
//       message, same `retryable`, same order of decision.
// **Any other difference is a bug.**
//
// ⚠️ THE FIRST DOC BLOCK IS A SUPERSEDED EARLIER ONE, KEPT WHERE IT SAT. It was
// already directly above the second, describing the same method in fewer words
// — it is not an orphan pointing at some other owner, so there was nothing to
// retarget, and deleting it would be deleting evidence. Read the second block as
// the current account.
//
// ⚠️ NO NEW CODES. `STT_ENGINE_TIMEOUT`, and whatever an `SttEngineError`
// carries, are existing registered codes; this module only decides which
// EXISTING sentence rides the frame.

import { SttEngineError } from './engines/base';

/** The `stt:error` frame for a flush-phase failure. `code` is `string` and not
 *  the protocol `ErrorCode` union for the same reason ColdOpenErrorFrame's is:
 *  it may carry an ENGINE's own code (`SttEngineError.code` is typed `string`),
 *  and narrowing it here would reject the very frames this verdict exists to let
 *  through. */
export interface FlushErrorFrame {
  code: string;
  message: string;
  retryable: boolean;
}

/** A flush-phase engine error is one-shot + retryable (a stateless HTTP batch
 *  engine has nothing to reconnect; a ws drop on release must not light the
 *  'reconnecting' pill). Surface stt:error only — never the ladder. */
/**
 * Flush-phase engine error. One-shot, never the ladder (there is nothing left
 * to reconnect for — the utterance is closing).
 *
 * 🔴 2026-08-02 (L2): the generic verdict is kept ONLY for errors that have no
 * verdict of their own. Found live: a real Soniox `402
 * organization_balance_exhausted` landed here instead of in the ladder purely
 * because that run's `open()` was ~1 s slower, so the refusal arrived after
 * `flush()` had begun. The user therefore got "STT engine failed during flush /
 * retryable:true" on one run and "STT_ENGINE_AUTH_FAIL /
 * [organization_balance_exhausted] / retryable:false" on the next — the SAME
 * event answered two ways, decided by a race. Two runs of the drill, same code:
 * see docs/strategy/shots-2026-08-02-l2-soniox/README.md §4.
 *
 * An engine that declared `retryable:false` has already answered the question,
 * and the phase it happened in does not change the answer.
 */
export function flushErrorVerdict(err: Error): FlushErrorFrame {
  if (err instanceof SttEngineError && err.retryable === false) {
    return { code: err.code, message: err.message, retryable: false };
  }
  return { code: 'STT_ENGINE_TIMEOUT', message: 'STT engine failed during flush', retryable: true };
}
