// Tests for book 16 §6.2 (clearing) and book 15 G-21 (a single-row delete must not
// delete bytes).
//
// The load-bearing ones are the "same delete path" pair: a single-row delete and a clear
// must have the SAME side effects on the same row, because before C2 they did not —
// eviction dropped the picture file and the user's delete left it on disk forever.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ROWS } from './timeline-retention';
import {
  CLEAR_WINDOWS,
  NO_CUTOFFS,
  advanceCutoffs,
  combinedCutoff,
  horizonOf,
  planClear,
  purge,
  readCutoffs,
  type Cutoffs,
  type PurgeSink,
} from './timeline-purge';
import { TimelineStore } from './timeline-store';
import type { ReportingKvStore, TimelineRow, TimelineTransport } from './types';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

function row(over: Partial<TimelineRow> & { id: string }): TimelineRow {
  return {
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    output_text: 'hello',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    entry_type: 'transcript',
    thumb_b64: null,
    full_image: false,
    target: null,
    mobile_id: null,
    mobile_label: null,
    channel: 'lan',
    ...over,
  } as TimelineRow;
}

function sinkOf(rows: TimelineRow[]): { sink: PurgeSink; dropped: string[][] } {
  const dropped: string[][] = [];
  const map = new Map(rows.map((r) => [`${r.channel}:${r.id}`, r]));
  return {
    dropped,
    sink: {
      rows: map,
      imageIds: new Set(rows.map((r) => r.id)),
      dropPictures: (ids) => dropped.push([...ids]),
      keyOf: (r) => `${r.channel}:${r.id}`,
    },
  };
}

describe('planClear — 二选 + 时间档 (owner 2026-08-01 §4-4)', () => {
  const rows = [
    row({ id: 'old-text', created_at: '2026-01-01T00:00:00.000Z' }),
    row({ id: 'new-text', created_at: '2026-08-02T00:00:00.000Z' }),
    row({ id: 'old-pic', created_at: '2026-01-01T00:00:00.000Z', entry_type: 'image', full_image: true }),
    row({ id: 'new-pic', created_at: '2026-08-02T00:00:00.000Z', entry_type: 'image', full_image: true }),
  ];

  it('「清图片 · 一月以前」 takes only old pictures — the other three are untouched', () => {
    const doomed = planClear(rows, 'images', horizonOf('month', NOW));
    expect(doomed.map((r) => r.id)).toEqual(['old-pic']);
  });

  it('「清文字 · 一月以前」 takes only old transcripts — the mirror of the above', () => {
    const doomed = planClear(rows, 'text', horizonOf('month', NOW));
    expect(doomed.map((r) => r.id)).toEqual(['old-text']);
  });

  it('「全部」 has no lower bound and takes everything of that kind, however recent', () => {
    expect(planClear(rows, 'both', horizonOf('all', NOW))).toHaveLength(4);
    expect(planClear(rows, 'images', horizonOf('all', NOW)).map((r) => r.id)).toEqual(['old-pic', 'new-pic']);
  });

  it('a row with no usable created_at is NOT swept up by a time-bounded clear', () => {
    // '' sorts below every real instant, so a naive `<` would delete a row of
    // genuinely unknown age under "older than a year". It only goes under "all", which
    // makes no claim about age.
    const junk = [row({ id: 'junk', created_at: '' })];
    expect(planClear(junk, 'both', horizonOf('year', NOW))).toHaveLength(0);
    expect(planClear(junk, 'both', horizonOf('all', NOW))).toHaveLength(1);
  });

  it('every bucket except 「全部」 yields a horizon, and they get older in order', () => {
    const marks = CLEAR_WINDOWS.filter((w) => w !== 'all').map((w) => horizonOf(w, NOW));
    expect(marks.every((m) => m !== null)).toBe(true);
    expect([...marks].sort().reverse()).toEqual(marks); // week newest … year oldest
    expect(horizonOf('all', NOW)).toBeNull();
  });
});

