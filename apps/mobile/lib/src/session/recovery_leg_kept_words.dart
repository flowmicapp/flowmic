// NR-137 — THE JOURNAL LEG'S RULES FOR RE-TRANSCRIBING WORDS THE USER HAS.
//
// A `part` of recovery_journal_leg.dart, beside recovery_leg_settle.dart
// (which sat at 789 of its 800 lines). What qualifies a recording is
// kept_words_retranscribe.dart + `PendingRecoveryStore.redoesKeptWords`; the
// three rules such an attempt follows are:
//   ① the replay cursor is pinned at the range start (`_attempt`,
//     recovery_leg_attempt.dart), where the earlier rows are;
//   ② rows that all read back REPLACE the earlier unedited rows of the range
//     (`_finishVerdict` widens the RC-3 shortfall replacement);
//   ③ no words back leaves everything standing — [_keptWordsNoWordsBack].
// Design: _dispatch/2026-10-02-nr137-design.md §2 / §4.
//
// ⚠️ 更正（NR-137 round 2, MAIN 2026-10-02）: ① and ② are now ONE of two
// paths, chosen once per attempt in `_attempt` ([_keptWordsPathFor]):
//   · IN PLACE — an article (round 3: rows read from storage, loaded or
//     not): ① + ② as above;
//   · NEW NOTE — everything else (an ordinary press, whose rows are delivered
//     history and stay exactly as they are; a piece not loaded): no replay
//     cursor, and the attempt's rows become ONE record-only note marked as a
//     re-transcription of this recording ([_keptWordsResult],
//     `consolidateIntoRetranscribedNote`). Nothing earlier is touched.
//
// ⚠️ 更正（NR-137 round 3, independent review B1/B2/B4/B5）:
//   · ONE press = ONE attempt over the WHOLE verified recording
//     (`_Candidate.whole`, `_attempt`): one range, one `audio:start`, one
//     operation. Round 2 reopened unproven stretches and fed them one by one —
//     a new operation per stretch, and every stretch after the first lost
//     these rules (it recomputed them from the `pending` the first one wrote).
//   · the press settles by [_finishKeptWords] alone: no stretch bookkeeping, no
//     `pending`, no `shortfall` — a kept recording stays manual-only whatever
//     the press comes to;
//   · the in-place replacement reads the earlier rows from STORAGE and
//     removes them durably before anything settles; the note fold awaits and
//     reads back its removals; either one failing ⇒ the press is `failed`,
//     the audio stays, nothing is released.

part of 'recovery_journal_leg.dart';

/// NR-137 round 2 — attempt id → whether that kept-words attempt replaces in
/// place (true) or makes a new note (false). Written once in `_attempt`, read
/// by `_finishVerdict`, including a late settle's (RC-N), so the placement the
/// rows were given and the rule applied to them cannot disagree. Its PRESENCE
/// is what marks an attempt as a kept-words press (round 3).
final Expando<Map<String, bool>> _keptWordsPaths = Expando<Map<String, bool>>();

/// What `_keptWordsRows` came to.
class _KeptRows {
  const _KeptRows({
    required this.result,
    required this.storageFailed,
    required this.inputs,
    this.claim,
  });
  final String? result;
  final bool storageFailed;
  final RecoverySettleInputs inputs;

  /// Round 10 (review r9 B1) — what releasing the audio would stand on;
  /// authorized by one fresh proof in [RecoveryJournalLegKeptWords
  /// ._finishKeptWords], immediately before the commit.
  final TimelineReleaseClaim? claim;
}

/// Round 10 — the attempt's failure code when its words stand but the
/// release of its audio could not be proven at the moment it was asked.
const String kKeptWordsReleaseNotProven = 'keptWordsReleaseNotProven';

extension RecoveryJournalLegKeptWords on RecoveryJournalLeg {
  Map<String, bool> get _paths => _keptWordsPaths[this] ??= <String, bool>{};

  /// Decide (once) and remember the path for [attemptId].
  Future<bool> _keptWordsPathFor(_Candidate c, String attemptId) async =>
      _paths[attemptId] = await _keptWordsReplaceable(c);

  /// Whether [attemptId]'s kept-words attempt replaces in place.
  bool _keptWordsInPlace(String attemptId) => _paths[attemptId] ?? false;

  /// Whether [attemptId] is a kept-words press (decided at `_attempt`).
  bool _isKeptWordsAttempt(String attemptId) => _paths.containsKey(attemptId);

