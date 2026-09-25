// Card RC-1a - THE SETTLE CHAPTER OF THE JOURNAL LEG.
//
// A `part` of recovery_journal_leg.dart, moved out VERBATIM when that file
// crossed the 800-line cap (2026-09-06). Nothing here changed in the move: it
// is `_finish`, the one method that decides what a completed attempt does to
// the manifest and the bytes, in an extension so it can still reach the leg's
// own fields.
//
// 🔴 IT STILL DECIDES NOTHING ON ITS OWN. The verdict comes from
// `evaluateRecoverySettle` (session/recovery_settle.dart); this writes it down
// in A6-3's order - row read back, predicate, manifest, delete - and every
// early return in it is a check against the disk, because owner ruling O-5's
// delete can land at any point while an attempt runs.

part of 'recovery_journal_leg.dart';

extension RecoveryJournalLegSettle on RecoveryJournalLeg {
  /// Card FX-4 (owner ruling O-1) — the bytes go NOW, not at the next sweep.
  ///
  /// 🔴 THE COMMENT THAT STOOD ABOVE THE CALLER USED TO SAY 「the sweep is the
  /// only thing that removes them - this leg never calls a delete of its own」.
  /// That was a description, not a reason, and it left the two legs of one
  /// product answering 「when does settled audio go」 differently: the live path
  /// deletes inline (`retained_audio_live_settle.dart`, right after its own
  /// commit), the recovery path waited for the TTL. MEASURED 2026-09-06 (drill
  /// DF-2 (c)): 243,200 B and 248,320 B still on disk after `settled:true`, and
  /// still there across a relaunch. Ruling O-1 is 「success ⇒ delete」.
  ///
  /// ⚠️ THE ORDER IS UNCHANGED AND STILL LOAD-BEARING. `commit()` has already
  /// published `settled` + `resultRef`; only then do the bytes go. A crash
  /// between the two still leaves audio that is merely eligible, and the sweep
  /// is still the backstop that takes it — what changes is that the ordinary
  /// case no longer waits for the backstop.
  ///
  /// ⚠️ THE MANIFEST STAYS. Same decision the live path documents: it is the
  /// record of where this recording's words went, it costs a few hundred bytes,
  /// and `RetainedAudioJournalScan` already reads 「settled, and the bytes are
  /// gone」 as the one benign claim-ahead-of-file case.
  ///
  /// Never throws: a delete that failed is not a settle that failed.
  Future<void> _releaseBytes(String recordingId) async {
    // Built from the SAME two pieces `_manifestPathOf` uses, so the delete and
    // the existence checks above it always talk about one directory.
    final String pcm = _manifestPathOf(recordingId).replaceFirst(
      RegExp('${RegExp.escape(RetainedAudioJournal.manifestSuffix)}\$'),
      RetainedAudioJournal.pcmSuffix,
    );
    try {
      if (!await _fs.exists(pcm)) return;
      final int bytes = await _fs.lengthOf(pcm);
      await _fs.deleteFile(pcm);
      diag('audio.recovery.bytes_released', <String, Object?>{
        'recording_id': recordingId,
        'bytes': bytes,
      });
    } on Object catch (e) {
      debugPrint('[flowmic.audio] recovery settle release failed: $e');
    }
  }

