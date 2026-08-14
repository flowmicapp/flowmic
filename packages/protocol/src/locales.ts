// SPEC-REF:
//   docs/rebuild/17-UI-LOCALE-GLOSSARY.md            (which languages, and the terminology lock)
//   docs/strategy/2026-08-14-locale-expansion-architecture.md §3  (this file's job)
//   docs/decisions/2026-07-28-i18n-four-locales-and-theme.md      (no OS locale, no fallback chain)
//
// 🔴 THE ONE PLACE THE PRODUCT'S UI LANGUAGES ARE LISTED.
//
// owner 2026-08-14: 「要设计一个相对更完美的方案来支持后面语种的扩展……未来可能还会
// 增加，争取每一次新增语种时比较顺，不会去动太多东西。」 Before this file, adding one
// language meant editing ~60 hand-written places across five mechanisms and three
// repos (the measured table is §1 of the architecture doc): 20 Dart `_t`
// signatures + 686 call sites, 15 desktop shards, 22 Rust matches, four hard-coded
// arrays in each of the web and admin repos, and five duplicated endonym maps.
//
// The rule this file exists to enforce: **a new language is a ROW HERE plus a data
// file, and nothing else.** Everything that used to enumerate languages by hand —
// enums, pickers, endonyms, parity loops, script assertions — now derives from
// this array. `verify/lint/i18n-add-locale-cost.mjs` is the gate that keeps it
// that way; without it the architecture quietly rots back on the third language.
//
// ⚠️ WHAT THIS IS NOT. Three neighbouring things enumerate languages for DIFFERENT
// questions and must never be merged into this one (each merge would be the
// repo's #1 defect shape — one value answering two questions):
//   · `AppSettings.sourceLang` / `kSpokenLangs` (mobile) — 「我说话用的是哪种语言」,
//     an OPEN string space that goes on the wire as `audio:start.source_lang` and
//     is a lookup key in the server's STT routing table;
//   · `Locale` in types.ts + `users.locale` (DB) — 「这个账号的邮件/发票用哪种语言」,
//     deliberately still `'zh-CN' | 'en'`;
//   · iOS `*.lproj` bundles — OS-locale-driven permission strings, a namespace
//     Apple owns (see apps/mobile/ios/Runner/zh-Hans.lproj/InfoPlist.strings).

/** One UI language. */
export interface UiLocaleSpec {
  /** BCP-47-ish tag. The wire/storage form everywhere except Dart. */
  readonly code: string;
  /** The Dart enum member name (`AppLocale.<dart>`). Bare and lowerCamel because
   *  Dart enum members cannot contain a hyphen — `zh-CN` becomes `zh`, `zh-TW`
   *  becomes `zhTw`. Kept HERE rather than derived so the mapping is auditable
   *  in one place instead of being re-guessed by three generators. */
  readonly dart: string;
  /** The language's name IN ITSELF. Shown in every picker on every surface.
   *  🔴 Deliberately NOT translated per locale: a language list that renames
   *  itself is unusable to the very person who needs it — someone who has the
   *  app in a language they cannot read is looking for their own language's
   *  name, not its translation into the current one. */
  readonly endonym: string;
  /** ISO 15924 script. Drives per-script rules that used to be hand-written:
   *  layout width budgets (Latn/Cyrl run 30-40% longer than en; Hans/Jpan/Kore
   *  are compact) and the anti-copy-paste assertions in the Rust table test.
   *  ⚠️ `Hans` and `Hant` share a script, so NO script-based rule can tell them
   *  apart — the zh-CN/zh-TW guard is a vocabulary check, not a codepoint check
   *  (17 册 §4/§5). */
  readonly script: 'Hans' | 'Hant' | 'Latn' | 'Jpan' | 'Kore' | 'Cyrl';
  /** True for the two languages whose copy is WRITTEN, not translated. Every
   *  other locale is produced FROM these. The generator refuses to take a
   *  non-authored locale as a translation source, so a machine translation can
   *  never silently become the origin of the next one (17 册 §1). */
  readonly authored?: true;
}

