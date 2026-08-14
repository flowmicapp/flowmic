// REQ-12-13 — what a remote key-press row looks like on the PC timeline
// (owner P0 2026-08-12). Contract = docs/rebuild/15 §2.0-e. The render path is
// exactly the same as timeline-search.test.ts (SSR compiles the real SFC), so
// what this file proves is **what the page displays**, not clicking.
//
// 🔴 Every assertion in this file corresponds to "what would happen if this
// were missing," not "does the code look right":
//   · Presentation: a row with empty `output_text`, if rendered as an ordinary
//     row, would be **a blank message** on screen;
//   · Two verbs: "re-inject" a key-press row = actually typing the word
//     "clear" INTO the user's document;
//   · Mode badge: that span has **no v-if** guarding it, so without one every
//     key press would wear the realtime waveform icon.

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
const { S, setLocale } = await import('../lib/strings');
const { UI_LOCALES } = await import('../lib/strings/locale');

function controlRow(over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'ctl:1-0',
    // 🔴 Structural filler: a key press has no mode (book 15 §2.0-e). The row
    // carries it, the UI must not draw it.
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    // Empty — the presentation is assembled at render time; the row itself has
    // no typeable text at all.
    output_text: '',
    created_at: '2026-08-12T10:00:00.000Z',
    updated_at: '2026-08-12T10:00:00.000Z',
    entry_type: 'control',
    control_kind: 'clear',
    control_outcome: 'sent',
    thumb_b64: null,
    full_image: false,
    target: null,
    cached_cause: null,
    focus_process: null,
    focus_evidence: null,
    mobile_id: null,
    device_label: null,
    duration_ms: null,
    channel: 'lan',
    ...over,
  };
}

function transcriptRow(over: Partial<TimelineRow> = {}): TimelineRow {
  return controlRow({
    id: 'req:1',
    entry_type: 'transcript',
    control_kind: null,
    control_outcome: null,
    output_text: '这是一句话',
    ...over,
  });
}

async function html(): Promise<string> {
  return renderToString(createSSRApp(TimelinePage));
}

afterEach(() => {
  h.entries.value = [];
  setLocale('zh-CN');
});

describe('REQ-12-13 — a key-press row can say which key was pressed', () => {
  it('the row reads "remote key press · clear," each of the four UI languages saying it their own way', async () => {
    for (const locale of UI_LOCALES) {
      setLocale(locale);
      h.entries.value = [controlRow()];
      const out = await html();
      expect(out, locale).toContain(S.tl_control_chip);
      expect(out, locale).toContain(S.ck_clear);
    }
  });

  it('every key recognises itself', async () => {
    for (const [kind, label] of [
      ['enter', () => S.ck_enter],
      ['backspace', () => S.ck_backspace],
      ['undo', () => S.ck_undo],
      ['clear', () => S.ck_clear],
    ] as const) {
      h.entries.value = [controlRow({ control_kind: kind })];
      expect(await html(), kind).toContain(label());
    }
  });

  it('an unrecognised kind prints the bare identifier, not a blank row', async () => {
    // "this row cannot say which key it was" and "this row does not exist"
    // are two different things. Printing the identifier is the next person's
    // only lead to dig further — the same policy the phone applies to an
    // unregistered error code: never invent a sentence to cover for it.
    h.entries.value = [controlRow({ control_kind: 'quantum_key' })];
    expect(await html()).toContain('quantum_key');
  });
});

describe('REQ-12-13 — a result note is added only when it never made it out', () => {
  it('it made it out: the status badge says "delivered," no extra result sentence', async () => {
    // 🔴 "Delivered" rather than "injected": the chord never reads back
    // evidence (`focus_evidence` is permanently absent), and "we never asked"
    // must never be rendered as "confirmed" (R11).
    h.entries.value = [controlRow({ control_outcome: 'sent' })];
    const out = await html();
    expect(out).toContain(S.st_delivered);
    expect(out).not.toContain(S.st_injected);
    for (const note of [S.co_no_target, S.co_os_refused, S.co_not_primary]) {
      expect(out).not.toContain(note);
    }
  });

  it('it never made it out: each failure speaks its own sentence, and the status is "not injected"', async () => {
    for (const [outcome, note] of [
      ['no_target', () => S.co_no_target],
      ['foreground_refused', () => S.co_foreground_refused],
      ['os_refused', () => S.co_os_refused],
      ['send_failed', () => S.co_send_failed],
      ['not_primary', () => S.co_not_primary],
    ] as const) {
      h.entries.value = [controlRow({ control_outcome: outcome, status: 'failed' })];
      const out = await html();
      expect(out, outcome).toContain(note());
      expect(out, outcome).toContain(S.st_failed);
    }
  });
});

describe('REQ-12-13 — this row must not be treated as an utterance', () => {
  it('🔴 no "re-inject," and no "edit"', async () => {
    // This is this file's whole reason for existing. Both judgement criteria
    // predated this card as `!== 'image'` (an open gate), so the moment a
    // third row kind showed up it **automatically** grew these two buttons,
    // and "re-inject" would type this row's content straight back into the
    // user's focused window. Reverse control: change both criteria back to
    // `!== 'image'`, this test goes red.
    h.entries.value = [controlRow()];
    const out = await html();
    expect(out).not.toContain(S.op_reinject);
    expect(out).not.toContain(S.op_edit);
  });

  it('an ordinary transcript row still has both buttons (positive control: the previous test is not because the whole page draws no buttons)', async () => {
    h.entries.value = [transcriptRow()];
    const out = await html();
    expect(out).toContain(S.op_reinject);
    expect(out).toContain(S.op_edit);
  });

  it('🔴 does not wear a mode badge — that span used to render unconditionally', async () => {
    // Without this v-if, every key press would wear the realtime waveform
    // icon and look like "something that was said" — the capsule strip fixed
    // the exact same defect for image rows (capsule/recent-line.ts's file header).
    const control = await (async () => {
      h.entries.value = [controlRow()];
      return html();
    })();
    const transcript = await (async () => {
      h.entries.value = [transcriptRow()];
      return html();
    })();
    expect(transcript).toContain('mbadge');
    expect(control).not.toContain('mbadge');
  });

  it('draws no word count — a key-press row has no words to count', async () => {
    h.entries.value = [controlRow()];
    expect(await html()).not.toContain('wc-chip');
  });
});
