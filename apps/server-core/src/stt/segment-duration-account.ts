// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-c (one
//     segment = one row)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` sits on the 800-line cap (card P0-1 added the
// rollover spawn-failure handling that pushed it back over). Structural split,
// same convention as `orchestrator-replay.ts`, `quota-recheck.ts` and
// `replay-debt.ts` before it: move a coherent family out WHOLE, never trim the
// reasoning a comment carries. The family here is one method's worth of
// account — the logic itself is a single subtraction; everything else below is
// why that subtraction is the only one, moved verbatim.

/**
 * 🔴 card N1-B1 — the ONE question `duration_ms` answers, on BOTH exits: "how
 * long is this segment".
 *
 * It used to answer two. The soft-segment exit passed `now - segmentStartMs`
 * and BOTH terminal exits passed `now - sessionStartMs`, so the same wire field
 * meant "this segment" on one final and "the whole utterance" on the next.
 * That was internally consistent while a whole utterance settled as ONE row:
 * the phone assembled every segment into one entry and read the duration off
 * the terminal final only. book 15 §2.0-c ends that — "one segment (segment_idx) = one row"
 * — and under it the old shape double-counts: a 10-minute recording mints ~20
 * rows of 30 s each PLUS a last row claiming 600 s, and the desktop stats tile
 * sums rows (`entry-metrics.ts` rowDurationMs).
 *
 * ⚠️ Not a bug fix — a contract change. Read the two directions before shipping:
 *  · new relay + OLD phone (settles only on the terminal final): a >30 s
 *    utterance's single row under-reports its duration. No text is lost.
 *  · new phone + OLD relay: every per-segment row claims the whole session's
 *    duration. No text is lost. Both degrade a number, neither drops a word —
 *    which is why this may ship ahead of N1-B2, though shipping them together
 *    is what keeps the number right.
 *
 * ⚠️ It cannot reach billing: the STT meter is settled from `totalAudioMs` /
 * `vad.sessionMs` in the bridge's `settle()`, never from a final's payload.
 *
 * ✅ CLOSED by card N1-B1b (`031660c`) — this block used to read "OPEN ACCOUNT …
 * it is reported, not done here", and every clause of it went false the moment
 * that card landed in a lane this one may not touch. Corrected in place rather
 * than deleted, because the account was real and the fix it PROPOSED was wrong:
 *
 * The account: the bridge's `kickRefine` passed this same number to
 * `shouldRefine`, whose floor is "only re-transcribe an utterance of at least N
 * seconds" while `RetainedAudio` holds the WHOLE utterance ⇒ a per-segment
 * duration made that gate read one segment and judge the whole. Real defect:
 * release a few seconds past a rollover and refine silently never ran, on
 * exactly the long recordings GA-14 exists to improve.
 *
 * 🔴 Why the replacement proposed here was REJECTED — keep this, or it will be
 * proposed again: `totalAudioMs` counts every byte the phone offered, INCLUDING
 * bytes `RetainedAudio` refused (cap) and replayed reconnect chunks. On an
 * overflowed buffer it would clear the floor and then hand `take()` an empty
 * buffer — re-creating the very "the gate judges something other than what it
 * bills" shape it was meant to close. The number that cannot disagree with
 * `take()` is the retained buffer's own length, and that is what shipped.
 *
 * ⚠️ Nothing here reads a final's `duration_ms` for that decision any more, so
 * this function is once again free to mean only what its name says.
 */
export function segmentDurationMs(nowMs: number, segmentStartMs: number): number {
  return nowMs - segmentStartMs;
}
