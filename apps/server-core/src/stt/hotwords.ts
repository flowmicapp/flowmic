// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (hotwords F-2117: stt.dictionary →
//     FunASR open-frame hotwords JSON-string {term:weight}, default weight
//     20, clamp 10..50, empty dictionary omits the field, cap 300)
//   Ported from legacy stt/hotwords.ts (mechanism follows the legacy line).
//
// Pure builder for the FunASR FST `hotwords` open-frame field. Given the
// `stt.dictionary` entries, emits the FunASR-wire `hotwords` value: a JSON
// STRING of `{term: weight}` pairs (NOT a nested object), e.g. '{"FlowMic":20}'.

/** A single `stt.dictionary` entry. Only `term`/`weight` participate here. */
export interface SttDictionaryEntry {
  term: string;
  weight?: number;
  aliases?: string[];
}

export const HOTWORD_DEFAULT_WEIGHT = 20;
export const HOTWORD_MIN_WEIGHT = 10;
export const HOTWORD_MAX_WEIGHT = 50;
export const HOTWORDS_MAX_ENTRIES = 300;

/** Clamp a hotword weight into the `[10, 50]` band, defaulting to 20. */
export function clampHotwordWeight(weight: number | undefined): number {
  const w = typeof weight === 'number' && Number.isFinite(weight)
    ? weight
    : HOTWORD_DEFAULT_WEIGHT;
  if (w < HOTWORD_MIN_WEIGHT) return HOTWORD_MIN_WEIGHT;
  if (w > HOTWORD_MAX_WEIGHT) return HOTWORD_MAX_WEIGHT;
  return Math.round(w);
}

/**
 * Build the FunASR open-frame `hotwords` value from `stt.dictionary` entries.
 * Returns a JSON string of `{term: weight}` pairs, or `undefined` when there is
 * nothing to send (empty/absent dictionary, or every entry malformed) — the
 * caller MUST then omit the field so the open frame stays baseline-identical.
 * Pure: no network / disk / clock. Safe on the live STT open path.
 */
export function buildHotwords(
  entries: readonly SttDictionaryEntry[] | null | undefined,
): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const map = Object.create(null) as Record<string, number>;
  let count = 0;
  for (const entry of entries) {
    if (count >= HOTWORDS_MAX_ENTRIES) break;
    if (entry === null || typeof entry !== 'object') continue;
    const term = typeof entry.term === 'string' ? entry.term.trim() : '';
    if (term.length === 0) continue;
    map[term] = clampHotwordWeight(entry.weight);
    count += 1;
  }

  if (Object.keys(map).length === 0) return undefined;
  return JSON.stringify(map);
}
