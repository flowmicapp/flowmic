// NR-137 round 5 — THE JOURNAL LEG'S ROW REMOVALS, PROVEN AGAINST STORAGE.
//
// A `part` of recovery_journal_leg.dart. `_replacePartialRows` moved here
// from recovery_leg_settle.dart (which sat at its 800-line cap); its rule
// (RC-3 / RC-3b, MAIN 2026-09-24) is unchanged, and so is its comment below.
// What changed is HOW it removes, and that is the whole card:
//
// 🔴 NO AUDIO GOES UNTIL EVERY ROW REMOVAL IT DEPENDS ON IS PROVEN BY STORAGE.
// Round 4 made the kept-words press obey that (kept_words_retranscribe.dart
// `removeRowsDurably` / `provenGone`). Two older paths of this leg did not:
//   · RC-3's shortfall retry deleted the partial rows with the fire-and-forget
//     `TimelineStore.delete` — a single-row delete that only LOGS a refused
//     reap — and went on to settle and release the audio; it also read the
//     rows to replace from the LOADED window, which a reload can page out;
//   · an attempt whose rows did not all reach storage withdrew them the same
//     unawaited way; a row that stayed behind became a second copy of the
//     words once a later attempt succeeded and released the audio.
// Now: the partial rows are read from STORAGE and removed durably before
// anything is settled (a failure keeps the audio and withdraws the new rows);
// a withdrawal is awaited and proven; and one that could NOT be proven is
// written onto the attempt (`withdrawNotProven:<ids>`), so the bytes of this
// recording are not released by any later attempt until those rows are proven
// gone ([_earlierWithdrawalsGone]).

part of 'recovery_journal_leg.dart';

/// The failure-code prefix that carries rows whose withdrawal was not proven.
const String kWithdrawNotProvenPrefix = 'withdrawNotProven:';

extension RecoveryJournalLegRows on RecoveryJournalLeg {
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
  ///
  /// ⚠️ 更正（NR-137 round 5）: 原为 `void`, reading the article from the
  /// LOADED window and removing with the unawaited single-row delete. Now the
  /// new rows and the article are read from STORAGE and the partial rows are
  /// removed durably; false ⇒ not proven, and the caller keeps the audio.
  ///
  /// ⚠️ NR-137 round 10 (review r9 B1): was `bool`. Now what a release of the
  /// audio would stand on (the new rows present, the replaced rows gone, the
  /// article resolved), or null ⇒ not proven. The release authorizes it with
  /// one fresh proof, immediately before its commit (recovery_leg_settle.dart).
  Future<TimelineReleaseClaim?> _replacePartialRows(
    RecoveryIdentity identity,
    _Candidate c,
    List<String> newRowIds,
  ) async {
    final Set<String> fresh = newRowIds.toSet();
    final List<TimelineEntry>? mine = await storedRows(_timeline, newRowIds);
    if (mine == null) return null;
    String? article;
    int? start;
    for (final TimelineEntry e in mine) {
      final int? off = e.articleOffsetMs;
      if (off == null || e.articleId == null) continue;
      article = e.articleId;
      if (start == null || off < start) start = off;
    }
    if (article == null || start == null) return const TimelineReleaseClaim();
    final int end = start + pcmBytesToMs(c.range.length);
    final List<TimelineEntry> replaced = <TimelineEntry>[];
    final List<TimelineEntry> keptEdited = <TimelineEntry>[];
    final List<TimelineEntry> members;
    try {
      // NR-137 round 6 (review D2) — null when a member may be a row storage
      // could not decode: it would survive beside the new rows.
      final List<TimelineEntry>? read =
          await articleMembersVerified(_timeline, article);
      if (read == null) return null;
      members = read;
    } on Object {
      return null;
    }
    for (final TimelineEntry m in members) {
      final int? off = m.articleOffsetMs;
      if (fresh.contains(m.id) || off == null || off < start || off >= end) {
        continue;
      }
      if (m.edited) {
        keptEdited.add(m);
        continue;
      }
      replaced.add(m);
    }
    final bool proven = await removeRowsDurably(_timeline, replaced);
    final int from = start;
    final bool editCoversRange = keptEdited.any((TimelineEntry e) =>
        (e.articleOffsetMs ?? end) <= from &&
        (e.articleOffsetMs ?? 0) + (e.durationMs ?? 0) >= end);
    diag('audio.recovery.shortfall_replaced', <String, Object?>{
      'recording_id': identity.recordingId,
      'attempt_id': identity.attemptId,
      'replaced': replaced.length,
      'proven': proven,
      'kept_edited': keptEdited.length,
      // RC-3b — which of the two edited-row outcomes this was.
      'edited_covers_range': editCoversRange,
      'edited_covers_part': keptEdited.isNotEmpty && !editCoversRange,
    });
    return proven
        ? TimelineReleaseClaim.ofRows(present: mine, gone: replaced)
            .and(TimelineReleaseClaim(articles: <String>{article}))
        : null;
  }

  /// Withdraw this attempt's own rows ([ids], its settlement ledger) from
  /// STORAGE and prove it. Returns null when proven, else the failure code
  /// that carries the rows still possibly there ([kWithdrawNotProvenPrefix]).
  ///
  /// ⚠️ NR-137 round 10b: and the ids are recorded on [attemptId] either way
  /// (`JournalAttempt.withdrawnRowIds`), so every later release of this
  /// recording re-proves them gone ([_withdrawnEarlier]) — a proven withdrawal
  /// used to leave no trace, and nothing re-proved it.
  Future<String?> _withdrawOwnRows(
      RetainedAudioJournal j, String attemptId, List<String> ids) async {
    await _recordWithdrawalFirst(j, attemptId, ids);
    final List<TimelineEntry>? rows = await withdrawalRows(_timeline, ids);
    if (rows != null && await removeRowsDurably(_timeline, rows)) return null;
    diag('audio.recovery.withdraw_not_proven', <String, Object?>{
      'rows': ids.length,
    });
    return '$kWithdrawNotProvenPrefix${ids.join(',')}';
  }

