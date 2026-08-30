// Owner report (2026-08-30, screenshot, UI language = English): Settings →
// Speech recognition → Scenario card → "Professions / fields (multi-select)"
// showed chips in CHINESE (软件开发 / 云原生 / 运维 / 产品设计 / 金融 / 医疗 /
// 法律 / 教育 / 科研) while everything around them — including the sibling
// "Domain packs" row — was English.
//
// ── ROOT CAUSE ───────────────────────────────────────────────────────────────
// `PROFESSION_OPTIONS` (settings-model.ts) is the STORED value of
// `card.professions` (a bare `string[]`, no separate id — it rides verbatim
// into the compose prompt as `Speaker professions: ...`,
// apps/server-core/src/compose/scenario.ts). ScenarioCard.vue used to render
// that stored value directly as the chip's label:
//   `<span v-for="p in PROFESSION_OPTIONS" ...>{{ p }}</span>`
// — the same id-doubles-as-label shape PACK_LABELS already exists to avoid for
// the sibling "Domain packs" row. Fix: PROFESSION_LABELS (a display overlay,
// same GETTERS-reading-S pattern as PACK_LABELS) + PROFESSIONS (`{id, label}`
// pairs), with the template now reading `p.id` for storage and `p.label` for
// display. PROFESSION_OPTIONS itself — the stored ids — is UNCHANGED.
//
// ── WHAT THIS FILE PINS ──────────────────────────────────────────────────────
// 🔴 The rendered result, not the catalogue (0.2.53's law — a test that only
// asserted `S.profession_*` strings exist would have been green while the
// chips on screen were Chinese, because the defect was in the TEMPLATE, not
// in the string table). Scoped to the professions chip row specifically (not
// the whole card) so the CJK check cannot accidentally pass or fail on
// unrelated prose elsewhere on the page.
//
// 🔴 REVERSE CONTROL: the same probe run against zh-CN must find CJK — a CJK
// regex that never matches anything is a blind probe, not a passing test (the
// G13 lesson this repo keeps re-learning). Seen red against the pre-fix
// template (`{{ p }}` on PROFESSION_OPTIONS) before this file's fix landed:
// the `en` assertion below failed with the seven raw Chinese labels in the
// chip HTML; reverted to confirm, then re-applied.

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
  });

  it('🔴 positive control: the SAME probe against zh-CN DOES find CJK — proves the regex is not blind', async () => {
    const chips = professionChipsHtml(await render('zh-CN'));
    expect(chips, 'zh-CN chips should still contain CJK').toMatch(CJK);
  });

  it('zh-CN wording is byte-identical to what shipped before this fix (no silent rewording)', async () => {
    const chips = professionChipsHtml(await render('zh-CN'));
    for (const id of PROFESSION_OPTIONS) {
      expect(chips, `zh-CN chip for id ${JSON.stringify(id)}`).toContain(esc(id));
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
      ] as const) {
        expect(chips, `${loc}.${key} missing from chip row`).toContain(esc(s[key]));
      }
    }
  });

  it('the stored ids (PROFESSION_OPTIONS) are unchanged — only the display label moved', () => {
    // Locked verbatim: card.professions is a bare string[] that rides into the
    // compose prompt as "Speaker professions: ...", and is already persisted
    // on existing installs keyed on these exact strings. Changing any of them
    // here would silently un-select an existing user's chosen chips.
    expect(PROFESSION_OPTIONS).toEqual([
      '软件开发', '云原生 / 运维', '产品设计', '金融', '医疗', '法律', '教育', '科研',
    ]);
  });
});
