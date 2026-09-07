// SPEC-REF:
//   docs/strategy/2026-08-08-design-n1-long-recording.md §2.2 (M2 — disk-spill trigger)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//   apps/mobile/lib/src/audio/ring_buffer.dart (AudioRingBuffer.onEvict — the
//     seam this class subscribes to)
//
// ── WHEN TO SPILL ───────────────────────────────────────────────────────────
//
// NOT "always write to disk". The design's trigger (§2.2) is: spill exactly
// when the ring is about to evict a chunk the server has not confirmed
// receiving. Healthy link ⇒ nothing is ever written and this layer costs zero
// I/O; only a real outage pays.
//
// 🔴 THE DESIGN'S PREDICATE DOES NOT EXIST IN THIS CODEBASE, AND THIS COMMENT
// IS THE HONEST SUBSTITUTE.
// 「the server has not yet confirmed receiving」 presumes a per-chunk
// acknowledgement. There is none: `audio:chunk` is fire-and-forget in both
// directions — the phone emits through `AudioEmitter.emitChunk` with no ack
// callback, and the server's `socket.on('audio:chunk', …)` in
// `apps/server-core/src/socket/handlers/audio.handler.ts` answers nothing.
// (Verified by grep 2026-08-08, card N1-B3; the nearest thing to a watermark is
// the reconnect replay, which re-sends the WHOLE ring window precisely because
// no watermark exists.) Building the ack would be a protocol change — owner-gated
// — so this card does not invent one.
//
// The predicate actually available, and the one used here, is
// 「the uplink was down while this chunk was live」. It is observable, it is the
// same fact `ptt_capture_pump._emitChunk` already holds in its catch block
// (whose comment 「the ring buffer replays it on the next reconnect edge」 is the
// promise this layer exists to make true past 30 s), and it errs in the safe
// direction: a chunk that WAS delivered but got retained anyway costs disk, not
// data. The reverse error — believing a chunk was delivered when it was not —
// is the one that loses the user's words, and this predicate cannot make it.
//
// ⚠️ [uplinkUp] DEFAULTS TO TRUE ON PURPOSE. An unwired build therefore behaves
// exactly as the phone behaves today: nothing is written, nothing is promised.
// That is a graceful degradation to the status quo rather than a façade — but it
// is also why 「待转录」("pending transcription") MUST NOT ship as a user-facing
// word until the signal below has a production caller (Book 15 §2.0-b
// constraint 3).
//
// ── CARD LS-2: THE SECOND STORAGE FACE, OFF BY DEFAULT ──────────────────────
//
// Everything above describes the SEGMENT store, whose only predicate is
// 「the uplink was down」 — E7, and the largest hole in the design: when the
// socket is healthy and the recognition provider is what died, not one byte is
// written and the user's words live in a 30 s ring that then evicts them.
//
// LS-2 does not patch that predicate. It puts a second, per-recording face
// next to it — the LS-1 journal — whose predicate is 「a recording is
// happening」 and nothing else. Which face is live is [retainFromFirstFrame]:
//
//   OFF (the legacy face; no longer what ships): byte-for-byte the behaviour
//     described above. Zero journal I/O — no directory is created, no handle
//     is opened, [beginRecording] returns without doing anything.
//   ON: every captured chunk and every residual partial goes to the journal
//     from the FIRST FRAME, regardless of [uplinkUp]. Ring eviction stops
//     being a storage trigger, because the bytes were written when they were
//     captured rather than when they aged out — so the segment store is not
//     written either, and the same audio is never stored twice.
//
// 🔴 [uplinkUp] IS STILL TRACKED AND STILL LOGGED UNDER BOTH SETTINGS, and
// under ON it is a DIAGNOSTIC FIELD rather than a switch (§A4's storage row:
// 「存储从首帧起恒开，uplinkUp 降级为诊断字段而不是开关」). It is not deleted,
// because 「was the link up while this stretch was captured」 remains a real
// question the recovery queue will want answered — it just stops deciding
// whether the audio exists.
//
// 🔴 ON IN PRODUCTION SINCE 2026-09-06 (card RC-1), once all five §A10-0
// prerequisites had landed. The default lives at ONE address —
// `kRetainFromFirstFrameDefault` in audio/retained_audio_boot.dart, which
// names each of the five with a file:line. This constructor's own default
// stays `false` so the legacy face is still reachable by the tests that cover
// recordings written before the flip.
//
// ── WHY ONE FILE PER SEGMENT, AND WHAT THAT DEGRADES TO ─────────────────────
//
// The segment is the unit because the server already delimits it and already
// guarantees one final per `segment_idx` (W2.5-B). This class does NOT invent a
// second segmentation scheme (design doc §6, 「刻意不做的」 "deliberately not
// done").
//
// 🔴 But note what that means during the exact situation this layer is for: the
// phone only ever learns `segment_idx` INBOUND, from `stt:interim` / `stt:final`
// (`stt/stt_stream.dart` parses it; `session/recording_telemetry.dart` tracks the
// highest seen). During an outage NO frames arrive, so the observed index is
// FROZEN at whatever the server had reached when the link died. An entire
// offline stretch therefore lands in ONE file, keyed by the last segment the
// server actually delimited — not in one file per 30 s as a reader of the design
// might expect. That is correct (we must not fabricate segment boundaries the
// server never issued), but it is not what §2.2 reads like, so it is written
// down here rather than discovered later.

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'replay_ownership.dart';
import 'retained_audio_deleted.dart';
import 'retained_audio_journal.dart';
import 'retained_audio_manifest_retry.dart';
import 'retained_audio_store.dart';
import 'ring_buffer.dart';

