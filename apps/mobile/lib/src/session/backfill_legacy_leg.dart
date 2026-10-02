// Part of backfill_runner.dart — THE LEGACY SEGMENT LEG (NR-138).
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the 2026-09-30 legacy backfill
//     correction (durable-result barrier) and the NR-138 correction (2026-10-01)
//   apps/mobile/lib/src/session/legacy_retry_budget.dart (the budget policy)
//   the NR-138 root cause (2026-10-01, read-only) §1, §5 ①②
//
// ── WHY THIS IS A PART NOW ──────────────────────────────────────────────────
//
// `_replayOne`, `_awaitPersistedResult` and `_awaitSettled` moved here from
// backfill_runner.dart, the last two VERBATIM (comments and all), when NR-138
// gave the legacy loop a budget: the runner sat at 760 lines of an 800-line
// cap. Same library, so every private member they read is still the runner's.
//
// ── WHAT NR-138 CHANGED IN THIS LOOP ────────────────────────────────────────
//
// Measured shape (root cause §1): a stalled engine left the segment eligible,
// every sweep tried it again, the recovery's own RECORDING → PROCESSING edge
// queued the next sweep, and each attempt was billed. There was no count, no
// wait and no end. Now:
//   ① a persisted per-session budget — five automatic starts of ANY outcome
//     (round 2, review B1; round 1 counted failures only), 1/2/4/8 minutes
//     after failed ones — reserved BEFORE `audio:start`
//     (`legacy_retry_budget.dart`);
//   ② due and cap checked again immediately before each start, so a pass
//     queued earlier cannot bypass them; a session that may not start is
//     skipped and later sessions still run; a failed start ends the pass
//     (the journal leg's rule: the engine that just failed is the next
//     session's engine too, and trying it would spend that session's budget).

part of 'backfill_runner.dart';

enum _LegacyReplayOutcome {
  refusedBusy,
  refusedNoLink,
  // NR-138 round 2 (review B2) — the capability gate, asked at the send point
  // itself: the server answered and may not be sent to, or nobody answered.
  refusedServer,
  refusedNoAck,
  retry,
  unverified,
  done,
}

/// What one session's turn told the pass to do next.
enum _LegacySessionStep { next, skip, stopPass }

extension _BackfillLegacyLeg on BackfillRunner {
  /// The legacy loop of one pass. Sessions sort lexically (the store's order).
  Future<void> _runLegacy(RetainedAudioStore store, String sourceLang) async {
    final List<String> owed = <String>[
      for (final String key in await store.pendingSessions())
        // The session currently being written to is LIVE audio, not a debt: a
        // recording in progress with the link down is still filling that file.
        if (key != store.sessionKey) key,
    ];
    if (owed.isEmpty) return;
    // NR-138 ③ — 🔴 NO LEGACY START WITHOUT THE IDEMPOTENCY BIT WHERE AN
    // ACCOUNT CAN BE CHARGED, and none before any server has answered. An
    // old relay that does not register operations would bill every attempt
    // again; nothing is sent and nothing is written, the audio stays, and the
    // pending page reads the same gate (`_legacyStateIn`).
    final LegacyRecoveryGate gate = legacyGate;
    if (gate != LegacyRecoveryGate.open) {
      diag('audio.recovery.legacy_gate_closed', <String, Object?>{
        'gate': gate.name,
        'sessions': owed.length,
      });
      return;
    }
    for (final String key in owed) {
      // Refused (no link, or a press is holding the session) or a failed start
      // ⇒ stop this pass. The debt stays on disk; a session the budget holds
      // back is skipped instead (NR-138 ②).
      final _LegacySessionStep step =
          await _replaySession(store, key, sourceLang);
      if (step == _LegacySessionStep.stopPass) break;
    }
  }

  /// NR-138 ① — this session's budget as THIS runner sees it: its own
  /// reservation is in flight, anybody else's is a start whose end was lost.
  Future<LegacyRetryStatus> _legacyStatus(
          RetainedAudioStore store, String key) async =>
      _legacyUnwritable.contains(key)
          ? LegacyRetryStatus.unwritable
          : LegacyRetryStatus.of(
              await store.readLegacyRetry(key),
              ownInFlight: _legacyInFlight == key ? _legacyOwner : null,
            );