/** 🔴 The list. Adding a language = adding a row here + its data files. */
export const UI_LOCALES = [
  // 🔴 ORDER IS PRODUCT COPY, NOT DATA ENTRY. This array IS the picker order on
  // every surface (every picker iterates it), so reordering here reorders what
  // the user sees everywhere, with no UI file edited. That is the point.
  //
  // Current order set by owner 2026-08-14 (second ruling of the day):
  //   「en > zh-CN > zh-TW > fr > de > ja > ko > ru」
  // ⚠️ It SUPERSEDES the earlier same-day ruling 「英语第 1 位；中文简体/中文繁体
  // 放最后」, which this file carried for about an hour. Recorded rather than
  // quietly overwritten: the two are opposite instructions about the same list,
  // and a reader who found only the newer one would reasonably wonder whether
  // the older one had been missed.
  //
  // ⚠️ `es` (Español) was NOT in the owner's eight-item list, and it is not
  // dropped on that account — owner commissioned it by name in the first
  // instruction of the day (「法语/西班牙语/德语/俄语」). It is placed between
  // `fr` and `de`, which is the order owner used in that enumeration. If the
  // omission was intentional rather than a slip, moving or removing this one row
  // is the whole edit.
  { code: 'en', dart: 'en', endonym: 'English', script: 'Latn', authored: true },
  // `zh-CN` keeps `authored`: its strings are originals, not translations.
  // Position says where it appears in a menu, never how its copy was produced.
  { code: 'zh-CN', dart: 'zh', endonym: '中文', script: 'Hans', authored: true },
  // 🔴 zh-TW is a real locale from 2026-08-14 and NOT from the two earlier
  // mentions in this repo: window W3 twice wrote it into a work order as if it
  // already existed and twice retracted it in place
  // (2026-08-07-w3-macos-usable-ledger.md:153 「zh_TW 是我编的」). Cite this row.
  { code: 'zh-TW', dart: 'zhTw', endonym: '繁體中文', script: 'Hant' },
  { code: 'fr', dart: 'fr', endonym: 'Français', script: 'Latn' },
  { code: 'es', dart: 'es', endonym: 'Español', script: 'Latn' },
  { code: 'de', dart: 'de', endonym: 'Deutsch', script: 'Latn' },
  { code: 'ja', dart: 'ja', endonym: '日本語', script: 'Jpan' },
  { code: 'ko', dart: 'ko', endonym: '한국어', script: 'Kore' },
  { code: 'ru', dart: 'ru', endonym: 'Русский', script: 'Cyrl' },
] as const satisfies readonly UiLocaleSpec[];

export type UiLocaleCode = (typeof UI_LOCALES)[number]['code'];

/** 🔴 THE BASE LANGUAGE — owner 2026-08-14: 「本项目对应的应用，它的主语源是英文…
 *  如果一个语种没有适当的翻译，就用默认语种的文本；默认语种是英文。」
 *
 *  Two consequences, and both reverse an earlier position in this repo, so they
 *  are written out rather than left to be inferred:
 *
 *  ① **English is the source of meaning.** New copy is written in English first
 *     and every other language is a translation OF IT. (The existing catalogue
 *     was authored in Chinese and its reasoning comments are Chinese — those
 *     stay; this rule is about what happens from here on. `zh-CN` keeps
 *     `authored` because its strings are originals, not translations.)
 *
 *  ② 🔴 **A MISSING TRANSLATION FALLS BACK TO ENGLISH.** This SUPERSEDES two
 *     standing decisions: `01-PRODUCT-OVERVIEW.md` §8 item 12 「不做 locale
 *     回退链」 (2026-07-28) and the compile-error contract in the mobile `_t`
 *     helper (「a missing translation is a COMPILE error, never a
 *     half-translated catalogue that looks done」). Owner has now ruled the
 *     other way, and the trade is real in both directions: a user who picks
 *     French and meets one English sentence is better served than one who cannot
 *     have French at all until 686 strings are ready.
 *
 *  ⚠️ WHAT MUST NOT BE LOST WITH THAT RED LINE. The old rule bought one thing —
 *  we could never be WRONG about how complete a language was. Falling back
 *  silently to the user must not mean falling back silently to US. So coverage
 *  is measured and reported per language (the generator emits it; the gate reads
 *  it), and 「fr is 62% translated」 stays a fact we hold, not a discovery a user
 *  makes. Fallback is a declared degradation, never an unnoticed one. */
