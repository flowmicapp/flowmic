// Card RC-1b - THE PRODUCTION SOURCE BEHIND THE PENDING-RECOVERY SCREEN.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-3, O-5, O-8, O-9)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A5-3, A6 R-2, A7-3, A3-8
//   apps/mobile/lib/src/session/pending_recovery.dart (the value layer)
//
// WHAT IT READS, AND WHY IT IS TWO SOURCES
//
// There are two storage faces on this phone and the recovery queue already
// knows both: the per-recording JOURNAL (manifest + pcm, card LS-1) and the
// LEGACY segment store that predates it. A screen that read only one of them
// would be honest about half a directory - and today, with
// `retainFromFirstFrame` still false in `retained_audio_boot.dart`, the legacy
// face is the ONLY one with anything in it. Reading only the journal would
// have shipped an always-empty screen that looked correct.
//
// THIS FILE HOLDS THE ONLY DELETE OF CAPTURED AUDIO A USER CAN REACH.
// `retained_audio_journal.dart` states, in its own words, that "nothing in the
// journal deletes PCM"; that rule is about the journal deleting its own bytes
// behind the user's back. Owner ruling O-5 requires the opposite thing to
// exist somewhere - cancelled audio is kept and "可由用户在待恢复清单逐条删除"
// (the user may delete it one at a time from the pending list) - and this is
// that somewhere. It is reached only from a confirm sheet.

import 'dart:async';

import '../audio/retained_audio_journal.dart';
import '../audio/retained_audio_spill.dart';
import '../audio/retained_audio_store.dart';
import '../diag/diag_log.dart';
import 'backfill_runner.dart';
import 'pending_recovery.dart';
import 'recovery_backoff.dart';
import 'recovery_gate.dart';
import 'recovery_settle.dart';

/// Reads both storage faces and drives the two sanctioned actions.
class PendingRecoveryStore implements PendingRecoverySource {
  PendingRecoveryStore({
    required BackfillRunner runner,
    required String Function() sourceLang,
  })  : _runner = runner,
        _sourceLang = sourceLang;

  final BackfillRunner _runner;
  final String Function() _sourceLang;

  @override
  bool get recordingNow => _runner.recordingNow;

  @override
  Future<List<PendingRecoveryItem>> list() async {
    final List<PendingRecoveryItem> out = <PendingRecoveryItem>[];
    await _addJournal(out);
    await _addLegacy(out);
    // Newest first. A recording whose id this build cannot read a clock out of
    // sorts last rather than to the epoch - see [recordedAtMsFromId]: it is
    // absence, and absence must not masquerade as 1970.
    out.sort((PendingRecoveryItem a, PendingRecoveryItem b) {
      final int? x = a.recordedAtMs;
      final int? y = b.recordedAtMs;
      if (x == null && y == null) return a.id.compareTo(b.id);
      if (x == null) return 1;
      if (y == null) return -1;
      return y.compareTo(x);
    });
    return out;
  }

