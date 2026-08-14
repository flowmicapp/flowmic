// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §4.1 (header) / §4.2 (record line) /
// §8 (streaming + the estimated size must be genuinely computed).

import { describe, expect, it } from 'vitest';
import type { ReportingKvStore, TimelineRow } from '../types';
import { PLACEHOLDER_SHA, archiveBytes, planExport, suggestedFileName } from './export';
import { PreservedFields } from './preserved';
import { utf8Bytes, type PictureFact } from './inventory';

class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  get(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): boolean {
    this.m.set(k, v);
    return true;
  }
}

function row(over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'req:1',
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: '原文',
    output_text: '结果',
    created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:30.000Z',
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

function plan(rows: TimelineRow[], over: Partial<Parameters<typeof planExport>[0]> = {}) {
  return planExport({
    rows,
    pictures: new Map(),
    includePictures: true,
    version: '0.2.36',
    device: '开发机',
    now: new Date('2026-08-01T09:12:33.000Z'),
    truncatedBefore: null,
    preserved: new PreservedFields(new MemStore()),
    readme: () => 'README',
    ...over,
  });
}

describe('§4.1 头', () => {
  it('exported_at 是带 Z 的 ISO；version 来自传入的真值；count = 实际行数', () => {
    const p = plan([row(), row({ id: 'req:2' })]);
    expect(p.header.fpr).toBe(1);
    expect(p.header.kind).toBe('header');
    expect(p.header.exported_at).toBe('2026-08-01T09:12:33.000Z');
    expect(p.header.source).toEqual({ app: 'flowmic', end: 'desktop', version: '0.2.36', device: '开发机' });
    expect(p.header.count).toBe(2);
    expect(p.lines.length - 1).toBe(p.header.count);
  });

  it('读不到本机名字时 device 写显式 null —— 既不省略，也不写占位名', () => {
    // §4.1 (added 2026-08-01 before the merge): omitting it would let the reader think an older version simply didn't write it.
    const p = plan([row()], { device: null });
    expect('device' in p.header.source).toBe(true);
    expect(p.header.source.device).toBeNull();
    // An empty string is likewise "could not be read" — it must not be written out as a device name.
    expect(plan([row()], { device: '' }).header.source.device).toBeNull();
    // Positive control: when there really is a name, it is that name.
    expect(plan([row()]).header.source.device).toBe('开发机');
  });

  it('truncated_before 只在真的裁过时才写（§4.1「不知道就不写」）', () => {
    const none = plan([row()]);
    expect('truncated_before' in none.header.scope).toBe(false);
    expect(none.header.scope).toEqual({ kind: 'all' });
    // Positive control: when there really is a cutoff it appears, and is exactly the instant the store remembers.
    const cut = plan([row()], { truncatedBefore: '2026-06-01T00:00:00.000Z' });
    expect(cut.header.scope).toEqual({ kind: 'all', truncated_before: '2026-06-01T00:00:00.000Z' });
  });
});

describe('§4.2 记录行', () => {
  const pics = new Map<string, PictureFact>([['req:img', { bytes: 2048, ext: 'webp' }]]);

  it('duration_ms：行有真值写真值（0.2.43 投递帧带来的），没有仍是显式 null——绝不端内编造', () => {
    // Doc 16 §4.2 revision (owner: 「语音时长要找回来」("the speaking duration needs to be recovered")): the field's obligation went from "always null" to
    // "carry the row's own value through verbatim." Both directions are asserted: carry a real value through / a missing one is still null, never omitted or 0.
    const withDur = JSON.parse(plan([row({ duration_ms: 9490 } as Parameters<typeof row>[0])]).lines[1]!);
    expect(withDur.duration_ms).toBe(9490);
    const without = JSON.parse(plan([row()]).lines[1]!);
    expect('duration_ms' in without).toBe(true);
    expect(without.duration_ms).toBeNull();
  });

  it('§4.2 window_title：顶层恒 null 的声明槽，真值进 source_ext.inject_target', () => {
    const target = { window_title: '未命名 - 记事本', process_name: 'notepad.exe' };
    const e = JSON.parse(plan([row({ target })]).lines[1]!);
    // ① The top level is a declaration slot: the field is present, always null — only one meaning across ends.
    expect('window_title' in e).toBe(true);
    expect(e.window_title).toBeNull();
    // ② The real value lives in the end-specific pocket, with the same key name on both ends: inject_target (must not be called target).
    expect(e.source_ext.inject_target).toEqual(target);
    expect('target' in e.source_ext).toBe(false);
    // ③ Not dropped wholesale over privacy worries — positive control: it really is written out.
    expect(e.source_ext.inject_target.window_title).toBe('未命名 - 记事本');
  });

  it('没有投递目标的行写显式 inject_target:null —— 键在，不省略，也不是空对象', () => {
    // 🔴 Same criterion as the top-level window_title (§4.2): null says「这个键存在，而这一行
    // 没有它」("this key exists, and this row does not have it"); `{}` would claim there is a target whose fields are just empty (a lie); omitting the key entirely would let the reader
    // think an older version simply didn't write it. Of the three options, only null commits neither sin.
    const e = JSON.parse(plan([row({ target: null })]).lines[1]!);
    expect('inject_target' in e.source_ext).toBe(true);
    expect(e.source_ext.inject_target).toBeNull();
    expect(e.window_title).toBeNull();
    // Positive control: when there is a target, that same key holds the real value, so null does not mean "this key never has a value."
    const withTarget = JSON.parse(
      plan([row({ target: { window_title: 'w', process_name: 'p.exe' } })]).lines[1]!,
    );
    expect(withTarget.source_ext.inject_target).toEqual({ window_title: 'w', process_name: 'p.exe' });
  });

  it('导入来的 inject_target 不会被本机的「没有目标」写成 null 抹掉（§5.4）', () => {
    // This machine's row has no room for inject_target, so "the live row has none" is the norm; if null were written unconditionally,
    // a second round trip would destroy the delivery target genuinely recorded in the file.
    const preserved = new PreservedFields(new MemStore());
    preserved.remember('lan:req:1', {
      top: {},
      ext: { inject_target: { window_title: '记事本', process_name: 'notepad.exe' } },
    });
    const e = JSON.parse(plan([row({ target: null })], { preserved }).lines[1]!);
    expect(e.source_ext.inject_target).toEqual({ window_title: '记事本', process_name: 'notepad.exe' });
  });

  it('端专属字段进 source_ext，不平铺进顶层', () => {
    const e = JSON.parse(plan([row({
      channel: 'cloud', edited: true, device_label: '客厅', mobile_id: 'm1',
      target: { window_title: 'w', process_name: 'p.exe' },
    })]).lines[1]!);
    for (const k of ['channel', 'edited', 'device_label', 'mobile_id', 'thumb_b64', 'full_image', 'updated_at', 'inject_target']) {
      expect(k in e, `${k} must not be at the top level`).toBe(false);
      expect(k in e.source_ext, `${k} belongs in source_ext`).toBe(true);
    }
    expect(e.source_ext.channel).toBe('cloud');
  });

  it('核心字段就是 §4.2 那张表，一个不多一个不少', () => {
    const e = JSON.parse(plan([row()]).lines[1]!);
    expect(Object.keys(e).sort()).toEqual([
      'attachment', 'created_at', 'duration_ms', 'entry_type', 'fpr', 'id', 'kind',
      'mode', 'output_text', 'source_ext', 'source_text', 'status', 'window_title',
    ]);
  });

  it('每一行都带 fpr（切片下来也要自解释）', () => {
    const p = plan([row(), row({ id: 'req:2' })]);
    for (const l of p.lines) expect(JSON.parse(l).fpr).toBe(1);
  });

  it('行按时间升序写出', () => {
    const p = plan([
      row({ id: 'req:new', created_at: '2026-08-02T00:00:00.000Z' }),
      row({ id: 'req:old', created_at: '2026-07-01T00:00:00.000Z' }),
    ]);
    expect(p.lines.slice(1).map((l) => JSON.parse(l).id)).toEqual(['req:old', 'req:new']);
  });

  it('图片行的成员名是 att/<16 位哈希>.<真实扩展名>', () => {
    const p = plan([row({ id: 'req:img', entry_type: 'image', full_image: true })], {
      pictures: pics,
      digests: new Map([['req:img', '0123456789abcdef']]),
    });
    expect(p.attachments).toEqual([{ row_id: 'req:img', name: 'att/0123456789abcdef.webp' }]);
    expect(JSON.parse(p.lines[1]!).attachment).toBe('att/0123456789abcdef.webp');
  });
});

describe('§8-2 预估体积是算出来的', () => {
  const pics = new Map<string, PictureFact>([['req:img', { bytes: 2048, ext: 'webp' }]]);
  const imgRow = row({ id: 'req:img', entry_type: 'image', full_image: true });

  it('占位哈希与真哈希产生的体积完全相同 —— 所以「预估」其实是精确值', () => {
    // 🔴 This is the mechanical guarantee behind the line 「一个假的体积数字和一个假的进度条是同一种东西」("a fake size number and a fake progress bar are the same kind of thing").
    const estimate = plan([imgRow], { pictures: pics });
    const real = plan([imgRow], { pictures: pics, digests: new Map([['req:img', 'ffeeddccbbaa9988']]) });
    expect(estimate.bytes).toBe(real.bytes);
    expect(PLACEHOLDER_SHA).toHaveLength(16);
    expect(estimate.attachments[0]!.name).toContain(PLACEHOLDER_SHA);
    expect(real.attachments[0]!.name).not.toContain(PLACEHOLDER_SHA);
  });

  it('体积随每一项真实变化：行、README、图片', () => {
    const base = plan([row()]);
    const more = plan([row(), row({ id: 'req:2' })]);
    expect(more.bytes).toBeGreaterThan(base.bytes);
    const longer = plan([row()], { readme: () => 'README'.repeat(100) });
    expect(longer.bytes - base.bytes).toBe(utf8Bytes('README'.repeat(100)) - utf8Bytes('README'));
    const withPic = plan([imgRow], { pictures: pics });
    const noPic = plan([imgRow], { pictures: pics, includePictures: false });
    // The delta = the picture itself + that member's two headers (local 30+name / central 46+name) + the extra
    // name string in the line. Only assert "at least as big as the picture itself," because the latter two terms are format constants, not what this test is meant to measure.
    expect(withPic.bytes - noPic.bytes).toBeGreaterThanOrEqual(2048);
  });

  it('两行共用一张图时只算一份（与 Rust 侧按名字去重一致）', () => {
    const two = plan(
      [imgRow, row({ id: 'req:img2', entry_type: 'image', full_image: true })],
      {
        pictures: new Map([
          ['req:img', { bytes: 2048, ext: 'webp' }],
          ['req:img2', { bytes: 2048, ext: 'webp' }],
        ]),
        // Same bytes ⇒ same content hash ⇒ same member name.
        digests: new Map([['req:img', 'aaaabbbbccccdddd'], ['req:img2', 'aaaabbbbccccdddd']]),
      },
    );
    const one = plan([imgRow], { pictures: pics, digests: new Map([['req:img', 'aaaabbbbccccdddd']]) });
    expect(two.attachments).toHaveLength(2); // both rows reference it
    // …but that picture appears only once in the size: there is no second 2048 in the delta.
    expect(two.bytes - one.bytes).toBeLessThan(2048);
  });

  it('archiveBytes 就是 zip.rs 写出的那套布局', () => {
    // 30 + name + content + 46 + name, plus one 22-byte EOCD.
    expect(archiveBytes([])).toBe(22);
    expect(archiveBytes([{ name: 'a.txt', bytes: 10 }])).toBe(22 + 30 + 5 + 10 + 46 + 5);
  });
});

describe('§3 建议文件名', () => {
  it('flowmic-export-desktop-<YYYYMMDD-HHMMSS>.zip，且只有名字没有目录', () => {
    const n = suggestedFileName(new Date(2026, 7, 1, 9, 12, 33));
    expect(n).toBe('flowmic-export-desktop-20260801-091233.zip');
    expect(n).not.toContain('/');
    expect(n).not.toContain('\\');
  });
});

describe('§8-1 满库导出的代价（2000 行 = MAX_ROWS）', () => {
  it('主线程那一段（遍历 + 序列化）在一次点击可以接受的时间内完成', () => {
    const rows: TimelineRow[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(row({
        id: `req:r${i}`,
        created_at: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
        // Realistic length scale: roughly 60 Chinese characters per utterance.
        source_text: '把这句话说完整一点这样字节数才有代表性'.repeat(3),
        output_text: '把这句话说完整一点这样字节数才有代表性'.repeat(3),
      }));
    }
    const t0 = Date.now();
    const p = plan(rows);
    const ms = Date.now() - t0;
    expect(p.header.count).toBe(2000);
    // eslint-disable-next-line no-console
    console.log(`[perf] planExport(2000 rows) = ${ms} ms, ${p.bytes} bytes`);
    // A loose upper bound: this is the lower-bound criterion for "does not block the UI," not a performance target. The real measured value is printed on
    // the line above, and that is what gets quoted in the delivery report.
    expect(ms).toBeLessThan(3000);
  });
});
