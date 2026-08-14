// R6 T-8 — the device page's 「已配对手机」("paired mobiles") decision core.
//
// The bug class this guards is the one the card replaced: a page that shows a
// confident answer it does not have. A failed read must NOT render as「暂无已配对
// 手机」("no paired phones yet"), and a phone must never be shown online on
// anything but the server's live presence flag.

import { describe, it, expect } from 'vitest';
import {
  asPairedMobiles,
  asPairedMobilesView,
  derivePairedGroups,
  derivePairedList,
  formatStamp,
  mergeWithCache,
  readPairedCache,
  writePairedCache,
  type PairedMobile,
} from './paired-mobiles';

const ROW: PairedMobile = {
  pairing_id: 'p1',
  mobile_name: 'Pixel 9',
  paired_at: '2026-07-20T08:00:00.000Z',
  last_seen_at: '2026-07-25T09:30:00.000Z',
  online: true, channel: 'lan' as const,
  device_uid: null,
};

describe('asPairedMobiles — narrowing the IPC payload', () => {
  it('keeps the public five and nothing else', () => {
    const rows = asPairedMobiles([{ ...ROW, mobile_token: 'S3CRET', user_id: 'default' }]);
    expect(rows).toEqual([ROW]);
    expect(JSON.stringify(rows)).not.toContain('S3CRET');
  });

  it('preserves the FAILED state — null in, null out (never an empty list)', () => {
    expect(asPairedMobiles(null)).toBeNull();
    expect(asPairedMobiles(undefined)).toBeNull();
    expect(asPairedMobiles({ mobiles: [] })).toBeNull();
    expect(asPairedMobiles([])).toEqual([]); // a real, empty answer
  });

  it('never invents presence: a missing or non-boolean online reads offline', () => {
    expect(asPairedMobiles([{ pairing_id: 'p1' }])?.[0]?.online).toBe(false);
    expect(asPairedMobiles([{ pairing_id: 'p1', online: 'true' }])?.[0]?.online).toBe(false);
    expect(asPairedMobiles([{ pairing_id: 'p1', online: 1 }])?.[0]?.online).toBe(false);
  });

  it('drops unidentifiable rows and falls back to a neutral name', () => {
    const rows = asPairedMobiles([{ mobile_name: 'ghost' }, { pairing_id: 'p2' }]);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.pairing_id).toBe('p2');
    expect(rows?.[0]?.mobile_name).toBe('手机');
  });

  it('treats an empty last_seen_at as never-connected (null), not as blank text', () => {
    expect(asPairedMobiles([{ pairing_id: 'p1', last_seen_at: '' }])?.[0]?.last_seen_at).toBeNull();
  });
});

describe('formatStamp — fixed zh-CN surface, no OS locale', () => {
  it('formats to YYYY-MM-DD HH:mm in local time', () => {
    const d = new Date('2026-07-25T09:30:00.000Z');
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatStamp('2026-07-25T09:30:00.000Z')).toBe(expected);
  });

  it('returns null for absent / unparseable stamps (caller renders 「—」)', () => {
    expect(formatStamp(null)).toBeNull();
    expect(formatStamp('')).toBeNull();
    expect(formatStamp('not-a-date')).toBeNull();
  });
});

describe('derivePairedList — the three-state truth', () => {
  it('distinguishes loading / FAILED / empty / rows', () => {
    expect(derivePairedList(undefined).state).toBe('loading');
    expect(derivePairedList(null).state).toBe('failed');
    expect(derivePairedList([]).state).toBe('empty');
    expect(derivePairedList([ROW]).state).toBe('rows');
  });

  it('a failed read never masquerades as「no phones paired」', () => {
    const failed = derivePairedList(null);
    const empty = derivePairedList([]);
    expect(failed.state).not.toBe(empty.state);
    expect(failed.rows).toEqual([]);
    expect(failed.onlineCount).toBe(0);
  });

  it('sorts online first, then most-recently-active', () => {
    const offlineRecent = { ...ROW, pairing_id: 'p2', mobile_name: 'iPhone', online: false, channel: 'lan' as const, last_seen_at: '2026-07-25T10:00:00.000Z' };
    const onlineOld = { ...ROW, pairing_id: 'p3', mobile_name: 'Old', online: true, channel: 'lan' as const, last_seen_at: '2026-07-01T00:00:00.000Z' };
    const view = derivePairedList([offlineRecent, onlineOld, ROW]);
    expect(view.rows.map((r) => r.pairing_id)).toEqual(['p1', 'p3', 'p2']);
    expect(view.onlineCount).toBe(2);
  });

  it('labels a never-connected phone as null (no back-filling from paired_at)', () => {
    const never = { ...ROW, last_seen_at: null };
    const [row] = derivePairedList([never]).rows;
    expect(row?.lastSeenLabel).toBeNull();
    expect(row?.pairedLabel).not.toBeNull();
  });

  it('onlineCount counts only rows the SERVER marked online', () => {
    const view = derivePairedList([{ ...ROW, online: false, channel: 'lan' as const }, { ...ROW, pairing_id: 'p9', online: false, channel: 'lan' as const }]);
    expect(view.onlineCount).toBe(0);
    expect(view.state).toBe('rows');
  });
});

