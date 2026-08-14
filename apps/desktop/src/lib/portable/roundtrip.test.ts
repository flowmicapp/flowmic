// 🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §9's first line:
//   「round-trip: 导出 N 条 → 清空 → 导入 → N 条一字不差（逐字段比对，不是只比条数）;
//     同一份文件再导一次 ⇒ 仍是 N 条」
//   ("round-trip: export N rows → clear → import → N rows match exactly, letter for letter
//     (field-by-field comparison, not just a count comparison); re-importing the same file
//     ⇒ still N rows")
//
// This runs against the real TimelineStore (not a stand-in): export reads its allRows, import writes through its
// onHistoryUpdated. The container in between (the zip) is asserted byte-for-byte to restore the lines by the Rust-side
// `an_export_round_trips_through_the_archive` in portable::archive — each half is asserted once at the same
// seam; this deliberately does not pretend one test runs the whole chain.

import { describe, expect, it } from 'vitest';
import { TimelineStore } from '../timeline-store';
import type {
  ChannelTag,
  InjectResult,
  ReportingKvStore,
  TimelineRow,
  TimelineTransport,
  WireHistoryItem,
} from '../types';
import { planExport } from './export';
import { applyImport } from './import';
import { PreservedFields } from './preserved';
import type { PictureFact } from './inventory';

class Transport implements TimelineTransport {
  async reInjectLocally(): Promise<InjectResult | null> {
    return null;
  }
  async rowImage(): Promise<string | null> {
    return null;
  }
  dropRowImages(): void {}
}

class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  refuse = false;
  get(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): boolean {
    if (this.refuse) return false;
    this.m.set(k, v);
    return true;
  }
}

function item(n: number, over: Partial<WireHistoryItem> = {}): WireHistoryItem {
  const two = String(n).padStart(2, '0');
  return {
    id: `req:r${two}`,
    mode: n % 3 === 0 ? 'organize' : n % 3 === 1 ? 'realtime' : 'translate',
    status: n % 2 === 0 ? 'injected' : 'cached',
    edited: n === 4,
    source_text: n % 2 === 0 ? `原文-${two}` : null,
    output_text: `结果-${two} 🎧`,
    created_at: `2026-07-${20 + (n % 9)}T10:${two}:00.000Z`,
    updated_at: `2026-07-${20 + (n % 9)}T10:${two}:30.000Z`,
    entry_type: n === 5 ? 'image' : 'transcript',
    ...(n === 5 ? { thumb_b64: 'QUJD', full_image: true } : {}),
    ...(n === 2 ? { device_label: '客厅的手机' } : {}),
    ...over,
  };
}

function fill(store: TimelineStore, n: number): void {
  for (let i = 1; i <= n; i++) {
    const ch: ChannelTag = i % 4 === 0 ? 'cloud' : 'lan';
    store.onHistoryUpdated(item(i), ch);
  }
}

const PICTURES = new Map<string, PictureFact>([['req:r05', { bytes: 4096, ext: 'png' }]]);

function exportFrom(store: TimelineStore, kv: ReportingKvStore, includePictures = true) {
  return planExport({
    rows: store.allRows(),
    pictures: PICTURES,
    digests: new Map([['req:r05', 'aabbccddeeff0011']]),
    includePictures,
    version: '9.9.9',
    device: '开发机',
    now: new Date('2026-08-01T09:12:33.000Z'),
    truncatedBefore: null,
    preserved: new PreservedFields(kv),
    readme: () => 'readme',
  });
}

