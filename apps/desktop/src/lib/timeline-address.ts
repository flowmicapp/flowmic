// SPEC-REF:
//   docs/decisions/2026-07-30-owner… (RV-01: the two channels are two separate
//     servers; `(channel, id)` is what actually addresses a row)
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5.1 (import is idempotent
//     by id — the import needs the same address the store keys by)
//
// A ROW'S ADDRESS. Three declarations, one meaning.
//
// Split out of timeline-store.ts for the reason that file has split twice before
// (its own header: 「it moved to timeline-normalize only because this file hit the
// 800-line cap … One binding, two paths — never a second copy」). Nothing about
// the behaviour changed: `rowKey` / `addressOf` are still re-exported from
// timeline-store.ts, which is where TimelinePage.vue and the capsule import them
// from, so no call site moved.
//
// The export/import layer (lib/portable/) is the third consumer, and the reason this
// is a module rather than a private helper: it builds the same `channel:id`
// string to decide "is this row already in the store", and a second hand-written template
// literal there would be exactly the second implementation of "which row" the
// original comment warns about.

import type { ChannelTag, TimelineRow } from './types';

/** The two channels, as the fixed list every row-wide sweep iterates. Declared once
 *  so "both channels count" cannot silently become "just one" after a refactor. */
export const CHANNELS: readonly ChannelTag[] = ['lan', 'cloud'];

/** A row's ADDRESS as a Map key. Both servers mint their own ids, so an id alone
 *  stopped being an address the moment the store started holding both channels.
 *
 *  The separator cannot introduce an ambiguity: `channel` is one of exactly two fixed
 *  words, so `lan:…` and `cloud:…` can never be read as each other whatever an id
 *  contains. Exported (with [[addressOf]]) because the PAGE needs the same identity
 *  for its `:key` and its selection state — two implementations of "which row" would be
 *  the same class of defect one layer up. */
export function rowKey(channel: ChannelTag, id: string): string {
  return `${channel}:${id}`;
}

/** [[rowKey]] for a row you already hold. */
export function addressOf(row: Pick<TimelineRow, 'channel' | 'id'>): string {
  return rowKey(row.channel, row.id);
}
