// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (three scenario
//     sources merged into ONE correction pipeline: ① card structured fields
//     ② application scenario (process_name→category) ③ dictionary reference
//     (personal terms as a "prefer these" list))
//   @flowmic/protocol ScenarioCardSchema / SETTINGS_KEY_SCENARIO_CARD /
//     composeDictionary + DICTIONARY_PACKS
//   docs/rebuild/05-DATA-MODEL.md §5 (stt.dictionary KV — the effective merged
//     dictionary the client ships via settings:update)
//   CLAUDE.md red line: no silent failures (bad scenario.card → fail loud, NOT silent skip)
//
// Reads the settings that back the scenario context and merges the three
// sources. The scenario.card value is zod-parsed with the protocol schema; a
// present-but-malformed card throws (SETTINGS_SCHEMA_INVALID) rather than being
// silently ignored — a corrupt profile must surface, not degrade transcription
// invisibly. An ABSENT card is fine (empty context → no scenario block).
//
// settings-key-drift GET ANCHOR (decision 2026-07-23-settings-key-drift-literal-
// anchors): now that WP-R3-3 gives the mobile a real UI SET surface, readCard
// reads scenario.card through a literal-keyed `readSetting('scenario.card')`
// local helper so the drift lint's GET regex has one real reader to pair with the
// mobile's `updateSetting('scenario.card')` writer — the mechanical "key has a
// live reader AND a live writer" proof (the old variable-key stance existed only
// while there was no UI set face, and is now retired). The literal here is the
// SETTINGS_KEY_SCENARIO_CARD SSOT value (asserted in compose-scenario.test). By
// contrast stt.dictionary keeps its VARIABLE-key read (STT_DICTIONARY_KEY): it
// still has no UI set surface this phase, so anchoring it would be a false match.

import {
  ScenarioCardSchema,
  composeDictionary,
  type ScenarioCard,
} from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { ServerError } from '../errors';
import type { ResolvedDescriptor } from './scenario-inference';
import type { ScenarioContext } from './scenario';
import type { TermRule } from './dictionary-replace';

// The effective personal dictionary the client ships (05 §5). Read as a
// variable — not a settings-key-drift get-site.
const STT_DICTIONARY_KEY = 'stt.dictionary';
// Upper bound on preferred-terminology entries injected into the prompt. The
// packs/dictionary are already capped at 300 upstream; this keeps the block
// bounded even if a user pastes a huge custom term list.
const MAX_PROMPT_TERMS = 200;

const EMPTY_CARD: ScenarioCard = { professions: [], domains: [], packs: [], terms: [] };

/** Read + validate the scenario.card value. Absent → empty card; present but
 *  invalid → throw (fail loud). */
