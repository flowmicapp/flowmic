// V2-17 — history-row mode badges are ICONS now, not ①②③ numerals.
// Two guards:
//   ① the three modes map to three DIFFERENT symbols — three look-alike icons
//     would be the same riddle the numerals were;
//   ② every symbol carries a queryable word (the title= tooltip binding on
//     the row), because an unexplained icon is just a new kind of numeral.
// The ICONS table lives inside a .vue SFC (no node import), so the sources
// are read and anchored literally — same wiring-proof culture as the drift
// lints: MODE_BADGE pointing at an icon name that does not exist, or a badge
// span that lost its title=, is exactly the façade bug class this repo hunts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODE_BADGE } from './strings';

const MODES = ['realtime', 'translate', 'organize'] as const;

const iconVue = readFileSync(
  fileURLToPath(new URL('../main-window/components/Icon.vue', import.meta.url)),
  'utf8',
);
const timelinePage = readFileSync(
  fileURLToPath(new URL('../main-window/TimelinePage.vue', import.meta.url)),
  'utf8',
);

/** Keys of the ICONS literal inside Icon.vue (`name: '<svg…'` entries). */
function iconsTableKeys(src: string): string[] {
  const table = src.match(/const ICONS: Record<string, string> = \{([\s\S]*?)\n\};/);
  expect(table, 'ICONS table literal not found in Icon.vue').toBeTruthy();
  const body = table![1];
  expect(body, 'ICONS table body is empty').toBeTruthy();
  return [...body!.matchAll(/^\s*'?([\w-]+)'?:\s*'</gm)].map((m) => m[1]!);
}

describe('MODE_BADGE (V2-17 symbols)', () => {
  it('maps the three locked modes to three DISTINCT icon names', () => {
    const names = MODES.map((m) => MODE_BADGE[m]?.icon);
    expect(new Set(names).size).toBe(3);
  });

  it('every referenced icon actually exists in Icon.vue ICONS', () => {
    const keys = iconsTableKeys(iconVue);
    for (const m of MODES) {
      expect(keys, `${m} → ${MODE_BADGE[m]?.icon}`).toContain(MODE_BADGE[m]?.icon);
    }
    // …and the three ICONS entries are three different drawings.
    const paths = MODES.map((m) => {
      const re = new RegExp(`${MODE_BADGE[m]?.icon}: '([^']+)'`);
      return iconVue.match(re)?.[1];
    });
    expect(new Set(paths).size).toBe(3);
  });

  it('each mode has a non-empty, distinct tooltip word', () => {
    const labels = MODES.map((m) => MODE_BADGE[m]?.label);
    for (const l of labels) expect(l?.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(3);
  });

  it('the timeline row binds title= so the word is queryable on hover', () => {
    expect(timelinePage).toContain('class="mbadge"');
    expect(timelinePage).toContain(':title="MODE_BADGE[e.mode]?.label"');
    expect(timelinePage).toContain('<Icon :name="MODE_BADGE[e.mode]?.icon');
  });

  it('no ①②③ numeral survives in the badge map or the row template', () => {
    for (const m of MODES) {
      expect(JSON.stringify(MODE_BADGE[m])).not.toMatch(/[①②③]/);
    }
    expect(timelinePage).not.toContain('MODE_BADGE[e.mode]?.glyph');
  });
});
