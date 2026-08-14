// U1 first-run language gate — mechanism tests.
//
// What this file has to prove, in the card's own words:
//   ① the picker FIRES for a new install and NEVER for an existing user (the
//      never-fires façade and the nag loop are both failures);
//   ② the answer goes to the SAME setting the switcher writes, and takes
//      effect immediately;
//   ③ 🔴 the no-OS-locale red line still holds — asking a human once is not
//      inferring from the environment, and nothing here reads the environment.
//
// The red-line pair mirrors locale.test.ts's: one RUNTIME case (stub the OS to
// a shipped language that is NOT the default — ja-JP — keep the profile empty,
// assert the app is still DEFAULT en behind the question) and one STRUCTURAL
// case (the sources contain no OS probe at all), because the runtime one proves
// today and the structural one anchors tomorrow.
// ⚠️ Stubbing the OS to en-US after the default flipped to English would go
// green even if the code started reading navigator.language.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KvStore } from '../types';
import {
  DEFAULT_LOCALE,
  LOCALE_ENDONYM,
  LOCALE_KEY,
  UI_LOCALES,
  getLocale,
  hydrateLocale,
  setLocale,
  wireLocaleStore,
} from './locale';
import {
  LOCALE_PROMPT_KEY,
  PROMPT_PENDING,
  PROMPT_SETTLED,
  chooseFirstRunLocale,
  hasPriorFlowMicState,
  resolveFirstRunPrompt,
  settleLocalePrompt,
} from './first-run-locale';
import { S, S_BY_LOCALE } from '../strings';
import FirstRunLocale from '../../main-window/components/FirstRunLocale.vue';

function memKv(initial?: Record<string, string>): KvStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
  };
}

/** What a boot stamps into a BRAND-NEW profile before any user has done
 *  anything — measured, not assumed: main-window/store.ts constructs
 *  TimelineStore at module scope and its constructor ends in `persist()`, which
 *  writes these three (rows / image ids / retention cutoffs = NO_CUTOFFS). ES
 *  imports run before every statement, so the gate can never precede them. */
const BOOT_STAMPS: Record<string, string> = {
  'flowmic.history.cache': '[]',
  'flowmic.history.images': '[]',
  'flowmic.history.retention': '{"text":null,"images":null}',
};

/** One "boot": the profile's keys are whatever the store already holds, which
 *  is the same thing App.vue reads out of localStorage. */
function boot(kv: KvStore & { map: Map<string, string> }): boolean {
  wireLocaleStore(kv);
  hydrateLocale();
  return resolveFirstRunPrompt(kv, [...kv.map.keys()]);
}

/** A boot of the REAL app: the timeline's module-scope stamps land first. */
function bootWithTimelineStamps(kv: KvStore & { map: Map<string, string> }): boolean {
  for (const [k, v] of Object.entries(BOOT_STAMPS)) kv.set(k, v);
  return boot(kv);
}

afterEach(() => {
  vi.unstubAllGlobals();
  wireLocaleStore(null);
  setLocale(DEFAULT_LOCALE);
});