describe('purge — 删一行 = 删掉这一行的全部字节 (16 册 §6.2-2)', () => {
  it('removes the row, its picture FILE and its image chip, in one call', () => {
    const pic = row({ id: 'p1', entry_type: 'image', full_image: true });
    const { sink, dropped } = sinkOf([pic, row({ id: 't1' })]);
    const out = purge(sink, [pic], null, NO_CUTOFFS);
    expect(out.removed).toBe(1);
    expect(out.picturesDropped).toBe(1);
    expect(sink.rows.has('lan:p1')).toBe(false);
    expect(dropped).toEqual([['p1']]); // ← the half G-21 was missing
    expect(sink.imageIds.has('p1')).toBe(false);
    expect(sink.rows.has('lan:t1')).toBe(true); // positive control: the other row survived
  });

  it('a picture row that never kept its bytes asks the filesystem for nothing', () => {
    // §9b-6: imageCount ≠ imageFileCount is real history, and a deletion must not
    // claim to free bytes that are not there.
    const pic = row({ id: 'p2', entry_type: 'image', full_image: false });
    const { sink, dropped } = sinkOf([pic]);
    expect(purge(sink, [pic], null, NO_CUTOFFS).picturesDropped).toBe(0);
    expect(dropped).toEqual([]);
  });

  it('a row named twice, or already gone, counts once and drops once', () => {
    const pic = row({ id: 'p3', entry_type: 'image', full_image: true });
    const { sink, dropped } = sinkOf([pic]);
    const out = purge(sink, [pic, pic], null, NO_CUTOFFS);
    expect(out.removed).toBe(1);
    expect(dropped).toEqual([['p3']]);
  });
});

describe('cutoffs — 清掉 ≠ 从未有过, without over-claiming (16 册 §6.2-3)', () => {
  const t = row({ id: 't', created_at: '2026-03-01T00:00:00.000Z' });
  const p = row({ id: 'p', created_at: '2026-04-01T00:00:00.000Z', entry_type: 'image' });

  it('a single-row delete moves NO mark —「我删了这条」≠「早于它的都没了」', () => {
    expect(advanceCutoffs(NO_CUTOFFS, [t], null)).toEqual(NO_CUTOFFS);
  });

  it('clearing only pictures does not let the page claim transcripts are gone too', () => {
    const after = advanceCutoffs(NO_CUTOFFS, [p], 'images');
    expect(after.images).toBe(p.created_at);
    expect(after.text).toBeNull();
    // 🔴 THE ASSERTION THIS WHOLE SHAPE EXISTS FOR: one scalar cutoff would now read
    // "everything before April has been cleared" while every transcript from March is
    // still on screen.
    expect(combinedCutoff(after)).toBeNull();
  });

  it('a kind-blind deletion earns BOTH marks even when it only caught transcripts', () => {
    // Capacity eviction drops oldest-first regardless of kind, so everything older
    // than its newest casualty really is gone — of every kind.
    const after = advanceCutoffs(NO_CUTOFFS, [t], 'both');
    expect(after).toEqual({ text: t.created_at, images: t.created_at });
    expect(combinedCutoff(after)).toBe(t.created_at);
  });

  it('marks only ever move forward', () => {
    const start: Cutoffs = { text: '2026-05-01T00:00:00.000Z', images: '2026-05-01T00:00:00.000Z' };
    expect(advanceCutoffs(start, [t], 'both')).toEqual(start);
  });

  it('reads the pre-C2 single {cutoff} as BOTH marks — it was written by kind-blind eviction', () => {
    expect(readCutoffs({ cutoff: '2026-01-05T08:30:00.000Z' })).toEqual({
      text: '2026-01-05T08:30:00.000Z',
      images: '2026-01-05T08:30:00.000Z',
    });
    expect(readCutoffs({ text: 'a', images: null })).toEqual({ text: 'a', images: null });
    expect(readCutoffs(null)).toEqual(NO_CUTOFFS);
    expect(readCutoffs({ cutoff: '' })).toEqual(NO_CUTOFFS);
  });
});

// ── The store's three triggers, through the ONE deleter ─────────────────────

class RecordingTransport implements TimelineTransport {
  pictures: string[] = [];
  dropRowImages(ids: readonly string[]): void {
    this.pictures.push(...ids);
  }
  reInjectLocally = vi.fn(async () => null);
  rowImage = vi.fn(async () => null);
}

function kvStore(): ReportingKvStore {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => {
      m.set(k, v);
      return true;
    },
  };
}

