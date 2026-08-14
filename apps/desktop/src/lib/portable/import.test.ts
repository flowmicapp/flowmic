// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §9 test coverage table:
//   §5.2 per-line outcome —— one case per each of the four outcomes; a refusal must be named; the wording of a partial-success report must be asserted
//   §5.3 same-end admission —— a cross-end file is refused by name (positive control: a same-end file imports normally)
//   §5.4 unknown fields —— build a line carrying a future field ⇒ import → export → that field is still there verbatim
//   §4.1 count —— a file whose count does not match the actual row count ⇒ named refusal

import { describe, expect, it } from 'vitest';
import { TimelineStore } from '../timeline-store';
import type { InjectResult, ReportingKvStore, TimelineTransport } from '../types';
import { planExport } from './export';
import { applyImport, isPartial } from './import';
import { PreservedFields } from './preserved';

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

function head(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fpr: 1,
    kind: 'header',
    exported_at: '2026-08-01T09:12:33.000Z',
    source: { app: 'flowmic', end: 'desktop', version: '0.2.36', device: '开发机' },
    count: 1,
    has_attachments: false,
    scope: { kind: 'all' },
    ...over,
  });
}

function entry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fpr: 1,
    kind: 'entry',
    id: 'req:e1',
    created_at: '2026-08-01T08:00:00.000Z',
    entry_type: 'transcript',
    mode: 'realtime',
    source_text: '原文',
    output_text: '结果',
    status: 'injected',
    duration_ms: null,
    window_title: null,
    attachment: null,
    source_ext: { channel: 'lan', updated_at: '2026-08-01T08:00:00.000Z', edited: false },
    ...over,
  });
}

function fresh() {
  const kv = new MemStore();
  return { kv, store: new TimelineStore(new Transport(), kv), preserved: new PreservedFields(kv) };
}

function run(lines: string[], att: string[] = []) {
  const f = fresh();
  const report = applyImport({
    lines,
    archiveAttachments: new Set(att),
    target: f.store,
    preserved: f.preserved,
  });
  return { ...f, report };
}

