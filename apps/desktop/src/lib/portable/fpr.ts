// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §4 (records.jsonl),
//      §5.2 (each line's outcome must be explainable), §5.3 (only same-end accepted), §5.4 (unknown fields kept verbatim)
//
// FPR v1 — THE ONE AUTHOR OF THE FORMAT ON THIS END.
//
// Nothing in src-tauri parses or edits a record line (see portable/mod.rs): the
// fields come off the timeline rows, which live here, so shaping them here is
// what keeps the format from having two authors that can drift.
//
// ⚠️ The two ends share one shape (doc 16, §1 ruling 4). The phone writes THIS shape — same header line,
// same core field set, same attachment naming. Anything that would make the two
// differ belongs in doc 16 first, then in both implementations.

import type { ChannelTag, TimelineRow, WireHistoryItem } from '../types';

/** The format version. On EVERY line, not just the header (§4.1): a JSONL file
 *  gets `tail`-ed and sliced, and a slice has to be self-describing. */
export const FPR_VERSION = 1;

/** Which end wrote it (§4.1 `source.end`) — and the import-side admission
 *  criterion (§5.3). */
export const THIS_END = 'desktop';

/** Three modes locked, never a fourth mode (red line). Runtime values, because the protocol's are
 *  types and types are erased — the same reason timeline-normalize.ts keeps its
 *  own copies. */
const MODES = new Set(['realtime', 'translate', 'organize']);
/** Five statuses (doc 05 §1). `noted` included: a「仅记录」("record only") row is still a row. */
const STATUSES = new Set(['injected', 'cached', 'failed', 'noted']);

/** Why a line was NOT imported. A TAG, mapped to a sentence by
 *  lib/strings/portable.ts — 🔴 §5.2「原因要具名，不许只说『格式错误』」("the reason must be named, not just a blanket 'format error'"). */
export type RefusalReason =
  | 'not_json'
  | 'unsupported_version'
  | 'unknown_kind'
  | 'no_id'
  | 'bad_created_at'
  | 'bad_mode'
  | 'bad_status'
  | 'bad_entry_type'
  | 'no_channel';

/** Why a whole FILE was refused before any line was considered. */
export type FileRefusal =
  | { kind: 'no_header' }
  | { kind: 'unsupported_version'; found: number }
  /** §5.3 — the other end's file. `end` is what it says it is, so the sentence
   *  can name it (「这是从手机导出的记录…」("this is a record exported from the phone…")) instead of saying「格式错误」("format error"). */
  | { kind: 'wrong_end'; end: string }
  /** §4.1 —「count 必须与实际行数相等；不等 = 导出撒谎」("count must equal the actual row count; a mismatch = the export is lying"). */
  | { kind: 'count_mismatch'; declared: number; found: number };

/** The header line (§4.1). */
export interface FprHeader {
  fpr: number;
  kind: 'header';
  exported_at: string;
  /** §4.1 — `device` is NOT optional: it is always written, `null` when unknown. */
  source: { app: string; end: string; version: string; device: string | null };
  count: number;
  has_attachments: boolean;
  scope: { kind: string; truncated_before?: string };
}

/** A record line (§4.2). `source_ext` is the end-specific pocket; everything else is the
 *  cross-end core. */
export interface FprEntry {
  fpr: number;
  kind: 'entry';
  id: string;
  created_at: string;
  entry_type: string;
  mode: string;
  source_text: string | null;
  output_text: string | null;
  status: string;
  duration_ms: number | null;
  window_title: null;
  attachment: string | null;
  source_ext: Record<string, unknown>;
  [k: string]: unknown;
}

/** Fields this end preserved verbatim from a file it imported, so a re-export
 *  writes them back unchanged (§5.4). Two buckets because the two live at two
 *  levels of the record and must not be flattened into each other. */
export interface Preserved {
  /** Unknown TOP-LEVEL keys (a future version's fields). */
  top: Record<string, unknown>;
  /** The whole `source_ext` as it arrived — including keys this build's rows
   *  cannot hold (see [[rowToEntry]]'s note on `inject_target`). */
  ext: Record<string, unknown>;
}

/** Header for an export of `count` rows.
 *
 *  🔴 `device` IS WRITTEN AS EXPLICIT `null` WHEN THIS PC'S NAME COULD NOT BE
 *  READ — never omitted, and never a placeholder (§4.1, identical verbatim on both ends). Same
 *  criterion as `window_title` in §4.2: writing `null` says「这个字段存在且我们
 *  没有它」("this field exists and we don't have it"), while omitting it lets a reader think an older version simply did
 *  not write it. ⚠️ The reason this is a RULE rather than a preference is that
 *  both spellings are defensible — and 一份 schema 三个消费者, 讲得通的做法有两种
 *  就等于没有规则 ("one schema, three consumers — having two defensible approaches is the same as having no rule")
 *  (main control 2026-08-01 ruling before the merge; the two ends had diverged). */
