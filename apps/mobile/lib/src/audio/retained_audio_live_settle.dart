// Card LS-1b — THE LIVE RECORDING'S SETTLE, on the journal face.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (§Chose 3 the threshold, §Chose 4 O-1 「success ⇒ delete」)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A5-3 (the three preconditions), §A6-3 (the ORDER), §A9 E25
//   apps/mobile/lib/src/session/recovery_settle.dart — THE predicate. This file
//     never decides anything; it writes down a decision somebody else made.
//
// A `part` of retained_audio_spill.dart, the shape retained_audio_policy.dart
// established next door: the mother class keeps one-line delegates and the
// bodies and the reasoning live here.
//
// 🔴 WHY THE LIVE PATH NEEDS A SETTLE AT ALL, WHICH IS THE WHOLE CARD. With the
// journal face on, EVERY recording writes its bytes from the first frame —
// healthy ones included. Nothing on the live path ever marked one done, so the
// only exits from that directory were the recovery queue (which skips a
// recording that produced a row) and the O-2 ceiling refusing new bytes at 512
// MiB. That is not a slow leak, it is a phone that stops keeping audio after
// about nine long recordings and never gets the space back.
//
// 🔴 AND WHY IT RELEASES THE BYTES HERE RATHER THAN LEAVING THEM TO THE TTL
// SWEEP. The sweep (retained_audio_policy.dart `_sweep`) already performs this
// delete, on a clock, for exactly the recordings this path marks. Waiting for
// it would mean a whole TTL window of healthy recordings sitting against the
// same ceiling, which is the accumulation this card exists to stop. The MANIFEST
// is still left to the sweep — it is a few hundred bytes and it is the record of
// where this recording's words went.
//
// The ORDER is what makes that safe: the settled manifest is committed FIRST, so
// a process killed between the commit and the delete leaves a recording the
// sweep is already entitled to take. The unsafe order — delete, then claim — is
// the one that cannot be recovered from.

part of 'retained_audio_spill.dart';

/// Card LS-1b — one live press's identity, from `audio:start` to the terminal
/// final that settles it.
///
/// 🔴 IT OUTLIVES THE JOURNAL ON PURPOSE. The terminal final arrives AFTER the
/// microphone stopped and after `endRecording` closed the handle, so a stamp
/// that died with the journal would leave the settle path with no recording to
/// name. [RetainedAudioSpill.beginRecording] mints the next one and drops this,
/// which is the correct lifetime: one live attempt at a time.
///
/// 🔴 MUTABLE IN EXACTLY ONE PLACE, AND THAT PLACE IS `endRecording`. The frame
/// count is not knowable when the stamp is minted and it must be knowable when
/// the receipt is compared, so it is written once, on the way out
/// ([closeWithFrames]), and read after. [closed] is what lets the settle path
/// refuse a stamp whose recording is still running — settling that would
/// compare a receipt against a count that is still moving.
class LiveAudioAttempt {
  LiveAudioAttempt({
    required this.recordingId,
    required this.attemptId,
    required this.startedAtMs,
  });

  /// The journal this press is writing. Minted by [RetainedAudioSpill
  /// .beginRecording] and put on `audio:start` in the same synchronous turn.
  final String recordingId;

  /// 04 §3.3-a ③ — one real recognition attempt. A live press has exactly one,
  /// so it is derived from the recording rather than drawn from a counter:
  /// two ids that can only ever move together are one id with a second author.
  final String attemptId;

  final int startedAtMs;

  int? _framesEmitted;

  /// Frames the capture put on the wire for this recording, or null while it is
  /// still running. 🔴 IT IS THE CAPTURE'S OWN SEQUENCE COUNT, never
  /// `bytes / 6400`: the residual partial at the end of a press is shorter than
  /// a frame, so a count derived by division is wrong for exactly the last
  /// frame of every recording (§A3-2a bans the same arithmetic for offsets).
  int? get framesEmitted => _framesEmitted;

  /// Whether the recording this stamp names has finished.
  bool get closed => _framesEmitted != null;

  /// Written once, by `endRecording`. A second call is ignored rather than
  /// overwriting: `fenceAndStop` can reach the close path twice on some exits,
  /// and the FIRST count is the one taken at the moment capture stopped.
  void closeWithFrames(int frames) => _framesEmitted ??= frames;

  @override
  String toString() =>
      'LiveAudioAttempt($recordingId/$attemptId frames=$_framesEmitted)';
}

