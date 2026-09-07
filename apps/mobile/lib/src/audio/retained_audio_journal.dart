// Card LS-1 — per-recording PCM journal (append-only) + manifest.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-1 journal/manifest separation · §A3-2a sample time base ·
//     §A3-3 commit order · §A3-5 flush caveat · §A3-6/7 write failures ·
//     §A3-8 startup recovery (three separate quantities, ZERO deletes) ·
//     §A10 cards LS-0 / LS-1 / LS-1b · §A11-D D-1
//   apps/mobile/lib/src/audio/retained_audio_manifest.dart (the value type)
//   apps/mobile/lib/src/audio/retained_audio_journal_fs.dart (the seam)
//
// ── D-1: WHAT `flush()` ACTUALLY BUYS US, IN dart:io's OWN WORDS ────────────
//
// Verbatim from the Dart SDK shipped with this repo's Flutter
// (flutter 3.41.8, bin/cache/dart-sdk/lib/io/file.dart):
//
//   RandomAccessFile.flush()  — "Flushes the contents of the file to disk.
//   Returns a `Future<RandomAccessFile>` that completes with this random
//   access file when the flush operation completes." (file.dart:902-906)
//
//   File.writeAsBytes({bool flush = false}) — "If the argument [flush] is set
//   to `true`, the data written will be flushed to the file system before the
//   returned future completes." (file.dart:630-635)
//
//   File.rename(newPath) — documents cross-filesystem failure and replacement
//   of an existing target (file.dart:277-284). It says NOTHING about atomicity.
//
// 🔴 WHAT THAT DOES **NOT** SAY, AND WE MUST NOT SAY EITHER:
//   · it does not say `fsync(2)`, `fdatasync(2)`, or `FlushFileBuffers`;
//   · it says nothing about FILE METADATA (length, mtime) being synced;
//   · it says nothing about the parent DIRECTORY ENTRY, so a `rename` that
//     "completed" is not established to survive power loss (§A11-D D-4);
//   · it says nothing about ordering between two different files;
//   · "to disk" / "to the file system" are the doc's words, not a durability
//     guarantee, and are not differentiated for Android vs iOS.
//
// ⇒ The strongest honest claim this module makes is: **the bytes have been
// handed to the platform, and the manifest was published by a temp-file
// rename after the PCM flush returned.** Whether that survives a power cut is
// UNMEASURED — it is exactly what the independent gate §A11-D D-2…D-6 exists
// to measure, per platform, and that gate has NOT been run.
// 🔴 Until it has, this file, its tests, its notices and any UI built on it
// must not use the words "durable", 「已安全保存」 or 「不会丢」. §A11-D says so;
// this paragraph is the reason, not a restatement.
//
// ── WIRING STATUS ───────────────────────────────────────────────────────────
//
// 🔴 CARD LS-2 HAS WIRED THIS MODULE, AND IT IS OFF BY DEFAULT.
// `RetainedAudioSpill` opens one journal per recording — but only when it was
// constructed with `retainFromFirstFrame: true`, and the production
// construction (`retained_audio_boot.dart`) passes `false`. So on every build
// shipped today capture still writes through `RetainedAudioStore` exactly as
// it did, and this module runs in tests only.
//
// 🔴 WHAT THE FLAG IS WAITING FOR — the five prerequisites §A10-0 names before
// first-frame storage may be switched ON, none of which this card supplies:
//   ① write-failure release (P1-1) — landed (LS-1b);
//   ② cancel semantics (P1-5 / owner ruling O-5) — card LS-4;
//   ③ space policy (O-2 / A5-2) — card LS-3;
//   ④ a live-path `settle` call site (P1-4) — card LS-1b;
//   ⑤ the coverage/cleanup policy (A7-1) — card CV-1.
// Turning it on is card RC-1's step, not a config change somebody may make
// early: without ④ and ⑤ this is a protection that only ever grows the disk.
//
// Every public member below is annotated with its caller where it matters: no
// doc comment here claims a caller that does not exist (anti-façade ④).

import 'dart:async';
import 'dart:typed_data';

