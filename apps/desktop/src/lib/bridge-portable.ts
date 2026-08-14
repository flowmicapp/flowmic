// Portable Record Format FPR v1's IPC gate (docs/rebuild/16) — export / import / picture bytes.
//
// ── WHY THIS CUT, AND NOT ANOTHER ONE ────────────────────────────────────────
//
// Split out of `bridge.ts` when the 800-line src cap bit (the same move that
// produced `capsule-copy.ts` and, in Rust, `inject/preflight.rs`). 🔴 NOTHING
// CHANGED IN THE MOVE — every line below is the verbatim text that was in
// bridge.ts, and any diff beyond a "move" (搬移) would be a bug in this split rather than a
// change anyone asked for.
//
// The knife goes where the RULES differ, not at the midpoint of the file:
//
//   · bridge.ts — the LIVE product surface. Its doors are fire-and-forget or
//     degrade-to-a-safe-default, because a down bridge there must still leave a
//     renderable UI (`invokeSafe` folds every rejection into `undefined` + a
//     console.warn, and every caller has a documented "outside Tauri" reading).
//   · this file — the FILE-SYSTEM doors, whose standing rule is the opposite one
//     and is written out below: "THE TWO FAILING COMMANDS DO NOT REJECT — they
//     answer with a verdict object", precisely because `invokeSafe`'s single
//     `undefined` cannot tell "the file is in use" (文件被占用) from "this isn't a zip" (这不是一个 zip) from "this file
//     has been compressed" (这份文件是压缩过的), and book 16 §5.2 requires a partial restore to SAY it is partial.
//
// ⚠️ IT IMPORTS `invokeSafe` FROM bridge.ts AND IS NOT RE-EXPORTED BACK. A
// re-export would have kept the three call sites untouched and created
// bridge → bridge-portable → bridge, which `verify:lint circular` fails on. The
// three consumers (DataPortability.vue / TimelineClear.vue / TimelineStats.vue)
// import from here instead — one edge, one direction.

import { invokeSafe } from './bridge';

// ── Portable Record Format FPR v1: export / import (docs/rebuild/16) ──────────────────────────
//
// The FORMAT lives in lib/portable/; these are only the doors to the bytes Rust
// holds — the row pictures, the zip container, and the file dialog. Every arg is
// a SINGLE WORD on the wire, this boundary's standing rule.
//
// ⚠️ THE TWO FAILING COMMANDS DO NOT REJECT — they answer with a verdict object
// (see src-tauri/src/portable/commands.rs). That is on purpose: `invokeSafe`
// folds every rejection into `undefined` + a console.warn, and "the file is in use" (文件被占用) vs
// "this isn't a zip" (这不是一个 zip) vs "this file has been compressed" (这份文件是压缩过的) need three different sentences.

/** One row's picture, as the filesystem reports it (§6-2 byte count (字节数) / §3 extension (扩展名)). */
export interface PortablePicture {
  id: string;
  bytes: number;
  ext: string;
}

/** Content hash + size for the rows whose pictures are going into an archive. */
export interface PortableDigest extends PortablePicture {
  sha16: string;
}

/** What an export really wrote — counted by Rust, never predicted. */
export interface PortableExportResult {
  path: string;
  records: number;
  attachments: number;
  bytes: number;
}

/** What a `.zip` holds, as far as the file layer can tell. */
export interface PortableArchive {
  lines: string[];
  attachments: string[];
  /** Member names the §3 path-traversal guard refused. Non-empty = say so. */
  refused_names: string[];
}

/** A file-layer verdict. `ok:false` carries a machine tag + a verbatim detail. */
export type PortableOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail: string };

/** Field-by-field, like every other narrowing on this boundary (RV-新A ⑤: a
 *  hand-written predicate is an assertion the compiler never checks). */