  /// NR-137 round 10b — record [ids] as withdrawn by [attemptId] and commit
  /// BEFORE the withdrawal, so a process death between the two still leaves
  /// the record on disk. A failed commit leaves it in the manifest for the
  /// next one, and no release commits without it.
  Future<void> _recordWithdrawalFirst(
      RetainedAudioJournal j, String attemptId, List<String> ids) async {
    j.recordWithdrawn(attemptId, ids);
    await j.commit();
  }

  /// NR-137 round 10b — every row any attempt of [m] withdrew, proven or not.
  /// A release of this recording's bytes re-proves all of them gone, in its
  /// final claim.
  List<String> _withdrawnEarlier(RecordingManifest m) => <String>{
        for (final JournalAttempt a in m.attempts) ...<String>[
          ...a.withdrawnRowIds,
          if (a.failureCode?.startsWith(kWithdrawNotProvenPrefix) ?? false)
            ...a.failureCode!
                .substring(kWithdrawNotProvenPrefix.length)
                .split(',')
                .where((String s) => s.isNotEmpty),
        ],
      }.toList();

  /// 🔴 NR-137 round 10c — SEAL a release: [resultRef], the attempt closed
  /// settled, the recording marked for cleanup, committed. With a [claim] (a
  /// release that stands on a removal) it goes through the timeline write
  /// gate (`TimelineWriteGate.release`): proven with writers running, then
  /// committed inside the gate's short hold, so no writer lands between the
  /// proof and the seal and none waits on a proof. Any other verdict (not
  /// proven, a budget exceeded, a throw, writers busy) puts the attempt back —
  /// settled_unverified with [keepCode], cleanup mark as it was — commits that
  /// and makes the press say it failed. True ⇒ sealed: the PCM goes once the
  /// journal is closed (`_releaseAfterClose`).
  ///
  /// THE SEAL IS THE COMMIT, NOT THE PCM DELETE. From that commit on the bytes
  /// are cleanup-eligible (A6-3: a crash after it leaves audio the sweep
  /// removes), so a writer landing after it is ordered after the release.
  ///
  /// ⚠️ A seal commit that outlives the hold budget is still in flight when
  /// the put-back starts, and a commit that lands writes its own snapshot
  /// back as the journal's state (`_commitLocked`: `_manifest = next`) — over
  /// any put-back made meanwhile (measured: state put back, cleanup mark
  /// silently restored). So the put-back waits for that commit first. The
  /// gate's hold is already over by then: only this press waits on it.
  Future<bool> _sealRelease(RetainedAudioJournal j, String attemptId,
      {required String? resultRef,
      required TimelineReleaseClaim? claim,
      required String keepCode}) async {
    final bool wasMarked = j.manifest.settled;
    Future<bool>? sealing;
    Future<bool> seal() {
      if (resultRef != null) j.setResultRef(resultRef);
      j.closeAttempt(attemptId, outcome: JournalAttempt.outcomeSettled);
      j.markSettledForCleanup();
      j.setRecoveryState(RecoveryQueueState.settled, clearNextEligibleAt: true);
      return sealing = j.commit();
    }

    if (claim == null) return seal();
    final TimelineReleaseVerdict verdict = await TimelineWriteGate.timeline
        .release(prove: () => _timeline.releaseAuthorized(claim), seal: seal);
    if (verdict == TimelineReleaseVerdict.released) return true;
    await sealing?.catchError((Object _) => false);
    if (resultRef != null) j.setResultRef(resultRef);
    j.closeAttempt(attemptId,
        outcome: JournalAttempt.outcomeSettledUnverified, failureCode: keepCode);
    if (!wasMarked) j.unmarkSettledForCleanup();
    j.setRecoveryState(RecoveryQueueState.settledUnverified,
        clearNextEligibleAt: true);
    await j.commit();
    _keptWordsPressFailed = true;
    diag('audio.recovery.release_kept', <String, Object?>{
      'verdict': verdict.name,
    });
    return false;
  }

  /// Before ANY attempt releases this recording's bytes: every row an earlier
  /// attempt could not prove withdrawn ([kWithdrawNotProvenPrefix] on its
  /// failure code) must now be proven gone — removed again if it is still
  /// there. False ⇒ the bytes stay.
  Future<bool> _earlierWithdrawalsGone(RecordingManifest m) async {
    final List<String> ids = <String>[
      for (final JournalAttempt a in m.attempts)
        if (a.failureCode?.startsWith(kWithdrawNotProvenPrefix) ?? false)
          ...a.failureCode!
              .substring(kWithdrawNotProvenPrefix.length)
              .split(',')
              .where((String s) => s.isNotEmpty),
    ];
    if (ids.isEmpty) return true;
    final List<TimelineEntry>? rows = await storedRows(_timeline, ids);
    final bool gone = rows != null && await removeRowsDurably(_timeline, rows);
    diag('audio.recovery.earlier_withdrawals', <String, Object?>{
      'rows': ids.length,
      'gone': gone,
    });
    return gone;
  }
}
