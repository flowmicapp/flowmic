// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5 (import: idempotence / each line's outcome must
//     be explainable / same-end admission / unknown fields kept verbatim)
//
// Import — four possible outcomes per line, every one counted; there is no fifth called「静默跳过」("silent skip").

import type { ChannelTag, TimelineRow, WireHistoryItem } from '../types';
import { addressOf, rowKey } from '../timeline-address';
import { readEntry, readHeader, type FileRefusal, type FprHeader, type RefusalReason } from './fpr';
import type { PreservedFields } from './preserved';

/** The slice of TimelineStore this module needs.
 *
 *  🔴 NARROW ON PURPOSE. Importing writes rows through the store's ONE existing
 *  row-minting entry point (`onHistoryUpdated` —「一条入站行 → 一行时间线」("one inbound row → one timeline row") — THE ONLY
 *  WAY A NEW ROW ENTERS THIS STORE), rather than a second writer of its own. An
 *  imported line IS an inbound row, and giving it a private door would give the
 *  timeline two ways to gain a row that could diverge on normalisation, on the
 *  bound, and on persistence. */
export interface ImportTarget {
  hasRow(channel: ChannelTag, id: string): boolean;
  onHistoryUpdated(
    item: WireHistoryItem,
    channel: ChannelTag,
  ): { evictedOnArrival: boolean } | null;
  allRows(): TimelineRow[];
}

/** One line that did not make it, with the reason NAMED (§5.2 red line). */
export interface RefusedLine {
  /** 1-based line number in `records.jsonl`, so a user can go and look. */
  line: number;
  reason: RefusalReason;
}

/** A picture to pull out of the archive, once the rows are decided. */
export interface PictureToRestore {
  name: string;
  row_id: string;
}

export interface ImportReport {
  /** Non-null ⇒ NOTHING was imported and this is why (§5.3 / §4.1). */
  fileRefusal: FileRefusal | null;
  /** N rows added. */
  added: number;
  /** N rows already existed (not re-imported) — §5.1 idempotence. */
  skipped: number;
  /** N lines could not be imported, for reason X. */
  refused: RefusedLine[];
  /** Rows accepted and then dropped by THIS PC's retention bound in the same
   *  write. Not one of §5.2's four outcomes because it is not about the file —
   *  it is this machine saying「我留不下这么多」("I can't hold onto this many"). Reported for the same reason
   *  `RowMintReport.evictedOnArrival` exists: a row that was taken in and lost
   *  must not be counted as added and then vanish. */
  evicted: number;
  /** Rows that named an attachment the archive does NOT contain. A problem. */
  attachmentMissing: number;
  /** Picture rows in a file exported WITHOUT full `att/` members
   *  (`has_attachments:false`, `attachment:null`). 🔴 §5.2: expected, not broken —
   *  separate count from `attachmentMissing`. ⚠️ The UI sentence must NOT say
   *  「只恢复了文字」("only the text was restored"): `thumb_b64` still rides in the row and the timeline paints it
   *  (2026-08-11 owner finding). */
  picturesNotInFile: number;
  /** Handed to Rust after the fact — only for rows that were really added, so a
   *  second import writes no files it does not need. */
  restore: PictureToRestore[];
  /** Header facts worth showing (「这份文件是 2026-08-01 从 <设备> 导出的」("this file was exported from <device> on 2026-08-01")). */
  header: FprHeader | null;
  /** The preserved-field table refused to persist (quota / private mode). The
   *  rows are in; a future re-export would lose the fields this file carried. */
  preserveFailed: boolean;
}

const EMPTY: ImportReport = {
  fileRefusal: null,
  added: 0,
  skipped: 0,
  refused: [],
  evicted: 0,
  attachmentMissing: 0,
  picturesNotInFile: 0,
  restore: [],
  header: null,
  preserveFailed: false,
};

export interface ImportInput {
  /** `records.jsonl`, already split by the Rust reader. */
  lines: readonly string[];
  /** Member names present under `att/` in the archive. */
  archiveAttachments: ReadonlySet<string>;
  target: ImportTarget;
  preserved: PreservedFields;
}

/** Read a file into the timeline.
 *
 *  🔴 §5.1 IDEMPOTENCE IS BY `id`, NOT BY FILE. The judgement is「这一行已经在库里
 *  了吗」("is this row already in the store?") — asking「这个文件我导过吗」("have I imported this file before?") instead would make a user's second import,
 *  after they edited one line, do nothing at all. */
export function applyImport(input: ImportInput): ImportReport {
  const out: ImportReport = { ...EMPTY, refused: [], restore: [] };
  if (input.lines.length === 0) {
    out.fileRefusal = { kind: 'no_header' };
    return out;
  }
  const head = readHeader(input.lines[0]!);
  if ('refusal' in head) {
    out.fileRefusal = head.refusal;
    return out;
  }
  out.header = head.header;

  const body = input.lines.slice(1);
  // §4.1 / §9 —「count 与实际行数不等的文件 ⇒ 具名拒收」("a file whose count does not match the actual row count ⇒ named refusal"). Checked BEFORE anything is
  // written: a file whose own header disagrees with its body is not a file to
  // half-apply.
  if (head.header.count !== body.length) {
    out.fileRefusal = {
      kind: 'count_mismatch',
      declared: head.header.count,
      found: body.length,
    };
    return out;
  }

  for (let i = 0; i < body.length; i++) {
    const parsed = readEntry(body[i]!);
    if ('refusal' in parsed) {
      out.refused.push({ line: i + 2, reason: parsed.refusal });
      continue;
    }
    const { item, channel, attachment, preserved } = parsed;
    if (input.target.hasRow(channel, item.id)) {
      out.skipped += 1;
      continue;
    }
    const mint = input.target.onHistoryUpdated(item, channel);
    if (mint === null) {
      // The store could not address the row. It has exactly one cause (a frame
      // with no usable id), which `readEntry` already refuses — so reaching here
      // means the two narrowings drifted, and it is counted rather than lost.
      out.refused.push({ line: i + 2, reason: 'no_id' });
      continue;
    }
    if (mint.evictedOnArrival) {
      out.evicted += 1;
      continue;
    }
    out.added += 1;
    input.preserved.remember(rowKey(channel, item.id), preserved);

    if (attachment !== null) {
      if (input.archiveAttachments.has(attachment)) {
        out.restore.push({ name: attachment, row_id: item.id });
      } else {
        out.attachmentMissing += 1;
      }
    } else if (item.entry_type === 'image' && !head.header.has_attachments) {
      // Expected: no `att/` member. Thumbnails still arrive via source_ext.
      out.picturesNotInFile += 1;
    }
  }

  const live = new Set(input.target.allRows().map(addressOf));
  out.preserveFailed = !input.preserved.prune(live);
  return out;
}

/** Say "partial success" when it is partial success (§5.2 red line): whether anything at all did NOT happen the
 *  way the file described. The page renders a different sentence for `true` — it
 *  must never be able to say「导入完成」("import complete") over a report with refusals in it. */
export function isPartial(r: ImportReport): boolean {
  return (
    r.refused.length > 0
    || r.evicted > 0
    || r.attachmentMissing > 0
    || r.picturesNotInFile > 0
    || r.preserveFailed
  );
}