/// Card SD-2 — the ordinary end of a recording, with the 「a settle is coming」
/// stamp written INTO the closing commit.
///
/// 🔴 WHY THE STAMP CANNOT BE WRITTEN BY THE SETTLE ITSELF. The settle runs on
/// the terminal final, which arrives AFTER `AudioCapture.stop()` closed the
/// journal; the gap between those two moments is precisely the window in which
/// `RecoveryJournalLeg._scanCandidates` sees an unsettled recording that nobody
/// owns and opens a second, billable transcription of it (a CR-5 edge-2 sweep
/// fires on exactly that transition — `chat_outbox_host.onFsmChangeRouted`,
/// 「a recording just ended」). A marker written after the gap does not cover the
/// gap. So it goes in here, on the last write before the handle goes away.
///
/// ⚠️ ORDINARY STOPS ONLY, AND THAT IS THE WHOLE CONDITION. A named interrupt
/// (link loss, capture fault, cancel, auto-stop) means no terminal final is
/// coming and no live settle will run — stamping those would delay the recovery
/// queue on exactly the recordings that need it, which is the opposite of what
/// this card is for.
/// ⚠️ AND ONLY FOR THE JOURNAL THE CURRENT LIVE ATTEMPT NAMES. `beginRecording`
/// also closes with a null reason (it closes whatever was left open before it);
/// that recording's settle is not coming either.
Future<void> _endRecordingLocked(
  RetainedAudioSpill s,
  String? interruptReason,
) async {
  final String? liveId = s._liveAttempt?.recordingId;
  final RetainedAudioJournal? j = s._journal;
  if (j != null &&
      interruptReason == null &&
      s._liveAttempt?.recordingId == s._recordingId) {
    // 🔴 NOT `s._clock()`, AND THIS IS THE SECOND TIME THIS REPO HAS PAID FOR
    // THAT ASSUMPTION (the first: the pending-recovery card that showed a date
    // ~56,000 years out). `RetainedAudioSpill._wallClock` is
    // `microsecondsSinceEpoch` — it feeds recording IDS, where only uniqueness
    // matters — while the reader of this field
    // (`RetainedAudioJournalScan._settlePending`) subtracts it from a
    // MILLISECOND clock. Stamped in microseconds the difference is about a
    // thousand times the recording's real age, every stamp reads as expired,
    // and the skip below silently never fires: the fix would be present,
    // green, and doing nothing. MEASURED here on 2026-09-06 — the test went
    // red identically with and without the guard.
    j.markLiveSettlePending(DateTime.now().millisecondsSinceEpoch);
    // 🔴 COMMITTED HERE, NOT LEFT TO THE CLOSING COMMIT, AND THAT IS THE WHOLE
    // HANDOFF. `_closeJournalLocked` nulls `_recordingId` BEFORE it awaits
    // `j.close()`, so between those two lines the recording is guarded by
    // neither fact: `currentRecordingId` no longer names it and the stamp is
    // not on disk yet. MEASURED 2026-09-06 — the sweep found it in exactly
    // that gap and opened an `auto_retry` attempt, i.e. the defect this card
    // is about, moved a few milliseconds later. Publishing the stamp while
    // the journal is still the live one makes the two guards OVERLAP, which
    // is what a handoff has to do.
    await j.commit();
  }
  await s._closeJournalLocked(interruptReason);
  // ── CARD LK-4 — A PRESS THAT SAID NOTHING LEAVES NOTHING BEHIND ─────────
  //
  // A press too short to fill one 200 ms chunk, with no residual tail, closes
  // a journal holding zero usable audio. It still left a manifest and an empty
  // PCM file on disk, and the pending-recovery screen has to be able to name
  // every file it finds — so a stray tap became a card offering to delete audio
  // that does not exist (observed 2026-09-07: 「0.6s · this recording cannot be
  // read」).
  //
  // 🔴 THE CONDITION IS 「NOTHING WAS CAPTURED」, NOT 「IT WAS SHORT」 — see
  // [_capturedNothing]. A recording that captured audio and then lost it is the
  // UNREADABLE case, which owner ruling O-2 requires to stay visible and
  // deletable; deleting on a duration threshold would take real audio away from
  // the one screen that can offer to remove it.
  //
  // 🔴 ORDINARY STOP ONLY. An interrupted close (a link loss, a capture fault,
  // a cancel) is a statement about how the recording ended and its journal is
  // evidence — even an empty one. This path is the user lifting their finger.
  //
  // 🔴 IT ASKS THE DISK, NOT THE HANDLE, AND THAT IS NOT DEFENSIVENESS. The
  // terminal `stt:final` lands inside `AudioCapture.stop()`'s
  // `retainUnsentTail()`, so the live settle regularly reaches the journal queue
  // BEFORE this close does — by which time `s._journal` is already null and a
  // manifest has been written. MEASURED 2026-09-07: the first version of this
  // branch read the handle, found none, and left the empty journal exactly
  // where it was.
  if (interruptReason != null || liveId == null) return;
  if (!await _capturedNothing(s, liveId)) return;
  s._droppedEmptyRecordingId = liveId;
  await _dropEmptyRecording(s, liveId);
}

