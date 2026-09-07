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

  /// A6-3, in order: row read back -> settle predicate -> manifest -> delete.
  Future<void> _finish(
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
    String? rowId;
    for (final String id in r.newRowIds) {
      await _timeline.awaitPersisted(id);
      if (await _timeline.isPersisted(id)) rowId = id;
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
    if (decision.mayDeleteBytes) {
      // A6-3 (3): resultRef and the settled flag are published BEFORE the
      // bytes go. A crash between the two leaves audio that is merely
      // eligible, which is the safe direction.
      j.setResultRef(rowId!);
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
    final bool emptyOnly =
        decision.reasonCode == RecoverySettleRefusal.emptyResult.name;
    if (rowId != null || emptyOnly) {
      if (rowId != null) j.setResultRef(rowId);
      j.closeAttempt(identity.attemptId,
          outcome: JournalAttempt.outcomeSettledUnverified,
          failureCode: decision.reasonCode);
      j.setRecoveryState(RecoveryQueueState.settledUnverified,
          clearNextEligibleAt: true);
      await j.commit();
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
  }
}
