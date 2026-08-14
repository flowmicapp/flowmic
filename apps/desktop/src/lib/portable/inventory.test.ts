// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6 —— the inventory layer.
//
// This layer is the shared data source for C2 (statistics) and the later "clear," so its shape
// has to be right now: row count / byte count (text and pictures kept separate) / time range.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_INVENTORY,
  formatBytes,
  formatCount,
  groupByMachine,
  pictureCandidates,
  summarize,
  utf8Bytes,
  walkAssets,
  type MachineRegistryEntry,
  type PictureFact,
} from './inventory';
import { rowWordCount } from '../entry-metrics';
import type { TimelineRow } from '../types';

function row(over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'req:1',
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    output_text: '',
    created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:00.000Z',
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

describe('utf8Bytes —— 中文按字节数，不是按 code unit', () => {
  it('ASCII / 中文 / emoji 各按真实 UTF-8 长度', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('你好')).toBe(6); // 🔴 `.length` would answer 2, which is a 3x lie
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('🎧')).toBe(4); // a surrogate pair is one 4-byte code point, not two 3-byte ones
    expect(utf8Bytes('')).toBe(0);
  });

  it('与浏览器/Node 的编码器逐字符一致（正向对照，不是自证）', () => {
    const enc = new TextEncoder();
    for (const s of ['', 'a', '你好，世界', 'a你b🎧c', 'Ωé—', '𝄞𝄢']) {
      expect(utf8Bytes(s)).toBe(enc.encode(s).length);
    }
  });
});

describe('walkAssets / summarize', () => {
  const pics = new Map<string, PictureFact>([['req:img', { bytes: 40_000, ext: 'jpg' }]]);

  it('条数 / 文字字节 / 图片字节 / 时间范围', () => {
    const rows = [
      row({ id: 'req:a', source_text: '你好', output_text: 'hi', created_at: '2026-08-01T08:00:00.000Z' }),
      row({ id: 'req:img', entry_type: 'image', full_image: true, output_text: '🖼 PNG', created_at: '2026-07-30T08:00:00.000Z' }),
      row({ id: 'req:c', output_text: 'abc', created_at: '2026-08-02T08:00:00.000Z' }),
    ];
    const inv = summarize(walkAssets(rows, pics));
    expect(inv.count).toBe(3);
    expect(inv.transcripts).toBe(2);
    expect(inv.images).toBe(1);
    expect(inv.withPicture).toBe(1);
    expect(inv.textBytes).toBe(utf8Bytes('你好') + 2 + utf8Bytes('🖼 PNG') + 3);
    expect(inv.pictureBytes).toBe(40_000);
    expect(inv.earliest).toBe('2026-07-30T08:00:00.000Z');
    expect(inv.latest).toBe('2026-08-02T08:00:00.000Z');
  });

  it('一张图都没有时 pictureBytes 是 0，而不是「不知道」', () => {
    expect(summarize(walkAssets([row()], new Map()))).toEqual({
      ...EMPTY_INVENTORY,
      count: 1,
      transcripts: 1,
      earliest: '2026-08-01T08:00:00.000Z',
      latest: '2026-08-01T08:00:00.000Z',
    });
  });

  it('空 created_at 不会变成「最早」那一端', () => {
    // An old cached row's created_at can be '' (timeline-normalize's degradation), and '' sorts
    // before every real instant — letting it act as a bound would report the time range as starting from the empty string.
    const inv = summarize(walkAssets([row({ created_at: '' }), row({ id: 'req:b' })], new Map()));
    expect(inv.count).toBe(2);
    expect(inv.earliest).toBe('2026-08-01T08:00:00.000Z');
  });

  it('图片行的行本身没有图片文件时 withPicture 不计它', () => {
    // `full_image:false` = that picture was not kept (the write's own verdict), only a thumbnail.
    const inv = summarize(walkAssets([row({ id: 'req:x', entry_type: 'image', full_image: false })], new Map()));
    expect(inv.images).toBe(1);
    expect(inv.withPicture).toBe(0);
  });
});

describe('pictureCandidates —— 只问声称留了图的行', () => {
  it('去重，且不问 full_image 为假的行', () => {
    const rows = [
      row({ id: 'req:p', full_image: true, channel: 'lan' }),
      row({ id: 'req:p', full_image: true, channel: 'cloud' }), // the same file
      row({ id: 'req:q', full_image: false }),
    ];
    expect(pictureCandidates(rows)).toEqual(['req:p']);
  });
});

