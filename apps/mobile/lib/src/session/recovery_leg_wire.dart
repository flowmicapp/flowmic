// Card RC-1a/RC-1b — THE ON-WIRE ATTEMPT, the journal leg's largest chapter.
//
// A `part` of recovery_journal_leg.dart, moved out VERBATIM on 2026-09-06
// (audit A9's 700-line cap) — the mother file grew past it once RC-1's live
// settle wiring (`recovery_leg_settle.dart`) and today's manifest-republish
// fixes landed. Not one character below changed; only this header, the
// `part of` line, and the `extension … on RecoveryJournalLeg` wrapper are
// new — the same shape `recovery_leg_settle.dart` already uses for the same
// reason (an extension keeps every private-field reference below working
// unchanged, because a `part` shares the library rather than reopening the
// class).
//
// WHY THIS IS THE RIGHT CUT: `_attempt` (still in the mother file) decides
// WHETHER a candidate gets a wire attempt and what to do with the outcome;
// everything here answers 「what happens once that attempt starts」 — opening
// the journal handle, streaming the range, waiting for the terminal final
// under four clocks, and reading the receipt/text off whatever finals came
// back. Nothing here is called from outside `_attempt`, and nothing here
// calls back into `_finish` or `_scanCandidates`.

part of 'recovery_journal_leg.dart';

