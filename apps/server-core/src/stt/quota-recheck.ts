// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.B④ (owner 2026-08-29: 「服务器端也是需要间歇性地来去检测它的可用分钟数的……
//     比如在你跟 Soniox 连接的时候，然后你可能要去检查一下，但这个过程要很短，提高性能」)
//   apps/server-core/src/stt/audio/session.ts (setQuotaRefresher / refreshQuotaBudget —
//     the RULE: when to read, when to refuse, what to do with the answer)
//   CLAUDE.md red line: no silent failure, in both directions
//
// ── ONE LINE OF BEHAVIOUR, AND WHY IT LIVES IN ITS OWN FILE ─────────────────
//
// `orchestrator-core.ts` sits at the 800-line cap (`verify:lint file-size`), and
// this repo's standing answer to that cap is a STRUCTURAL split — take a
// coherent family out whole — rather than trimming the reasoning a comment
// carries. The family here is small but genuinely one thing: 「a leg is being
// born, so we are about to spend money again — is the budget still what we were
// told at audio:start?」 The WHEN lives in the orchestrator (it owns leg birth),
// the RULE lives in AudioSession, and what is left over — the failure direction
// and the log line — is this file.
//
// ── WHY IT CATCHES, AND WHY THE CATCH IS NOT IN AudioSession ────────────────
//
// AudioSession has no honest place to put a log line, so `refreshQuotaBudget`
// propagates. Something has to decide what a failed read MEANS, and the answer
// is a product decision rather than a data-structure one:
//
//   · it must NOT stop the recording. A database hiccup would then cost a
//     meeting, and the whole point of continuous transcription is that the
//     user's words survive things going wrong around them;
//   · it must NOT be swallowed either. 「we could not re-check」 and 「there was
//     nothing to re-check」 are different facts, and only one of them is fine.
//
// ⇒ keep the previously declared budget, let the leg be born, and say so.

import { log } from '../log';

/** The slice of AudioSession this needs. Narrow on purpose: it makes the unit
 *  testable without an engine, and it makes the dependency direction obvious —
 *  nothing here reaches back into the orchestrator. */
export interface QuotaRecheckable {
  refreshQuotaBudget(): void;
}

/**
 * Re-check the monthly budget at the birth of an engine leg.
 *
 * Safe to call on every leg: the floor, the no-ceiling short-circuit and the
 * state guard all live in {@link QuotaRecheckable.refreshQuotaBudget}, so this
 * is a cheap no-op in every case where a read would be wasted.
 *
 * @returns `true` when the check ran without throwing — `false` means the
 *          previous budget still stands. Returned rather than kept private so a
 *          caller that wants to count failures can, and so a test can assert
 *          「it failed AND the leg still happened」 in one expression.
 */
export function recheckQuotaOnLegBirth(session: QuotaRecheckable): boolean {
  try {
    session.refreshQuotaBudget();
    return true;
  } catch (err) {
    log.warn('stt.quota re-check failed; keeping the previously declared budget', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
