// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §9:
//   "§6.1-c desktop has no duration — the desktop stats have no duration tile
//     (negative), and the sentence 'only the phone can answer duration'
//     really renders (positive control, otherwise the 'zero' could be a
//     blind probe)"
//   "§6.2-5 freed-bytes figure / §6.2-3 cleared ≠ never existed"
//
// Render path is the same as data-portability.test.ts (SSR first frame).
// ⚠️ onMounted does not run under SSR, so what is seen here is the screen
// **before the user presses any button** — exactly where both warnings must be.

import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import TimelineStats from './components/TimelineStats.vue';
import TimelineClear from './components/TimelineClear.vue';
import { STATS_STRINGS } from '../lib/strings/stats';
import { setLocale, wireLocaleStore } from '../lib/strings';
import { UI_LOCALES } from '../lib/strings/locale';
import { CLEAR_WINDOWS } from '../lib/timeline-purge';

const ZH = STATS_STRINGS['zh-CN'];

describe('the stats page — the duration tile does not exist, and someone says why (§6.1-c)', () => {
  it('🔴 the positive control comes first: the stats card really renders', async () => {
    wireLocaleStore(null);
    setLocale('zh-CN');
    const html = await renderToString(createSSRApp(TimelineStats));
    expect(html.length).toBeGreaterThan(100);
    expect(html).toContain(ZH.st_title);
    expect(html).toContain(ZH.st_hint);
  });

  it('🔴 0.2.43: both duration-gap sentences are complete in all four languages, and "unknown" must never be said as 0', () => {
    // §6.1-c revision (owner: "speech duration needs to come back"): the tile
    // has a real data source now, but the two sentences "N more row(s) have
    // no duration" and "not a single one has one" are the user-visible face
    // of "null is never treated as 0" — not one sentence may be missing.
    for (const loc of UI_LOCALES) {
      expect(STATS_STRINGS[loc].st_duration_missing.trim().length, loc).toBeGreaterThan(10);
      expect(STATS_STRINGS[loc].st_duration_missing, loc).toContain('{n}');
      expect(STATS_STRINGS[loc].st_duration_none.trim().length, loc).toBeGreaterThan(15);
    }
    expect(ZH.st_duration_missing).toContain('不计入');
    expect(ZH.st_duration_none).not.toContain('0 分钟');
  });

  it('🔴 the duration keys\' catalogue shape: three keys divide the labour (tile label / N more rows / not a single one), a retired key must not come back from the dead', () => {
    const keys = Object.keys(ZH);
    expect(keys.filter((k) => /^st_.*(duration|time_total|minutes)/.test(k)).sort()).toEqual([
      'st_duration', 'st_duration_missing', 'st_duration_none',
    ]);
    expect(keys).not.toContain('st_no_duration');
  });
});

describe('the clear card — the irreversibility is stated clearly above the button (§6.2)', () => {
  it('🔴 the standing warning really renders, and all six time tiers are on screen', async () => {
    wireLocaleStore(null);
    setLocale('zh-CN');
    const html = await renderToString(createSSRApp(TimelineClear));
    // 0.2.44: the card no longer has its own heading — the heading is the data
    // panel's "clear records ▾" entry row, and a same-named sub-h would say
    // the same sentence twice (owner's red-boxed note ②). The warning is the
    // first element, still above the button.
    expect(html).not.toContain(`>${ZH.cl_title}<`);
    expect(html).toContain(ZH.cl_irreversible);
    // The two-way kind pick + the time tiers are REAL controls, not just mentioned in prose.
    expect(html).toContain(ZH.cl_kind_text);
    expect(html).toContain(ZH.cl_kind_images);
    for (const w of CLEAR_WINDOWS) {
      const label = {
        week: ZH.cl_win_week,
        month: ZH.cl_win_month,
        quarter: ZH.cl_win_quarter,
        halfYear: ZH.cl_win_halfYear,
        year: ZH.cl_win_year,
        all: ZH.cl_win_all,
      }[w];
      expect(html, w).toContain(label);
    }
  });

  it('the button is disabled when the store is empty — the smallest form of "button ⇔ bytes" (§6.2-4)', async () => {
    const html = await renderToString(createSSRApp(TimelineClear));
    expect(html).toContain(ZH.cl_nothing);
    expect(html).toContain('disabled');
  });

  it('the warning must not be softened into consequence-less phrasing (all four languages)', () => {
    for (const loc of UI_LOCALES) {
      const s = STATS_STRINGS[loc].cl_irreversible;
      expect(s.trim().length, loc).toBeGreaterThan(15);
      expect(s, loc).not.toContain('整理');
      expect(s.toLowerCase(), loc).not.toContain('tidy');
    }
  });
});

// ── 2026-08-02 rework (mockup §1.5): the lifecycle of the clear result ────────────────────────────
//
// "N item(s) deleted" is event-type (describes the press that just happened)
// ⇒ auto-hides + can be dismissed manually;
// "cleared before {t}" is a state-type fact (persisted cutoff) ⇒ one compact
// line, stays within the clear surface.
// Clearing cannot be clicked in SSR, so the lifecycle can only be proven from
// source — the criterion is that those mechanisms really exist and are wired
// correctly.
describe('the clear result: an event-type banner + one compact line of fact (no longer page-tail prose)', () => {
  const SRC = ((): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- source probe
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { fileURLToPath } = require('node:url') as typeof import('node:url');
    return readFileSync(fileURLToPath(new URL('./components/TimelineClear.vue', import.meta.url)), 'utf8');
  })();
  // Negative assertions run against the comment-stripped view (this repo's
  // shape of G13 rule ②: a comment is an audit trail, the probe is what needs fixing).
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*(?:\/\/|<!--).*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  it('🔴 event-type: auto-hides after ~4 seconds, a re-trigger gets its full window, no stray timer left on unmount', () => {
    expect(SRC).toContain('DONE_MS = 4000');
    expect(SRC).toMatch(/setTimeout\([\s\S]{0,120}?DONE_MS\)/);
    expect(SRC).toMatch(/clearTimeout\(doneTimer\)/);
    expect(SRC).toMatch(/onUnmounted\(/);
  });

  it('the banner can be dismissed manually (✕ calls dismissDone), and run() only calls showDone after recount', () => {
    expect(SRC).toContain('@click="dismissDone"');
    const iRecount = SRC.indexOf('await recount();\n    showDone');
    expect(iRecount).toBeGreaterThan(0);
  });

  it('🔴 the state-type fact is merged into one line (cutLine), the old two separate <p> elements no longer exist', () => {
    // 0.2.44 (owner's red-boxed note ②): two cutoffs on the same day merge
    // into one cl_cleared_both sentence; different days are joined with a
    // space — no more "。·"-style connectors meant for machines to read.
    expect(SRC).toContain('S.cl_cleared_both');
    expect(SRC).toContain("parts.join(' ')");
    expect(SRC).not.toContain("join(' · ')");
    expect(CODE).toContain('cutLine');
    // The old shape: two separately v-if'd cutoffs paragraphs — exactly the
    // two lines hanging under the button in owner's screenshot.
    expect(CODE).not.toMatch(/v-if="timelineRetention\.cutoffs\.text/);
    expect(CODE).not.toMatch(/v-if="timelineRetention\.cutoffs\.images/);
  });

  it('the first frame (before any button press) has no "deleted" banner — positive control: both the warning and the tiers are present', async () => {
    const html = await renderToString(createSSRApp(TimelineClear));
    expect(html).not.toContain('cl-done');
    expect(html).toContain(ZH.cl_irreversible);
  });
});
