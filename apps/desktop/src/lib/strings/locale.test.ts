// V2-07.8a locale-axis mechanism tests. Covers task self-check ⑦-④ (red-line guard):
//   the language recognizes only the user's explicit choice — nothing
//   stored / a stored value that can't be recognized → DEFAULT_LOCALE (en);
//   spoof the system locale as ja, and the UI must still be DEFAULT, never
//   Japanese. If this one breaks, the red line has broken.
//   ⚠️ The OS stub MUST be a shipped language that is NOT the default. Stubbing
//   the OS to English after the default flipped to English would go green even
//   if the code started reading navigator.language — a weakened guard.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KvStore } from '../types';
import {
  DEFAULT_LOCALE,
  LOCALE_KEY,
  UI_LOCALES,
  getLocale,
  hydrateLocale,
  isUiLocale,
  onLocaleChange,
  setLocale,
  wireLocaleStore,
} from './locale';
import { S } from '../strings';
import { statusBadge, statusLine } from '../status';

function memKv(initial?: Record<string, string>): KvStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('locale axis (V2-07.8a)', () => {
  it('nothing stored → DEFAULT en, catalogue renders English', () => {
    wireLocaleStore(memKv());
    expect(hydrateLocale()).toBe('en');
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    expect(S.nav_devices).toBe('Devices');
  });

  it('persisted explicit choice wins on hydrate', () => {
    wireLocaleStore(memKv({ [LOCALE_KEY]: 'en' }));
    expect(hydrateLocale()).toBe('en');
    expect(S.nav_devices).toBe('Devices');
  });

  it('unrecognised stored value falls back to DEFAULT en (never guessed, never OS)', () => {
    wireLocaleStore(memKv({ [LOCALE_KEY]: 'fr-FR' }));
    expect(hydrateLocale()).toBe('en');
    expect(S.nav_devices).toBe('Devices');
  });

  it('setLocale persists 即改即存 and the reactive S swaps immediately', () => {
    const kv = memKv();
    wireLocaleStore(kv);
    hydrateLocale();
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale('en');
    off();
    expect(kv.get(LOCALE_KEY)).toBe('en');
    expect(seen).toEqual(['en']);
    // Object.assign swap — no remount, no reload, call sites untouched.
    expect(S.st_cached).toBe('Not injected · buffered');
    setLocale('zh-CN');
    expect(S.st_cached).toBe('未注入 · 已缓存');
  });

  it('cross-window path: the shared store changed elsewhere → hydrateLocale re-reads it', () => {
    const kv = memKv();
    wireLocaleStore(kv);
    hydrateLocale();
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    kv.set(LOCALE_KEY, 'zh-CN'); // the other window wrote it (prefs-sync event)
    hydrateLocale();
    expect(getLocale()).toBe('zh-CN');
    expect(S.nav_settings).toBe('设置');
  });

  it('red line ④: OS locale stubbed to Japanese, nothing stored → UI stays DEFAULT (en), never the OS', async () => {
    // Fresh module graph so the stub is in place BEFORE locale.ts first runs,
    // and the empty store means no explicit choice was ever made.
    // ja-JP is a SHIPPED language and is NOT the default — if anything read
    // navigator.language this would come back Japanese, not English.
    vi.resetModules();
    vi.stubGlobal('navigator', { language: 'ja-JP', languages: ['ja-JP', 'ja'] });
    try {
      const freshLocale = await import('./locale');
      const freshStrings = await import('../strings');
      freshLocale.wireLocaleStore(memKv());
      expect(freshLocale.hydrateLocale()).toBe('en');
      expect(freshStrings.S.nav_devices).toBe('Devices');
      expect(freshStrings.S.st_cached).toBe('Not injected · buffered');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('red line ④ (structural): locale.ts source contains NO OS-locale probe', () => {
    // The runtime test above proves today; this anchors tomorrow — any future
    // "helpful" navigator.language read turns this red before it ships.
    const src = readFileSync(fileURLToPath(new URL('./locale.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/navigator/);
    expect(src).not.toMatch(/Intl\./);
    expect(src).not.toMatch(/matchMedia/);
  });

  // 🔴 THIS TEST USED TO SAY `isUiLocale('fr') === false` (2026-08-14). French
  // then shipped, and that line is the shape a guard rots into: it did not fail,
  // it would have been "fixed" by deleting it, and what it was really guarding —
  // 「the persisted whitelist is exactly the shipped list, no more and no less」 —
  // was never the thing being asserted. Derived now, so language #10 extends it.
  it('isUiLocale accepts exactly the shipped locales and nothing else', () => {
    for (const l of UI_LOCALES) expect(isUiLocale(l), l).toBe(true);
    // Measure the ruler: an empty UI_LOCALES would make the loop above vacuous.
    expect(UI_LOCALES.length).toBeGreaterThan(1);
    // The realistic invalid values: a region variant of a SHIPPED language (the
    // shape of a stale persisted value, and the one a sloppy `startsWith` would
    // wave through), an unshipped language, and the empty/null cases.
    for (const bad of ['fr-FR', 'zh', 'ZH-CN', 'pt', 'nl', '']) {
      expect(isUiLocale(bad), bad).toBe(false);
    }
    expect(isUiLocale(null)).toBe(false);
    expect(isUiLocale(undefined)).toBe(false);
  });
});

describe('red-line wording stays factual (V2-07.8a)', () => {
  it('「未注入 · 已缓存」 is a fact statement, never a delivery promise', () => {
    wireLocaleStore(memKv({ [LOCALE_KEY]: 'en' }));
    hydrateLocale();
    expect(S.st_cached).toBe('Not injected · buffered');
    // 「待投递」("pending delivery")-class phrasing promises a delivery
    // nobody scheduled — banned.
    expect(S.st_cached).not.toMatch(/pending|to be (delivered|sent)|will be (delivered|sent)/i);
    // 🔴 卡 L7 (owner 2026-08-02) — this used to read「same word as the phone's
    // statusUndelivered —「未投递」/「Not delivered」」and THAT WAS THE DEFECT:
    // the capsule runs on the PC, so a frame it can see has already been
    // DELIVERED; only the INJECTION failed. The capsule now REFERENCES st_cached
    // instead of spelling its own copy (docs/rebuild/15 §2.5c).
    expect(S.cap_cached).toBe(S.st_cached);
    expect(S.cap_cached).not.toMatch(/pending|not delivered/i);
  });

  it('status badges follow the switch (getter table, not a boot snapshot)', () => {
    wireLocaleStore(memKv());
    hydrateLocale();
    setLocale('zh-CN');
    expect(statusBadge('cached').label).toBe('未注入 · 已缓存');
    // owner 2026-08-07 甲-3: `injected` renders as TWO words split by ③evidence.
    // BOTH are asserted here, in both locales, because the point of this test is that
    // the LABELS follow a switch — and after 甲-3 there are two label getters to prove
    // it for, not one (`st_injected` / `st_delivered`).
    expect(statusLine('injected', '微信', 'editable')).toBe('✓ 已注入 → 微信（已确认可输入）');
    expect(statusLine('injected', '微信', 'unknown')).toBe('✓ 已送入 → 微信（未确认）');
    setLocale('en');
    expect(statusBadge('cached').label).toBe('Not injected · buffered');
    expect(statusLine('injected', 'WeChat', 'editable')).toBe('✓ Injected → WeChat (input confirmed)');
    expect(statusLine('injected', 'WeChat', 'unknown')).toBe('✓ Input sent → WeChat (unconfirmed)');
    setLocale('zh-CN');
  });
});