// ── v0.2.1: two channels, and the difference between 「没有」("none") and
// 「问不到」("could not ask") ──
describe('asPairedMobilesView — the two-channel read', () => {
  it('keeps each row on the channel the bridge stamped it with', () => {
    const view = asPairedMobilesView({
      rows: [
        { ...ROW, pairing_id: 'p-lan', channel: 'lan' },
        { ...ROW, pairing_id: 'p-cloud', channel: 'cloud' },
      ],
      unreachable: [],
    });
    expect(view?.rows.map((r) => r.channel)).toEqual(['lan', 'cloud']);
  });

  it('the SAME phone paired on both channels stays TWO rows', () => {
    // owner 2026-07-28. They are not duplicates: two servers, two
    // mobile_pairings tables, two ids — and 断开/撤销 ("disconnect/revoke") on one
    // does nothing to the other. Merging them would make the revoke button lie
    // about what it kills.
    const view = asPairedMobilesView({
      rows: [
        { ...ROW, pairing_id: 'a', mobile_name: 'HUAWEI PLA-AL10-921d', channel: 'lan' },
        { ...ROW, pairing_id: 'b', mobile_name: 'HUAWEI PLA-AL10-921d', channel: 'cloud' },
      ],
      unreachable: [],
    });
    expect(view?.rows).toHaveLength(2);
    expect(new Set(view?.rows.map((r) => r.pairing_id)).size).toBe(2);
  });

  it('an unreachable channel is REPORTED, never rendered as "no phones there"', () => {
    const view = asPairedMobilesView({ rows: [], unreachable: ['cloud'] });
    expect(view?.rows).toEqual([]);
    expect(view?.unreachable).toEqual(['cloud']);
  });

  it('an unknown channel tag degrades to lan rather than inventing a third', () => {
    const view = asPairedMobilesView({ rows: [{ ...ROW, channel: 'satellite' }], unreachable: [] });
    expect(view?.rows[0]?.channel).toBe('lan');
    // …and a junk entry in `unreachable` is dropped, not shown as a channel name.
    const junk = asPairedMobilesView({ rows: [], unreachable: ['cloud', 'satellite', 7] });
    expect(junk?.unreachable).toEqual(['cloud']);
  });

  it('a shape we do not recognise is the LOUD state, not an empty table', () => {
    for (const raw of [null, undefined, 'nope', 42, [], { rows: 'nope' }]) {
      expect(asPairedMobilesView(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

// ── v0.2.4 · 「是不是同一台手机」("is it the same phone") ──────────────────
//
// owner 2026-07-29:「应能明确知道是否都是同一台手机和同一台 PC」("must be able to
// clearly tell whether it's the same phone and the same PC"). The table has
// always been RIGHT to show one handset as two rows (two servers, two pairings,
// independent 断开/撤销 ["disconnect/revoke"]) and has never been able to SAY
// that they are one phone.
// `sharedHandset` is that sentence, and its only real risk is claiming it when
// it is not true — which is what most of these assert.
describe('derivePairedList — sharedHandset', () => {
  it('two rows with the same device_uid both say 同一台手机', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', device_uid: 'mb-00112233445566aa' },
      { ...ROW, pairing_id: 'b', channel: 'cloud', device_uid: 'mb-00112233445566aa' },
    ]);
    expect(view.rows).toHaveLength(2);
    expect(view.rows.every((r) => r.sharedHandset)).toBe(true);
  });

  it('two rows with NO uid never do — 问不到 is not 同一台', () => {
    // The negative control, and the one that matters most: every pairing made
    // before 0.2.4 has a null uid, so a null-matches-null rule would light this
    // chip on every legacy table in existence.
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', device_uid: null },
      { ...ROW, pairing_id: 'b', channel: 'cloud', device_uid: null },
    ]);
    expect(view.rows.some((r) => r.sharedHandset)).toBe(false);
  });

  it('two DIFFERENT handsets never do', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', device_uid: 'mb-00112233445566aa' },
      { ...ROW, pairing_id: 'b', device_uid: 'mb-ffeeddccbbaa9988' },
    ]);
    expect(view.rows.some((r) => r.sharedHandset)).toBe(false);
  });

  it('a lone row with a uid does not claim a peer that is not there', () => {
    const view = derivePairedList([{ ...ROW, device_uid: 'mb-00112233445566aa' }]);
    expect(view.rows[0]?.sharedHandset).toBe(false);
  });

  it('the tally is over the whole list, not over adjacent rows', () => {
    // derivePairedList SORTS (online first, then recency), so group members can
    // end up separated. Counting after the sort — or only comparing neighbours
    // — would silently drop the chip on exactly the interesting case.
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', online: true, device_uid: 'mb-00112233445566aa' },
      { ...ROW, pairing_id: 'mid', online: true, device_uid: 'mb-ffeeddccbbaa9988' },
      { ...ROW, pairing_id: 'b', online: false, device_uid: 'mb-00112233445566aa' },
    ]);
    const shared = view.rows.filter((r) => r.sharedHandset).map((r) => r.pairing_id);
    expect(shared.sort()).toEqual(['a', 'b']);
  });

  it('the narrower turns a blank uid into null so it can never become a key', () => {
    const view = asPairedMobiles([
      { ...ROW, pairing_id: 'a', device_uid: '   ' },
      { ...ROW, pairing_id: 'b', device_uid: '' },
      { ...ROW, pairing_id: 'c', device_uid: 7 },
    ]);
    expect(view?.map((r) => r.device_uid)).toEqual([null, null, null]);
  });
});

