// Split out of timeline-store.ts for the 800-line src cap — the SAME reason
// `asChannelTag` moved to timeline-normalize.ts (see that re-export's comment in
// timeline-store.ts). NOTHING ELSE CHANGED: the block below is byte-identical to
// what sat between `InjectResultMiss` and the storage keys, except that the two
// functions gained `export` so the store can still call them. A diff that shows
// anything else is a bug, not a cleanup.

import type { TimelineRow } from './types';

/** The FROZEN fields of a row this PC already holds, in the order a log line reads
 *  best. Declared once so "which fields an inbound frame is not allowed to change"
 *  cannot quietly become a shorter list:
 *  [[mergeIntoOwnedRow]] freezes by CONSTRUCTION (it builds from the local row), and
 *  this list is what [[refusedBy]] reports on — the two are checked against each other
 *  by the store's tests. */
const FROZEN_ROW_FIELDS = ['output_text', 'source_text', 'edited', 'mode', 'created_at'] as const;

/** Which frozen fields this frame disagreed with. */
export function refusedBy(prev: TimelineRow, incoming: TimelineRow): string[] {
  return FROZEN_ROW_FIELDS.filter((f) => prev[f] !== incoming[f]);
}

/** Build the row that STAYS, from the row this PC already owns.
 *
 *  Built from `prev` rather than from the frame on purpose: a whitelist of what may
 *  change is safe against a field added later, while a blacklist of what to restore
 *  silently admits every new one (that is exactly how the overwrite got in). */
export function mergeIntoOwnedRow(prev: TimelineRow, incoming: TimelineRow): TimelineRow {
  const merged: TimelineRow = { ...prev };
  // ① status — forward only (see onHistoryUpdated).
  if (prev.status !== 'injected') merged.status = incoming.status;
  // ② display backfills — ABSENT → PRESENT only. Each adds an answer where the row had
  //    none, so none of them can contradict anything the user or this machine knows.
  if (prev.thumb_b64 === null && incoming.thumb_b64 !== null) merged.thumb_b64 = incoming.thumb_b64;
  if (prev.device_label === null && incoming.device_label !== null) merged.device_label = incoming.device_label;
  if (prev.mobile_id === null && incoming.mobile_id !== null) merged.mobile_id = incoming.mobile_id;
  // RV-93 — false → true only. It is a backfill like the three above: "the full image
  // got saved" can be learned, never un-learned by a later frame. The reverse would leave a
  // picture on disk with no row willing to open it.
  if (!prev.full_image && incoming.full_image) merged.full_image = true;
  // transcript → image only. The reverse would undo what THIS PC learned by pasting the
  // bytes (see rememberImage) — a row quietly changing what it claims to be.
  if (prev.entry_type !== 'image' && incoming.entry_type === 'image') merged.entry_type = 'image';
  return merged;
}
