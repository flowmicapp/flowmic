// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §9
//   CLAUDE.md red line: no silent failure
//
// What the timeline store ANSWERED — the two report types its writers return instead
// of logging. They live here rather than beside the store for one reason: that file
// sat at 800/800 lines when C2 needed to wire the one deleter into it. Moved VERBATIM
// (a pure cut-and-paste; the store re-exports both, so no import path changed).
//
// Why they are RETURNED and not logged: timeline-store.ts is pure — the store counts,
// main-window/store.ts writes the forensic line. Both types exist because the quiet
// path was the wrong one: refusing to overwrite a row, and failing to find the row an
// inject:result is about, were each a bare `return`.

import type { ChannelTag } from './types';

/** What [[TimelineStore.onHistoryUpdated]] did with one arriving frame, so the caller
 *  can RECORD it. Returned rather than logged here because this module is pure — the
 *  same split `windedDownQueueOps` already uses (the store counts, main-window/store.ts
 *  writes the forensic line).
 *
 *  It exists for one reason: refusing to overwrite a row is the right call, and doing it
 *  silently would trade one silence for another (red line: no silent failure). When a
 *  re-delivery disagrees with the row this PC holds, the words that were actually
 *  typed into the user's window leave no visible record here — that gap is knowingly
 *  open (see [[TimelineStore.onHistoryUpdated]]'s open note) and this is what makes it
 *  findable. */
export interface RowMintReport {
  /** The row's id — with `channel`, its full address. */
  id: string;
  channel: ChannelTag;
  /** Fields the frame carried that DIFFER from the row this PC holds and were therefore
   *  NOT applied. Empty on a brand-new row (nothing to disagree with) and on a frame
   *  that simply agrees. Names, not values: a forensic line must never carry the
   *  transcript itself. */
  refusedFields: string[];
  /** Whether the row carries a LOCAL edit — the case the rule exists for, and the
   *  difference between "preserved the user's edited text" and "refused an upstream
   *  overwrite". */
  locallyEdited: boolean;
  /** RV-76 — the row was accepted and then dropped by the BOUND in the same write.
   *
   *  It can only happen when this PC is already at MAX_ROWS / MAX_CHARS and the
   *  arriving row is older than everything it holds — a queued delivery from days ago
   *  (owner: "no matter how much time has passed, everything must be delivered"). The
   *  words WERE typed into the user's window, and the row for them does not survive,
   *  so this is the same disclosure gap as
   *  [[refusedFields]] and gets the same treatment: reported, never silent. It is NOT
   *  the same thing as the cutoff refusal this card removed — that one fired at ANY
   *  store size, on rows there was plenty of room for. */
  evictedOnArrival: boolean;
}

/** Why an `inject:result` did NOT reach a row (`null` = it did).
 *
 *  It exists because [[TimelineStore.onInjectResult]] is the ONLY writer of a row's
 *  delivery TARGET (the window the words landed in), and its two failure modes both
 *  used to be a bare `return`. A verdict that finds no row is not automatically a bug
 *  — the row may have been deleted — but "saying nothing at all" is (red line: no
 *  silent failure), and
 *  after RV-72 moved the address this is exactly where a producer/consumer drift would
 *  show up first. Reported rather than logged here because this module stays pure —
 *  the same split [[RowMintReport]] uses. */
export type InjectResultMiss =
  /** The verdict carries no usable `(channel, row_id)` — the Rust bridge stamps both
   *  on every forwarded copy (`row_transit::forward_verdict`) and both halves ship in
   *  one binary, so in a shipped build this means the bridge drifted. */
  | 'unaddressable'
  /** Addressed fine, and this store holds no such row: deleted by the user, or dropped
   *  by the bound between the mint and the verdict. */
  | 'no-such-row';