function asOutcome<T>(v: unknown, value: (raw: unknown) => T | null): PortableOutcome<T> {
  const bridgeDown = { ok: false as const, error: 'bridge', detail: '' };
  if (v === null || typeof v !== 'object') return bridgeDown;
  const o = v as Record<string, unknown>;
  if (o.ok === true) {
    const narrowed = value(o.value);
    return narrowed === null
      ? { ok: false, error: 'shape', detail: '' }
      : { ok: true, value: narrowed };
  }
  return {
    ok: false,
    error: typeof o.error === 'string' ? o.error : 'unknown',
    detail: typeof o.detail === 'string' ? o.detail : '',
  };
}

/** Sizes for the rows that claim a kept picture. Rows without one are simply
 *  absent — never a `0`, which would read as "has a picture but it's empty" (有图但是空的). */
export async function portablePictureSizes(ids: readonly string[]): Promise<PortablePicture[]> {
  const rows = await invokeSafe<unknown>('portable_picture_sizes', { ids: [...ids] });
  return Array.isArray(rows) ? rows.filter(isPicture) : [];
}

/** Content hashes, computed only when an export is really being written (hashing
 *  every picture just to show an estimate would stall the page). */
export async function portablePictureDigests(ids: readonly string[]): Promise<PortableDigest[]> {
  const rows = await invokeSafe<unknown>('portable_picture_digests', { ids: [...ids] });
  return Array.isArray(rows)
    ? rows.filter((r): r is PortableDigest => isPicture(r) && typeof (r as PortableDigest).sha16 === 'string')
    : [];
}

function isPicture(r: unknown): r is PortablePicture {
  if (r === null || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.bytes === 'number' && typeof o.ext === 'string';
}

/** 🔴 §7-2 —— the ONLY way a destination is chosen. `null` = the user cancelled,
 *  which is a normal answer and must never be surfaced as a failure. */
export async function portablePickSave(
  title: string,
  filter: string,
  suggested: string,
): Promise<string | null> {
  return (await invokeSafe<string | null>('portable_pick_save', { title, filter, suggested })) ?? null;
}

/** Which archive to read. `null` = cancelled. */
export async function portablePickOpen(title: string, filter: string): Promise<string | null> {
  return (await invokeSafe<string | null>('portable_pick_open', { title, filter })) ?? null;
}

/** Write the archive the frontend has finished shaping. */
export async function portableExport(args: {
  path: string;
  lines: string[];
  readme: string;
  attachments: Array<{ row_id: string; name: string }>;
}): Promise<PortableOutcome<PortableExportResult>> {
  const raw = await invokeSafe<unknown>('portable_export', args);
  return asOutcome(raw, (v) => {
    if (v === null || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.path !== 'string' || typeof o.bytes !== 'number') return null;
    return {
      path: o.path,
      records: typeof o.records === 'number' ? o.records : 0,
      attachments: typeof o.attachments === 'number' ? o.attachments : 0,
      bytes: o.bytes,
    };
  });
}

/** Read `records.jsonl` + the attachment inventory out of an archive. */
export async function portableReadArchive(path: string): Promise<PortableOutcome<PortableArchive>> {
  const raw = await invokeSafe<unknown>('portable_read_archive', { path });
  return asOutcome(raw, (v) => {
    if (v === null || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o.lines)) return null;
    const strs = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
    return {
      lines: strs(o.lines),
      attachments: strs(o.attachments),
      refused_names: strs(o.refused_names),
    };
  });
}

/** Put the imported rows' pictures where this PC keeps them. Both halves are
 *  counted so a partial restore can SAY it is partial (§5.2). */
export async function portableRestorePictures(
  path: string,
  items: Array<{ name: string; row_id: string }>,
): Promise<{ landed: number; failed: number }> {
  const raw = await invokeSafe<unknown>('portable_restore_pictures', { path, items });
  if (raw === null || typeof raw !== 'object') return { landed: 0, failed: items.length };
  const o = raw as Record<string, unknown>;
  return {
    landed: typeof o.landed === 'number' ? o.landed : 0,
    failed: typeof o.failed === 'number' ? o.failed : items.length,
  };
}
