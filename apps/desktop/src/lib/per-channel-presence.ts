// The device page's ONE comparable value for 「what is each channel's phone
// situation right now」, moved out of DevicesPage.vue on 2026-08-26.
//
// The split is the repo rule, not a preference: that SFC sits on a pinned
// size budget that may shrink and never grow, and the card that touches a file
// at its cap splits it first — trading the reasoning in these comments for line
// count is exactly what that rule forbids. This is a pure derivation over a
// plain record, so it leaves without moving a single behaviour, and it gains
// something on the way out: it can now be asserted directly.

import type { ConnectionState } from './types';

/** EVERY resident channel's own phone count, as one comparable value.
 *
 *  🔴 The real defect from owner 2026-08-02 UI batch 1 ② is exactly here
 *  (screenshot: the phone card's header says "offline" while right next to it
 *  it says "last active just now"). This watch's original source included
 *  `conn.mobiles`, and `conn` **by construction is only the snapshot of the
 *  primary channel** (main-window/store.ts's `applyConnectionRows` does a bare
 *  `continue` on `primary === false`). `lanUp` / `cloudUp` from that same source
 *  also don't track phones — they read `connByChannel[x].connected`, i.e. the
 *  **desktop ↔ server** socket.
 *  ⇒ When a phone joins/leaves the room on a **non-primary channel**, none of
 *  these three values move, `loadPaired()` never gets triggered, and that
 *  column's online dot freezes on whatever it last read. This is precisely the
 *  first of the four classes of structural defects: "pushed state with no
 *  matching pull".
 *
 *  ⚠️ Why "one concatenated string" rather than listing the two numbers
 *  separately: `connByChannel` is a reactive **dictionary**, and channels are
 *  keys that only appear at runtime (a single-channel shell has just one).
 *  Fixed enumeration like `connByChannel.lan?.mobiles` / `.cloud?.mobiles`
 *  would silently miss a future third channel, and that kind of omission has
 *  no symbol you can grep for.
 *  ⚠️ `conn.mobiles` was **removed** from the source, not forgotten: it is a
 *  subset of this summary (the primary channel's row is also in
 *  `connByChannel`), and keeping it would just be a second answer to the same
 *  question. */
export function presenceKey(rows: Record<string, ConnectionState>): string {
  return Object.keys(rows).sort().map((ch) =>
    // 🔴 THE EPOCH IS PART OF THE KEY (2026-08-26). Without it this watch was
    // blind to the one event it exists to react to: the count is a SET SIZE, so
    // a phone re-entering — or a NEW phone taking the only slot — leaves it at 1,
    // `loadPaired()` never ran, `pairSuccess.observe()` was never called, and the
    // QR modal never closed. Why the count cannot answer this: see
    // `socket/reconcile.rs::epoch`. `?? -1` keeps an older shell behaving exactly
    // as before rather than re-firing every tick.
    `${ch}:${rows[ch]?.mobiles ?? 0}@${rows[ch]?.presence_epoch ?? -1}`,
  ).join('|');
}

/** Every resident channel's JOIN counter, summed.
 *
 *  A phone can pair on either channel and the QR modal does not care which, so
 *  the page needs ONE number that moves when any of them sees a JOIN. Only
 *  INCREASE is ever read — the sum itself means nothing, exactly like the per-
 *  channel counters it adds up (socket/reconcile.rs `join_epoch`).
 *
 *  🔴 `join_epoch`, NOT `presence_epoch`. The first cut summed the latter, and
 *  that counter also moves on a DEPARTURE (reconcile.rs `on_left`) — so another
 *  paired handset backgrounding its app while the QR was on screen read as a
 *  pairing success and closed the modal. A leave must refresh the list (that is
 *  `presenceKey`'s job, above); it must never look like a join.
 *
 *  ⚠️ `?? 0` for a shell that does not report it: a stable contribution, so an
 *  older shell degrades to the identity rulers instead of mis-firing.
 */
export function joinEpochSum(rows: Record<string, ConnectionState>): number {
  return Object.values(rows).reduce((n, r) => n + (r?.join_epoch ?? 0), 0);
}
