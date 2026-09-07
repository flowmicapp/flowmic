// Part of chat_controller.dart — THE SETTLEMENT OF ONE SPAN (N1-B2).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_utterance.dart went to 820 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800 when N1-B2 turned 「一次说话＝一行」("one utterance = one row")
// into 「一段＝一行」("one segment = one row") (docs/rebuild/15 §2.0-c). This
// repo's established practice is **structural splitting, not deleting
// evidence**: what needs cutting is 「内容不该在这里」("content that does not
// belong here"), not 「内容太长」("content that is too long").
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR —— [_settlesPerSegment] and [_settleSpan]
// were moved out of chat_utterance.dart character-for-character, not one
// character changed. They are one self-contained unit: **"how an already
// finalized span becomes a row, and starts its delivery"**.
// What chat_utterance.dart kept is its **upstream** — which frame should
// trigger a settlement.
// **Any diff beyond the move is a bug.**

part of 'chat_controller.dart';

/// True when THIS utterance settles segment-by-segment (15 册 §2.0-c).
///
/// ── 🔴 N1-B2 — WHY realtime ONLY (RULED: owner 2026-08-11 deferred-batch #3) ──
/// 15 册 §2.0-c writes the new cardinality (one segment = one row) without
/// saying a word about translate/organize, and the code answers for it:
/// [UtteranceComposeController.start]
/// is STRICTLY SINGLE-FLIGHT (`if (isRunning) return busy`, one `_entryId`, one
/// `_requestId`, one watchdog `_timer`). Settling per segment there would hand
/// segment 2 onward a `busy` failure each — i.e. every segment after the first
/// would render as a failed transform.
///
/// ✅ This began life as an interim default awaiting owner approval item #9.
/// **The owner ruled on 2026-08-11: whole-utterance settle for
/// translate/organize is the TERMINAL state, and the widen-to-per-segment
/// option is dead, not deferred**
/// (docs/decisions/2026-08-11-owner-deferred-batch-explanations-and-rulings.md
/// §2 #3; 15 册 §2.0-c carries the same verdict). The pin in
/// `chat_segment_settlement_test.dart` 「translate/organize 维持整次结算」
/// ("translate/organize keep whole-utterance settlement") now guards a
/// ruling, not a placeholder.
/// ⚠️ The same batch mandated the unified segment/session package; until its
/// §2-R2 question returns (the doc-15 ruling-request book #15), the realtime
/// half of this predicate is frozen too — in BOTH directions.
bool _settlesPerSegment(ChatController c) => _composeTaskFor(c._activeMode) == null;

/// Card FX-3 — how long is the audio behind this row?
///
/// The default is Σ over the engine's own `duration_ms` for the spans the row
/// covers — REG-D1, and the right answer for a live press, where nothing on
/// this phone knows the length of what the microphone is still capturing.
///
/// 🔴 A RECOVERY ROW THAT COVERS THE WHOLE ATTEMPT USES THE FED RANGE INSTEAD.
/// MEASURED 2026-09-06 (drill DF-2 (b)): a 7.6 s recovery — `audio intake
/// audioMs 7600` in the server's own log — produced a row reading 「0.5s · 10
/// words」. We fed that audio ourselves, out of a file whose byte range we
/// chose, so its length is a MEASUREMENT here and only a report from the engine
/// there. Between a number we measured and a number we were told, the one we
/// measured wins.
///
/// ⚠️ ONLY FOR THE WHOLE-ATTEMPT ROW (`!isSegment` and starting at the first
/// span). A soft-segment row covers part of the fed range and nothing maps
/// spans onto byte offsets, so stamping the whole range on it would replace an
/// under-report with an over-report — and unlike the engine's number, it would
/// be wrong by design rather than by accident.
int _spanMsFor(ChatController c, SttFinal f, int fromIdx) {
  final int engineMs = c.session.segments.durationBetween(fromIdx, f.segmentIdx);
  final RecoverySampleRange? range = c.session.openSessionRange;
  if (range == null || f.isSegment || fromIdx != 0) return engineMs;
  final int sampleRate = AudioJournalFormat.current.sampleRate;
  if (sampleRate <= 0) return engineMs;
  final int samples = range.endSample - range.startSample;
  return samples > 0 ? samples * 1000 ~/ sampleRate : engineMs;
}