  /// NR-138 ④ — see [BackfillRunner.legacyStateOf].
  ///
  /// 🔴 PRECEDENCE CHANGED, ON PURPOSE: a session that still has untouched
  /// segments is described by THEIR state, even if another of its segments is
  /// kept unverified. Before NR-138 any unverified segment made the whole row
  /// `settledUnverified` (delete only), which would hide a stopped automatic
  /// route — and its Re-transcribe — behind a sentence about other audio.
  Future<PendingRecoveryState> _legacyStateIn(
      RetainedAudioStore store, String key) async {
    if ((await store.pendingSegments(session: key)).isEmpty) {
      // Only results kept without a complete proof are left.
      return PendingRecoveryState.settledUnverified;
    }
    // NR-138 ③ — a server that answered and cannot register operations gets
    // no legacy start at all, so 「waiting」 would promise one. Not asked of
    // `undetermined`: nobody has spoken, and that is not a verdict.
    if (legacyGate == LegacyRecoveryGate.refused) {
      return PendingRecoveryState.serverUnsupported;
    }
    final LegacyRetryStatus status = await _legacyStatus(store, key);
    if (!status.stoppedAt(_nowMs())) return PendingRecoveryState.waitingAuto;
    // Round 3 (review B4): the row is about to say 「stopped」 — write it down,
    // so no later clock value can take that back.
    await _latchStopped(store, key, status);
    return PendingRecoveryState.needsManual;
  }

  /// NR-138 round 3 (review B4, MAIN decision) — `needsManual` is PERSISTED and
  /// ONE-WAY. The first time this runner observes the automatic route stopped
  /// for [key] at the current time, it writes the stop into the session's
  /// record (`LegacyRetryStatus.stop`); from then on `stoppedAt` is true at
  /// every clock value, across restarts and reconnects. Only a person moves
  /// the recording now (Re-transcribe never reads or writes this record).
  ///
  /// Not written: while this runner's own attempt on [key] is out (the record
  /// carries its reservation), for a record that cannot be read (that is
  /// already stopped, and stays so), or when it is already written. A write
  /// that fails keeps the session stopped for this process
  /// ([_legacyUnwritable]); a restart asks the disk again — the residual is in
  /// the NR-138 audit-queue row.
  Future<void> _latchStopped(
      RetainedAudioStore store, String key, LegacyRetryStatus status) async {
    if (status.autoStopped || !status.readable || _legacyInFlight == key) {
      return;
    }
    final int now = _nowMs();
    if (!status.stoppedAt(now)) return;
    if (await store.writeLegacyRetry(key, status.stop(nowMs: now))) {
      diag('audio.recovery.legacy_stopped', <String, Object?>{
        'session': key,
        'starts': status.starts,
        'window_closes_at_ms': status.windowClosesAtMs,
      });
    } else {
      _legacyUnwritable.add(key);
    }
  }

  /// NR-138 ② — the earliest legacy due time strictly after [afterMs], for the
  /// RC-O timer. Sessions the automatic route will not try again are left out.
  Future<int?> _legacyEarliestDueMs(
      RetainedAudioStore store, int afterMs) async {
    // Nothing will be sent through a closed gate; a timer would only wake a
    // pass that refuses again.
    if (legacyGate != LegacyRecoveryGate.open) return null;
    int? due;
    for (final String key in await store.pendingSessions()) {
      if (key == store.sessionKey) continue;
      final LegacyRetryStatus s = await _legacyStatus(store, key);
      final int? at = s.nextEligibleAtMs;
      if (s.stoppedAt(afterMs) || at == null || at <= afterMs) continue;
      // Round 2 (B3) — a due time past the window's end wakes the pass at the
      // end instead, so the row says 「stopped」 then rather than 「waiting」
      // until some other edge happens to publish.
      final int? closes = s.windowClosesAtMs;
      final int wake = closes != null && closes < at ? closes : at;
      if (due == null || wake < due) due = wake;
    }
    return due;
  }

