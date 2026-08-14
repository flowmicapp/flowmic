<script setup lang="ts">
// V2-07.8a — the two new controls on the preferences page: UI language
// (zh-CN / en) and theme (follow system / light / dark). Change-applies-
// immediately, no save button (red line): @change calls setLocale /
// setThemeMode directly, and notifyPrefsChanged then has the other window
// (the capsule) re-read the shared localStorage.
//
// "Follow system" deliberately does NOT exist for the language option
// (decision 2026-07-28 Option C); it does exist for theme.
import { computed } from 'vue';
import { S, setLocale, UI_LOCALES, LOCALE_ENDONYM, getLocale, type UiLocale } from '../../lib/strings';
import { getThemeMode, setThemeMode, THEME_MODES, type ThemeMode } from '../../lib/theme';
import { notifyPrefsChanged } from '../../lib/bridge';

// computed wrappers: getLocale()/getThemeMode() read module refs, so these
// re-evaluate on a switch and the select stays honest even after a cross-window
// prefs-sync rehydrate.
const locale = computed(() => getLocale());
const theme = computed(() => getThemeMode());

// V2-07.8b: four locales. The control STAYS a <select> — a dropdown holds four
// options as easily as two (no new dependency, no layout change); the labels
// are endonyms (日本語 / 한국어 read the same under every UI language).
//
// 🔴 2026-08-14, nine locales: the label table is GONE, not extended. It used to
// map each locale to one of four `set_lang_*` catalogue keys, which existed only
// so that four catalogues could each spell "中文 / English / 日本語 / 한국어" —
// 16 strings to say four things that are never translated. The endonym now comes
// from the registry (packages/protocol/src/locales.ts), so this control gains a
// language when the registry does and this file is not edited. The <select> still
// holds nine options as easily as two.
const THEME_LABEL: Record<ThemeMode, 'set_theme_system' | 'set_theme_light' | 'set_theme_dark'> = {
  system: 'set_theme_system',
  light: 'set_theme_light',
  dark: 'set_theme_dark',
};

function onLocale(ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value;
  if (!(UI_LOCALES as readonly string[]).includes(v)) return;
  setLocale(v as UiLocale);
  notifyPrefsChanged();
}

function onTheme(ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value;
  if (!(THEME_MODES as readonly string[]).includes(v)) return;
  setThemeMode(v as ThemeMode);
  notifyPrefsChanged();
}
</script>

<template>
  <div class="card pad prefs-row">
    <div>
      <div class="prefs-label">{{ S.set_prefs_language }}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">{{ S.set_prefs_language_hint }}</div>
    </div>
    <select class="input pref-select" :value="locale" aria-label="UI language" @change="onLocale">
      <option v-for="l in UI_LOCALES" :key="l" :value="l">{{ LOCALE_ENDONYM[l] }}</option>
    </select>
  </div>
  <div class="card pad prefs-row">
    <div>
      <div class="prefs-label">{{ S.set_prefs_theme }}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">{{ S.set_prefs_theme_hint }}</div>
    </div>
    <select class="input pref-select" :value="theme" aria-label="Theme" @change="onTheme">
      <option v-for="t in THEME_MODES" :key="t" :value="t">{{ S[THEME_LABEL[t]] }}</option>
    </select>
  </div>
</template>

<style scoped>
.prefs-row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.prefs-label { font-size: 13.5px; font-weight: 600; }
.pref-select { width: auto; min-width: 132px; margin-left: auto; }
</style>
