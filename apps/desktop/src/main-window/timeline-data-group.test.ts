// owner 2026-08-02 UI batch 1 ③ "the PC 'data' group moves from settings to the
// timeline page" + the rework ruling's guard for "data gets its own view,
// switchable with the timeline data list."
//
// 🔴 Why this file has to exist: when the three cards were re-mounted onto a
// different page, **the entire suite of 701 unit tests stayed green** — each
// component's own tests cannot prove "which page this group is mounted on, in
// what form." That means the next edit could drop the mount point entirely and
// the gates would stay all-green — the UI-layer version of this repo's #1
// historical bug class (a capability still exists, nobody calls it).
//
// Division of labour, by what each half can actually be proven by:
//   · the moved-away half (the settings page) is a DELETION ⇒ source-literal assertion;
//   · the timeline page: the **default view (row list)** is proven by a REAL
//     render (SSR reaches it, and it is exactly the frame the user sees when
//     opening the page); the "data" view's existence and the toggle structure
//     are proven by source assertions — SSR cannot click;
//   · the data panel itself (TimelineDataPanel) is rendered **directly** — it
//     is now an independent component, which is exactly one of the benefits
//     of having extracted it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineRow } from '../lib/types';
import type { RetentionFacts } from '../lib/timeline-store';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- hoisted before imports
  const { reactive, ref } = require('vue') as typeof import('vue');
  return {
    entries: ref<TimelineRow[]>([]),
    timelineFailure: ref<null>(null),
    timelineQuery: ref(''),
    timelineRetention: ref<RetentionFacts>({ kept: 0, cutoff: null, cutoffs: { text: null, images: null } }),
    timelineStorageFailed: ref(false),
    mobileNames: reactive<Record<string, string>>({}),
    mobileMachines: reactive<Record<string, string | null>>({}),
    timeline: {
      edit: vi.fn(),
      remove: vi.fn(),
      reInject: vi.fn(),
      search: vi.fn(),
      clearSearch: vi.fn(),
      clearFailure: vi.fn(),
      textOf: vi.fn(),
      allRows: vi.fn(() => [] as TimelineRow[]),
      previewClear: vi.fn(() => [] as TimelineRow[]),
      clear: vi.fn(),
      retention: { kept: 0, cutoff: null, cutoffs: { text: null, images: null } },
    },
    rowImage: vi.fn(async () => null),
  };
});

// Same substitution timeline-search.test.ts justifies: `./store` builds the real
// TimelineStore over localStorage + the Tauri bridge at module load, and the page's
// own inputs are exactly these refs.
vi.mock('./store', () => ({
  entries: h.entries,
  timelineFailure: h.timelineFailure,
  timelineQuery: h.timelineQuery,
  timelineRetention: h.timelineRetention,
  timelineStorageFailed: h.timelineStorageFailed,
  mobileNames: h.mobileNames,
  mobileMachines: h.mobileMachines,
  timeline: h.timeline,
  rowImage: h.rowImage,
}));

const TimelinePage = (await import('./TimelinePage.vue')).default;
const TimelineDataPanel = (await import('./components/TimelineDataPanel.vue')).default;
const { S } = await import('../lib/strings');

const TL_SRC = readFileSync(fileURLToPath(new URL('./TimelinePage.vue', import.meta.url)), 'utf8');
const PANEL_SRC = readFileSync(
  fileURLToPath(new URL('./components/TimelineDataPanel.vue', import.meta.url)),
  'utf8',
);
const SET_SRC = readFileSync(fileURLToPath(new URL('./SettingsPage.vue', import.meta.url)), 'utf8');

/** The rendered page with HTML COMMENTS STRIPPED.
 *
 *  🔴 Not a convenience — the first run of this file failed on it. Vue's SSR renderer
 *  emits `<!-- … -->` template comments verbatim, and a comment introducing the data
 *  group contains the word "statistics" (统计). The general form is this repo's G13
 *  rule ② one layer down: **a negative assertion is only as good as what it is
 *  allowed to see**. */
async function render(component: unknown): Promise<string> {
  const raw = await renderToString(createSSRApp(component as Parameters<typeof createSSRApp>[0]));
  return raw.replace(/<!--[\s\S]*?-->/g, '');
}