  Future<void> _addJournal(List<PendingRecoveryItem> out) async {
    final RetainedAudioSpill? spill = _runner.retainedSpill;
    if (spill == null) return;
    final RecoveryTier? tier = _runner.lastServerTier;
    final String? live = spill.currentRecordingId;
    final List<RecordingScan> scans = await RetainedAudioJournalScan.scan(
      dirPath: spill.store.dirPath,
      fs: spill.journalFs,
    );
    for (final RecordingScan s in scans) {
      final RecordingManifest? m = s.manifest;
      // THE EXCLUSIONS MIRROR `RecoveryJournalLeg._scanCandidates`, WITH ONE
      // DELIBERATE ADDITION AND ONE DELIBERATE DIFFERENCE:
      //   - addition: a `cancelled` recording IS listed here, because owner
      //     ruling O-5 keeps its bytes and names this list as the only place
      //     the user can remove them. The leg excludes it from FEEDING; this
      //     screen must not exclude it from EXISTING, or the ruling has no
      //     entry point;
      //   - difference: quarantined / missing-manifest / format-mismatch
      //     recordings ARE listed, under `PendingRecoveryState.unreadable`.
      //     The leg still excludes them from FEEDING (nothing here can be
      //     transcribed), but owner ruling O-2 says unrecovered audio counts
      //     against the cap - so a recording nothing lists and nobody can
      //     remove is an invisible, undeletable orphan, which that ruling
      //     names as a defect. Listing them costs one honest sentence and
      //     buys the only delete they will ever have.

      // The recording being written right now is live audio, not a debt. Asked
      // FIRST, before any unreadable branch: a journal that has not committed
      // its first manifest yet looks exactly like an orphan PCM, and offering
      // to delete the audio somebody is speaking into is worse than any orphan.
      if (s.recordingId == live) continue;
      if (m == null || s.quarantined || s.manifestMissing || s.formatMismatch) {
        if (s.observedLength <= 0) continue;
        // 🔴 A LEGACY SEGMENT IS NOT AN ORPHAN, IT IS THE OTHER FACE. Both
        // faces live in ONE directory, and the legacy one writes
        // `<session>__seg-N.pcm` — no manifest, ever, by design. The journal
        // scan cannot tell that from a crashed journal recording, so without
        // this line every legacy session would be listed twice: once here as
        // 「cannot be read」 and once by `_addLegacy` as itself. Pinned by the
        // two legacy cases in `pending_recovery_actions_test.dart`, which
        // assert the list has exactly one row.
        if (_looksLegacySegment(s.recordingId)) continue;
        out.add(PendingRecoveryItem(
          id: s.recordingId,
          legacy: false,
          state: PendingRecoveryState.unreadable,
          durationMs: _unreadableMs(s, m),
          recordedAtMs: recordedAtMsFromId(s.recordingId),
        ));
        continue;
      }
      if (m.settled) continue;
      // 🔴 CARD LK-1 — NOT A DEBT, SO NOT A ROW, SO NOT AN ENTRY POINT EITHER.
      // A recording marked `transcribed_unverified` produced its words, they
      // were read back out of storage, and the only missing piece is a receipt
      // this server cannot issue. Nothing is waiting for it and nothing can be
      // done about it, so listing it would put a card — and, through
      // `PendingRecoveryEntry`, a permanent row on the light-record screen —
      // in front of the user after EVERY successful press (observed
      // 2026-09-07 on 0.3.74 against relay 0.3.71: four ordinary presses, four
      // cards). Its bytes leave on the TTL sweep instead
      // (retained_audio_policy.dart), which is the difference between this
      // state and `settled_unverified`.
      if (RecoveryQueueState.normalise(m.recoveryState) ==
          RecoveryQueueState.transcribedUnverified) {
        continue;
      }
      // 🔴 CARD UX2-1 — SD-2, AND THIS SCREEN HAD BEEN LEFT OUT OF IT. The
      // press ended normally, the journal closed and stamped 「a settle is
      // coming」, and the terminal final that writes the verdict has not landed
      // yet. `RecoveryJournalLeg._scanCandidates` skips exactly this
      // (`RecordingScan.liveSettlePending`, and its comment says why); this
      // list did not — so between release and settle every ordinary press was
      // a row here, which is a DEBT claimed about a recording that is being
      // settled as we read it. Through `PendingRecoveryEntry` that put 「录音等待
      // 转写」 on the light-record screen after EVERY release, and by the time
      // the user tapped it the settle had landed and the page was honestly
      // empty (observed 2026-09-07 on 0.3.75, cloud relay).
      //
      // ⚠️ A HOLD, NOT AN EXCLUSION, and the bound is the one the leg already
      // trusts: the stamp expires after `kLiveSettlePendingGraceMs`, so a
      // process killed between the stamp and the settle costs a bounded delay
      // and then appears here as the debt it has become. The settle CLEARS the
      // stamp on either outcome (`retained_audio_live_settle.dart`), so a
      // `settled_unverified` recording — one this screen must show — is hidden
      // for no longer than the settle itself took.
      //
      // ⚠️ ONE INTERLEAVING IS NOT COVERED AND IS NOT PRETENDED TO BE: when the
      // terminal final lands INSIDE `AudioCapture.stop()` (a fast local
      // engine), the settle path closes the journal itself and no stamp is ever
      // written, leaving the same narrow window. Measured while writing
      // `live_settle_test.dart`'s UX2-1 case, which models the cloud-relay
      // ordering owner reported and says so at `_EchoTransport.finalDelay`.
      if (s.liveSettlePending) continue;
      if (s.verifiedRecoverableRange.isEmpty) {
        // 🔴 O-2 - A CLAIM WITH NO BYTES BEHIND IT IS STILL A ROW ON THIS
        // SCREEN. A manifest that says it committed audio and has no readable
        // range left (the file is gone or truncated, so the scan marks
        // `claimAheadOfObserved` and reports an empty range) used to be skipped
        // here AND by `RecoveryJournalLeg._scanCandidates` - invisible,
        // undeletable, and still holding whatever it holds. MEASURED 2026-09-06
        // (drill B-1, second-run.manifest.json: `committedClaimBytes` 1,318,400,
        // `recoveryState` pending, no PCM file).
        //
        // It is [PendingRecoveryState.unreadable] rather than a new state
        // because the two sentences would be identical from where the user
        // stands - it cannot become words, and delete is the only offer - and
        // A5-4's ban on inventing states applies to screens too.
        //
        // ⚠️ `committedClaim > 0` IS THE CONDITION. A manifest that never
        // claimed a byte (a press that produced nothing) has nothing to show
        // and nothing to delete; listing it would put a card on screen for a
        // recording that costs the user nothing.
        if (s.committedClaim > 0) {
          out.add(PendingRecoveryItem(
            id: s.recordingId,
            legacy: false,
            state: PendingRecoveryState.unreadable,
            durationMs: _unreadableMs(s, m),
            recordedAtMs: recordedAtMsFromId(s.recordingId),
          ));
        }
        continue;
      }
      out.add(PendingRecoveryItem(
        id: s.recordingId,
        legacy: false,
        state: _stateOf(scan: s, manifest: m, tier: tier),
        durationMs: _journalMs(s, m),
        recordedAtMs: recordedAtMsFromId(s.recordingId),
        partlySaved: _partlySaved(m),
      ));
    }
  }