  /// NR-137 round 3 — the rows that stand for a kept-words press: the
  /// earlier rows replaced in place (from storage), or the answer folded into
  /// one note. Returns that row, or null; `storageFailed` when a write or a
  /// removal did not complete. `_finishVerdict` then asks the ONE settle
  /// predicate (live_settle_has_call_site_test.dart) and calls
  /// [_finishKeptWords] with its answer.
  ///
  /// [rowId] is non-null only when every row this attempt settled was read
  /// back (`_finishVerdict` checked that before calling here).
  Future<_KeptRows> _keptWordsRows(
    RetainedAudioJournal j,
    _Candidate c,
    RecoveryIdentity identity,
    _AttemptResult r,
    RecoveryGateVerdict verdict, {
    required String? rowId,
    required bool allRead,
  }) async {
    String? result;
    bool storageFailed = false;
    TimelineReleaseClaim? claim;
    final String id = identity.recordingId;
    // Round 4 (review D1) — an in-place answer is fitted and placed on the
    // LOADED rows (`_fitRowsToFedAudio`, `applyArticleSpan`); one a reload
    // paged out cannot be. Rather than settle a mis-placed answer, the press
    // fails closed: its rows go (proven), the earlier rows and audio stay.
    final bool pagedOut = rowId != null &&
        _keptWordsInPlace(identity.attemptId) &&
        r.newRowIds.any((String x) => _timeline.findById(x) == null);
    if (!allRead || pagedOut) {
      // Round 4 (review D2) — the rows of a press that did not land are
      // withdrawn from STORAGE and the withdrawal is proven; an unproven one
      // is a storage failure, said as such. Round 10b: recorded first.
      await _recordWithdrawalFirst(j, identity.attemptId, r.newRowIds);
      final List<TimelineEntry>? owned =
          await withdrawalRows(_timeline, r.newRowIds);
      // The removal runs FIRST (not inside an `||` that `pagedOut` would
      // short-circuit), and its proof is what decides the failure's kind.
      final bool withdrawn =
          owned != null && await removeRowsDurably(_timeline, owned);
      storageFailed = pagedOut || !withdrawn;
      diag('audio.recovery.kept_words_withdrawn', <String, Object?>{
        'attempt_id': identity.attemptId,
        'paged_out': pagedOut,
        'rows': r.newRowIds.length,
      });
    } else if (rowId != null && _keptWordsInPlace(identity.attemptId)) {
      // B5 — earlier rows read from storage, removed durably, before any
      // verdict about the bytes is written.
      claim = await replaceKeptRowsInPlaceForRelease(
        timeline: _timeline,
        articleId: RetainedAudioSpill.sessionKeyOf(id),
        ownedRowIds: r.newRowIds,
        rangeEndMs: pcmBytesToMs(c.range.end),
      );
      if (claim != null) {
        result = rowId;
      } else {
        await _recordWithdrawalFirst(j, identity.attemptId, r.newRowIds);
        final List<TimelineEntry>? owned =
            await withdrawalRows(_timeline, r.newRowIds);
        if (owned != null) await removeRowsDurably(_timeline, owned);
        storageFailed = true;
      }
    } else if (rowId != null) {
      final KeptWordsFold fold = await consolidateIntoRetranscribedNote(
        timeline: _timeline,
        ownedRowIds: r.newRowIds,
        sourceRecordingId: id,
        clientId: 'rt-${identity.attemptId}',
      );
      result = fold.noteId;
      storageFailed = fold.storageFailed;
      claim = fold.claim;
    }
    return _KeptRows(
      result: result,
      storageFailed: storageFailed,
      claim: claim,
      // The inputs the ONE predicate is asked with, in `_finishVerdict`.
      inputs: RecoverySettleInputs(
        sent: identity.startEcho,
        framesEmitted: r.framesEmitted,
        receipt: r.receipt,
        resultText: r.resultText,
        endedOnTerminalFinal: r.endedOnTerminalFinal,
        rowPersistedAndReadBack: result != null,
        serverMayDelete: verdict.tier.mayDeleteBytes,
        fedWholeRange: r.fedWholeRange,
        resultIsSilence: r.resultEmptyReason == kEmptyReasonNoVoice,
      ),
    );
  }