  /// Write [record] as the end of this runner's attempt on [key], whatever it
  /// says. A failed write leaves the reservation on disk, which every reader
  /// then counts as a failed start (`LegacyRetryStatus.of`).
  Future<void> _resolveLegacy(
      RetainedAudioStore store, String key, LegacyRetryRecord record) async {
    try {
      await store.writeLegacyRetry(key, record);
    } finally {
      if (_legacyInFlight == key) _legacyInFlight = null;
    }
  }

  /// Recover one session's retained stretches.
  Future<_LegacySessionStep> _replaySession(
    RetainedAudioStore store,
    String key,
    String sourceLang,
  ) async {
    try {
      for (final int idx in await store.pendingSegments(session: key)) {
        // Per SEGMENT, not per session: each retained file is one outage (the
        // server's segment index freezes for the length of a gap and advances
        // when the link returns), so each one has its own start.
        final ArticleReplayTarget? target = _targetFor(key);
        final Uint8List? pcm = await store.read(idx, session: key);
        if (pcm == null || pcm.isEmpty) {
          // Nothing to recover, and nothing to keep. An empty retained file is
          // not audio anyone said.
          await store.settle(idx, session: key);
          continue;
        }
        if (!linkConnected || !sessionAcceptsPttDown(_session.fsm.session)) {
          return _LegacySessionStep.stopPass;
        }
        // NR-138 ③ — asked again per start: a reconnect inside a long pass
        // can land on a different server.
        if (legacyGate != LegacyRecoveryGate.open) {
          return _LegacySessionStep.stopPass;
        }
        // NR-138 ② — 🔴 DUE AND CAP AT SEND TIME. A pass can be queued
        // minutes before it runs (a recording-end edge, a link edge, the RC-O
        // timer); asking here is what makes a queued pass unable to bypass
        // either.
        final LegacyRetryStatus status = await _legacyStatus(store, key);
        if (!status.mayAutoAttemptAt(_nowMs())) {
          // Round 3 (review B4): a stop observed here is written down.
          await _latchStopped(store, key, status);
          diag('audio.recovery.legacy_held', <String, Object?>{
            'session': key,
            'readable': status.readable,
            'starts': status.starts,
            'failed_starts': status.failedStarts,
            'next_eligible_at_ms': status.nextEligibleAtMs,
          });
          return _LegacySessionStep.skip;
        }
        // NR-138 ① — RESERVED BEFORE `audio:start`. A process killed with the
        // attempt out leaves this record behind, and the next reader counts
        // it; a reservation that cannot be written means no attempt at all.
        final int startedAt = _nowMs();
        _legacyInFlight = key;
        if (!await store.writeLegacyRetry(
            key, status.reserve(nowMs: startedAt, owner: _legacyOwner))) {
          _legacyInFlight = null;
          // Remembered for this process, so the list says 「stopped」 instead
          // of promising an attempt every pass refuses. A restart asks the
          // disk again and, if it still refuses, lands here again.
          _legacyUnwritable.add(key);
          return _LegacySessionStep.skip;
        }
        final _LegacyReplayOutcome outcome;
        try {
          outcome = await _replayOne(
            pcm: pcm,
            target: target,
            sourceLang: sourceLang,
            sessionKey: key,
            segmentIdx: idx,
            kind: RecoveryAttemptKind.autoRetry,
          );
        } on Object {
          // The reservation stays and counts: whatever happened, an attempt
          // may have reached the wire.
          _legacyInFlight = null;
          rethrow;
        }
        switch (outcome) {
          case _LegacyReplayOutcome.refusedBusy:
          case _LegacyReplayOutcome.refusedNoLink:
          case _LegacyReplayOutcome.refusedServer:
          case _LegacyReplayOutcome.refusedNoAck:
            // Nothing was sent: the reservation is released, no wait.
            await _resolveLegacy(store, key, status.release());
            return _LegacySessionStep.stopPass;
          case _LegacyReplayOutcome.retry:
            await _resolveLegacy(store, key,
                status.failed(nowMs: _nowMs(), startedAtMs: startedAt));
            diag('audio.recovery.legacy_failed_start', <String, Object?>{
              'session': key,
              'segment': idx,
              'failed_starts': status.failedStarts + 1,
            });
            return _LegacySessionStep.stopPass;
          case _LegacyReplayOutcome.unverified:
            // Results exist, but their writes/readback did not confirm
            // durability. The store also skips them in memory if this marker
            // cannot be saved. A conclusion: it counts as a start and sets no
            // wait — UNLESS the marker did not reach disk: then the next
            // process replays this segment, so it counts as a FAILED start.
            final bool kept = await store.markUnverified(idx, session: key);
            await _resolveLegacy(store, key,
                kept
                    ? status.concluded(startedAtMs: startedAt)
                    : status.failed(nowMs: _nowMs(), startedAtMs: startedAt));
            _session.articles.dropStretchStart(key);
            continue;
          case _LegacyReplayOutcome.done:
            // LAST: every result row passed exact durable readback, or
            // recognition returned no rows (the existing legacy empty-result
            // exception).
            await store.settle(idx, session: key);
            // ⚠️ 更正（round 2, review B1）: this released the reservation,
            // so a healthy start spent nothing and six segments made six
            // automatic starts. It counts now.
            await _resolveLegacy(
                store, key, status.concluded(startedAtMs: startedAt));
            _session.articles.dropStretchStart(key);
            await _publish(store, running: true);
        }
      }
      return _LegacySessionStep.next;
    } finally {
      // No audio left ⇒ nothing for the record to describe.
      if ((await store.pendingSegments(session: key, includeUnverified: true))
          .isEmpty) {
        await store.clearLegacyRetry(key);
      }
    }
  }

