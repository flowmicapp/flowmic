// U1 — the first-run language question: WHEN may it be asked, and when is it
// settled forever. The question itself (the four endonym buttons) lives in
// main-window/components/FirstRunLocale.vue; the ANSWER is written through
// locale.ts's setLocale, i.e. the same `flowmic.ui.locale` the settings
// switcher writes. This module adds no second answer to "what language is this
// app" — it only answers "has this install been asked yet".
//
// 🔴 RED LINE, and its exact shape (docs/decisions/2026-07-28-i18n-four-locales
// -and-theme.md, Option C): what is forbidden is INFERRING the language from
// the OS locale, not ASKING the user once. So this module — like locale.ts —
// contains nothing that reads the environment: no `navigator`, no `Intl`, no
// media query. Its answer comes from persisted state only. locale.test.ts's
// structural guard pins locale.ts; first-run-locale.test.ts pins this file the
// same way, because a "helpful" OS-language pre-selection here would break the
// red line just as thoroughly as one there.
//
// 🔴 WHY A SECOND KEY (and why that is NOT the banned "one value, two answers"
// shape):
//   · `flowmic.ui.locale`        answers "which language is the UI".
//   · `flowmic.ui.locale.prompt` answers "is the first-run question settled".
// Those are two questions. Reading the first one for both is what breaks: an
// upgrading user who never opened the language dropdown and a brand-new
// install are BYTE-FOR-BYTE IDENTICAL on "is flowmic.ui.locale missing" — and
// they must go opposite ways (never ask / ask). Measured, not assumed: neither
// end writes the locale key eagerly (locale.ts:71 setLocale is its only writer
// and it runs on an explicit choice), so "missing" is true for BOTH groups.

import type { KvStore } from '../types';
import { setLocale, type UiLocale } from './locale';

/** Device-local, never the wire — the same storage family as locale.ts's
 *  LOCALE_KEY, and deliberately a different key from it (see the header). */
export const LOCALE_PROMPT_KEY = 'flowmic.ui.locale.prompt';

/** The picker has been shown but no answer has landed yet (the user closed the
 *  window mid-question). Asked again next boot — the alternative is an install
 *  stranded in a language nobody picked. */
export const PROMPT_PENDING = 'pending';

/** Answered (or grandfathered). Never ask again — this is the "one-time" half
 *  of the card, and it is a persisted fact, not a session flag. */
export const PROMPT_SETTLED = 'settled';

/**
 * The keys this profile already holds, or `null` when storage cannot be read.
 *
 * `null` is deliberately NOT the same as `[]`: an empty list means "measured,
 * and this profile is empty" (a new install), while `null` means "could not
 * measure". [resolveFirstRunPrompt] treats the two oppositely — see there.
 */
export function profileKeys(): readonly string[] | null {
  try {
    // `Object.keys` over the Storage object yields its item keys. Guarded
    // because localStorage throws outright in some privacy modes, and a
    // language question must never be the thing that takes the window down.
    return Object.keys(globalThis.localStorage);
  } catch {
    return null;
  }
}

/**
 * Does this boot owe the user the first-run language question?
 *
 * WRITES on the first call of an install's life (that is the point — the signal
 * has to become durable the moment it is read, or a force-quit mid-question
 * turns into "never asked again"). Idempotent afterwards.
 *
 * The four cases, and why each is what it is:
 *   ① mark === settled → no. Steady state: answered, or grandfathered by ③.
 *   ② mark === pending → yes. We asked and never got an answer.
 *   ③ no mark, profile already holds FlowMic content → an install that predates
 *      the picker (an upgrade). Grandfather it: write `settled`, never ask.
 *      Its status quo — DEFAULT_LOCALE, or whatever it explicitly chose — is
 *      preserved byte for byte, because this writes the PROMPT key, never the
 *      language key.
 *   ④ no mark, and nothing but this boot's own empty containers → a genuinely
 *      new install. Write `pending`, ask. (Why "empty containers" and not
 *      "nothing at all": see [hasPriorFlowMicState].)
 *
 * `keys === null` (storage unreadable) takes the ③ door on purpose: we cannot
 * tell the two populations apart, and the failure that costs the user least is
 * "does not ask" — "asks on every single boot" is a nag loop, and in that state
 * the answer would not persist anyway.
 */
export function resolveFirstRunPrompt(kv: KvStore, keys: readonly string[] | null): boolean {
  const mark = kv.get(LOCALE_PROMPT_KEY);
  if (mark === PROMPT_SETTLED) return false;
  if (mark === PROMPT_PENDING) return true;
  const prior = keys === null || hasPriorFlowMicState(keys, kv);
  kv.set(LOCALE_PROMPT_KEY, prior ? PROMPT_SETTLED : PROMPT_PENDING);
  return !prior;
}