export function buildHeader(input: {
  now: Date;
  version: string;
  device: string | null;
  count: number;
  hasAttachments: boolean;
  /** 🔴 §4.1 — the instant everything older than which this PC has already
   *  dropped (TimelineStore.retention.cutoff). `null` = nothing was ever
   *  evicted, and the field is then ABSENT: §4.1「不知道就不写这个字段，绝不许写
   *  一个猜的时刻」("if you don't know, don't write this field — never write a guessed instant"). */
  truncatedBefore: string | null;
}): FprHeader {
  return {
    fpr: FPR_VERSION,
    kind: 'header',
    exported_at: input.now.toISOString(),
    source: {
      app: 'flowmic',
      end: THIS_END,
      version: input.version,
      // §4.1 — explicit `null`, never an omitted key and never a placeholder name.
      device: input.device === null || input.device === '' ? null : input.device,
    },
    count: input.count,
    has_attachments: input.hasAttachments,
    scope: {
      kind: 'all',
      ...(input.truncatedBefore !== null ? { truncated_before: input.truncatedBefore } : {}),
    },
  };
}

/** One timeline row → one record line (§4.2).
 *
 *  ── WHAT GOES IN `source_ext`, AND WHY NOT AT THE TOP ────────────────────
 *  §4.2: end-specific fields always go into `source_ext`, because flattening them into
 *  the top level would collide names, and would also make MCP consumers think
 *  they are generic fields. For this end that is: which server carried the row
 *  (`channel` — half of a PC row's ADDRESS, RV-01), the injection provenance
 *  (`inject_target`), 🔴 the focus observation of the attempt (`focus_process` /
 *  `focus_evidence` — IJ-01; see the block beside them in [[rowToEntry]] for why
 *  they are in and why no window title is), the two sender identities (`mobile_id` /
 *  `device_label`), the local-edit bit, `updated_at`, the inline thumbnail, and
 *  whether the delivered picture was kept.
 *
 *  `duration_ms` — since 0.2.43 the delivery frame CAN carry the phone's
 *  engine-reported duration (`inject:request.duration_ms`, additive optional,
 *  owner「语音时长要找回来」("the speaking duration needs to be recovered")), so the row's own value is written through. Still
 *  null on every row that never had one (typed/manual/image, pre-0.2.43 frames,
 *  frames that crossed an old relay) — null means 「没有」("absent"), and deriving a number
 *  from character counts or timestamp gaps would be 「把不知道的说成知道的」("passing off the unknown as the known").
 *
 *  🔴 `window_title` — the three rules of §4.2 (identical verbatim on both ends after the 2026-08-01 correction):
 *  ① The top level is always `null`. It is a DECLARATION SLOT: 「这个格式有这个字段，而这一行
 *     不在这里回答它」("this format has this field, and this row does not answer it here"). Constant ⇒ it is impossible for the two ends to
 *     have two different meanings; an MCP consumer reading the top level always gets
 *     the same answer;
 *  ② The real value goes into `source_ext.inject_target` — the key name must be identical on both ends,
 *     **one end may not call it `target` while the other calls it `inject_target`**
 *     (`inject_target` is this repo's existing vocabulary);
 *  ③ It is not dropped wholesale over privacy worries: owner's worry there governs the **scenario-inference
 *     collection surface on the way up** (`INFERENCE_COLLECTED_FIELDS`), not「这个应用从来不知道窗口标题」("this app never knew the window title") — the desktop
 *     genuinely knows it and already renders it to the user (lib/inject-provenance.ts). The export is the user's OWN
 *     copy, to a destination the user picks, already plainly stated as「谁拿到都能看」("whoever gets it can read it") ⇒ dropping it would be cutting
 *     one's own team's backup, not protecting anyone. The two have different threat models. */
