// Addresses of the WEBSITE's user manual, built for the language the reader has
// the interface in.
//
// SPEC-REF: owner ruling 2026-08-28 item 2 (「提醒可连到官网帮助手册中的设置说明
// 查看」). The chapters shipped in the 2026-08-27 web round.
//
// ── 🔴 THIS IS A MIRROR OF THE WEBSITE'S ROUTING, AND THAT IS THE RISK ───────
//
// The website is a separate project and there is nothing here to import from
// it, so the two rules below are COPIES of how it builds its own URLs, read off
// its routing when this was written [measured 2026-08-28]:
//   · a chapter lives at `/guide/<id>`, and `model` is one of the chapter ids
//     its guide registry enumerates;
//   · a language is a LOWERCASE path prefix and ENGLISH HAS NONE — `en` is the
//     site's default locale and its prefix is the empty string, so
//     `/en/guide/model` is not a route at all and would fall through to the
//     site's catch-all.
// A chapter renamed over there turns these into confident wrong addresses. The
// containment is that this file names ONE chapter rather than mirroring the
// whole registry: a broken link is one grep away, and the reader always keeps
// the address on screen (the failure branch at every call site).

import { getLocale, type UiLocale } from './strings/locale';

/** The site's origin. Same literal as `SITE_ORIGIN` over there and as the two
 *  legal links in strings/disclosure.ts — this product has one public name. */
export const SITE_ORIGIN = 'https://flowmic.app';

/** Chapters this app links to. A union, not a string, so a typo is a compile
 *  error here instead of a 404 in front of a user — the chapter list on the
 *  other side is 28 long and only these are the app's business. */
export type GuideChapter = 'model';

/** `zh-CN` → `/zh-cn`, `en` → `''`. See the header: the default locale's prefix
 *  is the empty string on the site, and inventing `/en` would 404. */
function localePrefix(locale: UiLocale): string {
  return locale === 'en' ? '' : `/${locale.toLowerCase()}`;
}

/** The manual page for `chapter`, in the UI language this window is in.
 *
 *  ⚠️ The INTERFACE language, deliberately — the manual is something the reader
 *  reads, so it follows what they chose to read the app in. It has nothing to
 *  do with the speaking-language axis (./machine-spoken-lang.ts). */
export function guideUrl(chapter: GuideChapter, locale: UiLocale = getLocale()): string {
  return `${SITE_ORIGIN}${localePrefix(locale)}/guide/${chapter}`;
}