/// Card LK-4 — did this recording capture nothing at all?
///
/// BOTH QUANTITIES, AND THE MANIFEST'S IS THE ONE THAT PROTECTS THE USER.
/// §A3-8 keeps them apart on purpose: the file says what is there NOW, the
/// manifest says what was once committed. A recording whose claim is a frame or
/// more captured audio — whatever happened to the file since — and belongs on
/// the pending screen as unreadable, not in a delete.
///
/// ⚠️ AN UNPARSABLE OR CANCELLED MANIFEST ANSWERS FALSE. Quarantining is the
/// startup scan's job and a tombstone is owner ruling O-5's; neither is a thing
/// this path may resolve by deleting.
Future<bool> _capturedNothing(RetainedAudioSpill s, String recordingId) async {
  final String base = _journalBasePath(s, recordingId);
  final String pcmPath = '$base${RetainedAudioJournal.pcmSuffix}';
  final String mPath = '$base${RetainedAudioJournal.manifestSuffix}';
  int frame = AudioJournalFormat.current.bytesPerFrame;
  try {
    if (await s._journalFs.exists(mPath)) {
      final RecordingManifest m = RecordingManifest.decode(
          String.fromCharCodes(await s._journalFs.readBytes(mPath)));
      frame = m.format.bytesPerFrame;
      if (m.cancelled) return false;
      if (m.committedClaimBytes >= frame) return false;
    }
    if (await s._journalFs.exists(pcmPath) &&
        await s._journalFs.lengthOf(pcmPath) >= frame) {
      return false;
    }
  } on Object catch (e) {
    debugPrint('[flowmic.audio] empty-recording probe failed: $e');
    return false;
  }
  return true;
}