  /// A5-3 / A7-3 / O-5, in precedence order. See [PendingRecoveryState] for
  /// why the order is what it is.
  PendingRecoveryState _stateOf({
    required RecordingScan scan,
    required RecordingManifest manifest,
    required RecoveryTier? tier,
  }) {
    if (scan.cancelled) return PendingRecoveryState.cancelled;
    final RecoveryJobStatus status = RecoveryJobStatus.fromManifest(manifest);
    if (status.state == RecoveryQueueState.settledUnverified) {
      // TWO SENTENCES BEHIND ONE QUEUE STATE, ROUTED ON THE REFUSAL THAT
      // PRODUCED IT. `settled_unverified` is written both when the coverage
      // receipt was missing/short/mismatched AND when everything passed and
      // only the server tier withheld the delete (A7-3 tier B). Saying
      // 「we could not confirm it was complete」 in the second case is a claim
      // about the user's words that nothing measured.
      // A5-4 - a THIRD sentence behind the same queue state, routed the same
      // way. An empty result is not "we could not confirm it was complete": it
      // is "there is nothing to confirm", and it is the only one of the three
      // that a retry can still fix.
      if (_lastRefusalIsOnly(manifest, RecoverySettleRefusal.emptyResult)) {
        return PendingRecoveryState.emptyResult;
      }
      return _onlyTierBKeptBytes(manifest)
          ? PendingRecoveryState.settledServerKeepsAudio
          : PendingRecoveryState.settledUnverified;
    }
    // TWO SOURCES FOR ONE SENTENCE, AND BOTH ARE NEEDED. The persisted state
    // is what a tier-C sweep wrote onto this recording (it outlives the
    // process, which is why the leg persists it); the live tier covers the
    // launch where no sweep has written anything yet but the server in front
    // of us still cannot be asked. Either one alone leaves a window in which
    // the screen promises an attempt that `evaluateRecoveryGate` would refuse.
    if (status.state == RecoveryQueueState.awaitingServerCapability ||
        tier == RecoveryTier.awaitingServerCapability) {
      // 🔴 CARD LK-2 — THE SENTENCE IS ABOUT RECOVERING AUDIO, SO IT MAY ONLY
      // BE SAID ABOUT AUDIO THAT NEEDS RECOVERING. Everything above this line
      // is a statement about the server, and it is true of every recording on
      // the phone; what makes it the RIGHT thing to say is that this recording
      // is owed a transcription. Told about a press that transcribed and was
      // delivered, it reads as 「something went wrong with that」 — and offers a
      // delete for the audio, which is the one action the person would not
      // have taken had they known (observed 2026-09-07).
      if (_needsRecovery(manifest)) {
        return PendingRecoveryState.serverUnsupported;
      }
      // Words exist and the server tier is the only thing keeping the bytes.
      // 🔴 REACHABLE ONLY FROM A MANIFEST AN EARLIER BUILD WROTE, and that is
      // why it is not the `transcribed_unverified` skip in `_addJournal`: a
      // 0.3.74 phone stamped `awaiting_server_capability` OVER the live
      // settle's own verdict, so what actually happened is no longer on disk.
      // 「we could not confirm it was complete」 is the honest half of that, and
      // delete is the only offer either way.
      return PendingRecoveryState.settledUnverified;
    }
    if (status.state == RecoveryQueueState.needsManual ||
        status.budgetExhausted) {
      return PendingRecoveryState.needsManual;
    }
    return PendingRecoveryState.waitingAuto;
  }