import 'retained_audio_deleted.dart';
import 'retained_audio_journal_fs.dart';
import 'retained_audio_manifest_retry.dart';
import 'retained_audio_manifest.dart';

export 'retained_audio_journal_fs.dart';
// The startup scan moved out for the 700-line discipline; re-exported so
// no importer had to change (see that file's header).
export 'retained_audio_journal_scan.dart';
export 'retained_audio_manifest.dart';

/// Default group-commit interval.
///
/// ⚠️ A DEFAULT, NOT A PROMISE. §A11-D D-6 asks for the measured lag between
/// "last captured byte" and "last committed byte" and says the user-visible
/// wording must be written from that number. This constant is the knob that
/// measurement will tune; it is a constructor parameter precisely so no test
/// and no caller has to accept 1000 ms as given.
const Duration kJournalCommitInterval = Duration(milliseconds: 1000);

/// Injection point for the group-commit timer, so tests drive commits on a
/// fake clock instead of sleeping.
typedef JournalTimerFactory = Timer Function(Duration d, void Function() cb);

/// Something the journal wants surfaced. Machine codes only — the localised
/// sentence belongs to the strings layer, which another card owns.
class JournalNotice {
  static const String codeAppendFailed = 'journal-append-failed';
  static const String codeShortWrite = 'journal-short-write';
  static const String codeCommitFailed = 'journal-commit-failed';
  static const String codeQuarantined = 'journal-quarantined';
  static const String codeClaimAheadOfObserved = 'journal-claim-ahead';
  static const String codeUnverifiedTail = 'journal-unverified-tail';

  final String code;
  final String recordingId;
  final int? offset;
  final int? bytes;
  final String? detail;

  const JournalNotice({
    required this.code,
    required this.recordingId,
    this.offset,
    this.bytes,
    this.detail,
  });

  @override
  String toString() =>
      'JournalNotice($code, $recordingId, offset=$offset, bytes=$bytes'
      '${detail == null ? '' : ', $detail'})';
}

/// Append-only PCM journal for one recording, plus its manifest.
///
/// 🔴 CALLER: `RetainedAudioSpill.beginRecording` / `appendCaptured` /
/// `endRecording`, and only when that spill's `retainFromFirstFrame` is true.
/// See the header for the five things that flag is waiting on.
///
/// Commit order (§A3-3, and the whole reason this class is not three lines):
///   1. append PCM bytes
///   2. flush the PCM handle
///   3. write the manifest to `<id>.manifest.json.tmp` (flushed)
///   4. rename the temp over `<id>.manifest.json`
///   5. only NOW raise the in-memory `committedClaimBytes`
///
/// Reversing 2 and 4 produces "the manifest says there are N bytes and the
/// PCM file has fewer" — §A3-3 calls that worse than losing a stretch,
/// because it is a lie a downstream reader will treat as a coordinate.
class RetainedAudioJournal {
  static const String pcmSuffix = '.pcm';
  static const String manifestSuffix = '.manifest.json';
  static const String manifestTempSuffix = '.manifest.json.tmp';
  static const String quarantineSuffix = '.manifest.quarantined';

  final JournalFileSystem _fs;
  final String _dirPath;
  final String _recordingId;
  final Duration _commitInterval;
  final JournalTimerFactory _timerFactory;
  final int Function() _clock;

  final StreamController<JournalNotice> _notices =
      StreamController<JournalNotice>.broadcast();

  JournalFileHandle? _handle;
  RecordingManifest _manifest;

  /// Bytes the platform reports are in the PCM file. Read back from the handle
  /// rather than accumulated from what we asked for: §A9 P1-1 ② — a short
  /// write that nobody re-measured is a hole nobody records.
  int _observedBytes = 0;

  int _failedAppends = 0;

  /// Every stretch this journal could not keep, in stream coordinates. See
  /// [JournalHoleLedger] for why the coordinate is not the file offset.
  final JournalHoleLedger _ledger = JournalHoleLedger();
  Timer? _pending;
  bool _closed = false;
  Future<void> _serial = Future<void>.value();