describe('U1 — when the first-run question may be asked', () => {
  it('NEW INSTALL: nothing stored at all → asks, and the ask is recorded', () => {
    const kv = memKv();
    expect(boot(kv)).toBe(true);
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_PENDING);
  });

  it('🔴 NEW INSTALL still asks after the timeline stamps its three keys — the '
    + 'measured hazard that makes this a real façade risk', () => {
    // A presence-only witness fails RIGHT HERE, and only here: store.ts builds
    // TimelineStore at module scope, so a brand-new profile is already three
    // keys deep before any statement in App.vue runs. The gate asks whether a
    // key holds SOMETHING, and empty containers hold nothing.
    const kv = memKv();
    expect(bootWithTimelineStamps(kv)).toBe(true);
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_PENDING);
  });

  it('…but a timeline with ROWS in it is an existing user', () => {
    // The same three keys, one of them actually filled: this machine has
    // received sentences, so it is not a first run whatever the marker says.
    const kv = memKv({ 'flowmic.history.cache': '[{"id":"r1"}]' });
    expect(boot(kv)).toBe(false);
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_SETTLED);
  });

  it('🔴 EXISTING USER who never opened the switcher → never asked, and their '
    + 'language is left exactly as it was', () => {
    // The measurement behind this case: NEITHER end writes the locale eagerly
    // (locale.ts setLocale is its only writer and it runs on an explicit
    // choice), so this user and a new install are byte-for-byte identical on
    // 「is flowmic.ui.locale missing」. The witness that separates them is the
    // rest of their profile — here, a theme they once picked.
    const kv = memKv({ 'flowmic.ui.theme': 'dark' });
    expect(boot(kv)).toBe(false);
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_SETTLED);
    // Grandfathering writes the PROMPT key, never the LOCALE key: their status
    // quo (DEFAULT_LOCALE, now en) is preserved rather than re-declared as a choice.
    expect(kv.get(LOCALE_KEY)).toBeNull();
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });

  it('EXISTING USER with an explicit choice → never asked, choice kept', () => {
    const kv = memKv({ [LOCALE_KEY]: 'ja' });
    expect(boot(kv)).toBe(false);
    expect(getLocale()).toBe('ja');
  });

  it('the marker itself is not mistaken for prior state', () => {
    // Otherwise the very act of recording「we asked」would make the next boot
    // read the profile as an upgrade.
    const kv = memKv();
    expect(hasPriorFlowMicState([LOCALE_PROMPT_KEY], kv)).toBe(false);
    const withRows = memKv({ 'flowmic.history.cache': '[{"id":"r1"}]' });
    expect(hasPriorFlowMicState([LOCALE_PROMPT_KEY, 'flowmic.history.cache'], withRows))
      .toBe(true);
    // Someone else's key on the same origin is not our history.
    const foreign = memKv({ theme: 'dark', 'sentry.session': '{"a":1}' });
    expect(hasPriorFlowMicState(['theme', 'sentry.session'], foreign)).toBe(false);
  });

  it('asked ONCE: a settled install is never asked again, however many boots', () => {
    const kv = memKv();
    expect(boot(kv)).toBe(true);
    chooseFirstRunLocale('ko', kv);
    expect(boot(kv)).toBe(false);
    expect(boot(kv)).toBe(false);
    expect(boot(kv)).toBe(false);
  });

  it('killed mid-question → asked again next boot (pending is not settled)', () => {
    // Without this branch the sequence 「first boot shows the picker → user
    // closes the window → boot writes its own keys → next boot reads the
    // profile as an upgrade」 strands a new install in a language nobody chose.
    const kv = memKv();
    expect(boot(kv)).toBe(true);
    kv.set('flowmic.history.cache', '[{"id":"r1"}]'); // this boot got as far as a row
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_PENDING);
    expect(boot(kv)).toBe(true);
  });

  it('storage unreadable → does not ask (a nag loop is the worse failure)', () => {
    const kv = memKv();
    expect(resolveFirstRunPrompt(kv, null)).toBe(false);
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_SETTLED);
  });
});

describe('U1 — the answer is the same setting the switcher writes', () => {
  it('choosing writes flowmic.ui.locale and swaps the catalogue immediately', () => {
    const kv = memKv();
    expect(boot(kv)).toBe(true);
    expect(S.nav_devices).toBe('Devices'); // English UI behind the question (fresh-install default)
    chooseFirstRunLocale('zh-CN', kv);
    // ONE store holds both keys — the language and「asked already」cannot drift.
    expect(kv.get(LOCALE_KEY)).toBe('zh-CN');
    expect(kv.get(LOCALE_PROMPT_KEY)).toBe(PROMPT_SETTLED);
    // Immediately, with no reload: the reactive S is already Chinese.
    expect(getLocale()).toBe('zh-CN');
    expect(S.nav_devices).toBe('设备');
    expect(S.nav_settings).toBe('设置');
  });

  it('🔴 choosing English — the DEFAULT — still settles the question', () => {
    // The trap: if「settled」were read off the locale key, picking the value
    // that happens to be the default would look like「never chose」and the
    // picker would come back on every boot.
    const kv = memKv();
    expect(boot(kv)).toBe(true);
    chooseFirstRunLocale('en', kv);
    expect(boot(kv)).toBe(false);
  });

  it('the switcher and the picker are interchangeable writers of one key', () => {
    const kv = memKv();
    boot(kv);
    chooseFirstRunLocale('ja', kv);
    expect(kv.get(LOCALE_KEY)).toBe('ja');
    setLocale('ko'); // what PrefsAppearance.vue does
    expect(kv.get(LOCALE_KEY)).toBe('ko');
    expect(boot(kv)).toBe(false);
    expect(getLocale()).toBe('ko');
  });

  it('settleLocalePrompt alone never touches the language', () => {
    const kv = memKv();
    boot(kv);
    settleLocalePrompt(kv);
    expect(kv.get(LOCALE_KEY)).toBeNull();
  });
});