// ── 2026-07-29 polish (D1) · 按物理设备归组 ("group by physical device") ──────
//
// The card renders PER HANDSET now. The grouping must be as conservative as
// sharedHandset was: only a shared non-null device_uid may merge two rows into
// one group, and merging must never touch the rows themselves — every sub-row
// keeps its own pairing_id + channel, because 断开/取消配对 ("disconnect/cancel
// pairing") still targets ONE pairing on ONE server.
describe('derivePairedGroups — one group per physical handset', () => {
  const UID = 'mb-00112233445566aa';

  it('two pairings of the SAME handset become ONE multi group, rows untouched', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', device_uid: UID, online: false },
      { ...ROW, pairing_id: 'b', channel: 'cloud', device_uid: UID, online: true },
    ]);
    const groups = derivePairedGroups(view.rows);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.multi).toBe(true);
    // 任一通道在线即在线 ("online on any channel counts as online") — the aggregate
    // is an OR, never a fresh judgement.
    expect(g.online).toBe(true);
    // The rows are the SAME objects in the SAME order — actions still target
    // their own pairing_id on their own channel.
    expect(g.rows.map((r) => `${r.channel}:${r.pairing_id}`)).toEqual(['cloud:b', 'lan:a']);
    expect(g.rows[0]).toBe(view.rows[0]);
    expect(g.rows[1]).toBe(view.rows[1]);
  });

  it('null uids NEVER merge — 问不到 is not 同一台, even with identical names', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', device_uid: null },
      { ...ROW, pairing_id: 'b', channel: 'cloud', device_uid: null },
    ]);
    const groups = derivePairedGroups(view.rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.multi && g.rows.length === 1)).toBe(true);
    // …and their keys differ, so v-for can never conflate them.
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('different handsets stay different groups; a lone uid is a singleton', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', device_uid: UID },
      { ...ROW, pairing_id: 'b', device_uid: 'mb-ffeeddccbbaa9988' },
    ]);
    const groups = derivePairedGroups(view.rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.multi)).toBe(true);
  });

  it('group order follows the first member, keeping the online-first sort', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'off', online: false, device_uid: 'mb-aa' },
      { ...ROW, pairing_id: 'on-1', online: true, device_uid: 'mb-bb' },
      { ...ROW, pairing_id: 'on-2', online: true, device_uid: 'mb-bb' },
    ]);
    const groups = derivePairedGroups(view.rows);
    expect(groups.map((g) => g.rows[0]?.pairing_id)).toEqual(['on-1', 'off']);
    expect(groups[0]?.multi).toBe(true);
  });

  it('the header name comes from the first (best-sorted) row of the group', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'a', mobile_name: 'HUAWEI old', online: false, device_uid: UID, last_seen_at: '2026-07-01T00:00:00.000Z' },
      { ...ROW, pairing_id: 'b', mobile_name: 'HUAWEI new', online: true, device_uid: UID },
    ]);
    const [g] = derivePairedGroups(view.rows);
    expect(g?.name).toBe('HUAWEI new');
  });

  it('an empty list groups to nothing', () => {
    expect(derivePairedGroups([])).toEqual([]);
  });
});

// ── 2026-08-02 返工 ("rework") (设计稿 ["design doc"] §2): 未知 ≠ 错误 ("unknown ≠
// error") —— 缓存合并与三态 ("cache merging and the three states") ───────────