/// Write the settle decision onto the recording's manifest, and — only when the
/// decision says so — release its bytes.
///
/// 🔴 IT TAKES A VERDICT, IT DOES NOT MAKE ONE. `mayDelete` comes from
/// `evaluateRecoverySettle` (session/recovery_settle.dart) and nothing here may
/// grow a condition of its own: a second place that decides when audio may go
/// is the filesystem-shaped version of this repo's headline defect.
///
/// §A6-3's order, and every step of it is load-bearing:
///   1. the attempt record is written and closed with its outcome, so a
///      manifest read later says WHICH of the three conditions missed;
///   2. `resultRef` names the row (present in both outcomes — a row exists
///      either way, and `settled_unverified` means 「we cannot prove it」, not
///      「there is nothing」);
///   3. the manifest is committed — the last point at which a crash is free;
///   4. the bytes go, and only then.
Future<void> _publishLiveSettle(
  RetainedAudioSpill s, {
  required LiveAudioAttempt attempt,
  required String? rowId,
  required String reasonCode,
  required bool mayDelete,
  // 🔴 THE TWO ON-DISK VOCABULARIES ARE PASSED IN, NOT SPELLED HERE.
  // `attempt_kind`'s enum (`RecoveryAttemptKind.live.wire`) and the queue's
  // state names (`RecoveryQueueState`) both live in the session layer, and the
  // audio layer does not import it. Copying two strings across the boundary
  // would put two authors on one manifest field for the sake of avoiding two
  // parameters.
  required String attemptKindWire,
  required String recoveryState,
}) async {
  // 🔴 NEVER TWO HANDLES ON ONE JOURNAL — and 「still open」 is the ORDINARY
  // case here, not the exceptional one. MEASURED 2026-09-06: the terminal
  // `stt:final` lands inside `AudioCapture.stop()`'s `await retainUnsentTail()`,
  // so the settle can reach this queue BEFORE the stop path's close does. A
  // version that refused an open journal simply never settled anything — the
  // manifest stayed `pending` and the bytes stayed with it, silently.
  //
  // So it is closed HERE, on this queue, which is the one place that cannot
  // race: every append and the tail flush are already ahead of us in the same
  // chain, and the `endRecording` that follows finds a null journal and no-ops.
  // The reason is null because a terminal final IS an ordinary stop; no
  // interrupted path produces one.
  if (s.currentRecordingId == attempt.recordingId) {
    await s._closeJournalLocked(null);
  }
  // Somebody else's recording is open: this final belongs to a recording the
  // user has already replaced, and settling it would name the wrong journal.
  if (s.currentRecordingId != null) return;
  // Card LK-4 — this recording's empty journal was removed on the stop path.
  // Opening one here to write a verdict on it would put the manifest and the
  // empty PCM straight back. There is nothing to settle: no bytes were kept,
  // so no decision about keeping them is owed.
  if (s._droppedEmptyRecordingId == attempt.recordingId) return;
  final String base = _journalBasePath(s, attempt.recordingId);
  final String pcmPath = '$base${RetainedAudioJournal.pcmSuffix}';
  final RetainedAudioJournal j = await RetainedAudioJournal.open(
    dirPath: s._journalDirPath,
    recordingId: attempt.recordingId,
    fs: s._journalFs,
    // Card RF-2 - a settle arriving after the user's delete must not put the
    // manifest back; the journal refuses the commit rather than this caller
    // growing a check of its own.
    deleted: s.deletedRecordings,
  );
  try {
    j.addAttempt(
      JournalAttempt(
        attemptId: attempt.attemptId,
        startedAtMs: attempt.startedAtMs,
        kind: attemptKindWire,
      ),
    );
    j.closeAttempt(
      attempt.attemptId,
      outcome: mayDelete
          ? JournalAttempt.outcomeSettled
          : JournalAttempt.outcomeSettledUnverified,
      failureCode: mayDelete ? null : reasonCode,
    );
    if (rowId != null) j.setResultRef(rowId);
    // SD-2 — the settle has happened, on EITHER outcome. Cleared here rather
    // than only on `mayDelete` because `settled_unverified` is a finished
    // decision too, and leaving the stamp on it would hold the recovery queue
    // off a recording whose bytes we deliberately kept for it.
    j.clearLiveSettlePending();
    if (mayDelete) j.markSettledForCleanup();
    j.setRecoveryState(recoveryState, clearNextEligibleAt: true);
    await j.commit();
  } finally {
    // The handle goes back even when the commit failed (§A9 P1-1 ③); an
    // uncommitted manifest simply leaves the recording where it was, which is
    // the direction that keeps bytes.
    await j.close();
  }
  if (!mayDelete) return;
  // 🔴 THE BYTES GO AND THE MANIFEST STAYS, which is not half a job. The
  // manifest is now the RECORD that this recording finished and where its words
  // went (`resultRef`, the closed attempt); the sweep takes it on the ordinary
  // TTL, by which time it costs a few hundred bytes rather than tens of MB.
  // Deleting it here would also throw away the only evidence a later question
  // (「where did this recording go」) can be answered from.
  //
  // ⚠️ IT LEAVES A MANIFEST WHOSE CLAIM EXCEEDS ITS FILE, which is normally the
  // §A3-8 commit-order violation. `RetainedAudioJournalScan` is taught to read
  // 「settled, and the bytes are gone」 as the ONE benign case of that — see the
  // guard there, which is the other half of this decision.
  int released = 0;
  try {
    if (await s._journalFs.exists(pcmPath)) {
      released = await s._journalFs.lengthOf(pcmPath);
      await s._journalFs.deleteFile(pcmPath);
    }
  } on Object catch (e) {
    // A delete that failed is not a settle that failed: the manifest already
    // says `settled`, so the TTL sweep will finish the job. Announcing this as
    // a user-facing failure would be an alarm about bytes that are safe.
    debugPrint('[flowmic.audio] live settle release failed: $e');
  }
  s._journalBytes = (s._journalBytes - released).clamp(0, 1 << 62);
}

/// Card LK-4 — remove both files of a recording that captured nothing.
///
/// 🔴 IT IS THE ONE DELETE IN THIS LAYER THAT IS NOT BEHIND THE §A5-3
/// PREDICATE, AND IT IS ALLOWED BECAUSE THERE IS NOTHING TO WEIGH. The
/// predicate exists to decide whether a user's WORDS may be thrown away; a
/// journal under one frame holds no words, no interval anybody could recover,
/// and no evidence about a failure (its caller admits only the ordinary stop
/// path). Every other delete on this face still goes through
/// `evaluateRecoverySettle`.
///
/// A failure to remove either file is swallowed: the recording is then merely
/// an empty journal, which is what it was a moment ago, and stopping a
/// recording may never wait on or fail because of a write (§A9 P1-1 ③).
Future<void> _dropEmptyRecording(RetainedAudioSpill s, String recordingId) async {
  final String base = _journalBasePath(s, recordingId);
  for (final String path in <String>[
    '$base${RetainedAudioJournal.pcmSuffix}',
    '$base${RetainedAudioJournal.manifestSuffix}',
  ]) {
    try {
      if (await s._journalFs.exists(path)) await s._journalFs.deleteFile(path);
    } on Object catch (e) {
      debugPrint('[flowmic.audio] empty recording cleanup failed: $e');
    }
  }
}

String _journalBasePath(RetainedAudioSpill s, String recordingId) {
  final String dir = s._journalDirPath;
  final String sep = dir.endsWith('/') || dir.endsWith(r'\') ? '' : '/';
  return '$dir$sep$recordingId';
}