part 'retained_audio_hole.dart';
part 'retained_audio_legacy_face.dart';
part 'retained_audio_live_settle.dart';

/// Decides whether an evicted ring chunk becomes retained audio, and keys it to
/// a segment. Retention policy itself lives in [RetainedAudioStore].
class RetainedAudioSpill {
  final RetainedAudioStore _store;

  /// See the header: default true ⇒ an unwired build writes nothing.
  bool _uplinkUp = true;

  /// CR-4 — file this capture's bytes under [key] (the article id). Forwarded
  /// rather than held: the store owns the naming, and a second copy of 「which
  /// session」 here is a second thing that can be stale.
  void beginSession(String key) => _store.beginSession(key);

  /// CR-4 — back to a fresh per-run key. See [RetainedAudioStore.endSession]
  /// for why it is not 「the previous key」.
  void endSession() => _store.endSession();

  /// The key writes are currently filed under.
  String get sessionKey => _store.sessionKey;

  /// Bytes retained for the current session — see
  /// [RetainedAudioStore.sessionRetainedBytes] for why this is counted rather
  /// than read back off the disk.
  int get sessionRetainedBytes => _store.sessionRetainedBytes;

  /// Last `segment_idx` the SERVER delimited, as observed on inbound stt
  /// frames. Starts at 0: before any frame arrives the utterance is, by the
  /// server's own numbering, segment 0.
  int _segmentIdx = 0;

  /// Serialises appends. Eviction is synchronous (it happens inside
  /// [AudioRingBuffer.prune]) while writing is async, so without this chain two
  /// evictions could interleave their writes and produce PCM in the wrong
  /// order — which is not a corrupt file, it is garbled speech that still
  /// transcribes to something, i.e. a silent data corruption.
  ///
  /// 🔴 P1-1 (card LS-1b; audit evidence E44) — THIS CHAIN USED TO BE POISON.
  /// Every link was `_writes = _writes.then(...)` with no error handling, so
  /// the FIRST append that threw left `_writes` permanently rejected and every
  /// later `.then` callback simply never ran: capture kept going, the ring kept
  /// evicting, and not one further byte reached the disk — silently. The same
  /// rejected future was handed straight to `flush()`'s awaiter, so the stop
  /// path (`retainTail` -> `flush`) rethrew a failure that had happened minutes
  /// earlier, at a caller whose job was to stop the microphone.
  ///
  /// Now each queued append isolates its own failure inside [_appendOne]: the
  /// chain's tail always completes successfully, so later appends still run;
  /// the bytes that did not make it are recorded as a [RetainedAudioHole]
  /// rather than swallowed (a silently missing interval reads downstream as
  /// continuous speech); and [flush] can never rethrow a past failure.
  Future<void> _writes = Future<void>.value();

  /// Chunks that were dropped because the store refused them (cap reached).
  /// Counted so a caller can assert on it; the store has already announced each
  /// one on [RetainedAudioStore.notices].
  int _refusedChunks = 0;

  /// Appends that THREW (as opposed to being refused by the cap, which is
  /// [_refusedChunks] and is already announced by the store). P1-1.
  int _failedWrites = 0;

