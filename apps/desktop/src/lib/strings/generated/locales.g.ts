// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/locales.ts
// Regenerate: node scripts/i18n/gen-desktop-ts.mjs
//
// 🔴 THE PICKER ORDER IS THE REGISTRY ORDER. Every language menu in the app
// iterates UI_LOCALES, so reordering the registry reorders what the user sees
// with no UI file edited. That is the point (registry header, 2026-08-14).
//
// 🔴 ENDONYMS ARE NOT TRANSLATED, so they are DATA and not catalogue keys.
// The four `set_lang_*` keys and the two hand-written `LANG_LABEL` maps this
// replaces existed only to spell 「中文 / English / 日本語 / 한국어」 four times
// each. A language list that renames itself is unusable to the one person who
// needs it — someone whose UI is in a language they cannot read is looking for
// their own language's name, not its translation.
//
// Every registry row has a data file on this surface.

export const UI_LOCALES = [
  'en',
  'zh-CN',
  'zh-TW',
  'fr',
  'es',
  'de',
  'ja',
  'ko',
  'ru',
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** What the first frame renders before a human has ever chosen — the
 *  registry's `DEFAULT_UI_LOCALE`. NEVER derived from the OS (red line). */
export const DEFAULT_LOCALE: UiLocale = 'en';

/** The language a MISSING translation renders in. Deliberately a separate
 *  constant from [DEFAULT_LOCALE]: 「缺译回落到哪一种」 and 「新装的第一帧渲染
 *  哪一种」 are two questions (registry, BASE_UI_LOCALE). Today they hold the
 *  same value; a ruling that moves one must not move the other. */
export const BASE_LOCALE: UiLocale = 'en';

/** Each language's name IN ITSELF, from the registry. */
export const LOCALE_ENDONYM: Record<UiLocale, string> = {
  'en': 'English',
  'zh-CN': '中文',
  'zh-TW': '繁體中文',
  'fr': 'Français',
  'es': 'Español',
  'de': 'Deutsch',
  'ja': '日本語',
  'ko': '한국어',
  'ru': 'Русский',
};