  /// Card RC-3 — a manual retry of a [RecoveryQueueState.shortfall] came back
  /// whole: remove the rows the short attempt left in the SAME range, so the
  /// recording holds one set of words for that stretch (MAIN ruling
  /// 2026-09-24: 「the article must not show both the 8 characters and the full
  /// tail, and the part count must not grow」).
  ///
  /// ⚠️ 更正（RC-3b，2026-09-24）：原为「came back whole」only. A retry that comes
  /// back short AGAIN replaces too: two partial sets of one stretch is never
  /// the right page, whichever of the two is longer.
  ///
  /// 🔴 THE RANGE IS WHERE THE NEW ROWS WERE PLACED, not a guess: the replay
  /// cursor put them at the stretch start, and the fed range fixes the end.
  /// Rows of the same article inside `[start, start + range)` that this attempt
  /// did not produce are the earlier attempt's. A row the user EDITED is left
  /// alone — replacing it would throw their work away — and said in the diag.
  ///
  /// Card RC-3b — an edited row in the range is kept AND the new rows are
  /// added beside it, and the attempt settles as it would without the edit
  /// (MAIN ruling 2026-09-24: nothing is thrown away, the user is never stuck,
  /// and deletes the copy they do not want). Whether the edited row covers the
  /// WHOLE range (the earlier attempt's one row, at the stretch start with the
  /// range's length — `_spanMsFor` in chat_utterance_settle.dart) or only part
  /// of it, the page shows both; the diag line says which.
  /// ⚠️ 更正（RC-3b follow-up，2026-09-24）：原为 a whole-range edited row
  /// withdrew this attempt's rows and left the recording `shortfall` with
  /// `failed / kept_edited_row` — every later retry was thrown away the same
  /// way, and deleting the recording was the only exit.
  void _replacePartialRows(
    RecoveryIdentity identity,
    _Candidate c,
    List<String> newRowIds,
  ) {
    final Set<String> fresh = newRowIds.toSet();
    String? article;
    int? start;
    for (final String id in fresh) {
      final TimelineEntry? e = _timeline.findById(id);
      final int? off = e?.articleOffsetMs;
      if (e == null || off == null || e.articleId == null) continue;
      article = e.articleId;
      if (start == null || off < start) start = off;
    }
    if (article == null || start == null) return;
    final int end = start + pcmBytesToMs(c.range.length);
    final List<String> replaced = <String>[];
    final List<TimelineEntry> keptEdited = <TimelineEntry>[];
    for (final TimelineEntry m in articleMembersOf(_timeline, article)) {
      final int? off = m.articleOffsetMs;
      if (fresh.contains(m.id) || off == null || off < start || off >= end) {
        continue;
      }
      if (m.edited) {
        keptEdited.add(m);
        continue;
      }
      _timeline.delete(m.id);
      replaced.add(m.id);
    }
    final int from = start;
    final bool editCoversRange = keptEdited.any((TimelineEntry e) =>
        (e.articleOffsetMs ?? end) <= from &&
        (e.articleOffsetMs ?? 0) + (e.durationMs ?? 0) >= end);
    diag('audio.recovery.shortfall_replaced', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'replaced': replaced.length,
      'kept_edited': keptEdited.length,
      // RC-3b — which of the two edited-row outcomes this was.
      'edited_covers_range': editCoversRange,
      'edited_covers_part': keptEdited.isNotEmpty && !editCoversRange,
    });
  }

  /// Card RC-3b — an owed stretch in the MIDDLE of a long recording
  /// (`owedRangeEndBytes`) was recovered and came back EMPTY: the time it took
  /// off the live row that spanned the outage (`ArticleScribe.liveRowSpan`) goes
  /// back to that row, so the head returns to the recording's length (MAIN
  /// ruling 2026-09-24). The usual cause: the outage began in a pause, which the
  /// relay's gate never handed any engine and its ring let go, so
  /// `replayed_ms` left it out and the phone owed silence.
  ///
  /// The lender is the first row of the article at or after the stretch start
  /// — the stretch itself has no row, so in the running app that IS the row
  /// the length was taken from (it was claimed right after the stretch). The
  /// give-back is the exact inverse of the trim: offset − lent, length + lent.
  /// Once per recording: a previous empty attempt already gave it back.
  ///
  /// ⚠️ 更正（RC-K，2026-09-24）：原为 「once per recording」, read off the whole
  /// manifest's end and any empty attempt. A recording now owes a LIST of
  /// stretches, each lent by its own spanning row: the test is THIS stretch's
  /// end, and 「already given back」 is an empty attempt on THIS stretch's job.
  /// Card RC6 (F3) — the last stretch settled. With words, their row is placed
  /// and the stretch's recorded start is spent; as silence (no row), the time
  /// it borrowed from the row that spans it goes back ([_giveBackLentSpan]),
  /// and an owed tail keeps its own span on the clock (recorded silence).
  void _placeSettled(RecoveryIdentity identity, _Candidate c, String? rowId) {
    if (rowId == null && c.scan.owedRange?.end != null) {
      _giveBackLentSpan(identity, c);
      return;
    }
    _session.articles.dropStretchStart(
        RetainedAudioSpill.sessionKeyOf(identity.recordingId));
  }

  void _giveBackLentSpan(RecoveryIdentity identity, _Candidate c) {
    final OwedRange? stretch = c.scan.owedRange;
    if (stretch == null || stretch.end == null) return;
    final String empty = RecoverySettleRefusal.emptyResult.name;
    if (c.manifest.attempts.any((JournalAttempt a) =>
        a.failureCode == empty && a.jobId == identity.jobId)) {
      return;
    }
    final String key = RetainedAudioSpill.sessionKeyOf(identity.recordingId);
    final ArticleReplayTarget? target = articleReplayTargetFor(
      articles: _session.articles,
      timeline: _timeline,
      sessionKey: key,
      persistedStartMs: pcmBytesToMs(c.range.start),
      pinnedStartMs: stretch.atMs,
    );
    if (target == null) return;
    final int lent = pcmBytesToMs(c.range.length);
    TimelineEntry? lender;
    for (final TimelineEntry m in articleMembersOf(_timeline, target.articleId)) {
      final int? off = m.articleOffsetMs;
      if (off == null || off < target.stretchStartMs) continue;
      if (lender == null || off < lender.articleOffsetMs!) lender = m;
    }
    final TimelineEntry? l = lender;
    if (l != null && l.articleOffsetMs! >= lent) {
      _timeline.applyArticleSpan(l.id,
          offsetMs: l.articleOffsetMs! - lent,
          durationMs: (l.durationMs ?? 0) + lent);
    }
    _session.articles.dropStretchStart(key);
    diag('audio.recovery.empty_stretch_given_back', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'lent_ms': lent,
      'row': l?.id,
    });
  }

  /// Codex review ⑥ (2026-09-24) — place a recovery's rows on the AUDIO it fed.
  ///
  /// 🔴 A SEGMENT ROW'S `duration_ms` IS THE RELAY'S WALL TIME
  /// (server-core `orchestrator-rollover.ts` `boundaryMs = host.now()`), and a
  /// recovery is fed faster than real time (RC-2 paces it against the engine,
  /// not the clock). `_spanMsFor` swaps in the fed range only for a single
  /// whole-attempt row, so a recovery that came back in several rows advanced
  /// the replay cursor by wall seconds: MEASURED (recovery_codex_review_test ⑥)
  /// 280,814 ms of audio filed as 90,000 ms, the stretch ending 3 min early.
  ///
  /// The rows keep their order and their relative lengths — the only fact the
  /// phone has about where each one's words sit — and are stretched (or
  /// shrunk) to cover the range this attempt named, from the stretch start —
  /// the same length _spanMsFor gives a single whole-attempt row (a feed that
  /// stopped short is a shortfall, and its retry replaces these rows). Rows
  /// outside an article have no place to fix.
  ///
  /// Codex rc2 ⑤ — returns whether every span it changed was read back from
  /// storage as written (true when nothing needed changing). The caller treats
  /// false exactly like a row that never reached storage.
  Future<bool> _fitRowsToFedAudio(
      RecoveryIdentity identity, _Candidate c, List<String> newRowIds) async {
    final List<TimelineEntry> rows = <TimelineEntry>[
      for (final String id in newRowIds)
        if (_timeline.findById(id) case final TimelineEntry e
            when e.articleId != null && e.articleOffsetMs != null)
          e,
    ]..sort((TimelineEntry a, TimelineEntry b) =>
        a.articleOffsetMs!.compareTo(b.articleOffsetMs!));
    if (rows.isEmpty) return true;
    final int fedMs = pcmBytesToMs(c.range.length);
    final int sum =
        rows.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0));
    if (fedMs <= 0 || sum <= 0 || sum == fedMs) return true;
    final int start = rows.first.articleOffsetMs!;
    int cum = 0;
    final Map<String, (int, int)> wrote = <String, (int, int)>{};
    for (final TimelineEntry e in rows) {
      final int from = start + cum * fedMs ~/ sum;
      cum += e.durationMs ?? 0;
      final int to = start + cum * fedMs ~/ sum;
      _timeline.applyArticleSpan(e.id, offsetMs: from, durationMs: to - from);
      wrote[e.id] = (from, to - from);
    }
    bool durable = true;
    for (final MapEntry<String, (int, int)> w in wrote.entries) {
      await _timeline.awaitPersisted(w.key);
      if (!await _timeline.isPersistedAs(w.key, (TimelineEntry s) =>
          s.articleOffsetMs == w.value.$1 && s.durationMs == w.value.$2)) {
        durable = false;
      }
    }
    diag('audio.recovery.rows_fit_to_audio', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'rows': rows.length,
      'reported_ms': sum,
      'fed_ms': fedMs,
      'durable': durable,
    });
    return durable;
  }

  /// Codex rc2 ② — mark THIS (last) stretch [thisOutcome] and reopen every
  /// earlier stretch that came back empty, so the recording keeps its bytes and
  /// the user's retry feeds them (`RecoveryJournalLeg.runOne` takes the first
  /// stretch still owed). A stretch that came back empty this time is reopened
  /// too. Returns false, touching nothing, when there was no earlier empty one.
  bool _reopenEmptiesAtEnd(
      RetainedAudioJournal j, _Candidate c, String thisOutcome) {
    final OwedRange? stretch = c.scan.owedRange;
    final List<OwedRange> empties = <OwedRange>[
      for (final OwedRange o in c.manifest.owedRanges)
        if (o.done == OwedRange.doneEmpty) o,
    ];
    if (stretch == null || empties.isEmpty) return false;
    j.markOwedRangeDone(stretch.start, thisOutcome);
    for (final OwedRange o in empties) {
      j.markOwedRangeDone(o.start, null);
    }
    if (thisOutcome == OwedRange.doneEmpty) {
      j.markOwedRangeDone(stretch.start, null);
    }
    return true;
  }

  /// Codex rc2 ② — the inverse of [_giveBackLentSpan]: words came back for a
  /// stretch whose earlier attempt was empty and gave its time back to the
  /// spanning row. That row lends it again (offset + lent, length − lent), or
  /// the stretch would be counted twice in the head. Same test as the give-back
  /// guard: an empty attempt on THIS stretch's job, and a stretch in the middle.
  ///
  /// Codex rc2 follow-up — returns whether the re-trim is ON DISK (true when
  /// there was nothing to take back). Same rule as the fitted spans: the write
  /// is awaited and read back, and when it did not land the row is put back
  /// in memory as storage still has it and the caller keeps the audio (the
  /// attempt counts as rows not persisted: withdrawn, nothing deleted).
  Future<bool> _takeBackLentSpan(RecoveryIdentity identity, _Candidate c,
      List<String> newRowIds) async {
    final OwedRange? stretch = c.scan.owedRange;
    if (stretch == null || stretch.end == null) return true;
    final String empty = RecoverySettleRefusal.emptyResult.name;
    if (!c.manifest.attempts.any((JournalAttempt a) =>
        a.failureCode == empty && a.jobId == identity.jobId)) {
      return true;
    }
    final ArticleReplayTarget? target = articleReplayTargetFor(
      articles: _session.articles,
      timeline: _timeline,
      sessionKey: RetainedAudioSpill.sessionKeyOf(identity.recordingId),
      persistedStartMs: pcmBytesToMs(c.range.start),
      pinnedStartMs: stretch.atMs,
    );
    if (target == null) return true;
    final int lent = pcmBytesToMs(c.range.length);
    final Set<String> fresh = newRowIds.toSet();
    TimelineEntry? lender;
    for (final TimelineEntry m in articleMembersOf(_timeline, target.articleId)) {
      final int? off = m.articleOffsetMs;
      if (fresh.contains(m.id) || off == null || off < target.stretchStartMs) {
        continue;
      }
      if (lender == null || off < lender.articleOffsetMs!) lender = m;
    }
    final TimelineEntry? l = lender;
    if (l == null || (l.durationMs ?? 0) <= lent) return true;
    final int wasOff = l.articleOffsetMs!;
    final int wasDur = l.durationMs!;
    _timeline.applyArticleSpan(l.id,
        offsetMs: wasOff + lent, durationMs: wasDur - lent);
    await _timeline.awaitPersisted(l.id);
    final bool durable = await _timeline.isPersistedAs(l.id,
        (TimelineEntry s) =>
            s.articleOffsetMs == wasOff + lent &&
            s.durationMs == wasDur - lent);
    if (!durable) {
      _timeline.applyArticleSpan(l.id, offsetMs: wasOff, durationMs: wasDur);
    }
    diag('audio.recovery.lent_span_taken_back', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'lent_ms': lent,
      'row': l.id,
      'durable': durable,
    });
    return durable;
  }

  /// A6-3, in order: row read back -> settle predicate -> manifest -> delete.
  ///
  /// Codex rc3 ⑥ — and then tell the ledger a verdict was written: a result
  /// kept while it was being written goes to the late-settle hook when the
  /// verdict was a failure ([RecoveryAttemptLedger.failed], registered at the
  /// end of the failure branch), and is dropped otherwise.
  Future<void> _finish(
    _Candidate c,
    RetainedAudioJournal j,
    RecoveryIdentity identity,
    _AttemptResult r,
    RecoveryGateVerdict verdict,
  ) async {
    try {
      await _finishVerdict(c, j, identity, r, verdict);
    } finally {
      _session.articles.attempts.verdictGiven(identity.attemptId);
    }
  }

  Future<void> _finishVerdict(
    _Candidate c,
    RetainedAudioJournal j,
    RecoveryIdentity identity,
    _AttemptResult r,
    RecoveryGateVerdict verdict,
  ) async {
    // 🔴 THE RECORDING MAY HAVE BEEN DELETED WHILE THIS ATTEMPT RAN. Card
    // RC-1b's screen can remove audio at any moment (owner ruling O-5), and
    // the journal handle `_attempt` opened is still valid afterwards: every
    // write below would commit, RECREATING the manifest of a recording whose
    // bytes the user just threw away. The scan would then list it again -
    // claim ahead of an absent file, no recoverable range - and the delete
    // would look as if it had failed.
    //
    // Checked against the FILE, not against anything this object remembers:
    // the deletion happened in another object, through another handle, and
    // 「what is on the disk now」 is the only question worth asking. The screen
    // also refuses a delete while a retry is in flight, but that is a UI
    // courtesy on one entry point, and the automatic sweep does not go through
    // it at all.
    if (!await _fs.exists(_manifestPathOf(identity.recordingId))) {
      diag('audio.recovery.settle_skipped_gone', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
      });
      return;
    }
    // (iii) - two facts, not one. Await the handle, THEN read the row back:
    // the handle completes on failure too (its own doc says so), so only the
    // read proves anything is there after a kill.
    // ⚠️ 更正（Codex review ③，2026-09-24）：原为 `rowId` = the last row read
    // back, i.e. ANY one durable row counted as condition (iii) — and licensed
    // replacing the old rows and deleting the PCM while another row of the same
    // result had failed to reach storage (its words then exist nowhere after a
    // restart). Now the result counts as persisted only when EVERY row of this
    // attempt was read back; otherwise it is treated as no row at all: nothing
    // replaced, nothing deleted, and the ordinary failure path decides the rest.
    String? rowId;
    bool allRead = true;
    for (final String id in r.newRowIds) {
      await _timeline.awaitPersisted(id);
      if (await _timeline.isPersisted(id)) {
        rowId = id;
      } else {
        allRead = false;
      }
    }
    // Codex review ⑥ — this attempt's rows cover the audio that was FED, not
    // the relay's wall time; done before anything reads their offsets.
    // Codex rc2 ⑤ — and the change must be ON DISK before anything below may
    // delete the audio: a fitted span that did not persist leaves storage
    // saying the stretch is the relay's wall time long (280 s read as 90 s).
    if (allRead) allRead = await _fitRowsToFedAudio(identity, c, r.newRowIds);
    // Codex rc2 ② + follow-up — words for a stretch whose earlier attempt came
    // back empty: the time it gave back to its spanning row is taken back, and
    // that write too must be on disk before anything below may delete audio.
    if (allRead && r.newRowIds.isNotEmpty) {
      allRead = await _takeBackLentSpan(identity, c, r.newRowIds);
    }
    if (!allRead) {
      diag('audio.recovery.rows_not_all_persisted', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
        'rows': r.newRowIds.length,
      });
      // Codex rc2 ③ — 「no row」 must be TRUE: the rows of this attempt that
      // did reach storage are withdrawn too. Left in place, the next attempt
      // that succeeds adds its rows beside them (replacement runs only for a
      // shortfall) and the article carries the same paragraph twice.
      for (final String id in r.newRowIds) {
        if (_timeline.findById(id) != null) _timeline.delete(id);
      }
      rowId = null;
    }
    // 🔴 ASKED AGAIN, AFTER THOSE AWAITS AND IMMEDIATELY BEFORE THE FIRST
    // WRITE. The check above this block ran before two round trips through
    // persistent storage, and a delete (owner ruling O-5) landing inside that
    // window puts us right back in the state the check exists to prevent: every
    // call below commits, RECREATING the manifest of audio the user just threw
    // away. MEASURED as a flake in `pending_recovery_actions_test.dart`'s
    // delete-mid-attempt case (2 of 12 oversubscribed runs) - which is what a
    // window this narrow looks like from the outside.
    if (!await _fs.exists(_manifestPathOf(identity.recordingId))) {
      diag('audio.recovery.settle_skipped_gone', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
        'after': 'row_readback',
      });
      return;
    }
    final RecoverySettleDecision decision = evaluateRecoverySettle(
      RecoverySettleInputs(
        sent: identity.startEcho,
        framesEmitted: r.framesEmitted,
        receipt: r.receipt,
        resultText: r.resultText,
        endedOnTerminalFinal: r.endedOnTerminalFinal,
        rowPersistedAndReadBack: rowId != null,
        serverMayDelete: verdict.tier.mayDeleteBytes,
        fedWholeRange: r.fedWholeRange, // Codex review ①
        resultIsSilence: r.resultEmptyReason == kEmptyReasonNoVoice, // RC6 (F3)
      ),
    );
    diag('audio.recovery.settle', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'frames_emitted': r.framesEmitted,
      'fed_frames': r.receipt?.fedFrames,
      'decision': decision.reasonCode,
      'row': rowId,
    });
    // RC-3 — a retry of a shortfall that produced rows: they take the place of
    // the partial ones BEFORE anything is committed about them.
    // ⚠️ 更正（RC-3b，2026-09-24）：原为 only when this attempt came back whole
    // (`&& !decision.receiptShowsShortfall`); short again replaces too.
    final bool replacesShortfall =
        rowId != null && c.status.state == RecoveryQueueState.shortfall;
    if (replacesShortfall) _replacePartialRows(identity, c, r.newRowIds);
    // Card RC-K — a stretch that is NOT the recording's last owed one. Its
    // words came back (proven or not) or it came back empty: it is concluded,
    // marked done, and the recording stays `pending` so the next stretch is fed
    // (`_attemptRanges`). No byte goes yet — the recording is not finished.
    // A shortfall or a failure is not a conclusion and takes the paths below.
    final bool emptyOnly =
        decision.reasonCode == RecoverySettleRefusal.emptyResult.name;
    final bool concluded = decision.mayDeleteBytes ||
        (rowId != null && !decision.receiptShowsShortfall) ||
        emptyOnly;
    final OwedRange? stretch = c.scan.owedRange;
    if (concluded && stretch != null && c.scan.owedStretches > 1) {
      if (rowId != null) j.setResultRef(rowId);
      j.closeAttempt(identity.attemptId,
          outcome: decision.mayDeleteBytes
              ? JournalAttempt.outcomeSettled
              : JournalAttempt.outcomeSettledUnverified,
          failureCode: decision.mayDeleteBytes ? null : decision.reasonCode);
      // Codex rc2 ② — an EMPTY stretch is its own mark, not 「words without
      // proof」: it is reopened when the recording concludes
      // (`_reopenEmptiesAtEnd`) so the user's retry still has it to feed.
      j.markOwedRangeDone(
          stretch.start,
          decision.mayDeleteBytes
              ? OwedRange.doneSettled
              : (emptyOnly ? OwedRange.doneEmpty : OwedRange.doneUnverified));
      j.setRecoveryState(RecoveryQueueState.pending, clearNextEligibleAt: true);
      await j.commit();
      if (rowId != null) {
        _session.articles.dropStretchStart(
            RetainedAudioSpill.sessionKeyOf(identity.recordingId));
      } else {
        _giveBackLentSpan(identity, c); // an empty stretch, or RC6 silence
      }
      diag('audio.recovery.stretch_done', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
        'range': c.range.toString(),
        'decision': decision.reasonCode,
        'left': c.scan.owedStretches - 1,
      });
      return;
    }
    // Card RC-K — the LAST stretch settles as the single range it used to be,
    // except that its delete also needs every earlier stretch proven: one that
    // concluded without proof keeps the whole recording's bytes.
    final bool earlierUnproven = c.manifest.owedRanges
        .any((OwedRange o) => o.done == OwedRange.doneUnverified);
    // Codex rc2 ② — an earlier stretch that came back EMPTY also keeps the
    // bytes, and it is reopened: the recording lands `settled_unverified`, its
    // last `settled_unverified` attempt is that empty one (so the pending page
    // offers the retry), and the retry feeds it.
    final bool reopened = decision.mayDeleteBytes &&
        _reopenEmptiesAtEnd(j, c, OwedRange.doneSettled);
    if (decision.mayDeleteBytes && (earlierUnproven || reopened)) {
      if (rowId != null) j.setResultRef(rowId); // RC6 (F3): silence settles with no row
      j.closeAttempt(identity.attemptId,
          outcome: reopened
              ? JournalAttempt.outcomeSettled // this stretch's own truth
              : JournalAttempt.outcomeSettledUnverified,
          failureCode: reopened ? null : 'earlier_stretch_unverified');
      j.setRecoveryState(RecoveryQueueState.settledUnverified,
          clearNextEligibleAt: true);
      await j.commit();
      _placeSettled(identity, c, rowId);
      return;
    }
    if (decision.mayDeleteBytes) {
      // A6-3 (3): resultRef and the settled flag are published BEFORE the
      // bytes go. A crash between the two leaves audio that is merely
      // eligible, which is the safe direction.
      if (rowId != null) j.setResultRef(rowId); // RC6 (F3): silence settles with no row
      j.closeAttempt(identity.attemptId,
          outcome: JournalAttempt.outcomeSettled);
      j.markSettledForCleanup();
      j.setRecoveryState(RecoveryQueueState.settled,
          clearNextEligibleAt: true);
      await j.commit();
      // Card FX-4 — armed here, fired once this leg's handle on the PCM is
      // closed (see `_releaseAfterClose`). Deleting from here would throw a
      // sharing violation on Windows and be swallowed.
      _releaseAfterClose = identity.recordingId;
      // Card RC-3 — the stretch is placed; its recorded start is spent (the
      // legacy leg drops it at the same moment, backfill_runner.dart).
      _placeSettled(identity, c, rowId);
      return;
    }
    // 🔴 CARD RC-3 — A RECEIPT THAT SAYS 「SHORT」 GETS ITS OWN NAME.
    //
    // ⚠️ 更正（RC-3，2026-09-24）: the paragraph below lumps every row plus a
    // missing proof into `settled_unverified`, whose sentence and action say
    // 「the words are already yours, only the proof is missing — delete is all
    // that is left」. That was false for the case root-cause §1.8 measured: the
    // relay's 3 s flush cap handed back eight words for a 398 s range on a
    // receipt that refused, and the page said 「7:01 awaiting confirmation」 for
    // good with no way to try again.
    //
    // ⇒ when the receipt itself says the attempt fell short
    // ([RecoverySettleDecision.receiptShowsShortfall]) the state is
    // [RecoveryQueueState.shortfall]: the row stays (they are the user's words),
    // the bytes stay, and — owner ruling 2026-09-06 §3, which still stands —
    // NOTHING retries it automatically (without a stable operation id, RC-8,
    // every automatic retry would bill the range again). The pending screen
    // offers the user's own retry, and a retry that succeeds replaces these
    // rows ([_replacePartialRows]). No backoff is written: there is no
    // automatic attempt for it to delay.
    if (rowId != null && decision.receiptShowsShortfall) {
      diag('audio.recovery.shortfall', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
        'decision': decision.reasonCode,
        'row': rowId,
      });
      j.setResultRef(rowId);
      j.closeAttempt(identity.attemptId,
          outcome: JournalAttempt.outcomeFailed,
          failureCode: 'shortfall:${decision.reasonCode}');
      j.setRecoveryState(RecoveryQueueState.shortfall,
          clearNextEligibleAt: true);
      await j.commit();
      return;
    }
    // Did it produce a row at all? A row plus a missing proof is
    // `settled_unverified` (A5-3): kept, and never automatically retried,
    // because retrying would transcribe words the user already has.
    //
    // 🔴 AN EMPTY RESULT LANDS HERE TOO, WITH NO ROW. A5-4: the engine
    // answered and produced nothing, so there is no row to point at - but this
    // is not a failed attempt either, and calling it one would spend the
    // automatic budget hammering an engine that is answering perfectly well.
    // The state is what the screen reads to offer the user's own retry, which
    // is the only thing that can change the outcome.
    if (rowId != null || emptyOnly) {
      // Codex rc2 ② — earlier empty stretches are reopened here too.
      _reopenEmptiesAtEnd(j, c,
          emptyOnly ? OwedRange.doneEmpty : OwedRange.doneUnverified);
      if (rowId != null) j.setResultRef(rowId);
      j.closeAttempt(identity.attemptId,
          outcome: JournalAttempt.outcomeSettledUnverified,
          failureCode: decision.reasonCode);
      j.setRecoveryState(RecoveryQueueState.settledUnverified,
          clearNextEligibleAt: true);
      await j.commit();
      // RC-3 — words came back and are placed; the recorded start is spent.
      if (rowId != null) {
        _session.articles.dropStretchStart(
            RetainedAudioSpill.sessionKeyOf(identity.recordingId));
      } else {
        _giveBackLentSpan(identity, c); // RC-3b — an empty middle stretch
      }
      return;
    }
    // lane EC (2026-09-06) - THE BINDING CONFLICT ENDS THIS ATTEMPT AND NOTHING
    // ELSE. The server refused the `audio:start` because the operation id was
    // already bound to different audio; ruling O-9 (乙) says the first
    // registration stands, so there is nothing here to overwrite and nothing to
    // re-send.
    //
    // 🔴 IT IS DELIBERATELY NOT A SPECIAL PATH. The ordinary failure below is
    // already the right one: the attempt closes `failed`, the BYTES STAY, and an
    // `auto_retry` attempt moves the auto budget and the backoff so the next
    // eligible pass runs `_attempt` again - which mints a fresh attempt id AND A
    // FRESH OPERATION ID (see its comment at the identity it builds). So the
    // operation that was just refused can never be sent twice, structurally,
    // and the five-attempt budget still bounds how many fresh ones there are.
    // What this branch adds is the honest label and a line in the diagnostics;
    // inventing a recovery path for a state that already recovers is how a
    // façade gets built.
    if (r.refusalCode == kAudioOpBindingConflictCode) {
      diag('audio.recovery.binding_conflict', <String, Object?>{
        'recording_id': identity.recordingId,
        'attempt_id': identity.attemptId,
        'refused_operation_id': identity.operationId,
      });
    }
    j.closeAttempt(identity.attemptId,
        outcome: JournalAttempt.outcomeFailed,
        // The server's own word for it wins over a clock label: `stall_*` says
        // 「something ended the wait」, the code says which refusal it was.
        failureCode: r.refusalCode ?? r.timeoutKind ?? decision.reasonCode);
    // CARD RC-1b - A USER'S OWN FAILED ATTEMPT CHANGES NOTHING ABOUT THE
    // AUTOMATIC ROUTE. Two things would otherwise go wrong at once: the queue
    // state would be recomputed from `stateAfterAutoFailure()` (which reads the
    // AUTO budget) and, worse, `nextEligibleAfterFailure` would push the next
    // automatic attempt further out - so pressing "try again" would DELAY the
    // thing the button is trying to help with. The attempt is still recorded
    // above, because the manifest is the history; it just does not move a
    // budget it is not part of (`RecoveryJobStatus.fromManifest` counts
    // `auto_retry` failures only, which is the other half of the same rule).
    if (identity.attemptKind == RecoveryAttemptKind.autoRetry) {
      final int now = _clock();
      j.setRecoveryState(c.status.stateAfterAutoFailure(),
          nextEligibleAtMs: c.status.nextEligibleAfterFailure(now));
    }
    await j.commit();
    // 🔴 CARD RC-N (MAIN ruling 2, option B) — THE RESULT MAY STILL COME. The
    // relay keeps flushing after we stop waiting (S6: final 26.7 s after
    // `audio:stop`, phone gave up at 15.3 s), and the account has paid for it.
    // If its terminal final lands while no newer attempt covers this range,
    // it is settled as if it had come in time; once a newer attempt opens,
    // the ledger drops it and it writes nothing.
    final _AttemptResult was = r;
    _session.articles.attempts.failed(identity.attemptId,
        onLate: (List<String> rowIds, Object frame) {
      if (frame is! SttFinal) return;
      unawaited(_session.articles.attempts.serialize(() => _settleLate(
            identity: identity,
            verdict: verdict,
            was: was,
            rowIds: rowIds,
            late: frame,
          )));
    });
  }

  /// Card RC-N — settle a failed attempt on its late result, through the same
  /// [_finish] a result in time goes through. Nothing is written when the
  /// recording is gone, settled, or owes a different stretch now, or when the
  /// late words never reached a row (the failure recorded before stands).
  Future<void> _settleLate({
    required RecoveryIdentity identity,
    required RecoveryGateVerdict verdict,
    required _AttemptResult was,
    required List<String> rowIds,
    required SttFinal late,
  }) async {
    _Candidate? c;
    for (final _Candidate x in await _scanCandidates()) {
      if (x.scan.recordingId == identity.recordingId) c = x;
    }
    RecoverySampleRange? owed;
    try {
      owed = c == null
          ? null
          : RecoverySampleRange.fromBytes(c.range, c.manifest.format);
    } on ArgumentError {
      owed = null; // A3-2a: not a coordinate; `_attempt` refuses it too
    }
    final bool sameRange = owed != null &&
        owed.startSample == identity.range.startSample &&
        owed.endSample == identity.range.endSample;
    final bool landed = rowIds.isNotEmpty || late.text.trim().isEmpty;
    // Codex rc4 ② — this attempt ended because the relay SAID part of the
    // stretch reached no engine (STT_SEGMENT_NOT_TRANSCRIBED, ahead of this very
    // final: server-core `owed-voice-verdict.ts`). Its receipt still counts every
    // frame accepted, so settling it here released audio whose words exist
    // nowhere. RC-N's option B is for a result we stopped waiting for, not for
    // one the relay has already called short: the failure stands, the stretch
    // stays owed, the audio stays.
    final bool relayCalledShort = was.refusalCode == kSttSegmentNotTranscribed;
    // RC6 (F1) — an EMPTY late final the relay did not stamp with an
    // `empty_reason` says nothing about the audio: the relay stamps one unless
    // an engine error already spoke (server-core `stt/empty-final-cause.ts`),
    // and re-check 5 measured exactly that — `STT_NO_ENGINE_REACHED`, then this
    // final. Read as 「the engine heard it and there were no words」 it filed
    // 55 s no engine ever heard as `settled_unverified` and never retried. The
    // failure stands; the RC-O timer retries it.
    final bool unheard = late.text.trim().isEmpty && late.emptyReason == null;
    diag('audio.recovery.late_result', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'rows': rowIds.length,
      'same_range': sameRange,
      'relay_called_short': relayCalledShort,
      'unheard': unheard,
      'settling': c != null && sameRange && landed && !relayCalledShort && !unheard,
    });
    if (c == null || !sameRange || !landed || relayCalledShort || unheard) return;
    final RetainedAudioJournal j = await _openJournal(identity.recordingId);
    try {
      await _finish(
        c,
        j,
        identity,
        _AttemptResult(
          framesEmitted: was.framesEmitted,
          endedOnTerminalFinal: true,
          receipt: late.coverage,
          resultText: late.text,
          resultEmptyReason: late.emptyReason, // RC6 (F3)
          newRowIds: rowIds,
          fedWholeRange: was.fedWholeRange,
        ),
        verdict,
      );
    } finally {
      // Same close as `_attempt`'s: the handle first, then any bytes `_finish`
      // decided may go (FX-4), and never a commit onto a deleted recording.
      if (await _fs.exists(_manifestPathOf(identity.recordingId))) {
        await j.close();
        final String? release = _releaseAfterClose;
        if (release != null) await _releaseBytes(release);
      } else {
        await j.abandon();
      }
      _releaseAfterClose = null;
    }
  }
}
