import { log } from '../log';
import { checkOriginalBounds } from '../stt/stt-polish-guard-bounds';
import { checkMeaningPreservedV2 } from '../stt/stt-polish-guard-v2';
import { baseLanguage, tcorr } from './utterance-timing';
import { closedClassDeltas } from '../stt/stt-polish-guard-deltas';
import type { GuardResult } from '../stt/stt-polish-guard';
interface PolishDeps { utteranceId?: string; language?: string; strength?: 'strict' | 'smooth'; protectedTerms?: readonly string[] }
import type { SelectedLlmConfig } from '../compose/llm-config';

export function guardFamily(reason?: string): string {
  if (reason?.startsWith('closed-class-drift:')) return 'closed_class';
  if (reason?.startsWith('dict-term-drift:')) return 'dict';
  return ({ 'edit-distance-exceeded': 'edit', 'length-ratio-exceeded': 'length',
    'han-count-exceeded': 'han', 'open-class-delta-exceeded': 'open_class' } as Record<string, string>)[reason ?? ''] ?? 'none';
}

export function logPolishGuard(raw: string, polished: string, guard: GuardResult, deps: PolishDeps): void {
  // No await remains between this call and the final's promise continuation.
  // An immediate runs after those microtasks (including the final emit), and
  // this callback only logs: it cannot emit or reorder protocol frames.
  try {
    setImmediate(() => {
      try { recordPolishGuard(raw, polished, guard, deps); }
      catch { /* All observation failures, including metrics and logger, are isolated. */ }
    });
  } catch { /* Scheduling is also optional telemetry, never a polish failure. */ }
}

function recordPolishGuard(raw: string, polished: string, guard: GuardResult, deps: PolishDeps): void {
  const skipped = Math.max(raw.length, polished.length) > 1500;
  const m = guard.metrics ?? (skipped ? undefined : checkOriginalBounds(raw, polished, {
    ...(deps.strength ? { strength: deps.strength } : {}),
    ...(deps.protectedTerms ? { declaredTerms: deps.protectedTerms } : {}),
  }).metrics);
  // Record only. Dictionary refusal remains decisive in both reported verdicts.
  let shadow: ReturnType<typeof checkMeaningPreservedV2> | null = null;
  try {
    if (!skipped) shadow = checkMeaningPreservedV2(raw, polished, { ...(deps.strength ? { strength: deps.strength } : {}), ...(deps.protectedTerms ? { declaredTerms: deps.protectedTerms } : {}), ...(deps.language ? { language: deps.language } : {}) });
    if (shadow && guardFamily(guard.reason) === 'dict') shadow = { ...shadow, ok: false, reason: 'dict-term-drift:' };
  } catch { /* Observation failure must not change a live decision. Null means unmeasured. */ }
  log.info('stt.polish.guard', {
    tcorr: tcorr(deps.utteranceId), verdict: guard.ok ? 'ok' : 'reject', family: guardFamily(guard.reason),
    ...(skipped ? { first_category: null, d_numeral: null, d_digit: null, d_modal: null, d_negation: null, d_quantifier: null } : closedClassDeltas(raw, polished)), distance: m?.distance ?? null, edit_bound: m?.editBound ?? null,
    length_ratio: m?.lengthRatio ?? null, open_class_delta: m?.openClassDelta ?? null,
    open_class_k: m?.openClassK ?? null, strength: deps.strength ?? 'strict', lang: baseLanguage(deps.language),
    v2_verdict: shadow === null ? null : shadow.ok ? 'ok' : 'reject', v2_family: skipped ? 'skipped_len' : shadow === null ? null : guardFamily(shadow.reason),
    v2_explained: shadow?.explained ?? null,
  });
}

export function modelFields(selected: SelectedLlmConfig): { llm_source: 'managed' | 'user' | 'seed'; model: string } {
  const source = selected.source === 'managed-default' ? 'managed' : selected.source;
  return { llm_source: source, model: source === 'managed' ? selected.cfg.model : 'byok' };
}
