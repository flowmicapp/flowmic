// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (three scenario
//     sources merged into ONE correction pipeline: ① card structured fields
//     ② application scenario (process_name→category) ③ dictionary reference
//     (personal terms as a "prefer these" list))
//   @flowmic/protocol ScenarioCardSchema / SETTINGS_KEY_SCENARIO_CARD /
//     composeDictionary + DICTIONARY_PACKS
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md Q1
//     (the personal dictionary retires; aliases move onto the card's terms)
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
// SETTINGS_KEY_SCENARIO_CARD SSOT value (asserted in compose-scenario.test).
//
// 2026-09-03 (owner ruling Q1): the personal dictionary (`stt.dictionary`) is
// RETIRED. This file used to read it as a third terminology source; that read
// is gone, its aliases now ride the card's terms (protocol scenario.ts), and
// the session overlay answers null for the key so no stale row can act.

import {
  ScenarioCardSchema,
  composeDictionary,
  type ScenarioCard,
  aliasesOf,
  termOf,
} from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { ServerError } from '../errors';
import type { ResolvedDescriptor } from './scenario-inference';
import type { ScenarioContext } from './scenario';
import type { TermRule } from './dictionary-replace';

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
 *   ③ preferred terms = card.terms ∪ composeDictionary(card.packs)
 *      (deduped, capped)
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
  // Card terms may carry aliases since 2026-09-03 (owner ruling Q1); the prompt
  // block lists canonical spellings only, exactly as before.
  const cardTerms = card.terms.map(termOf);
  const terms = dedupeNonEmpty([...cardTerms, ...packTerms]).slice(0, MAX_PROMPT_TERMS);
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
 *   ① scenario-card custom terms — canonical + the user's own aliases (Q1)
 *   ② enabled dictionary packs   — term + curated homophone aliases + weight
 * Reuses readCard, so a present-but-malformed card fails loud here too (same
 * SETTINGS_SCHEMA_INVALID contract as resolveScenarioContext).
 *
 * Rules carry an OPTIONAL `weight` (leg ② only — the scenario card has no
 * weight field, so ① is left to the consumer's default). It is inert for the
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
    const canonical = termOf(t).trim();
    if (canonical.length === 0) continue;
    // Aliases on a card term (owner ruling Q1, 2026-09-03): the retired
    // personal dictionary's alias list now lives here. No weight — the
    // consumer's default applies, same as a bare card term.
    const aliases = aliasesOf(t).map((a) => a.trim()).filter((a) => a.length > 0);
    rules.push({ canonical, ...(aliases.length > 0 ? { aliases } : {}) });
  }
  for (const e of composeDictionary(card.packs)) {
    rules.push({
      canonical: e.term,
      ...(typeof e.weight === 'number' ? { weight: e.weight } : {}),
      ...(e.aliases && e.aliases.length > 0 ? { aliases: e.aliases } : {}),
    });
  }
  return rules;
}
