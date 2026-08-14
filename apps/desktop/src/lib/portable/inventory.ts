// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6 (the inventory layer —— this document's
//      most important constraint on the implementation)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §1 (「导出 = 遍历 +
//      序列化; 统计 = 遍历 + 聚合; 清空 = 遍历 + 删除。一次遍历实现, 三个动词消费。」
//      ("export = walk + serialize; statistics = walk + aggregate; clear = walk + delete.
//      One walk implementation, consumed by three verbs."))
//
// THE ASSET WALKER — which assets this PC holds, and how many bytes each occupies.
//
// 🔴 EXPORT IS ITS FIRST CONSUMER, NOT ITS OWNER (§6-4). The whole point of this
// module existing before there is anything but an export to use it is that the
// other two verbs are already specified:
//
//   export (window C, this round)  walk + serialise  → lib/portable/export.ts
//   statistics (C2, next)          walk + aggregate  → [[summarize]] IS the answer
//   clear (after C2)               walk + delete     → [[walkAssets]] rows carry the
//                                                       bytes each deletion frees
//
// If the export had walked the rows inline, C2 would have grown a SECOND walk,
// and「你有多少条记录、占多少空间」("how many records you have, how much space they occupy") would have two answers that drift — the repo's
// #1 bug shape (one value answering two questions) at feature scale.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It knows nothing about JSON, zip files or the wire. It takes rows and picture
// sizes and returns numbers. Serialisation is the export's job (§6-1).
//
// ── WHERE THE PICTURE BYTES COME FROM ───────────────────────────────────────
// Not from here: the delivered pictures are FILES beside the forensic log
// (src-tauri/src/socket/row_image.rs), because a 5.5 M base64 image cannot live
// on a row inside a 1.5 M-character localStorage budget. The caller passes what
// Rust measured (`portable_picture_sizes` → `metadata().len()`), which is why
// §8-2's「预估体积必须是真的算出来的」("the estimated size must be genuinely computed") can be honoured: every byte in this answer
// was measured, none estimated.

import { rowDurationMs, rowWordCount } from '../entry-metrics';
import type { TimelineRow } from '../types';

/** One row's own picture, as the filesystem reports it. */
export interface PictureFact {
  /** Size on disk, in bytes. */
  bytes: number;
  /** `png` / `jpg` / `webp` — the stored file's real extension, never a guess. */
  ext: string;
}

/** One row plus what it costs this machine. */
export interface AssetRow {
  row: TimelineRow;
  /** UTF-8 bytes of the WORDS on this row (`source_text` + `output_text`).
   *
   *  ⚠️ Deliberately NOT「这一行在 localStorage 里占多少」("how much this row occupies in localStorage"): that number includes
   *  JSON punctuation, the thumbnail and the field names, and it answers a
   *  question about our storage format rather than about the user's data. C2's
   *  「字数 / 文字占用」("word count / text footprint") is about what the user said. */
  textBytes: number;
  /** The delivered picture's size on disk; `0` when this row has none — which is
   *  the honest value for a transcript row and for an image row whose picture
   *  was not kept (`full_image === false`). */
  pictureBytes: number;
  /** The picture's real extension, or null. Carried because the export needs it
   *  to name the archive member (§3) and the walk already has it. */
  pictureExt: string | null;
  /** 0.2.43 — the row's speaking duration, from THE row-level function
   *  (`rowDurationMs`) and no other. Null =「没有时长」("no duration") — absent from the sum AND
   *  counted in 「另有 N 条没有时长」("N more rows have no duration"), never coerced to 0 (doc 16 §6.1). */
  durationMs: number | null;
  /** C2 (doc 16 §6.1) — word count, from THE row-level function and no other.
   *
   *  🔴 `rowWordCount` is imported rather than re-derived, and that import IS the
   *  contract: the overarching design §4b-8 says「聚合＝逐行之和，一套算法两个展示粒度」("aggregate = the sum of the rows, one algorithm at two display granularities"). If the
   *  statistics page counted words its own way, the row chip and the total would
   *  drift and neither would be wrong enough to notice. */
  words: number;
}

