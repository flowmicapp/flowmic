// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 / docs/rebuild/
//     06-STT-ENGINE-LAYER.md §5 (final pipeline last stage: an OPT-IN, meaning-
//     preserving LLM polish — default OFF)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 ① (settings key `stt.polish`,
//     value `{enabled: boolean}`, present-but-malformed → fail loud at audio:start)
//   docs/rebuild/05-DATA-MODEL.md §5 (user_settings KV: `stt.polish` value)
//
// The value schema for the `stt.polish` user_settings key (SETTINGS_KEY_STT_POLISH
// in constants.ts). Like ScenarioCardSchema this is a SETTINGS-VALUE schema, NOT a
// wire event — it never enters the EVENT_SCHEMAS registry or the 55-event
// whitelist. It is a STRICT object (WP-R4-6 ①): the desktop toggle writes exactly
// `{enabled}`, so an unexpected key means a corrupt profile and must be caught, not
// silently tolerated — the server reads it through this schema at the per-session
// audio:start snapshot and fails loud (SETTINGS_SCHEMA_INVALID) on any mismatch.

import { z } from 'zod';

/**
 * How far the polish layer may go when it corrects an utterance (card C8, owner
 * ruling 2026-08-17). NOT a fourth mode — the three-mode lock (realtime /
 * translate / organize) is untouched. This is a dial inside the existing
 * `stt.polish` toggle, and it only has meaning when `enabled` is true.
 *
 *  · `strict` — today's behaviour, byte for byte. Fix mis-recognitions and
 *    punctuation, never add or remove content words, never rephrase. The text on
 *    screen stays word-for-word what was said.
 *  · `smooth` — additionally drop fillers and false starts and repair the
 *    grammar they leave behind. The owner asked for this after comparing our
 *    output against a chat model asked to 「纠错改顺」.
 *
 * 🔴 THE TWO VALUES ARE NOT A QUALITY RANKING, and the copy must not imply one.
 * They buy opposite things: `strict` guarantees fidelity, `smooth` trades some
 * of it for readability. A user dictating a quote, a name list, or evidence
 * wants `strict` and would be harmed by a "better" setting that silently
 * rewrote them.
 */
export const POLISH_STRENGTHS = ['strict', 'smooth'] as const;

export const PolishStrengthSchema = z.enum(POLISH_STRENGTHS);

export type PolishStrength = z.infer<typeof PolishStrengthSchema>;

/**
 * 🔴 ABSENT MEANS `strict`, AND THAT IS THE WHOLE COMPATIBILITY STORY.
 *
 * Every row written before this field existed omits it, so the value a legacy
 * row resolves to is the value the product had when that row was written. There
 * is no migration and no backfill: a rewrite would have to decide what a user
 * who never saw this choice "meant", and the only honest answer is "what they
 * were already getting".
 *
 * Do not read this as "the safe default". It is the UNCHANGED default — the
 * distinction matters because it is the reason nothing has to be redeployed in
 * lockstep on the *read* side.
 */
export const DEFAULT_POLISH_STRENGTH: PolishStrength = 'strict';

/** `stt.polish` value: the opt-in switch for the LLM polish layer, plus how far
 *  that layer may go. Strict — no additional keys (a settings value,
 *  server-owned, written verbatim by the UI).
 *
 *  🔴 `.strict()` IS THE DEPLOYMENT ORDER, NOT A STYLE CHOICE. A server built
 *  before this field existed rejects `{enabled, strength}` outright with
 *  SETTINGS_SCHEMA_INVALID — the write does not degrade, it fails. So the server
 *  half must ship BEFORE any client that can emit `strength`, and "the server"
 *  is two halves: the relay AND the LAN server that ships inside the desktop
 *  installer. See the deployment-order note in stt-polish-settings.ts.
 *
 *  ⚠️ `strength` is optional on the WIRE and total in the CODE: readers resolve
 *  absent to [[DEFAULT_POLISH_STRENGTH]] once, at the read boundary, so no
 *  downstream consumer ever has to decide what `undefined` means. A second place
 *  that answers that question is the second answer to one question this repo
 *  keeps paying for. */
export const SttPolishSchema = z.object({
  enabled: z.boolean(),
  strength: PolishStrengthSchema.optional(),
}).strict();

export type SttPolish = z.infer<typeof SttPolishSchema>;
