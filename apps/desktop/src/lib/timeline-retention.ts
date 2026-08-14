// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md
//     ("the PC timeline becomes entirely local-owned — it used to be a cache of server
//     rows, now it has to become the owner")
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (timeline persistence)
//
// THE RETENTION POLICY OF A STORE THAT IS NOW AN OWNER.
//
// While the rows lived on a server, the local copy was a cache and unbounded growth
// was merely wasteful: the real list was somewhere else, and anything dropped here
// came back on the next pull. owner 2026-07-31 removed the somewhere else. From now
// on a row this PC drops is a row that no longer exists, so the bound has to be a
// stated policy rather than an accident of how much localStorage happened to hold.
//
// THE POLICY, in one sentence: KEEP THE NEWEST ROWS THAT FIT — at most MAX_ROWS of
// them, and at most MAX_CHARS worth of persisted text. Anything past either limit is
// dropped oldest-first, permanently.
//
// WHY TWO LIMITS AND NOT ONE. A count alone cannot bound the bytes: an image row
// carries `thumb_b64`, a base64 preview capped at 200 KB at the wire boundary, so
// twenty of them can outweigh two thousand transcripts. A byte budget alone cannot
// bound the work: every persist walks the rows, and a million tiny rows would be
// slow long before they were large. So both, and whichever binds first wins — which
// is why the sentence the user is shown states the KEPT COUNT and the CUTOFF
// INSTANT rather than the policy: those two numbers are true whichever limit bound,
// and the user can check them against their own memory.
//
// ⚠️ THE THING THIS FILE EXISTS TO PREVENT: "the user thinks their whole history is
// there, when it's actually already been trimmed". That is the storage face of this
// repo's No.1 bug shape. Dropping rows is acceptable; dropping them QUIETLY is not. So
// eviction never happens without leaving the two facts the page needs to say it out
// loud (TimelineStore.retention → the "this machine has kept N rows · everything
// before X has been cleared" line), and the store keeps the in-memory rows and
// the persisted rows IDENTICAL — showing a row that was not saved would be the same
// lie one layer up.

import type { TimelineRow } from './types';

/** Hard cap on rows kept locally. Chosen so a heavy day (a few hundred utterances)
 *  never trims at all, and so the per-persist walk stays trivially cheap. */
export const MAX_ROWS = 2000;

/** Budget for the persisted rows payload, in JS string characters.
 *
 *  WebView2 is Chromium, whose per-origin localStorage quota is on the order of a
 *  few megabytes and is NOT observable from script — and this origin also holds the
 *  settings cache, the change queue, the image-id set, the theme and the locale.
 *  So this number is deliberately well under any plausible quota rather than tuned
 *  to it, and the write is CHECKED besides (TimelineStore.storageFailed): a budget
 *  is a prediction, and a prediction is not evidence that the bytes landed. */
const MAX_CHARS = 1_500_000;

/** Per-row cost, estimated from the three fields that dominate it plus a flat
 *  allowance for the ids/timestamps/keys JSON adds around them.
 *
 *  An estimate rather than `JSON.stringify(row).length` because this runs for every
 *  row on every persist, and the budget above already carries the slack: being 20%
 *  wrong about a 1.5 M character budget cannot reach a multi-megabyte quota. */
function rowCost(r: TimelineRow): number {
  const FIXED = 280; // id, channel, two ISO timestamps, mode/status/flags, JSON syntax
  return FIXED + r.output_text.length + (r.source_text?.length ?? 0) + (r.thumb_b64?.length ?? 0);
}

/** Newest first, exactly the order [[TimelineStore.entries]] renders in, with the
 *  address as a tie-break so two rows sharing an instant evict deterministically. */
function newestFirst(a: TimelineRow, b: TimelineRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** Decide which rows this PC can no longer keep. Returns the rows to DROP (may be
 *  empty); the caller removes them and records the cutoff.
 *
 *  ONE row is never dropped: the NEWEST one — a single row larger than the whole
 *  budget is still the thing the user just said, and answering "the thing you just
 *  said doesn't fit" by showing nothing would be worse than being over budget for one
 *  row.
 *
 *  0.2.27 — the SECOND protection is gone with the thing it protected. A row with
 *  `pending === true` used to be un-evictable because an unconfirmed edit/delete was
 *  still sitting in the durable uplink queue and evicting the row would have left the
 *  queue replaying against nothing. There is no uplink and no queue (owner's
 *  architecture ruling),
 *  so no row is in that state and the guard could only ever have been dead weight —
 *  which is worse than absent, because the next reader would take it for a live rule. */
export function planEviction(
  all: readonly TimelineRow[],
  opts: { maxRows?: number; maxChars?: number } = {},
): TimelineRow[] {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const ordered = [...all].sort(newestFirst);
  const drop: TimelineRow[] = [];
  let kept = 0;
  let cost = 0;
  for (const row of ordered) {
    const c = rowCost(row);
    const mustKeep = kept === 0;
    if (mustKeep || (kept < maxRows && cost + c <= maxChars)) {
      kept += 1;
      cost += c;
      continue;
    }
    drop.push(row);
  }
  return drop;
}

/** The newest `created_at` among the dropped rows — the instant everything older
 *  than which is gone from this PC.
 *
 *  Rows with no usable timestamp (a junk row normalized to `''`) are skipped rather
 *  than allowed to set the cutoff: `''` would compare below every real instant and
 *  quietly turn the cutoff into "nothing was cleared". `null` = nothing was dropped. */
export function cutoffOf(dropped: readonly TimelineRow[]): string | null {
  let max: string | null = null;
  for (const r of dropped) {
    if (r.created_at === '') continue;
    if (max === null || r.created_at > max) max = r.created_at;
  }
  return max;
}
