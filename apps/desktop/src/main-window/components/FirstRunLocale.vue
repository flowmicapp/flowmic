<script setup lang="ts">
// U1 — the one-time first-run language question (desktop).
//
// WHY IT EXISTS: both ends default to zh-CN and deliberately never read the OS
// locale, and the desktop navigation itself is Chinese — so a user in Tokyo or
// Chicago used to land in an all-Chinese UI and had to find the language
// switcher inside Chinese menus. This screen is the one place that problem can
// be solved without breaking the red line.
//
// 🔴 CORRECTION (owner 2026-08-14): "both ends default to zh-CN" is no longer
// true — "a fresh install now starts in English" (全新安装以英文启动), so
// DEFAULT_UI_LOCALE is `en` on both ends
// (packages/protocol/src/locales.ts). The paragraph is kept because the REASON
// this screen exists survives the change intact: the default is now a language
// a reader in Tokyo also cannot read, and asking once is still the only way to
// fix that without inferring from the OS. What changed is which users land in a
// language they did not choose, not whether any do.
//
// 🔴 THE RED LINE IS INTACT AND THAT IS THE WHOLE DESIGN: what the repo forbids
// is INFERRING the language from the OS locale; ASKING the user once is a
// different thing. Nothing here reads the environment's language — not even to
// pre-highlight a row. The four options are shown flat, in a fixed order, and
// the app is in DEFAULT_LOCALE behind this screen until a human clicks.
//
// NO NEW USER COPY. Every string on this screen already ships in all four
// catalogues: `set_lang_*` are the endonyms (中文 / English / 日本語 / 한국어 —
// they read the same under every UI language, which is exactly why they can be
// shown all at once), and `set_prefs_language` is the word "language" in each
// of the four. So the screen is four-language BY CONSTRUCTION rather than by a
// new set of keys someone would have to keep in parity — and locale-parity.
// test.ts's key set is untouched.
//
// 🔴 2026-08-14: the `set_lang_*` KEYS ARE GONE and the endonyms now come from
// the registry (LOCALE_ENDONYM). The paragraph's argument is what deleted them:
// if a language's own name reads the same under every UI language, then storing
// it once per language was nine copies of one fact. `set_prefs_language` stays a
// catalogue key — it is the WORD "language," which really is translated.
//
// 即改即存 / no save button (red line): the click IS the choice. There is no
// confirm step and no dismiss — a "skip" would drop the user into the exact
// all-Chinese UI this screen exists to prevent, and the marker would still say
// "asked", so it would never come back.
import { localKv } from '../../lib/storage';
import { S_BY_LOCALE, UI_LOCALES, LOCALE_ENDONYM, type UiLocale } from '../../lib/strings';
import { chooseFirstRunLocale } from '../../lib/strings/first-run-locale';
import { notifyPrefsChanged } from '../../lib/bridge';
import BrandMark from './BrandMark.vue';

const emit = defineEmits<{ (e: 'chosen', locale: UiLocale): void }>();

/** The word "language" IN that language — this is what tells a Korean reader
 *  what the screen is asking, without a headline in someone else's script. */
function inOwnScript(l: UiLocale): string {
  return S_BY_LOCALE[l].set_prefs_language;
}

function choose(l: UiLocale): void {
  // The SAME writer the settings switcher uses (setLocale, which owns the one
  // persisted UI-language key), plus the "asked already" marker. Not a parallel
  // language setting — see first-run-locale.ts.
  chooseFirstRunLocale(l, localKv);
  // Identical to PrefsAppearance.vue's @change: tells the capsule window to
  // re-read the shared store, and main.ts's UI_PREFS_SYNC handler mirrors the
  // effective locale into the Rust shell (reportUiLocale → ui_locale_set), so
  // the tray / exit dialog / autostart strings follow this click too (card U6).
  notifyPrefsChanged();
  emit('chosen', l);
}
</script>

<template>
  <div class="fr-scrim" role="dialog" aria-modal="true" aria-label="Choose a language">
    <div class="fr-card">
      <div class="fr-brand"><span class="fr-logo"><BrandMark /></span><b>FlowMic</b></div>
      <button
        v-for="l in UI_LOCALES"
        :key="l"
        type="button"
        class="fr-opt"
        :data-locale="l"
        :lang="l"
        @click="choose(l)"
      >
        <span class="fr-endonym">{{ LOCALE_ENDONYM[l] }}</span>
        <span class="fr-word">{{ inOwnScript(l) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* z-index above the pairing modal (50) and the timeline zoom (60): until this
   is answered there is nothing else the window should let you reach. */
.fr-scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
}
.fr-card {
  width: 320px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r16);
  box-shadow: var(--sh-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Nine options, not four (2026-08-14). The list scrolls rather than the card
     growing past a short window: the card is centred in the viewport, so a card
     taller than the viewport would push the first and last options off both
     edges at once — with no scrollbar, because the scrim owns the overflow. */
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.fr-brand { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 15px; }
.fr-logo { display: flex; width: 22px; height: 22px; }
.fr-opt {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: transparent;
  color: var(--t1);
  cursor: pointer;
  text-align: left;
}
.fr-opt:hover { background: var(--line-soft); }
.fr-endonym { font-size: 16px; font-weight: 600; }
.fr-word { font-size: 12px; color: var(--t3); margin-left: auto; }
</style>
