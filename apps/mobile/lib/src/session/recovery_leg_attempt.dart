part of 'recovery_journal_leg.dart';

extension _RecoveryLegAttempt on RecoveryJournalLeg {
  Future<_Candidate?> _freshCandidate(String recordingId) async {
    final candidates = await _scanCandidates(recordingId: recordingId);
    return candidates.isEmpty ? null : candidates.single;
  }

  /// One recording, one attempt. A changed recovery projection asks the
  /// caller for a bounded restart; observational scan writes do not.
  Future<_StepOutcome> _attempt(
    _Candidate c,
    RecoveryGateVerdict verdict,
    String fallbackSourceLang, {
    RecoveryAttemptKind kind = RecoveryAttemptKind.autoRetry,
  }) async {
    // Card RC5 — read before the first await; see `_runOnWire`.
    final int accountChanges = _session.articles.attempts.accountChanges;
    // NR-115 N3: onScanned durably publishes debt and must remain awaited.
    // That await (and earlier candidates) can let the live final narrow or
    // settle this recording. Re-read before the owed-tail guard and identity.
    final _Candidate? fresh = await _freshCandidate(c.scan.recordingId);
    if (fresh == null) return _StepOutcome.completed;
    // NR-137 round 3 (review B1/B2) — a re-transcription of kept words is
    // decided HERE, once, from the recording as it stands before the press,
    // and fed WHOLE: one range, one `audio:start`, one operation. Nothing
    // later in this attempt recomputes it from a state the attempt changed.
    final bool keptWords = PendingRecoveryStore.redoesKeptWords(
        manifest: fresh.manifest, kind: kind);
    _Candidate? asFed(_Candidate? x) =>
        x == null || !keptWords ? x : x.whole();
    c = asFed(fresh)!;
    if (_heldForAnotherAccount(c) ||
        (kind == RecoveryAttemptKind.autoRetry &&
            !c.status.mayAutoAttemptAt(_clock()))) {
      return _StepOutcome.completed;
    }
    final AudioJournalFormat fmt = c.manifest.format;
    final RecoverySampleRange range;
    try {
      range = RecoverySampleRange.fromBytes(c.range, fmt);
    } on ArgumentError catch (e) {
      // A3-2a: an unaligned byte offset is not a coordinate. Keep the bytes,
      // do not guess a boundary.
      diag('audio.recovery.range_unaligned', <String, Object?>{
        'recording_id': c.scan.recordingId,
        'error': '$e',
      });
      return _StepOutcome.completed;
    }
    // A6 R-5. A recording captured before the snapshot existed is LEGACY, and
    // the substitution is named in the diagnostics rather than made silently -
    // that silence is the defect R-5 exists to close.
    RecoveryResultVariant? variant = RecoveryResultVariant.fromConfigSnapshot(
      c.manifest.configSnapshot,
    );
    final bool legacyVariant = variant == null;
    variant ??= RecoveryResultVariant(
      mode: FlowMode.realtime.name,
      sourceLang: fallbackSourceLang,
      prefsDigest: digestPrefs(_phonePrefs?.call()),
    );
    final String jobId = deriveJobId(
      recordingId: c.scan.recordingId,
      range: range,
      variant: variant,
    );
    final RecoveryIdentity identity = RecoveryIdentity.forAttempt(
      recordingId: c.scan.recordingId,
      range: range,
      variant: variant,
      attemptId: 'a-${_newId()}',
      // ⚠️ 更正（RC-R，2026-09-24）：originally 「A6-1 (4): one operation per
      // attempt … every attempt mints one」 with `'o-${_newId()}'`. Card RC-R
      // (MAIN ruling 3) derives it instead, so every attempt at this job
      // carries the same operation and the relay charges the job once —
      // see [deriveOperationId] for the exact derivation and its two
      // charge-less consequences.
      // ⚠️ 更正（RC-R follow-up, MAIN 2026-09-24）：originally every kind was
      // derived. Owner ruling O-4 wins over ruling 3 for a USER press: an
      // explicit re-transcription is metered as a new attempt, so it mints a
      // fresh operation each time; only `auto_retry` attempts share one.
      operationId: kind == RecoveryAttemptKind.userRetranscribe
          ? 'o-${_newId()}'
          : deriveOperationId(
              jobId: jobId,
              attemptKind: kind,
              generation: RecoveryJournalLeg._bindingConflictsOf(
                c,
                jobId,
                kind,
              ),
            ),
      attemptKind: kind,
      audioFormatVersion: c.manifest.formatVersion,
    );
    // Card RC-P follow-up (integ merge 3, 2026-09-24) — a tail still waiting
    // for its live terminal final is refused HERE, before `addAttempt`:
    // `_runOnWire` refuses it too, but only after the attempt below has been
    // committed, which left a manifest attempt with no outcome. Same refusal,
    // same re-run (`noteHeldSweep`), no record. The cursor is closed as the
    // wire refusal's path closes it. `_runOnWire` keeps its own check for the
    // live hold and for a tail that becomes pending while this handle opens.
    if (_session.articles.owedTailPendingFor(
      RetainedAudioSpill.sessionKeyOf(c.scan.recordingId),
    )) {
      _session.articles.attempts.noteHeldSweep();
      _session.articles.endReplay();
      diag('audio.recovery.held_for_live_final', <String, Object?>{
        'recording_id': c.scan.recordingId,
        'before_attempt': true,
      });
      return _StepOutcome.refusedByGate;
    }
    diag('audio.recovery.attempt', <String, Object?>{
      'recording_id': identity.recordingId,
      'job_id': identity.jobId,
      'attempt_id': identity.attemptId,
      'range': range.toString(),
      'legacy_config_snapshot': legacyVariant,
      'source_lang': variant.sourceLang,
      'tier': verdict.tier.name,
      'attempt_kind': kind.wire,
    });
    final RetainedAudioJournal j = await _openJournal(c.scan.recordingId);
    bool abandoned = false;
    try {
      // 🔴 ASKED AGAIN, AFTER THE HANDLE IS OPEN. `_scanCandidates` ran before
      // this and the user's delete (owner ruling O-5) can land in between —
      // and from here on EVERY write through this handle would recreate the
      // manifest of audio that is gone, starting with the `commit` a few lines
      // down. On a phone the unlink succeeds while the handle stays perfectly
      // valid, so there is no error to catch; there is only the question,
      // asked of the disk.
      if (!await _fs.exists(_manifestPathOf(identity.recordingId))) {
        diag('audio.recovery.recording_gone', <String, Object?>{
          'recording_id': identity.recordingId,
          'attempt_id': identity.attemptId,
        });
        return _StepOutcome.recordingGone;
      }
      // Opening/existence checks yielded too. Never commit a stale handle
      // over a final's narrowed range, nor close it (close commits again).
      final _Candidate? opened =
          asFed(await _freshCandidate(identity.recordingId));
      if (opened == null ||
          recoveryRelevantProjection(opened.manifest, opened.range) !=
              recoveryRelevantProjection(c.manifest, c.range) ||
          recoveryRelevantProjection(opened.manifest, opened.range) !=
              recoveryRelevantProjection(j.manifest, c.range)) {
        abandoned = true;
        await j.abandon();
        return opened == null
            ? _StepOutcome.completed
            : _StepOutcome.revalidate;
      }
      // OPENED BEFORE THE WIRE IS TOUCHED: a process killed mid-attempt must
      // still leave a record that the attempt happened, or the budget resets
      // on every crash.
      j.addAttempt(
        JournalAttempt(
          attemptId: identity.attemptId,
          startedAtMs: _clock(),
          jobId: identity.jobId,
          operationId: identity.operationId,
          kind: identity.attemptKind.wire,
        ),
      );
      await j.commit();
      // The durable attempt write is another yield. Revalidate its range and
      // debt before opening a cursor or sending audio. A changed snapshot is
      // retried from disk, with a new identity; no old-range bytes are sent.
      final _Candidate? committed =
          asFed(await _freshCandidate(identity.recordingId));
      if (committed == null ||
          recoveryRelevantProjection(committed.manifest, committed.range) !=
              recoveryRelevantProjection(j.manifest, c.range)) {
        abandoned = true;
        await j.abandon();
        return committed == null
            ? _StepOutcome.completed
            : _StepOutcome.revalidate;
      }
      c = committed;
      // P1-2: tell the reconnect ring replay that these bytes have a sender.
      // A CLAIM IS NOT DELIVERY - see audio/replay_ownership.dart.
      _spill.replayOwnership.claim(identity.recordingId);
      // 🔴 CARD RC-3 — OPEN THE REPLAY CURSOR, OR THE ROWS GO ON THE LIVE CLOCK.
      // This leg never did: `ArticleScribe.claim` found no cursor, fell through
      // to the live clock (still open after a long recording — only the next
      // press or recording closes it), and filed the recovered row AFTER the
      // recording's end with the whole range's length (root-cause §1.7: a
      // 6:38 recording read 8:36). Same derivation the legacy leg uses, from
      // one function (session/article_replay_target.dart).
      //
      // ⚠️ A candidate that is NOT an article closes any cursor a previous
      // candidate in this sweep left open: its rows are ordinary rows, and a
      // stale cursor would file them inside somebody else's recording.
      // NR-137 round 2 — a re-transcription of kept words that does NOT
      // replace in place makes a new note: no cursor, ordinary rows, which
      // `_finishKeptWords` folds into that one note (recovery_leg_kept_words).
      final bool asNote = keptWords &&
          !await _keptWordsPathFor(c, identity.attemptId);
      final ArticleReplayTarget? target = asNote ? null : articleReplayTargetFor(
        articles: _session.articles,
        timeline: _timeline,
        sessionKey: RetainedAudioSpill.sessionKeyOf(identity.recordingId),
        // The recorded answer, as persisted: the prefix was written from the
        // same clock value the stretch start was (ptt_capture_pump.dart
        // `_accountOwedTail`), and unlike the in-memory stretch start it
        // survives a relaunch — the row derivation would otherwise land a
        // retry of a shortfall AFTER its own partial rows.
        //
        // NR-137 — and for a re-transcription of kept words: their rows ARE
        // at the range start, and without this the derivation below puts the
        // new rows after the END of the existing ones
        // (article_replay_target.dart), where the replacement in `_finish`
        // finds nothing to replace and the page carries both copies.
        persistedStartMs: c.manifest.transcribedPrefixBytes == null &&
                !keptWords
            ? null
            : pcmBytesToMs(c.range.start),
        // RC-K — this stretch's own placement, when it was recorded with one.
        // NR-137 round 3 — not for a whole-recording kept-words feed: it
        // starts at the recording's start, not at a stretch.
        pinnedStartMs: keptWords ? null : c.scan.owedRange?.atMs,
      );
      if (target != null) {
        _session.articles.beginReplay(target);
      } else {
        _session.articles.endReplay();
      }
      final _AttemptResult r = await _runOnWire(
        c,
        identity,
        variant.sourceLang,
        accountChanges,
      );
      // Closed ONLY when no session carried words: see
      // `ArticleScribe.endReplay` for why a cursor closed after a live session
      // files the rows it was opened for on the wrong clock.
      if (r.refusedByGate || r.framesEmitted == 0) {
        _session.articles.endReplay();
      }
      if (r.refusedByGate) {
        return r.refusedNoLink
            ? _StepOutcome.refusedNoLink
            : _StepOutcome.refusedByGate;
      }
      await _finish(c, j, identity, r, verdict);
      return r.linkLost ? _StepOutcome.linkLost : _StepOutcome.completed;
    } finally {
      _spill.replayOwnership.release(identity.recordingId);
      // 🔴 CLOSE COMMITS, SO IT IS ASKED FIRST WHETHER THERE IS ANYTHING LEFT
      // TO COMMIT TO. The user can delete this recording at any point while
      // the attempt runs (owner ruling O-5, card RC-1b's screen), through a
      // different object and a different handle — this one stays perfectly
      // valid, and its closing commit would write the manifest back for audio
      // that is gone. The scan would then list the recording again with its
      // claim ahead of an absent file, and the delete would look as though it
      // had silently failed. `_finish` makes the same check before ITS writes;
      // this one covers the commit `close` performs on its own.
      if (abandoned) {
        // Already closed without publishing its obsolete manifest.
      } else if (await _fs.exists(_manifestPathOf(identity.recordingId))) {
        await j.close();
        // Card FX-4 — the handle is gone, so the bytes can go. Only ever set
        // by the settled branch of `_finish`; the abandon branch below drops
        // it unused, because a recording the user deleted has no bytes left to
        // release and no manifest that would license one.
        final String? release = _releaseAfterClose;
        if (release != null) await _releaseBytes(release);
      } else {
        await j.abandon();
      }
      _releaseAfterClose = null;
    }
  }
}