  /// Card FX-1 - the manifest ON DISK is missing facts this object holds.
  ///
  /// It is NOT "the claim is behind". A claim that is behind is the safe
  /// direction and [_commitLocked] has always said so. This flag is raised only
  /// when a publish FAILED, which means the standing manifest still carries
  /// whatever `holes` and `interruptReason` it had before the failure - and on
  /// the first failure of a recording that is `[]` and `none`. Measured on
  /// device (drill D-5b): 26.5 s of audio missing and a manifest asserting
  /// there were no holes. Full reading in retained_audio_manifest_retry.dart.
  bool _manifestBehind = false;

  /// Where a manifest goes when it cannot be published and this journal is
  /// closing. Null in tests that do not care; production always supplies the
  /// one `RetainedAudioSpill` owns.
  ManifestRepublishQueue? _republishQueue;

  /// Recordings the user threw away, shared with everything else that can
  /// write about this one. See retained_audio_deleted.dart for why this is a
  /// registry rather than a fifth existence check.
  DeletedRecordings? _deleted;

  RetainedAudioJournal._({
    required JournalFileSystem fs,
    required String dirPath,
    required String recordingId,
    required Duration commitInterval,
    required JournalTimerFactory timerFactory,
    required int Function() clock,
    required RecordingManifest manifest,
  })  : _fs = fs,
        _dirPath = dirPath,
        _recordingId = recordingId,
        _commitInterval = commitInterval,
        _timerFactory = timerFactory,
        _clock = clock,
        _manifest = manifest;

