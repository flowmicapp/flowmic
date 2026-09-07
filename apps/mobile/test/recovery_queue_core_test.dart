// Card RC-1a — THE RECOVERY QUEUE CORE.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A10's failure-test tables (the group names below are those test names)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//
// 🔴 WHAT IS DELIBERATELY *NOT* HERE. `backfill_channel_test.dart` is the
// UNCHANGED CONTROL for the legacy segment leg: this card promised the flag-off
// path stays byte-identical, and the only way that promise is worth anything is
// if the test that covers it was not touched. Nothing in this file imports it,
// edits it, or duplicates it.
//
// The rig below runs the JOURNAL face (`retainFromFirstFrame: true`), which no
// shipped build does.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/replay_ownership.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_gate.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/session/recovery_settle.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const int kPcmBytesPerSecondLocal = 32000;

/// The three bits a metered server has to advertise for tier A. The rig's
/// channel probe has not run, so `BackfillRunner` reads the connection as
/// metered - the fail-closed direction, and the one production takes until the
/// probe answers.
const List<String> tierACaps = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

CoverageReceipt receipt({
  int version = 1,
  required int fedFrames,
  int seqGaps = 0,
  int drops = 0,
  bool endedNormally = true,
  String? recordingId,
  String? attemptId,
  int? start,
  int? end,
}) =>
    CoverageReceipt(
      version: version,
      fedFrames: fedFrames,
      seqGaps: seqGaps,
      drops: drops,
      engineLegRollovers: 0,
      endedNormally: endedNormally,
      recordingId: recordingId,
      attemptId: attemptId,
      rangeStartSample: start,
      rangeEndSample: end,
    );

RecoverySettleInputs inputs({
  CoverageReceipt? r,
  int framesEmitted = 10,
  bool endedOnTerminalFinal = true,
  bool rowPersisted = true,
  bool serverMayDelete = true,
  // A5-4 - a result WITH words is the ordinary case; the empty-result group
  // below is the one that overrides it. Defaulted rather than required so the
  // existing cases keep measuring the condition each of them is about.
  String? resultText = 'hello',
}) =>
    RecoverySettleInputs(
      // Card LS-1b turned the pin into 「what this attempt SENT」 so one
      // predicate can serve the recovery leg and the live press (which cannot
      // name a range end at `audio:start`). A recovery attempt sends all four,
      // which is what this helper describes.
      sent: const StartEcho(
        recordingId: 'r1',
        attemptId: 'a1',
        rangeStartSample: 0,
        rangeEndSample: 32000,
      ),
      framesEmitted: framesEmitted,
      receipt: r,
      resultText: resultText,
      endedOnTerminalFinal: endedOnTerminalFinal,
      rowPersistedAndReadBack: rowPersisted,
      serverMayDelete: serverMayDelete,
    );

CoverageReceipt goodReceipt() => receipt(
    fedFrames: 10, recordingId: 'r1', attemptId: 'a1', start: 0, end: 32000);

// ───────────────────────────────────────────────────────── the journal rig