describe('FPR v1 round trip (16 册 §9)', () => {
  it('导出 N 条 → 清空 → 导入 → N 条一字不差（逐字段比对）', () => {
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 8);
    const before = source.allRows().sort(byId);
    expect(before).toHaveLength(8);

    const plan = exportFrom(source, kvA);
    // §4.1 count == the actual row count.
    expect(plan.header.count).toBe(8);
    expect(plan.lines).toHaveLength(9);

    // 「清空」("clear") = a brand-new machine with nothing on it.
    const kvB = new MemStore();
    const target = new TimelineStore(new Transport(), kvB);
    expect(target.allRows()).toHaveLength(0);

    const report = applyImport({
      lines: plan.lines,
      archiveAttachments: new Set(plan.attachments.map((a) => a.name)),
      target,
      preserved: new PreservedFields(kvB),
    });
    expect(report.fileRefusal).toBeNull();
    expect(report.refused).toEqual([]);
    expect(report.added).toBe(8);

    const after = target.allRows().sort(byId);
    expect(after).toHaveLength(8);
    // 🔴 Field-by-field, not just a count comparison. `target` is the one field this end cannot take back
    // in (see the delivery report + fpr.ts `rowToEntry`), and it is null on every
    // row here because nothing in this test ever injected.
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toEqual(before[i]);
    }
  });

  it('同一份文件再导一次 ⇒ 仍是 N 条（§5.1 幂等）', () => {
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 8);
    const plan = exportFrom(source, kvA);

    const kvB = new MemStore();
    const target = new TimelineStore(new Transport(), kvB);
    const once = applyImport({
      lines: plan.lines,
      archiveAttachments: new Set(),
      target,
      preserved: new PreservedFields(kvB),
    });
    const snapshot = target.allRows().sort(byId);

    const twice = applyImport({
      lines: plan.lines,
      archiveAttachments: new Set(),
      target,
      preserved: new PreservedFields(kvB),
    });
    expect(once.added).toBe(8);
    expect(twice.added).toBe(0);
    // N rows already existed (not re-imported) — counted, never silently skipped.
    expect(twice.skipped).toBe(8);
    expect(target.allRows().sort(byId)).toEqual(snapshot);
  });

  it('两条通道上同一个 id 是两行，导入后仍然是两行（RV-01）', () => {
    // If the address collapsed to the bare id, one of these would「已存在跳过」("already exists, skipped") and
    // the other machine's row would silently never arrive.
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    source.onHistoryUpdated(item(1), 'lan');
    source.onHistoryUpdated({ ...item(1), output_text: '云端那一条' }, 'cloud');
    const plan = exportFrom(source, kvA);
    expect(plan.header.count).toBe(2);

    const kvB = new MemStore();
    const target = new TimelineStore(new Transport(), kvB);
    const r = applyImport({
      lines: plan.lines,
      archiveAttachments: new Set(),
      target,
      preserved: new PreservedFields(kvB),
    });
    expect(r.added).toBe(2);
    expect(target.hasRow('lan', 'req:r01')).toBe(true);
    expect(target.hasRow('cloud', 'req:r01')).toBe(true);
    expect(target.allRows().find((x) => x.channel === 'cloud')?.output_text).toBe('云端那一条');
  });

  it('§8-3 去掉勾选：无 att/、has_attachments:false、图片行仍在且 attachment:null', () => {
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 6); // row 5 is the picture row
    const withPics = exportFrom(source, kvA, true);
    const without = exportFrom(source, kvA, false);

    expect(withPics.header.has_attachments).toBe(true);
    expect(withPics.attachments).toEqual([
      { row_id: 'req:r05', name: 'att/aabbccddeeff0011.png' },
    ]);
    // 🔴 The positive control is right in the two lines above: 「不含图片」("no pictures included") being true
    // must be because the tick was removed, not because there are no pictures in this store to begin with.
    expect(without.header.has_attachments).toBe(false);
    expect(without.attachments).toEqual([]);

    const pic = without.lines.map((l) => JSON.parse(l)).find((o) => o.id === 'req:r05');
    // The row itself is exported as usual —— the text, timestamp, and status are all still there.
    expect(pic.entry_type).toBe('image');
    expect(pic.attachment).toBeNull();
    expect(pic.output_text).toBe('结果-05 🎧');
    expect(pic.status).toBeDefined();
    // 🔴 2026-08-11: no att/ ≠ the timeline has no picture —— thumb_b64 is still in the jsonl, and the UI will paint it after import.
    // 「只恢复了文字」("only the text was restored") is therefore a lie; the contract is pinned here, wording is in strings/portable.ts pd_r_no_pictures.
    expect(pic.source_ext?.thumb_b64).toBe('QUJD');
    // …while it has a name in the version that includes pictures.
    const pic2 = withPics.lines.map((l) => JSON.parse(l)).find((o) => o.id === 'req:r05');
    expect(pic2.attachment).toBe('att/aabbccddeeff0011.png');
  });

  it('§5.2 不含完整图：导入后 thumb 仍在行上，且计数走 picturesNotInFile', () => {
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 6);
    const without = exportFrom(source, kvA, false);
    const destKv = new MemStore();
    const dest = new TimelineStore(new Transport(), destKv);
    const report = applyImport({
      lines: without.lines,
      archiveAttachments: new Set(),
      target: dest,
      preserved: new PreservedFields(destKv),
    });
    expect(report.picturesNotInFile).toBe(1);
    expect(report.attachmentMissing).toBe(0);
    const landed = dest.allRows().find((r) => r.id === 'req:r05');
    expect(landed?.entry_type).toBe('image');
    expect(landed?.thumb_b64).toBe('QUJD');
  });

  it('§6 盘点层的条数与导出产物对得上', () => {
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 7);
    const plan = exportFrom(source, kvA);
    // 「统计说 N 条，导出出来是不是恰好 N 条？」("statistics says N rows — does the export produce exactly N rows?") (the acceptance question posed by the overarching design §5-2)
    expect(plan.inventory.count).toBe(plan.header.count);
    expect(plan.inventory.count).toBe(plan.lines.length - 1);
    expect(plan.inventory.images).toBe(1);
    expect(plan.inventory.withPicture).toBe(1);
    expect(plan.inventory.pictureBytes).toBe(4096);
    expect(plan.inventory.earliest! <= plan.inventory.latest!).toBe(true);
  });

  it('导出读的是全部行，不是搜索框筛剩下的那些', () => {
    // 🔴 The mechanical face of 「导出不许只导一半」("export must not export only half"): allRows vs entries.
    const kvA = new MemStore();
    const source = new TimelineStore(new Transport(), kvA);
    fill(source, 6);
    source.search('结果-01');
    expect(source.entries()).toHaveLength(1); // positive control: the filter really did take effect
    expect(exportFrom(source, kvA).header.count).toBe(6);
  });
});

function byId(a: TimelineRow, b: TimelineRow): number {
  return `${a.channel}:${a.id}` < `${b.channel}:${b.id}` ? -1 : 1;
}