describe('TimelineStore — 三个触发器一条删除路径 (16 册 §6.2-1)', () => {
  let transport: RecordingTransport;
  let kv: ReportingKvStore;

  beforeEach(() => {
    transport = new RecordingTransport();
    kv = kvStore();
  });

  function seeded(rows: TimelineRow[]): TimelineStore {
    kv.set('flowmic.history.cache', JSON.stringify(rows));
    return new TimelineStore(transport, kv, () => NOW);
  }

  it('🔴 G-21 — 用户删单行 now drops the picture file, exactly like 自动裁剪 does', () => {
    const pic = row({ id: 'p1', entry_type: 'image', full_image: true });
    const store = seeded([pic]);
    expect(transport.pictures).toEqual([]); // positive control: nothing dropped at boot
    expect(store.remove('p1', 'lan')).toBe(true);
    expect(transport.pictures).toEqual(['p1']);
  });

  it('the two triggers have the SAME side effects on the same row', () => {
    const pic = row({ id: 'same', entry_type: 'image', full_image: true });
    const byDelete = new RecordingTransport();
    const kvA = kvStore();
    kvA.set('flowmic.history.cache', JSON.stringify([pic]));
    new TimelineStore(byDelete, kvA, () => NOW).remove('same', 'lan');

    const byClear = new RecordingTransport();
    const kvB = kvStore();
    kvB.set('flowmic.history.cache', JSON.stringify([pic]));
    new TimelineStore(byClear, kvB, () => NOW).clear('images', 'all');

    expect(byClear.pictures).toEqual(byDelete.pictures);
    expect(JSON.parse(kvB.get('flowmic.history.cache') ?? 'x')).toEqual(
      JSON.parse(kvA.get('flowmic.history.cache') ?? 'y'),
    );
  });

  it('清空 removes exactly what previewClear promised — one selector, two callers', () => {
    const rows = [
      row({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'b', created_at: '2026-08-01T00:00:00.000Z' }),
      row({ id: 'c', created_at: '2026-01-02T00:00:00.000Z', entry_type: 'image', full_image: true }),
    ];
    const store = seeded(rows);
    const preview = store.previewClear('text', 'month');
    expect(preview.map((r) => r.id)).toEqual(['a']);
    expect(store.clear('text', 'month').removed).toBe(preview.length);
    expect(store.allRows().map((r) => r.id).sort()).toEqual(['b', 'c']);
    // The picture was NOT touched by a text clear — the two-way choice (text/images)
    // can be exercised independently.
    expect(transport.pictures).toEqual([]);
  });

  it('a clear that matches nothing removes nothing, persists nothing, moves no mark', () => {
    const store = seeded([row({ id: 'recent', created_at: '2026-08-02T00:00:00.000Z' })]);
    const before = kv.get('flowmic.history.cache');
    expect(store.clear('text', 'year').removed).toBe(0);
    expect(store.retention.cutoffs).toEqual(NO_CUTOFFS);
    expect(kv.get('flowmic.history.cache')).toBe(before);
  });

  it('🔴 the cleared range survives a restart —「清掉了」must not become「本来就没有」', () => {
    const store = seeded([
      row({ id: 'gone', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'kept', created_at: '2026-08-01T00:00:00.000Z' }),
    ]);
    store.clear('both', 'month');
    const mark = store.retention.cutoff;
    expect(mark).toBe('2026-01-01T00:00:00.000Z');

    const reborn = new TimelineStore(new RecordingTransport(), kv, () => NOW);
    expect(reborn.retention.cutoff).toBe(mark);
    expect(reborn.retention.kept).toBe(1);
  });

  it('clearing only pictures leaves the combined sentence unsaid, and says the picture one', () => {
    const store = seeded([
      row({ id: 't', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'p', created_at: '2026-01-02T00:00:00.000Z', entry_type: 'image', full_image: true }),
    ]);
    store.clear('images', 'month');
    expect(store.retention.cutoff).toBeNull(); // never claim the transcripts went too
    expect(store.retention.cutoffs.images).toBe('2026-01-02T00:00:00.000Z');
    expect(store.retention.cutoffs.text).toBeNull();
  });

  it('自动裁剪 still drops pictures — the trigger moved, the behaviour did not (RV-93)', () => {
    const many: TimelineRow[] = [];
    for (let i = 0; i <= MAX_ROWS; i++) {
      const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 60_000).toISOString();
      many.push(row({ id: `r${i}`, created_at: at, entry_type: 'image', full_image: true }));
    }
    seeded(many);
    expect(transport.pictures).toEqual(['r0']);
  });
});