/// Answers `audio:stop` the way the server does, and echoes the identity the
/// phone put on `audio:start` back on the terminal final's coverage receipt.
///
/// 🔴 THE ECHO IS THE POINT. A fixture that invented its own attempt id would
/// make `receiptMismatch` unreachable and the settle path would look green for
/// the wrong reason.
class _EchoingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunkFrames = 0;

  /// null ⇒ answer nothing (the engine never speaks).
  bool replyOnStop = true;
  int? overrideFedFrames;
  bool endedNormally = true;

  /// What the terminal final carries. '' is the server's silence gate:
  /// `stt:final {"text":"","empty_reason":"heard_no_words"}` - drill B-7 / B-1.
  String finalText = 'recovered words';

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      chunkFrames = 0;
    }
    if (event == FlowMicEvents.audioChunk) chunkFrames += 1;
    if (event == FlowMicEvents.audioStop && replyOnStop && starts.isNotEmpty) {
      final Map<String, Object?> s = starts.last;
      Future<void>.microtask(() {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': finalText,
          if (finalText.isEmpty) 'empty_reason': 'heard_no_words',
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': 0,
          'is_segment': false,
          'duration_ms': 1000,
          'coverage_receipt_version': 1,
          'fed_frames': overrideFedFrames ?? chunkFrames,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 0,
          'ended_normally': endedNormally,
          'recording_id': s['recording_id'],
          'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

/// Deletes a recording's files during the settle's READ-BACK of the row - the
/// exact window owner ruling O-5's delete can land in, and the one the
/// existence check at the top of `_finish` has already passed.
///
/// 🔴 IT IS A FAKE OF A REAL SEQUENCE, NOT AN INVENTED ONE. `_finish`
/// asks "does the manifest still exist" before two awaits (`awaitPersisted`
/// then `isPersisted`) and used to write straight after them; a delete inside
/// those awaits meant every write below committed through a still-valid handle
/// and RECREATED the manifest of audio the user had just thrown away. Timing it
/// with a sleep is what made `pending_recovery_actions_test.dart`'s version of
/// this flaky (2 of 12 oversubscribed runs); doing it from inside the read
/// makes it happen on every run.
class _DeletesRecordingOnReadBack extends InMemoryTimelinePersistence {
  /// `<dir>/<recordingId>`; the two suffixes are appended here. Set after the
  /// rig has opened, because the rig owns the temp directory; null until then
  /// and inert.
  String? base;
  int reads = 0;

  @override
  Future<List<TimelineEntry>> loadAll() async {
    reads += 1;
    final String? b = base;
    if (b != null) {
      // ⚠️ THE MANIFEST ONLY. Taking the PCM here would starve
      // `_streamRange` and the attempt would end before it ever reached the
      // read-back - a test that passed for the wrong reason.
      final File f = File('$b${RetainedAudioJournal.manifestSuffix}');
      if (f.existsSync()) f.deleteSync();
    }
    return super.loadAll();
  }
}

/// Counts range reads so `long_recording_stream_test` can assert the recovery
/// never held the file whole.
class _CountingFs implements JournalFileSystem {
  _CountingFs(this._inner);

  final JournalFileSystem _inner;
  int wholeFileReads = 0;
  final List<int> rangeSizes = <int>[];

  @override
  Future<void> ensureDirectory(String p) => _inner.ensureDirectory(p);
  @override
  Future<bool> exists(String p) => _inner.exists(p);
  @override
  Future<int> lengthOf(String p) => _inner.lengthOf(p);
  @override
  Future<Uint8List> readBytes(String p) {
    if (p.endsWith(RetainedAudioJournal.pcmSuffix)) wholeFileReads += 1;
    return _inner.readBytes(p);
  }

  @override
  Future<Uint8List> readRange(String p, int s, int e) {
    rangeSizes.add(e - s);
    return _inner.readRange(p, s, e);
  }

  @override
  Future<void> writeBytes(String p, Uint8List b, {bool flush = true}) =>
      _inner.writeBytes(p, b, flush: flush);
  @override
  Future<JournalFileHandle> openAppend(String p) => _inner.openAppend(p);
  @override
  Future<void> rename(String f, String t) => _inner.rename(f, t);
  @override
  Future<void> deleteFile(String p) => _inner.deleteFile(p);
  @override
  Future<List<String>> listNames(String d) => _inner.listNames(d);
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill, this.fs);

  /// [withController] builds the real `ChatController`, which is WHAT TURNS
  /// FINALS INTO ROWS - the settle path's third condition is unreachable
  /// without it. When it is there, the rig tests the CONTROLLER'S OWN runner
  /// and builds no second one.
  ///
  /// 🔴 WHY THERE MAY ONLY EVER BE ONE RUNNER, measured rather than reasoned
  /// about: the first version built its own alongside the controller's. The
  /// controller's edge-2 sweep (a recording ending - which our own recovery
  /// produces) then ran a SECOND pass over the same journals with different
  /// options and stamped its verdict over ours: 'Expected: settled_unverified /
  /// Actual: awaiting_server_capability', on a test about neither. Production
  /// has exactly one runner; a rig with two is not a harder version of
  /// production, it is a different program.
  static Future<_Rig> open({
    List<String> capabilities = const <String>[],
    bool withController = true,
    RecoveryTimeouts timeouts = const RecoveryTimeouts(),
    // A seam for the ONE case that needs to act during the settle's own two
    // reads of persistent storage - see `_DeletesRecordingOnReadBack`.
    TimelinePersistence? persistence,
  }) async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-rc1a-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _CountingFs fs = _CountingFs(const IoJournalFileSystem());
    final _Rig r = _Rig._(
      tmp,
      store,
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        journalFs: fs,
      ),
      fs,
    );
    r._build(capabilities, withController, timeouts, persistence);
    // Drain the connected-edge sweep before anything is on disk.
    while (r.runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  final _CountingFs fs;

  late final _EchoingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  ChatController? controller;
  late final BackfillRunner runner;

  void _build(
    List<String> capabilities,
    bool withController,
    RecoveryTimeouts timeouts,
    TimelinePersistence? persistence,
  ) {
    transport = _EchoingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': capabilities});
    timeline = newTestStore(persistence: persistence);
    if (withController) {
      controller = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: timeline,
        destination: DestinationController(fixedRecordOnly: true),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
      );
      runner = controller!.backfill;
    } else {
      runner = BackfillRunner(
        session: session,
        store: timeline,
        recoveryTimeouts: timeouts,
        sleep: (Duration _) async {},
      );
    }
    transport.pushStatus(SocketStatus.connected);
  }

  /// Write one journal onto the real temp directory, the way capture would.
  Future<String> writeJournal({
    required String id,
    required int bytes,
    Map<String, Object?> configSnapshot = const <String, Object?>{
      kConfigSnapshotMode: 'realtime',
      kConfigSnapshotSourceLang: 'zh',
      kConfigSnapshotPrefsDigest: '',
    },
    AudioJournalFormat format = AudioJournalFormat.current,
    bool cancelled = false,
  }) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      format: format,
      configSnapshot: configSnapshot,
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    if (cancelled) j.markCancelled();
    await j.close();
    return id;
  }

  List<Map<String, Object?>> get recoveryStarts => transport.starts
      .where((Map<String, Object?> s) => s['recording_id'] != null)
      .toList();

  Future<RecordingManifest?> manifestOf(String id) async {
    final List<RecordingScan> scans =
        await RetainedAudioJournalScan.scan(dirPath: tmp.path);
    for (final RecordingScan s in scans) {
      if (s.recordingId == id) return s.manifest;
    }
    return null;
  }

  Future<void> dispose() async {
    // 🔴 LET THE EDGE-TRIGGERED SWEEPS FINISH FIRST. The controller's two
    // production edges fire unawaited sweeps; disposing under one of them
    // throws 'a ValueNotifier was used after being disposed' from inside the
    // PRODUCT, reported against whichever test happened to be finishing.
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await controller?.dispose();
    if (controller == null) runner.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
      await removeTempDir(tmp);
  }
}

