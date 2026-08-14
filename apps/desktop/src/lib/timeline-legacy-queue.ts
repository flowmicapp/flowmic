// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (0.2.27 — uplink retirement)
//
// Winding down the 0.2.26 durable change queue.
//
// Extracted from timeline-store.ts VERBATIM (C2, 0.2.39) — behaviour unchanged, and
// the reason is the cap: that file sat at exactly 800/800 lines and the one-deleter
// wiring had to go in. This is the least load-bearing thing in it — a one-shot
// migration for a build two versions old — so it is what moved. ⚠️ Moving code to
// make room is only safe when the moved code is UNCHANGED; the diff for this file is
// a pure cut-and-paste plus a store parameter where `this.store` used to be.

import type { ReportingKvStore } from './types';

/** The RETIRED durable change queue (0.2.27). Read exactly once, at hydrate, to wind
 *  down whatever a 0.2.26 build left behind. Nothing writes ops to it any more. */
export const QUEUE_KEY = 'flowmic.history.queue';

/** Retire whatever the 0.2.26 durable change queue left on this machine.
 *
 *  ⚠️ Nothing is re-applied, and nothing is lost — this is the whole reason the
 *  wind-down is safe. Both queued kinds were written to the ROWS OPTIMISTICALLY
 *  BEFORE being queued: `edit` set `output_text` and persisted, `remove` deleted the
 *  row and persisted. So the rows the user is looking at ALREADY show every queued
 *  change; the queue only ever held the un-mirrored SERVER half, and there is no
 *  server half any more (`history:update`/`:delete` answer `HISTORY_SYNC_RETIRED`).
 *
 *  What the user sees: their edited and deleted rows exactly as they left them.
 *  What disappears: the "saved locally" chip on those rows, and the "the server
 *  hasn't confirmed… will retry" line — the second of which is the important one,
 *  because keeping the queue would have made that line appear on EVERY edit and
 *  delete from now on, attached to a retry that could never succeed. That is a
 *  promise this build cannot keep, and "never promise something that hasn't been
 *  done" is the red line it would break.
 *
 *  The key is overwritten with `[]` rather than left alone so that no later build
 *  can resurrect the ops by reading it again, and the count is RETURNED because a
 *  one-way discard of user-initiated work must be discoverable (no silent failure).
 *
 *  @returns ops discarded — `0` = none, `-1` = the key was there but unreadable. */
export function windDownRetiredQueue(store: ReportingKvStore): number {
  const raw = store.get(QUEUE_KEY);
  if (raw === null || raw === '[]') return 0;
  let n = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) n = parsed.length;
  } catch {
    n = -1; // unparseable: the count is unknown, and saying so beats claiming 0
  }
  if (n === 0) return 0;
  store.set(QUEUE_KEY, '[]');
  return n;
}
