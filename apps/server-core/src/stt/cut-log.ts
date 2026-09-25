// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.3 / §5 RC-6 — the
//     relay recorded no reason, boundary, fed audio or vendor position for any
//     cut, so the 「演练一次」 loss (A1, u4|u5) could not be told apart between two
//     mechanisms, and the next run would not be able to either.
//
// Card RC-6 — ONE INFO line per leg that is retired: a row cut, a leg rotation,
// a silence hang-up, the terminal flush. Every field is a fact the retiring code
// already holds at that moment; nothing here is derived after the fact.
//
//   kind                 which retirement: 'segment' (a row ended or a leg
//                        rotated — `reason` says which), 'hangup', 'stop'
//   reason               `SegmentCutReason` for kind 'segment' ('sentence' |
//                        'pause' ⇒ a row ended; 'leg' ⇒ only the engine leg
//                        rotated); null otherwise
//                        ⚠️ 更正（RC-E，2026-09-24）：「null otherwise」 is still true of
//                        'stop', and of a 'hangup' that banked; a 'hangup' that ENDED
//                        A ROW (long recording, `orchestrator-rollover.ts`
//                        `flushAndCloseLegForSilence`) carries 'pause'
//   segment_idx          the segment this retirement CLOSES
//   boundary_seq         the fed-seq boundary taken before the flush (F-2152)
//   leg_fed_ms           audio handed to the retiring leg (live + replay)
//   vendor_last_word_ms  the vendor's last word end in that leg's clock
//                        (Soniox only; null = absent, never 0)
//   flush_ms / timed_out the flush round trip, and whether its cap fired
//   replayed_ms          audio replayed into the NEXT leg; null when none was born
//   x_leg_ms             card RC-J — an OVERDUE cut only (null otherwise): the cut point X,
//                        in the retiring leg's fed-audio clock (`overdue-cut.ts`)
//   leg_seam_ms          card RC-J — ditto: how much of that leg's head is audio the leg
//                        before it had also been handed (its replay overlap at birth)
//   x_left_word_leg /    card RC-J — ditto: the words either side of X, 'current' when the
//   x_right_word_leg     word starts at or after `leg_seam_ms` (this leg's own audio),
//                        'previous' when it starts inside the re-heard head; the right one
//                        is null for a word-end cut (there is no word after X yet)
//
// Owned by `orchestrator-rollover.ts` / `orchestrator-terminal.ts` (the retiring
// sites); `orchestrator-core.ts flushFinal` records the flush facts it reads.

import { log } from '../log';
import type { SegmentCutReason } from './segment-boundary';

export type SttCutKind = 'segment' | 'hangup' | 'stop';

export interface SttCutRecord {
  kind: SttCutKind;
  reason: SegmentCutReason | null;
  segment_idx: number;
  boundary_seq: number;
  leg_fed_ms: number;
  vendor_last_word_ms: number | null;
  flush_ms: number | null;
  timed_out: boolean | null;
  replayed_ms: number | null;
  x_leg_ms: number | null;
  leg_seam_ms: number | null;
  x_left_word_leg: CutWordLeg | null;
  x_right_word_leg: CutWordLeg | null;
}

/** card RC-J — which leg's audio a word at the cut point sits in (see the field list above). */
export type CutWordLeg = 'current' | 'previous';

/** card RC-J — the four cut-point fields, for an overdue cut. */
export type CutPointFacts = Pick<SttCutRecord, 'x_leg_ms' | 'leg_seam_ms' | 'x_left_word_leg' | 'x_right_word_leg'>;

const NO_CUT_POINT: CutPointFacts = { x_leg_ms: null, leg_seam_ms: null, x_left_word_leg: null, x_right_word_leg: null };

/** card RC-J — the fields for an overdue cut at [c], in a leg whose own audio begins at [seamMs]. */
export function cutPointFacts(c: { legMs: number; leftWordStartMs: number; rightWordStartMs: number | null }, seamMs: number): CutPointFacts {
  const side = (startMs: number): CutWordLeg => (startMs >= seamMs ? 'current' : 'previous');
  return { x_leg_ms: Math.round(c.legMs), leg_seam_ms: Math.round(seamMs), x_left_word_leg: side(c.leftWordStartMs), x_right_word_leg: c.rightWordStartMs === null ? null : side(c.rightWordStartMs) };
}

/** What the orchestrator's single flush chokepoint records about the most recent flush. */
export interface LastFlushFacts { startedMs: number; endedMs: number; timedOut: boolean; lastWordMs: number | null; legFedMs: number }

/** The event name, exported so the shape test and a log reader grep the same string. */
export const STT_CUT_EVENT = 'stt.cut';

export function logCut(record: SttCutRecord): void {
  log.info(STT_CUT_EVENT, { ...record });
}

/** Flush fields for a record, from the facts `flushFinal` left behind — or null when no
 *  flush ran for this retirement (e.g. the leg was already gone). */
export function flushFields(f: LastFlushFacts | null, sinceMs: number): Pick<SttCutRecord, 'leg_fed_ms' | 'vendor_last_word_ms' | 'flush_ms' | 'timed_out'> | null {
  if (f === null || f.startedMs < sinceMs) return null;
  return { leg_fed_ms: Math.round(f.legFedMs), vendor_last_word_ms: f.lastWordMs, flush_ms: Math.max(0, Math.round(f.endedMs - f.startedMs)), timed_out: f.timedOut };
}

/** Log a retirement whose flush ran since `sinceMs`; a retirement that bailed before flushing retired no leg and logs nothing. */
export function logCutIfFlushed(head: Pick<SttCutRecord, 'kind' | 'reason' | 'segment_idx' | 'boundary_seq' | 'replayed_ms'> & { x?: CutPointFacts | null }, f: LastFlushFacts | null, sinceMs: number): void {
  const flush = flushFields(f, sinceMs);
  const { x, ...rest } = head;
  if (flush !== null) logCut({ ...rest, ...(x ?? NO_CUT_POINT), ...flush }); // card RC-J: the cut point, null unless an overdue cut
}