  /// NR-138 ④ — ONE legacy recording, because a person asked for it.
  ///
  /// Entered only from [BackfillRunner.retranscribe] (`legacy: true`), so it
  /// queues behind whatever pass is running: one stretch on the wire at a
  /// time, a press included.
  ///
  /// 🔴 WHAT IT DOES DIFFERENTLY FROM THE AUTOMATIC LOOP, AND NOTHING ELSE:
  ///   · it does not read or write the retry record. A press is not an
  ///     automatic attempt (owner ruling O-9's budget counts those only), so a
  ///     stopped recording stays stopped for the automatic route whatever the
  ///     press does — and a press can never reset it;
  ///   · it does not stop at a not-due or spent budget — the person whose
  ///     automatic route has stopped is who this entry point exists for.
  /// Everything else is the automatic loop's: `beginBackfill` (so `delivery:
  /// none`, the deferred-delivery red line), the same durable-result barrier
  /// before a segment is deleted, the same unverified marker.
  ///
  /// ⚠️ NR-137 HOOK: segments kept as `settled_unverified` are NOT replayed
  /// here (`pendingSegments` leaves them out). Re-transcribing audio whose
  /// rows already exist needs NR-137's design for those rows; widening this
  /// read is where it would start.
  /// ⚠️ 更正（NR-137, 2026-10-02）: NR-137 does NOT widen it. A legacy
  /// unverified segment has no manifest and its tomb records no rows or
  /// offsets (`retained_audio_unverified.dart`), so a replay could not find
  /// the earlier rows and would duplicate them; it stays delete-only. The
  /// journal face's articles got the press (`kept_words_retranscribe.dart`).
  Future<PendingRetryOutcome> _retranscribeLegacy(
      String key, String sourceLang) async {
    final RetainedAudioStore? store = _storeOf();
    if (store == null) return PendingRetryOutcome.unavailable;
    if (key == store.sessionKey) return PendingRetryOutcome.unavailable;
    // NR-138 ③ — the same gate as the automatic loop. A press is billed per
    // press (O-4), so a server that cannot register operations is not the
    // problem here — but one that has not answered, or that the gate refuses,
    // gets nothing, exactly as the journal leg's `runOne` refuses tier C.
    switch (legacyGate) {
      case LegacyRecoveryGate.undetermined:
        return PendingRetryOutcome.failed; // nobody has spoken; nothing sent
      case LegacyRecoveryGate.refused:
        return PendingRetryOutcome.refusedServer;
      case LegacyRecoveryGate.open:
        break;
    }
    final List<int> segments = await store.pendingSegments(session: key);
    // Gone, cancelled (O-5: never fed back, by anybody), or only unverified
    // audio left: nothing this press may drive.
    // ⚠️ 更正（NR-137 round 2）: only unverified audio left ⇒ the kept-words
    // press (backfill_legacy_kept.dart), which makes one new note. A
    // cancelled session has no pending segments either way (its tombstone).
    if (segments.isEmpty) {
      return (await store.unverifiedSegments(key)).isEmpty
          ? PendingRetryOutcome.unavailable
          : _retranscribeLegacyKept(store, key, sourceLang);
    }
    await _publish(store, running: true);
    try {
      for (final int idx in segments) {
        final ArticleReplayTarget? target = _targetFor(key);
        final Uint8List? pcm = await store.read(idx, session: key);
        if (pcm == null || pcm.isEmpty) {
          await store.settle(idx, session: key);
          continue;
        }
        switch (await _replayOne(
          pcm: pcm,
          target: target,
          sourceLang: sourceLang,
          sessionKey: key,
          segmentIdx: idx,
          kind: RecoveryAttemptKind.userRetranscribe,
        )) {
          case _LegacyReplayOutcome.refusedBusy:
            return PendingRetryOutcome.refusedBusy;
          case _LegacyReplayOutcome.refusedNoLink:
            return PendingRetryOutcome.refusedNoLink;
          // Round 2 (review B2) — the gate is asked again before EVERY
          // segment, not once per press: a relay that changed between two
          // segments gets no second metered start.
          case _LegacyReplayOutcome.refusedServer:
            return PendingRetryOutcome.refusedServer;
          case _LegacyReplayOutcome.refusedNoAck:
            return PendingRetryOutcome.failed; // nobody has spoken; nothing sent
          case _LegacyReplayOutcome.retry:
            return PendingRetryOutcome.failed;
          case _LegacyReplayOutcome.unverified:
            await store.markUnverified(idx, session: key);
            _session.articles.dropStretchStart(key);
          case _LegacyReplayOutcome.done:
            await store.settle(idx, session: key);
            _session.articles.dropStretchStart(key);
        }
      }
      return PendingRetryOutcome.done;
    } finally {
      if ((await store.pendingSegments(session: key, includeUnverified: true))
          .isEmpty) {
        await store.clearLegacyRetry(key);
      }
      // The screen re-reads its list after the press; the banner reads this.
      await _publish(store, running: false);
    }
  }

