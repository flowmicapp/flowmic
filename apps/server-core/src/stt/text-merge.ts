// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (interim = offlineAccum + onlineDraft
//     cumulative concatenation; segment text dedup-merge heuristic)
//   Ported from legacy stt/text-merge.ts (mechanism unchanged, F-2067/F-2069/F-2100).
//
// Server-side suffix-prefix overlap-merge. Collects FunASR 2pass mid-session
// offline finals so the terminal stt:final carries the FULL session text, and
// keeps the live online draft from doubling on VAD-span restatements.

import type { InterimShape } from './engines/base';

/** Longest k ∈ [0, min(left.length, right.length)] where
 *  left.endsWith(right.slice(0, k)). k=0 means no overlap. */
export function overlapLen(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let k = max; k > 0; k--) {
    if (left.endsWith(right.slice(0, k))) return k;
  }
  return 0;
}

/** Merge `next` into `accum` using overlap semantics:
 *   - accum empty → next
 *   - next empty → accum
 *   - next starts with accum → next (cumulative engine)
 *   - accum starts with next → accum (retraction / replay)
 *   - else → accum + next.slice(overlapLen(accum, next))
 */
/** Minimum suffix/prefix overlap, in characters, before {@link mergeOverlap}
 *  will believe two consecutive engine FINALS actually overlap.
 *
 *  🔴 W2/FB-6. There was no minimum, so a single coincidentally shared
 *  character deleted a character of speech. Measured on this source:
 *    mergeOverlap('他说了算', '算了吧我们走')     → '他说了算了吧我们走'   (one "算" character is gone)
 *    mergeOverlap('这次先到这里', '里面还有两个人') → '这次先到这里面还有两个人' (one "里" character is gone)
 *  One-character suffix/prefix coincidences are ordinary in CJK, and the loss is
 *  invisible: the result still reads as fluent Chinese.
 *
 *  Why 2 is the right side to err on. A REAL overlap here only arises from
 *  rollover replay, which re-feeds five seconds of audio — that restates many
 *  characters, never one. So raising the floor cannot suppress a genuine
 *  overlap, while lowering it silently deletes speech. Where the two errors are
 *  not symmetric, take the visible one: owner's rule is losing characters is an automatic veto, and a
 *  duplicated character is something a user can see and we can measure
 *  (verify/eval judge `no_duplication`), whereas a deleted one leaves nothing
 *  behind to notice.
 *
 *  🔴 IN-PLACE CORRECTION (CARD⑦ / W4S, 2026-08-07, this machine dev-pc-a [measured]): the premise
 *  above, "A REAL overlap here only arises from rollover replay", is false — the
 *  mechanism was attributed to the wrong owner. **The whole 5-second replay belongs
 *  to the reconnect ladder, not to rollover**:
 *  `EngineSessionReconnectLadder.attemptReconnect()` (`engine-session.ts`), once it
 *  succeeds, only does `await this.hooks.spawnEngine(); this.hooks.replayBufferTail();`
 *  — a zero-argument hook call that lands on `orchestrator-core.ts`'s
 *  `replayBufferTail(gateUnfed = false)`, which is exactly the branch its own
 *  comment spells out as "RECONNECT (gateUnfed=false) full 5s", with the window
 *  taken from `DEFAULT_REPLAY_WINDOW_MS` (`orchestrator-types.ts`, = 5_000).
 *  **Rollover takes the other branch**: `rolloverSegment()` calls
 *  `this.replayBufferTail(true)`, and `gateUnfed=true` only replays the handful of
 *  packets with `seq > lastEngineFedSeq` — the ones that newly arrived during the
 *  flush round trip — never the whole 5 seconds; and rollover has already cleared
 *  `this.offlineAccum` before replaying (the same assignment site), so
 *  `mergeOverlap`'s `accum.length === 0` branch short-circuits immediately ⇒
 *  **rollover's replay physically cannot produce an overlap**. Conversely, the
 *  only places in the whole repo that write `currentSegmentIdx` are `start()`
 *  (resets to zero) and the three `+= 1` sites inside `rolloverSegment()` (checked
 *  one by one via grep) — the reconnect ladder never touches it at all, so that
 *  5-second replay lands on **the SAME `segment_idx`, on the SAME un-cleared
 *  `offlineAccum`** — it is a continuation within the same segment, never a seam
 *  across segments. The original text is kept, not deleted: it records the
 *  judgment made at the time.
 *  ⇒ The attribution was wrong, but the conclusion is not entirely overturned: a
 *  mechanism that really does replay the whole 5 seconds, and therefore really can
 *  recover many characters at once, does exist — only the subject needs to change
 *  from rollover to reconnect — "raising the floor cannot suppress a genuine
 *  overlap" still holds with the subject swapped; this correction only changes
 *  "who is replaying", not "whether replay can produce a genuine overlap", nor
 *  does it change `OVERLAP_MIN_CHARS` itself.
 *  ⇒ The second half (the asymmetry: losing characters is an automatic veto +
 *  `no_duplication` is a testable criterion, while deleted characters are not
 *  testable) is an independent argument that does not depend on the premise
 *  above, and after review it **still holds**: owner's automatic veto on losing
 *  characters and the content-loss criterion `no_duplication` are both real,
 *  running mechanisms (`verify/eval/judges/index.mjs`), unrelated to "whether the
 *  replay comes from rollover or reconnect" — so it is kept as written. */