  /// Open (or reopen) the journal for [recordingId] under [dirPath].
  ///
  /// 🔴 Reopening an existing recording APPENDS. It never truncates and never
  /// deletes (§A3-8), so a previous run's bytes survive a crash-and-restart
  /// even if that run's manifest is behind.
  static Future<RetainedAudioJournal> open({
    required String dirPath,
    required String recordingId,
    JournalFileSystem fs = const IoJournalFileSystem(),
    AudioJournalFormat format = AudioJournalFormat.current,
    Duration commitInterval = kJournalCommitInterval,
    JournalTimerFactory? timerFactory,
    int Function()? clock,
    Map<String, Object?> configSnapshot = const <String, Object?>{},
    ManifestRepublishQueue? republishQueue,
    DeletedRecordings? deleted,
  }) async {
    await fs.ensureDirectory(dirPath);
    final String sep = dirPath.endsWith('/') || dirPath.endsWith(r'\') ? '' : '/';
    final String base = '$dirPath$sep$recordingId';
    RecordingManifest manifest = RecordingManifest(
      recordingId: recordingId,
      format: format,
      configSnapshot: configSnapshot,
    );
    final String mPath = '$base$manifestSuffix';
    if (await fs.exists(mPath)) {
      try {
        manifest = RecordingManifest.decode(
            String.fromCharCodes(await fs.readBytes(mPath)));
      } on ManifestFormatException {
        // Leave the unreadable manifest exactly where it is; the scan is the
        // only thing allowed to quarantine, and it does so without deleting.
        manifest = RecordingManifest(
          recordingId: recordingId,
          format: format,
          configSnapshot: configSnapshot,
        );
      }
    }
    final RetainedAudioJournal j = RetainedAudioJournal._(
      fs: fs,
      dirPath: dirPath,
      recordingId: recordingId,
      commitInterval: commitInterval,
      timerFactory: timerFactory ?? Timer.new,
      clock: clock ?? (() => DateTime.now().millisecondsSinceEpoch),
      manifest: manifest,
    );
    j._republishQueue = republishQueue;
    j._deleted = deleted;
    j._handle = await fs.openAppend(j.pcmPath);
    j._observedBytes = await j._handle!.length();
    j._ledger.restore(manifest.holes);
    return j;
  }

  String get _base {
    final String sep =
        _dirPath.endsWith('/') || _dirPath.endsWith(r'\') ? '' : '/';
    return '$_dirPath$sep$_recordingId';
  }

  String get pcmPath => '$_base$pcmSuffix';

  String get manifestPath => '$_base$manifestSuffix';

  String get recordingId => _recordingId;

  /// What the last successful manifest publish CLAIMED. Not the file length.
  int get committedClaimBytes => _manifest.committedClaimBytes;

  /// What the platform last told us the PCM file contains.
  int get observedBytes => _observedBytes;

  int get failedAppendCount => _failedAppends;

  List<JournalHole> get holes => _ledger.holes;

  RecordingManifest get manifest => _manifest;

  /// Card FX-1 - the manifest this object holds when the copy on disk is older
  /// than it, else null. Non-null means: somebody must publish this, and until
  /// they do the file is telling a reader something we know to be wrong.
  RecordingManifest? get unpublishedManifest =>
      _manifestBehind ? _manifest : null;

  /// Card FX-1 - `<dir>/<recordingId>`, the prefix both manifest paths share.
  /// Public because [ManifestRepublishQueue] republishes by path after this
  /// object is gone.
  String get basePath => _base;

  /// Announcements a UI layer can surface.
  ///
  /// 🔴 SUBSCRIBER: `RetainedAudioSpill._onJournalNotice` (card LS-2), which
  /// folds the two codes a user can act on ([codeAppendFailed],
  /// [codeShortWrite]) into `RetainedAudioStore.lastNotice` — the one value
  /// the banner queue already reads (`onRetainedAudioNoticeRouted` in
  /// `session/chat_notices.dart`). The rest stay on the
  /// diagnostics line on purpose: a failed commit under-claims, which is the
  /// safe direction, and a banner for it would be an alarm that fires when
  /// nothing was lost.
  Stream<JournalNotice> get notices => _notices.stream;

  /// Append captured PCM. Returns whether the bytes reached the file.
  ///
  /// 🔴 NEVER THROWS AND NEVER POISONS THE QUEUE (§A9 P1-1). A failed append
  /// records a [JournalHole] at the offset it would have occupied, bumps
  /// [failedAppendCount], announces, and lets the next append proceed. The
  /// alternative — one failure killing the chain — is E44, the defect this
  /// module and the LS-1b spill fix were written against.
  Future<bool> appendPcm(Uint8List bytes) {
    if (_closed || bytes.isEmpty) return Future<bool>.value(false);
    return _enqueue<bool>(() async {
      final JournalFileHandle? h = _handle;
      if (h == null) return false;
      final int before = _observedBytes;
      try {
        await h.append(bytes);
        final int after = await h.length();
        _observedBytes = after;
        final int written = after - before;
        if (written < bytes.length) {
          // Short write: the file grew, but not by as much as we handed it.
          final int at = _ledger.cursor(after);
          _ledger.record(
            start: at,
            length: bytes.length - written,
            reason: JournalInterrupt.ioError,
          );
          _announce(JournalNotice(
            code: JournalNotice.codeShortWrite,
            recordingId: _recordingId,
            offset: at,
            bytes: bytes.length - written,
          ));
        }
        _arm();
        return written > 0;
      } on Object catch (e) {
        _failedAppends += 1;
        // 🔴 RE-MEASURE THE FILE BEFORE RECORDING THE HOLE. A throwing
        // `writeFrom` (ENOSPC caught mid-write is the real case) can leave the
        // file LONGER than it was: the platform took part of the buffer and
        // then failed. The earlier version of this catch recorded the hole from
        // the STALE `before` and left `_observedBytes` behind the file, which
        // put two lies in the manifest at once — the next `_commitLocked` set
        // `committedClaimBytes` from a fresh `length()` and therefore CLAIMED
        // bytes this same manifest also lists as a hole, and the next append's
        // `written = after - before` was computed against a stale baseline, so
        // it came out LARGER than the buffer handed in and the `written <
        // bytes.length` short-write check could never fire again for the rest
        // of the recording.
        //
        // Re-reading is itself allowed to fail (the handle may be the thing
        // that died); falling back to the stale value keeps the hole
        // conservative — it covers MORE than was actually lost, which is the
        // safe direction for a record whose only job is to stop a downstream
        // reader treating a gap as continuous speech.
        int landed = 0;
        try {
          final int after = await h.length();
          if (after > before) {
            landed = after - before;
            _observedBytes = after;
          }
        } on Object {
          // Keep `before`; see above.
        }
        // 🔴 THE HOLE'S START IS A STREAM POSITION, NOT `before + landed`.
        // When nothing lands the file length does not move, so a file offset
        // gives every failure of a full-disk run the SAME start and the ranges
        // pile up (drill D-5b: 132 holes, 2 starts, union 6,400 B of 835,584).
        final int at = _ledger.cursor(_observedBytes);
        _ledger.record(
          start: at,
          length: bytes.length - landed,
          reason: JournalInterrupt.ioError,
        );
        _manifest = _manifest.copyWith(
          interruptReason: JournalInterrupt.ioError,
          holes: _ledger.holes,
        );
        _announce(JournalNotice(
          code: JournalNotice.codeAppendFailed,
          recordingId: _recordingId,
          offset: at,
          bytes: bytes.length - landed,
          detail: '$e',
        ));
        // Card FX-1 - ARM THE COMMIT TIMER ON THE FAILURE PATH TOO. It used to
        // be armed only by a SUCCESSFUL append (the `_arm()` at the end of the
        // try), so the first ENOSPC stopped every further commit attempt for
        // the rest of the recording: the hole this catch had just recorded had
        // no scheduled way of reaching the disk, even once space came back. A
        // failed append is precisely the moment the manifest most needs
        // republishing.
        _arm();
        return false;
      }
    });
  }

  /// Publish the manifest now, in the §A3-3 order. Idempotent.
  Future<void> commit() => _enqueue<void>(_commitLocked);

  /// Record a named interrupt (§A3-9). Committed on the next [commit].
  void noteInterrupt(String reason) =>
      _manifest = _manifest.copyWith(interruptReason: reason);

  /// Tombstone slot (§A10 P1-5 / owner ruling O-5). 🔴 Sets a field and
  /// nothing else — this module deletes nothing, ever.
  void markCancelled() => _manifest = _manifest.copyWith(cancelled: true);

  /// Declare that this recording passed the A5-3 clearing gate, which is the
  /// ONLY thing that makes its bytes eligible for the TTL sweep (card LS-3).
  ///
  /// 🔴 NOT `markSettled`, AND THE LONGER NAME IS THE POINT. `SegmentBuffer
  /// .markSettled(idx)` already exists two directories away and means
  /// something much weaker: a final arrived for that segment. A5-3 exists
  /// precisely because that is NOT enough to delete audio — it is one
  /// attempt's one terminal state, and it proves nothing about whether every
  /// interval was covered. Two verbs spelled the same, one of which licenses
  /// a delete, is this repo's headline defect shape with a filesystem behind
  /// it.
  ///
  /// 🔴 NO PRODUCTION CALLER, AND THE CARD THAT OWES ONE IS RC-1. It is
  /// written here rather than by the sweep because the three preconditions —
  /// coverage receipt, normal final, result row read back — are all held by
  /// the recovery queue and none of them is visible from a directory listing.
  /// Until RC-1 calls it every manifest says `settled:false` and the sweep
  /// removes nothing; §A5-1 wants exactly that failure direction.
  void markSettledForCleanup() =>
      _manifest = _manifest.copyWith(settled: true);

  /// SD-2 — declare that the live settle for this recording is about to run,
  /// so the recovery queue does not open a second, billable attempt on it in
  /// the window between the journal closing and the settle committing.
  ///
  /// 🔴 IT MUST LAND IN THE **CLOSING** COMMIT. `close()` commits on its way
  /// out, so this is called immediately before it; a stamp written after the
  /// close is a stamp that arrives after the window it was meant to cover.
  /// 🔴 AND IT MUST BE CLEARED BY SOMEBODY. [clearLiveSettlePending] is that
  /// somebody, and the settle path calls it on every exit — including the ones
  /// where it declines to settle. The grace window
  /// ([kLiveSettlePendingGraceMs]) covers only the case where nobody can:
  /// a process that died in between.
  void markLiveSettlePending(int atMs) =>
      _manifest = _manifest.copyWith(liveSettlePendingAtMs: atMs);

  /// SD-2 — the live settle has finished (or has decided there is nothing here
  /// to settle). Committed on the next [commit].
  void clearLiveSettlePending() =>
      _manifest = _manifest.copyWith(clearLiveSettlePending: true);

  /// Timeline row id for a completed recovery. Slot only — written by RC-1.
  void setResultRef(String rowId) =>
      _manifest = _manifest.copyWith(resultRef: rowId);

  /// Append a recovery attempt record.
  ///
  /// 🔴 CALLER (card RC-1a): `RecoveryJournalLeg` — one record per attempt,
  /// OPENED before the wire is touched so a process killed mid-attempt still
  /// leaves evidence that the attempt happened. `closeAttempt` writes its
  /// outcome; an attempt with no outcome is one that did not come back.
  void addAttempt(JournalAttempt a) => _manifest = _manifest.copyWith(
        attempts: <JournalAttempt>[..._manifest.attempts, a],
      );

  /// Card RC-1a — record how an attempt ended. Unknown ids are ignored: an
  /// outcome for an attempt this manifest never opened is evidence of a bug
  /// somewhere else, and inventing a record for it would hide that.
  void closeAttempt(String attemptId,
          {required String outcome, String? failureCode}) =>
      _manifest = _manifest.copyWith(
        attempts: <JournalAttempt>[
          for (final JournalAttempt a in _manifest.attempts)
            a.attemptId == attemptId
                ? a.closedWith(outcome: outcome, failureCode: failureCode)
                : a,
        ],
      );

  /// Card RC-1a (A6 R-3) — persist where the recovery queue stands, and when
  /// the next automatic attempt is due. Committed on the next [commit].
  void setRecoveryState(String state,
          {int? nextEligibleAtMs, bool clearNextEligibleAt = false}) =>
      _manifest = _manifest.copyWith(
        recoveryState: state,
        nextEligibleAtMs: nextEligibleAtMs,
        clearNextEligibleAt: clearNextEligibleAt,
      );

  /// Mode / language / prefs digest as of recording start (§A6 R-5). Slot
  /// only — read by RC-1.
  void setConfigSnapshot(Map<String, Object?> snapshot) =>
      _manifest = _manifest.copyWith(
          configSnapshot: Map<String, Object?>.from(snapshot));

  /// Release the handle WITHOUT the closing commit.
  ///
  /// 🔴 IT EXISTS FOR EXACTLY ONE CALLER AND ONE SITUATION: the recording this
  /// handle describes was DELETED while the handle was open (owner ruling
  /// O-5's user delete, from `PendingRecoveryStore`, through a different
  /// object and a different file handle). [close] commits on its way out, so
  /// closing here would write the manifest of a recording whose bytes are
  /// gone — the scan would list it again, claim ahead of an absent file, and
  /// the user's delete would look as if it had silently failed. Its one
  /// production caller is `RecoveryJournalLeg._attempt`; grep:
  ///   grep -rn "\.abandon()" apps/mobile/lib
  ///
  /// ⚠️ IT IS NOT A ROLLBACK. Bytes already appended are already on disk and
  /// stay there; what is dropped is the in-memory manifest this handle was
  /// going to write. Anything that wants a manifest kept must [close].
  Future<void> abandon() async {
    if (_closed) return;
    _closed = true;
    _pending?.cancel();
    _pending = null;
    try {
      await _handle?.close();
    } on Object {
      // Same posture as [close]: the bytes are where they are.
    }
    _handle = null;
    await _notices.close();
  }

  /// Commit once more, then release the handle. 🔴 Uses a `finally` so the
  /// handle is released even when the final commit fails — the stop path must
  /// never be blocked by a write error (§A9 P1-1 ③).
  Future<void> close({String? interruptReason}) async {
    if (_closed) return;
    if (interruptReason != null) noteInterrupt(interruptReason);
    _closed = true;
    _pending?.cancel();
    _pending = null;
    try {
      await _enqueue<void>(_commitLocked);
    } finally {
      if (_manifestBehind) {
        // Card FX-1 - the closing commit failed too (on a full disk it always
        // will). Hand the facts to something that outlives this object;
        // publishing needs only the path and the filesystem, never the handle.
        _republishQueue?.remember(PendingManifestPublish(
          fs: _fs,
          base: _base,
          manifest: _manifest,
        ));
      }
      try {
        await _handle?.close();
      } on Object {
        // Nothing to do and nothing to promise: the bytes are where they are.
      }
      _handle = null;
      await _notices.close();
    }
  }

  // --------------------------------------------------------------- internals

  /// One-at-a-time queue. Unlike E44's `_writes` chain, the wrapper always
  /// completes the tail successfully, so a failure can never make later work
  /// unreachable.
  Future<T> _enqueue<T>(Future<T> Function() body) {
    final Completer<T> out = Completer<T>();
    _serial = _serial.then((_) async {
      try {
        out.complete(await body());
      } on Object catch (e, s) {
        out.completeError(e, s);
      }
    });
    return out.future;
  }

  void _arm() {
    if (_closed || _pending != null) return;
    _pending = _timerFactory(_commitInterval, () {
      _pending = null;
      unawaited(commit().catchError((Object _) {}));
    });
  }

  Future<void> _commitLocked() async {
    final JournalFileHandle? h = _handle;
    if (h == null) return;
    // 🔴 THE ONE CHOKE POINT FOR 「the user deleted this while we were
    // writing about it」. Publishing here would put the manifest of a deleted
    // recording back on disk; the scan would list it again, claim ahead of an
    // absent file, and the delete would look as though it had silently failed.
    //
    // Its callers already ask the filesystem the same question — four times,
    // in `recovery_journal_leg.dart` and `recovery_leg_settle.dart` — and
    // every one of those is a check-then-write whose window cannot be closed
    // by adding a fifth. The registry is marked BEFORE the delete's first
    // await, so from that instant no commit can publish, wherever it came
    // from. The `_fs.exists` checks stay: they also decide what the leg DOES
    // next (abandon vs close, skip the settle), which this cannot answer.
    if (_deleted?.contains(_recordingId) ?? false) {
      // Not `_manifestBehind`: there is nothing to catch up to. Leaving the
      // flag raised would hand this manifest to the republish queue at close.
      _manifestBehind = false;
      return;
    }
    await _flushOrRecordHole(h);
    try {
      // (2) happened above: the PCM is flushed BEFORE the manifest learns of it.
      final int observed = await h.length();
      _observedBytes = observed;
      // (3) claim floors to a frame boundary: §A3-2a, an odd offset is not a
      // sample coordinate. The odd byte stays in the file.
      final int claim = observed - (observed % _manifest.format.bytesPerFrame);
      final RecordingManifest next = _manifest.copyWith(
        committedClaimBytes: claim,
        holes: _ledger.holes,
      );
      final String tmp = '$_base$manifestTempSuffix';
      await _fs.writeBytes(
        tmp,
        Uint8List.fromList(next.encode().codeUnits),
        flush: true,
      );
      // (4) publish.
      await _fs.rename(tmp, manifestPath);
      // 🔴 ASKED AGAIN, AFTER THE RENAME — AND THIS HALF IS WHAT MAKES THE
      // DELETE TERMINAL RATHER THAN MERELY EARLY. The check at the top of this
      // method is still a check-then-write: a delete arriving between it and
      // the two lines above publishes anyway, which is exactly the interleaving
      // `pending_recovery_actions_test.dart`'s 「between the check and the write
      // it guards」 case drives. There is no place to move a pre-check to that
      // fixes that; the only thing a writer can do about a fact that became
      // true underneath it is to take back what it just wrote.
      //
      // ⚠️ IT REMOVES ONLY THE MANIFEST THIS CALL PUT THERE, and never any
      // PCM — §A3-8: nothing in the journal deletes audio.
      if (_deleted?.contains(_recordingId) ?? false) {
        try {
          await _fs.deleteFile(manifestPath);
        } on Object {
          // Swallowed, and deliberately NOT announced: `notices` is the
          // user-facing channel and the audio itself is exactly where the user
          // put it (gone). What is left behind is a few hundred bytes of JSON
          // that the scan reads as claim-ahead-of-absent-file.
        }
        _manifestBehind = false;
        return;
      }
      // (5) only now is the claim ours to state.
      _manifest = next;
      _manifestBehind = false;
    } on Object catch (e) {
      _announce(JournalNotice(
        code: JournalNotice.codeCommitFailed,
        recordingId: _recordingId,
        detail: '$e',
      ));
      // Still swallowed - a commit failure must not stop capture (A9 P1-1 (3)).
      //
      // BUT NO LONGER FORGOTTEN, AND THE COMMENT THAT STOOD HERE WAS HALF TRUE.
      // It read: "a failed commit leaves the PREVIOUS manifest standing, which
      // under-claims, and under-claiming is the safe direction". True of
      // `committedClaimBytes`. FALSE of `holes` and `interruptReason`: the
      // standing manifest does not under-report those, it DENIES them, and on
      // the first failure of a recording it denies them with `[]` and `none`.
      // Drill D-5b measured exactly that (26.5 s missing, `"holes":[]`). So a
      // failed commit now (a) raises [_manifestBehind], (b) re-arms the timer
      // so the next tick tries again while the recording is still open, and
      // (c) at [close] hands the manifest to [ManifestRepublishQueue] for after
      // space comes back.
      _manifestBehind = true;
      _arm();
    }
  }

  /// Step (2) of the commit order, with A3-6's obligation attached.
  ///
  /// A SEPARATE METHOD BECAUSE A FAILING `flush()` USED TO COST US A HOLE. It
  /// sat inside [_commitLocked]'s one `try`, so a flush that threw jumped
  /// straight to the commit-failed catch - no re-measure, no hole, no
  /// `interruptReason`, and the next successful commit then published a claim
  /// computed from a `length()` that had never been reconciled with what the
  /// platform actually kept. ENOSPC is allowed to surface at either `writeFrom`
  /// or `flush` depending on the platform's buffering, and only one of those
  /// two doors was guarded.
  ///
  /// Never throws: the claim still has to be published when the flush failed,
  /// and it is then published SMALLER than what we handed the platform.
  Future<void> _flushOrRecordHole(JournalFileHandle h) async {
    try {
      await h.flush();
    } on Object catch (e) {
      _failedAppends += 1;
      int after = _observedBytes;
      try {
        after = await h.length();
      } on Object {
        // Keep the last observation; the hole below then covers MORE than was
        // lost, the conservative direction for a record whose only job is to
        // stop a reader treating a gap as continuous speech.
      }
      final int lost = _observedBytes - after;
      final int at = _ledger.cursor(after);
      if (lost > 0) {
        _ledger.record(
          start: at,
          length: lost,
          reason: JournalInterrupt.ioError,
        );
        _observedBytes = after;
      }
      _manifest = _manifest.copyWith(
        interruptReason: JournalInterrupt.ioError,
        holes: _ledger.holes,
      );
      // The SAME code an append failure raises, because from where the user
      // stands it is the same fact - a stretch of this recording has no local
      // copy. `RetainedAudioSpill._onJournalNotice` forwards this one to the
      // banner; [JournalNotice.codeCommitFailed] is deliberately NOT forwarded,
      // because a manifest that could not be written says nothing on its own
      // about the audio.
      _announce(JournalNotice(
        code: JournalNotice.codeAppendFailed,
        recordingId: _recordingId,
        offset: at,
        bytes: lost,
        detail: 'flush: $e',
      ));
    }
  }

  void _announce(JournalNotice n) {
    if (!_notices.isClosed) _notices.add(n);
  }

  /// Timestamp helper reserved for attempt records written by RC-1.
  int nowMs() => _clock();
}