  /// Card LK-2 — is this recording actually OWED a transcription?
  ///
  /// 🔴 ONE FACT, NOT A LIST OF INTERRUPT REASONS. The ruling names four
  /// situations — a link loss, a capture fault, the continuous-recording cap
  /// reached before any final, and a crashed/orphaned journal — and every one
  /// of them is a recording that never produced a row. `resultRef` is written
  /// by the settle path (and only there) at the moment a row has been read
  /// back out of persistent storage, so its ABSENCE is exactly 「no words came
  /// of this yet」 and its presence is exactly 「they did」. A branch over the
  /// four reason strings would have to be kept in step with
  /// [JournalInterrupt]'s twelve; this cannot drift.
  ///
  /// ⚠️ IT IS NOT A JUDGEMENT ABOUT THE WORDS. A recording with a `resultRef`
  /// may still be listed — as `settled_unverified`, `settledServerKeepsAudio`
  /// or `emptyResult`, all decided above this line. What it may never be is
  /// 「waiting for a server that can recover it」.
  static bool _needsRecovery(RecordingManifest m) => m.resultRef == null;

  /// How much audio, measured from the range that actually passed its checks.
  ///
  /// COMPUTED FROM THE RECORDING'S OWN FORMAT, never from a constant: the
  /// manifest carries `sampleRate` and `bytesPerFrame` precisely so a file
  /// written by a build with a different capture format is not measured with
  /// today's numbers. (A3-2a makes the same argument about offsets.)
  /// Card FX-1 — does this manifest record a stretch that never reached disk?
  ///
  /// Two conditions, not one, because they can occur apart: a short write
  /// records a hole without changing `interruptReason`, and a capture that died
  /// on an I/O error can set the reason before any hole is filed.
  bool _partlySaved(RecordingManifest m) =>
      m.holes.isNotEmpty || m.interruptReason == JournalInterrupt.ioError;

  int _journalMs(RecordingScan s, RecordingManifest m) {
    final AudioJournalFormat f = m.format;
    if (f.bytesPerFrame <= 0 || f.sampleRate <= 0) return 0;
    final int samples = s.verifiedRecoverableRange.length ~/ f.bytesPerFrame;
    return samples * 1000 ~/ f.sampleRate;
  }

  /// Was the ONLY thing standing between this recording and a delete the
  /// server's tier (A7-3 B)?
  ///
  /// Read off the last `settled_unverified` attempt's `failureCode`, which is
  /// `RecoverySettleDecision.reasonCode` — the refusal names joined with '+',
  /// so a lone tier-B refusal is exactly one name and anything else is not.
  /// The refusal set is collected rather than short-circuited
  /// (`evaluateRecoverySettle` says why), which is what makes this readable at
  /// all: a receipt that ALSO failed leaves its own name in there.
  ///
  /// 🔴 THIS IS THE ONE BRANCH ON `failureCode`, and `JournalAttempt` says so
  /// at the field. It used to be marked diagnostic-only; a second reader would
  /// have to keep the format stable with this one.
  static bool _onlyTierBKeptBytes(RecordingManifest m) =>
      _lastRefusalIsOnly(m, RecoverySettleRefusal.serverTierKeepsBytes);

  /// Was [only] the WHOLE refusal set of the last `settled_unverified` attempt?
  ///
  /// `RecoverySettleDecision.reasonCode` joins the collected refusals with '+',
  /// so an exact string match is what "and nothing else" means here. Anything
  /// that also failed leaves its own name in there and the caller falls back to
  /// the general sentence, which is the direction that never over-claims.
  static bool _lastRefusalIsOnly(
      RecordingManifest m, RecoverySettleRefusal only) {
    for (int i = m.attempts.length - 1; i >= 0; i--) {
      final JournalAttempt a = m.attempts[i];
      if (a.outcome != JournalAttempt.outcomeSettledUnverified) continue;
      return a.failureCode == only.name;
    }
    return false;
  }