extension RecoveryJournalLegWire on RecoveryJournalLeg {
  /// Where this recording's manifest lives, built the same way
  /// `RetainedAudioJournalScan` builds it (dir + separator + id + suffix), so
  /// the existence check in `_finish` asks about the same file the scan reads.
  String _manifestPathOf(String recordingId) {
    final String dir = _spill.store.dirPath;
    final String sep = dir.endsWith('/') || dir.endsWith(r'\') ? '' : '/';
    return '$dir$sep$recordingId${RetainedAudioJournal.manifestSuffix}';
  }

  Future<RetainedAudioJournal> _openJournal(String recordingId) =>
      RetainedAudioJournal.open(
        dirPath: _spill.store.dirPath,
        recordingId: recordingId,
        fs: _fs,
        // 🔴 Never let a group-commit timer fire behind a leg that is about to
        // write an outcome: this handle exists to record decisions, not to
        // track a capture.
        commitInterval: const Duration(days: 1),
        // Card RF-2 - the delete is a fact, not a file check. Every write this
        // leg makes goes through `commit()`, and `commit()` asks this.
        deleted: _spill.deletedRecordings,
      );

  /// Open the session, stream the range, close it, and watch four clocks.
  Future<_AttemptResult> _runOnWire(
    _Candidate c,
    RecoveryIdentity identity,
    String sourceLang,
  ) async {
    if (!_session.beginBackfill(
      mode: FlowMode.realtime,
      sourceLang: sourceLang,
      prefs: _phonePrefs?.call(),
      identity: identity,
    )) {
      return const _AttemptResult(refusedByGate: true);
    }
    final _ProgressClocks clocks = _ProgressClocks(_clock);
    final StreamSubscription<SttInterim> interims =
        _session.stt.interims.listen((_) => clocks.noteEngine());
    final List<SttFinal> finals = <SttFinal>[];
    final StreamSubscription<SttFinal> finalsSub =
        _session.stt.finals.listen((SttFinal f) {
      clocks.noteEngine();
      finals.add(f);
    });
    // 🔴 SUBSCRIBED FOR THE WHOLE ATTEMPT, NOT ONLY WHILE WAITING FOR THE FINAL.
    // A refusal of the `audio:start` itself — the operation binding conflict is
    // one — arrives EARLY: the FSM can stall inside `endBackfill` before
    // `_awaitTerminal` has opened its own listener, and that path returns the
    // bare label `'stall'`. MEASURED: with the listener only inside the wait,
    // the manifest recorded `failureCode: 'stall'` and the server's own code was
    // gone. The code is the whole reason the code exists, so it is captured
    // from the first frame of the attempt.
    final Set<String> before = _timeline.entries
        .map((TimelineEntry e) => e.id)
        .toSet();
    int framesEmitted = 0;
    bool linkLost = false;
    try {
      framesEmitted = await _streamRange(c, identity, clocks);
      if (framesEmitted == 0) {
        _session.abortBackfill();
        return const _AttemptResult(linkLost: true);
      }
      // 🔴 LISTENING FROM BEFORE `endBackfill`, NOT FROM INSIDE THE WAIT.
      // A refusal of the `audio:start` itself — the operation binding conflict
      // is one — is LATCHED by the FSM while the leg is still uploading
      // (`onSttTerminalError` keeps it in `_pendingTerminalError` during
      // RECORDING) and fires SYNCHRONOUSLY inside `endBackfill`. That is before
      // `_awaitTerminal` opens its own listener, so that path returns the bare
      // label `'stall'` and the server's code is gone.
      // MEASURED: without this, the manifest recorded `failureCode: 'stall'`.
      // ⚠️ Scoped to these two statements on purpose. An earlier draft listened
      // for the whole attempt including `_streamRange`, and
      // `pending_recovery_actions_test.dart`'s delete-mid-attempt case went red
      // — a listener on a `sync` broadcast controller is not free, and this one
      // has no business being awake while bytes are being pushed.
      String? refusalCode;
      final StreamSubscription<SttStall> refusalSub =
          _session.sttStalled.listen((SttStall s) => refusalCode ??= s.code);
      final _WaitOutcome w;
      try {
        _session.endBackfill();
        w = await _awaitTerminal(
          clocks: clocks,
          audio: Duration(milliseconds: pcmBytesToMs(c.range.length)),
        );
      } finally {
        await refusalSub.cancel();
      }
      linkLost = w.timedOut && !w.reachedTerminal;
      final Set<String> after =
          _timeline.entries.map((TimelineEntry e) => e.id).toSet();
      return _AttemptResult(
        framesEmitted: framesEmitted,
        endedOnTerminalFinal: w.reachedTerminal,
        receipt: _receiptOf(finals),
        resultText: _terminalTextOf(finals),
        newRowIds: after.difference(before).toList(),
        timeoutKind: w.timeoutKind,
        refusalCode: w.stallCode ?? refusalCode,
        linkLost: linkLost,
      );
    } finally {
      await interims.cancel();
      await finalsSub.cancel();
    }
  }

  /// The receipt off the TERMINAL final (`is_segment == false`). A segment
  /// final's receipt would describe one 30 s slice, and using it to license a
  /// delete of the whole range is exactly the confusion A7-1 warns about.
  CoverageReceipt? _receiptOf(List<SttFinal> finals) {
    for (final SttFinal f in finals.reversed) {
      if (!f.isSegment && f.coverage != null) return f.coverage;
    }
    return null;
  }

  /// A5-4 - the words on the TERMINAL final, or null when none arrived.
  ///
  /// Deliberately a SECOND fold rather than a field taken off `_receiptOf`'s
  /// frame: a terminal final can carry text and no receipt (an older relay), and
  /// collapsing the two would make "no receipt" also mean "no words", which is a
  /// different refusal with a different sentence.
  String? _terminalTextOf(List<SttFinal> finals) {
    for (final SttFinal f in finals.reversed) {
      if (!f.isSegment) return f.text;
    }
    return null;
  }

  /// Read the range in bounded blocks and pace the sends.
  ///
  /// 🔴 BOUNDED IN TWO DIFFERENT SENSES, AND ONLY ONE OF THEM WAS TRUE BEFORE.
  /// [kRecoveryReadBlockBytes] bounds what WE hold; it says nothing about what
  /// the socket holds after we hand it over, and `socket.io` buffers every
  /// `emit` with no way to ask whether it left. Measured on device (round-four
  /// drill, LAN, engine stalled): a 38.6 MiB recording cost PSS +45.5 MB,
  /// because the loop below read to the end of the file whatever the server was
  /// doing. [kRecoveryInFlightWindowBytes] is the second bound.
  ///
  /// ⚠️ THE OLD `upload_progress` CHECK IS GONE, AND IT WAS NEVER ALIVE. It
  /// compared `_clock()` against `clocks.lastUploadMs` two statements after
  /// `noteUpload()` set that field to now, so the gap it measured was always
  /// zero: it asked 「are WE still writing」, which we always are. The timeout
  /// keeps its name and its diag `kind` and is now measured against the only
  /// party who can prove the upload moved — the engine's inbound traffic.
  Future<int> _streamRange(
    _Candidate c,
    RecoveryIdentity identity,
    _ProgressClocks clocks,
  ) async {
    final String pcmPath = _pcmPathOf(c.scan.recordingId);
    int frames = 0;
    int off = c.range.start;
    int inFlight = 0;
    int engineSeenMs = clocks.lastEngineMs;
    while (off < c.range.end) {
      final int end = math.min(off + _readBlockBytes, c.range.end);
      final Uint8List block = await _fs.readRange(pcmPath, off, end);
      if (block.isEmpty) break; // the file is shorter than the claim; A3-8.
      final int sent = _session.feedBackfillBlock(
        block,
        seqStart: frames,
        tsMsBase: pcmBytesToMs(off - c.range.start),
      );
      frames += sent;
      if (sent == 0) break;
      clocks.noteUpload();
      off += block.length;
      inFlight += block.length;
      if (clocks.lastEngineMs != engineSeenMs) {
        engineSeenMs = clocks.lastEngineMs;
        inFlight = 0; // the server has consumed and answered; the queue drained
      }
      // A bound on burst, not a real-time cadence: P1-3 (2) explicitly refuses
      // 「drag a 30-minute recording through at 200 ms per frame」.
      if (off >= c.range.end) break;
      await _sleep(_blockCadence);
      final int? room = await _awaitWindowRoom(clocks, identity, inFlight);
      if (room == null) break;
      if (room == 0) engineSeenMs = clocks.lastEngineMs;
      inFlight = room;
    }
    return frames;
  }

  /// Hold the feed while [inFlight] bytes are out and unconfirmed.
  ///
  /// Returns the count to carry forward (0 once the engine has spoken again),
  /// or null when nothing came back inside [RecoveryTimeouts.uploadProgress]
  /// and the attempt must stop feeding.
  ///
  /// ⚠️ THE TOTAL BUDGET STAYS AUTHORITATIVE. This deadline is `uploadProgress`
  /// (30 s by default) and the budget is minutes, so waiting here can never
  /// outlive the attempt; and stopping the feed is not a settle — a partial
  /// range produces no matching coverage receipt, so the bytes stay and the job
  /// backs off, exactly as every other clock in this file does.
  Future<int?> _awaitWindowRoom(
    _ProgressClocks clocks,
    RecoveryIdentity identity,
    int inFlight,
  ) async {
    if (inFlight < kRecoveryInFlightWindowBytes) return inFlight;
    final int engineWas = clocks.lastEngineMs;
    final int startedMs = _clock();
    while (clocks.lastEngineMs == engineWas) {
      if (_clock() - startedMs >= _timeouts.uploadProgress.inMilliseconds) {
        diag('audio.recovery.timeout', <String, Object?>{
          'kind': 'upload_progress',
          'attempt_id': identity.attemptId,
          'in_flight_bytes': inFlight,
        });
        return null;
      }
      await _sleep(_blockCadence);
    }
    return 0;
  }

  String _pcmPathOf(String id) {
    final String dir = _spill.store.dirPath;
    final String sep = dir.endsWith('/') || dir.endsWith(r'\') ? '' : '/';
    return '$dir$sep$id${RetainedAudioJournal.pcmSuffix}';
  }

  /// Wait for the terminal final, under three of the four clocks (the fourth,
  /// upload progress, ran while we were sending).
  Future<_WaitOutcome> _awaitTerminal({
    required _ProgressClocks clocks,
    required Duration audio,
  }) async {
    if (_session.fsm.session == SessionState.justDone) {
      return const _WaitOutcome(reachedTerminal: true);
    }
    if (_session.fsm.session != SessionState.processing) {
      // A stall already ran to completion synchronously inside endBackfill -
      // the same shape backfill_runner.dart's `_awaitSettled` documents.
      return const _WaitOutcome(timeoutKind: 'stall');
    }
    final Duration total = _timeouts.totalBudgetFor(audio);
    final int startedMs = _clock();
    final Completer<_WaitOutcome> done = Completer<_WaitOutcome>();
    late final StreamSubscription<FlowmicStateSnapshot> stateSub;
    late final StreamSubscription<SttStall> stallSub;
    Timer? tick;
    void finish(_WaitOutcome o) {
      if (!done.isCompleted) done.complete(o);
    }

    stateSub = _session.fsm.changes.listen((FlowmicStateSnapshot s) {
      if (s.session == SessionState.justDone) {
        finish(const _WaitOutcome(reachedTerminal: true));
      }
    });
    stallSub = _session.sttStalled.listen((SttStall s) {
      // 🔴 THE CODE IS CARRIED OUT, NOT JUST THE REASON. `stall_engineError` is
      // what four unrelated refusals used to look like in the manifest, and one
      // of them - the operation binding conflict - is the server saying 「I did
      // not run this and nothing was charged」. Losing the code here is how a
      // fact the server took the trouble to name stops being available to the
      // layer that has to decide what happened (R11's shape).
      finish(_WaitOutcome(
        timeoutKind: 'stall_${s.reason.name}',
        stallCode: s.code,
      ));
    });
    // ONE poll driving FOUR independent deadlines. A timer per deadline would
    // be four things to cancel on every exit path; the poll is coarse (250 ms)
    // and every deadline here is measured in tens of seconds.
    tick = Timer.periodic(const Duration(milliseconds: 250), (_) {
      final int now = _clock();
      final int sinceEngine = now - clocks.lastEngineMs;
      final int sinceAny = now - clocks.lastAnyMs;
      String? kind;
      if (now - startedMs >= total.inMilliseconds) {
        kind = 'total_budget';
      } else if (sinceAny >= _timeouts.noProgress.inMilliseconds) {
        kind = 'no_progress';
      } else if (clocks.sawEngine &&
          sinceEngine >= _timeouts.engineProgress.inMilliseconds) {
        // 🔴 ONLY ONCE THE ENGINE HAS SPOKEN ONCE. Before that there is nothing
        // to measure a GAP against, and `no_progress` above already covers
        // 「it never said anything at all」. This is also what stops an interim
        // stream from extending forever: the total budget is a separate clock
        // and interims do not touch it.
        kind = 'engine_progress';
      }
      if (kind != null) finish(_WaitOutcome(timedOut: true, timeoutKind: kind));
    });
    try {
      final _WaitOutcome o = await done.future;
      if (o.timeoutKind != null) {
        diag('audio.recovery.timeout', <String, Object?>{'kind': o.timeoutKind});
      }
      return o;
    } finally {
      tick.cancel();
      await stateSub.cancel();
      await stallSub.cancel();
    }
  }


  Future<void> _persistState(_Candidate c, String state) async {
    if (c.status.state == state) return;
    final RetainedAudioJournal j = await _openJournal(c.scan.recordingId);
    try {
      j.setRecoveryState(state);
      await j.commit();
    } finally {
      await j.close();
    }
  }
}
