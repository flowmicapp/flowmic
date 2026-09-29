// NR-132 (2026-09-29) — the phone's untouched polish switch and this server's
// absent-row polish default are ONE answer, stated in two languages.
//
// The defect (0.3.101 device test T2, dispatch report 2026-09-29-test-0-3-101, outside the repo):
// the phone rendered an untouched 「AI 润色」 switch as ON and sent nothing; this
// server, holding no row and no usable model, defaulted to OFF and armed nothing,
// so the NR-123 `not_configured` badge and hint never appeared. Two constants in
// two languages answered the same question differently and nothing compared them.
//
// No import can bind a Dart constant to a TypeScript one, so this reads the Dart
// declaration as text. The declaration's own doc comment
// (apps/mobile/lib/src/settings/prefs_controller.dart `kPolishDefault`) names this
// file and asks for the one-line form the regex below matches; if the form
// changes, the "found it" assertion goes red rather than the comparison passing
// on nothing.
//
// REVERSE CONTROL (executed 2026-09-29): `kPolishDefault` flipped to
// `enabled: false` in the Dart file ⇒ `vitest run test/stt-polish-default-truth.test.ts`:
// 1 red — 「enabled: the phone shows what the server does…」 expected false to be
// true. Restored from a byte copy; 3/3 green.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLISH_STRENGTH } from '@flowmic/protocol';
import { STT_POLISH_DEFAULT } from '../src/stt/stt-polish-settings';

const DART = fileURLToPath(new URL('../../mobile/lib/src/settings/prefs_controller.dart', import.meta.url));
const DECL = /const PolishPrefs kPolishDefault = PolishPrefs\(enabled: (true|false), strength: PolishStrength\.(\w+)\);/;

describe('NR-132 — phone default == server default for an untouched polish switch', () => {
  const m = DECL.exec(readFileSync(DART, 'utf8'));

  it('the Dart declaration is found (positive control: the comparison below is not against nothing)', () => {
    expect(m).not.toBeNull();
  });

  it('enabled: the phone shows what the server does when nothing was carried', () => {
    expect(m?.[1] === 'true').toBe(STT_POLISH_DEFAULT.enabled);
  });

  it('strength: the phone default equals the protocol default the server falls back to', () => {
    // An absent strength is read as DEFAULT_POLISH_STRENGTH at the server's read
    // boundary (engine/stt-factory.ts `polishSetting.strength ?? DEFAULT_POLISH_STRENGTH`).
    expect(m?.[2]).toBe(STT_POLISH_DEFAULT.strength ?? DEFAULT_POLISH_STRENGTH);
  });
});
