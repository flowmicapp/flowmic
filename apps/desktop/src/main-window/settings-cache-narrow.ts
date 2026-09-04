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
//
// 🔴 SHRUNK ON 2026-09-03 (owner ruling, phone-owned preferences). `asBoolean`,
// `asPolishStrength`, `asDictionary`, `asCard` and `asConsentRow` went with the
// screens whose cached values they salvaged — the scenario card, AI polish,
// two-pass refine, the personal dictionary and the inference consent are the
// phone's now and never reach this end. They are not kept "in case": a narrowing
// function with no caller is a claim that something on this machine still reads
// that cache, and nothing does.

import { localKv } from '../lib/storage';

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
 *  outlive upgrades, so `model.llm.preset_id`, `model.routings[i].language` and
 *  friends were one older-build cache away from throwing during render and
 *  blanking the whole settings page. Every key now goes through a narrowing
 *  function; a value that cannot be salvaged falls back to the same default a
 *  fresh install gets. */
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