const OVERLAP_MIN_CHARS = 2;

export function mergeOverlap(accum: string, next: string): string {
  if (accum.length === 0) return next;
  if (next.length === 0) return accum;
  if (next.startsWith(accum)) return next;
  if (accum.startsWith(next)) return accum;
  const k = overlapLen(accum, next);
  return accum + next.slice(k >= OVERLAP_MIN_CHARS ? k : 0);
}

/** Minimum shared prefix, in characters, before {@link mergeOnlineDraft} will
 *  treat two frames as the SAME span restated. Purely a guard against short
 *  strings: without it "好的" (OK) vs "好好学习天天向上" (study hard and make progress every day) share 50 % of the shorter
 *  string on one character and a genuine new delta would be thrown away. */
const REVISION_MIN_PREFIX = 8;

/** F-2100 — live-VAD-span online draft accumulator.
 *
 *  FunASR 2pass-online frames are per-VAD-span ROLLING DELTAS that RESTART at
 *  every VAD boundary, and the engine also emits one consolidated full-span
 *  frame mid-span. A blind k=0 APPEND re-appends the whole span → doubling.
 *  This builds the running text of the CURRENT live span only:
 *   - draft empty → next
 *   - next empty → draft
 *   - next starts with draft → cumulative refinement, REPLACE (next)
 *   - draft starts with next → retraction / restart-prefix, KEEP draft
 *   - overlap k>0 → sliding-window forward delta, trim + append
 *   - long shared PREFIX and next is no shorter → MID-STRING REVISION, REPLACE
 *   - k=0 AND long shared SUFFIX → consolidated/restart re-statement, REPLACE
 *   - k=0 AND no shared suffix → genuine brand-new tail delta, APPEND
 *
 *  🔴 THE REVISION BRANCH WAS ADDED 2026-08-02 (L9) AND IT WAS A LIVE DEFECT,
 *  not a hypothetical. Soniox does not send deltas at all — every frame is the
 *  WHOLE current hypothesis, and it may be REVISED IN THE MIDDLE. Observed on
 *  the real service, two consecutive interim frames of one English utterance:
 *
 *    draft = 'The tribal chieftain called for the boy, and presented him with'
 *    next  = 'The tribal chieftain called for the boy and presented him with 50 pieces of gold'
 *
 *  — the model dropped a comma 38 characters in. Neither `startsWith` holds,
 *  `overlapLen` is 0 (the draft ends in "with", the next begins in "The") and
 *  the common SUFFIX is 0, so the old code fell through to APPEND and the user
 *  watched the sentence pile up on itself. The drill printed it TRIPLED:
 *    'The tribal chieftain … him withThe tribal chieftain … of goldThe tribal … of gold.'
 *  The terminal `stt:final` was clean (it comes from the engine's own final via
 *  `offlineAccum`), so ONLY the live preview was wrong — which is exactly the
 *  kind of defect that no final-text assertion can see.
 *
 *  🔴 IN-PLACE CORRECTION (W2 / FB-6, 2026-08-06, this machine dev-pc-a [measured]): the
 *  half-sentence in parentheses above was already false when it was written, and it
 *  shielded a real defect for an entire window. The terminal transcript does
 *  **NOT** come only from the engine's own final — at the time, the
 *  `getOfflineText` that `flushFinal()` handed to `raceFlushFinal` was exactly
 *  `mergeOnlineDraft(offlineAccum, onlineDraft)`, and `raceFlushFinal` used it to
 *  answer on **every non-timeout path** (`flush-final.ts:104-109`: only on
 *  timeout, and only when the engine's final strictly extends this text, does it
 *  switch to the engine's own). ⇒ **This function's verdict is exactly the text
 *  the phone takes and injects.**
 *  The original text is kept, not deleted: it records the judgment made at the
 *  time, and this correction records where it was wrong.
 *  ⇒ Rule (another instance of anti-façade ④): **a comment asserting another
 *  module's behaviour has a truth value that changes with that other module's
 *  code, while the comment itself does not**; this particular sentence went
 *  further and claimed "no terminal-final assertion can see this class of
 *  defect", so nobody ever went and wrote that terminal-final assertion. The
 *  criterion is now pinned in `verify/eval/cases/merge.jsonl`, which replays the
 *  two accumulators byte-for-byte against the three lines in
 *  `orchestrator-core.ts`.
 *
 *  ⚠️ `next.length >= draft.length` is part of the condition on purpose. A
 *  SHORTER revision is ambiguous — it could be the vendor retracting, or a
 *  FunASR delta that happens to restate the opening — and dropping text on an
 *  ambiguous signal is worse than the doubling this fixes. Ambiguous ⇒ fall
 *  through to the pre-existing branches, whose behaviour is unchanged.
 *
 *  📌 The structural answer is for an engine to DECLARE whether its interim is
 *  cumulative or a delta, instead of every consumer guessing from the strings.
 *  That is a change to the `InterimResult` contract shared by seven engines, so
 *  it is REPORTED as an open account rather than smuggled in here.
 *
 *  ✅ IN-PLACE CORRECTION (INT-2, 2026-08-12) — THAT ACCOUNT IS NOW HALF CLOSED, and the
 *  half that closed is the half this function could never have done. Engines may
 *  now declare `interimShape:'cumulative'` (`engines/base.ts`), and a declared
 *  cumulative stream is folded by {@link mergeCumulativeDraft} instead of by this
 *  function. `sherpa-local` declares it; the other six stay silent and keep
 *  every branch below, unchanged, forever — including the SIX cases in
 *  `test/text-merge.test.ts` that pin them.
 *  🔴 The reason the account was scoped too large: "a change to the
 *  `InterimResult` contract shared by seven engines" assumed the declaration had
 *  to be MANDATORY. An optional one costs the six silent engines nothing, and
 *  absent-means-unmeasured is the honest default — see `InterimShape` in
 *  `engines/base.ts`.
 */
