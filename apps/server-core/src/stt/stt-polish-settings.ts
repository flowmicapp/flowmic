// SPEC-REF:
//   docs/archive/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 ①⑥ (stt.polish {enabled};
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
// 🔴 NR-132 (2026-09-29): THE DEFAULT IS A CONSTANT AGAIN — ON — and no longer
// follows the model. Full reasoning on [STT_POLISH_DEFAULT]. The history below is
// kept because it was true when written and explains the shape it replaced:
//
// (2026-08-09, card POLISH-CFG, owner ruling
// docs/decisions/2026-08-09-owner-polish-follows-llm-configuration.md) the
// default became a FUNCTION of "whether there is a usable llm.config". owner,
// verbatim: "when a polish/correction LLM model is configured, the smoothing
// feature follows it; if none is configured, it defaults to not enabled". The
// problem it solved was a DESKTOP switch reading ON over a PC that had no model
// — a control that changes nothing (0.2.27). That switch was deleted on
// 2026-09-03 when polish became a phone-owned setting; the phone renders an
// untouched switch as ON and has no way to learn this server's model state, so
// the function recreated the same split with the sides swapped (0.3.101 T2).
//
// ⚠️ SCOPE (ruling §implementation-boundary 1): this is only the "not
// configured" branch. A configured LLM
// that FAILS AT RUNTIME must still fail loudly — engine/stt-factory.ts
// `resolvePolishDep` keeps degrading to a bare final with `polish_reason`, and not
// one line of it is touched here. "you haven't configured it yet" and
// "configured but it failed this time" read alike and
// are handled oppositely; merging them would be one code answering two questions.

import { SttPolishSchema, type SttPolish } from '@flowmic/protocol';
import { resolveLlmConfigWithSource } from '../compose/llm-config';
import { isLlmConfigRejected } from './llm-reject-latch';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { ServerError } from '../errors';

/**
 * The value a session gets when nobody said anything about `stt.polish`: no
 * phone bundle key, no stored row. ON, unconditionally.
 *
 * 🔴 NR-132 (2026-09-29, MAIN decision after the 0.3.101 device test T2):
 * THE DEFAULT NO LONGER FOLLOWS THE MODEL. Until this card it was
 * 「on when a usable model resolves, off when none does」 (POLISH-CFG,
 * docs/decisions/2026-08-09-owner-polish-follows-llm-configuration.md), and it
 * was right when the switch that rendered it lived on the desktop and was fed
 * this value. Since 2026-09-03 the switch lives on the PHONE (and the web
 * client), both render an untouched switch as ON
 * (`prefs_controller.dart` `kPolishDefault`; web `SettingsPolish.vue`
 * `props.value?.enabled ?? true`), and neither receives this value. So on a PC
 * with no usable model the phone said ON while this said OFF, the session
 * armed nothing, and `not_configured` — the NR-123 badge and one-time hint —
 * was never emitted: one switch answering two ways on two sides.
 * The phone's displayed value is the truth (phone-owned settings); this
 * constant is now the same answer, so a phone too old to carry its default
 * gets what its own screen shows. With no model that means an armed request
 * that degrades to `polish:'skipped'` + `not_configured` (engine/stt-factory.ts
 * `resolvePolishDep`); with a model it means polish, exactly as before.
 *
 * ⚠️ Nothing new leaves the device: without a usable model there is nothing to
 * send to, and with one the old default was already ON.
 * ⚠️ `capability.llm` (below) is untouched and still drives the desktop's
 * LAN-card line (LanPolishNotice.vue); it is a fact about the PC, not a default.
 * ⚠️ The phone's twin is `kPolishDefault` in
 * apps/mobile/lib/src/settings/prefs_controller.dart. Two languages, so no
 * import can bind them; `apps/server-core/test/stt-polish-default-truth.test.ts`
 * reads that Dart constant and fails if the two disagree.
 *
 * 🔴 EXPORTED because settings.handler.ts `withEffectiveDefaults` hands the same
 * value out on `settings:list` (PC arm), so the list and the session cannot
 * disagree. Do not re-privatise it without removing that consumer first.
 */
export const STT_POLISH_DEFAULT: SttPolish = { enabled: true };

/**
 * 🔴 THE FACT ITSELF — "can a usable language model be resolved", and the ONLY place that asks.
 *
 * Split out for card POLISH-CFG, when the polish default was derived from it too.
 * Since NR-132 the default is the constant above and this fact feeds only
 * `capability.llm` (settings.handler.ts `settings:list`, `notifyLlmCapability`),
 * which the desktop renders on the LAN card. Resolve it once per read; a second
 * call site would be a second answer to the same question.
 *
 * ⚠️ It answers only "whether one exists". Not which model, not whose key, not whether the
 * model will actually respond — a configured model that fails at runtime is a
 * different question with the opposite handling, and it stays where it is.
 */
export interface LlmCapabilityFact {
  /** A usable model resolves for this account (the fact documented above). */
  usable: boolean;
  /**
   * NR-130 — the provider refused the config that resolves NOW (bad key or a
   * model/endpoint it does not know), as last seen by a polish run on this
   * server (stt/llm-reject-latch.ts). Always false when `usable` is false:
   * "not set up" and "set up but refused" are two facts, never both at once.
   */
  rejected: boolean;
}

/**
 * The ONE resolution behind `capability.llm` (NR-130 widened the answer, not
 * the number of resolutions). `rejected` is compared against the config this
 * very call resolved, so a config edited since the refusal is not reported.
 */
export function llmCapabilityFact(repo: SettingsRepo, userId: string): LlmCapabilityFact {
  try {
    const selected = resolveLlmConfigWithSource(repo, userId);
    return { usable: true, rejected: isLlmConfigRejected(userId, selected.cfg) };
  } catch {
    return { usable: false, rejected: false };
  }
}

/** Read + validate the `stt.polish` value. Absent → [STT_POLISH_DEFAULT];
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
  if (row === null || row.value === null || row.value === undefined) return STT_POLISH_DEFAULT;
  const parsed = SttPolishSchema.safeParse(row.value);
  if (!parsed.success) {
    throw new ServerError('SETTINGS_SCHEMA_INVALID', `stt.polish failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}
