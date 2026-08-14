// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.2 (clearing — five hard constraints)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-21 (a single-row delete
//     must not delete bytes), G-17 / RV-96 (storage grows monotonically; this module is
//     where that gets closed off)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §5-4/-5/-6
//
// 🔴 THE ONE DELETER. Every row that leaves this PC leaves through [purge].
//
// ── WHY A MODULE AND NOT THREE CALL SITES ───────────────────────────────────
// The umbrella design doc §5-6, verbatim: "user-triggered clear and automatic trimming
// are two triggers for the SAME delete implementation; there must not be two separate
// deletion code paths (otherwise 'is it really all gone' has two different answers)".
// That is not a style preference — the repo had already paid for the second path
// before this file existed:
//
//   automatic trimming (TimelineStore.evict)  dropped the row AND its picture file ✅
//   user single-row delete (TimelineStore.remove) dropped the row and LEFT the picture ❌  ← G-21
//
// One question ("are this row's bytes gone?"), two answers, and the wrong one was the
// one the user reaches by tapping Delete. So the three TRIGGERS stay separate and the
// DELETER is this function. A fourth trigger tomorrow inherits the fix by construction.
//
// ── WHAT IT DELETES ─────────────────────────────────────────────────────────
// A desktop row owns two things: itself, and — for a picture row that kept its
// delivered bytes (`full_image`) — a FILE beside the forensic log. Both go. The
// remembered image-id chip goes with them, because a chip for a row that no longer
// exists is a claim about nothing.
//
// ⚠️ The phone additionally owns a third thing (the unknown-field vault, book 16 §9b-4);
// the desktop has no such side table — its carried fields ride on the row itself
// (lib/portable/preserved.ts) and therefore die with it. Stated because the two ends'
// deleters look asymmetric and the asymmetry is real, not an omission.

import type { TimelineRow } from './types';

/** WHICH KIND of row a clear is about (owner 2026-08-01 §4-4: "clear transcript text /
 *  clear images — the two can be exercised independently"). `both` is what automatic
 *  trimming does — it is about capacity, not kind. */
export type ClearKind = 'text' | 'images' | 'both';

/** owner's five time buckets (§4-4), plus the sixth that is NOT his and is marked as
 *  such everywhere it appears.
 *
 *  🔴 `all` is a LEAD CONTROLLER ASSUMPTION pending owner's B5 answer
 *  (`docs/decisions/2026-08-02-b5-stats-list-and-clear-all-options.md` §2), NOT a
 *  ruling. owner listed five buckets and "older than a week" does not include the last
 *  week, so as specified there is no way to empty the timeline at all — which the
 *  device-switch / privacy scenarios need. It ships behind the same confirmation as
 *  the rest and is trivially removable (delete the entry; `horizonOf` and the UI are
 *  data-driven off this list). */
export const CLEAR_WINDOWS = ['week', 'month', 'quarter', 'halfYear', 'year', 'all'] as const;
export type ClearWindow = (typeof CLEAR_WINDOWS)[number];

/** Days per bucket. FIXED DAY COUNTS, not calendar arithmetic, on purpose: "older than
 *  three months" has to mean the same span in February as in July, and a deletion the user cannot
 *  predict the extent of is worse than one that is a few days off their intuition. */
const WINDOW_DAYS: Record<Exclude<ClearWindow, 'all'>, number> = {
  week: 7,
  month: 30,
  quarter: 90,
  halfYear: 182,
  year: 365,
};

/** The instant a bucket points at: rows STRICTLY older than it are in scope.
 *  `null` for `all` — "there is no lower bound", which is a different thing from "the
 *  lower bound is now" and is why this returns null rather than
 *  `new Date(now).toISOString()`. */
export function horizonOf(window: ClearWindow, nowMs: number): string | null {
  if (window === 'all') return null;
  return new Date(nowMs - WINDOW_DAYS[window] * 86_400_000).toISOString();
}

/** Whether a row is in scope for `kind`.
 *
 *  A picture row is "an image" whatever its text says, and a transcript row is "text" —
 *  the split is `entry_type`, the same field the export's two-way choice and the
 *  timeline's chip read, so a row cannot be one kind here and another kind there. */
