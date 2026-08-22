// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §6 (spoken language → the ready model, one value one question)
//   CLAUDE.md red line: 绝不许串号 in model form — task §3-3: a language the
//     user never downloaded a model for must REFUSE, never silently borrow a
//     model downloaded for another language that cannot recognise it.
//
// The §6 ladder, verbatim:
//   1. the model the user EXPLICITLY SELECTED for this language, if ready;
//   2. otherwise any ready model claiming the language — preferring the
//      recommended tier, then multilingual, then lite;
//   3. otherwise: nothing (the caller throws the loud STT_CONFIG_MISSING).
//
// "Ready" is the controller's verdict (integrity-verified files, no download
// in flight, loadable this phase) — the stat-keyed memo makes the repeated
// per-utterance asks cheap.

import {
  catalogRowsForLanguage, isLoadableThisPhase, isWildcardLang, MODEL_CATALOG,
  type CatalogModel, type CatalogTier,
} from './model-catalog';
import { getModelController } from './model-downloader';
import { resolveModelDir } from './model-manifest';
import { readModelSelection } from './model-selection';

export interface ResolvedModel {
  row: CatalogModel;
  dir: string;
}

const TIER_ORDER: readonly CatalogTier[] = ['recommended', 'multilingual', 'lite'];

/** §6-2's preference order for one language: the selected row first, then by
 *  tier. Streaming rows are excluded before anything else — they can never be
 *  "the model that will open". */
/** Test seam: a synthetic catalog/selection. Production passes neither — the
 *  real catalog rows carry pinned sizes/hashes, so a suite exercising the
 *  LADDER would otherwise have to stage gigabytes of correct bytes per case. */
export interface ResolveSeams {
  catalog?: readonly CatalogModel[];
  selection?: Record<string, string>;
}

export function candidateRowsForLanguage(
  language: string,
  selection: Record<string, string>,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): CatalogModel[] {
  if (isWildcardLang(language)) {
    // No language named ⇒ any loadable model may serve. Selected rows first
    // (they are the user's stated preferences), then catalog order — which
    // deliberately starts with SenseVoice, preserving the pre-LM-CAT auto
    // behaviour on machines that downloaded it.
    const selected = [...new Set(Object.values(selection))];
    const rest = catalog.filter((m) => !selected.includes(m.model_id));
    return [...selected.map((id) => catalog.find((m) => m.model_id === id)).filter((m): m is CatalogModel => m !== undefined), ...rest]
      .filter(isLoadableThisPhase);
  }
  const base = language.trim().toLowerCase().split('-')[0] ?? language;
  const rows = catalog === MODEL_CATALOG
    ? catalogRowsForLanguage(language).filter(isLoadableThisPhase)
    : catalog.filter((m) => m.spoken.includes(base)).filter(isLoadableThisPhase);
  const selectedId = selection[base];
  const byTier = [...rows].sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
  );
  if (!selectedId) return byTier;
  const chosen = byTier.filter((m) => m.model_id === selectedId);
  return [...chosen, ...byTier.filter((m) => m.model_id !== selectedId)];
}

/**
 * The first candidate that is actually ready on disk, or null. Sequential on
 * purpose: readiness is a (memoised) SHA-256 in the worst case, and asking
 * candidates in preference order means the common case — the selected model
 * is ready — costs exactly one memo hit.
 */
export async function resolveReadyModelForLanguage(
  language: string,
  env: NodeJS.ProcessEnv = process.env,
  seams: ResolveSeams = {},
): Promise<ResolvedModel | null> {
  const selection = seams.selection ?? readModelSelection(env);
  for (const row of candidateRowsForLanguage(language, selection, seams.catalog)) {
    const controller = getModelController(row, env);
    if (await controller.isReady()) {
      return { row, dir: resolveModelDir(row.model_id, env) };
    }
  }
  return null;
}
