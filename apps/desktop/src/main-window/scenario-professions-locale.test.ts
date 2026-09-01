// Owner report (2026-08-30, screenshot, UI language = English): Settings →
// Speech recognition → Scenario card → "Professions / fields (multi-select)"
// showed chips in CHINESE (软件开发 / 云原生 / 运维 / 产品设计 / 金融 / 医疗 /
// 法律 / 教育 / 科研) while everything around them — including the sibling
// "Domain packs" row — was English.
//
// ── ROOT CAUSE (2026-08-30) ──────────────────────────────────────────────────
// The template rendered the stored id as the chip label. Fix: PROFESSION_LABELS
// overlay + PROFESSIONS `{id, label}` pairs. W-i18n-B (2026-08-31) then switched
// the stored ids themselves to the phone's English alphabet
// (`profession-ids.ts`, mirror of kProfessionPresets). Display still goes
// through the overlay; this file still pins the RENDERED result, not the
// catalogue.
//
// ── WHAT THIS FILE PINS ──────────────────────────────────────────────────────
// 🔴 The rendered result, not the catalogue (0.2.53's law). Scoped to the
// professions chip row specifically so the CJK check cannot accidentally pass
// or fail on unrelated prose elsewhere on the page.
//
// 🔴 REVERSE CONTROL: the same probe run against zh-CN must find CJK — a CJK
// regex that never matches anything is a blind probe, not a passing test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

// Same stubs llm-notice.test.ts installs before importing the settings SFCs:
// ScenarioCard pulls in settings-model -> store -> bridge, which touches the
// Tauri IPC surface at module scope outside an actual Tauri webview.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import ScenarioCard from './components/ScenarioCard.vue';
import { PROFESSION_OPTIONS } from './settings-model';
import { S_BY_LOCALE, UI_LOCALES, setLocale, type UiLocale } from '../lib/strings';

/** renderToString HTML-escapes text nodes (`'` → `&#39;`, `&` → `&amp;`), so a
 *  catalogue sentence with an apostrophe (fr/es) must be compared in its
 *  escaped form — same helper as llm-notice.test.ts. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function render(loc: UiLocale): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(ScenarioCard));
  setLocale('zh-CN');
  return html;
}

/** Slices out just the profession/domain chip row's HTML — deliberately NOT
 *  the whole card. The "Domain packs" row sits right below it in the same
 *  component and was already correctly localized; scoping here means this
 *  test's CJK check can only ever be about the row the owner actually
 *  screenshotted. */
function professionChipsHtml(html: string): string {
  const start = html.indexOf('class="ctx-chips"');
  expect(start, 'ctx-chips row not found in ScenarioCard render').toBeGreaterThan(-1);
  const end = html.indexOf('</div>', start);
  expect(end, 'ctx-chips row has no closing </div>').toBeGreaterThan(start);
  return html.slice(start, end);
}

const CJK = /[㐀-鿿]/;

afterEach(() => {
  setLocale('zh-CN');
});

describe('scenario-card profession chips localize with the UI locale (owner 2026-08-30)', () => {
  it('en: chip row renders the English labels and contains NO CJK characters', async () => {
    const chips = professionChipsHtml(await render('en'));
    expect(chips, 'en chips must not contain any CJK character').not.toMatch(CJK);
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_swdev));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_cloud_ops));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_product_design));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_finance));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_healthcare));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_law));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_education));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_research));
    expect(chips).toContain(esc(S_BY_LOCALE.en.profession_writing));
  });

  it('🔴 positive control: the SAME probe against zh-CN DOES find CJK — proves the regex is not blind', async () => {
    const chips = professionChipsHtml(await render('zh-CN'));
    expect(chips, 'zh-CN chips should still contain CJK').toMatch(CJK);
  });

  it('zh-CN chips render overlay labels, not the stored English ids', async () => {
    const chips = professionChipsHtml(await render('zh-CN'));
    const s = S_BY_LOCALE['zh-CN'];
    expect(chips).toContain(esc(s.profession_swdev));
    expect(chips).toContain(esc(s.profession_cloud_ops));
    expect(chips).toContain(esc(s.profession_writing));
    for (const id of PROFESSION_OPTIONS) {
      expect(chips, `zh-CN must not paint the stored English id ${JSON.stringify(id)}`).not.toContain(`>${esc(id)}<`);
    }
  });

  it('every one of the nine UI locales renders its own label, not a fallback token', async () => {
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const chips = professionChipsHtml(await render(loc));
      for (const key of [
        'profession_swdev',
        'profession_cloud_ops',
        'profession_product_design',
        'profession_finance',
        'profession_healthcare',
        'profession_law',
        'profession_education',
        'profession_research',
        'profession_writing',
      ] as const) {
        expect(chips, `${loc}.${key} missing from chip row`).toContain(esc(s[key]));
      }
    }
  });

  it('the stored ids are the phone\'s English alphabet, not the old Chinese labels', () => {
    expect([...PROFESSION_OPTIONS]).toEqual([
      'software development',
      'product design',
      'devops / SRE',
      'research',
      'writing / editing',
      'teaching',
      'medicine',
      'law',
      'finance',
    ]);
  });
});
