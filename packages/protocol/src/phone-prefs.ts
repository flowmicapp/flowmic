// SPEC-REF:
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     (Q1/Q2b/Q3a; Q6 note: these preferences never enter server storage)
//   docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md
//     (D2 the server-side overlay; D3 the key set)
//   packages/protocol/src/constants.ts (SETTINGS_KEY_SCENARIO_CARD /
//     SETTINGS_KEY_STT_POLISH / SETTINGS_KEY_STT_REFINE /
//     SETTINGS_KEY_SCENARIO_INFERENCE — the same four dotted keys)
//
// THE PHONE'S PREFERENCE BUNDLE, carried INSIDE the request that starts a
// transcription cycle (owner ruling, 2026-09-03 follow-up): an optional
// `prefs` field on `audio:start` and `compose:start`. It is NOT a settings
// write — nothing here is stored — and it is NOT a new event (whitelist and
// count guard untouched; payload field only). The server reads the bundle for
// exactly that session and forgets it; a request WITHOUT `prefs` carries no
// preferences, and a key absent from a bundle means "unset", never "keep the
// previous one".
//
// Every value is validated with the SAME schema its settings key always had,
// so a malformed card is refused at the wire boundary exactly as a malformed
// stored row used to be refused at audio:start (SETTINGS_SCHEMA_INVALID).

import { z } from 'zod';
import { ScenarioCardSchema } from './scenario';
import { SttPolishSchema } from './stt-polish';
import { SttRefineSchema } from './stt-refine';

/**
 * The consent row as a zod schema — `{granted, granted_for}`, the shape
 * `ScenarioConsentRow` (scenario-consent.ts) declares as an interface. That
 * file deliberately carries no zod ("no wire surface"); this one does, because
 * the row now crosses the wire inside `prefs`. `.strict()` so a misspelled key
 * cannot pass as "consent given with an unknown extra".
 */
export const ScenarioConsentRowSchema = z.object({
  granted: z.boolean(),
  granted_for: z.enum(['local', 'external']),
}).strict();

/** The four phone-owned keys, each optional, spelled as the dotted settings
 *  keys they replace so the server-side overlay needs no translation table. */
export const PhonePrefsSchema = z.object({
  'scenario.card': ScenarioCardSchema.optional(),
  'stt.polish': SttPolishSchema.optional(),
  'stt.refine': SttRefineSchema.optional(),
  'scenario.inference': ScenarioConsentRowSchema.optional(),
}).strict();

export type PhonePrefs = z.infer<typeof PhonePrefsSchema>;