/// Card FX-2 — was this final produced by a recovery attempt or by a live press?
///
/// TWO LOCKS, and they fail in opposite directions on purpose.
///   1. [PttSession.openSessionDelivery] — what WE put on the `audio:start`
///      that is open. Phone-local, always present, never guesses. This is the
///      one that closes the measured defect.
///   2. the coverage receipt's echo — the server puts back the `recording_id`
///      and `attempt_id` the opener sent. A receipt naming an attempt that is
///      not the live one is a recovery conclusion however lock 1 reads. Same
///      discriminator `live_settle.dart` already uses, and same caveat: an
///      older relay strips the echoes, so a NULL echo is neither a match nor a
///      mismatch and lock 1 answers alone.
///
/// ⚠️ Lock 2 is not redundancy for its own sake. `beginBackfill` refuses while
/// a press is running, but the terminal final of a press arrives AFTER
/// `audio:stop`, so there is a window in which a recovery could open the wire
/// before the live conclusion lands. In that window lock 1 alone would call a
/// live final recovered - the safe direction (a row stays on the phone) - and
/// lock 2 cannot help. What lock 2 covers is the reverse ordering.
Delivery _deliveryOfThisFinal(ChatController c, SttFinal f) {
  if (c.session.openSessionDelivery == Delivery.none) return Delivery.none;
  final CoverageReceipt? r = f.coverage;
  final LiveAudioAttempt? live = c.session.audio.retainedAudio?.liveAttempt;
  final bool namesAnotherAttempt = r != null &&
      live != null &&
      ((r.attemptId != null && r.attemptId != live.attemptId) ||
          (r.recordingId != null && r.recordingId != live.recordingId));
  return namesAnotherAttempt ? Delivery.none : c._activeDelivery;
}

