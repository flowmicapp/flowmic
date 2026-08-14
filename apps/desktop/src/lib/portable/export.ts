// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (container), §4 (records.jsonl),
//     §8 (streaming + the estimated size must be genuinely computed)
//
// Export = walk + serialize (overarching design §1). The walk is lib/portable/inventory.ts and is
// NOT re-implemented here; this module is the serialize half plus the plan the Rust
// writer executes.

import { addressOf } from '../timeline-address';
import type { TimelineRow } from '../types';
import { buildHeader, rowToEntry, serializeLine, type FprHeader } from './fpr';
import {
  summarize,
  utf8Bytes,
  walkAssets,
  type AssetRow,
  type Inventory,
  type PictureFact,
} from './inventory';
import type { PreservedFields } from './preserved';

/** One archive member carrying a row's picture. */
export interface PlannedAttachment {
  row_id: string;
  /** `att/<sha256-16>.<ext>` (§3). */
  name: string;
}

export interface ExportPlan {
  /** `records.jsonl`, one element per line, header first. */
  lines: string[];
  attachments: PlannedAttachment[];
  /** 🔴 §8-2 — THE SIZE, COMPUTED. Not a guess: every term below is a measured
   *  byte count (see [[archiveBytes]]). */
  bytes: number;
  /** The walk's answer, so the page can state row count / text / picture counts from the SAME
   *  pass that produced the lines. */
  inventory: Inventory;
  header: FprHeader;
  /** The `README.txt` this plan's [[bytes]] accounts for — hand it to the
   *  writer verbatim. */
  readme: string;
}

export interface ExportInput {
  rows: readonly TimelineRow[];
  /** What Rust measured for every row that has a picture. */
  pictures: ReadonlyMap<string, PictureFact>;
  /** Content hashes, when they have been computed. ABSENT at estimate time —
   *  see [[PLACEHOLDER_SHA]]. */
  digests?: ReadonlyMap<string, string>;
  /** owner 2026-08-01 ruling 5 — the user's tick. `false` ⇒ in the header
   *  `has_attachments:false`, no `att/`, and image rows keep `attachment:null`
   *  (§8-3 ⚠️ the row itself is still exported as usual, it is not that the whole
   *  image row gets dropped). */
  includePictures: boolean;
  /** From apps/desktop/package.json via lib/version.ts — §4.1「不许硬编码」("must not be hardcoded"). */
  version: string;
  /** This PC's name, or null when it could not be read. */
  device: string | null;
  now: Date;
  /** TimelineStore.retention.cutoff. */
  truncatedBefore: string | null;
  preserved: PreservedFields;
  /** 🔴 A FUNCTION, not a string, and that is what keeps the size honest: the
   *  README quotes the header (§3 ④ export timestamp and row count) and the header is not known
   *  until the lines have been built, so a caller-supplied string would either
   *  be built from stale numbers or leave [[ExportPlan.bytes]] describing a
   *  README that is not the one written. */
  readme: (header: FprHeader) => string;
}

/** The stand-in used while ESTIMATING, before the pictures have been hashed.
 *
 *  🔴 It is exactly as long as a real digest, which is what makes the estimate
 *  EXACT rather than approximate: `att/<16 hex>.<ext>` has a fixed length once
 *  the extension is known, and the extension comes from the same `find_in` call
 *  on both passes. One builder, two callers, no second size model to drift
 *  (§8-2:「一个假的体积数字和一个假的进度条是同一种东西」("a fake size number and a fake progress bar are the same kind of thing")). */
export const PLACEHOLDER_SHA = '0000000000000000';

/** Rows oldest-first. A file people read top-to-bottom should start at the
 *  beginning — and it matches the batch-copy ruling (owner 2026-08-01: ascending by time). */
function chronological(assets: readonly AssetRow[]): AssetRow[] {
  return [...assets].sort((a, b) => (a.row.created_at < b.row.created_at ? -1 : 1));
}

/** The archive's exact size, from the zip layout portable/zip.rs writes.
 *
 *  Local header 30 + name, then the body; central record 46 + name; EOCD 22. No
 *  extra fields, no comment, no compression — which is precisely why this can be
 *  computed instead of guessed. */
export function archiveBytes(members: ReadonlyArray<{ name: string; bytes: number }>): number {
  let n = 22;
  for (const m of members) {
    const nameLen = utf8Bytes(m.name);
    n += 30 + nameLen + m.bytes + 46 + nameLen;
  }
  return n;
}

/** Build everything an export needs. Pure: no I/O, no clock of its own. */
export function planExport(input: ExportInput): ExportPlan {
  const assets = chronological(walkAssets(input.rows, input.pictures));
  const inventory = summarize(assets);

  const attachments: PlannedAttachment[] = [];
  const entryLines: string[] = [];
  for (const a of assets) {
    let name: string | null = null;
    // A row gets an attachment only when the user asked for pictures AND this
    // row really has one on disk. `entry_type === 'image'` alone is not enough:
    // a picture row whose bytes were not kept has nothing to carry, and naming
    // a member that will not exist is a file that lies about itself.
    if (input.includePictures && a.pictureExt !== null && a.pictureBytes > 0) {
      const sha = input.digests?.get(a.row.id) ?? PLACEHOLDER_SHA;
      name = `att/${sha}.${a.pictureExt}`;
      attachments.push({ row_id: a.row.id, name });
    }
    // ONE spelling of「哪一行」("which row") — see lib/timeline-address.ts.
    entryLines.push(serializeLine(rowToEntry(a.row, name, input.preserved.get(addressOf(a.row)))));
  }

  const header = buildHeader({
    now: input.now,
    version: input.version,
    device: input.device,
    // §4.1「count 必须与实际行数相等; 不等 = 导出撒谎」("count must equal the actual row count; a mismatch = the export is lying") — derived from the lines
    // that were just built, never from a count taken earlier.
    count: entryLines.length,
    // §8-3: false when the user unticked, AND false when there is genuinely
    // nothing to carry — 「有 att/ 目录但它是空的」("having an att/ directory that is empty") would be a third state nobody
    // asked for. §3 says the directory exists only「且真的有图片时」("and only when there really are pictures").
    hasAttachments: attachments.length > 0,
    truncatedBefore: input.truncatedBefore,
  });
  const lines = [serializeLine(header), ...entryLines];
  const readme = input.readme(header);

  // Deduped by NAME, exactly as portable::archive::write_export does — the size
  // has to describe the archive that will really be written, and two rows
  // sharing a picture share one member (§3).
  const seen = new Set<string>();
  const members: Array<{ name: string; bytes: number }> = [
    { name: 'records.jsonl', bytes: lines.reduce((n, l) => n + utf8Bytes(l) + 1, 0) },
    { name: 'README.txt', bytes: utf8Bytes(readme) },
  ];
  for (const at of attachments) {
    if (seen.has(at.name)) continue;
    seen.add(at.name);
    members.push({ name: at.name, bytes: input.pictures.get(at.row_id)?.bytes ?? 0 });
  }

  return { lines, attachments, bytes: archiveBytes(members), inventory, header, readme };
}

/** The suggested file name (§3 `flowmic-export-<end>-<YYYYMMDD-HHMMSS>.zip`).
 *
 *  A NAME only — never a directory. §7-2 forbids defaulting the destination, so
 *  the picker opens wherever the shell last left the user and they choose. */
export function suggestedFileName(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const s = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `flowmic-export-desktop-${s}.zip`;
}
