// The SPEAKING languages this product can be configured for, and what to call
// them on screen. Owner ruling 2026-08-27 section 2-1.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// Two surfaces now ask the same question — the STT routing table ("which
// language is this row for") and the local-model card ("which language's packs
// am I looking at") — and the derivation below was written for the second one
// first, inside LocalModelCard.vue. Copying it into the settings table would
// have made a SECOND registry of language names, which is the thing the
// locale-expansion architecture (2026-08-14 section 2) exists to prevent and
// which CLAUDE.md forbids by name. So it moved here VERBATIM and the card now
// imports it. Nothing about the derivation changed in the move.
//
// ── 🔴 SPEAKING LANGUAGE IS NOT INTERFACE LANGUAGE ──────────────────────────
//
// They are two questions and the owner has ruled twice that they stay two
// controls (2026-08-14, restated 2026-08-27). This file borrows the interface
// registry only for the NAMES — an endonym is a fact about a language, not a
// fact about a menu — and it must never become the place where the two are
// merged. In particular the list of speaking languages is the SERVER's
// (`spoken_langs` on the model-status wire, sourced from
// `CATALOG_SPOKEN_LANGS`), not `UI_LOCALES`; [spokenLangCodes] takes it as an
// argument for exactly that reason.
//
// ── ENDONYMS ARE DATA, NEVER TRANSLATED ─────────────────────────────────────
//
// From locales.g.ts's own header: someone whose interface is in a language they
// cannot read is looking for their own language's NAME, not its translation. So
// no key in the string catalogue spells 「中文」 and none may be added.

import { LOCALE_ENDONYM, UI_LOCALES } from './strings/generated/locales.g';

/** base spoken code → the UI-locale code whose endonym names it — DERIVED from
 *  the generated registry (first registry locale with that base wins, so
 *  zh → zh-CN), never a hand-rolled list: adding a tenth language must not mean
 *  editing this file (locale-expansion architecture section 2). */
export const ENDONYM_LOCALE: Record<string, string> = (() => {
  const byBase: Record<string, string> = {};
  for (const code of UI_LOCALES) {
    const base = code.split('-')[0] ?? code;
    if (!(base in byBase)) byBase[base] = code;
  }
  return byBase;
})();

/**
 * What to call `code` on screen: its own name if the registry knows it,
 * otherwise the code VERBATIM.
 *
 * 🔴 The verbatim arm is load-bearing, not a defensive shrug. A stored routing
 * row can hold anything a previous build's free-text field accepted, and the
 * owner's ruling is explicit that such a value is shown as its raw code with an
 * "unsupported" badge — never silently rewritten, never blanked. A label
 * function that returned '' or 'unknown' here would erase the one piece of
 * information the user needs in order to fix the row.
 */
export function endonymFor(code: string): string {
  return (LOCALE_ENDONYM as Record<string, string>)[ENDONYM_LOCALE[code] ?? ''] ?? code;
}

/**
 * The speaking languages to offer, from the server's `spoken_langs` when we
 * have a status, and from the registry's bases when we do not.
 *
 * ⚠️ The fallback is not a guess at the server's answer — the two lists are the
 * same eight codes today by construction (`CATALOG_SPOKEN_LANGS` is documented
 * as the bare codes of the phone's `kSpokenLangs`, and every one of them has a
 * UI locale). It exists so a select rendered in the seconds before the local
 * service answers is a working control rather than an empty box. The moment a
 * status lands, the server's list wins.
 */
export function spokenLangCodes(spokenLangs: readonly string[] | undefined): string[] {
  return spokenLangs !== undefined && spokenLangs.length > 0
    ? [...spokenLangs]
    : Object.keys(ENDONYM_LOCALE);
}

/** The routing table's catch-all row. Its LABEL is a catalogue key
 *  (`stt_lang_fallback`) because 「other languages」 is a sentence and sentences
 *  are translated; the asterisk itself is a wire value and is never shown. */
export const FALLBACK_LANG = '*';

/**
 * Options for the MODEL CARD's picker: the speaking languages plus `zh-TW`.
 *
 * zh-TW is not a ninth acoustic key — it is a SCRIPT that shares the zh packs
 * (LM-CAT task section 3-1) — so it rides directly after zh wearing its own
 * endonym, and the card maps it back to `zh` before asking about packs. The
 * ROUTING table deliberately does NOT offer it: the owner ruled that 简体/繁体
 * is one spoken language and therefore one row (2026-08-27 section 2-1), and
 * the router now treats zh-TW and zh-CN as the same base anyway.
 */
export function modelCardLangOptions(
  spokenLangs: readonly string[] | undefined,
): { value: string; label: string }[] {
  const opts = spokenLangCodes(spokenLangs).map((l) => ({ value: l, label: endonymFor(l) }));
  const zhAt = opts.findIndex((o) => o.value === 'zh');
  const zhTw = { value: 'zh-TW', label: (LOCALE_ENDONYM as Record<string, string>)['zh-TW'] ?? 'zh-TW' };
  if (zhAt >= 0) opts.splice(zhAt + 1, 0, zhTw);
  else opts.push(zhTw);
  return opts;
}
