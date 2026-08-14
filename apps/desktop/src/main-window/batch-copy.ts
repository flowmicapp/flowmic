// V2-18 — pure logic for the PC timeline's multi-select + batch copy (owner
// 2026-07-28 ①②③, the three are one whole). Kept out of the .vue so it is
// unit-testable — the timeline-filter.ts precedent.
//
// ② a selected IMAGE row is skipped WHOLE — no placeholder line, no descriptor
// text; ③ the skip is SAID twice: on the toolbar BEFORE the button is pressed
// (preCopyHint) and in the message AFTER the clipboard write resolves
// (resultMessage). "Copied 5 items" with only 3 lines actually written is the
// second direction of red line "no silent failure" — claiming done what was not done.

import { TL_BATCH_MSG } from '../lib/strings/timeline';
import type { TimelineRow } from '../lib/types';

/** The four fields batch copy reads. Structural, so tests pass plain literals.
 *  `created_at` was added so the concatenation order can be decided HERE (see
 *  [[planBatchCopy]]) rather than by whatever order the caller happens to hand
 *  rows in. */
export type BatchRow = Pick<TimelineRow, 'id' | 'entry_type' | 'output_text' | 'created_at'>;

/** The image predicate. Same field the row's image chip and the filter chip
 *  already use (TimelineRow.entry_type — timeline-store.ts maps it from the
 *  wire row or this PC's own paste record); never `thumb_b64`, which is only
 *  the preview and is absent on pre-thumbnail rows. */
export function isImageRow(r: Pick<TimelineRow, 'entry_type'>): boolean {
  return r.entry_type === 'image';
}

/** REQ-12-13 — which rows can contribute a LINE of text.
 *
 *  🔴 Positive on `'transcript'`, not `!== 'image'`. A `'control'` row (a remote key
 *  press) has `output_text: ''` by construction — its face is composed at render time
 *  from `control_kind` — so the old shape would have pushed a BLANK LINE into the
 *  clipboard for every keypress in the selection. That is not a crash and not a lie;
 *  it is silent junk in a payload the user pastes somewhere else, which is why it has
 *  to be decided here rather than noticed later.
 *
 *  ⚠️ A skipped control row is deliberately NOT counted into `skippedImages`: that
 *  number feeds a sentence about PICTURES ([[preCopyHint]]), and inflating it would
 *  make the hint claim pictures that are not in the selection. When a selection holds
 *  nothing but control rows the plan yields zero lines, and the existing
 *  "no copyable text" branch — which never claims a copy happened — is already the
 *  right answer. */
export function isCopyableRow(r: Pick<TimelineRow, 'entry_type'>): boolean {
  return r.entry_type === 'transcript';
}

export interface BatchCopyPlan {
  /** The clipboard payload: one line per TEXT row, in the order given. */
  text: string;
  /** Text rows that produced a line. */
  copied: number;
  /** Image rows skipped whole (②). */
  skippedImages: number;
  /** Rows examined, pictures included — the N of the all-pictures message. */
  selected: number;
}

/** Build the copy plan for the selected rows, reordered to CHRONOLOGICAL
 *  ASCENDING before anything else happens.
 *
 *  🔴 owner 2026-08-01, docs/strategy/2026-08-01-data-asset-lifecycle-design.md
 *  §4b-6, verbatim: "concatenation order has been ruled: chronological ascending
 *  — earlier ones first, newer ones after, so what gets pasted naturally comes out
 *  in the order things happened (regardless of the order the user checked them
 *  in)". This SUPERSEDES an earlier version
 *  of this function that used the caller's array order as-is (labelled "IN
 *  DISPLAY ORDER" — but display order is created_at DESCENDING (timeline-store.ts
 *  `entries()`), so that earlier version produced the NEWEST line first: the
 *  opposite of the ruling above).
 *
 *  The sort lives HERE, inside the function, not in the caller: this function is
 *  the one place that answers "what the clipboard looks like", and letting a caller
 *  hand in pre-sorted rows would make that a question with two possible answers
 *  depending on who called it — this repo's #1 bug shape (one question, two
 *  answers). Callers may pass
 *  rows in ANY order (display order, click order, fully reversed); the payload is
 *  identical.
 *
 *  Each line is the row's `output_text` — exactly what the row renders (the
 *  processed result for translate / organize), so the clipboard says what the
 *  user saw. Image rows contribute NOTHING: no line, no placeholder (②). */
export function planBatchCopy(rows: readonly BatchRow[]): BatchCopyPlan {
  // Stable sort (spec-guaranteed since ES2019 — every engine this runs on honors
  // it): when two rows share the exact same `created_at`, there is no second field
  // on this type that could break the tie non-arbitrarily (id is not guaranteed
  // monotonic — see TimelineRow), so the only defensible answer is "keep whatever
  // order they arrived in this call". Pinned by the tie-break test in
  // batch-copy.test.ts — swap this for a non-stable sort and that test goes red.
  const ordered = [...rows].sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return 0;
  });

  const lines: string[] = [];
  let skippedImages = 0;
  for (const r of ordered) {
    if (isImageRow(r)) {
      skippedImages += 1;
      continue;
    }
    // REQ-12-13 — see [[isCopyableRow]] for why this is separate from the image
    // branch and why it increments nothing.
    if (!isCopyableRow(r)) continue;
    lines.push(r.output_text);
  }
  return { text: lines.join('\n'), copied: lines.length, skippedImages, selected: rows.length };
}

/** The selected rows in the timeline's display order. `displayed` is the list
 *  the page renders (newest first); filtering it preserves the on-screen
 *  relative order under any filter chip. Keys whose row no longer exists
 *  (deleted / refreshed away) drop out, so the count and the payload only ever
 *  describe rows that are actually there.
 *
 *  `keyOf` exists because owner 2026-07-30 ① put BOTH servers' rows in one list: a
 *  row's identity on screen is `(channel, id)`, and selecting by bare id could tick
 *  two rows on two servers at once. Defaults to the id so existing callers (and the
 *  tests, which pass `{id}` literals) are unchanged. */
export function selectedInOrder<T extends { id: string }>(
  displayed: readonly T[],
  keys: ReadonlySet<string>,
  keyOf: (row: T) => string = (row) => row.id,
): T[] {
  return displayed.filter((r) => keys.has(keyOf(r)));
}

/** ③before — the toolbar hint, or null while the selection holds no picture. */
export function preCopyHint(rows: readonly BatchRow[]): string | null {
  const images = rows.filter(isImageRow).length;
  return images === 0 ? null : TL_BATCH_MSG.selImgHint(rows.length, images);
}

/** ③after — the result message. The all-pictures branch says "no copyable text",
 *  never "Copied 0 items": nothing was written, so "copy" never happened and the
 *  message must not pretend it did (red line, second direction). */
export function resultMessage(plan: BatchCopyPlan): string {
  if (plan.copied === 0) return TL_BATCH_MSG.nothingToCopy(plan.selected);
  if (plan.skippedImages > 0) return TL_BATCH_MSG.copiedWithSkip(plan.copied, plan.skippedImages);
  return TL_BATCH_MSG.copied(plan.copied);
}