export function mergeOnlineDraft(draft: string, next: string): string {
  if (draft.length === 0) return next;
  if (next.length === 0) return draft;
  if (next.startsWith(draft)) return next;
  if (draft.startsWith(next)) return draft;
  const k = overlapLen(draft, next);
  if (k > 0) return draft + next.slice(k);
  const p = commonPrefixLen(draft, next);
  if (p >= REVISION_MIN_PREFIX && p * 2 >= Math.min(draft.length, next.length) && next.length >= draft.length) {
    return next;
  }
  const s = commonSuffixLen(draft, next);
  const restated = s > 0 && s * 4 >= Math.min(draft.length, next.length);
  return restated ? next : draft + next;
}

/**
 * 🔴 INT-2 (2026-08-12) — fold two interims of an engine that has DECLARED
 * `interimShape:'cumulative'` (`engines/base.ts`).
 *
 * ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
 * Device line, round 2, run C (scratch/r7-req1205-round2-2026-08-12.md §2-2):
 * a single non-repeating 5 s sentence, played ONCE, rendered on the phone as
 *
 *     跟你说个事啊。跟你说个事啊，明天下午。 (lit. "Let me tell you something. Let me tell you something, tomorrow afternoon." — the sentence duplicated)
 *
 * and the SERVER's own instrument said `utterance summary {"last_chars":34}`
 * for a ~13-character sentence — so the doubling had already happened here,
 * before the frame left this process. Run B: ~26 chars of audio ⇒ 173.
 *
 * ── WHY {@link mergeOnlineDraft} PRODUCES IT, EXACTLY ────────────────────────
 * Real SenseVoice punctuates as a function of the WHOLE span, so a clause that
 * ended a sentence stops ending it once more speech follows. Two consecutive
 * previews of ONE utterance therefore differ IN THE MIDDLE:
 *
 *     draft = "跟你说个事啊。"  (lit. "Let me tell you something.")
 *     next  = "跟你说个事啊，明天下午。"  (lit. "Let me tell you something, tomorrow afternoon.")        ← 。 became ，
 *
 * Walk `mergeOnlineDraft` on those two: neither `startsWith` holds (character 7
 * differs); `overlapLen` is 0 (the draft ends "。" (a full stop), no prefix of `next` ends
 * that way); the shared PREFIX is 6 < `REVISION_MIN_PREFIX` (8); the shared
 * SUFFIX is 1 "。" (a full stop), and 1×4 < min(7,12). Every branch declines, and the last
 * line APPENDS. Nothing is broken in that function — it is guessing, and on
 * short CJK clauses the guess is wrong, because 8 characters of shared prefix is
 * a whole sentence in Chinese and a fragment in English.
 *
 * ── THE DISCRIMINATOR IS THE DECLARATION, NOT THE TEXT ───────────────────────
 * 🔴 The tempting fix — lower `REVISION_MIN_PREFIX`, or loosen the suffix ratio —
 * is the SAME KIND of fact that produced the defect: a threshold on string
 * similarity, tuned on the shape in front of us. It would also reach the six
 * engines whose behaviour nobody measured today, and the guards it would weaken
 * are each pinned by a test that names real speech it protects.
 *
 * What is TRUE here is a property of the producer, not of the strings:
 * `SherpaPreviewDecoder.push()` returns `joinPreviewSpans(committed, tailDecode)`
 * — i.e. EVERY frame it emits is the whole utterance-so-far. So for a declared
 * cumulative stream "is this new text a continuation of the old text?" is not a
 * question that has to be ASKED: the answer is structurally "it CONTAINS the old
 * text's subject matter, whatever the characters look like". There is no
 * append branch because there is nothing an append could ever be right about.
 *
 * ── WHAT THIS MUST NOT DO — THE POSITIVE CONTROL ─────────────────────────────
 * ⚠️ A user who genuinely says the same sentence twice MUST still get it twice.
 * Runs A and B on the sheet played doubled audio deliberately, and their doubled
 * TEXT was correct input. This function cannot get that wrong, and the reason is
 * the same invariant: the recognizer heard both utterances, so BOTH are inside
 * the one cumulative frame it hands us (`跟你说个事明，跟你说个。` — lit. "let me tell you
 * something, let me tell you" — the same utterance said twice). Believing that
 * frame preserves the repetition; it is CONCATENATING frames that invents one.
 * ⇒ Nothing here compares `draft` and `next` for similarity, so there is no
 * mechanism by which repeated speech could be collapsed. Pinned by the positive
 * control in `test/req1205-interim-growth-seam.test.ts`.
 *
 * ── THE ONE GUARD THAT SURVIVES THE DECLARATION ──────────────────────────────
 * `draft.startsWith(next)` ⇒ KEEP the draft. A cumulative frame that is a strict
 * PREFIX of what we already published is the engine walking its hypothesis back,
 * and honouring it would shorten text the user has already read. Round 2
 * verified "prefix is not rewritten" green on the device (§1, 2-2), under the old code,
 * whose `draft.startsWith(next)` branch produced exactly this behaviour — so
 * dropping the guard would be changing a property that was measured, to fix a
 * defect that does not require changing it. A DIVERGENT shorter frame (not a
 * prefix) is a real revision and is believed.
 */
