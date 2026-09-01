// W-i18n-B — stored Chinese profession ids must light the English-slug chip
// and be written back as slugs on the next save. Unknown values survive.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// The chip lights because asCardMigrated (settings-model.ts) runs
// migrateProfessionList on READ. Removing that call — leaving
// `asCard(v)` as the narrow — makes a stored `软件开发` sit next to chips
// whose ids are `software development`, so `.includes(p.id)` is false and
// the chip stays dark. Run with the mapping commented out, paste the
// verbatim red below, restore, green, grep marker = 0.
//
// Verbatim red (2026-08-31, this file, mapping removed from asCardMigrated):
//   FAIL  src/main-window/profession-id-migration.test.ts > W-i18n-B profession id read mapping > a stored 软件开发 lights the software-development chip and is saved back as the slug
//   AssertionError: stored Chinese must light the software-development chip: expected 'class="ctx-chips"><!--[--><span class…' to match /class="on ctx-chip">Software developm…/
//
//   - Expected:
//   /class="on ctx-chip">Software development/
//
//   + Received:
//   "class=\"ctx-chips\"><!--[--><span class=\"ctx-chip\">Software development</span><span class=\"ctx-chip\">Product design</span>…"
//
// (every chip is class="ctx-chip" — none is lit). Restored; hyphenated
// reverse-control marker grep in apps/desktop/src = 0.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import ScenarioCard from './components/ScenarioCard.vue';
import { applyServerSettings, model, toggleProfession } from './settings-model';
import { settings } from './store';
import { setLocale } from '../lib/strings';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function professionChipsHtml(html: string): string {
  const start = html.indexOf('class="ctx-chips"');
  expect(start, 'ctx-chips row not found').toBeGreaterThan(-1);
  const end = html.indexOf('</div>', start);
  expect(end, 'ctx-chips row has no closing </div>').toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('W-i18n-B profession id read mapping', () => {
  beforeEach(() => {
    setLocale('en');
    model.card = { professions: [], domains: [], packs: [], terms: [] };
  });
  afterEach(() => {
    setLocale('zh-CN');
    model.card = { professions: [], domains: [], packs: [], terms: [] };
  });

  it('a stored 软件开发 lights the software-development chip and is saved back as the slug', async () => {
    applyServerSettings([
      { key: 'scenario.card', value: { professions: ['软件开发'], domains: [], packs: [], terms: [] } },
    ]);

    const html = await renderToString(createSSRApp(ScenarioCard));
    const chips = professionChipsHtml(html);
    expect(
      chips,
      'stored Chinese must light the software-development chip',
    ).toMatch(/class="on ctx-chip">Software development/);
    expect(model.card.professions).toEqual(['software development']);

    const pushed: unknown[] = [];
    const spy = vi.spyOn(settings, 'setScenarioCard').mockImplementation((v) => {
      pushed.push(v);
    });
    toggleProfession('product design');
    spy.mockRestore();
    expect(pushed).toHaveLength(1);
    const saved = pushed[0] as { professions: string[] };
    expect(saved.professions).toEqual(['software development', 'product design']);
    expect(saved.professions).not.toContain('软件开发');
  });

  it('an unknown stored value survives read + write untouched', async () => {
    applyServerSettings([
      {
        key: 'scenario.card',
        value: { professions: ['程序员', '软件开发'], domains: [], packs: [], terms: [] },
      },
    ]);
    expect(model.card.professions).toEqual(['程序员', 'software development']);

    const html = await renderToString(createSSRApp(ScenarioCard));
    const chips = professionChipsHtml(html);
    expect(chips).toMatch(/class="on ctx-chip">Software development/);
    expect(chips, 'custom values are not drawn as extra chips').not.toContain(esc('程序员'));

    const pushed: unknown[] = [];
    const spy = vi.spyOn(settings, 'setScenarioCard').mockImplementation((v) => {
      pushed.push(v);
    });
    toggleProfession('law');
    spy.mockRestore();
    const saved = pushed[0] as { professions: string[] };
    expect(saved.professions).toEqual(['程序员', 'software development', 'law']);
  });
});
