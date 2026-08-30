// 2026-08-30 owner defect sweep — see autostart-reason.ts's header for the
// full story: `bridge.ts`'s `fetchAutostartState`/`setAutostartEnabled` used
// to bake a raw Chinese sentence into `reason` for the one failure they
// diagnose themselves ('autostart_state 返回了无法识别的形状'), rendered
// verbatim by SettingsPage.vue's `autostartError` in every UI locale, not
// only zh-CN. bridge.ts now returns a stable machine CODE instead, and
// `describeAutostartReason` (THIS file) maps it to a localized sentence.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeAutostartReason } from './autostart-reason';
import { S_BY_LOCALE } from './strings';
import { UI_LOCALES, setLocale, type UiLocale } from './strings/locale';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CJK = /[㐀-鿿]/;
const CODES = ['autostart_state_unrecognised_shape', 'autostart_set_unrecognised_shape'] as const;

describe('describeAutostartReason', () => {
  afterEach(() => setLocale('en')); // back to the real DEFAULT_LOCALE

  it('en: both known codes resolve to English text with no CJK characters', () => {
    setLocale('en');
    for (const code of CODES) {
      const text = describeAutostartReason(code);
      expect(text, `${code} under en must not contain any CJK character`).not.toMatch(CJK);
      expect(text).toBe(S_BY_LOCALE.en.set_prefs_autostart_unrecognised_shape);
      expect(text).toContain('unrecognized');
    }
  });

  it('🔴 positive control: the SAME probe under zh-CN DOES find CJK — proves the regex is not blind', () => {
    setLocale('zh-CN');
    for (const code of CODES) {
      const text = describeAutostartReason(code);
      expect(text, `${code} under zh-CN should still contain CJK`).toMatch(CJK);
      expect(text).toBe(S_BY_LOCALE['zh-CN'].set_prefs_autostart_unrecognised_shape);
    }
  });

  it('every one of the nine UI locales resolves both codes to its own sentence, not a bare code', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      setLocale(loc);
      for (const code of CODES) {
        const text = describeAutostartReason(code);
        expect(text, `${loc}/${code}`).toBe(S_BY_LOCALE[loc].set_prefs_autostart_unrecognised_shape);
        expect(text, `${loc}/${code} must not just echo the code back`).not.toBe(code);
      }
    }
  });

  it('an UNMAPPED reason (a future code, or bridge.ts free-form text) passes through unchanged, never invented prose', () => {
    setLocale('en');
    expect(describeAutostartReason('bridge unavailable (not running under Tauri)')).toBe(
      'bridge unavailable (not running under Tauri)',
    );
    expect(describeAutostartReason('Access is denied. (os error 5)')).toBe('Access is denied. (os error 5)');
    expect(describeAutostartReason('autostart_some_future_code_this_table_does_not_know')).toBe(
      'autostart_some_future_code_this_table_does_not_know',
    );
  });

  it('the empty string is not a known code and passes through unchanged', () => {
    expect(describeAutostartReason('')).toBe('');
  });
});

describe('SettingsPage really routes bridge.ts reasons through describeAutostartReason (owner 2026-08-30)', () => {
  it('both autostartError assignments wrap r.reason in describeAutostartReason(...)', () => {
    const page = src('../main-window/SettingsPage.vue');
    expect(page).toContain(
      'autostartError.value = `${S.set_prefs_autostart_read_failed}${describeAutostartReason(r.reason)}`;',
    );
    expect(page).toContain(
      'autostartError.value = `${S.set_prefs_autostart_failed}${describeAutostartReason(r.reason)}`;',
    );
  });
});
