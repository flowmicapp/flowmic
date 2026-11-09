// The paired-phone row on the REAL devices page (screenshot 2026-11-07, 0.3.120):
// "Paired 1 total · 1 phones online", and "Last active Never connected" on a phone
// whose own chip said Online.
//
// 【rendered-result】 The page is mounted whole, with its real load path
// (loadPaired → mergeWithCache → PairedList). Only the bridge read is replaced.
// `pairedView` is private to the page and arrives asynchronously, and SSR does not
// wait for it on its own, so the fake read registers an `onServerPrefetch` on the
// page while the page's immediate watcher is running. SSR awaits that before it
// renders. The row itself is therefore produced by the same code the app runs.
//
// REVERSE CONTROLS, run with `vitest run src/main-window/paired-row-truth.test.ts`:
//   · lastActiveText without its presence line turns the online case red;
//   · lastActiveText reading only `last_seen_at` turns the "paired, no stamp" case red;
//   · the number put back before dev_mobiles_online turns the summary case red, and
//     in App.vue turns the footer case red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, onServerPrefetch } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

const pairedRead = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../lib/bridge', async (original) => {
  const real = await original<typeof import('../lib/bridge')>();
  return {
    ...real,
    fetchPairedMobilesView: () => {
      // Runs inside the page's setup, through its immediate watcher.
      onServerPrefetch(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      return Promise.resolve({ rows: pairedRead.rows, unreachable: [] });
    },
  };
});

import App from './App.vue';
import DevicesPage from './DevicesPage.vue';
import { conn } from './store';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';
import type { PairedMobile } from '../lib/paired-mobiles';

function phone(over: Partial<PairedMobile>): PairedMobile {
  return {
    pairing_id: 'p-1',
    mobile_name: 'LENOVO TB335ZC',
    paired_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    last_seen_at: null,
    online: true,
    channel: 'lan',
    device_uid: 'uid-1',
    client: 'app',
    ...over,
  };
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderPage(loc: UiLocale, rows: PairedMobile[]): Promise<string> {
  pairedRead.rows = rows;
  setLocale(loc);
  try {
    return await renderToString(createSSRApp(DevicesPage));
  } finally {
    setLocale('zh-CN');
  }
}

/** The text of the row's "last active" cell. Throws when the row did not render, so
 *  no assertion below can pass on an empty page. */
function lastActiveCell(html: string, loc: UiLocale): string {
  const at = html.indexOf('pm-seen');
  expect(at, `${loc}: the paired row did not render`).toBeGreaterThan(-1);
  const open = html.indexOf('>', at) + 1;
  return html.slice(open, html.indexOf('</span>', open));
}

function summary(html: string, loc: UiLocale): string {
  const at = html.indexOf('paired-count');
  expect(at, `${loc}: the paired summary did not render`).toBeGreaterThan(-1);
  const open = html.indexOf('>', at) + 1;
  return html.slice(open, html.indexOf('</span>', open)).replace(/\s+/g, ' ').trim();
}

const kv = new Map<string, string>();
beforeEach(() => {
  kv.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => void kv.set(k, String(v)),
    removeItem: (k: string) => void kv.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the last-active cell on the real devices page', () => {
  it('a phone connected right now reads "just now", even with no stamp at all', async () => {
    for (const loc of UI_LOCALES) {
      const html = await renderPage(loc, [phone({ online: true, last_seen_at: null })]);
      expect(lastActiveCell(html, loc)).toBe(esc(S_BY_LOCALE[loc].dev_time_just_now));
      expect(html, `${loc}: the online chip is the other half of the claim`).toContain(
        esc(S_BY_LOCALE[loc].dev_paired_online),
      );
    }
  });

  it('a phone connected for days also reads "just now", not its old stamp', async () => {
    for (const loc of UI_LOCALES) {
      const html = await renderPage(loc, [phone({ online: true, last_seen_at: '2026-01-01T00:00:00.000Z' })]);
      expect(lastActiveCell(html, loc)).toBe(esc(S_BY_LOCALE[loc].dev_time_just_now));
    }
  });

  it('paired, gone offline, never stamped: the pairing is the last contact', async () => {
    for (const loc of UI_LOCALES) {
      const html = await renderPage(loc, [phone({ online: false, last_seen_at: null })]);
      expect(lastActiveCell(html, loc)).toBe(
        esc(S_BY_LOCALE[loc].dev_time_minutes_ago.replace('{n}', '10')),
      );
    }
  });

  it('offline with a stamp: the stamp wins over the pairing time', async () => {
    const stamp = new Date(Date.now() - 3 * 60_000).toISOString();
    for (const loc of UI_LOCALES) {
      const html = await renderPage(loc, [phone({ online: false, last_seen_at: stamp })]);
      expect(lastActiveCell(html, loc)).toBe(
        esc(S_BY_LOCALE[loc].dev_time_minutes_ago.replace('{n}', '3')),
      );
    }
  });
});

describe('the paired summary on the real devices page', () => {
  it('says the online count through the string, for one phone and for two', async () => {
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const one = summary(await renderPage(loc, [phone({})]), loc);
      expect(one).toContain(esc(s.dev_mobiles_online.replace('{n}', '1')));
      const two = summary(
        await renderPage(loc, [
          phone({}),
          phone({ pairing_id: 'p-2', device_uid: 'uid-2', mobile_name: 'Pixel' }),
        ]),
        loc,
      );
      expect(two).toContain(esc(s.dev_mobiles_online.replace('{n}', '2')));
    }
  });

  it('every language keeps exactly one {n}, and English no longer says "1 phones"', async () => {
    for (const loc of UI_LOCALES) {
      expect(S_BY_LOCALE[loc].dev_mobiles_online.match(/\{n\}/g), loc).toHaveLength(1);
    }
    const en = summary(await renderPage('en', [phone({})]), 'en');
    expect(en).toContain('Phones online: 1');
    expect(en).not.toContain('1 phones');
  });
});

describe('the sidebar footer, on the real app shell', () => {
  it('says the same count through the same string', async () => {
    conn.mobiles = 1;
    for (const loc of UI_LOCALES) {
      setLocale(loc);
      try {
        const html = await renderToString(createSSRApp(App));
        // Read the footer's own element: the page below it says the same words in
        // its summary, so a search of the whole document passes with the footer wrong.
        const at = html.indexOf('conn-detail-mobiles');
        expect(at, `${loc}: the footer did not render`).toBeGreaterThan(-1);
        const open = html.indexOf('>', at) + 1;
        expect(html.slice(open, html.indexOf('</div>', open)).trim()).toBe(
          esc(S_BY_LOCALE[loc].dev_mobiles_online.replace('{n}', '1')),
        );
      } finally {
        setLocale('zh-CN');
      }
    }
    conn.mobiles = 0;
  });
});