/** The three answers §6-2 requires, plus the splits C2's clear-by-type needs. */
export interface Inventory {
  /** Row count — every row this PC holds, both channels. */
  count: number;
  /** How many of them are transcripts / pictures (the "pick one of two" dimension for clearing, §4-4). */
  transcripts: number;
  images: number;
  /** Image rows whose bytes are really on this disk. `images - withPicture` is
   *  the number of picture rows that only have a thumbnail — a real difference,
   *  and one an export of「不含图片」("without pictures") must not blur. */
  withPicture: number;
  /** Byte count, text and pictures kept separate (§6-2). */
  textBytes: number;
  pictureBytes: number;
  /** C2 — total word count = Σ [[AssetRow.words]]. See there for why it is a sum of the row
   *  function rather than a second algorithm. */
  words: number;
  /** 0.2.43 — total transcription duration (ms) = Σ non-null [[AssetRow.durationMs]]. Rows without
   *  one are EXCLUDED, and [[withDuration]] says how many are in — the render layer
   *  derives 「另有 N 条没有时长」("N more rows have no duration") as `count − withDuration` and must show it
   *  whenever it is non-zero (doc 16 §6.1: treating "unknown" as "zero seconds" is forbidden). */
  durationMs: number;
  withDuration: number;
  /** Time range — the oldest and newest `created_at` held (ISO strings, null when
   *  there are no rows). Never a fabricated bound. */
  earliest: string | null;
  latest: string | null;
}

/** The empty answer. A store with no rows has a shape, not a null. */
export const EMPTY_INVENTORY: Inventory = {
  count: 0,
  transcripts: 0,
  images: 0,
  withPicture: 0,
  textBytes: 0,
  pictureBytes: 0,
  words: 0,
  durationMs: 0,
  withDuration: 0,
  earliest: null,
  latest: null,
};

/** UTF-8 byte length of a string.
 *
 *  Computed rather than `s.length`: a Chinese transcript is 3 bytes per
 *  character, so the two numbers differ by 3× for this product's primary
 *  language — and「占多少空间」("how much space it occupies") has to be true in bytes, not in code units. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // A surrogate PAIR is one 4-byte code point; a lone surrogate is 3
      // (what an encoder emits as U+FFFD). Getting this wrong would make emoji
      // rows over-count, which is a small lie that compounds over 2000 rows.
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** THE WALK. One pass, no side effects, no ordering promise beyond「same order
 *  in as out」— the caller decides how to sort (the export sorts by time, the
 *  clear will sort by age).
 *
 *  `pictures` maps a row id to what Rust measured. A row absent from the map has
 *  no picture on this disk; that is a fact, not a missing measurement, because
 *  the producer only returns rows whose file it actually stat-ed. */
export function walkAssets(
  rows: readonly TimelineRow[],
  pictures: ReadonlyMap<string, PictureFact>,
): AssetRow[] {
  // 🔴 REQ-12-13 — remote key press rows are NOT portable records, and this is the
  // one place that has to know it (docs/rebuild/16 §4.2 + docs/rebuild/15 §2.0-e).
  //
  // WHY HERE AND NOT AT THE EXPORTER: this walker is the single producer feeding
  // BOTH verbs — statistics (`summarize`) and export (`plan`) — so excluding here keeps one
  // answer to 「哪些行算数」("which rows count") instead of two rules that will drift. And both need the
  // exclusion for the same reason from different directions: FPR v1's `entry_type`
  // admits `transcript`/`image` ONLY, so a control row exports fine and is REFUSED
  // line-by-line on re-import (`fpr.ts` `bad_entry_type`) — 导得出、导不回 ("exportable but not importable back"), a silent
  // one-way loss on a round trip — while statistics has exactly two buckets and would file
  // every keypress under transcript count.
  //
  // ⚠️ NOT fixed by widening `kFprEntryTypes`: that is a FORMAT change to a frozen
  // v1, and a keypress is not a record of content — an MCP consumer reading one
  // learns nothing. doc 16 §4.2 states the ruling.
  const portable = rows.filter((r) => r.entry_type !== 'control');
  return portable.map((row) => {
    const pic = pictures.get(row.id) ?? null;
    return {
      row,
      textBytes: utf8Bytes(row.source_text ?? '') + utf8Bytes(row.output_text),
      pictureBytes: pic?.bytes ?? 0,
      pictureExt: pic?.ext ?? null,
      durationMs: rowDurationMs(row),
      words: rowWordCount(row),
    };
  });
}

