// V2-07.8a UI locale state — the leaf every shard and strings.ts read.
//
// Red-line clarification (docs/decisions/2026-07-28-i18n-four-locales-and-theme.md, Option C):
// 「UI 不跟随 OS locale」("UI does not follow OS locale") forbids 「从系统
// locale 推断」("inferring from the system locale"), NOT multiple languages
// itself. So there is nothing in this module that reads the system
// language — the UI language has only two sources:
//   ① the user's explicit choice (setLocale, persisted to flowmic.ui.locale);
//   ② the choice persisted in storage (hydrateLocale).
// Nothing stored / a stored value that can't be recognized → DEFAULT_LOCALE.
//
// 🔴 Correction (owner 2026-08-14): the line above used to read
// DEFAULT_LOCALE (zh-CN) and 「回退链维持不做 (01 §8 第 12 条): 缺译是守卫的事,
// 不是运行时的事」("keep not building a fallback chain (01 §8 item 12): a
// missing translation is the guard's job, not the runtime's"). Neither
// sentence holds anymore; the original text is kept in git history, and
// here are the current values and their source:
//   ① The startup default **is en** (owner ruled the same day, "a fresh
//      install starts in English"). The value comes from
//      packages/protocol/src/locales.ts's DEFAULT_UI_LOCALE, and
//      **BASE_UI_LOCALE ('en', the missing-translation fallback baseline)
//      is a separate question** — they happen to share a value today, but
//      are still written separately.
//      ⚠️ Hand-writing the same value here is **temporary**: once the
//      desktop webview shard is migrated it will become derived. Until
//      then, remember to update this line whenever the registry changes —
//      exactly the kind of hand-written spot the
//      verify/lint/i18n-add-locale-cost gate watches for.
//   ② A missing translation **falls back to English**, and is no longer
//      the guard's job. Rationale and cost are in
//      docs/rebuild/17-UI-LOCALE-GLOSSARY.md §0-bis: silent to the user,
//      never silent to us — coverage is a measured, reported artifact.
// The 「UI 不跟随 OS locale」red line **has not changed**; paragraphs ①②③
// above still hold.
//
// 🔴 The line in ① that said 「⚠️ 这里手写同一个值是**暂时的**」("hand-writing
// the same value here is temporary") has now expired (2026-08-14, desktop
// migration): `UI_LOCALES` / `DEFAULT_LOCALE` / `BASE_LOCALE` /
// `LOCALE_ENDONYM` now **all come from ./generated/locales.g.ts**, which is
// generated from the registry. **There is no longer a single place in this
// file that writes a language code** — adding a tenth language will not
// touch this line, which is exactly what that sentence was waiting for.
//
// `current` is a Vue ref ON PURPOSE: getLocale() is called inside getters /
// message functions that run during component render (SIDECAR_LABEL, MODE_BADGE
// labels, TL_BATCH_MSG…), and reading `.value` there is what makes those
// templates re-render on a switch. A plain `let` would be the friendly no-op
// DI default 13 册 §7 F1 ② bans — it would render once and never again.
//
// The store is INJECTED (wireLocaleStore; production wires localKv in the two
// window mains, tests wire a memory kv or null). This module therefore stays
// node-testable and never touches localStorage on its own.

import { ref } from 'vue';
import type { KvStore } from '../types';
import { DEFAULT_LOCALE, UI_LOCALES, type UiLocale } from './generated/locales.g';

// Re-exported from here because this module has always been the leaf every
// shard imports 「the locale axis」 from, and moving 400 call sites to a
// generated path would be a rename with no product in it. The VALUES are the
// registry's; the ADDRESS stays where readers expect it.
export {
  UI_LOCALES,
  DEFAULT_LOCALE,
  BASE_LOCALE,
  LOCALE_ENDONYM,
  type UiLocale,
} from './generated/locales.g';

/** localStorage key for the persisted choice (device-local, never the wire). */
export const LOCALE_KEY = 'flowmic.ui.locale';

const current = ref<UiLocale>(DEFAULT_LOCALE);
const listeners = new Set<(l: UiLocale) => void>();
let store: KvStore | null = null;

export function getLocale(): UiLocale {
  return current.value;
}

export function isUiLocale(v: unknown): v is UiLocale {
  return typeof v === 'string' && (UI_LOCALES as readonly string[]).includes(v);
}

/** strings.ts subscribes to swap the reactive catalogue; returns an unsubscribe. */
export function onLocaleChange(cb: (l: UiLocale) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function apply(l: UiLocale): void {
  current.value = l;
  for (const cb of listeners) cb(l);
}

/** Wire the durable store for the choice. `null` (tests) = in-memory only. */
export function wireLocaleStore(kv: KvStore | null): void {
  store = kv;
}

/** Read the persisted choice and apply it. Also the cross-window path: the
 *  other window's prefs-sync event re-reads the shared store through here. */
export function hydrateLocale(): UiLocale {
  const v = store?.get(LOCALE_KEY) ?? null;
  apply(isUiLocale(v) ? v : DEFAULT_LOCALE);
  return current.value;
}

/** The ONLY writer of the UI language: an explicit user choice (applied and
 *  persisted immediately on change). */
export function setLocale(l: UiLocale): void {
  apply(l);
  store?.set(LOCALE_KEY, l);
}