describe('the settings page handed off the data group, no orphan left behind', () => {
  it('[source] the three components are no longer imported or mounted by the settings page', () => {
    for (const gone of ['TimelineStats', 'DataPortability', 'TimelineClear']) {
      expect(SET_SRC, `${gone} must no longer be imported here`).not.toMatch(
        new RegExp(`^import ${gone} from`, 'm'),
      );
      expect(SET_SRC, `<${gone}> must no longer be mounted here`).not.toContain(`<${gone}`);
    }
  });

  it('[source] no empty section with just a heading left behind', () => {
    expect(SET_SRC).not.toContain('id="set-data"');
    expect(SET_SRC).not.toContain("{ id: 'data'");
    expect(SET_SRC).not.toContain('S.tl_data_title');
  });

  it('[catalogue] `set_nav_data` followed its one and only consumer, the other two changed prefix', () => {
    const keys = Object.keys(S);
    expect(keys).not.toContain('set_nav_data');
    expect(keys).not.toContain('set_data_title');
    expect(keys).not.toContain('set_data_hint');
    expect(keys).toContain('tl_data_title');
    expect(keys).toContain('tl_data_hint');
  });

  it('[source] the original five sections keep their order, the new one is an APPEND, and SECS order matches DOM order (the scroll-spy "last section" rule depends on it)', () => {
    const secs = [...SET_SRC.matchAll(/\{ id: '(\w+)', label:/g)].map((m) => m[1]!);
    // Kept verbatim: the 2026-08-04 real-device run sheet names exactly these five positions.
    expect(secs.slice(0, 5)).toEqual(['account', 'stt', 'llm', 'prefs', 'about']);
    // 0.3.0 P1 appends "privacy & data" — the same shape of addition as that
    // year's "data" section: APPEND to the end, none of the five above move,
    // so it is likewise the one item that can be cleanly lifted back out.
    expect(secs.slice(5)).toEqual(['privacy']);
    // 🔴 The assertion was changed to "position" rather than "what the last
    // item is called." What the spy's "scroll to the bottom ⇒ last section"
    // actually depends on is not SECS's literal content, but **SECS order
    // matching DOM order**: if someone inserts a new section into the middle
    // of the DOM but leaves the nav item at the end of the array, a
    // name-only assertion stays green while the highlight jumps to a section
    // the user never scrolled to. This also nails down "every nav item has a
    // matching section" — scrollTo() resolves `set-${id}`, and a nav item
    // missing its section scrolls nowhere.
    const at = (id: string): number => SET_SRC.indexOf(`id="set-${id}"`);
    for (const id of secs) expect(at(id), `set-${id} section does not exist`).toBeGreaterThan(-1);
    const positions = secs.map(at);
    expect(positions, 'SECS order does not match DOM order').toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('the timeline page: data is an independent view, toggled with the row list (owner 2026-08-02 ruling)', () => {
  it('[render] the default view is the row list: not one of the data panel\'s three cards is on screen', async () => {
    const html = await render(TimelinePage);
    // Clear matters most — it carries an irreversible button, must never stand
    // beside the rows on the very first frame the page opens on.
    expect(html).not.toContain(S.cl_title);
    expect(html).not.toContain(S.cl_irreversible);
    expect(html).not.toContain(S.st_title);
    expect(html).not.toContain(S.pd_export_btn);
    expect(html).not.toContain('id="tl-data"');
  });

  it('[render] positive control: the two page-header segments really render (the toggle entry point is standing)', async () => {
    const html = await render(TimelinePage);
    expect(html).toContain('tl-views');
    expect(html).toContain(S.tl_data_title);
    expect(html).toContain(S.timeline_title);
  });

  it('[source] 🔴 the data panel is no longer mounted at the tail of the list: the page\'s only mount is the v-else TimelineDataPanel', () => {
    expect(TL_SRC).toContain("const view = ref<'rows' | 'data'>('rows')");
    expect(TL_SRC).toMatch(/<TimelineDataPanel v-else \/>/);
    // The three cards are no longer mounted directly by the page — they belong to the panel.
    for (const comp of ['<TimelineStats', '<DataPortability', '<TimelineClear']) {
      expect(TL_SRC).not.toContain(comp);
    }
  });

  it('[source] the view state is a session-only ref, not a settings item', () => {
    expect(TL_SRC).not.toMatch(/view[\s\S]{0,120}(localKv|settings\.)/);
  });
});

describe('the data panel (TimelineDataPanel — rendered directly)', () => {
  const ROW_A = {
    id: 'req:a', mode: 'realtime', status: 'injected', edited: false,
    source_text: null, output_text: '你好世界', created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:00.000Z', entry_type: 'transcript', thumb_b64: null,
    full_image: false, target: null, mobile_id: null, device_label: null, channel: 'lan',
  } as unknown as TimelineRow;
  const ROW_B = { ...ROW_A, id: 'req:b', created_at: '2026-08-02T08:00:00.000Z' } as TimelineRow;

  it('[render] 🔴 the group\'s internal order is still C2\'s ruling of "stats → export/import → clear" (export is clear\'s safety net)', async () => {
    const html = await render(TimelineDataPanel);
    const iStats = html.indexOf(S.st_title);
    const iPortable = html.indexOf(S.pd_export_title);
    const iClear = html.indexOf(S.cl_title);
    expect(iStats).toBeGreaterThan(0);
    expect(iStats).toBeLessThan(iPortable);
    expect(iPortable).toBeLessThan(iClear);
  });

  it('[render] head-row live summary: row count/word count/range when there are rows, empty-store fallback hint otherwise (positive/negative control)', async () => {
    h.timeline.allRows.mockReturnValue([ROW_A, ROW_B]);
    try {
      const html = await render(TimelineDataPanel);
      expect(html).toContain(`2 ${S.st_unit_rows}`);
      expect(html).toContain(S.st_range_to);
      expect(html).toContain('2026-08-01');
      expect(html).not.toContain(S.tl_data_hint);
    } finally {
      h.timeline.allRows.mockReturnValue([]);
    }
    expect(await render(TimelineDataPanel)).toContain(S.tl_data_hint);
  });

  it('[source] 🔴 the summary consumes the SAME pair of inventory-layer functions + allRows (entries is filtered by search, cannot answer for the whole store)', () => {
    expect(PANEL_SRC).toContain('summarize(walkAssets(timeline.allRows(), new Map()))');
  });

  it('[render] clear is a second-layer disclosure: the first frame has only the entry row and the safety-net hint, no warning or tier pills visible', async () => {
    const html = await render(TimelineDataPanel);
    expect(html).toContain(S.cl_entry_hint);
    expect(html).not.toContain(S.cl_irreversible);
    expect(html).not.toContain(S.cl_win_week);
  });

  it('[source] TimelineClear is mounted inside clearOpen (default off), the entry sits before it', () => {
    expect(PANEL_SRC).toContain('const clearOpen = ref(false)');
    expect(PANEL_SRC).toMatch(/<TimelineClear v-if="clearOpen"/);
    expect(PANEL_SRC.indexOf('S.cl_entry_hint')).toBeLessThan(PANEL_SRC.indexOf('<TimelineClear'));
  });

  it('[source] the clear → stats-refresh wire is still there (if it dropped, nothing would error)', () => {
    expect(PANEL_SRC).toContain('@cleared="() => stats?.refresh()"');
    expect(PANEL_SRC).toMatch(/const stats = ref<\{ refresh/);
  });

  it('[source] the disclosure state is a session-only ref, not persisted to settings', () => {
    expect(PANEL_SRC).not.toMatch(/clearOpen[\s\S]{0,120}(localKv|settings\.)/);
  });
});

// ── 0.2.47 (owner's two data-page rulings): section-container unification — the guard against the ghost class `.pad` ────────────────
//
// The disease: `.card` has a definition in tokens.css but `.pad` never did —
// five components each patched in their own scoped padding (one had already
// drifted to 12px/14px), and the two that missed the patch (the stats card,
// the clear card) rendered as an edge-to-edge bare block with "a border but
// zero inner padding." Why 0.2.46's "no element escapes its card" geometry
// assertion never caught it: the content genuinely never escaped the card —
// the card itself had lost its lining. ⇒ Guard both halves: the one true
// definition really exists; the data-page components are never allowed to
// grow a private copy again.
describe('data-page section-container unification: `.card.pad` has exactly one definition, in tokens.css', () => {
  const TOKENS = readFileSync(
    fileURLToPath(new URL('../styles/tokens.css', import.meta.url)),
    'utf8',
  );

  it('🔴 the sole definition lives in tokens.css, and carries padding (the ghost class must not recur)', () => {
    const defs = TOKENS.match(/^\.card\.pad \{[^}]*\}/gm) ?? [];
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain('padding');
  });

  it('🔴 the data-page component family has ZERO private `.card.pad` definitions (with one true definition in place, a copy is a seed for drift)', () => {
    const family: Record<string, string> = {
      'TimelineStats.vue': readFileSync(fileURLToPath(new URL('./components/TimelineStats.vue', import.meta.url)), 'utf8'),
      'DataPortability.vue': readFileSync(fileURLToPath(new URL('./components/DataPortability.vue', import.meta.url)), 'utf8'),
      'TimelineClear.vue': readFileSync(fileURLToPath(new URL('./components/TimelineClear.vue', import.meta.url)), 'utf8'),
      'TimelineDataPanel.vue': PANEL_SRC,
    };
    for (const [name, src] of Object.entries(family)) {
      expect(src, `${name} must not define a private .card.pad`).not.toMatch(/\.card\.pad\s*\{/);
    }
  });

  it('🔴 every data-page section has a card container (stats / export-import / clear — 0.2.46\'s assertion missed it precisely because there was no card at all)', () => {
    const stats = readFileSync(fileURLToPath(new URL('./components/TimelineStats.vue', import.meta.url)), 'utf8');
    const portability = readFileSync(fileURLToPath(new URL('./components/DataPortability.vue', import.meta.url)), 'utf8');
    expect(stats).toContain('<div class="card pad">');
    expect(portability).toContain('<div class="card pad">');
    expect(PANEL_SRC).toContain('class="card pad clear-card"');
  });

  it('[render] the three sections\' cards really land in the DOM (positive control: a source assertion might be pinning dead code)', async () => {
    const html = await render(TimelineDataPanel);
    const cards = html.match(/class="card pad[" ]/g) ?? [];
    expect(cards.length).toBeGreaterThanOrEqual(3);
  });
});