function inKind(row: TimelineRow, kind: ClearKind): boolean {
  if (kind === 'both') return true;
  return kind === 'images' ? row.entry_type === 'image' : row.entry_type !== 'image';
}

/** THE SELECTOR for the user's trigger: which rows a clear would remove.
 *
 *  Pure and separate from [purge] so the confirmation dialog can ask "what will this
 *  delete" and get the SAME answer the deletion will act on — book 16 §6.2-5: "must
 *  not multiply a row count by an average". The dialog counts these rows; the deleter
 *  deletes these rows.
 *
 *  A row with no usable `created_at` (`''`, possible on a row normalised from an
 *  ancient cache) is NEVER selected by a time-bounded clear: it would compare below
 *  every real instant and be swept up by "older than a year" while genuinely being of
 *  unknown age. It IS selected by `all`, which makes no claim about age. */
export function planClear(
  all: readonly TimelineRow[],
  kind: ClearKind,
  olderThan: string | null,
): TimelineRow[] {
  return all.filter((r) => {
    if (!inKind(r, kind)) return false;
    if (olderThan === null) return true;
    return r.created_at !== '' && r.created_at < olderThan;
  });
}

/** "Everything before this instant is gone" — per kind, because a type-filtered clear
 *  cannot honestly claim anything about the kind it did not touch.
 *
 *  🔴 THIS IS THE STRUCTURE THAT KEEPS "cleared ≠ never existed" TRUE (umbrella design
 *  doc §5-5) WITHOUT OVER-CLAIMING. One scalar cutoff was right while the only deleter
 *  was capacity eviction (which drops rows regardless of kind). Clearing only pictures
 *  and then advancing that one scalar would tell the user "records before X have all
 *  been cleared" while every transcript from that period is still on screen — a lie
 *  the old shape could not even express. */
export interface Cutoffs {
  /** Newest transcript instant this PC has dropped, ever. `null` = never dropped one. */
  text: string | null;
  /** Newest picture instant this PC has dropped, ever. */
  images: string | null;
}

export const NO_CUTOFFS: Cutoffs = { text: null, images: null };

/** The one sentence the page has always shown: "everything (any record) before X has
 *  been cleared".
 *
 *  = the OLDER of the two per-kind marks, and `null` unless BOTH are known: if
 *  pictures have been dropped back to March but no transcript ever has, there is no
 *  instant before which everything is gone. Under-claiming on purpose — the page
 *  falls back to the per-kind lines, which are true. */
export function combinedCutoff(c: Cutoffs): string | null {
  if (c.text === null || c.images === null) return null;
  return c.text < c.images ? c.text : c.images;
}

/** Read the persisted shape, tolerating the pre-C2 one.
 *
 *  0.2.37 and earlier wrote `{cutoff: "<iso>"}` — a single scalar written ONLY by
 *  capacity eviction, which drops both kinds. So an old value maps to BOTH marks, and
 *  that is a faithful translation rather than a guess: at the moment it was written,
 *  every kind older than it really had been dropped. */
export function readCutoffs(raw: unknown): Cutoffs {
  const o = raw as { cutoff?: unknown; text?: unknown; images?: unknown } | null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const legacy = str(o?.cutoff);
  if (legacy !== null && o?.text === undefined && o?.images === undefined) {
    return { text: legacy, images: legacy };
  }
  return { text: str(o?.text), images: str(o?.images) };
}

/** Push the marks forward by what was actually dropped.
 *
 *  Only ever forward (a later deletion cannot un-delete an earlier one), and only for
 *  kinds this deletion really covered. `advance === null` is a SINGLE-ROW delete: the
 *  user removing one line says nothing about everything older than it, so the marks do
 *  not move — that is the difference between "I deleted this one" and "everything
 *  before it is gone". */