export function mergeCumulativeDraft(draft: string, next: string): string {
  if (draft.length === 0) return next;
  if (next.length === 0) return draft;
  if (draft.startsWith(next)) return draft;
  return next;
}

/**
 * 🔴 INT-2 — the ONE place that turns an engine's declaration into a fold.
 *
 * Called from `orchestrator-core.ts`'s `interim` handler, which is the only
 * consumer of an engine's interim stream in this process. It lives HERE and not
 * there for two reasons, and neither is tidiness:
 *
 *  · the choice and the two functions it chooses between have to be readable
 *    together — the argument for {@link mergeCumulativeDraft} is entirely about
 *    what {@link mergeOnlineDraft} cannot know, and a reader who finds only one
 *    of them has the wrong half;
 *  · `orchestrator-core.ts` is up against the file-size gate — 796/800 before
 *    this card, 798/800 after — and this card is not the one that gets to spend
 *    its last lines. (Measured: the first shape of this change put the block
 *    inline and `verify:lint file-size` went RED at 810. That is the gate doing
 *    its job, not an obstacle to route around.)
 *    🔴 REGISTERED, not fixed: 798/800 is the `bootstrap.ts` trap one line
 *    further along. The next card that touches `orchestrator-core.ts` must split
 *    it first (parent-book J-a's standing rule), and nothing here has made that cheaper.
 *
 * ⚠️ `undefined` — no declaration — keeps TODAY'S behaviour exactly, and that is
 * the safe direction: six engines have not been measured, and the merge they get
 * is the one every existing test in `test/text-merge.test.ts` pins.
 */