function readCard(repo: SettingsRepo, userId: string): ScenarioCard {
  // The single literal-key GET anchor (settings-key-drift lint). It pairs with
  // the mobile updateSetting('scenario.card') SET anchor; the literal equals
  // SETTINGS_KEY_SCENARIO_CARD (test-pinned). Reads still funnel through the
  // repo's variable-key read() — this closure only exposes the ONE literal.
  const readSetting = (key: string): SettingRow | null => repo.read(userId, key);
  const row = readSetting('scenario.card');
  if (row === null || row.value === null || row.value === undefined) return EMPTY_CARD;
  const parsed = ScenarioCardSchema.safeParse(row.value);
  if (!parsed.success) {
    throw new ServerError('SETTINGS_SCHEMA_INVALID', `scenario.card failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/** Best-effort extraction of {term, weight, aliases} from the stt.dictionary
 *  value. The effective dictionary is an array of {term, weight?, aliases?};
 *  anything else contributes nothing (the dictionary is a hint source, not a
 *  hard schema gate here — the STT layer owns its validation). Aliases are kept
 *  so the deterministic-replacement leg can map a homophone/variant → the
 *  canonical; the weight is kept for the FunASR-hotwords consumer (it is inert
 *  in the replacer — see TermRule.weight). A non-finite weight is dropped, not
 *  coerced: the hotword builder's own clamp already owns "absent → default 20",
 *  and forwarding a NaN would ask it to answer a question it was not asked. */
function readDictionaryEntries(repo: SettingsRepo, userId: string): { term: string; weight?: number; aliases?: string[] }[] {
  const row = repo.read(userId, STT_DICTIONARY_KEY);
  const value = row?.value;
  if (!Array.isArray(value)) return [];
  const out: { term: string; weight?: number; aliases?: string[] }[] = [];
  for (const e of value) {
    if (e && typeof e === 'object' && typeof (e as { term?: unknown }).term === 'string') {
      const rawAliases = (e as { aliases?: unknown }).aliases;
      const aliases = Array.isArray(rawAliases)
        ? rawAliases.filter((a): a is string => typeof a === 'string')
        : undefined;
      const rawWeight = (e as { weight?: unknown }).weight;
      const weight = typeof rawWeight === 'number' && Number.isFinite(rawWeight) ? rawWeight : undefined;
      out.push({
        term: (e as { term: string }).term,
        ...(weight !== undefined ? { weight } : {}),
        ...(aliases && aliases.length > 0 ? { aliases } : {}),
      });
    }
  }
  return out;
}

/** The term strings only (source ③ of the LLM-reference channel). */
function readDictionaryTerms(repo: SettingsRepo, userId: string): string[] {
  return readDictionaryEntries(repo, userId).map((e) => e.term);
}

function dedupeNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Resolve the three-source scenario context for a user:
 *   ① card.professions / card.domains (structured)
 *   ② `appScenario` — the ALREADY-RESOLVED app descriptor (optional)
 *   ③ preferred terms = card.terms ∪ composeDictionary(card.packs) ∪
 *      stt.dictionary terms (deduped, capped)
 *
 * V2-08/F2 changed source ② from a process NAME to a resolved DESCRIPTOR. The
 * mapping used to be one call to `appCategoryDescriptor` right here; it is now
 * override > builtin > inferred, needs the user's llm.config (to know where the
 * model lives) and a process-lifetime cache, and none of that belongs in a
 * settings reader. ScenarioInferenceStore owns it and this function takes the
 * verdict as data — so there is exactly ONE place that decides what "what
 * scenario is this application" (这个程序是什么情景) means, instead of two that
 * can disagree.
 */
export function resolveScenarioContext(
  repo: SettingsRepo,
  userId: string,
  appScenario?: ResolvedDescriptor,
): ScenarioContext {
  const card = readCard(repo, userId);
  const packTerms = composeDictionary(card.packs).map((e) => e.term);
  const dictTerms = readDictionaryTerms(repo, userId);
  const terms = dedupeNonEmpty([...card.terms, ...packTerms, ...dictTerms]).slice(0, MAX_PROMPT_TERMS);
  // The SOURCE (override/builtin/inferred) is deliberately NOT rendered: the
  // block is a stable prompt prefix, and making its bytes depend on where a
  // descriptor came from would cost a prefix-cache miss to tell the model
  // something it has no use for. The source goes to the log instead.
  const appContext = appScenario?.descriptor;

  return {
    professions: dedupeNonEmpty(card.professions),
    domains: dedupeNonEmpty(card.domains),
    ...(appContext !== undefined ? { appContext } : {}),
    terms,
  };
}

/**
 * Resolve the deterministic-replacement rules (§4.1 source ③, the
 * "deterministic replacement" (确定性替换) leg) for a user — the SAME three
 * terminology sources the LLM-reference block
 * uses, but keeping each source's alias→canonical mapping:
 *   ① scenario-card custom terms — canonical only (Latin casing normalisation)
 *   ② enabled dictionary packs   — term + curated homophone aliases + weight
 *   ③ stt.dictionary entries     — user term + aliases + weight
 * Reuses readCard, so a present-but-malformed card fails loud here too (same
 * SETTINGS_SCHEMA_INVALID contract as resolveScenarioContext).
 *
 * Rules carry an OPTIONAL `weight` (legs ② and ③ only — the scenario card has
 * no weight field, so ① is left to the consumer's default). It is inert for the
 * deterministic replacer, which reads canonical/aliases only; the consumer that
 * reads it is `stt/engine-factory.ts loadHotwords`, which turns these rules into
 * the FunASR open-frame hotword weights. See TermRule.weight for why the field
 * has to exist at all (without it the curated pack weights would collapse to the
 * default on the way to the engine, invisibly).
 */
export function resolveReplacementRules(repo: SettingsRepo, userId: string): TermRule[] {
  const card = readCard(repo, userId);
  const rules: TermRule[] = [];
  for (const t of card.terms) {
    const canonical = t.trim();
    if (canonical.length > 0) rules.push({ canonical });
  }
  for (const e of composeDictionary(card.packs)) {
    rules.push({
      canonical: e.term,
      ...(typeof e.weight === 'number' ? { weight: e.weight } : {}),
      ...(e.aliases && e.aliases.length > 0 ? { aliases: e.aliases } : {}),
    });
  }
  for (const e of readDictionaryEntries(repo, userId)) {
    rules.push({
      canonical: e.term,
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      ...(e.aliases && e.aliases.length > 0 ? { aliases: e.aliases } : {}),
    });
  }
  return rules;
}
