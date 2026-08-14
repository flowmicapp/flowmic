// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (Interim assembly / SegmentBuffer: same
//     segment_idx REPLACES within slot, new idx APPENDS, finalized slots lock
//     against late/replayed interims; CJK-aware joiner)
//
// Per-PTT accumulator that respects the STT engine's segment semantics:
//   - Same segment_idx interims REPLACE within that slot (offline 2-pass
//     correction overwrites the online estimate cleanly).
//   - Different segment_idx values APPEND across slots (whole utterance grows).
//   - A slot marked finalized (is_segment=true) drops late interims for that idx
//     (guards reconnect-replay storms re-emitting a locked segment).
//   - Joiner is CJK-aware: '\n' after 。！？, '' after ，；、：or CJK↔CJK,
//     ' ' when crossing into Latin words.
//
// Ported from legacy stt/segment_buffer.dart (behaviour byte-identical).

class SegmentBuffer {
  final Map<int, String> _texts = <int, String>{};
  final Set<int> _finalized = <int>{};

  /// Per-slot engine-reported duration, written once when the slot's server
  /// final lands. Kept HERE and not in the controller for the reason [clear]
  /// documents: one owner, one reset.
  ///
  /// ── 🔴 REG-D1 — WHY A SUM AND NOT `f.duration_ms` ────────────────────────
  /// `24b75cc` (N1-B1) made `duration_ms` answer ONE question on both exits:
  /// 「这一段有多长」("how long is this segment"). Before it, the TERMINAL final's number was the whole
  /// session, so the row could just copy it. After it, copying the terminal
  /// final gives the row its LAST SEGMENT ONLY — a 10-minute recording whose
  /// user released 2 s after a rollover reports 2 s. The row's number has to be
  /// assembled here for exactly the same reason its TEXT does (see [joined]):
  /// after a rollover the earlier spans exist nowhere else.
  final Map<int, int> _durations = <int, int>{};

  /// Highest `segment_idx` that has already been turned into a timeline row.
  /// −1 ⇒ nothing settled yet in this utterance.
  ///
  /// ── 🔴 N1-B2 / J5 — WHY THE WATERMARK LIVES IN THE BUFFER ────────────────
  /// It is reset by [clear], and [clear] already has FOUR callers spread across
  /// two layers (`ptt_session.pttDown` / `.pttCancel`,
  /// `ptt_capture_pump._onCaptureFault`, `chat_notices.clearBufferRouted`).
  /// A watermark kept next to the settlement code instead would need the same
  /// four resets, three of which are in files the settlement code does not own,
  /// and a MISSED one does not fail loudly: the next utterance's first segments
  /// would sit below the stale watermark and be silently swallowed — content
  /// loss, the reddest of the red lines. Keying it off the same `clear()` that
  /// already owns the slot map makes the reset structural rather than
  /// remembered.
  int _settledThrough = -1;

  void clear() {
    _texts.clear();
    _finalized.clear();
    _durations.clear();
    _settledThrough = -1;
  }