/// Turn the spans `[fromIdx, f.segmentIdx]` into ONE row and start its delivery.
///
/// The single settlement path: a soft-segment final in realtime and the terminal
/// final in every mode both land here. 🔴 **There must never be a second one** —
/// the 15 册 §2.0-c cardinality change was accepted on the basis that a segment
/// row is the SAME KIND of row, and a copy of this fork would give 「what happens
/// to a settled span」 two answers (this repo's #1 defect shape).
void _settleSpan(
  ChatController c,
  SttFinal f, {
  required int fromIdx,
  required String text,
  String? clientId,
}) {
  final SegmentBuffer segs = c.session.segments;
  // 🔴 REG-D1 — Σ over the spans THIS row covers, never `f.durationMs`. For the
  // whole-utterance settlement that sum IS the whole recording; for a segment
  // row it is that span. `f.durationMs` answers 「这一段有多长」("how long is
  // this segment") on both exits since `24b75cc`, so copying it onto a
  // whole-utterance row reported the last segment only. 0 ⇒ nothing in range
  // reported one ⇒ NULL (absence, not 0 — entry_metrics.dart).
  final int spanMs = _spanMsFor(c, f, fromIdx);
  // 🔴 CR-7/CR-8 — claim this row's place in the recording, if one is running.
  //
  // Null for every ordinary utterance, which is almost all of them, and the
  // cost of asking is a null check on a closed scribe. CLAIMED EXACTLY ONCE
  // per row, here, because claiming ADVANCES the clock: a second claim for
  // one row would push every later row late by that row's own length, and the
  // error compounds down the rest of the recording with nothing to compare it
  // against.
  //
  // ⚠️ Claimed BEFORE the row is built rather than after, so the offset and
  // the row are ONE write. Building first and stamping second would leave a
  // window in which a row exists inside an article at no position — and the
  // article reader orders by exactly that field.
  final ({String articleId, int offsetMs})? place =
      c.session.articles.claim(spanMs > 0 ? spanMs : null);
  // 🔴 CARD FX-2 — THE DELIVERY OF THE SESSION THAT PRODUCED THIS FINAL, NOT
  // THE ONE THE LAST BUTTON PRESS CHOSE. `c._activeDelivery` is written in
  // `pttDown` and nowhere else; a recovery attempt opens its own `audio:start`
  // with `delivery: none` and used to leave that field holding either the
  // previous press's destination or — after a relaunch — the field's own
  // default, `inject`. The recovered transcript was then minted as an
  // injectable row and `_deliverDirect` put it on the PC.
  //
  // MEASURED 2026-09-06 (drill DF-2 (a), B-11): `inject:request` on the PC with
  // `inject_origin:"live"` for a transcript the manifest calls `auto_retry`.
  // Forbidden by E17 / owner ruling O-8 — recovered words are never sent.
  //
  // ⚠️ IT IS NOT AN EXTRA GUARD ON THE DELIVERY CALL, AND THAT IS THE POINT.
  // The row itself must be record-only, because a row that says `inject` is one
  // a long-press re-delivery would happily send later. `_deliverDirect` already
  // returns on `Delivery.none`, so the send stops as a CONSEQUENCE of the row
  // being honest rather than as a second rule that could drift from it.
  final Delivery wireDelivery = _deliveryOfThisFinal(c, f);
  final TimelineEntry entry = c.store.buildFromUtterance(
    clientId: clientId ?? c._mintClientId(),
    mode: c._activeMode,
    delivery: wireDelivery,
    text: text,
    sourceLang: f.language.isNotEmpty ? f.language : null,
    durationMs: spanMs > 0 ? spanMs : null,
    // How many engine spans stand behind THIS row — not how many the utterance
    // has had. They coincide exactly when the row is the whole utterance.
    segmentsCount: f.segmentIdx - fromIdx + 1,
    origin: c.destination.isFixed ? 'cloud' : 'paired',
    articleId: place?.articleId,
    articleOffsetMs: place?.offsetMs,
    // D7 ③ — the server-minted utterance id off this final, so a later
    // `stt:refined` can name this row. Null when the relay predates ids, in
    // which case no refine will ever match it, which is the safe direction.
    utteranceId: f.utteranceId,
  );
  // The head is minted LAZILY, on the first segment that settles, and never
  // before: a recording nobody said anything into leaves nothing behind,
  // which is the honest record of it. The builder is idempotent on the id, so
  // every later segment finds the head rather than forking a second cover.
  //
  // ⚠️ The head's createdAt is the SCRIBE's start instant, not now — the
  // recording began when the button was pressed, and the list sorts by it.
  if (place != null) {
    buildArticleHeadOf(
      c.store,
      articleId: place.articleId,
      startedAt: c.session.articles.startedAt ?? entry.createdAt,
    );
    refreshArticleHeadOf(c.store, place.articleId);
  }
  // 🔴 J5 — the row exists, so the span is spoken for. Advance BEFORE any
  // `await`-carrying delivery so a replay landing inside that window is judged
  // against a watermark that already includes this row.
  segs.markSettled(f.segmentIdx);
  // 🔴 CARD LS-1b — THE LIVE RECORDING'S AUDIO SETTLES HERE, AND ONLY ON THE
  // TERMINAL FINAL. Placed ABOVE the compose fork on purpose: that fork returns
  // for translate/organize, so a call after it would settle realtime recordings
  // and silently never settle the other two modes' — a hole with no symbol to
  // grep for. `!f.isSegment` is the whole cardinality rule (one journal per
  // recording, segments are the server's unit); see live_settle.dart's foot.
  //
  // A no-op unless the journal face is on, and it deletes nothing unless
  // `evaluateRecoverySettle` says all three conditions held. Unawaited because
  // it reads persistent storage and a row's face may not wait on a disk read.
  if (!f.isSegment) {
    unawaited(settleLiveRecording(
      session: c.session,
      timeline: c.store,
      receipt: f.coverage,
      finalText: f.text,
      rowId: entry.id,
    ));
  }
  c._liveText = '';
  // Card D-2's `c._lastUtteranceEntryId = entry.id` stood here until
  // 2026-09-03: the row now carries the server's `utterance_id` (built in
  // above), which is the key a refine matches on — see `_applyRefined`.
  // Honest signal only — does not touch entry.status / timeline schema. The
  // mark is per-entry and session-persistent (lead's ruling): once an utterance
  // reports polish:skipped its bubble keeps the mark; later utterances never
  // clear earlier marks.
  if (f.polish == SttPolish.skipped) {
    c._polishSkippedEntryIds.add(entry.id);
  }
  // GA-01: translate / organize are PRODUCT modes, not metadata. The row is
  // built (the utterance happened) but nothing is delivered or synced yet — the
  // LLM runs first and the finished text goes up in ONE history:create. The
  // row's face meanwhile is the STT text: honest, and never delivered.
  // realtime falls through to the direct/manual fork below, unchanged.
  //
  // ⚠️ N1-B2: this arm is reachable ONLY from the terminal final, because
  // [_settlesPerSegment] is exactly `task == null`. That is not a coincidence to
  // be tidied away — it is the whole reason translate/organize still settle once
  // per utterance (see that predicate for the single-flight measurement).
  final ComposeTask? task = _composeTaskFor(c._activeMode);
  if (task != null) {
    final AiComposeFailure? failed = c.utteranceCompose.start(
      entryId: entry.id,
      requestId: entry.clientId,
      task: task,
      sourceText: text,
      sourceLang: entry.sourceLang,
      // The target language rides along ONLY for translate; organize rewrites
      // in place and has no target pair.
      targetLang: task == ComposeTask.translate ? c._translateTarget : null,
    );
    if (failed != null) c.ucFailed(entry.id, AiComposeOutcome(reason: failed));
    c.ucNotify();
    return;
  }
  // 08 §5 send policy fork. The ROW is built either way (§4.0 A: the utterance
  // completed, so the record exists) — only the DELIVERY differs.
  if (c._activeSendPolicy == SendPolicy.manual &&
      entry.delivery != Delivery.none &&
      entry.origin != 'cloud') {
    // hold-then-send: nothing is delivered now. The text lands in the editable
    // buffer and the row stays ⏳ until the explicit ➤ (or settles at 📥 noted
    // if the user discards the buffer).
    //
    // A 「仅记录」("record-only")/cloud utterance is deliberately NOT folded
    // in: it was never meant for the PC (「留在手机」 — "stays on the phone"),
    // so pre-loading it into the send box would stage exactly the accidental
    // delivery §4.0 C exists to prevent. Its row is already 📥 noted, and a
    // long-press deferred re-delivery (长按补投) remains the explicit way to
    // send it.
    _foldIntoBuffer(c, text);
    c._bufferedEntryIds.add(entry.id);
  }
  // 0.2.27: the §4.0 C emit-side gate (`_gateEntry` -> `history:create`) used to
  // run here before the delivery. There is no room row to create any more (owner
  // architecture ruling), and the ordering it bought — 「the stored row provably
  // precedes the inject」 — is moot now that the phone owns the row. §4.0 C itself
  // still holds and is now STRUCTURAL: a 「仅记录」("record-only") row is not delivered, so it
  // never leaves this device.
  if (c._activeSendPolicy == SendPolicy.direct) {
    unawaited(_deliverDirect(c, entry));
  }
  c.ucNotify();
}
