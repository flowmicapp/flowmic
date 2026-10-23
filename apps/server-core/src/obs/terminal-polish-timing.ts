import { log } from '../log';
import { baseLanguage, tcorr } from './utterance-timing';
import { guardFamily, modelFields } from './polish-telemetry';
import { polishFinalText, type PolishDeps, type PolishResult } from '../stt/stt-polish';
import type { SelectedLlmConfig } from '../compose/llm-config';
import type { PolishStage } from '../engine/stt-session-polish-timing';

/** The bridge's terminal-only call. Logging cannot change the chosen text or wire reason. */
/** Card INC-1e/1f — which call this was: the whole text (today's only call), a
 *  piece requested while speaking (`spec`), or a gap/tail polished after the
 *  final arrived (`release`). Absent ⇒ `whole`. */
export interface PolishPhase { phase: 'spec' | 'release'; span_idx: number; ctx_chars: number }

export async function observedPolishFinalText(text: string, selected: SelectedLlmConfig, deps: PolishDeps, utteranceId?: string, isSegment?: boolean, phase?: PolishPhase, stage?: PolishStage, afterHoldCap?: () => boolean): Promise<PolishResult> {
  const result = await polishFinalText(text, selected.cfg, { ...deps, ...(utteranceId ? { utteranceId } : {}) });
  try {
    // Card POL-3: read when the answer is in. The stage-1 hold cap aborted this request
    // (engine/stt-session-units.ts) ⇒ the row timed out: `timeout`, not the `llm_error`
    // the internal `cancelled` reason maps to — and that holds for the ROW whatever the
    // request did afterwards, so this record and `stt.polish.final` (hold_cap_hit) agree.
    // The request's own result (cancelled, applied, guard_reject, …) goes to `late_outcome`.
    const late = afterHoldCap?.() === true;
    const own = result.reason === 'cancelled' && late ? 'cancelled' : result.reason === 'empty-input' ? 'empty_input' : result.reason === 'empty-output' ? 'empty_output'
      : result.reason === 'exception' ? 'exception' : result.skipReason ?? (result.timing?.cacheHit ? 'cache_hit' : 'applied');
    const outcome = late ? 'timeout' : own;
    log.info('stt.polish.timing', {
      // Card SEG-1: soft-segment polishes must not mix into the terminal latency baseline.
      tcorr: tcorr(utteranceId), is_segment: isSegment === true, outcome,
      phase: phase?.phase ?? 'whole', span_idx: phase?.span_idx ?? null, ctx_chars: phase?.ctx_chars ?? null, // INC-1e
      // Card POL-1 — the unit (segment / tail / whole) when the caller knows it: the
      // bridge's whole-text path does (stt-session-polish.ts passes `clock.stage`);
      // a piece requested while speaking does not ⇒ the key is OMITTED, never guessed.
      ...(stage !== undefined ? { stage } : {}),
      ...(late ? { after_hold_cap: true, late_outcome: own } : {}), // POL-3: absent unless the cap fired
      elapsed_ms: result.timing?.elapsedMs ?? null,
      ttfb_ms: result.timing?.ttfbMs ?? null, budget_ms: result.timing?.budgetMs ?? null,
      chars_in: text.length, chars_out: result.timing?.charsOut ?? result.text.length,
      strength: deps.strength ?? 'strict', lang: baseLanguage(deps.language), ...modelFields(selected),
      finish_reason: result.timing?.finishReason ?? 'none',
      // QP-1: `strength` above is what was REQUESTED; these say what was delivered
      // and, when the Smooth -> Strict fallback was considered, why smooth failed.
      // The FAMILY only: a raw reason can carry a dictionary term (privacy).
      applied_strength: result.reason === undefined ? result.appliedStrength ?? deps.strength ?? 'strict' : null,
      // Two calls ⇒ ttfb_ms / chars_out / finish_reason above describe the strict
      // call; the smooth call's own numbers are the first_* fields.
      attempts: result.firstCall ? 2 : 1,
      first_elapsed_ms: result.firstCall?.elapsedMs ?? null,
      first_ttfb_ms: result.firstCall?.ttfbMs ?? null,
      first_chars_out: result.firstCall?.charsOut ?? null,
      first_finish_reason: result.firstCall?.finishReason ?? null,
      first_reject: result.firstReject === undefined ? null
        : result.firstReject === 'empty-output' ? 'empty_output' : guardFamily(result.firstReject),
    });
  } catch { /* Observation cannot change the result or the final's wire signal. */ }
  return result;
}