describe('formatBytes —— 一份库在两个页面上不许显示成两个大小', () => {
  it('二进制单位，与资源管理器同口径', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

// ── C2 (doc 16 §6.1): statistics = walk + aggregate ───────────────────────────────────────

describe('字数 —— 聚合就是逐行之和，一套算法两个粒度 (§6.1)', () => {
  it('🔴 Inventory.words 恒等于逐行 rowWordCount 相加', () => {
    // What is asserted is "equals the sum of the rows," not some specific number: swap out the algorithm and this stays green,
    // while writing a second algorithm at the aggregation site turns it red immediately — that is exactly what it exists to prevent.
    const rows = [
      row({ id: 'a', output_text: '你好 world 123' }),
      row({ id: 'b', output_text: '这是一句中文' }),
      row({ id: 'c', output_text: '' }),
      row({ id: 'd', output_text: 'ignored', entry_type: 'image' }),
    ];
    const assets = walkAssets(rows, new Map());
    expect(summarize(assets).words).toBe(assets.reduce((n, a) => n + a.words, 0));
    expect(summarize(assets).words).toBe(rows.reduce((n, r) => n + rowWordCount(r), 0));
  });

  it('图片行按行级口径计 0 字（那不是说出来的话）', () => {
    const inv = summarize(walkAssets([row({ id: 'p', entry_type: 'image', output_text: '[图片]' })], new Map()));
    expect(inv.images).toBe(1);
    expect(inv.words).toBe(0);
  });

  it('空库的字数是 0，而不是缺席', () => {
    expect(summarize([]).words).toBe(0);
    expect(EMPTY_INVENTORY.words).toBe(0);
  });
});

describe('转录时长 —— 0.2.43 投递帧带回来的那一格 (§6.1 修订)', () => {
  it('🔴 合计只含盖了章的行；null 绝不当 0，缺口用 withDuration 说出口', () => {
    const assets = walkAssets([
      row({ id: 'a', duration_ms: 3200 }),
      row({ id: 'b', duration_ms: 0 }), // a genuine 0ms stamp still counts as stamped (stamped ≠ the illusion of having a duration)
      row({ id: 'c' }), // not stamped —— excluded from the sum
      row({ id: 'd', duration_ms: null }),
    ] as Parameters<typeof walkAssets>[0], new Map());
    const inv = summarize(assets);
    expect(inv.durationMs).toBe(3200);
    expect(inv.withDuration).toBe(2);
    expect(inv.count - inv.withDuration).toBe(2); // the data behind「另有 2 条没有时长」("2 more rows have no duration")
  });

  it('聚合 == 逐行之和（同一个行级函数，不是第二份算法）', () => {
    const rows = [row({ id: 'a', duration_ms: 1000 }), row({ id: 'b', duration_ms: 250 })];
    const assets = walkAssets(rows as Parameters<typeof walkAssets>[0], new Map());
    expect(summarize(assets).durationMs).toBe(assets.reduce((n, a) => n + (a.durationMs ?? 0), 0));
  });

  it('负数/小数这类坏值按行级口径读成「没有」，不进合计也不崩', () => {
    const inv = summarize(walkAssets([
      row({ id: 'a', duration_ms: -5 }),
      row({ id: 'b', duration_ms: 3.7 }),
    ] as Parameters<typeof walkAssets>[0], new Map()));
    expect(inv.durationMs).toBe(0);
    expect(inv.withDuration).toBe(0);
  });
});

describe('formatCount —— 一个数在两个面上不许长成两样', () => {
  it('固定千分位，不吃 OS locale', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(188)).toBe('188');
    expect(formatCount(16515)).toBe('16,515');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('groupByMachine —— 按来源机器归并 (§6.1「分组」2026-08-02 修订)', () => {
  /** The shape in owner's screenshot: one Huawei phone has one pairing per channel across two channels (two pairing ids, the same
   *  device_uid), and another batch of rows was minted from delivery frames, carrying only device_label. */
  const REG = new Map<string, MachineRegistryEntry>([
    ['p-lan', { name: 'HUAWEI PLA-AL10-921d', deviceUid: 'mb-hw' }],
    ['p-cloud', { name: 'HUAWEI PLA-AL10-921d', deviceUid: 'mb-hw' }],
    ['p-old', { name: 'Pixel 8-ab12', deviceUid: null }],
  ]);
  const rows = [
    row({ id: 'a', mobile_id: 'p-lan', output_text: '一二三' }),
    row({ id: 'b', mobile_id: 'p-cloud', output_text: '四五' }),
    row({ id: 'c', mobile_id: null, device_label: 'HUAWEI PLA-AL10-921d', output_text: '六' }),
    row({ id: 'd', mobile_id: 'p-old', output_text: '七' }),
    row({ id: 'e', mobile_id: '6427ef13-dead-beef-0000-000000000000', output_text: '八' }),
    row({ id: 'f', mobile_id: null, output_text: '九' }),
  ];

  it('各组之和 == 总计（用的是同一个聚合器，不是另抄一遍字段）', () => {
    const assets = walkAssets(rows, new Map());
    const total = summarize(assets);
    const groups = groupByMachine(assets, REG);
    expect(groups.reduce((n, g) => n + g.inventory.count, 0)).toBe(total.count);
    expect(groups.reduce((n, g) => n + g.inventory.words, 0)).toBe(total.words);
    expect(groups.reduce((n, g) => n + g.inventory.textBytes, 0)).toBe(total.textBytes);
  });

  it('🔴 同一台手机绝不出现两行：两条配对 + 投递帧标签合成一行，条数相加', () => {
    const groups = groupByMachine(walkAssets(rows, new Map()), REG);
    const hw = groups.filter((g) => g.name === 'HUAWEI PLA-AL10-921d');
    expect(hw).toHaveLength(1);
    expect(hw[0]?.inventory.count).toBe(3); // a + b + c, in owner's screenshot this was two lines, 48+1
  });

  it('反向对照：两台名字不同的手机不会被并掉', () => {
    const groups = groupByMachine(walkAssets(rows, new Map()), REG);
    expect(groups.find((g) => g.name === 'Pixel 8-ab12')?.inventory.count).toBe(1);
  });

  it('🔴 UUID 永不上屏：解析不到名字的 mobile_id 进「其他设备」，id 只进 devices 计数', () => {
    const groups = groupByMachine(walkAssets(rows, new Map()), REG);
    const other = groups.find((g) => g.kind === 'other');
    expect(other?.inventory.count).toBe(1);
    expect(other?.devices).toBe(1);
    expect(other?.name).toBeNull();
    // That id string must not appear in any display field of any bucket.
    for (const g of groups) expect(g.name ?? '').not.toContain('6427ef13');
  });

  it('两个身份都没有的行归「早期记录」，不并进「其他设备」', () => {
    const groups = groupByMachine(walkAssets(rows, new Map()), REG);
    expect(groups.find((g) => g.kind === 'early')?.inventory.count).toBe(1);
  });

  it('具名桶按条数排前，「其他设备」「早期记录」固定收尾', () => {
    const groups = groupByMachine(walkAssets(rows, new Map()), REG);
    expect(groups[0]?.name).toBe('HUAWEI PLA-AL10-921d');
    expect(groups.at(-2)?.kind).toBe('other');
    expect(groups.at(-1)?.kind).toBe('early');
  });

  it('registry miss 但行上带 device_label ⇒ 走标签，不掉「其他设备」（senderLabel 同一条次序）', () => {
    const groups = groupByMachine(
      walkAssets([row({ id: 'x', mobile_id: 'gone-pairing', device_label: 'Mate 60-cd34' })], new Map()),
      new Map(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Mate 60-cd34');
  });

  it('同一 device_uid 在两条通道下名字不同 ⇒ 用一个规范名合成一行', () => {
    const reg = new Map<string, MachineRegistryEntry>([
      ['p1', { name: '旧名字', deviceUid: 'mb-x' }],
      ['p2', { name: '新名字', deviceUid: 'mb-x' }],
    ]);
    const groups = groupByMachine(
      walkAssets([row({ id: 'a', mobile_id: 'p1' }), row({ id: 'b', mobile_id: 'p2' })], new Map()),
      reg,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.inventory.count).toBe(2);
  });
});

// §6.1-c (2026-08-02 revision): after the delivery frame started carrying duration_ms, the inventory layer had a real data source.
// This guards the field shape: exactly one pair (total + stamped count), no second duration metric is allowed to grow.
describe('转录时长 —— 字段形状 (§6.1-c 修订版)', () => {
  it('Inventory 的时长面恰好是 durationMs + withDuration 一对', () => {
    const keys = Object.keys(EMPTY_INVENTORY);
    expect(keys.filter((k) => /duration|seconds|minutes|elapsed/i.test(k)).sort()).toEqual([
      'durationMs', 'withDuration',
    ]);
  });
});
