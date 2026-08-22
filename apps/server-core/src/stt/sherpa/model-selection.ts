// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §6 (the per-language selection is LOCAL state: sidecar-side, never in
//     the protocol, never on the phone — the phone keeps sending only
//     `source_lang`)
//
// WHO WRITES IT: exactly one action — the user picking a model for a language
// on the desktop card (POST /api/stt/model/download with a `lang`). WHO READS
// IT: model-resolve.ts, first rung of the §6 ladder.
//
// It lives beside the models-ROOT pointer in the FIXED app data dir, not under
// the movable models root: a selection names model ids, which stay meaningful
// when the user re-points the root — storing it under the root would silently
// reset every choice on a directory change.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelsRootPointerPath } from './model-manifest';
import { catalogModelById, CATALOG_SPOKEN_LANGS, sherpaModelCanRecognize } from './model-catalog';

const SELECTION_FILE = 'stt-model-selection.json';

function selectionPath(env: NodeJS.ProcessEnv): string {
  // Same fixed directory the root pointer lives in (…/FlowMic/).
  return join(modelsRootPointerPath(env), '..', SELECTION_FILE);
}

/**
 * lang (bare code) → model_id. Entries that no longer parse are DROPPED ON
 * READ, loudly-typed rather than silently trusted: an id the catalog no
 * longer carries, or a lang outside the catalog keys, cannot be resolved by
 * anybody downstream — returning it would push the failure to a layer with
 * no idea where the bad value came from.
 */
export function readModelSelection(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(selectionPath(env), 'utf8'));
  } catch {
    return {};
  }
  const raw = (parsed as { selected_by_lang?: unknown }).selected_by_lang;
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [lang, id] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string') continue;
    if (!CATALOG_SPOKEN_LANGS.includes(lang)) continue;
    const row = catalogModelById(id);
    if (!row || !sherpaModelCanRecognize(lang, row)) continue;
    out[lang] = id;
  }
  return out;
}

/**
 * Record "for `lang`, use `modelId`". THROWS on a pair the catalog cannot
 * honour — the http route turns that into a 400 instead of persisting a
 * selection that resolution would have to ignore forever.
 */
export function writeModelSelection(lang: string, modelId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!CATALOG_SPOKEN_LANGS.includes(lang)) {
    throw new Error(`'${lang}' is not a catalog spoken-language key`);
  }
  const row = catalogModelById(modelId);
  if (!row) throw new Error(`unknown model_id '${modelId}'`);
  if (!sherpaModelCanRecognize(lang, row)) {
    throw new Error(`model '${modelId}' does not claim language '${lang}'`);
  }
  const next = { ...readModelSelection(env), [lang]: modelId };
  const p = selectionPath(env);
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ selected_by_lang: next }, null, 2));
  renameSync(tmp, p);
}