export function advanceCutoffs(
  current: Cutoffs,
  dropped: readonly TimelineRow[],
  advance: ClearKind | null,
): Cutoffs {
  if (advance === null || dropped.length === 0) return current;
  // 🔴 `both` uses the newest instant across ALL dropped rows for BOTH marks, NOT each
  // kind's own newest — and that asymmetry with the filtered case is the whole point.
  // A kind-blind deletion (capacity eviction, or an "all" clear) removes everything
  // older than its newest casualty WHATEVER KIND it was, so both marks are earned even
  // when the batch happened to contain only transcripts. Taking each kind's own newest
  // here would leave `images` null on a transcript-only eviction and silently retire the
  // "everything before X has been cleared" line that has shipped since 0.2.26.
  const newest = (kind: ClearKind): string | null => {
    let max: string | null = null;
    for (const r of dropped) {
      if (r.created_at === '' || !inKind(r, kind)) continue;
      if (max === null || r.created_at > max) max = r.created_at;
    }
    return max;
  };
  const bump = (cur: string | null, mark: string | null): string | null =>
    mark !== null && (cur === null || mark > cur) ? mark : cur;
  if (advance === 'both') {
    const mark = newest('both');
    return { text: bump(current.text, mark), images: bump(current.images, mark) };
  }
  return {
    text: advance === 'images' ? current.text : bump(current.text, newest('text')),
    images: advance === 'text' ? current.images : bump(current.images, newest('images')),
  };
}

/** What [purge] mutates. A narrow view of the store rather than the store itself, so
 *  this module never learns about persistence, listeners or search — and so a test can
 *  hand it two plain collections. */
export interface PurgeSink {
  /** Keyed by `rowKey(channel, id)`, exactly as TimelineStore holds them. */
  rows: Map<string, TimelineRow>;
  /** The remembered image-id chips (R6 T-4). */
  imageIds: Set<string>;
  /** Delete these rows' picture FILES. Ids are bare row ids — both channels share one
   *  picture directory (`row_image.rs`). */
  dropPictures(ids: readonly string[]): void;
  /** `rowKey`, injected so this module does not import the address rules it does not
   *  own. */
  keyOf(row: TimelineRow): string;
}

/** What one deletion did — for the caller to report, never to guess at. */
export interface PurgeResult {
  /** Rows actually removed (a row named twice, or already gone, counts once). */
  removed: number;
  /** Picture FILES this deletion asked the filesystem to drop. ≤ [removed], and the
   *  gap is real: a picture row whose bytes were never kept has none. */
  picturesDropped: number;
  /** The marks after this deletion. */
  cutoffs: Cutoffs;
}

/** 🔴 THE DELETER. Nothing else in the desktop removes a timeline row.
 *
 *  It is deliberately NOT responsible for persisting or notifying: the callers already
 *  own a `persist()`/`notify()` pair with their own ordering rules (eviction runs
 *  INSIDE persist, so a persist here would recurse). What it IS responsible for is
 *  that every byte belonging to a removed row goes with it. */
export function purge(
  sink: PurgeSink,
  doomed: readonly TimelineRow[],
  advance: ClearKind | null,
  cutoffs: Cutoffs,
): PurgeResult {
  if (doomed.length === 0) return { removed: 0, picturesDropped: 0, cutoffs };
  const gone: TimelineRow[] = [];
  for (const r of doomed) {
    const key = sink.keyOf(r);
    if (!sink.rows.has(key)) continue;
    sink.rows.delete(key);
    gone.push(r);
  }
  if (gone.length === 0) return { removed: 0, picturesDropped: 0, cutoffs };
  // The chip goes with the row it describes — for EVERY removed row, not only picture
  // ones: the set is keyed by bare id and is what makes a row render as an image, so a
  // leftover entry would re-label a future row that happens to reuse the id.
  for (const r of gone) sink.imageIds.delete(r.id);
  // 🔴 G-21's fix. `full_image` is the WRITE's own verdict that bytes were kept, so
  // this asks the filesystem only about files that exist — and asks for EVERY removal
  // path, which is the whole point of there being one deleter.
  const pics = [...new Set(gone.filter((r) => r.full_image).map((r) => r.id))];
  if (pics.length > 0) sink.dropPictures(pics);
  return {
    removed: gone.length,
    picturesDropped: pics.length,
    cutoffs: advanceCutoffs(cutoffs, gone, advance),
  };
}