export const BASE_UI_LOCALE: UiLocaleCode = 'en';

/** What the first frame renders before the user has ever chosen.
 *
 *  owner 2026-08-14: 「全新安装以英文启动」. Same value as [BASE_UI_LOCALE] today,
 *  and still a SEPARATE constant on purpose — 「what a brand-new install opens
 *  in」 and 「what we substitute for a missing string」 are two questions, and
 *  collapsing them would be this repo's most-repeated defect committed in the
 *  very file written to stop it. If a later ruling moves the startup default
 *  (say, to an OS suggestion behind an explicit opt-in) the fallback base must
 *  not move with it.
 *
 *  ⚠️ Measured when this flipped from 'zh-CN': **52 desktop tests went red**,
 *  every one of them encoding 「the app starts in Chinese」. They were mechanical
 *  and were updated. Recorded because the number is the honest size of the
 *  change — it was a visible product change, not a tidy-up.
 *
 *  NOT an OS read either way — the UI language is always an explicit human
 *  choice (01 册 §8 #11). */
export const DEFAULT_UI_LOCALE: UiLocaleCode = 'en';

/** The languages whose strings are ORIGINALS rather than translations.
 *  Everything else is translated from [BASE_UI_LOCALE], never from another
 *  translation — chaining machine output multiplies its errors. */
export const AUTHORED_LOCALES = UI_LOCALES.filter((l) => 'authored' in l).map((l) => l.code);

export function isUiLocaleCode(v: unknown): v is UiLocaleCode {
  return typeof v === 'string' && UI_LOCALES.some((l) => l.code === v);
}

export function localeSpec(code: UiLocaleCode): UiLocaleSpec {
  const found = UI_LOCALES.find((l) => l.code === code);
  // Unreachable for a UiLocaleCode, but this is the function every generator
  // funnels through: a silent `undefined` here would surface as a missing
  // language three layers away, with nothing naming the cause.
  if (!found) throw new Error(`locales: no spec for ${code}`);
  return found;
}

/** Layout width budget relative to Simplified Chinese, by script.
 *
 *  🔴 WHY THIS LIVES HERE AND NOT IN A TEST. The mobile legibility suite used to
 *  fork on ONE hard-coded locale — `locale == AppLocale.en ? 640 : 360`
 *  (wp5_rendered_copy_legibility_test.dart) — because under the Ahem placeholder
 *  font every glyph is a full em square, so Latin text measures roughly double
 *  its real width. That fork is correct in spirit and unmaintainable in form: de
 *  and ru would land on the 360 branch and produce a wall of FALSE red, and
 *  loosening the threshold until it stops failing is the same as deleting the
 *  test. Deriving the budget from SCRIPT means a new language gets a defensible
 *  ruler the day it is added, with no test edited.
 *
 *  ⚠️ These are RULER units, not product claims. The Ahem asymmetry stands: 「did
 *  not clip under Ahem」 ⇒ 「will not clip on a real device」, but never the
 *  converse. Nothing here may be cited as 「this sentence fits on a real 360dp
 *  screen」. */
export const SCRIPT_WIDTH_FACTOR: Record<UiLocaleSpec['script'], number> = {
  Hans: 1.0,
  Hant: 1.0,
  Jpan: 1.0,
  Kore: 1.05,
  // Latin and Cyrillic: measured against zh as the baseline. German compounds
  // and Russian inflections are the long tail, which is why they share the
  // widest budget rather than getting a per-language number nobody can defend.
  Latn: 1.8,
  Cyrl: 1.8,
};
