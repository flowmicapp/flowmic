import { log } from '../log';
import { baseLanguage, tcorr } from './utterance-timing';
import { modelFields } from './polish-telemetry';
import { polishFinalText, type PolishDeps, type PolishResult } from '../stt/stt-polish';
import type { SelectedLlmConfig } from '../compose/llm-config';

/** The bridge's terminal-only call. Logging cannot change the chosen text or wire reason. */
export async function observedPolishFinalText(text: string, selected: SelectedLlmConfig, deps: PolishDeps, utteranceId?: string): Promise<PolishResult> {
  const result = await polishFinalText(text, selected.cfg, { ...deps, ...(utteranceId ? { utteranceId } : {}) });
  try {
    const outcome = result.reason === 'empty-input' ? 'empty_input' : result.reason === 'empty-output' ? 'empty_output'
      : result.reason === 'exception' ? 'exception' : result.skipReason ?? (result.timing?.cacheHit ? 'cache_hit' : 'applied');
    log.info('stt.polish.timing', {
      tcorr: tcorr(utteranceId), outcome, elapsed_ms: result.timing?.elapsedMs ?? null,
      ttfb_ms: result.timing?.ttfbMs ?? null, budget_ms: result.timing?.budgetMs ?? null,
      chars_in: text.length, chars_out: result.timing?.charsOut ?? result.text.length,
      strength: deps.strength ?? 'strict', lang: baseLanguage(deps.language), ...modelFields(selected),
      finish_reason: result.timing?.finishReason ?? 'none',
    });
  } catch { /* Observation cannot change the result or the final's wire signal. */ }
  return result;
}