  /// Does this scan id name a file the LEGACY store owns?
  ///
  /// The shape is `<sanitised session>__seg-<n>`, minted by
  /// `RetainedAudioStore._fileFor` out of its `_sessionSep` (`__`) and
  /// `_filePrefix` (`seg-`). Both are private to that file (another lane owns
  /// it this window), so the coupling is stated here and PINNED by the two
  /// legacy cases in `pending_recovery_actions_test.dart`: they write through
  /// the real store and require the list to hold exactly one row, which is
  /// false the moment this predicate stops matching.
  static bool _looksLegacySegment(String recordingId) =>
      recordingId.contains('__seg-');

  /// How much disk an unreadable recording is holding, expressed as time.
  ///
  /// 🔴 IT IS THE BYTES ON DISK, NOT A RECOVERABLE RANGE. There is no verified
  /// range here by definition, and the question this card answers for an
  /// unreadable recording is 「how much space is this costing me」 - which is
  /// the whole reason ruling O-2 asked for it to be visible.
  ///
  /// ⚠️ THE FORMAT IS THE BEST ONE AVAILABLE AND MAY BE WRONG. A quarantined
  /// or missing manifest carries no format, so the current capture format is
  /// used; a `formatMismatch` recording carries its own, so that one is used
  /// and is exact. The card's sentence already says this recording cannot be
  /// read, so a length derived from an assumed format does not contradict it -
  /// and a `0` would, because it would read as 「empty, delete it freely」 next
  /// to a file that is holding megabytes.
  int _unreadableMs(RecordingScan s, RecordingManifest? m) {
    final AudioJournalFormat f = m?.format ?? AudioJournalFormat.current;
    if (f.bytesPerFrame <= 0 || f.sampleRate <= 0) return 0;
    return (s.observedLength ~/ f.bytesPerFrame) * 1000 ~/ f.sampleRate;
  }

  Future<void> _addLegacy(List<PendingRecoveryItem> out) async {
    final RetainedAudioStore? store = _runner.retainedStore;
    if (store == null) return;
    final Set<String> tombstoned = await store.tombstonedSessions();
    for (final String key in await store.pendingSessions()) {
      // The session being written to is live audio, the same exclusion
      // `BackfillRunner._run` makes one layer up.
      if (key == store.sessionKey) continue;
      final int bytes = await store.bytesForSession(key);
      if (bytes <= 0) continue;
      out.add(PendingRecoveryItem(
        id: key,
        legacy: true,
        // A legacy session has no manifest, so it carries no attempt history
        // and no queue state: the automatic route re-reads it on every edge
        // and spends no budget. It therefore cannot be `needsManual`, and
        // `PendingRecoveryItem.actions` withholds the retry button from it for
        // the matching reason - there is no per-recording entry point to press.
        state: tombstoned.contains(key)
            ? PendingRecoveryState.cancelled
            : PendingRecoveryState.waitingAuto,
        durationMs: _legacyMs(bytes),
        recordedAtMs: recordedAtMsFromId(key),
      ));
    }
  }

  /// 16 kHz mono PCM16 is 32 bytes per millisecond - the legacy face records no
  /// format, so this is the one place a constant is unavoidable. It is the same
  /// constant `RetainedAudioStore`'s own cap arithmetic uses, and the journal
  /// path above does NOT use it.
  int _legacyMs(int bytes) => bytes ~/ 32;

