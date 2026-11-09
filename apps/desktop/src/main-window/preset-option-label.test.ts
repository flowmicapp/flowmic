// FR-D2 (D-MKT-7, 2026-11-06): the engine menus in an English interface read
// 内置本地（离线）/ Built-in Local (offline) and 自定义 / Custom. Those two labels
// were written bilingual into the shared catalogue, and the menus print `p.label`.
// Neither is a vendor name, so both belong to the interface language; the vendor
// labels stay as the catalogue spells them.
//
// Reads the <option> a person picks from, on the real settings cards.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import { CUSTOM_PRESET_ID, LLM_PRESETS, STT_PRESETS } from '@flowmic/protocol';
import LlmSettings from './components/LlmSettings.vue';
import SttSettings from './components/SttSettings.vue';
import { model, type Routing } from './settings-model';
import { S_BY_LOCALE, UI_LOCALES, setLocale } from '../lib/strings';

const BUILTIN_ID = 'builtin-sherpa-local';

function optionText(html: string, value: string): string {
  const hits = [...html.matchAll(new RegExp(`<option value="${value}"[^>]*>([^<]*)</option>`, 'g'))];
  expect(hits.length, `no <option value="${value}"> rendered`).toBeGreaterThan(0);
  return (hits[0]?.[1] ?? '').trim().replace(/&#39;/g, "'");
}

async function stt(): Promise<string> {
  model.routings = [{ language: 'en', engine_id: 'sherpa-local', endpoint: null } as unknown as Routing];
  return renderToString(createSSRApp(SttSettings));
}
const llm = (): Promise<string> => renderToString(createSSRApp(LlmSettings));

afterEach(() => setLocale('zh-CN'));

describe('the two labels that are ours follow the interface language', () => {
  for (const code of UI_LOCALES) {
    it(`${code}: speech menu`, async () => {
      setLocale(code);
      const html = await stt();
      expect(optionText(html, BUILTIN_ID)).toBe(S_BY_LOCALE[code].preset_group_builtin);
      expect(optionText(html, CUSTOM_PRESET_ID)).toBe(S_BY_LOCALE[code].preset_group_custom);
    });

    it(`${code}: language-model menu`, async () => {
      setLocale(code);
      expect(optionText(await llm(), CUSTOM_PRESET_ID)).toBe(S_BY_LOCALE[code].preset_group_custom);
    });
  }

  it('no preset label in the shared catalogue carries Chinese any more', () => {
    for (const p of [...STT_PRESETS, ...LLM_PRESETS]) {
      expect(p.label, p.id).not.toMatch(/[㐀-鿿]/);
    }
  });

  it('a vendor name stays as the catalogue spells it, whatever the language', async () => {
    setLocale('de');
    expect(optionText(await llm(), 'cloud-deepseek')).toBe('DeepSeek');
  });
});