export function foldInterim(shape: InterimShape | undefined, draft: string, next: string): string {
  return shape === 'cumulative' ? mergeCumulativeDraft(draft, next) : mergeOnlineDraft(draft, next);
}

/** Fold the CONFIRMED session text together with the CURRENT live draft to
 *  produce the terminal transcript. Used by exactly one call site:
 *  `orchestrator-core.ts` `flushFinal()` → `raceFlushFinal({getOfflineText})`.
 *
 *  🔴 W2/FB-6 — WHY THIS IS NOT {@link mergeOnlineDraft}. It used to be, and
 *  that was this repo's #1 bug shape: one function answering two different
 *  questions.
 *
 *  `mergeOnlineDraft(draft, next)` compares TWO SUCCESSIVE HYPOTHESES OF THE
 *  SAME SPAN, so when they conflict, believing the newer one is right — that is
 *  the L9 Soniox mid-string-revision fix, and it must stay exactly as it is.
 *
 *  This function compares something else entirely: `offlineAccum` (spans the
 *  engine has already FINALISED) against `onlineDraft` (a span that is not in
 *  offlineAccum at all, because `onlineDraft` is cleared the moment a final
 *  lands — orchestrator-core.ts:328). They are DISJOINT BY CONSTRUCTION. There
 *  is no such thing as one "revising" the other, so the revision and
 *  restatement branches had nothing true to say here — and when they fired they
 *  discarded confirmed speech in favour of an unconfirmed hypothesis.
 *
 *  Measured on the previous implementation, all real shapes of ordinary speech:
 *    ('第一部分已经完成了',   '第二部分已经完成了') → '第二部分已经完成了'   (the entire first point is gone)
 *    ('他说这个方案不可行',   '这个方案可行')       → '这个方案可行'         (the negation is gone, the meaning is reversed)
 *    ('预算是三百万人民币',   '预算是五百万人民币') → '预算是五百万人民币'   (the earlier number is gone)
 *  Parallel clauses share a long suffix, and `s * 4 >= min(len)` is satisfied by
 *  a 25 % shared tail — which is most enumerations, comparisons and corrections
 *  anyone speaks. The result always read as fluent, complete text, so nothing
 *  downstream could tell that half the utterance was gone.
 *
 *  ⚠️ This was NOT only the live preview. `raceFlushFinal` resolves with this
 *  string on every non-timeout path (`flush-final.ts:104-109` prefers the
 *  engine's own final only when it timed out AND the final strictly extends
 *  this text), so it is the terminal `stt:final` the phone injects. The comment
 *  in this file that said the terminal final "comes from the engine's own final
 *  via offlineAccum" described a path that does not exist; it has been corrected
 *  where it appears above.
 *
 *  The rule now: never discard confirmed text. Only the two containment cases
 *  replace, and both are lossless by definition. */