/** THE AGGREGATE — statistics IS this function and nothing else (§6-2). */
export function summarize(assets: readonly AssetRow[]): Inventory {
  const inv: Inventory = { ...EMPTY_INVENTORY };
  for (const a of assets) {
    inv.count += 1;
    if (a.row.entry_type === 'image') inv.images += 1;
    else inv.transcripts += 1;
    if (a.pictureBytes > 0) inv.withPicture += 1;
    inv.textBytes += a.textBytes;
    inv.pictureBytes += a.pictureBytes;
    inv.words += a.words;
    if (a.durationMs !== null) {
      inv.durationMs += a.durationMs;
      inv.withDuration += 1;
    }
    const t = a.row.created_at;
    // An empty `created_at` is possible on a row normalised from an ancient
    // cache (timeline-normalize.ts defaults it to ''), and it must not become
    // the「最早」("earliest") bound — that would report a time range starting at the empty
    // string, which sorts before every real instant.
    if (t !== '') {
      if (inv.earliest === null || t < inv.earliest) inv.earliest = t;
      if (inv.latest === null || t > inv.latest) inv.latest = t;
    }
  }
  return inv;
}

/** A byte count as a person reads it (`1.2 MB`).
 *
 *  Lives HERE, beside the numbers it formats, so the export's estimated size and C2's space-occupied figure
 *  render the same bytes the same way — two formatters would make the same
 *  library look like two different sizes on two pages.
 *
 *  Binary units (1 KB = 1024 B), matching what Windows Explorer shows for the
 *  very same file, because that is the number the user will check ours against. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // One decimal below 10, none above: `9.7 MB` is useful, `973.4 MB` is noise.
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A whole number as a person reads it (`16,515`). Fixed comma grouping — never
 *  `toLocaleString` (red line: UI must not follow the OS locale) — and it lives HERE beside
 *  [[formatBytes]] for the same reason that one does: the panel's summary line and
 *  the statistics tiles render the same count, and two formatters would make one
 *  number look like two. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** How the paired registry describes one pairing id, for [[groupByMachine]].
 *  `deviceUid` is v0.2.4's cross-channel handset identity, null on pre-0.2.4 rows. */
export interface MachineRegistryEntry {
  name: string;
  deviceUid: string | null;
}

/** One line of the 「按来源手机」("by source phone") breakdown (C2, doc 16 §6.1「分组」("grouping") — 2026-08-02 revision).
 *
 *  🔴 THE DESKTOP GROUPS BY SOURCE PHONE, the phone groups by target PC, and the two
 *  are deliberately not symmetric — doc 15 §2.3: the phone owns 「这句话」("this utterance"), this machine
 *  owns 「这次投递」("this delivery").
 *
 *  🔴 AND THE UNIT IS A MACHINE, NOT AN INTERNAL ID (owner 2026-08-02 real-device ruling,
 *  design draft 2026-08-02-ui-batch1-rework-design.md §1.3). A row's sender identity has TWO
 *  carriers — `mobile_id` (a pairing id, resolvable against the paired registry) and
 *  `device_label` (the name the phone stamped on the delivery frame; minted rows carry
 *  ONLY this — see TimelineRow.device_label). The previous version grouped by
 *  `mobile_id` alone, so every frame-minted row fell into 「未标注来源」("unlabeled source") and one handset
 *  paired over two channels rendered as two lines. This is the UI face of
 *  `queue-destination-is-a-machine`: a pairing id is an ALIAS of the phone, not the phone. */
export interface MachineGroup {
  /** Stable render key. Never an id the user should read. */
  key: string;
  /** `named` = a phone the user can recognise by name; `other` = sources whose name
   *  can no longer be resolved (unpaired since); `early` = rows that never said. */
  kind: 'named' | 'other' | 'early';
  /** The display name (kind `named` only) — resolved NOW, never stored on rows. */
  name: string | null;
  /** kind `other`: how many distinct unresolvable source ids were merged in. */
  devices: number;
  inventory: Inventory;
}

/** Split a walk per source MACHINE, then aggregate each part with [[summarize]]
 *  (same aggregator per group ⇒ 「各组之和 == 总计」("the sum of each group == the total") by construction — if this summed
 *  fields itself, a field added to Inventory later would silently stay 0 per group).
 *
 *  Name resolution is THE SAME two-step senderLabel() uses on the timeline row —
 *  ① the paired registry, ② the row's own `device_label` — so the breakdown and the
 *  row chips can never disagree about who sent a row. Registry names are canonicalised
 *  per `device_uid` first (two channels can know one handset under different names),
 *  and buckets that resolve to the SAME display name are merged: the name IS the
 *  identity the user sees, and both ends mint device-suffixed names (`Pixel 8-ab12`),
 *  so equal names are one phone for every practical purpose.
 *
 *  🔴 Raw ids NEVER become display text: an unresolvable `mobile_id` lands in the one
 *  merged 「其他设备」("other devices") line (distinct-id count only), and a row with neither identity
 *  lands in 「早期记录」("early records"). Rendering the id 「因为它至少是真的」("because it is at least true") was exactly the
 *  owner-rejected screen this replaces — true, but written for an engineer. */