  /// Intervals of captured audio that were handed to this layer and did not
  /// reach the disk. §A3-6/7: a write failure gets a named record, never a
  /// swallowed exception.
  final List<RetainedAudioHole> _holes = <RetainedAudioHole>[];

  /// 🔴 P1-1 — the spill's OWN announcement channel.
  ///
  /// It is not [RetainedAudioStore.notices] because the store's `_announce` is
  /// private and this failure happens OUTSIDE the store: the store never
  /// returned, so it never got the chance to announce anything. Folding these
  /// into the store's stream means editing that file, which card LS-3 is
  /// concurrently restructuring — so the seam is here and merging the two
  /// streams is LS-1b/LS-3 work.
  ///
  /// 🔴 STILL NO SUBSCRIBER, AND IT NO LONGER MATTERS. Card LS-2 did the
  /// wiring the paragraph above asked for, but not by adding a listener here:
  /// [_appendOne] now ALSO announces on the store's channel, which is the
  /// value the banner queue already binds to. This stream stays because tests
  /// assert on the failure objects themselves, and because a caller that wants
  /// the hole (not the sentence) has nowhere else to get it.
  final StreamController<RetainedAudioWriteFailure> _writeFailures =
      StreamController<RetainedAudioWriteFailure>.broadcast();

  /// Card LS-2 — [retainFromFirstFrame] chooses the storage face (see the
  /// header). 🔴 THIS DEFAULT IS NOT THE PRODUCT'S: production goes through
  /// `openRetainedAudioSpill`, whose `kRetainFromFirstFrameDefault` is `true`
  /// since card RC-1. `false` here only keeps the legacy face constructible.
  ///
  /// [journalDirPath] defaults to the store's own directory: one recording's
  /// `<id>.pcm` + `<id>.manifest.json` sit alongside the segment files, which
  /// is what lets the LS-3 sweep see both layouts in one listing. [journalFs]
  /// is the seam tests drive; production gets `IoJournalFileSystem`.
  RetainedAudioSpill({
    required RetainedAudioStore store,
    bool retainFromFirstFrame = false,
    String? journalDirPath,
    JournalFileSystem journalFs = const IoJournalFileSystem(),
    int Function()? clock,
  })  : _store = store,
        _retainFromFirstFrame = retainFromFirstFrame,
        _journalDirPath = journalDirPath ?? store.dirPath,
        _journalFs = journalFs,
        _clock = clock ?? _wallClock;

  static int _wallClock() => DateTime.now().microsecondsSinceEpoch;

  RetainedAudioStore get store => _store;

  // ───────────────────────────────────── card LS-2: the journal storage face

  final bool _retainFromFirstFrame;
  final String _journalDirPath;
  final JournalFileSystem _journalFs;
  final int Function() _clock;

  RetainedAudioJournal? _journal;
  String? _recordingId;

  /// Card RC-1a (audit A6 R-5) - mode / spoken language / prefs digest AS OF
  /// THE MOMENT THE MICROPHONE OPENED, handed to the next journal this spill
  /// opens.
  ///
  /// WRITER: [noteConfigSnapshot], called by `PttSessionEdges.pttDown`
  /// (ptt/ptt_edges.dart) on the line before `audio.start()` - the only line in
  /// the product that holds all three values at recording time.
  /// READER: [beginRecording] below, and after that the manifest.
  ///
  /// EMPTY IS A LEGACY RECORDING, NOT A DEFAULT. The recovery queue reads an
  /// empty snapshot as "nobody recorded what this was" and says so in its
  /// diagnostics rather than substituting today's settings - substituting is
  /// the defect R-5 exists to close (`chat_inbound_routes.dart:43`).
  Map<String, Object?> _configSnapshot = const <String, Object?>{};

  /// See [_configSnapshot]. Cheap and idempotent: a press that never reaches
  /// `audio.start()` leaves a snapshot that the next press overwrites.
  void noteConfigSnapshot(Map<String, Object?> snapshot) =>
      _configSnapshot = Map<String, Object?>.unmodifiable(snapshot);
  int _journalBytes = 0;
  bool _journalCapAnnounced = false;
  StreamSubscription<JournalNotice>? _journalNotices;

  /// Card FX-1 - manifests whose publish failed, kept until they can land.
  ///
  /// ONE PER SPILL, NOT A GLOBAL, and it is handed to every journal this
  /// object opens. Retried at both ends of a recording ([beginRecording] and
  /// [endRecording]) because the case that produced it - drill D-5b, the disk
  /// filled mid-press - freed its space only AFTER the press was over, when
  /// the journal that held the facts had already closed its handle.
  final ManifestRepublishQueue _republishQueue = ManifestRepublishQueue();