  /// One stretch: open, feed, close, wait for the words.
  Future<_LegacyReplayOutcome> _replayOne({
    required Uint8List pcm,
    required ArticleReplayTarget? target,
    required String sourceLang,
    required String sessionKey,
    required int segmentIdx,
    required RecoveryAttemptKind kind,
    // NR-137 round 3 — the kept-words press (backfill_legacy_kept.dart): its
    // one recording id, and where to hand back the rows THIS replay settled
    // (the segment ledger, never a timeline-wide difference — review B3).
    String? recordingIdOverride,
    List<String>? ownedRows,
  }) async {
    // NR-138 round 2 (review B2) — 🔴 THE CAPABILITY GATE, AT THE ONE SEND
    // POINT. Every metered legacy start, automatic or manual, every segment,
    // passes here immediately before `audio:start`; the earlier per-pass and
    // per-press checks only save work. Round 1 asked once per press, and the
    // reviewer's probe saw a second metered start leave after the relay's
    // acknowledgment had changed to 「no capabilities」 between two segments.
    // Asked BEFORE the replay cursor opens, so a refusal touches nothing.
    switch (legacyGate) {
      case LegacyRecoveryGate.refused:
        return _LegacyReplayOutcome.refusedServer;
      case LegacyRecoveryGate.undetermined:
        return _LegacyReplayOutcome.refusedNoAck;
      case LegacyRecoveryGate.open:
        break;
    }
    if (target != null) _session.articles.beginReplay(target);
    // NR-138 ③ — one read of the preferences: the SAME bundle goes on the
    // frame and into the job's variant, so the two cannot disagree.
    final Map<String, Object?>? prefs = _phonePrefs?.call();
    final BackfillStart start = _session.beginBackfill(
      mode: BackfillRunner.kRecoveryMode,
      sourceLang: sourceLang,
      prefs: prefs,
      // 🔴 THE BILLING HALF OF NR-138. An automatic start names the job's
      // derived operation, so the relay meters the job once however many
      // starts it takes; a press names a fresh one and is metered per press
      // (O-4). See legacy_recovery_identity.dart.
      identity: legacySegmentIdentity(
        sessionKey: sessionKey,
        segmentIdx: segmentIdx,
        pcmBytes: pcm.length,
        sourceLang: sourceLang,
        prefs: prefs,
        kind: kind,
        attemptId: 'a-${_mintId()}',
        freshOperationId: kind == RecoveryAttemptKind.userRetranscribe
            ? 'o-${_mintId()}'
            : null,
        recordingIdOverride: recordingIdOverride,
      ),
      legacySegment: true,
    );
    if (!start.ok) {
      _session.articles.endReplay();
      // NR-138 — two refusals, both before anything was sent.
      return start == BackfillStart.noLink
          ? _LegacyReplayOutcome.refusedNoLink
          : _LegacyReplayOutcome.refusedBusy;
    }
    final SegmentSettlement result = _session.segments.settlement;
    final int frames = _session.feedBackfill(pcm);
    if (frames == 0) {
      // The wire refused everything. Keep the bytes for the next sweep.
      // NR-138: `audio:start` DID leave, so this is a failed start.
      _session.abortBackfill();
      _session.articles.endReplay();
      return _LegacyReplayOutcome.retry;
    }
    _session.endBackfill();
    // 🔴 THE CURSOR IS **NOT** CLOSED HERE ON SUCCESS, and that is not an
    // omission — see ArticleScribe.endReplay for what closing it cost. The
    // rows this recovery is for settle a microtask after the FSM comes to
    // rest, so a `finally` around this closes the cursor first and the
    // recovered sentences get filed at the end of the recording. It is closed
    // by the next press or the next recording, and nothing between those two
    // points can mint a row.
    if (!await _awaitSettled()) {
      ownedRows?.addAll(result.rowIds); // whatever did land, so it can go
      return _LegacyReplayOutcome.retry;
    }
    // _settleSpan records only this buffer's rows, excluding foreign finals.
    // Awaiting justDone lets that synchronous settlement finish; its writes
    // can still be pending or failed (backfill_channel_test.dart).
    final bool durable = await _awaitPersistedResult(result).timeout(
      _settleTimeout,
      onTimeout: () => false,
    );
    ownedRows?.addAll(result.rowIds);
    return durable ? _LegacyReplayOutcome.done : _LegacyReplayOutcome.unverified;
  }