  /// Write [text] into slot [idx].
  ///   - finalized=true with empty text and non-empty prior → KEEP prior + lock
  ///     (the orchestrator's empty fallback on flushFinal timeout must NOT wipe
  ///     accumulated online text).
  ///   - finalized=true with non-empty text → the server's final REPLACES the
  ///     slot, then locks. See the block below for why replace and not merge.
  ///   - interim: same-idx REPLACES wholesale (server emits cumulative text);
  ///     ignore an empty update or a shorter retraction the prior contains.
  /// Once [finalized] the slot is locked against further [put]. Returns true iff
  /// the buffer actually changed.
  ///
  /// ── 🔴 W2.5 / FB-6: WHY A FINAL REPLACES ITS SLOT ──────────────────────────
  /// Ruling (裁定):
  /// docs/decisions/2026-08-06-server-final-is-authoritative-over-phone-joined.md
  /// (read its in-place-correction (原地更正) block — the authority holds PER `segment_idx`, not over
  /// the whole terminal transcript).
  ///
  /// This slot's interims and this slot's final describe the SAME SPAN: the
  /// orchestrator stamps every interim with the segment index it is currently
  /// on, and closes that same index with the final. Two versions of one span is
  /// a REVISION relationship, and the authoritative version replaces — merging
  /// them would DUPLICATE the span, not protect it.
  ///
  /// Which one is authoritative is not a guess: normalisation, the dictionary,
  /// punctuation and the optional AI polish all run on the SERVER. What arrives
  /// here as `finalized` is the processed text; what accumulated in this slot is
  /// the raw interim stream.
  ///
  /// This used to be `_mergeOverlap(prior, text)`, a rule that ended in
  /// `next.length > accum.length ? next : accum`. FB-6 asks the server to REMOVE
  /// filler, so a correctly processed final is SHORTER by construction ⇒ the raw
  /// interims won every single time and the entire server-side processing chain
  /// was invisible to the user. Measured on the unmodified source, through the
  /// real wire (`test/server_final_authority_test.dart`):
  ///   interims 「嗯 我 我觉得这个方案可以」("um, I, I think this plan works") +
  ///     final 「我觉得这个方案可行」("I think this plan is feasible")
  ///     → 「嗯 我 我觉得这个方案可以」   (the whole processed final discarded)
  ///   interims 「呃 那个 我们明天上午开会」("uh, um, we have a meeting tomorrow
  ///     morning") + final 「我们明天上午开会」("we have a meeting tomorrow
  ///     morning")
  ///     → 「呃 那个 我们明天上午开会」   (filler read back to the user)
  ///
  /// ⚠️ CROSS-SEGMENT ASSEMBLY IS STILL THIS DEVICE'S JOB and is NOT touched by
  /// this rule: different `segment_idx` values are DISJOINT spans, they live in
  /// different slots, and [joined] concatenates them. The terminal final carries
  /// only the LAST segment (the orchestrator resets its accumulators and
  /// increments the index at every rollover), so preferring it over [joined] at
  /// the utterance level would delete every earlier segment. Same span ⇒
  /// replace; different spans ⇒ never drop either. Today's defect on both ends
  /// of this product was one arbiter answering both questions.
  ///
  /// ⚠️ volume 15「手机是这句话的所有者」("the phone is the owner of this
  /// sentence") IS NOT IN CONFLICT WITH THIS. Ownership says
  /// WHICH DEVICE IS RESPONSIBLE FOR THE RECORD — this phone stores the row,
  /// renders it, exports it and deletes it, and no server keeps a copy. It does
  /// NOT say who COMPUTES the text. Adopting the server's processed transcript
  /// is the owner exercising ownership, not surrendering it. (Written out
  /// because the ruling (裁定) asks for it in so many words: the two readings were
  /// conflated once already.)
  ///
  /// [durationMs] is the engine's reading for THIS slot and is only carried by a
  /// final (`finalized: true`). It is recorded under the SAME lock as the text —
  /// a replayed final for an already-closed slot changes neither — so
  /// [durationFrom] inherits [put]'s idempotency instead of asking for a second
  /// 「have I seen this index」 answer (this repo's #1 defect shape).
  bool put({
    required int idx,
    required String text,
    bool finalized = false,
    int? durationMs,
  }) {
    if (_finalized.contains(idx)) return false;
    if (finalized && durationMs != null && durationMs > 0) {
      _durations[idx] = durationMs;
    }
    final String prior = _texts[idx] ?? '';
    if (finalized) {
      if (text.isEmpty && prior.isNotEmpty) {
        _finalized.add(idx);
        return false;
      }
      _texts[idx] = text;
      _finalized.add(idx);
      return true;
    }
    if (prior.isEmpty) {
      if (text.isEmpty) return false;
      _texts[idx] = text;
      return true;
    }
    if (text.isEmpty || text == prior) return false;
    if (prior.startsWith(text)) return false;
    _texts[idx] = text;
    return true;
  }