  /// NR-137 round 3 — the whole of a kept-words press's settle, given the
  /// settle predicate's [decision] about [result].
  Future<void> _finishKeptWords(
    RetainedAudioJournal j,
    RecoveryIdentity identity,
    _AttemptResult r,
    RecoverySettleDecision decision, {
    required String? rowId,
    required String? result,
    required bool storageFailed,
    required TimelineReleaseClaim? claim,
  }) async {
    final String id = identity.recordingId;
    diag('audio.recovery.kept_words_settle', <String, Object?>{
      'recording_id': id,
      'attempt_id': identity.attemptId,
      'in_place': _keptWordsInPlace(identity.attemptId),
      'decision': decision.reasonCode,
      'storage_failed': storageFailed,
      'row': result,
    });
    final String key = RetainedAudioSpill.sessionKeyOf(id);
    // NR-137 round 5 — and no earlier attempt's unproven withdrawal holds the
    // bytes (`_earlierWithdrawalsGone`, recovery_leg_rows.dart).
    // 🔴 NR-137 round 10 (review r9 B1) — and, LAST, one fresh proof of what
    // the release stands on: the answer present, the replaced or folded rows
    // gone, the article resolved. Was the answer's presence alone, so a cloud
    // retry landing between the removal proof and that read was seen by the
    // census and ignored (measured: press `done`, PCM gone, retry kept).
    final bool earlierGone = result != null &&
        decision.mayDeleteBytes &&
        await _earlierWithdrawalsGone(j.manifest);
    // Round 10b: plus every row any earlier attempt withdrew. Round 10c: proven
    // with writers running and sealed inside the gate's bounded hold
    // (`_sealRelease`); not sealed ⇒ already put back and committed there.
    final bool authorized = earlierGone &&
        claim != null &&
        await _sealRelease(j, identity.attemptId,
            resultRef: result,
            claim: claim.and(
                TimelineReleaseClaim(gone: _withdrawnEarlier(j.manifest))),
            keepCode: kKeptWordsReleaseNotProven);
    if (result != null && decision.mayDeleteBytes && earlierGone && !authorized) {
      // The words stand (the earlier rows were proven gone when they were
      // removed); what changed since cannot be ruled out. Kept, and the press
      // says it failed: the audio is the only way to settle it.
      _keptWordsPressFailed = true;
      diag('audio.recovery.kept_words_release_unproven', <String, Object?>{
        'recording_id': id,
        'attempt_id': identity.attemptId,
      });
    }
    if (authorized) {
      // Proven and sealed: the whole recording settled, its bytes go once the
      // journal is closed (A6-3 order).
      _releaseAfterClose = id;
      _session.articles.dropStretchStart(key);
      return;
    }
    if (result != null) {
      // Words back, one set of them on the page, proof missing or short:
      // still kept, still MANUAL-ONLY (never `pending`, never `shortfall`).
      j.setResultRef(result);
      j.closeAttempt(identity.attemptId,
          outcome: JournalAttempt.outcomeSettledUnverified,
          failureCode: _keptWordsPressFailed
              ? kKeptWordsReleaseNotProven
              : decision.reasonCode);
      j.setRecoveryState(RecoveryQueueState.settledUnverified,
          clearNextEligibleAt: true);
      await j.commit();
      _session.articles.dropStretchStart(key);
      return;
    }
    // 🔴 No row stands for this press. Either the engine answered with
    // nothing (empty, or silence) — NOT 「the recording has no words」: the
    // earlier words are on the page, so the card must not turn into
    // `emptyResult` / `emptyConfirmed`, and a silence verdict must not
    // release audio under words nothing confirmed — or the press failed.
    // Either way nothing is replaced, the audio stays, and 🔴 THE QUEUE STATE
    // IS NOT WRITTEN: a manual press never puts a kept recording back on the
    // automatic route (review B2). The `keptWordsNoWords:` prefix keeps the
    // attempt out of the readers that match `emptyResult` exactly.
    final bool noWords = !storageFailed &&
        rowId == null &&
        (decision.mayDeleteBytes ||
            decision.reasonCode == RecoverySettleRefusal.emptyResult.name);
    j.closeAttempt(identity.attemptId,
        outcome: JournalAttempt.outcomeFailed,
        failureCode: noWords
            ? 'keptWordsNoWords:${decision.reasonCode}'
            : storageFailed
                ? 'keptWordsStorageFailed'
                : (r.refusalCode ?? r.timeoutKind ?? decision.reasonCode));
    await j.commit();
    if (noWords) return;
    _keptWordsPressFailed = true;
    // A result that arrives after this failure is not this press's answer any
    // more (the person was told it failed): its rows are withdrawn, never
    // left as an unmarked second copy of the words.
    _session.articles.attempts.failed(identity.attemptId,
        onLate: (List<String> rowIds, Object frame) {
      unawaited(_session.articles.attempts.serialize(() async {
        // Round 10b — recorded on the failed attempt FIRST (its journal is
        // reopened: no newer attempt covers this range, or this would not be
        // called), so a later release re-proves these rows too.
        if (await _fs.exists(_manifestPathOf(id))) {
          final RetainedAudioJournal lj = await _openJournal(id);
          try {
            lj.recordWithdrawn(identity.attemptId, rowIds);
            await lj.commit();
          } finally {
            await lj.close();
          }
        }
        final List<TimelineEntry>? late =
            await withdrawalRows(_timeline, rowIds);
        final bool ok =
            late != null && await removeRowsDurably(_timeline, late);
        diag('audio.recovery.kept_words_late_withdrawn', <String, Object?>{
          'attempt_id': identity.attemptId,
          'rows': rowIds.length,
          'durable': ok,
        });
      }));
    });
  }

}
