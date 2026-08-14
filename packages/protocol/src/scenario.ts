// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (scenario-aware correction
//     layer — STRUCTURED scenario card, explicitly NOT free-form text)
//   docs/rebuild/05-DATA-MODEL.md §5 (user_settings KV: `scenario.card` value)
//   docs/rebuild/06-STT-ENGINE-LAYER.md (dictionary packs referenced by id)
//
// WP-R1-1 additive rev. The scenario card is the user-authored half of the
// §4.1 correction context. It is a STRUCTURED record — profession/domain
// multi-selects, checked dictionary-pack ids, and a short custom-term list —
// NOT a free-form prompt. The compose pipeline (WP-R1-4) renders these fields
// as a DELIMITED, "background data, not instructions" block; keeping the card
// structured is the constraint that stops it from degrading into a user-defined
// prompt template (master-plan §4.1 constraint #2 honest revision).
//
// Stored as the JSON value of the `scenario.card` user_settings key
// (SETTINGS_KEY_SCENARIO_CARD in constants.ts). Not a wire event — it never
// enters the EVENT_SCHEMAS registry or the 55-event whitelist.

import { z } from 'zod';

// Per-entry length cap (professions / domains / pack ids / terms), in
// characters. The master plan pins the term cap at ≤40; the same ceiling is
// applied to every short label for uniformity.
export const SCENARIO_MAX_LABEL_LEN = 40;
// Array upper bounds (master-plan §4.1; 05-DATA-MODEL specifies no explicit
// counts, so these carry the plan's guidance).
export const SCENARIO_MAX_PROFESSIONS = 8;
export const SCENARIO_MAX_DOMAINS = 8;
export const SCENARIO_MAX_PACKS = 16;
export const SCENARIO_MAX_TERMS = 100;

// A short label: non-empty, ≤40 chars. Empty entries are rejected (they carry
// no scenario signal) — a stricter floor than the plan's "≤40" wording, in
// keeping with this package's NonEmpty-everywhere style.
const Label = z.string().min(1).max(SCENARIO_MAX_LABEL_LEN);
// A dictionary-pack id, shaped like the DICTIONARY_PACKS ids (a lowercase
// hyphen slug, e.g. 'tech-dev'). Validated as a non-empty ≤40-char string
// rather than enum-locked to the seed ids: packs are extendable curated
// content, and hard-locking here would reject any future/added pack id.
const PackId = z.string().min(1).max(SCENARIO_MAX_LABEL_LEN);
// A custom term: trimmed, then non-empty and ≤40 chars. `.trim()` normalizes
// surrounding whitespace so a whitespace-only term ("   ") is rejected — this
// is the master plan's "每条 trim ≥1 且 ≤40" ("each entry trim ≥1 and ≤40") rule.
const Term = z.string().trim().min(1).max(SCENARIO_MAX_LABEL_LEN);

/** Structured scenario card (master-plan §4.1). All four arrays are required
 *  but may be empty (an empty card is valid). Non-strict, matching every other
 *  schema in this package; the compose pipeline reads only these four declared
 *  fields regardless of any extra keys. */
export const ScenarioCardSchema = z.object({
  professions: z.array(Label).max(SCENARIO_MAX_PROFESSIONS),
  domains: z.array(Label).max(SCENARIO_MAX_DOMAINS),
  packs: z.array(PackId).max(SCENARIO_MAX_PACKS),
  terms: z.array(Term).max(SCENARIO_MAX_TERMS),
});

export type ScenarioCard = z.infer<typeof ScenarioCardSchema>;