  // `_mergeOverlap` was here — the finalized-only arbiter whose last line was
  // `next.length > accum.length ? next : accum`. DELETED rather than repaired
  // (W2.5 / FB-6): its only caller was the `finalized` branch of [put], which
  // now replaces, and its 「keep whichever string is longer」 tie-break IS the
  // defect — ruling option 丙 (the third option), which systematically overrules every successful
  // server-side cleanup. Leaving it behind unused would be worse than useless:
  // an unreferenced capability is this repo's #1 historical bug class, and the
  // next person to need 「merge two texts」 would find a rule that drops one of
  // them. If a genuine merge is ever needed again, the losslessly-correct one to
  // copy is the server's `foldConfirmedWithDraft`
  // (apps/server-core/src/stt/text-merge.ts): containment replaces, disjoint
  // concatenates, nothing is ever discarded.

  // `_overlapMinChars` (= 2) and `_overlapLen` were here — the cross-segment
  // seam trimmer. BOTH DELETED (W5a / W2.5-H); see [joined]'s doc for why the
  // whole mechanism went rather than the number. Left behind unused they would
  // be worse than useless: an unreferenced capability is this repo's #1
  // historical bug class, and the next person to need 「how much do these two
  // segments overlap」 would find a helper whose only past caller used it to
  // delete speech. If a genuine merge is ever needed here, the losslessly
  // correct one to copy is the server's `foldConfirmedWithDraft`
  // (apps/server-core/src/stt/text-merge.ts): containment replaces, disjoint
  // concatenates, nothing is ever discarded.

