// What language is this machine's owner most likely to SPEAK — the first-run
// guess the STT setup card is built on (owner ruling 2026-08-28, item 1:
// 「检查是否已下载当前机器默认语言的本地 STT 引擎模型」).
//
// ── 🔴 THIS IS THE SPEAKING AXIS. IT IS NOT THE INTERFACE LANGUAGE. ──────────
//
// The red line 「UI 不跟随 OS locale」 (strings/locale.ts, and the Rust side's
// locale_sync.rs) forbids ONE thing: inferring the INTERFACE language from the
// operating system. It says nothing about the speaking language, and the owner
// has ruled twice — 2026-08-14 and again 2026-08-27 — that 「说话语言」 and
// 「界面语言」 are two questions with two controls that may never be merged
// (the reasoning is written out in ./spoken-langs.ts).
//
// So: NOTHING here may ever be used to pick a UI locale, and no caller may
// route this value into `setLocale`. Without this paragraph the next reader
// reaches `navigator.language` in a FlowMic file and reads a red-line
// violation, because from the outside the two look identical — the difference
// is entirely in what the answer is used FOR.
//
// ⚠️ AND IT IS A GUESS, WHICH IS WHY IT ONLY EVER OPENS A DISMISSIBLE CARD.
// `navigator.language` in the WebView reflects the OS display language, and a
// person's display language is correlated with — never equal to — the language
// they dictate in. The value therefore picks a DEFAULT for a suggestion the
// reader can ignore; it never selects a routing row, never writes a setting,
// and never overrides a choice the user made in the model card.

import { baseSpokenLang } from './model-status';
import { spokenLangCodes } from './spoken-langs';

/** Where an unmappable tag lands (owner ruling: 「映射不到的落 en」).
 *
 *  A named constant rather than a literal at three sites: the fallback is the
 *  answer for a Portuguese or Hindi speaker, i.e. for someone this product
 *  cannot serve locally yet, and that case deserves to be greppable. */
export const SPOKEN_LANG_FALLBACK = 'en';

/**
 * A BCP-47 tag → one of the speaking languages this product has packs for.
 *
 * `zh-CN`, `zh-TW`, `zh-HK` and `zh-Hans-CN` all collapse to `zh`: the catalog
 * has no separate Traditional pack (LM-CAT §3-1 — script, not acoustics), so
 * splitting them here would produce a language the caller cannot then find a
 * model for. Every other tag keeps its base subtag, and a base the product has
 * no packs for becomes [SPOKEN_LANG_FALLBACK].
 *
 * `supported` defaults to the SAME list the model card's picker falls back to
 * (`spokenLangCodes(undefined)` — the registry's bases). Callers holding a
 * model status should pass `status.spoken_langs` instead: that is the server's
 * own answer, and the two lists agreeing today is a fact about today.
 */
export function spokenLangFromTag(
  tag: string | null | undefined,
  supported: readonly string[] = spokenLangCodes(undefined),
): string {
  if (typeof tag !== 'string' || tag.trim() === '') return SPOKEN_LANG_FALLBACK;
  const base = baseSpokenLang(tag);
  return supported.includes(base) ? base : SPOKEN_LANG_FALLBACK;
}

/**
 * The same question, asked of the machine this window is running on.
 *
 * Separate from [spokenLangFromTag] so the mapping is testable with no DOM and
 * so there is exactly one place that touches `navigator` — a global that is
 * absent in the Node test runner and in SSR, where reading it unguarded would
 * throw during render rather than degrade.
 */
export function machineSpokenLang(supported?: readonly string[]): string {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return spokenLangFromTag(nav?.language ?? null, supported);
}