export function groupByMachine(
  assets: readonly AssetRow[],
  registry: ReadonlyMap<string, MachineRegistryEntry>,
): MachineGroup[] {
  const uidName = new Map<string, string>();
  for (const entry of registry.values()) {
    if (entry.deviceUid !== null && !uidName.has(entry.deviceUid)) uidName.set(entry.deviceUid, entry.name);
  }
  const named = new Map<string, AssetRow[]>();
  const orphanIds = new Set<string>();
  const other: AssetRow[] = [];
  const early: AssetRow[] = [];
  const pushNamed = (name: string, a: AssetRow): void => {
    const bucket = named.get(name);
    if (bucket) bucket.push(a);
    else named.set(name, [a]);
  };
  for (const a of assets) {
    const pid = a.row.mobile_id;
    const reg = pid !== null ? registry.get(pid) : undefined;
    if (reg !== undefined) {
      pushNamed(reg.deviceUid !== null ? (uidName.get(reg.deviceUid) ?? reg.name) : reg.name, a);
    } else if (a.row.device_label !== null && a.row.device_label !== '') {
      // senderLabel's step ②, taken for both 「no mobile_id」 and 「registry miss」 —
      // the frame-stamped name is a real answer to which phone, not a fallback of shame.
      pushNamed(a.row.device_label, a);
    } else if (pid !== null) {
      orphanIds.add(pid);
      other.push(a);
    } else {
      early.push(a);
    }
  }
  const out: MachineGroup[] = [];
  for (const [name, rows] of named) {
    out.push({ key: `name:${name}`, kind: 'named', name, devices: 1, inventory: summarize(rows) });
  }
  // Biggest first — a user with one main phone should not have to scan for it. Ties
  // broken by name so the order is stable across renders, not Map insertion.
  out.sort((a, b) => b.inventory.count - a.inventory.count || (a.name ?? '').localeCompare(b.name ?? ''));
  // The two anonymous lines close the list in a FIXED order: they are context, and a
  // context line that outranked a named phone by sheer row count would bury the answer.
  if (other.length > 0) out.push({ key: 'other', kind: 'other', name: null, devices: orphanIds.size, inventory: summarize(other) });
  if (early.length > 0) out.push({ key: 'early', kind: 'early', name: null, devices: 0, inventory: summarize(early) });
  return out;
}

// 0.2.43 —「转录时长」("transcription duration") IS HERE NOW (owner 2026-08-02:「语音时长要找回来」("the speaking duration needs to be recovered")).
//
// The doc 16 §6.1-c note that used to stand here said the desktop had no data
// source for duration — true until the delivery frame gained the additive
// optional `duration_ms` (protocol-schemas-inject.ts) and the phone started
// stamping its engine-reported number on every utterance frame. Two rules
// survive from that era unchanged:
//   · null is never treated as 0 —— rows without a duration (typed/manual/image, pre-0.2.43
//     frames, frames that crossed an old relay) stay OUT of the sum, and
//     `count − withDuration` is surfaced as 「另有 N 条没有时长」("N more rows have no duration");
//   · a tile with no data source is not rendered —— a store where NO row has a
//     duration shows the explanation line, never a 「0 分钟」("0 minutes").

/** The row ids worth asking Rust about — every row that CLAIMS a kept picture.
 *
 *  `full_image` is the write's own verdict, stamped by `socket::row_image::store`
 *  (types.ts), so this is not a guess about which rows might have files; asking
 *  about all 2000 rows would stat 2000 paths for the ~20 that can answer. */
export function pictureCandidates(rows: readonly TimelineRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    // Both channels' rows share one picture directory keyed by BARE id
    // (row_image.rs states why a collision is not reachable), so the ids are
    // deduped here rather than asking twice for one file.
    if (r.full_image) seen.add(r.id);
  }
  return [...seen];
}