  /// Joined view in segment_idx order — THE WHOLE UTTERANCE. Empty iff no slot
  /// has text.
  ///
  /// Different `segment_idx` values are DISJOINT spans, so this CONCATENATES
  /// every non-empty slot in index order and drops nothing, ever. It is also the
  /// only place the whole utterance exists: the terminal `stt:final` carries just
  /// the LAST segment, so this assembly is what makes a recording longer than the
  /// soft-segment window survive.
  ///
  /// ── 🔴 W5a / W2.5-H — THE SEAM TRIMMER IS GONE, NOT RETUNED ────────────────
  /// This used to trim a suffix/prefix overlap at the seam between two adjacent
  /// segments whenever the shared run reached a floor of 2 characters. That rule
  /// DELETED REAL SPEECH, measured four times on this source (the four rows are
  /// pinned in `test/segment_buffer_test.dart`, group 「W2.5-H」, and were first
  /// measured by the previous window — ledger
  /// docs/strategy/2026-08-06-w25-closing-the-two-red-lines-ledger.md §4.3
  /// in-place-correction block (原地更正块):
  ///   「这个方案我觉得可以」("I think this plan works")+「可以的话我们下周开始。」
  ///     ("if that works, we'll start next week.") → 「可以」("works") gone
  ///   「我们先看第一个问题」("let's look at the first problem first")+「问题不大
  ///     我来处理」("no big problem, I'll handle it") → 「问题」("problem") gone
  ///   「这件事我们下周再说」("let's talk about this next week")+「再说」("talk
  ///     about it later") → the whole 2nd segment gone
  ///   「我们明天开会」("we have a meeting tomorrow")+「开会」("meeting")+「地点在
  ///     三楼」("location is on the 3rd floor") → the whole MIDDLE segment gone
  /// Every one of those results still reads as fluent Chinese, so nothing
  /// downstream could notice. The production shape makes the collision LIKELY,
  /// not exotic: `final-text-pipeline.ts` applies
  /// `ensureTerminalPunctuation: !ctx.isSegment`, so a soft-segment final ends on
  /// a BARE CONTENT CHARACTER — the most collision-prone ending there is.
  ///
  /// WHY THE NUMBER WAS NOT THE FIX. The floor could not tell a real overlap
  /// from a real repetition, and NO number can, because this layer holds two
  /// strings and nothing else — no sequence numbers, no timestamps, no audio
  /// offsets. Raising it to 3 or 4 would only make the deletion rarer and just
  /// as silent, and there is no measurement anywhere in this repo that would
  /// justify picking the new number: the 2 was copied from the server's
  /// `OVERLAP_MIN_CHARS` together with a justification (「a real overlap only
  /// comes from rollover replay, which restates MANY characters」) that the
  /// previous window corrected to FALSE right here in this file — while leaving
  /// the original standing verbatim in the file it named as the source. Trading
  /// one unexamined constant for another unexamined constant is the same mistake
  /// at a different scale.
  ///
  /// 🔴 THE TRADE-OFF, STATED PLAINLY (owner's rule: 丢字是一票否决 / "losing
  /// characters is an automatic veto"). Where a
  /// true overlap and a true repetition are indistinguishable — which here is
  /// ALWAYS — KEEP THE CONTENT. Losing a word the user said is strictly worse
  /// than showing a word twice: a duplicate is visible, the user can delete it,
  /// and we can measure it (`verify/eval` judge `no_duplication`); a deleted word
  /// leaves nothing behind to notice and is unrecoverable. 「开会」("meeting")
  /// twice IS
  /// legitimate speech.
  ///
  /// 🔴 THE ROOT MISTAKE, RECORDED SO IT IS NOT REPEATED. The previous window
  /// applied a DEDUP/OVERLAP rule to two segments that do not intersect at all —
  /// and the symmetry that exposes it (same span ⇒ revision ⇒ replace; different
  /// spans ⇒ disjoint ⇒ never drop either) is the criterion that same window
  /// established, four paragraphs above this one, for [put]. It was applied to
  /// [put] and not to [joined].
  ///
  /// ⚠️ WHAT NOW HAPPENS TO A GENUINE ROLLOVER-SEAM OVERLAP — the case the
  /// trimmer was built for. Read from the server【读码】("[read-from-code]"), greppable anchors all in
  /// apps/server-core/src/stt/orchestrator-core.ts: `rolloverSegment` captures the
  /// PRE-flush boundary (`const finalizedSeq = this.lastEngineFedSeq`), and after
  /// spawning the next engine calls `replayBufferTail(true)`, whose gate is
  /// `if (gateUnfed && chunk.seq <= this.lastEngineFedSeq) continue;`. So a
  /// rollover re-feeds ONLY the chunks that arrived DURING the flush round-trip,
  /// which its own comment (F-2152) asserts 「aren't in segment N's final」. IF
  /// that assertion holds the overlap is ZERO and removing the trimmer changes
  /// nothing. It is a RACE, not a design: `pushChunk` keeps feeding the OLD
  /// engine while `await this.flushAndEmitFinal(...)` is in flight, so the old
  /// engine's final MAY include that seam audio after all, and the flush timeout
  /// is `DEFAULT_ENGINE_FLUSH_TIMEOUT_MS = 3_000`, i.e. the race window is up to
  /// three seconds of speech. When it fires the user now sees those characters
  /// TWICE instead of losing them — the visible error, deliberately chosen.
  /// ⚠️ HOW OFTEN IT FIRES IS UNKNOWN AND CANNOT BE DETERMINED FROM THIS SIDE:
  /// nothing that reaches the phone says whether a seam was re-transcribed. The
  /// structurally correct fix is on the server, which is the only place that
  /// knows `finalizedSeq` — either guarantee F-2152, or DECLARE the seam width
  /// on the wire so this assembly can trim on a fact instead of on a string
  /// coincidence. REPORTED as an open account (W2.5-H) rather than smuggled in
  /// here — `packages/protocol` and `apps/server-core` belong to another window.
  ///
  /// 🔴 In-place correction (原地更正) (W2.5 / FB-6, 2026-08-06, this machine
  /// (本机) dev-pc-a【读码实证】/ "[verified by reading the code]"). This
  /// doc used to say the seam exists because 「orchestrator soft-segment rollover
  /// re-emits the last 5 s under a new idx」. THAT IS FALSE, and it was the
  /// stated reason for trimming at all. The five seconds are
  /// `DEFAULT_REPLAY_WINDOW_MS` and belong to the RECONNECT ladder's
  /// `replayBufferTail()` (no argument ⇒ `gateUnfed` false ⇒ the full window),
  /// which replays into the SAME segment index, i.e. it produces overlapping
  /// interims WITHIN a slot, not across slots. Original text kept in the
  /// previous sentence, not deleted (原文保留在上一句里，不删): it
  /// recorded a real past belief, and the correction is what it got wrong.
  String get joined => joinedFrom(0);