/**
 * Has this profile been used by an earlier build?
 *
 * The witness is "a `flowmic.` key, other than the prompt marker, that holds
 * SOMETHING". Every persisted surface this app owns is namespaced that way
 * (flowmic.ui.locale / flowmic.ui.theme / flowmic.history.cache /
 * flowmic.settings.queue / flowmic.pairing.* / flowmic.capsule.pos / …), so a
 * third-party key on the same origin cannot be mistaken for our own history.
 *
 * 🔴 WHY "HOLDS SOMETHING" AND NOT "EXISTS" — this was measured, and the
 * presence-only version was WRONG:
 *   `main-window/store.ts:41` constructs `TimelineStore` at MODULE scope, and
 *   that constructor ends in `this.persist()` (timeline-store.ts, the `constructor` tail). ES module
 *   side effects run before ANY statement in main.ts or App.vue, so by the time
 *   the gate can possibly run, a BRAND-NEW profile already holds
 *   `flowmic.history.cache='[]'`, `flowmic.history.images='[]'` and
 *   `flowmic.history.retention='{"text":null,"images":null}'` — written by us,
 *   not by the user. A presence-only witness therefore reads every new install
 *   as an upgrade and the picker NEVER FIRES: exactly the façade this card is
 *   about. There is no statement position that avoids this (imports are hoisted
 *   above every statement), so the fix has to be in the signal, not the timing.
 *
 * Emptiness rather than a deny-list of those three keys on purpose: "a boot
 * stamps a container it has not filled yet" is the general shape, so the next
 * boot-time writer is covered without anyone remembering to extend a list.
 *
 * ⚠️ RESIDUAL RISK, stated rather than pretended away: a future writer that
 * stamps a NON-empty default into a fresh profile at boot would make new
 * installs look like upgrades again. If the picker ever stops appearing on a
 * clean machine, that is the first thing to look for — and
 * first-run-locale.test.ts pins today's three stamps by their measured values
 * so the regression has somewhere to show up.
 */
export function hasPriorFlowMicState(keys: readonly string[], kv: KvStore): boolean {
  return keys.some(
    (k) =>
      k !== LOCALE_PROMPT_KEY && k.startsWith('flowmic.') && !isEmptyPayload(kv.get(k)),
  );
}

/** Does this stored value carry any user content? Absent, blank, an empty JSON
 *  container, or a container whose every field is still `null` all mean "no". */
function isEmptyPayload(raw: string | null): boolean {
  if (raw === null) return true;
  const s = raw.trim();
  if (s === '' || s === 'null') return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return false; // not JSON at all — somebody stored a real value here
  }
  if (parsed === null) return true;
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (typeof parsed === 'object') {
    return Object.values(parsed as Record<string, unknown>).every((v) => v === null);
  }
  return false;
}

/** Mark the question answered. Called with — never instead of — `setLocale`:
 *  the language goes to locale.ts's LOCALE_KEY, the "asked already" fact here. */
export function settleLocalePrompt(kv: KvStore): void {
  kv.set(LOCALE_PROMPT_KEY, PROMPT_SETTLED);
}

/**
 * The whole answer, in one place so it can be asserted instead of eyeballed.
 *
 * 🔴 It goes through locale.ts's `setLocale` — the SAME writer the settings
 * switcher (PrefsAppearance.vue) uses, writing the SAME `flowmic.ui.locale`.
 * There is deliberately no first-run-only locale value: a picker that wrote
 * somewhere else would give the app two answers to "what language is this",
 * and the settings page would then disagree with the screen the user just
 * used. `setLocale` also swaps the reactive catalogue synchronously, which is
 * what makes the choice take effect on the very next frame, no reload.
 *
 * The caller (FirstRunLocale.vue) additionally calls `notifyPrefsChanged()` —
 * exactly as PrefsAppearance.vue does — which is what carries the choice to
 * the capsule window and, through main.ts's UI_PREFS_SYNC handler, into the
 * Rust shell via `reportUiLocale` (tray / exit dialog / autostart strings,
 * card U6). That emit is a Tauri round-trip and cannot be asserted in a node
 * test, so it stays in the component behind a literal anchor rather than being
 * faked here.
 *
 * ⚠️ `kv` is the prompt marker's store; the LANGUAGE lands in the store
 * `wireLocaleStore` was given. In production both are the one `localKv`
 * (main.ts:21 wires it, App.vue passes it), and first-run-locale.test.ts
 * asserts both keys land in the SAME map when wired that way — a pair of
 * stores that could drift apart is the kind of split this card forbids.
 */
export function chooseFirstRunLocale(l: UiLocale, kv: KvStore): void {
  setLocale(l);
  settleLocalePrompt(kv);
}
