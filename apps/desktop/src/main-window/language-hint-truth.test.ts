// FR-D2 (D-MKT-7, 2026-11-06): the hint under the Language menu states what the
// interface shows when nobody has picked a language. English, Japanese and Korean
// said English; Chinese (both scripts), French, Spanish, German and Russian said
// Chinese. Only one of those can be true, and DEFAULT_LOCALE says which.
//
// Read off the real Preferences card, in every shipped language.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import PrefsAppearance from './components/PrefsAppearance.vue';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';
import { DEFAULT_LOCALE } from '../lib/strings/generated/locales.g';

/** How each language writes the two words the sentence turns on. */
const WORDS: Record<UiLocale, { english: string; chinese: RegExp }> = {
  en: { english: 'English', chinese: /Chinese/ },
  'zh-CN': { english: '英语', chinese: /中文/ },
  'zh-TW': { english: '英文', chinese: /中文/ },
  fr: { english: 'anglais', chinese: /chinois/ },
  es: { english: 'inglés', chinese: /chino/ },
  de: { english: 'Englisch', chinese: /Chinesisch/ },
  ja: { english: '英語', chinese: /中国語|中文/ },
  ko: { english: '영어', chinese: /중국어/ },
  ru: { english: 'английск', chinese: /китайск/ },
};

afterEach(() => setLocale('zh-CN'));

describe('the Language hint tells the truth about the default', () => {
  it('control: the default this sentence describes is English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  for (const code of UI_LOCALES) {
    it(`${code}`, async () => {
      setLocale(code);
      const html = await renderToString(createSSRApp(PrefsAppearance));
      const hint = S_BY_LOCALE[code].set_prefs_language_hint;
      expect(html, 'the hint is on the card').toContain(hint.replace(/'/g, '&#39;'));
      expect(hint).toContain(WORDS[code].english);
      expect(hint).not.toMatch(WORDS[code].chinese);
    });
  }
});