  Future<bool> _awaitPersistedResult(SegmentSettlement result) async {
    final Map<String, TimelineEntry?> rows = <String, TimelineEntry?>{
      for (final String id in result.rowIds) id: _timeline.findById(id),
    };
    // Main disposes an empty legacy result on justDone; this barrier protects
    // rows that exist, without changing the empty-recognition policy.
    if (rows.isEmpty) return true;
    for (final TimelineEntry? row in List<TimelineEntry?>.of(rows.values)) {
      if (row?.articleId case final String articleId) {
        final TimelineEntry? head = _timeline.findByClientId(articleId);
        if (head == null || !head.isArticle) return false;
        rows[head.id] = head;
      }
    }
    for (final MapEntry<String, TimelineEntry?> row in rows.entries) {
      await _timeline.awaitPersisted(row.key);
      final TimelineEntry? expected = row.value;
      if (expected == null ||
          expected.displayText.trim().isEmpty ||
          !await _timeline.isPersistedAs(row.key, (TimelineEntry stored) =>
              !stored.deleted &&
              stored.sourceText == expected.sourceText &&
              stored.outputText == expected.outputText &&
              stored.processedText == expected.processedText &&
              stored.articleId == expected.articleId &&
              stored.entryType == expected.entryType &&
              stored.durationMs == expected.durationMs &&
              stored.segmentsCount == expected.segmentsCount)) {
        return false;
      }
    }
    return true;
  }

