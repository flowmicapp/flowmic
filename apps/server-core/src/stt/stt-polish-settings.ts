// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 ①⑥ (stt.polish {enabled};
//     default OFF; present-but-malformed → SETTINGS_SCHEMA_INVALID at audio:start)
//   @flowmic/protocol SttPolishSchema / SETTINGS_KEY_STT_POLISH
//   docs/decisions/2026-07-23-settings-key-drift-literal-anchors.md
//   CLAUDE.md red line: no silent failures
//
// settings-key-drift GET ANCHOR for `stt.polish`. Pairs with the desktop
// `updateSetting('stt.polish')` SET anchor (WP-R4-6 ⑥ desktop task). Owns the
// per-session snapshot READ + fail-loud schema gate only (the LLM apply stage is
// engine/stt-factory.ts + engine/stt-session.ts). Mirrors compose/scenario-
// context.ts readCard exactly: absent → the default below; present but invalid →
// throw (SETTINGS_SCHEMA_INVALID) so a corrupt profile surfaces, not silently
// degrades.
//
// 🔴 THE DEFAULT IS NO LONGER A CONSTANT as of 2026-08-09 (card POLISH-CFG, owner
// ruling docs/decisions/2026-08-09-owner-polish-follows-llm-configuration.md).
// It is a FUNCTION of "whether there is a usable llm.config" — see [resolveSttPolishDefault].
// owner, verbatim: "when a polish/correction LLM model is configured, the
// smoothing feature follows it; if none is configured, it defaults to not
// enabled".
//
// WHY IT COULD NOT STAY A CONSTANT. 2026-08-08 flipped it to ON ("AI smoothing
// defaults to fully on")
// while `llm.config` was still seeded for every account, so "on by default" and
// "there is a model to call" were the same fact. OSS-DEFAULTS then stopped seeding
// an LLM, and the two facts came apart: a fresh install got a switch reading ON
// that could never do anything — the 0.2.27 "a control that changes nothing" shape, which
// is the very thing the ruling cites. A constant cannot answer a question whose
// answer now varies per account.
//
// ⚠️ This changes what leaves the user's device by default, so the same ordering
// rule as the 08-08 flip applies: the four-language disclosure on both clients and
// the toggle hint are made true in the SAME round, never after.
// ⚠️ SCOPE (ruling §implementation-boundary 1): this is only the "not
// configured" branch. A configured LLM
// that FAILS AT RUNTIME must still fail loudly — engine/stt-factory.ts
// `resolvePolishDep` keeps degrading to a bare final with `polish_reason`, and not
// one line of it is touched here. "you haven't configured it yet" and
// "configured but it failed this time" read alike and
// are handled oppositely; merging them would be one code answering two questions.

import { SttPolishSchema, type SttPolish } from '@flowmic/protocol';
import { resolveLlmConfigWithSource } from '../compose/llm-config';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { ServerError } from '../errors';

/**
 * The value every account gets when it has no `stt.polish` row — and there is no
 * seeding, so that is MOST accounts.
 *
 * 🔴 EXPORTED, AND THE EXPORT IS THE POINT. While this was a file-private `const`
 * the desktop could not learn it, so `settings-model.ts` carried its own
 * hard-coded `false` and adopted the server's answer only when a ROW existed. For
 * an account that never touched the switch that produced a control rendering OFF
 * while the server polished every closing final — doc 15 R11 ("every status
 * word must be able to answer 'on what basis'") in its purest form, and the
 * 0.2.27 "a control that changes nothing" with
 * the sign flipped. The read path now hands this value out (settings.handler.ts
 * `settings:list`) so the switch reports the EFFECTIVE value rather than
 * "whether that row exists". Do not re-privatise it without removing that consumer first.
 *
 * ⚠️ Two questions live one line apart and must not be merged: this is what the
 * server DOES when the row is absent; whether the row exists is a different fact
 * and stays visible to callers that need it.
 */
export const STT_POLISH_DEFAULT_WITH_LLM: SttPolish = { enabled: true };

/** The other half of the same answer: no usable model ⇒ the feature does not
 *  arm, so nothing is promised and no amber mark is owed. */
