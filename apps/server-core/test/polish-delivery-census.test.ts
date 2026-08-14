// POLISH-1 (2026-08-11) — split out of stt-session-bridge.test.ts, which went
// over the 1200-line test cap when THE DELIVERY JOIN was added to it. Moved
// VERBATIM, per the repo precedent for that gate (0.2.52: structural split rather than
// deleting evidence) — nothing in this block was rewritten by the move.
//
// The scan itself now lives in ./polish-delivery-scan.ts, shared with the join.

import { describe, expect, it } from 'vitest';
import { SRC, TESTS, deliverySelections, selectors } from './polish-delivery-scan';

// ── ACTIVATION TRIPWIRE — the detached delivery stays out of production ───────
//
// 🔴 DISARMED AGAIN 2026-08-11 (POLISH-1, owner's ruling). The history matters
// more than the current value, so it is kept in order:
//   · built as a TRIPWIRE: no file under src/ may select the detached mode;
//   · INVERTED 2026-08-08 (0.3.0 L2) to pin exactly one production selector,
//     because the triple below was judged discharged;
//   · TURNED BACK today, to `toEqual([])`, because it was not.
//
// 🔴 WHY IT WAS NOT, and this is the part to read before anyone inverts it a
// second time: every leg of the triple is about the mobile CONSUMER — which row
// `_applyRefined` lands on, which APK carries that fix, how many phones took it.
// NOT ONE LEG IS 「the server sends anything」. And it does not:
// `runDetachedPolish` ends at 「stt.polish produced a correction but there is no
// safe carrier — withheld」 and a bare `return`. So the triple could be
// discharged perfectly and still deliver zero characters — which is what
// happened, for every release from 0.2.59 to now. A precondition list that omits
// the delivery itself cannot be completed by satisfying it, and 「all three legs
// are green」 was therefore never evidence that anything would arrive.
//
// ⚠️ The inversion was not the defect and un-inverting is not the lesson. The
// census did exactly what a census does: it made the flip VISIBLE, in a diff,
// with the reasoning attached. What nothing anywhere did was ask whether the
// newly selected mode DELIVERS — see 「THE DELIVERY JOIN」 in
// stt-session-bridge.test.ts, which is the assertion that was missing on
// 2026-08-08 and would have gone red that day.
//
// A comment saying "do not enable this yet" is precisely the artefact this repo
// has watched rot over and over (anti-façade ④: a claim about someone else's
// behaviour whose truth changes when they change, while it does not). So the
// constraint is mechanical: the mode is a dep, and this census reads what src/
// actually selects.
//
// 🔴 THE TRIPLE IS RE-OPENED, and it is now a QUADRUPLE. Legs (i)–(iii) stand as
// written below; the leg that was never on the list is:
//   (0)   `runDetachedPolish` actually emits the correction to someone. Until
//         that exists, selecting 'detached' is not an activation — it is an
//         off switch, and it is the one that shipped.
// Historical note on (iii), left because it is the leg most likely to be waved
// through again: on 2026-08-08 it was claimed on the DISPATCHER's authority, not
// owner's, while its own text says the adoption threshold is owner's call and
// that the flipping card may not invent a number.
//
// The original three, verbatim, as they were written when they were open:
//   (i)   mobile `_applyRefined` selects its target row by entry type + owner.
//         Today it takes the newest row in `store.entries` unfiltered, guarded
//         only on `edited` / `processedText`, and four of the five row-insertion
//         callers are not utterances — an image sent to the PC, a record-only
//         image, a typed note, a canned-phrase tap. `buildDeliveryRow` leaves both
//         guards open on them.
//   (ii)  an APK carrying that fix is RELEASED.
//   (iii) the FIELD risk has retired. Phones already installed keep running the
//         old consumer, and wiring the server up exposes EVERY utterance to
//         them — orders of magnitude wider than GA-14's producer, which only
//         survives on the auto-stop path. 🔴 The adoption threshold for (iii) is
//         OWNER's call; neither this test nor the card that flips it may invent
//         a number.
//
// Ledger row: docs/strategy/2026-08-07-rt-realtime-correction-ledger.md.
describe('🔴 RT-1 ACTIVATION TRIPWIRE — detached polish delivery stays out of production', () => {
  it('NO file under src/ selects the detached delivery — there is still no carrier', () => {
    // 🔴 TURNED BACK, not deleted, and not re-inverted (POLISH-1). The 0.3.0 L2
    // inversion is left described in full in the block comment above: a census
    // that is edited on the day it goes red only ever measured the author's
    // patience, and that is as true of un-inverting it as of deleting it. What
    // makes this the right value is not that it is the older one — it is that
    // `runDetachedPolish` has no emit, so any src file selecting this mode is
    // asking for the correction to be computed, billed and dropped.
    expect(selectors(SRC, 'detached')).toEqual([]);
  });

  it('production STATES its delivery, in EXACTLY ONE file, and states the one that delivers', () => {
    // The half the pre-0.2.59 tripwire did not have, and the reason `'sync'` is
    // written out in stt-factory.ts rather than left to the accessor default.
    // 🔴 This fails in three directions, each a real defect:
    //   · the mode flipped ⇒ the pair no longer matches (and THE DELIVERY JOIN
    //     goes red beside it, which is the assertion that speaks for the user);
    //   · zero entries ⇒ production stopped stating its choice and the decision
    //     moved into a `??` in another file, where the census cannot see it.
    //     🔴 MEASURED, because this is the one direction where the case fires on
    //     something that is not yet a user-visible defect: deleting the line from
    //     stt-factory.ts (2026-08-11) left THE DELIVERY JOIN green — behaviour is
    //     identical, the accessor answers 'sync' — and failed HERE alone, with
    //     `expected [] to deeply equal [ { …(2) } ]`. That is the whole argument
    //     for stating the mode rather than omitting it: what deletion costs is
    //     not today's behaviour, it is this census's ability to police tomorrow's;
    //   · two or more ⇒ the delivery mode has two authors, this repo's #1 bug
    //     shape (one value answering two questions) arriving through the back door.
    expect(deliverySelections(SRC)).toEqual([{ file: 'engine/stt-factory.ts', mode: 'sync' }]);
  });

  it('the tripwire can actually fail (the tests DO select the detached mode)', () => {
    // 🔴 Without this, a regex that quietly stopped matching would make the
    // assertions above pass by measuring nothing — the failure mode every census
    // has, and the one this repo has been bitten by. It has to probe for
    // 'detached' specifically: the src census asserts an EMPTY list, so a scanner
    // that matched nothing at all would satisfy it perfectly.
    expect(selectors(TESTS, 'detached').length).toBeGreaterThan(0);
    expect(selectors(TESTS, 'detached')).toContain('stt-session-bridge.test.ts');
  });
});
