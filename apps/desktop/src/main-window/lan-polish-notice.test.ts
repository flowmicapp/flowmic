// Card NR-123 (owner 2026-09-29) — the Local-LAN card on the REAL devices page
// says, in one quiet line, that polish for phones on the local network needs an
// AI model on this computer, with a button to the model section. It shows only
// while the local service reports no usable model (`capability.llm.usable`).
//
// 【rendered-result】 The page is mounted whole (anti-façade ⑥): the component on
// its own would prove the line exists, not that the page the user opens draws
// it. SSR never runs onMounted, so the bridge pulls that keep other tests from
// mounting this page never fire; the LAN card itself renders from its computeds.
// Every negative case carries a positive control (the LAN card really rendered).
//
// REVERSE CONTROLS, run with `vitest run src/main-window/lan-polish-notice.test.ts`:
//   · flipping LanPolishNotice.vue's v-if to `model.llmCapabilityUsable` turns
//     both cases red;
//   · removing `<LanPolishNotice />` from DevicesPage.vue turns the usable:false
//     case red while the usable:true case stays green (the zero was not blind).
//
// NR-130 adds the second fact, `capability.llm.rejected` (a model IS set up and
// its provider refused it): same line and button, its own sentence. Reverse
// controls (2026-09-29, same command, each restored): the v-if without
// `llmModelRejected`, settings-model.ts not adopting `rejected`, and the text
// pinned to the no-model key each turn the NR-130 case red, the other three green.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { SETTINGS_KEY_CAPABILITY_LLM } from '@flowmic/protocol';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import DevicesPage from './DevicesPage.vue';
import { applyServerSettings, model } from './settings-model';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderPage(loc: UiLocale): Promise<string> {
  setLocale(loc);
  try {
    return await renderToString(createSSRApp(DevicesPage));
  } finally {
    setLocale('zh-CN');
  }
}

function usable(v: boolean, rejected?: boolean): void {
  applyServerSettings([{ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: v, ...(rejected === undefined ? {} : { rejected }) } }]);
}

const kv = new Map<string, string>();
beforeEach(() => {
  model.llmCapabilityUsable = true;
  model.llmModelRejected = false;
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

describe('NR-123 — LAN polish notice on the real devices page', () => {
  it('usable:false ⇒ the LAN card carries the line and the model button, in every locale', async () => {
    usable(false);
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const html = await renderPage(loc);
      const lan = html.indexOf('ch-lan');
      expect(lan, `${loc}: the LAN card did not render`).toBeGreaterThan(-1); // positive control
      const at = html.indexOf('data-testid="lan-polish-notice"');
      expect(at, `${loc}: notice missing`).toBeGreaterThan(lan);
      // Inside the LAN card, before the cloud card starts.
      expect(at, `${loc}: notice is not on the LAN card`).toBeLessThan(html.indexOf('ch-cloud'));
      const notice = html.slice(at, html.indexOf('</div>', at));
      expect(notice).toContain(esc(s.dev_lan_polish_no_model));
      expect(notice).not.toContain(esc(s.dev_lan_polish_model_rejected));
      expect(notice).toContain('data-jump="llm"');
      expect(notice).toContain(esc(s.llm_setup_go_llm));
    }
  });

  it.each([
    ['a current server, healthy', false],
    ['an older server that never sends `rejected`', undefined],
  ])('usable:true (%s) ⇒ no notice (and the page still rendered its LAN card)', async (_label, rejected) => {
    usable(true, rejected);
    for (const loc of UI_LOCALES) {
      const html = await renderPage(loc);
      expect(html, `${loc}: the LAN card did not render`).toContain('ch-lan'); // positive control
      expect(html, `${loc}: notice leaked`).not.toContain('data-testid="lan-polish-notice"');
      expect(html).not.toContain(esc(S_BY_LOCALE[loc].dev_lan_polish_no_model));
      expect(html).not.toContain(esc(S_BY_LOCALE[loc].dev_lan_polish_model_rejected));
    }
  });

  it('NR-130: usable:true + rejected:true ⇒ the LAN card carries the REFUSED line and the model button, in every locale', async () => {
    usable(true, true);
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const html = await renderPage(loc);
      const lan = html.indexOf('ch-lan');
      expect(lan, `${loc}: the LAN card did not render`).toBeGreaterThan(-1);
      const at = html.indexOf('data-testid="lan-polish-notice"');
      expect(at, `${loc}: notice missing`).toBeGreaterThan(lan);
      expect(at, `${loc}: notice is not on the LAN card`).toBeLessThan(html.indexOf('ch-cloud'));
      const notice = html.slice(at, html.indexOf('</div>', at));
      expect(notice).toContain(esc(s.dev_lan_polish_model_rejected));
      // One value, one question: a refused model is not "no model".
      expect(notice).not.toContain(esc(s.dev_lan_polish_no_model));
      expect(notice).toContain('data-jump="llm"');
      expect(notice).toContain(esc(s.llm_setup_go_llm));
    }
    // And the fact ends with the next snapshot that no longer says it.
    usable(true, false);
    expect(await renderPage('en')).not.toContain('data-testid="lan-polish-notice"');
  });
});