export const STT_POLISH_DEFAULT_WITHOUT_LLM: SttPolish = { enabled: false };

/**
 * 🔴 THE ONE PLACE that answers "when this row has never been set, is
 * smoothing on or off". Both readers call it —
 * [readSttPolish] (what the server DOES) and settings.handler.ts
 * `withEffectiveDefaults` (what the switch SHOWS). They must not compute it
 * separately: the previous bug was exactly a second copy of the answer, and the
 * export above exists because of it.
 *
 * 🔴 WHY THIS ASKS `resolveLlmConfigWithSource` AND NOT "whether there is an
 * llm.config row".
 * The resolver's order is user row → MANAGED DEFAULT (env-gated) → seed → throw.
 * On flowmic.app `FLOWMIC_MANAGED_LLM_ENABLED=1`, so an account with NO row
 * still has a perfectly usable model. Deciding from the row alone would answer
 * "off" for every cloud account while the server polished for them anyway —
 * re-creating, one release after it was fixed, the very split this module's
 * header describes. The question is "can a usable model be resolved", not
 * "did the user fill it in themself".
 *
 * ⚠️ A present-but-malformed row also lands here as "nothing usable", because it
 * resolves to nothing usable. That is the DEFAULT question only; it does not
 * soften any runtime failure (see the SCOPE note in the header).
 */
export function resolveSttPolishDefault(repo: SettingsRepo, userId: string): SttPolish {
  return sttPolishDefaultFrom(llmCapabilityUsable(repo, userId));
}

/**
 * 🔴 THE FACT ITSELF — "can a usable language model be resolved", and the ONLY place that asks.
 *
 * Split out of [resolveSttPolishDefault] for card POLISH-CFG so that the value the
 * server DEFAULTS from and the `capability.llm` fact the desktop RENDERS are the
 * same boolean, computed once, rather than two answers to one question that agree
 * today. The settings handler resolves this a single time and derives both; that
 * is a constraint on the design, not an optimisation — a second call site would
 * re-open exactly the split this card was written to close.
 *
 * ⚠️ It answers only "whether one exists". Not which model, not whose key, not whether the
 * model will actually respond — a configured model that fails at runtime is a
 * different question with the opposite handling, and it stays where it is.
 */
export function llmCapabilityUsable(repo: SettingsRepo, userId: string): boolean {
  try {
    resolveLlmConfigWithSource(repo, userId);
    return true;
  } catch {
    return false;
  }
}

/** The pure half: fact → default. Separated so the handler can derive the default
 *  from an ALREADY-RESOLVED fact instead of resolving a second time. */
export function sttPolishDefaultFrom(llmUsable: boolean): SttPolish {
  return llmUsable ? STT_POLISH_DEFAULT_WITH_LLM : STT_POLISH_DEFAULT_WITHOUT_LLM;
}

/** Read + validate the `stt.polish` value. Absent → [resolveSttPolishDefault];
 *  present but schema-invalid → throw (fail loud).
 *
 *  ⚠️ A row that EXISTS is returned untouched, at either value (ruling §implementation-boundary 2):
 *  this card moves the default, never overrides a choice somebody made. A user who
 *  turned it on without a model still gets it armed — and then the honest runtime
 *  degrade path, which is the correct answer to a deliberate choice. */
export function readSttPolish(repo: SettingsRepo, userId: string): SttPolish {
  // The single literal-key GET anchor (settings-key-drift lint) — pairs with the
  // desktop updateSetting('stt.polish') SET anchor; the literal equals
  // SETTINGS_KEY_STT_POLISH (test-pinned). Reads funnel through the repo's
  // variable-key read() — this closure only exposes the ONE literal.
  const readSetting = (key: string): SettingRow | null => repo.read(userId, key);
  const row = readSetting('stt.polish');
  if (row === null || row.value === null || row.value === undefined) return resolveSttPolishDefault(repo, userId);
  const parsed = SttPolishSchema.safeParse(row.value);
  if (!parsed.success) {
    throw new ServerError('SETTINGS_SCHEMA_INVALID', `stt.polish failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}