export function rowToEntry(
  row: TimelineRow,
  attachment: string | null,
  preserved: Preserved | null,
): FprEntry {
  const carried = preserved?.ext ?? {};
  const ext: Record<string, unknown> = {
    ...carried,
    channel: row.channel,
    updated_at: row.updated_at,
    edited: row.edited,
    full_image: row.full_image,
    mobile_id: row.mobile_id,
    device_label: row.device_label,
    thumb_b64: row.thumb_b64,
  };
  // 🔴 IJ-01 — 「`focus_process` / `focus_evidence` 进不进导出」("does focus_process /
  // focus_evidence go into the export") IS ANSWERED HERE AND
  // EXPLICITLY, because design doc §4-5 implementation-boundary 3 forbids letting it default-inherit.
  // ✅ THEY GO IN (main control's ruling). Two reasons, and the second is the operative one:
  //   ① they are facts ABOUT THE ROW — 「这一条对着 chrome，凭据是 unknown」("this row was aimed at chrome, the evidence is unknown") — of the
  //      same kind as `inject_target`, which has always been exported;
  //   ② doc 16's export is the user's OWN copy, to a destination the user picks, and
  //      §4.2 ③ already settled that a privacy worry about the INFERENCE UPLINK
  //      (`INFERENCE_COLLECTED_FIELDS`) is not a reason to cut a field out of the
  //      user's own backup — the two have different threat models.
  //
  // 🔴 AND THE WINDOW TITLE IS NOT HERE — not because export is dangerous, but because
  // THE ROW DOES NOT HAVE ONE. owner 2026-08-07 ruling (c) kept titles off the durable
  // record for the failure/cached path, so `focus_process` is all this end ever held.
  // ⚠️ That is NOT a contradiction of §4.2 ③ above: `inject_target.window_title` on a
  // SUCCESSFUL row is still exported, exactly as it always was. The asymmetry is the
  // ruling (design doc §4-5 implementation-boundary 2), and writing it down here is the point — a reader who
  // finds titles on some rows and not others must not have to guess which of the two
  // rules is being applied.
  //
  // Precedence mirrors `inject_target` below: live row → whatever an imported file
  // carried → explicit null. Without the middle term a re-export would DESTROY a
  // preserved value, because import.ts cannot take these back onto a row (they are
  // written only by `onInjectResult`) — §5.4.
  ext.focus_process = row.focus_process ?? carried.focus_process ?? null;
  ext.focus_evidence = row.focus_evidence ?? carried.focus_evidence ?? null;
  // §4.2 ②: the key is `inject_target` on BOTH ends — and 🔴 it is ALWAYS
  // WRITTEN, as an explicit `null` when this row has no delivery target.
  //
  // ⚠️ THIS OVERTURNS AN EARLIER CALL OF MINE, and the mistake is worth keeping
  // because it is a shape, not a slip. I reasoned: an empty `{}` would CLAIM
  // 「有一个投递目标，只是字段都空着」("there is a delivery target, its fields are just all empty"), which is a lie ⇒ so omit the key. The first
  // half was right; the conclusion skipped a THIRD option. `null` neither claims
  // nor equivocates — it says exactly 「这个键存在，而这一行没有它」("this key exists, and this row does not have it"), which is the
  // criterion §4.2 had already settled one paragraph up for top-level
  // `window_title`. Two answers to one question inside one document is this
  // repo's #1 bug shape wearing a document for a costume (main control's 2026-08-01 ruling,
  // after diffing the two ends' sample output field by field).
  //
  // AND `inject_target` IS NO LONGER end-specific: it lives in the `source_ext` pocket,
  // but its NAME is now mandated identical on both ends ⇒ 「不存在时怎么写」("how to write it when absent") must
  // have exactly one answer too.
  //
  // Precedence: the live row wins; else whatever an imported file carried (this
  // store cannot take an inject target back in — the row-minting entry point has
  // no such field, see lib/portable/import.ts); else explicit null. Without the
  // middle term, writing `null` unconditionally would DESTROY a preserved value
  // on the second round trip — the file would stop reporting a delivery
  // destination it really did record (§5.4).
  ext.inject_target = row.target ?? carried.inject_target ?? null;
  return {
    ...(preserved?.top ?? {}),
    fpr: FPR_VERSION,
    kind: 'entry',
    id: row.id,
    created_at: row.created_at,
    entry_type: row.entry_type,
    mode: row.mode,
    source_text: row.source_text,
    output_text: row.output_text,
    status: row.status,
    duration_ms: row.duration_ms ?? null,
    window_title: null,
    attachment,
    source_ext: ext,
  };
}

/** One JSON value per line, no trailing newline (the writer adds it). */
export function serializeLine(v: unknown): string {
  return JSON.stringify(v);
}

/** The header of a file being imported, or why the file is refused. */
export function readHeader(line: string): { header: FprHeader } | { refusal: FileRefusal } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { refusal: { kind: 'no_header' } };
  }
  if (v === null || typeof v !== 'object') return { refusal: { kind: 'no_header' } };
  const o = v as Record<string, unknown>;
  if (o.kind !== 'header') return { refusal: { kind: 'no_header' } };
  if (typeof o.fpr !== 'number') return { refusal: { kind: 'no_header' } };
  if (o.fpr !== FPR_VERSION) {
    return { refusal: { kind: 'unsupported_version', found: o.fpr } };
  }
  const src = (o.source ?? null) as Record<string, unknown> | null;
  const end = typeof src?.end === 'string' ? src.end : '';
  // §5.3 — this round's boundary: only accept files exported by the same end, and speak plainly when refusing.
  if (end !== THIS_END) return { refusal: { kind: 'wrong_end', end } };
  return {
    header: {
      fpr: o.fpr,
      kind: 'header',
      exported_at: typeof o.exported_at === 'string' ? o.exported_at : '',
      source: {
        app: typeof src?.app === 'string' ? src.app : '',
        end,
        version: typeof src?.version === 'string' ? src.version : '',
        // An older file that OMITTED the key and a new one that wrote `null`
        // both mean「没有设备名」("no device name"), so both narrow to null. The distinction the
        // rule protects is on the WRITE side (§4.1) — a reader that treated a
        // missing key as a different state would just re-create the ambiguity.
        device: typeof src?.device === 'string' && src.device !== '' ? src.device : null,
      },
      count: typeof o.count === 'number' ? o.count : -1,
      has_attachments: o.has_attachments === true,
      scope: (o.scope ?? { kind: 'all' }) as FprHeader['scope'],
    },
  };
}