void main() {
  // ───────────────────────────────────────────────── identity (A6-1, A3-2a)

  group('same_mode_retranscribe_test / variant_change_new_version_test', () {
    const RecoverySampleRange r = RecoverySampleRange(0, 16000);
    const RecoveryResultVariant zh = RecoveryResultVariant(
        mode: 'realtime', sourceLang: 'zh', prefsDigest: '');

    test('two attempts at the same thing share a job and differ by attempt',
        () {
      final RecoveryIdentity a = RecoveryIdentity.forAttempt(
        recordingId: 'rec-1',
        range: r,
        variant: zh,
        attemptId: 'a1',
        operationId: 'o1',
        attemptKind: RecoveryAttemptKind.autoRetry,
        audioFormatVersion: 1,
      );
      final RecoveryIdentity b = RecoveryIdentity.forAttempt(
        recordingId: 'rec-1',
        range: r,
        variant: zh,
        attemptId: 'a2',
        operationId: 'o2',
        attemptKind: RecoveryAttemptKind.userRetranscribe,
        audioFormatVersion: 1,
      );
      // 🔴 A6-1: a same-mode re-transcription must produce a NEW VERSION, not
      // be swallowed as a duplicate. Same job, different attempt is exactly
      // that shape.
      expect(b.jobId, a.jobId);
      expect(b.attemptId, isNot(a.attemptId));
      expect(a.toStartFields()['attempt_kind'], 'auto_retry');
      expect(b.toStartFields()['attempt_kind'], 'user_retranscribe');
    });

    test('a different variant is a different job', () {
      String job(RecoveryResultVariant v) =>
          deriveJobId(recordingId: 'rec-1', range: r, variant: v);
      expect(
          job(const RecoveryResultVariant(
              mode: 'realtime', sourceLang: 'en', prefsDigest: '')),
          isNot(job(zh)));
      expect(
          job(const RecoveryResultVariant(
              mode: 'translate', sourceLang: 'zh', prefsDigest: '')),
          isNot(job(zh)));
      expect(
          job(const RecoveryResultVariant(
              mode: 'realtime', sourceLang: 'zh', prefsDigest: 'x')),
          isNot(job(zh)));
      // A different RANGE is a different job too, and stability across two
      // computations is what makes the whole scheme survive a restart.
      expect(
          deriveJobId(
              recordingId: 'rec-1',
              range: const RecoverySampleRange(0, 16001),
              variant: zh),
          isNot(job(zh)));
      expect(deriveJobId(recordingId: 'rec-1', range: r, variant: zh), job(zh));
    });

    test('the prefs digest ignores key order', () {
      expect(digestPrefs(<String, Object?>{'a': 1, 'b': 2}),
          digestPrefs(<String, Object?>{'b': 2, 'a': 1}));
      expect(digestPrefs(<String, Object?>{'a': 1}),
          isNot(digestPrefs(<String, Object?>{'a': 2})));
    });
  });

  group('range_boundary_continuity_test / sub_chunk_residual_test', () {
    test('adjacent half-open ranges touch and never overlap', () {
      const RecoverySampleRange a = RecoverySampleRange(0, 3200);
      const RecoverySampleRange b = RecoverySampleRange(3200, 4800);
      expect(a.joinsTo(b), isTrue);
      expect(a.overlaps(b), isFalse);
      expect(a.overlaps(const RecoverySampleRange(3199, 4000)), isTrue);
      expect(a.lengthSamples + b.lengthSamples, 4800);
    });

    test('a sub-200ms residual is measured in samples, not in 6400-byte frames',
        () {
      // 3200 bytes = 100 ms = 1600 samples. It is NOT a multiple of the 6400
      // transport frame, and A3-2a forbids deriving the coordinate from that.
      final RecoverySampleRange r = RecoverySampleRange.fromBytes(
          const JournalByteRange(0, 3200), AudioJournalFormat.current);
      expect(r.endSample, 1600);
      expect(3200 % 6400, isNot(0));
    });

    test('an odd byte offset is refused as a coordinate, not rounded', () {
      expect(
          () => RecoverySampleRange.fromBytes(
              const JournalByteRange(0, 3201), AudioJournalFormat.current),
          throwsArgumentError);
    });
  });

  // ───────────────────────────────────────────────── the settle predicate

  group('no_receipt_no_delete_test', () {
    test('no receipt at all keeps the bytes', () {
      final RecoverySettleDecision d = evaluateRecoverySettle(inputs());
      expect(d.mayDeleteBytes, isFalse);
      expect(d.settledUnverified, isTrue);
      expect(d.refusals, contains(RecoverySettleRefusal.noReceipt));
    });

    test('a receipt version this build does not know is NOT a weaker proof',
        () {
      final RecoverySettleDecision d = evaluateRecoverySettle(inputs(
          r: receipt(
              version: 99, fedFrames: 10, attemptId: 'a1', start: 0, end: 32000)));
      expect(d.mayDeleteBytes, isFalse);
      expect(d.refusals, contains(RecoverySettleRefusal.receiptVersionUnknown));
    });

    test('gaps or drops keep the bytes', () {
      expect(
          evaluateRecoverySettle(inputs(
                  r: receipt(
                      fedFrames: 10,
                      seqGaps: 1,
                      attemptId: 'a1',
                      start: 0,
                      end: 32000)))
              .refusals,
          contains(RecoverySettleRefusal.gapsOrDrops));
      expect(
          evaluateRecoverySettle(inputs(
                  r: receipt(
                      fedFrames: 10,
                      drops: 2,
                      attemptId: 'a1',
                      start: 0,
                      end: 32000)))
              .refusals,
          contains(RecoverySettleRefusal.gapsOrDrops));
    });

    test('an abnormal end keeps the bytes, from either side', () {
      expect(
          evaluateRecoverySettle(
                  inputs(r: goodReceipt(), endedOnTerminalFinal: false))
              .refusals,
          contains(RecoverySettleRefusal.notEndedNormally));
      expect(
          evaluateRecoverySettle(inputs(
                  r: receipt(
                      fedFrames: 10,
                      endedNormally: false,
                      attemptId: 'a1',
                      start: 0,
                      end: 32000)))
              .refusals,
          contains(RecoverySettleRefusal.notEndedNormally));
    });

    test('an old server (tier B) recovers and still deletes nothing', () {
      final RecoverySettleDecision d =
          evaluateRecoverySettle(inputs(r: goodReceipt(), serverMayDelete: false));
      expect(d.mayDeleteBytes, isFalse);
      expect(d.refusals, contains(RecoverySettleRefusal.serverTierKeepsBytes));
    });

    test('all three conditions together are what license a delete', () {
      final RecoverySettleDecision d =
          evaluateRecoverySettle(inputs(r: goodReceipt()));
      expect(d.mayDeleteBytes, isTrue);
      expect(d.reasonCode, 'settled');
    });

    test('every miss is reported, not just the first', () {
      final RecoverySettleDecision d = evaluateRecoverySettle(inputs(
          r: null, endedOnTerminalFinal: false, rowPersisted: false));
      expect(d.refusals.length, 3);
    });
  });

  group('frame_count_not_completeness_test', () {
    test('a matching frame count over a DIFFERENT range proves nothing', () {
      // Same count, wrong stretch: A7-1 says a count cannot prove content, and
      // this is the shape that makes that concrete.
      final RecoverySettleDecision d = evaluateRecoverySettle(inputs(
          r: receipt(fedFrames: 10, attemptId: 'a1', start: 32000, end: 64000)));
      expect(d.mayDeleteBytes, isFalse);
      expect(d.refusals, contains(RecoverySettleRefusal.receiptMismatch));
    });

    test('a receipt that echoes nothing is not agreement', () {
      final RecoverySettleDecision d =
          evaluateRecoverySettle(inputs(r: receipt(fedFrames: 10)));
      expect(d.refusals, contains(RecoverySettleRefusal.receiptMismatch));
    });

    test('a frame count that differs from what we sent is refused', () {
      final RecoverySettleDecision d = evaluateRecoverySettle(inputs(
          r: receipt(fedFrames: 9, attemptId: 'a1', start: 0, end: 32000)));
      expect(d.refusals, contains(RecoverySettleRefusal.frameCountMismatch));
    });
  });

  group('settle_requires_persisted_commit_test', () {
    test('a row that is not in persistent storage keeps the bytes', () {
      final RecoverySettleDecision d =
          evaluateRecoverySettle(inputs(r: goodReceipt(), rowPersisted: false));
      expect(d.mayDeleteBytes, isFalse);
      expect(d.refusals, contains(RecoverySettleRefusal.rowNotPersisted));
    });

    test('awaitPersisted completes, and only the READ says it is there',
        () async {
      final _ThrowingPersistence p = _ThrowingPersistence();
      final TimelineStore store = newTestStore(persistence: p);
      addTearDown(store.dispose);
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'u-1',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'a row whose write fails',
      );
      // 🔴 The handle completes even though the write FAILED - that is why the
      // ruling names two facts and the predicate takes one boolean built from
      // both.
      await store.awaitPersisted(e.id);
      expect(await store.isPersisted(e.id), isFalse);
      expect(store.entries.any((TimelineEntry x) => x.id == e.id), isTrue,
          reason: 'the in-memory row is deliberately kept (E48)');
    });

    test('a row that really landed reads back', () async {
      final TimelineStore store = newTestStore();
      addTearDown(store.dispose);
      final TimelineEntry e = store.buildFromUtterance(
        clientId: 'u-2',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: 'a row that lands',
      );
      await store.awaitPersisted(e.id);
      expect(await store.isPersisted(e.id), isTrue);
    });
  });

  // ───────────────────────────────────────────────── backoff and the budget

  group('auto_retry_vs_user_retranscribe_test', () {
    test('the series is 1,2,4,8,16 then capped at 30 minutes', () {
      expect(recoveryBackoffFor(0), Duration.zero);
      expect(recoveryBackoffFor(1), const Duration(minutes: 1));
      expect(recoveryBackoffFor(2), const Duration(minutes: 2));
      expect(recoveryBackoffFor(4), const Duration(minutes: 8));
      expect(recoveryBackoffFor(5), const Duration(minutes: 16));
      expect(recoveryBackoffFor(6), kRecoveryBackoffCap);
      // A count large enough to overflow a naive shift must not come back as
      // "retry immediately".
      expect(recoveryBackoffFor(9999), kRecoveryBackoffCap);
    });

    test('only FAILED auto attempts spend the budget', () {
      JournalAttempt a(String kind, String? outcome) => JournalAttempt(
            attemptId: 'x',
            startedAtMs: 0,
            kind: kind,
            outcome: outcome,
          );
      final RecordingManifest m = RecordingManifest(
        recordingId: 'r',
        attempts: <JournalAttempt>[
          a('auto_retry', JournalAttempt.outcomeFailed),
          a('auto_retry', JournalAttempt.outcomeFailed),
          a('user_retranscribe', JournalAttempt.outcomeFailed),
          a('auto_retry', JournalAttempt.outcomeSettledUnverified),
          a('auto_retry', null),
        ],
      );
      expect(RecoveryJobStatus.fromManifest(m).failedAutoAttempts, 2);
    });

    test('five failures ends the automatic route and only that', () {
      const RecoveryJobStatus s = RecoveryJobStatus(
          state: RecoveryQueueState.pending,
          failedAutoAttempts: 5,
          nextEligibleAtMs: null);
      expect(s.budgetExhausted, isTrue);
      expect(s.mayAutoAttemptAt(0), isFalse);
      expect(s.stateAfterAutoFailure(), RecoveryQueueState.needsManual);
    });

    test('a job that is due waits, and a job past its wait does not', () {
      const RecoveryJobStatus s = RecoveryJobStatus(
          state: RecoveryQueueState.pending,
          failedAutoAttempts: 1,
          nextEligibleAtMs: 1000);
      expect(s.mayAutoAttemptAt(999), isFalse);
      expect(s.mayAutoAttemptAt(1000), isTrue);
      expect(s.nextEligibleAfterFailure(1000),
          1000 + const Duration(minutes: 2).inMilliseconds);
    });

    test('settled_unverified is never picked up again automatically', () {
      const RecoveryJobStatus s = RecoveryJobStatus(
          state: RecoveryQueueState.settledUnverified,
          failedAutoAttempts: 0,
          nextEligibleAtMs: null);
      expect(s.mayAutoAttemptAt(0), isFalse);
    });

    test('the queue state survives a manifest round trip', () {
      const RecordingManifest m = RecordingManifest(
        recordingId: 'r',
        recoveryState: RecoveryQueueState.awaitingServerCapability,
        nextEligibleAtMs: 4242,
      );
      final RecordingManifest back = RecordingManifest.decode(m.encode());
      expect(back.recoveryState, RecoveryQueueState.awaitingServerCapability);
      expect(back.nextEligibleAtMs, 4242);
      // An older manifest, written before these fields existed, must decode to
      // the RETRYING direction rather than to "forget it".
      expect(
          RecordingManifest.decode(
                  '{"recordingId":"r","formatVersion":1,"format":{},'
                  '"committedClaimBytes":0}')
              .recoveryState,
          RecoveryQueueState.pending);
    });
  });

  // ───────────────────────────────────────────────── the gate (A7-3, O-10)

  group('capability_missing_fail_closed_test (unit half)', () {
    ServerCapabilities caps(List<String> bits) =>
        parseServerCapabilities(<String, Object?>{'capabilities': bits});

    test('tier A needs both bits, and idempotency only when metered', () {
      final ServerCapabilities two = caps(<String>[
        kCapabilityCoverageReceipt,
        kCapabilityDeliveryNoneSafe,
      ]);
      expect(evaluateRecoveryGate(caps: two, metered: false).tier,
          RecoveryTier.full);
      expect(evaluateRecoveryGate(caps: two, metered: true).tier,
          RecoveryTier.awaitingServerCapability);
      expect(
          evaluateRecoveryGate(
                  caps: caps(<String>[
                    kCapabilityCoverageReceipt,
                    kCapabilityDeliveryNoneSafe,
                    kCapabilityIdempotentOperation,
                  ]),
                  metered: true)
              .tier,
          RecoveryTier.full);
    });

    test('nobody has answered yet: UNDETERMINED, not tier C', () {
      // 🔴 THE DEFECT THIS PINS (drill D-2, 2026-09-06). This case used to
      // require `awaitingServerCapability`, i.e. it required the gate to turn
      // "we have not asked anybody" into a verdict about a server - and the
      // sweep really did fire 1.3 s before the ack, so the phone rendered
      // "This server version cannot recover audio safely" against a server
      // advertising all three bits.
      final RecoveryGateVerdict v = evaluateRecoveryGate(
          caps: const ServerCapabilities.unknown(), metered: false);
      expect(v.tier, RecoveryTier.undetermined);
      expect(v.tier.mayStart, isFalse);
      expect(v.tier.mayDeleteBytes, isFalse);
      expect(v.tier.isVerdict, isFalse,
          reason: 'nothing may be persisted or rendered from this');
      expect(v.capabilitiesKnown, isFalse);
      expect(v.ackSeen, isFalse);
    });

    test('an ack with no capabilities key IS tier C', () {
      // The other half, and the reason the two states cannot be merged: a
      // server that answered without the key has spoken, and A7-3 C is a
      // verdict about it. Same refusal as the case above, different meaning,
      // different sentence, and only this one is persisted.
      final RecoveryGateVerdict v = evaluateRecoveryGate(
          caps: const ServerCapabilities.ackWithoutCapabilities(),
          metered: false);
      expect(v.tier, RecoveryTier.awaitingServerCapability);
      expect(v.tier.isVerdict, isTrue);
      expect(v.capabilitiesKnown, isFalse);
      expect(v.ackSeen, isTrue);
    });

    test('an empty capability list is a STATEMENT, and still refused', () {
      final RecoveryGateVerdict v =
          evaluateRecoveryGate(caps: caps(<String>[]), metered: false);
      expect(v.tier, RecoveryTier.awaitingServerCapability);
      // The refusal is the same; the diagnostic is not, and that is the point.
      expect(v.capabilitiesKnown, isTrue);
    });

    test('tier B recovers and may never delete', () {
      final RecoveryGateVerdict v = evaluateRecoveryGate(
        caps: caps(<String>[]),
        metered: false,
        verifier: const _AlwaysSafeLegacyVerifier(),
      );
      expect(v.tier, RecoveryTier.recoverKeepBytes);
      expect(v.tier.mayStart, isTrue);
      expect(v.tier.mayDeleteBytes, isFalse);
    });

    test('the production verifier answers false to everything', () {
      expect(
          const DenyAllLegacyServerVerifier()
              .isVerifiedSafeLegacy(caps(<String>['anything'])),
          isFalse);
    });
  });

  // ───────────────────────────────────── replay ownership (P1-2)

  group('replay_ownership_no_overlap_test / replay_without_server_session_test',
      () {
    ReplayRefusal? gate({
      bool on = true,
      ReplayOwnership? own,
      bool recording = false,
      int? watermark = 5,
    }) =>
        replayRefusalFor(
          journalFaceOn: on,
          ownership: own ?? ReplayOwnership(),
          recorderRunning: recording,
          serverAudioWatermark: watermark,
        );

    test('with the journal face OFF nothing is ever refused', () {
      final ReplayOwnership own = ReplayOwnership()..claim('rec-1');
      expect(gate(on: false, own: own, watermark: null), isNull);
    });

    test('a claimed recording stops the ring replay', () {
      final ReplayOwnership own = ReplayOwnership()..claim('rec-1');
      expect(gate(own: own), ReplayRefusal.claimedByRecovery);
      own.release('rec-1');
      expect(gate(own: own), isNull);
      expect(own.anyClaimed, isFalse);
    });

    test('a LIVE recording still replays - that is what the ring is for', () {
      final ReplayOwnership own = ReplayOwnership()..claim('rec-1');
      expect(gate(own: own, recording: true), isNull);
    });

    test('no watermark on the ack means no session to replay into', () {
      expect(gate(watermark: null), ReplayRefusal.noServerSession);
      // -1 IS a statement ("I have observed nothing yet") and passes.
      expect(gate(watermark: -1), isNull);
    });
  });

  // ───────────────────────────────────── the leg, end to end on a fake wire

  group('a delete that lands inside the settle read-back', () {
    test('🔴 the leg does not resurrect a recording deleted mid-settle',
        () async {
      final _DeletesRecordingOnReadBack persistence =
          _DeletesRecordingOnReadBack();
      final _Rig rig =
          await _Rig.open(capabilities: tierACaps, persistence: persistence);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-mid', bytes: 6400 * 3);
      // Armed only now: the rig owns the temp directory, and arming earlier
      // would have it deleting files during the rig's own start-up sweep.
      persistence.base = '${rig.tmp.path}${Platform.pathSeparator}rec-mid';

      await rig.runner.sweep(sourceLang: 'zh');

      // ⚠️ NOT a positive control on its own - `loadAll` is also called at
      // store start-up, before `base` is armed. What proves the delete landed
      // inside the settle is the manifest below being absent AFTER an attempt
      // that ran to a verdict, which the failure branch would have rewritten.
      expect(persistence.reads, greaterThan(0));
      expect(rig.recoveryStarts, hasLength(1),
          reason: 'positive control: the attempt really ran');
      expect(
          File('${rig.tmp.path}${Platform.pathSeparator}'
                  'rec-mid${RetainedAudioJournal.manifestSuffix}')
              .existsSync(),
          isFalse,
          reason: 'a manifest written back after the delete makes the '
              'recording reappear with its claim ahead of an absent file, and '
              'the delete looks as if it had silently failed');
    });
  });

  group('empty_result_keeps_the_bytes_test (drill B-1 run 2)', () {
    test('the recovery leg refuses to settle an empty result', () async {
      // 🔴 B-1'S OWN PREMISE IS A DEAD ENGINE, and under it every
      // recording used to be destroyed the moment the provider answered with
      // nothing: MEASURED 2026-09-06, 1,305,600 bytes deleted, manifest
      // `settled:true`, `outcome:"settled"`, a resultRef minted. The receipt was
      // complete and the session ended normally - which is precisely why no
      // other condition catches this.
      final _Rig rig = await _Rig.open(capabilities: tierACaps);
      addTearDown(rig.dispose);
      rig.transport.finalText = '';
      await rig.writeJournal(id: 'rec-empty', bytes: 6400 * 3);

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, hasLength(1),
          reason: 'positive control: the attempt really ran');
      expect(
          File('${rig.tmp.path}${Platform.pathSeparator}rec-empty.pcm')
              .lengthSync(),
          6400 * 3,
          reason: 'A5-4: not one byte goes on an empty result');
      final RecordingManifest m = (await rig.manifestOf('rec-empty'))!;
      expect(m.settled, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      expect(m.attempts.last.failureCode, 'emptyResult',
          reason: 'the only refusal, so the screen can say which one');
    });
  });

  group('capability_undetermined_test (drill D-2)', () {
    test('no ack yet: nothing starts, and nothing is written to disk',
        () async {
      // The whole defect in one case. The sweep used to run 1.3 s before the
      // ack that carries `capabilities`, read tier C out of "nobody has
      // answered", and PERSIST it - after which the pending screen said "This
      // server version cannot recover audio safely" about a server advertising
      // all three bits, and never re-asked.
      final _Rig rig = await _Rig.open(withController: false);
      addTearDown(rig.dispose);
      // No ack at all on this connection: the rig's default passes a
      // capabilities key, so it is cleared here to reproduce the real state.
      rig.session.reconnect.noteServerCapabilities(null);
      await rig.writeJournal(id: 'rec-u', bytes: kPcmBytesPerSecondLocal);

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, isEmpty);
      final RecordingManifest m = (await rig.manifestOf('rec-u'))!;
      expect(m.recoveryState, RecoveryQueueState.pending,
          reason: '🔴 NOT awaiting_server_capability: that is a verdict '
              'about a server, and no server has spoken');
      expect(rig.runner.progress.value.serverTier, RecoveryTier.undetermined);
      expect(rig.runner.progress.value.hasKeptAudio, isTrue,
          reason: 'the audio is still owed a transcription - the banner may '
              'not go quiet just because the verdict is not in');
    });

    test('a stale tier-C state is re-judged once a server answers', () async {
      final _Rig rig = await _Rig.open(withController: false);
      addTearDown(rig.dispose);
      rig.session.reconnect.noteServerCapabilities(null);
      await rig.writeJournal(id: 'rec-r', bytes: 6400 * 3);
      // What an earlier build wrote onto every recording it found.
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
          dirPath: rig.tmp.path,
          recordingId: 'rec-r',
          commitInterval: const Duration(days: 1));
      j.setRecoveryState(RecoveryQueueState.awaitingServerCapability);
      await j.close();
      expect((await rig.manifestOf('rec-r'))!.recoveryState,
          RecoveryQueueState.awaitingServerCapability,
          reason: 'positive control: the stale verdict is really on disk');

      rig.session.reconnect.noteServerCapabilities(
          <String, Object?>{'capabilities': tierACaps});
      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, hasLength(1),
          reason: 'the recording is owed an attempt again');
      expect((await rig.manifestOf('rec-r'))!.recoveryState,
          isNot(RecoveryQueueState.awaitingServerCapability),
          reason: 'nothing else in the product ever clears it, so the screen '
              'would keep the old sentence for the life of the recording');
    });
  });

  group('capability_missing_fail_closed_test (the wire half)', () {
    test('tier C sends zero audio:start, deletes nothing, and says so on disk',
        () async {
      final _Rig rig = await _Rig.open(withController: false);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-c', bytes: kPcmBytesPerSecondLocal);

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, isEmpty,
          reason: 'not one audio:start may leave on an unknown server');
      expect(rig.transport.chunkFrames, 0);
      expect(File('${rig.tmp.path}${Platform.pathSeparator}rec-c.pcm')
          .lengthSync(), kPcmBytesPerSecondLocal,
          reason: 'zero deletes');
      final RecordingManifest? m = await rig.manifestOf('rec-c');
      expect(m!.recoveryState, RecoveryQueueState.awaitingServerCapability);
      expect(m.settled, isFalse);
      expect(rig.runner.progress.value.serverTier,
          RecoveryTier.awaitingServerCapability);
    });
  });

  group('the leg on a tier-A server', () {
    Future<_Rig> tierA({bool withController = true}) =>
        _Rig.open(capabilities: tierACaps, withController: withController);

    test('a recovery carries all four identifiers and delivery stays none',
        () async {
      final _Rig rig = await tierA();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-a', bytes: 6400 * 3);

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, hasLength(1));
      final Map<String, Object?> s = rig.recoveryStarts.single;
      expect(s['recording_id'], 'rec-a');
      expect(s['job_id'], isA<String>());
      expect(s['attempt_id'], isA<String>());
      expect(s['operation_id'], isA<String>());
      expect(s['attempt_kind'], 'auto_retry');
      expect(s['range_start_sample'], 0);
      expect(s['range_end_sample'], 6400 * 3 ~/ 2);
      expect(s['audio_format_version'], 1);
      // 🔴 The red line: recovered audio has nowhere to be delivered.
      expect(s['delivery'], 'none');
      // R-5: the language came off the manifest snapshot, not from the sweep's
      // fallback.
      expect(s['source_lang'], 'zh');
    });

    test('a complete proof settles: resultRef, settled, and the bytes go',
        () async {
      final _Rig rig = await tierA();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-ok', bytes: 6400 * 2);

      await rig.runner.sweep(sourceLang: 'zh');

      final RecordingManifest m = (await rig.manifestOf('rec-ok'))!;
      expect(m.settled, isTrue, reason: 'the three conditions held');
      expect(m.resultRef, isNotNull);
      expect(m.recoveryState, RecoveryQueueState.settled);
      expect(m.attempts.single.outcome, JournalAttempt.outcomeSettled);
      // 🔴 CARD FX-4 TURNED THIS ASSERTION AROUND, AND THE OLD REASON IS WORTH
      // KEEPING BECAUSE IT WAS ONLY HALF WRONG. It read: 「the leg never
      // deletes - `markSettledForCleanup` is the licence, the TTL sweep is the
      // only executioner (A5-1); a leg that unlinked the file here would
      // delete on its own judgement, one layer away from the policy」. The
      // policy point stands and is unchanged: the licence still comes from
      // `evaluateRecoverySettle`, and this leg still unlinks nothing the
      // predicate did not clear. What was wrong is WHEN. Owner ruling O-1 is
      // 「success ⇒ delete」, the LIVE path has always deleted inline right
      // after its own commit, and this leg's wait left the two halves of one
      // product answering differently - MEASURED on device (drill DF-2 (c)):
      // 243,200 B and 248,320 B still on disk after `settled:true`, surviving
      // a relaunch. The sweep is still the backstop for a crash between the
      // commit and the unlink.
      expect(File('${rig.tmp.path}${Platform.pathSeparator}rec-ok.pcm')
          .existsSync(), isFalse);
      // ...and the manifest stays: it is the record of where the words went.
      expect(
        File('${rig.tmp.path}${Platform.pathSeparator}rec-ok'
                '${RetainedAudioJournal.manifestSuffix}')
            .existsSync(),
        isTrue,
      );
    });

    test('a wrong frame count settles UNVERIFIED and never marks for cleanup',
        () async {
      final _Rig rig = await tierA();
      addTearDown(rig.dispose);
      rig.transport.overrideFedFrames = 1; // the server saw fewer than we sent
      await rig.writeJournal(id: 'rec-short', bytes: 6400 * 4);

      await rig.runner.sweep(sourceLang: 'zh');

      final RecordingManifest m = (await rig.manifestOf('rec-short'))!;
      expect(m.settled, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
      expect(m.attempts.single.outcome,
          JournalAttempt.outcomeSettledUnverified);
      expect(m.attempts.single.failureCode, contains('frameCountMismatch'));
    });

    test('cancelled and format-mismatched recordings are never fed back',
        () async {
      final _Rig rig = await tierA(withController: false);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-cancel', bytes: 6400, cancelled: true);
      await rig.writeJournal(
        id: 'rec-fmt',
        bytes: 6400,
        format: const AudioJournalFormat(sampleRate: 48000),
      );

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.recoveryStarts, isEmpty);
      for (final String id in <String>['rec-cancel', 'rec-fmt']) {
        expect(File('${rig.tmp.path}${Platform.pathSeparator}$id.pcm')
            .existsSync(), isTrue,
            reason: 'format_mismatch_refuse_test / O-5: keep the bytes');
        expect((await rig.manifestOf(id))!.settled, isFalse);
      }
    });

    test('long_recording_stream_test: bounded blocks, never the whole file',
        () async {
      final _Rig rig = await tierA(withController: false);
      addTearDown(rig.dispose);
      // 8x the read block, so a whole-file read and a bounded one cannot be
      // confused with each other.
      const int bytes = kRecoveryReadBlockBytes * 8;
      await rig.writeJournal(id: 'rec-long', bytes: bytes);
      rig.fs.rangeSizes.clear();
      rig.fs.wholeFileReads = 0;

      await rig.runner.sweep(sourceLang: 'zh');

      expect(rig.fs.wholeFileReads, 0,
          reason: 'a 30-minute recording must never be held whole');
      expect(rig.fs.rangeSizes, hasLength(8));
      for (final int n in rig.fs.rangeSizes) {
        expect(n, lessThanOrEqualTo(kRecoveryReadBlockBytes));
      }
      expect(rig.transport.chunkFrames, bytes ~/ 6400);
    });

    test('the four timeouts are four separate parameters, and the total budget '
        'grows with the audio', () {
      const RecoveryTimeouts t = RecoveryTimeouts();
      expect(<Duration>{
        t.uploadProgress,
        t.engineProgress,
        t.noProgress,
      }, hasLength(3), reason: 'three distinct clocks, not one reused');
      expect(t.totalBudgetFor(Duration.zero), t.totalBudgetBase);
      expect(t.totalBudgetFor(const Duration(minutes: 30)),
          greaterThan(t.totalBudgetFor(const Duration(minutes: 1))));
    });

    test('an engine that never answers fails the attempt and backs off, '
        'keeping every byte', () async {
      // No controller: this test needs no rows (a silent engine mints none),
      // and one runner is the rule the rig's doc explains.
      final _Rig rig = await _Rig.open(
        capabilities: tierACaps,
        withController: false,
        timeouts: const RecoveryTimeouts(
          uploadProgress: Duration(milliseconds: 200),
          engineProgress: Duration(milliseconds: 200),
          noProgress: Duration(milliseconds: 200),
          totalBudgetBase: Duration(milliseconds: 400),
          totalBudgetPerAudioMinute: Duration.zero,
        ),
      );
      addTearDown(rig.dispose);
      rig.transport.replyOnStop = false; // silence
      await rig.writeJournal(id: 'rec-silent', bytes: 6400);

      await rig.runner.sweep(sourceLang: 'zh');

      final RecordingManifest m = (await rig.manifestOf('rec-silent'))!;
      expect(m.settled, isFalse);
      expect(m.attempts.single.outcome, JournalAttempt.outcomeFailed);
      expect(m.recoveryState, RecoveryQueueState.pending);
      expect(m.nextEligibleAtMs, isNotNull,
          reason: 'a failure schedules the next attempt, it does not spin');
      expect(File('${rig.tmp.path}${Platform.pathSeparator}rec-silent.pcm')
          .lengthSync(), 6400);
    });
  });
}

/// Tier B's counterfactual. It exists so the branch is exercised; nothing in
/// `lib/` answers true (see [DenyAllLegacyServerVerifier]).
class _AlwaysSafeLegacyVerifier extends LegacyServerVerifier {
  const _AlwaysSafeLegacyVerifier();

  @override
  bool isVerifiedSafeLegacy(ServerCapabilities caps) => true;
}

class _ThrowingPersistence extends InMemoryTimelinePersistence {
  @override
  Future<void> upsert(TimelineEntry entry) async =>
      throw StateError('disk is gone');
}