  /// Card RF-2 — recordings the user deleted, shared with every writer that
  /// can still be mid-flight over one of them.
  ///
  /// It lives HERE for the same reason [replayOwnership] does: this object
  /// owns the journal, and both parties can reach it — `PendingRecoveryStore`
  /// marks an id as its delete begins, `RecoveryJournalLeg` and the live
  /// settle open journals that consult it.
  final DeletedRecordings deletedRecordings = DeletedRecordings();

  /// Recording ids whose manifest is still behind what we know about them.
  /// Empty in every healthy run.
  List<String> get unpublishedManifestIds => _republishQueue.pendingIds;

  /// Try to publish them now. Returns how many landed. Never throws.
  Future<int> republishPendingManifests() => _republishQueue.republish();

  /// Serialises journal work. Same shape as [_writes] and for the same reason
  /// — open, append and close are async while their callers are not — with the
  /// same P1-1 rule: every link completes successfully, so one failure can
  /// never make the later ones unreachable.
  Future<void> _journalOps = Future<void>.value();

  /// Which storage face is live. See the header.
  bool get retainFromFirstFrame => _retainFromFirstFrame;

  /// The filesystem this spill's journals are written through.
  ///
  /// 🔴 EXPOSED SO THE RECOVERY LEG READS THE SAME ONE (card RC-1a). A recovery
  /// that opened the journal through a DIFFERENT seam than the capture wrote it
  /// through would be testable and wrong: a test could then drive one and
  /// assert the other, which is the shape where a fixture answers the question
  /// instead of the product.
  JournalFileSystem get journalFs => _journalFs;

  /// Card RC-1a (audit P1-2) - the send-ownership registry shared by the
  /// recovery leg and the reconnect ring replay.
  ///
  /// It lives HERE because this object owns the journal, and both parties can
  /// already reach it: `RecoveryJournalLeg` claims a recording while it feeds
  /// it back, and `ReconnectCoordinator`'s replay gate reads the claim.
  /// 🔴 A CLAIM IS NOT DELIVERY AND NEVER LICENSES A DELETE - replay_ownership
  /// .dart's header carries the ruling that says so.
  final ReplayOwnership replayOwnership = ReplayOwnership();

  /// The recording currently being journalled, or null.
  ///
  /// 🔴 ONE RECORDING = ONE JOURNAL, and the id is minted at
  /// [beginRecording] from the CURRENT session key rather than cached
  /// alongside it. That is the whole of the §A9 P2-8 note about the two roll
  /// points: `ptt_edges.dart` rolls the session key between two ordinary
  /// presses and `ptt_continuous.dart` holds it across one continuous
  /// recording, and minting per `AudioCapture.start()` gives both the right
  /// answer without either file having to know the journal exists. A cached
  /// id would have been the failure they warn about — the article ends and
  /// the recording is still open.
  ///
  /// ⚠️ NO PRODUCTION READER TODAY: the tests read it, and card RC-1 will,
  /// because a recovery queue has to name the recording it is resuming. Said
  /// here rather than left for a grep to discover.
  String? get currentRecordingId => _recordingId;

  /// Bytes this run has handed to journals. Counted, not read back, for the
  /// same reason [RetainedAudioStore.sessionRetainedBytes] is.
  int get journalBytes => _journalBytes;

  /// Card LS-1b — what the live press stamped on `audio:start`, or null when no
  /// recording has been opened under the journal face.
  ///
  /// 🔴 IT IS THE ONE THE TERMINAL FINAL SETTLES, AND IT IS REPLACED ONLY BY
  /// THE NEXT [beginRecording]. A settle path that read the journal instead
  /// would find null (the handle closes on stop, the final arrives after) and a
  /// settle path that read the store's session key would find whatever the next
  /// press rolled it to.
  LiveAudioAttempt? get liveAttempt => _liveAttempt;

  LiveAudioAttempt? _liveAttempt;