/** A record line, narrowed onto what this end's store can take in.
 *
 *  Field-by-field, never a cast: a hand-written type predicate is an assertion
 *  the compiler does not check (RV-新A ⑤), and this input is a FILE — the least
 *  trusted thing this app reads. */
export function readEntry(
  line: string,
): { item: WireHistoryItem; channel: ChannelTag; attachment: string | null; preserved: Preserved }
  | { refusal: RefusalReason } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { refusal: 'not_json' };
  }
  if (v === null || typeof v !== 'object') return { refusal: 'not_json' };
  const o = v as Record<string, unknown>;
  if (o.fpr !== FPR_VERSION) return { refusal: 'unsupported_version' };
  if (o.kind !== 'entry') return { refusal: 'unknown_kind' };
  if (typeof o.id !== 'string' || o.id === '') return { refusal: 'no_id' };
  if (typeof o.created_at !== 'string' || Number.isNaN(Date.parse(o.created_at))) {
    return { refusal: 'bad_created_at' };
  }
  if (typeof o.mode !== 'string' || !MODES.has(o.mode)) return { refusal: 'bad_mode' };
  if (typeof o.status !== 'string' || !STATUSES.has(o.status)) return { refusal: 'bad_status' };
  if (o.entry_type !== 'transcript' && o.entry_type !== 'image') {
    return { refusal: 'bad_entry_type' };
  }
  const ext = (o.source_ext !== null && typeof o.source_ext === 'object'
    ? (o.source_ext as Record<string, unknown>)
    : {});
  const channel = ext.channel === 'lan' || ext.channel === 'cloud' ? ext.channel : null;
  // A PC row without its channel has no ADDRESS (RV-01: two servers mint ids
  // independently), so it cannot be placed. Refused by name rather than parked
  // on a guessed channel — guessing is exactly what RV-01 exists to stop.
  if (channel === null) return { refusal: 'no_channel' };

  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const item: WireHistoryItem = {
    id: o.id,
    mode: o.mode as WireHistoryItem['mode'],
    status: o.status as WireHistoryItem['status'],
    edited: ext.edited === true,
    source_text: typeof o.source_text === 'string' ? o.source_text : null,
    output_text: str(o.output_text),
    created_at: o.created_at,
    updated_at: typeof ext.updated_at === 'string' ? ext.updated_at : o.created_at,
    entry_type: o.entry_type,
    ...(typeof ext.thumb_b64 === 'string' && ext.thumb_b64 !== ''
      ? { thumb_b64: ext.thumb_b64 }
      : {}),
    ...(ext.full_image === true ? { full_image: true } : {}),
    ...(typeof ext.mobile_id === 'string' && ext.mobile_id !== ''
      ? { mobile_id: ext.mobile_id }
      : {}),
    ...(typeof ext.device_label === 'string' && ext.device_label !== ''
      ? { device_label: ext.device_label }
      : {}),
    // 0.2.43 — the top-level FPR field, read back onto the row. Non-negative
    // integers only; anything else stays absent (⇒ null after normalisation).
    ...(typeof o.duration_ms === 'number' && Number.isInteger(o.duration_ms) && o.duration_ms >= 0
      ? { duration_ms: o.duration_ms }
      : {}),
  };
  return {
    item,
    channel,
    attachment: typeof o.attachment === 'string' && o.attachment !== '' ? o.attachment : null,
    preserved: { top: unknownTop(o), ext },
  };
}

/** The top-level keys this build does not know about (§5.4). They are kept so a
 *  file written by a NEWER version survives a round trip through this one. */
const KNOWN_TOP = new Set([
  'fpr', 'kind', 'id', 'created_at', 'entry_type', 'mode', 'source_text',
  'output_text', 'status', 'duration_ms', 'window_title', 'attachment', 'source_ext',
]);

function unknownTop(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (!KNOWN_TOP.has(k)) out[k] = o[k];
  return out;
}
