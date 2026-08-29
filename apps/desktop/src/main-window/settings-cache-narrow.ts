// The settings page's DISPLAY-CACHE NARROWING LAYER — how a value read back out
// of localStorage (or off a server snapshot) becomes a value the templates are
// allowed to render.
//
// 🔴 MOVED OUT WHOLE from ./settings-model.ts on 2026-08-28, when that file hit
// the 800-line cap on the vendor-catalogue card. Every function below arrived
// VERBATIM, comments included — this is a relocation, not a rewrite, and nothing
// here was simplified on the way over. The repo's own rule for this split
// (CLAUDE.md, 0.2.52 §5): at the cap, extract a coherent FAMILY, never delete
// comments to make room. `settings-model.ts` is now one of this module's call
// sites rather than a second opinion about what a salvageable value is.
//
// Why THIS family: these are the only pure functions in that file. They touch no
// `model`, no store, no bridge — so the seam is a real one (the extraction closes
// no import cycle and opens none), and the module can be unit-tested without
// standing up the reactive singleton.

import {
  POLISH_STRENGTHS,
  ScenarioCardSchema,
  type PolishStrength,
  type ScenarioCard,
  type ScenarioInferenceConsent,
} from '@flowmic/protocol';
import { localKv } from '../lib/storage';

export interface DictEntry {
  term: string;
  aliases?: string[];
  weight?: number;
}
export interface LlmConfigModel {
  preset_id: string;
  protocol: string;
  endpoint: string;
  api_key: string;
  model: string;
}

/** owner 2026-07-27 — the same class as the "PC timeline page renders entirely
 *  blank" defect, on the page with the most surface.
 *
 *  The old `load<T>` returned `JSON.parse(raw) as T`: only a PARSE failure fell
 *  back, so any value that parsed but had a different shape — including a literal
 *  `null`, which parses fine — was handed to the templates verbatim. These caches
 *  outlive upgrades, so `model.card.professions.includes(…)`,
 *  `model.llm.preset_id`, `model.dictionary.length` and friends were one
 *  older-build cache away from throwing during render and blanking the whole
 *  settings page. Every key now goes through a narrowing function; a value that
 *  cannot be salvaged falls back to the same default a fresh install gets. */
export function loadWith<T>(key: string, fallback: T, narrow: (v: unknown) => T | null): T {
  const raw = localKv.get(key);
  if (raw === null) return fallback;
  try {
    return narrow(JSON.parse(raw) as unknown) ?? fallback;
  } catch {
    return fallback;
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function asStr(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}
export function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Card C8 — the correction strength, narrowed against the protocol's own
 *  enum rather than a string literal copied into this file. An unrecognised
 *  value returns null so [loadWith] falls back to the default, which is the
 *  same stance every other key here takes. */
export function asPolishStrength(v: unknown): PolishStrength | null {
  return typeof v === 'string' && (POLISH_STRENGTHS as readonly string[]).includes(v)
    ? (v as PolishStrength)
    : null;
}
export function asDictionary(v: unknown): DictEntry[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).flatMap((d) => {
    const term = asStr(d.term);
    if (term === '') return [];
    const out: DictEntry = { term };
    // The template renders `d.aliases.join('、')` behind a truthy `.length` check
    // — which a STRING also satisfies, so a string here threw `.join is not a
    // function`. Normalize to a real array of strings either way.
    if (Array.isArray(d.aliases)) {
      out.aliases = d.aliases.filter((a): a is string => typeof a === 'string');
    } else if (typeof d.aliases === 'string' && d.aliases !== '') {
      out.aliases = [d.aliases];
    }
    if (typeof d.weight === 'number' && Number.isFinite(d.weight)) out.weight = d.weight;
    return [out];
  });
}

export function asLlmConfig(v: unknown): LlmConfigModel | null {
  if (!isObj(v)) return null;
  return {
    preset_id: asStr(v.preset_id),
    protocol: asStr(v.protocol, 'openai-compatible'),
    endpoint: asStr(v.endpoint),
    api_key: asStr(v.api_key),
    model: asStr(v.model),
  };
}

/** The card has a real schema, so validate against THAT rather than restating it.
 *  A card that fails only on a bound (one over-long term) is salvaged field by
 *  field instead of discarded — these strings are the owner's own content, and
 *  silently emptying their scenario card would be its own kind of lie. */
export function asCard(v: unknown): ScenarioCard | null {
  const parsed = ScenarioCardSchema.safeParse(v);
  if (parsed.success) return parsed.data;
  if (!isObj(v)) return null;
  const arr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  return {
    professions: arr(v.professions),
    domains: arr(v.domains),
    packs: arr(v.packs),
    terms: arr(v.terms),
  };
}
/** The V2-08 consent row, narrowed from EITHER source it can arrive from: the
 *  local display cache and the server snapshot both hold the same stored shape
 *  (`{granted, granted_for}`), so there is one narrowing function rather than two
 *  that could disagree about what counts as a consent.
 *
 *  Anything else — including a row whose `granted_for` is outside the closed
 *  vocabulary — reads as NO CONSENT, which is exactly what server-core's reader
 *  does with it. Salvaging a partial row would be inventing an agreement. */
export function asConsentRow(v: unknown): ScenarioInferenceConsent | null {
  if (!isObj(v)) return null;
  const granted = v.granted;
  const grantedFor = v.granted_for;
  if (typeof granted !== 'boolean') return null;
  if (grantedFor !== 'local' && grantedFor !== 'external') return null;
  return { granted, grantedFor };
}