  /// Card LK-4 — the recording whose empty journal was just removed.
  ///
  /// 🔴 IT EXISTS BECAUSE A SETTLE CAN STILL ARRIVE FOR IT. A press that
  /// captured nothing may still draw a terminal `stt:final` out of the server
  /// (the engine answers about a session, not about our bytes), and
  /// `_publishLiveSettle` opens a journal by name — which would RECREATE the
  /// manifest and the empty PCM the drop had just taken away. MEASURED
  /// 2026-09-07: the LK-4 case failed on exactly that, with a manifest back on
  /// disk one turn after it was deleted.
  ///
  /// ⚠️ ONE SLOT, NOT A SET. It is cleared by the next [beginRecording], so it
  /// only ever guards the window between a drop and the settle that chases it;
  /// a stale id can therefore never suppress a later recording's settle.
  String? _droppedEmptyRecordingId;

  /// Card LS-1b — the settle seam. See [_publishLiveSettle] for the order and
  /// for why the delete happens here rather than at the TTL sweep.
  ///
  /// 🔴 IT IS NOT A DECISION. `mayDelete` is `evaluateRecoverySettle`'s verdict,
  /// carried in from `session/live_settle.dart`; this object may not add a
  /// condition and may not drop one.
  Future<void> publishLiveSettle({
    required LiveAudioAttempt attempt,
    required String? rowId,
    required String reasonCode,
    required bool mayDelete,
    required String attemptKindWire,
    required String recoveryState,
  }) =>
      _enqueueJournal(() => _publishLiveSettle(
            this,
            attempt: attempt,
            rowId: rowId,
            reasonCode: reasonCode,
            mayDelete: mayDelete,
            attemptKindWire: attemptKindWire,
            recoveryState: recoveryState,
          ));

  @visibleForTesting
  RetainedAudioJournal? get journal => _journal;

  /// A recording is starting: open its journal.
  ///
  /// CALLER: `AudioCapture.start` (audio_capture_journal.dart). A no-op when
  /// [retainFromFirstFrame] is false — that is what zero journal I/O means:
  /// no directory, no handle, no manifest.
  Future<void> beginRecording() {
    if (!_retainFromFirstFrame) return Future<void>.value();
    final String id = '${_store.sessionKey}-r${_clock()}';
    // 🔴 THE STAMP IS MINTED SYNCHRONOUSLY, THE JOURNAL IS OPENED ON THE QUEUE,
    // AND THAT SPLIT IS THE CARD. `ptt_edges.pttDown` puts `recording_id` on
    // `audio:start` in the turn after `audio.start()` returns; a value that
    // only appeared once the queued open ran would be null on every first
    // press, and the frame would go out unstamped — indistinguishable, from the
    // receipt's side, from an old relay stripping it.
    _droppedEmptyRecordingId = null; // card LK-4 — one slot, this press's own
    _liveAttempt = LiveAudioAttempt(
      recordingId: id,
      attemptId: '$id-a1',
      startedAtMs: _clock(),
    );
    return _enqueueJournal(() async {
      await _closeJournalLocked(null);
      _recordingId = id;
      _journalCapAnnounced = false;
      // Card FX-1 - space may have come back since the last recording ended.
      // Unawaited: a stale manifest must never delay opening the microphone.
      unawaited(_republishQueue.republish());
      _journal = await RetainedAudioJournal.open(
        dirPath: _journalDirPath,
        recordingId: id,
        fs: _journalFs,
        configSnapshot: _configSnapshot,
        republishQueue: _republishQueue,
        deleted: deletedRecordings,
      );
      _journalNotices = _journal!.notices.listen(_onJournalNotice);
    });
  }

  /// Captured PCM, from the first frame, whatever the uplink is doing.
  ///
  /// CALLER: `AudioCapture._emitChunk` (every 200 ms chunk),
  /// `AudioCapture.takeResidualChunk` (the sub-chunk stop tail) and
  /// `AudioCapture.pause` (the partial that pause used to discard).
  /// Synchronous by necessity — its callers are — so the write is queued.
  void appendCaptured(Uint8List bytes) {
    if (!_retainFromFirstFrame || bytes.isEmpty) return;
    _enqueueJournal(() async {
      final RetainedAudioJournal? j = _journal;
      if (j == null) return;
      // 🔴 O-2's cap, applied to this face too. The budget is the whole
      // directory, so what is already retained counts: the two faces must not
      // each spend it. Refusing is the ruled behaviour — never delete older
      // unrecovered audio to make room.
      if (_store.retainedBytes + _journalBytes + bytes.length >
          _store.capBytes) {
        if (!_journalCapAnnounced) {
          _journalCapAnnounced = true;
          _store.announce(const RetainedAudioNotice(
            code: RetainedAudioNotice.codeCapReached,
            bytes: 0,
          ));
        }
        return;
      }
      if (await j.appendPcm(bytes)) _journalBytes += bytes.length;
    });
  }