describe('§5.2 四种结局，每一种都计数', () => {
  it('新增', () => {
    const { report, store } = run([head(), entry()]);
    expect(report.added).toBe(1);
    expect(store.hasRow('lan', 'req:e1')).toBe(true);
    expect(isPartial(report)).toBe(false); // when everything succeeds, the report's wording must not say "partial"
  });

  it('已存在跳过', () => {
    const f = fresh();
    applyImport({ lines: [head(), entry()], archiveAttachments: new Set(), target: f.store, preserved: f.preserved });
    const again = applyImport({ lines: [head(), entry()], archiveAttachments: new Set(), target: f.store, preserved: f.preserved });
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it('拒收 —— 原因具名，而且是不同的名字（不是一个笼统的「格式错误」）', () => {
    const bad = [
      entry({ mode: 'summarise' }),          // never a fourth mode
      entry({ id: 'req:e2', status: 'sent' }),
      entry({ id: 'req:e3', created_at: '昨天下午' }),
      entry({ id: 'req:e4', entry_type: 'audio' }),
      entry({ id: 'req:e5', source_ext: { updated_at: 'x' } }), // channel not stated
      '{ this is not json',
      entry({ id: 'req:e7', fpr: 99 }),
      entry({ id: 'req:e8', kind: 'note' }),
      entry({ id: '' }),
    ];
    const { report } = run([head({ count: bad.length }), ...bad]);
    expect(report.added).toBe(0);
    expect(report.refused.map((r) => r.reason)).toEqual([
      'bad_mode',
      'bad_status',
      'bad_created_at',
      'bad_entry_type',
      'no_channel',
      'not_json',
      'unsupported_version',
      'unknown_kind',
      'no_id',
    ]);
    // The line number is usable: the user can go look at that line in the file (line 1 is the file header).
    expect(report.refused[0]!.line).toBe(2);
    expect(isPartial(report)).toBe(true);
  });

  it('附件缺失 —— 行照常导入，并且明说图片不在这份文件里', () => {
    const { report, store } = run(
      [head({ has_attachments: true }), entry({ entry_type: 'image', attachment: 'att/deadbeefdeadbeef.png' })],
      [], // that member is not in the archive
    );
    expect(report.added).toBe(1);
    expect(store.hasRow('lan', 'req:e1')).toBe(true); // the row imports as usual
    expect(report.attachmentMissing).toBe(1);
    expect(report.picturesNotInFile).toBe(0); // this is not the "pictures weren't exported in the first place" case
    expect(isPartial(report)).toBe(true);
  });

  it('「当初就没导图片」与「图片丢了」是两个不同的计数', () => {
    // 🔴 §5.2:「用户勾了不含图片时这是预期，不是错误——报告用词要分得出这两种」("when the user ticked 'no pictures' this is expected, not an error — the report's wording must distinguish the two")
    const { report } = run([
      head({ has_attachments: false }),
      entry({ entry_type: 'image', attachment: null }),
    ]);
    expect(report.picturesNotInFile).toBe(1);
    expect(report.attachmentMissing).toBe(0);
  });

  it('附件真在归档里 ⇒ 排进待恢复清单（上面两条的正向对照）', () => {
    const name = 'att/deadbeefdeadbeef.png';
    const { report } = run(
      [head({ has_attachments: true }), entry({ entry_type: 'image', attachment: name })],
      [name],
    );
    expect(report.attachmentMissing).toBe(0);
    expect(report.restore).toEqual([{ name, row_id: 'req:e1' }]);
  });
});

describe('§5.3 只接受同端导出的文件', () => {
  it('手机导的被具名拒收，一行都不进', () => {
    const { report, store } = run([
      head({ source: { app: 'flowmic', end: 'mobile', version: '0.2.36' } }),
      entry(),
    ]);
    expect(report.fileRefusal).toEqual({ kind: 'wrong_end', end: 'mobile' });
    expect(report.added).toBe(0);
    expect(store.allRows()).toHaveLength(0);
  });

  it('电脑导的正常导入（上一条的正向对照）', () => {
    const { report } = run([head(), entry()]);
    expect(report.fileRefusal).toBeNull();
    expect(report.added).toBe(1);
  });

  it('不认识的格式版本被具名拒收，且带上它自称的版本号', () => {
    const { report } = run([head({ fpr: 7 }), entry()]);
    expect(report.fileRefusal).toEqual({ kind: 'unsupported_version', found: 7 });
  });

  it('根本没有文件头', () => {
    expect(run(['{"just":"an object"}']).report.fileRefusal).toEqual({ kind: 'no_header' });
    expect(run([]).report.fileRefusal).toEqual({ kind: 'no_header' });
  });
});

describe('§4.1 count 与实际行数', () => {
  it('对不上就整份拒收，并说出两个数字', () => {
    const { report, store } = run([head({ count: 5 }), entry()]);
    expect(report.fileRefusal).toEqual({ kind: 'count_mismatch', declared: 5, found: 1 });
    // 「不等 = 导出撒谎」("a mismatch = the export is lying") ⇒ not a single line gets written in.
    expect(store.allRows()).toHaveLength(0);
  });

  it('对得上就导（正向对照）', () => {
    expect(run([head({ count: 1 }), entry()]).report.added).toBe(1);
  });
});

describe('§5.4 未知字段原样保留', () => {
  it('导入 → 导出，未来版本的顶层字段与 source_ext 键都原样还在', () => {
    const f = fresh();
    const future = entry({
      lucky_number: 42,                                  // unknown top-level key
      source_ext: {
        channel: 'lan',
        updated_at: '2026-08-01T08:00:00.000Z',
        edited: false,
        inject_target: { window_title: '记事本', process_name: 'notepad.exe' },
        some_future_ext: { deep: ['a', 1] },
      },
    });
    const r = applyImport({
      lines: [head(), future],
      archiveAttachments: new Set(),
      target: f.store,
      preserved: f.preserved,
    });
    expect(r.added).toBe(1);
    expect(r.preserveFailed).toBe(false);

    // Key point: use a **new** PreservedFields (read back from the same kv) to prove it really was persisted.
    const plan = planExport({
      rows: f.store.allRows(),
      pictures: new Map(),
      includePictures: true,
      version: '0.2.36',
      device: null,
      now: new Date('2026-08-02T00:00:00.000Z'),
      truncatedBefore: null,
      preserved: new PreservedFields(f.kv),
      readme: () => 'readme',
    });
    const out = JSON.parse(plan.lines[1]!);
    expect(out.lucky_number).toBe(42);
    expect(out.source_ext.some_future_ext).toEqual({ deep: ['a', 1] });
    // `inject_target` is a field this machine's row has no room for (see fpr.ts rowToEntry) — it comes back too.
    expect(out.source_ext.inject_target).toEqual({ window_title: '记事本', process_name: 'notepad.exe' });
    // …while fields this machine can answer on its own use the live row's value, not the file's old one.
    expect(out.source_ext.channel).toBe('lan');
    expect(out.id).toBe('req:e1');
  });

  it('存不下额外字段时报告说出来，不装作存下了', () => {
    const f = fresh();
    f.kv.refuse = true;
    const r = applyImport({
      lines: [head(), entry({ future_key: 1 })],
      archiveAttachments: new Set(),
      target: f.store,
      preserved: f.preserved,
    });
    expect(r.preserveFailed).toBe(true);
    expect(isPartial(r)).toBe(true);
  });
});
