// FR-D2 (first-run walk on a fresh 0.3.120, 2026-11-06): an English timeline
// showed 刚刚 on every row younger than a minute, and 昨天 on yesterday's rows.
// protocol's formatTimelineLabel took a locale argument that defaulted to zh-CN,
// and none of its callers ever passed one.
//
// The deliverable is what the row says on the Timeline page, so these cases
// render the real page through the mocked store (timeline-search.test.ts explains
// why that substitution is honest) and read the row and its tooltip.

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      refresh: vi.fn(),
      search: vi.fn(),
      clearSearch: vi.fn(),
      clearFailure: vi.fn(),
      textOf: vi.fn(),
      allRows: vi.fn(() => [] as TimelineRow[]),
    },
    rowImage: vi.fn(async () => null),
  };
});

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
const { S_BY_LOCALE, UI_LOCALES, setLocale } = await import('../lib/strings');

function row(createdAt: string, over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'r1',
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    output_text: 'row body',
    created_at: createdAt,
    updated_at: createdAt,
    entry_type: 'transcript',
    control_kind: null,
    control_outcome: null,
    thumb_b64: null,
    full_image: false,
    target: null,
    mobile_id: null,
    device_label: null,
    channel: 'lan',
    ...over,
  };
}

const page = (): Promise<string> => renderToString(createSSRApp(TimelinePage));
const esc = (text: string): string => text.replace(/'/g, '&#39;');

afterEach(() => {
  h.entries.value = [];
  h.timelineRetention.value = { kept: 0, cutoff: null, cutoffs: { text: null, images: null } };
  setLocale('zh-CN');
});

describe('a timeline row says when, in the language the reader chose', () => {
  for (const code of UI_LOCALES) {
    it(`${code}: a row younger than a minute`, async () => {
      setLocale(code);
      h.entries.value = [row(new Date(Date.now() - 5_000).toISOString())];
      const out = await page();
      expect(out).toContain(esc(S_BY_LOCALE[code].dev_time_just_now));
      if (S_BY_LOCALE[code].dev_time_just_now !== '刚刚') expect(out).not.toContain('刚刚');
    });

    it(`${code}: a row from yesterday`, async () => {
      setLocale(code);
      const at = new Date();
      at.setDate(at.getDate() - 1);
      at.setHours(9, 41, 0, 0);
      h.entries.value = [row(at.toISOString())];
      const out = await page();
      expect(out).toContain(`${esc(S_BY_LOCALE[code].dev_time_yesterday)} 09:41`);
      if (S_BY_LOCALE[code].dev_time_yesterday !== '昨天') expect(out).not.toContain('昨天');
    });
  }

  it('the provenance tooltip on an injected row uses the same words', async () => {
    setLocale('en');
    h.entries.value = [row(new Date(Date.now() - 3_600_000 * 30).toISOString(), {
      target: { window_title: 'Notes', process_name: 'notes', injected_at: new Date(Date.now() - 5_000).toISOString() },
    } as Partial<TimelineRow>)];
    const out = await page();
    expect(out).toContain('Just now');
    expect(out).not.toContain('刚刚');
  });

  it('the retention note states its cutoff in the same language', async () => {
    setLocale('en');
    h.entries.value = [row('2020-01-01T00:00:00.000Z')];
    h.timelineRetention.value = {
      kept: 1,
      cutoff: new Date(Date.now() - 5_000).toISOString(),
      cutoffs: { text: null, images: null },
    };
    const out = await page();
    expect(out).toContain('Just now');
    expect(out).not.toContain('刚刚');
  });
});