  /// 🔴 CARD LS-4 (owner ruling O-5) — THE USER SWIPED THIS RECORDING AWAY.
  /// Keep every byte; never let it be fed back on its own.
  ///
  /// CALLER: `AudioCapture.fenceAndStop(reason: JournalInterrupt.cancelled)`,
  /// i.e. `PttSession.pttCancel` — and nothing else. The other three
  /// `fenceAndStop` callers (capture fault / `audio:auto-stopped` / auth drain)
  /// do NOT reach this verb, because none of them is the user throwing words
  /// away and all three must stay recoverable.
  ///
  /// 🔴 IT WRITES BOTH FACES, AND THAT IS WHY IT IS ONE VERB. The legacy
  /// face's marker is written UNCONDITIONALLY — it is today's product, the flag
  /// is off, and the defect §A12 P1-5 measured lives there. The journal face's
  /// [RecordingManifest.cancelled] is written only when the journal is running.
  /// Two call sites for one decision is how the two faces come to disagree
  /// about whether a recording was cancelled.
  ///
  /// ⚠️ ORDER MATTERS AND IS BOUGHT BY THE QUEUE, NOT BY AWAITING: the
  /// `markCancelled` below rides `_enqueueJournal`, and so does the
  /// [endRecording] that `fenceAndStop` issues one line later, so the flag is
  /// on the manifest before the close commits it. A synchronous
  /// `_journal?.markCancelled()` here would race the open on the very first
  /// press instead.
  ///
  /// 🔴 DELETES NOTHING, EVER. The ruling is 「保留但永不自动转」.
  /// 🔴 NOT `async`, AND THAT IS LOAD-BEARING — MEASURED, NOT REASONED
  /// ABOUT. The journal work must be ENQUEUED in the same synchronous turn as
  /// the caller, because `fenceAndStop` enqueues the journal CLOSE on the very
  /// next line. The first version awaited the store's file write before
  /// touching the journal queue; the close therefore went in first, published a
  /// manifest with `cancelled:false`, and set `_journal` to null, so
  /// `markCancelled` landed on nothing. The journal-face test failed with
  /// `Expected: true  Actual: <false>` — a tombstone that wrote a marker and
  /// lost the flag, i.e. exactly the half-applied state §A4 warns about.
  Future<void> tombstoneCurrentRecording({String? sessionKey}) {
    // Queued FIRST (see above), then the marker. Both are awaited together, so
    // a caller that wants "the tombstone is on disk" can await one future.
    final Future<void> journal = !_retainFromFirstFrame
        ? Future<void>.value()
        : _enqueueJournal(() async {
            final RetainedAudioJournal? j = _journal;
            if (j == null) return;
            j.markCancelled();
            // Commit now rather than relying on the close: a process killed
            // between the swipe and the close would otherwise leave bytes with
            // no tombstone, the exact state this card makes impossible.
            await j.commit();
          });
    // 🔴 [sessionKey] is the key captured when the recording STARTED, not the
    // store's cursor. `AudioCapture.start`'s comment has the measurement: the
    // cancel path rolls the cursor before it gets here, so reading it live
    // tombstones an empty key. null falls back to the cursor for a caller that
    // has no recording of its own (tests).
    return Future.wait<void>(<Future<void>>[
      _store.tombstoneSession(session: sessionKey),
      journal,
    ]);
  }

  /// The recording ended. [interruptReason] is one of [JournalInterrupt]'s
  /// named causes, or null for an ordinary stop.
  ///
  /// CALLER: `AudioCapture.stop` (null), `stopForLinkLoss`
  /// ([JournalInterrupt.linkLoss]) and `fenceAndStop` (one of
  /// [JournalInterrupt.cancelled] / [JournalInterrupt.captureFault] /
  /// [JournalInterrupt.autoStopped] / [JournalInterrupt.authDrained]).
  ///
  /// 🔴 IT RECORDS A REASON AND DELETES NOTHING, AND THE REASON IS NOT THE
  /// TOMBSTONE — [tombstoneCurrentRecording] above is.
  Future<void> endRecording({String? interruptReason}) {
    if (!_retainFromFirstFrame) return Future<void>.value();
    return _enqueueJournal(() => _endRecordingLocked(this, interruptReason));
  }