  @override
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item) {
    if (item.legacy) {
      // There is no per-recording entry into the legacy leg, and inventing one
      // that swept everything would make a button on THIS card transcribe some
      // OTHER recording. `PendingRecoveryItem.actions` already withholds the
      // button; this arm is the structural half of the same refusal.
      return Future<PendingRetryOutcome>.value(
          PendingRetryOutcome.unavailable);
    }
    return _runner.retranscribe(
      recordingId: item.id,
      sourceLang: _sourceLang(),
    );
  }

  @override
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item) async {
    diag('audio.recovery.user_delete', <String, Object?>{
      'legacy': item.legacy,
      'state': item.state.name,
      'duration_ms': item.durationMs,
    });
    if (item.legacy) {
      await _deleteLegacy(item.id);
      return PendingDeleteOutcome.done;
    }
    return _deleteJournal(item.id);
  }

  /// PCM FIRST, MANIFEST SECOND, AND THE ORDER IS THE SAFE ONE.
  ///
  /// A crash between the two is possible either way, so the question is which
  /// leftover is worse. Manifest-first leaves a PCM file with no manifest;
  /// PCM-first leaves a manifest whose claim runs ahead of an absent file: the
  /// scan marks `claimAheadOfObserved`, the recoverable range is empty, and
  /// what remains is a few hundred bytes of JSON. Both leak; only one of them
  /// leaks the audio.
  ///
  /// 🔴 A FAILED DELETE STOPS THE WHOLE THING, and that is the fix this method
  /// exists in its current shape for. It used to catch per file INSIDE the
  /// loop, so a PCM that refused to go was written to a diag line and the
  /// manifest was removed anyway. The result was an orphan that
  /// `PendingRecoveryStore.list` skipped, that `RecoveryJournalLeg
  /// ._scanCandidates` skipped, and that went on counting against the cap
  /// (owner ruling O-2) - invisible AND undeletable, from a button the user
  /// pressed to make it go away. Now: PCM first, and the manifest is only
  /// touched once the PCM is gone.
  ///
  /// ⚠️ THE QUARANTINE SIDECAR IS REMOVED TOO. A quarantined recording's
  /// manifest was RENAMED aside (`.manifest.quarantined`), so deleting only
  /// the two ordinary names would leave the file that makes the scan keep
  /// reporting the recording - the card would come back with no audio behind
  /// it. It is deleted LAST for the same reason the manifest is: it is the
  /// bookkeeping, not the bytes.
  Future<PendingDeleteOutcome> _deleteJournal(String recordingId) async {
    final RetainedAudioSpill? spill = _runner.retainedSpill;
    if (spill == null) return PendingDeleteOutcome.done;
    // 🔴 CARD RF-2 — MARKED BEFORE THE FIRST AWAIT, WHICH IS THE WHOLE
    // POINT. A recovery attempt may be running over this recording right now,
    // holding a valid journal handle. From this line on the journal's commit
    // refuses to publish, and a publish already in the air takes itself back
    // (`RetainedAudioJournal._commitLocked`). Marking after the deletes would
    // leave exactly the window the four `_fs.exists` re-checks in the leg have
    // been narrowing one measurement at a time.
    //
    // ⚠️ It is marked even if a delete below then FAILS. That is the safe
    // direction: the id is only consulted by writers deciding whether to
    // publish a manifest, and a recording the user asked to remove must not
    // gain a fresh one while we are failing to remove it. The card stays,
    // because `PendingDeleteOutcome.failed` is what the screen reads.
    spill.deletedRecordings.mark(recordingId);
    final String dir = spill.store.dirPath;
    final String sep = dir.endsWith('/') || dir.endsWith(r'\') ? '' : '/';
    final String base = '$dir$sep$recordingId';
    final JournalFileSystem fs = spill.journalFs;
    for (final String path in <String>[
      '$base${RetainedAudioJournal.pcmSuffix}',
      '$base${RetainedAudioJournal.manifestSuffix}',
      '$base${RetainedAudioJournal.quarantineSuffix}',
    ]) {
      try {
        if (await fs.exists(path)) await fs.deleteFile(path);
      } on Object catch (e) {
        diag('audio.recovery.user_delete_failed', <String, Object?>{
          'recording_id': recordingId,
          'error': '$e',
        });
        return PendingDeleteOutcome.failed;
      }
    }
    return PendingDeleteOutcome.done;
  }

  /// TOMBSTONE FIRST, BYTES SECOND - the reverse of the journal path, and for a
  /// reason the journal does not have. The legacy face has no per-session
  /// state, so the only thing that can stop the recovery queue from picking a
  /// half-deleted session back up is the marker (`retained_audio_tombstone
  /// .dart`, card LS-4). Writing it first means a crash mid-delete leaves a
  /// session that is inert rather than one that gets transcribed on the next
  /// edge.
  Future<void> _deleteLegacy(String key) async {
    final RetainedAudioStore? store = _runner.retainedStore;
    if (store == null) return;
    await store.tombstoneSession(session: key);
    for (final int idx in await store.pendingSegments(session: key)) {
      // `settle` is the store's own byte removal - the same call the recovery
      // queue makes once a stretch has become rows. Reused rather than
      // reimplemented so there is one deletion path per storage face.
      await store.settle(idx, session: key);
    }
  }
}
