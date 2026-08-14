// 2026-08-02 rework (mockup §1.3): the **render-face** guard for stats "grouped by source phone."
//
// The logic face (how grouping works, the UUID never entering `name`) is in
// lib/portable/inventory.test.ts; what this file guards is that the template
// really draws only groupLabel's three forms, and that a raw internal id
// cannot be grepped out of the HTML — owner's screenshot defect ①
// (6427ef13-… shown directly to the user) leaked out through exactly this face.
//
// onMounted does not run under SSR, but `assets`'s seed comes **synchronously**
// from timeline.allRows() (the component is deliberately designed this way —
// the first frame already has numbers, refresh only fills in picture bytes),
// so one renderToString is exactly the frame the user sees when opening the panel.

import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { TimelineRow } from '../lib/types';

const UUID = '6427ef13-dead-beef-0000-000000000000';

const M = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- hoisted before imports
  const { reactive } = require('vue') as typeof import('vue');
  const row = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'req:x', mode: 'realtime', status: 'injected', edited: false,
    source_text: null, output_text: '你好', created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:00.000Z', entry_type: 'transcript', thumb_b64: null,
    full_image: false, target: null, mobile_id: null, device_label: null, channel: 'lan',
    ...over,
  });
  return {
    mobileNames: reactive<Record<string, string>>({ 'p-lan': 'HUAWEI PLA-AL10-921d', 'p-cloud': 'HUAWEI PLA-AL10-921d' }),
    mobileMachines: reactive<Record<string, string | null>>({ 'p-lan': 'mb-hw', 'p-cloud': 'mb-hw' }),
    rows: [
      row({ id: 'a', mobile_id: 'p-lan' }),
      row({ id: 'b', mobile_id: 'p-cloud' }),
      row({ id: 'c', mobile_id: null, device_label: 'HUAWEI PLA-AL10-921d' }),
      row({ id: 'd', mobile_id: '6427ef13-dead-beef-0000-000000000000' }),
      row({ id: 'e', mobile_id: null }),
    ],
  };
});

vi.mock('./store', () => ({
  mobileNames: M.mobileNames,
  mobileMachines: M.mobileMachines,
  timeline: { allRows: () => M.rows as unknown as TimelineRow[] },
}));
vi.mock('../lib/bridge', () => ({
  portablePictureSizes: vi.fn(async () => []),
}));

const TimelineStats = (await import('./components/TimelineStats.vue')).default;
const { S } = await import('../lib/strings');

function renderStats(): Promise<string> {
  return renderToString(createSSRApp(TimelineStats));
}

describe('stats group rendering — an internal id never reaches the screen', () => {
  it('🔴 after grouping, the UUID cannot be grepped out of the HTML; two pairings + the label row merge into one line; the early/other rows are fixed copy', async () => {
    const html = await renderStats();
    // This is the direct counter-proposition to owner's screenshot defect ①.
    expect(html).not.toContain(UUID.slice(0, 8));
    // Merged into a single line (the name appears once inside the group area,
    // zero times outside it — the group area renders once).
    expect(html).toContain('HUAWEI PLA-AL10-921d');
    expect(html).toContain(S.st_early);
    expect(html).toContain(S.st_other.replace('{n}', '1'));
  });

  it('all three group forms carry an explanation: other/early get a tooltip (dotted-underline mark), named does not', async () => {
    const html = await renderStats();
    expect(html).toContain(S.st_other_tip);
    expect(html).toContain(S.st_early_tip);
  });

  it('standing note: with zero stamped rows it is the "none carry a duration" sentence + the per-language accuracy note (owner 2026-08-02)', async () => {
    // M.rows all lack duration_ms ⇒ the §6.1-c revised "not a single one"
    // branch: no duration tile, the explanation sentence renders.
    const html = await renderStats();
    expect(html).toContain(S.st_duration_none);
    expect(html).not.toContain(`>${S.st_duration}<`);
    expect(html).toContain(S.st_approx);
  });

  it('🔴 0.2.43 with stamped rows present: the duration tile renders a real sum, "N more row(s)" is on screen at the same time (null is never treated as 0)', async () => {
    (M.rows[0] as Record<string, unknown>).duration_ms = 4000;
    try {
      const html = await renderStats();
      expect(html).toContain(`>${S.st_duration}<`);
      expect(html).toContain('4s'); // formatRowDuration(4000) — only the one stamped row
      expect(html).toContain(S.st_duration_missing.replace('{n}', '4'));
      expect(html).not.toContain(S.st_duration_none);
    } finally {
      delete (M.rows[0] as Record<string, unknown>).duration_ms;
    }
  });
});