  /// Card LS-1b — the capture's OWN sequence count at the moment it stopped.
  /// Synchronous, and it must stay so: see `_journalNoteFrames`
  /// (audio/audio_capture_journal.dart) for the race that put it there. A stamp
  /// with no count is one the settle path refuses.
  void noteLiveFramesEmitted(int frames) =>
      _liveAttempt?.closeWithFrames(frames);

  /// Await every queued journal operation, then commit. Tests need it for the
  /// same reason [flush] exists; `AudioCapture.retainUnsentTail` calls it on
  /// the stop path so "is the tail committed?" has an answer.
  Future<void> journalFlush() => _enqueueJournal(() async {
        await _journal?.commit();
      });

  Future<void> _closeJournalLocked(String? interruptReason) async {
    final RetainedAudioJournal? j = _journal;
    if (j == null) return;
    _journal = null;
    _recordingId = null;
    await _journalNotices?.cancel();
    _journalNotices = null;
    try {
      await j.close(interruptReason: interruptReason);
    } on Object catch (e) {
      // P1-1 ③: a write failure must never block stopping. The journal's own
      // close() already swallows its commit failure inside a `finally`; this
      // catch covers the handle itself going away underneath us.
      debugPrint('[flowmic.audio] journal close failed: $e');
    }
    // Card FX-1 - `close()` hands an unpublishable manifest to the queue on its
    // way out; this is the first chance to land it. On the drill's own timeline
    // the disk was still full here and this call is a no-op that leaves the
    // entry queued for the next [beginRecording]. Unawaited for the same reason
    // the close is guarded: nothing about stopping may wait on a write.
    unawaited(_republishQueue.republish());
  }

  /// 🔴 THE MERGE §A9 ASKED FOR: two announcement channels, one value the
  /// screen reads.
  ///
  /// Only the two codes a user can act on become notices — an append that
  /// failed and a short write both mean "this stretch has no local copy". A
  /// failed COMMIT does not: the audio itself may be perfectly fine, so an
  /// alarm here would fire about bytes that are all present.
  ///
  /// 🔴 CARD FX-1 CORRECTED THE SECOND HALF OF THAT REASON, WHICH WAS FALSE.
  /// It used to read 「it leaves the previous manifest standing, which
  /// under-claims, and under-claiming loses nothing」. Under-claiming
  /// `committedClaimBytes` loses nothing; keeping the previous `holes` and
  /// `interruptReason` loses the RECORD OF A HOLE — the standing manifest does
  /// not under-report those, it denies them (drill D-5b: 26.5 s missing,
  /// `"holes":[]`). Staying silent HERE is still right, because the failure
  /// that matters already announced itself as [JournalNotice.codeAppendFailed];
  /// what a failed commit needed was a retry, and that is
  /// [ManifestRepublishQueue], not a banner.
  void _onJournalNotice(JournalNotice n) {
    debugPrint('[flowmic.audio] journal notice: $n');
    if (n.code != JournalNotice.codeAppendFailed &&
        n.code != JournalNotice.codeShortWrite) {
      return;
    }
    _store.announce(RetainedAudioNotice(
      code: RetainedAudioNotice.codeWriteFailed,
      bytes: n.bytes ?? 0,
    ));
  }

  Future<void> _enqueueJournal(Future<void> Function() body) {
    final Completer<void> out = Completer<void>();
    _journalOps = _journalOps.then((_) async {
      try {
        await body();
        out.complete();
      } on Object catch (e, st) {
        debugPrint('[flowmic.audio] journal op failed: $e');
        out.completeError(e, st);
      }
    });
    // The returned future carries the failure to whoever asked; the CHAIN
    // never does, so the next operation still gets its turn (P1-1).
    return out.future.catchError((Object _) {});
  }

  bool get uplinkUp => _uplinkUp;

  int get currentSegmentIdx => _segmentIdx;

  int get refusedChunks => _refusedChunks;

  /// P1-1 — appends that threw. Distinct from [refusedChunks]: the cap saying
  /// no is a decision, an I/O error is a failure, and the two ask the product
  /// for different words.
  int get failedWrites => _failedWrites;

  /// P1-1 — the intervals that are missing from the retained audio, in the
  /// order they failed.
  List<RetainedAudioHole> get holes =>
      List<RetainedAudioHole>.unmodifiable(_holes);

  /// P1-1 — see [_writeFailures]. No production subscriber yet (card LS-2).
  Stream<RetainedAudioWriteFailure> get writeFailures =>
      _writeFailures.stream;