  /// Wait for the recovery utterance to finish producing rows.
  ///
  /// ⚠️ THE TIMEOUT IS NOT A GUESS ABOUT THE ENGINE, it is a bound on how long
  /// this object holds the single-flight latch. Expiring does NOT mean the
  /// stretch failed — the finals may still be arriving and still settling — so
  /// it returns false and leaves the bytes eligible for the next sweep.
  ///
  /// 🔴 P0-1 (2026-09-02 audit) — `sessionAcceptsPttDown` WAS THE PREDICATE
  /// HERE, and it is the wrong one: it answers 「idle, or the JUST_DONE face」,
  /// which is also what `state_machine.dart`'s own 15 s processing watchdog and
  /// its terminal-`stt:error` stall (`_stallProcessing`) produce on their way
  /// BACK TO IDLE. A stall is not a completion — no terminal final arrived, no
  /// row was built — but this predicate could not tell the two apart, so an
  /// engine hiccup made this function report 「done」 and the caller deleted a
  /// stretch of audio that had never been transcribed. Only [SessionState
  /// .justDone] is reachable exclusively through [FlowmicStateMachine
  /// .onSttFinal] — a REAL terminal final — so it is the one state this
  /// function may treat as settled.
  ///
  /// ⚠️ THE SYNCHRONOUS CASE, AND WHY IT IS CHECKED BEFORE SUBSCRIBING TO
  /// ANYTHING: a terminal `stt:error` that arrived while capture was still
  /// open is LATCHED (`onSttTerminalError`, RECORDING branch) and consumed the
  /// instant `endBackfill()` — called by our caller one line above this
  /// function — calls `fsm.onPttUp()`. That stall (PROCESSING → IDLE) and its
  /// `sttStalled` event both fire synchronously, before this function has had
  /// a chance to listen for anything. A generic `SessionState.processing` check
  /// at entry, done ONCE, catches that miss: anything other than PROCESSING or
  /// JUST_DONE at this exact instant means a stall already happened and there
  /// is nothing left to wait for.
  Future<bool> _awaitSettled() async {
    final SessionState atEntry = _session.fsm.session;
    if (atEntry == SessionState.justDone) return true;
    if (atEntry != SessionState.processing) {
      // A stall already ran to completion — and its own event already fired —
      // before this function subscribed to anything. Say so and stop, rather
      // than sitting out the full [_settleTimeout] waiting for an event that
      // has already happened and gone.
      diag('audio.backfill.stall', <String, Object?>{
        'reason': 'synchronous',
        'session': atEntry.name,
      });
      return false;
    }
    final Completer<bool> done = Completer<bool>();
    late final StreamSubscription<FlowmicStateSnapshot> stateSub;
    late final StreamSubscription<SttStall> stallSub;
    final Timer timer = Timer(_settleTimeout, () {
      if (!done.isCompleted) {
        diag('audio.backfill.settle_timeout', const <String, Object?>{});
        // Card RC-M — a recovery session has no GA-03 net any more
        // (`endBackfill`), so this clock is the one that ends its wait.
        _session.abortBackfill();
        done.complete(false);
      }
    });
    stateSub = _session.fsm.changes.listen((FlowmicStateSnapshot s) {
      if (!done.isCompleted && s.session == SessionState.justDone) {
        done.complete(true);
      }
    });
    stallSub = _session.sttStalled.listen((SttStall stall) {
      if (!done.isCompleted) {
        diag('audio.backfill.stall', <String, Object?>{
          'reason': stall.reason.name,
          if (stall.code != null) 'code': stall.code,
        });
        done.complete(false);
      }
    });
    try {
      return await done.future;
    } finally {
      timer.cancel();
      await stateSub.cancel();
      await stallSub.cancel();
    }
  }
}
