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

/** `stt.polish` value: the single opt-in switch for the LLM polish layer. Strict —
 *  no additional keys (a settings value, server-owned, written verbatim by the UI). */
export const SttPolishSchema = z.object({ enabled: z.boolean() }).strict();

export type SttPolish = z.infer<typeof SttPolishSchema>;