describe('mergeWithCache — an unreachable channel answers from its last-known rows', () => {
  const NOW = new Date('2026-08-02T12:00:00.000Z');
  const kv = (): { store: Map<string, string>; get(k: string): string | null; set(k: string, v: string): void } => {
    const store = new Map<string, string>();
    return {
      store,
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
    };
  };

  it('🔴 行保留：问不到的通道用缓存行顶上，标 unknown、带「截至几点」，绝不整行消失', () => {
    const k = kv();
    // First read: both channels answer → the cache writes down the cloud row.
    const first = mergeWithCache(
      { rows: [{ ...ROW, pairing_id: 'pc1', channel: 'cloud', online: true }], unreachable: [] },
      readPairedCache(k), NOW,
    );
    writePairedCache(k, first.nextCache);
    // Second read: cloud does not answer.
    const second = mergeWithCache(
      { rows: [], unreachable: ['cloud'] },
      readPairedCache(k), new Date('2026-08-02T12:05:00.000Z'),
    );
    expect(second.view.rows).toHaveLength(1);
    expect(second.view.rows[0]?.presence).toBe('unknown');
    expect(second.view.rows[0]?.asOf).toBe(NOW.toISOString());
    // 🔴 The 「在线」("online") in the cache is an old fact, and must never be
    // treated as a live session.
    expect(second.view.rows[0]?.online).toBe(false);
    expect(second.view.unlisted).toEqual([]);
  });

  it('问不到且无缓存 ⇒ 该通道进 unlisted（弱灰行的数据源），不进 rows', () => {
    const merged = mergeWithCache({ rows: [], unreachable: ['cloud'] }, {}, NOW);
    expect(merged.view.rows).toEqual([]);
    expect(merged.view.unlisted).toEqual(['cloud']);
  });

  it('答了话的通道刷新自己的桶——包括刷成空（取消配对后不许在下次断连时复活）', () => {
    const k = kv();
    writePairedCache(k, { cloud: { rows: [{ ...ROW, channel: 'cloud' }], fetchedAt: NOW.toISOString() } });
    const merged = mergeWithCache({ rows: [], unreachable: [] }, readPairedCache(k), NOW);
    expect(merged.nextCache.cloud?.rows).toEqual([]);
  });

  it('坏掉的缓存降级为空缓存，不抛错也不编造行', () => {
    const k = kv();
    k.set('paired.lastKnown.v1', '{not json');
    expect(readPairedCache(k)).toEqual({});
    k.set('paired.lastKnown.v1', JSON.stringify({ cloud: { rows: 'nope', fetchedAt: 'x' } }));
    expect(readPairedCache(k)).toEqual({});
  });

  it('缓存行的 channel 以桶为准——漂了的行不许自称另一条通道', () => {
    const k = kv();
    writePairedCache(k, { cloud: { rows: [{ ...ROW, channel: 'lan' }], fetchedAt: NOW.toISOString() } });
    expect(readPairedCache(k).cloud?.rows[0]?.channel).toBe('cloud');
  });
});

describe('presence 三态贯穿 derive 层', () => {
  it('unknown 行不计入在线数，也不被 sort 抬到活会话之上', () => {
    const view = derivePairedList([
      { ...ROW, pairing_id: 'live', online: true },
      { ...ROW, pairing_id: 'ghost', online: false, presence: 'unknown', asOf: '2026-08-02T11:00:00.000Z' },
    ]);
    expect(view.onlineCount).toBe(1);
    expect(view.rows[0]?.pairing_id).toBe('live');
    expect(view.rows.find((r) => r.pairing_id === 'ghost')?.asOfLabel).not.toBeNull();
  });

  it('组头聚合：任一在线→online；否则有未知→unknown（问不到的通道在场时不许断言「离线」）；全离线→offline', () => {
    const UID2 = 'mb-agg';
    const mixed = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', online: false, device_uid: UID2 },
      { ...ROW, pairing_id: 'b', channel: 'cloud', online: false, presence: 'unknown', asOf: null, device_uid: UID2 },
    ]);
    expect(derivePairedGroups(mixed.rows)[0]?.presence).toBe('unknown');
    const allOff = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', online: false, device_uid: UID2 },
      { ...ROW, pairing_id: 'b', channel: 'cloud', online: false, device_uid: UID2 },
    ]);
    expect(derivePairedGroups(allOff.rows)[0]?.presence).toBe('offline');
    const oneUp = derivePairedList([
      { ...ROW, pairing_id: 'a', channel: 'lan', online: true, device_uid: UID2 },
      { ...ROW, pairing_id: 'b', channel: 'cloud', online: false, presence: 'unknown', asOf: null, device_uid: UID2 },
    ]);
    expect(derivePairedGroups(oneUp.rows)[0]?.presence).toBe('online');
  });
});