  /// Release the announcement channel and close any open journal. Optional:
  /// the spill outlives every capture in production, so nothing calls this
  /// outside tests today.
  ///
  /// 🔴 IT AWAITS EVERY WRITE THIS OBJECT STARTED, AND IT USED TO AWAIT ONLY
  /// ONE OF THREE. `endRecording` rides [_journalOps], so it covered the
  /// journal work queued BEFORE it and nothing else:
  ///   · [_writes] — the legacy-face append chain — is a SECOND queue and was
  ///     never awaited, so `dispose()` could return with PCM still going down;
  ///   · `_closeJournalLocked` hands its last manifest to [_republishQueue]
  ///     and fires `republish()` UNAWAITED on its way out, i.e. a whole-file
  ///     write + rename that outlived the object that started it;
  ///   · the live settle rides [_journalOps] too and releases its handle in a
  ///     `finally` AFTER the manifest commit, so an op enqueued while dispose
  ///     was running still had a file open.
  /// MEASURED 2026-09-07 (dev-pc-a): a rig that deleted its temp
  /// directory after `session.dispose()` hit `PathAccessException … errno =
  /// 32` in 7 of 8 oversubscribed runs of `live_settle_test.dart` — a handle
  /// this object owned, still open after everything the caller could await.
  /// Windows names it; on POSIX the same window silently deletes a file out
  /// from under a live write.
  ///
  /// Judged by `retained_audio_dispose_drains_test.dart`, whose two reverse
  /// controls remove one await each.
  Future<void> dispose() async {
    await endRecording(interruptReason: JournalInterrupt.processGone);
    await flush();
    // Serialised inside the queue, so this also awaits the unawaited call
    // `_closeJournalLocked` just made.
    await republishPendingManifests();
    // Anything the two lines above enqueued (a settle racing the close) is on
    // this chain; its tail always completes, so awaiting it cannot throw.
    await _journalOps;
    await _writeFailures.close();
  }

  /// The uplink is down: from here, chunks aging out of the ring are retained
  /// instead of discarded. Body moved to retained_audio_legacy_face.dart.
  void noteUplinkDown() => _noteUplinkDown(this);

  /// The uplink is back. Body moved to retained_audio_legacy_face.dart.
  void noteUplinkUp() => _noteUplinkUp(this);

  /// Record the `segment_idx` seen on an inbound stt frame. Body moved to
  /// retained_audio_legacy_face.dart.
  void noteSegmentObserved(int segmentIdx) => _noteSegmentObserved(this, segmentIdx);

  /// Ring eviction sink. Wired to [AudioRingBuffer.onEvict]; synchronous by
  /// necessity, so the write is queued rather than awaited. Body moved to
  /// retained_audio_legacy_face.dart (700-line cap).
  void onEvicted(BufferedChunk chunk) => _onEvicted(this, chunk);

  /// Retain chunks that are still IN the ring because capture ended before
  /// they aged out. Body moved to retained_audio_legacy_face.dart.
  Future<void> retainTail(Iterable<BufferedChunk> chunks) =>
      _retainTail(this, chunks);

  /// Await every queued append; see retained_audio_legacy_face.dart for why
  /// it never rethrows a past append failure.
  Future<void> flush() => _flush(this);

  // 🔴 E25 CLOSED (card LS-1b, 2026-09-06): `settleSegment(int)` USED TO STAND
  // HERE AND HAS BEEN DELETED. It had no production caller and the audit asked
  // for one or for its removal; removal is the answer, and the reason is the
  // one `retained_audio_session_identity_test.dart` measured before this card
  // existed: on the LEGACY face, retained bytes are BY CONSTRUCTION the bytes
  // the server did not receive, so 「a final arrived ⇒ settle that segment」
  // would delete audio that was never transcribed. There is no correct live
  // caller for it.
  //
  // What the live path settles instead is the RECORDING, on the journal face,
  // and only behind the three-condition predicate — [publishLiveSettle] above.
  // The store's own `settle(idx, session:)` is untouched and still has its
  // production caller (`backfill_runner.dart`, after re-feeding a segment).

  /// Segments with retained audio, ascending. Body moved to
  /// retained_audio_legacy_face.dart.
  Future<List<int>> pendingSegments() => _pendingSegments(this);

  /// Retained bytes for one segment, for the recovery feed. Body moved to
  /// retained_audio_legacy_face.dart.
  Future<Uint8List?> readSegment(int segmentIdx) => _readSegment(this, segmentIdx);
}