describe('U1 — 🔴 the no-OS-locale red line still holds', () => {
  it('runtime: OS stubbed to ja-JP, brand-new profile → app is STILL DEFAULT en and '
    + 'the question is asked instead of answered for the user', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { language: 'ja-JP', languages: ['ja-JP', 'ja'] });
    try {
      const freshLocale = await import('./locale');
      const freshGate = await import('./first-run-locale');
      const freshStrings = await import('../strings');
      const kv = memKv();
      freshLocale.wireLocaleStore(kv);
      expect(freshLocale.hydrateLocale()).toBe('en');
      // The gate ASKS — it does not answer. An OS-derived pre-answer would show
      // up right here as `false` plus a stored 'ja'.
      expect(freshGate.resolveFirstRunPrompt(kv, [...kv.map.keys()])).toBe(true);
      expect(kv.get(freshLocale.LOCALE_KEY)).toBeNull();
      expect(freshLocale.getLocale()).toBe('en');
      expect(freshStrings.S.nav_devices).toBe('Devices');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('structural: neither the gate nor the picker contains an OS-locale probe', () => {
    // Same guard locale.test.ts puts on locale.ts. It has to cover the picker
    // too: 「helpfully pre-select the row matching navigator.language」 breaks
    // the red line just as thoroughly as reading it in the state module.
    for (const rel of ['./first-run-locale.ts', '../../main-window/components/FirstRunLocale.vue']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src, rel).not.toMatch(/navigator\./);
      expect(src, rel).not.toMatch(/Intl\./);
      expect(src, rel).not.toMatch(/matchMedia/);
    }
  });
});

describe('U1 — what the user actually sees', () => {
  it('renders every shipped language in its own script, with no pre-selection', async () => {
    wireLocaleStore(memKv());
    hydrateLocale();
    const html = await renderToString(createSSRApp(FirstRunLocale));
    // 🔴 DERIVED FROM THE REGISTRY, NOT THE FOUR NAMES THIS USED TO LIST
    // (2026-08-14). The old form asserted 中文 / English / 日本語 / 한국어 by hand,
    // which means a fifth language could ship missing from this screen with the
    // test green — and this screen is the ONE place a user who cannot read the
    // current UI language can fix that. Now the assertion grows with the list.
    for (const l of UI_LOCALES) {
      // The endonym — the point of the screen: readable without already knowing
      // the UI language.
      expect(html, `${l}: endonym`).toContain(LOCALE_ENDONYM[l]);
      // …and the word「language」in that language, so the screen says what it is
      // asking in every language it offers. (A language that has not translated
      // this key yet inherits the English word, which is the declared fallback —
      // still a real answer, not a blank.)
      expect(html, `${l}: the word for "language"`).toContain(S_BY_LOCALE[l].set_prefs_language);
      // One option per shipped locale, each individually clickable.
      expect(html, `${l}: option`).toContain(`data-locale="${l}"`);
    }
    // Measure the ruler (§1-bis-5): the loop above proves every registry row is
    // present; this proves the screen offers NOTHING ELSE — an extra row would
    // be a language the rest of the app does not have.
    expect((html.match(/data-locale="/g) ?? []).length).toBe(UI_LOCALES.length);
    // No「selected / current」affordance: with nothing chosen yet, highlighting
    // a row would be the app answering its own question.
    expect(html).not.toMatch(/class="[^"]*\bon\b[^"]*"/);
    expect(html).not.toContain('checked');
  });

  it('the screen renders identically whatever the app is currently rendered in', async () => {
    // Endonyms do not translate: the same rows greet a zh-CN install and an en
    // one, so this screen never becomes a second place where「what language is
    // this app」has to be answered before it can be read.
    wireLocaleStore(memKv());
    hydrateLocale();
    const zh = await renderToString(createSSRApp(FirstRunLocale));
    setLocale('en');
    const en = await renderToString(createSSRApp(FirstRunLocale));
    expect(en).toBe(zh);
  });

  it('the click is wired to the one writer and the one mirror', () => {
    // Literal anchor (the culture prefs-appearance.test.ts states for the same
    // wiring): the Tauri emit cannot be exercised in a node test, so what is
    // pinned is that the component calls the shared writer and the shared
    // prefs-sync broadcast rather than growing its own.
    const src = readFileSync(
      fileURLToPath(new URL('../../main-window/components/FirstRunLocale.vue', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('chooseFirstRunLocale(l, localKv)');
    expect(src).toContain('notifyPrefsChanged()');
    // No second language key, and no writing localStorage behind the store.
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/flowmic\.ui\.locale/);
  });
});