export function foldConfirmedWithDraft(confirmed: string, draft: string): string {
  if (confirmed.length === 0) return draft;
  if (draft.length === 0) return confirmed;
  // Cumulative engines (Soniox sends the whole hypothesis every frame) produce a
  // draft that already contains everything confirmed — replacing loses nothing.
  if (draft.startsWith(confirmed)) return draft;
  // The draft is a prefix of what is already confirmed: nothing new to add.
  if (confirmed.startsWith(draft)) return confirmed;
  // Disjoint spans. Concatenate — the same rule the live interim already uses
  // when it emits `offlineAccum + onlineDraft` (orchestrator-core.ts:320).
  // Those two lines disagreeing was the defect.
  return confirmed + draft;
}

/**
 * 🔴 REQ-14-01 (2026-08-14) — should a DEAD leg's draft be banked into the
 * confirmed text before the next leg starts? Returns the new confirmed text,
 * or null for "do not bank; leave both accumulators exactly as they are".
 *
 * THE HOLE THIS CLOSES (the OPEN-ACCOUNT row of `test/stt-outage-loss.test.ts`,
 * closed by the REQ-14-01 rows in the same file). A declared-cumulative engine
 * (Soniox) emits its `final` only at flush, so a leg the reconnect ladder
 * killed mid-utterance never flushed — everything it heard lives ONLY in
 * `onlineDraft`. The new leg replays just the 5 s buffer tail, and when ITS
 * final eventually lands, the orchestrator's `final` handler does
 * `onlineDraft = ''` — discarding the dead leg's speech from the terminal
 * transcript. Content loss, the reddest of the red lines, and invisible: the
 * preview showed the words, the row never carried them.
 *
 * {@link foldConfirmedWithDraft}, not {@link mergeOnlineDraft}: the banked
 * draft and whatever comes later are DISJOINT-or-containing spans, never two
 * hypotheses of one span, and that fold never discards (its W2/FB-6 argument).
 * The seam the new leg re-transcribes (≤ the replay window) may then appear
 * twice in the preview until the flush's {@link mergeOverlap} trims it — the
 * visible error, deliberately chosen over the silent one (losing characters is an automatic veto).
 * Measured in the REQ-14-01 duplication-cost rows: in the perfect-transcriber harness
 * the terminal cost is ZERO, because the new leg's flush final restates the
 * banked text's tail FROM ITS START — a suffix→prefix overlap, exactly the
 * shape `mergeOverlap` exists to trim.
 *
 * ⚠️ GATED on the dead leg having DECLARED 'cumulative'; undeclared engines
 * keep today's behaviour byte-for-byte. For FunASR 2pass the dead leg's span
 * is re-fed to the new leg and re-finalised by its offline pass, so banking
 * would duplicate what the existing draft-replacement handles cleanly. The
 * gate is the same fact {@link foldInterim} already turns on — and like it,
 * this belongs HERE so the choice and the folds it chooses between are read
 * together (the INT-2 argument, one function up).
 */
export function bankDraftAcrossLegs(
  shape: InterimShape | undefined,
  confirmed: string,
  draft: string,
): string | null {
  if (shape !== 'cumulative' || draft === '') return null;
  return foldConfirmedWithDraft(confirmed, draft);
}

/** Length of the longest common prefix of `a` and `b`. */
export function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Length of the longest common suffix of `a` and `b`. */
export function commonSuffixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
