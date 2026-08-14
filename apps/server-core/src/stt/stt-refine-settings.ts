// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.refine` {enabled, min_utterance_ms})
//   @flowmic/protocol SttRefineSchema / SETTINGS_KEY_STT_REFINE
//   docs/decisions/2026-07-23-settings-key-drift-literal-anchors.md
//   CLAUDE.md red line: no silent failure
//
// settings-key-drift GET ANCHOR for `stt.refine`. Mirrors stt-polish-settings
// exactly: absent → default OFF; present but schema-invalid → throw
// (SETTINGS_SCHEMA_INVALID) so a corrupt profile surfaces rather than silently
// degrading into "the switch is on and nothing happens".

import { SttRefineSchema, type SttRefine } from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../db/repos/settings.repo';
import { ServerError } from '../errors';

const DEFAULT: SttRefine = { enabled: false };

/** Read + validate the `stt.refine` value. Absent → OFF; invalid → throw. */
export function readSttRefine(repo: SettingsRepo, userId: string): SttRefine {
  // The single literal-key GET anchor (settings-key-drift lint) — pairs with the
  // desktop updateSetting('stt.refine') SET anchor; the literal equals
  // SETTINGS_KEY_STT_REFINE (test-pinned).
  const readSetting = (key: string): SettingRow | null => repo.read(userId, key);
  const row = readSetting('stt.refine');
  if (row === null || row.value === null || row.value === undefined) return DEFAULT;
  const parsed = SttRefineSchema.safeParse(row.value);
  if (!parsed.success) {
    throw new ServerError(
      'SETTINGS_SCHEMA_INVALID',
      `stt.refine failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}
