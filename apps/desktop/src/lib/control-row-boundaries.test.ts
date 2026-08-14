// REQ-12-13 — the four boundaries a control-key row crosses **outside the UI** (docs/rebuild/15 §2.0-e / book 16 §4.2).
//
// The UI half lives in main-window/control-key-row.test.ts. Here are the four
// places where things go wrong if you don't watch them — each one states what
// happens if it's missing:
//   ① the local cache (盘) (normalizeCachedRow) —— **loses data**: the two-branch
//      ternary rewrites it to transcript, and next boot writes it back
//      verbatim, so after one restart it permanently becomes an empty
//      transcript row;
//   ② stats/export (walkAssets) —— FPR v1 only recognizes transcript/image, so
//      it exports out but can't import back;
//   ③ the capsule strip (toRecentLine) —— `output_text` is an empty string, so
//      what gets drawn is an empty message;
//   ④ batch copy (planBatchCopy) —— that same empty string stuffs an empty
//      line into the clipboard.

import { describe, expect, it } from 'vitest';
import { normalizeCachedRow, mapItem } from './timeline-normalize';
import { rowWordCount } from './entry-metrics';
import { matchesFilter } from './timeline-filter';
import { walkAssets, summarize } from './portable/inventory';
import { toRecentLine } from '../capsule/recent-line';
import { planBatchCopy } from '../main-window/batch-copy';
import type { TimelineRow, WireHistoryItem } from './types';

const WIRE: WireHistoryItem = {
  id: 'ctl:1-0',
  mode: 'realtime',
  status: 'injected',
  edited: false,
  source_text: null,
  output_text: '',
  created_at: '2026-08-12T10:00:00.000Z',
  updated_at: '2026-08-12T10:00:00.000Z',
  entry_type: 'control',
  control_kind: 'clear',
  control_outcome: 'sent',
};

function row(over: Partial<TimelineRow> = {}): TimelineRow {
  return { ...(mapItem(WIRE, 'lan') as TimelineRow), ...over };
}

describe('① the local cache: a control-key row read back is still a control-key row', () => {
  it('🔴 normalizeCachedRow preserves control, the two structured fields come back together', () => {
    // Reverse control: change that ternary back to `r.entry_type === 'image' ?
    // 'image' : 'transcript'` ⇒ this case goes red on the spot. This is not
    // fussiness: the row is written into localStorage whole and read back,
    // and once rewritten it **gets written back again** — after one launch
    // the loss is permanent, and that row immediately gets a re-inject button.
    const back = normalizeCachedRow({ ...WIRE, channel: 'lan' });
    expect(back?.entry_type).toBe('control');
    expect(back?.control_kind).toBe('clear');
    expect(back?.control_outcome).toBe('sent');
  });

  it('the inbound frame preserves it too, and the isImage guess cannot override it', () => {
    // `isImage` is a guess the caller makes from the injection path; a
    // control-key row can never be produced by an image delivery, so it must
    // never be allowed to rewrite control into image.
    expect(mapItem(WIRE, 'lan', undefined, true)?.entry_type).toBe('control');
  });

  it('positive control: every other row is unchanged, not a single character', () => {
    const t = normalizeCachedRow({
      ...WIRE, entry_type: 'transcript', control_kind: undefined, control_outcome: undefined, channel: 'lan',
    });
    expect(t?.entry_type).toBe('transcript');
    expect(t?.control_kind).toBeNull();
    // ⚠️ Written as "drop both fields together" rather than "only change
    // entry_type", because the normalization layer **deliberately does not**
    // cross-check control_kind against entry_type: two fields that must
    // agree, if the normalization layer invents its own reconciliation rule,
    // become a second answer to "what is this row". The producer must either
    // write both together, or write neither. The first version of this case
    // did exactly that and went red on the spot — kept here, because it
    // proves that design, not a slip of the pen.
    const unknown = normalizeCachedRow({ ...WIRE, entry_type: 'audio', channel: 'lan' });
    expect(unknown?.entry_type, 'an unrecognized value still falls back to transcript').toBe('transcript');
  });
});

describe('② stats and export: a control-key row is not a portable record', () => {
  it('🔴 walkAssets excludes it entirely —— stats and export share this one producer', () => {
    // book 16 §4.2: FPR v1's entry_type only recognizes transcript/image ⇒
    // letting it out means it exports but can't import back (one-way loss);
    // and stats only has two buckets, so it would get counted into "transcript count".
    const assets = walkAssets([row(), row({ id: 'req:1', entry_type: 'transcript', output_text: '一句话' })], new Map());
    expect(assets).toHaveLength(1);
    expect(assets[0]!.row.entry_type).toBe('transcript');
    const inv = summarize(assets);
    expect(inv.count).toBe(1);
    expect(inv.transcripts).toBe(1);
  });

  it('the word count is 0, and the criterion is not "its text happens to be empty"', () => {
    // Written as `!== 'transcript'` rather than "an empty string counts as
    // 0": the day someone stores a face for a control-key row, the
    // empty-string-only test case would keep going green while the word
    // count quietly starts counting the control key in.
    expect(rowWordCount({ output_text: '清除清除', entry_type: 'control' })).toBe(0);
    expect(rowWordCount({ output_text: '清除清除', entry_type: 'transcript' })).toBe(4);
  });

  it('mode filtering should never pick it up in a single case —— its mode is a filler value', () => {
    const r = row();
    expect(matchesFilter(r, 'all')).toBe(true);
    expect(matchesFilter(r, 'realtime'), 'mode is a structural filler, not "something said in realtime"').toBe(false);
    expect(matchesFilter(r, 'image')).toBe(false);
  });
});

describe('③④ the capsule strip and batch copy: an empty string must never become an empty piece of content', () => {
  it('🔴 the capsule\'s "delivered-in record" does not accept control-key rows', () => {
    expect(toRecentLine(WIRE)).toBeNull();
    expect(toRecentLine({ ...WIRE, entry_type: 'transcript', output_text: '一句话' })).not.toBeNull();
  });

  it('🔴 batch copy skips it, and does not impersonate an image', () => {
    // Skipping is mandatory (otherwise an extra empty line lands in the
    // clipboard); not counting it into skippedImages is also mandatory ——
    // that number goes on to say a sentence about **images**.
    const plan = planBatchCopy([
      { id: 'ctl:1-0', entry_type: 'control', output_text: '', created_at: '2026-08-12T10:00:00.000Z' },
      { id: 'req:1', entry_type: 'transcript', output_text: '一句话', created_at: '2026-08-12T10:00:01.000Z' },
      { id: 'img:1', entry_type: 'image', output_text: '🖼 PNG', created_at: '2026-08-12T10:00:02.000Z' },
    ]);
    expect(plan.text).toBe('一句话');
    expect(plan.copied).toBe(1);
    expect(plan.skippedImages, 'a control-key row must never be counted as an image').toBe(1);
    expect(plan.selected).toBe(3);
  });

  it('when everything is control-key rows, no copy happens, and the message must not say it happened', () => {
    const plan = planBatchCopy([
      { id: 'ctl:1', entry_type: 'control', output_text: '', created_at: '2026-08-12T10:00:00.000Z' },
      { id: 'ctl:2', entry_type: 'control', output_text: '', created_at: '2026-08-12T10:00:01.000Z' },
    ]);
    expect(plan.text).toBe('');
    expect(plan.copied).toBe(0);
  });
});
