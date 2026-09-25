// The async cold-open failure nobody was told about (card K-7) — moved
// VERBATIM out of `stt-session.ts` `onColdOpenRejection`.
//
// ⚠️ THE SPLIT WAS FORCED BY THE 800-LINE CAP (verify/lint/file-size.mjs
// SRC_MAX), not by an architectural claim: `stt-session.ts` stood at 799 lines
// and card RC-1b/RC-6 (2026-09-24) have to change its settle and intake lines.
// Same reading as `stt-session-autostop.ts` / `stt-session-refine.ts` — a
// movable family, not a new layer. The mechanical edits: the receiver
// `this.deps` became the parameter `deps`, and the `SttConfigMissingError`
// import moved here with its only reader. The one caller is `stt-session.ts`
// `onColdOpenRejection`, which is wiring and nothing else.

import { SttConfigMissingError } from '../stt/engine-router';
import { log } from '../log';
import type { SttSessionDeps } from './stt-session-deps';

/**
 * 🔴 card K-7 — THE ONE COLD-OPEN FAILURE NOBODY WAS TOLD ABOUT.
 *
 * `SttEngineOrchestrator.start()` narrates every spawn failure on its own
 * 'error' event (→ `stt:error` through [[wireEvents]]) and then rethrows —
 * every failure but one. The ROUTER's `SttConfigMissingError` is rethrown
 * BEFORE those two emits (orchestrator-core.ts, `if (err instanceof
 * SttConfigMissingError) throw err`), on the documented premise that it
 * "propagates raw (audio.handler maps it)".
 *
 * That premise has been false since this constructor started firing `start()`
 * and forgetting it. Nothing above this line awaits `startPromise`, so the
 * rejection reaches no handler; `audio.handler` has already called
 * `safeAck(ack, {ok:true})` by the time it arrives. So the honest description
 * of the old `.catch(() => undefined)` is: a silent swallow AND a false
 * success — the two halves of the red line, at once, on the failure whose
 * whole job is to say "this account has no engine for this language".
 *
 * ⚠️ NOT a second copy of the other arms' reporting: this branch is the exact
 * complement of the `throw err` above (`instanceof` on one side, everything
 * else on the other), so a code that already spoke never speaks twice. A
 * non-config rejection returns silently here for that reason and no other.
 *
 * ⚠️ There is a SYNCHRONOUS `SttConfigMissingError` path too — `deps.build`
 * throwing out of this constructor, which reaches `audio.handler`'s engine
 * catch and is answered there. This is the ASYNC one, at spawn time, and it
 * had no answer at all.
 */
export function reportColdOpenRejection(deps: Pick<SttSessionDeps, 'userId' | 'sourceLang' | 'emitter'>, err: unknown): void {
  if (!(err instanceof SttConfigMissingError)) return;
  log.error('stt cold open: no engine configured for this session — the phone was never told', {
    user_id: deps.userId,
    language: deps.sourceLang,
    error: err.message,
  });
  // 🔴 card C1 (2026-08-17): the THROWER's code, not a literal. The async arm
  // has to agree with the synchronous one in audio.handler.ts — the same
  // failure reaching the phone by a different route must not get a different
  // sentence, and a pool refusal answered with 「该语言尚未配置识别引擎」 is
  // false on every relay that has a pool.
  deps.emitter.emit('stt:error', {
    code: err.code,
    message: err.message,
    retryable: false,
  });
}