  /// [joined] restricted to slots at or after [minIdx] — the assembly of the
  /// spans that have NOT been settled into a row yet (N1-B2). Same rule as
  /// [joined]: concatenate in index order, drop nothing.
  String joinedFrom(int minIdx) {
    if (_texts.isEmpty) return '';
    final List<int> keys = _texts.keys.where((int k) => k >= minIdx).toList()
      ..sort();
    String out = '';
    for (int i = 0; i < keys.length; i++) {
      final String segText = _texts[keys[i]] ?? '';
      if (segText.isEmpty) continue;
      if (out.isEmpty) {
        out = segText;
        continue;
      }
      // No trimming, no containment check, no length comparison: a different
      // `segment_idx` is a different span, and a different span is never a
      // duplicate of what came before it.
      out = out + _joinerBetween(out, segText) + segText;
    }
    return out;
  }

  bool get isEmpty => _texts.isEmpty;
  Iterable<int> get finalizedSlots => _finalized;

  // ── N1-B2 settlement bookkeeping ───────────────────────────────────────────

  /// Highest `segment_idx` already turned into a row; −1 ⇒ none yet.
  int get settledThrough => _settledThrough;

  /// The lowest `segment_idx` that has not been settled yet.
  int get nextUnsettledIdx => _settledThrough + 1;

  /// The spans that have not been settled into a row yet, assembled.
  String get unsettledJoined => joinedFrom(nextUnsettledIdx);

  /// Σ of the engine-reported durations of the slots in `[minIdx, maxIdx]` that
  /// actually reported one. 0 ⇒ nothing in range reported a duration, which is
  /// the caller's cue to write NULL on the row rather than a fabricated 0
  /// (`entry_metrics.dart`: 「absence, not 0」).
  ///
  /// Bounded at BOTH ends on purpose: an out-of-order final could bank a slot
  /// beyond the span being settled, and a row must not claim time it does not
  /// cover.
  int durationBetween(int minIdx, int maxIdx) {
    int sum = 0;
    _durations.forEach((int k, int ms) {
      if (k >= minIdx && k <= maxIdx) sum += ms;
    });
    return sum;
  }

  /// Record that everything up to and including [idx] now lives on a row.
  ///
  /// 🔴 MONOTONIC BY CONSTRUCTION. This is the ONE thing standing between a
  /// replayed final and a second row carrying the same words (J5), so it must
  /// never move backwards: a reconnect-replay storm re-emits OLD indices, and
  /// accepting one would re-open spans that are already on screen.
  void markSettled(int idx) {
    if (idx > _settledThrough) _settledThrough = idx;
  }

  /// Visible for unit tests so joiner-choice cases can be pinned without the
  /// whole session FSM.
  static String joinerBetween(String left, String right) =>
      _joinerBetween(left, right);

  static String _joinerBetween(String left, String right) {
    if (left.isEmpty || right.isEmpty) return '';
    final String last = left[left.length - 1];
    if ('。！？'.contains(last)) return '\n';
    if ('，；、：'.contains(last)) return '';
    final int codeUnit = last.codeUnitAt(0);
    final bool lastIsAscii = codeUnit < 0x80;
    if (lastIsAscii) {
      final String firstR = right[0];
      if (firstR == ' ' || firstR == '\n') return '';
      return ' ';
    }
    return '';
  }
}
