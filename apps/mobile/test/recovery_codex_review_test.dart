// Codex review of integ (2026-09-24, `_dispatch/2026-09-24-codex-review-rc1.out.md`)
// items 1, 3 and 6 — each written as the reviewer's suggested test and run on
// the code as it stood BEFORE the fix, so a green here means the claim was
// checked, not assumed. Item 2 lives in `article_restart_retry_test.dart`.
//
//   ① a pacing timeout stops the feed early, the relay then answers the SHORT
//     upload with a receipt that matches what it received, and the settle used
//     to delete the whole range's PCM — including the part never sent;
//   ③ a shortfall retry whose replacement rows did not ALL reach storage used to
//     delete the old rows and the PCM anyway;
//   ⑥ a recovery that comes back in several rows used to place them by the
//     relay's WALL durations, so a faster-than-real-time feed filed a shorter
//     recording than was captured.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/recovery_leg_wire.dart (`_streamRange`)
//   apps/mobile/lib/src/session/recovery_leg_settle.dart (`_finish`)
//   apps/mobile/lib/src/session/recovery_settle.dart (the predicate)

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart' show SessionOwnerProbe;
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/memory_journal_fs.dart';
import 'support/temp_teardown.dart';

const List<String> _tierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];
const int _bytesPerMs = 32;

// ─────────────────────────────────────────────────────────── ① pacing timeout

/// A relay whose engine keeps reporting position 0 (so the pacing gives up),
/// and which then answers the stop with words and a receipt for exactly the
/// frames it RECEIVED — the honest relay the reviewer describes.
class _StuckRelay extends FakeSocketTransport {
  Map<String, Object?>? start;
  int chunks = 0;
  bool reporting = true;

  /// rc2 ① — the engine's reported position (default: stuck at 0), and the
  /// 0-based chunk whose emit throws (the wire drops it mid-block).
  int Function(int chunks) acked = (int _) => 0;
  int? throwOnChunk;
  int _seen = 0;

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk && _seen++ == throwOnChunk) {
      throw StateError('wire dropped this chunk');
    }
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      start = payload;
      _seen = 0;
      chunks = 0;
      unawaited(Future<void>.microtask(() async {
        while (reporting) {
          pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
            'text': '…', 'confidence': 0.5, 'language': 'zh',
            'segment_idx': 0, 'acked_audio_ms': acked(chunks),
          });
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }
      }));
    }
    if (event == FlowMicEvents.audioChunk) chunks += 1;
    if (event == FlowMicEvents.audioStop && start != null) {
      reporting = false;
      final Map<String, Object?> s = start!;
      final int fed = chunks;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': '只转出了开头这一句。', 'confidence': 0.9, 'language': 'zh',
          'segment_idx': 0, 'is_segment': false, 'duration_ms': 5000,
          'coverage_receipt_version': 1, 'fed_frames': fed, 'seq_gaps': 0,
          'drops': 0, 'engine_leg_rollovers': 0, 'ended_normally': true,
          'recording_id': s['recording_id'], 'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

// ───────────────────────────────────────── ③ / ⑥ the A1 article, recovered

const int _prefixMs = 117666;
const int _totalMs = 398480;
const int _owedMs = _totalMs - _prefixMs; // 280,814
const String _u4 = '今天上午我们先开个短会，把库存口径对一下。';
const String _u5 = '珊瑚二号，先在备份上把每一步演练一次。';
const String _partial = '今天上午我们先。';
const String _partA = '下午的发布推迟到四点。';
const String _partB = '灰度先放百分之五，明早看数。';

/// A row write that fails for one text: the E48 shape, for ONE of two rows.
class _FailOne extends InMemoryTimelinePersistence {
  String? failText;

  /// rc2 ⑤ — refuse any write this predicate names.
  bool Function(TimelineEntry e)? failWhen;
  @override
  Future<void> upsert(TimelineEntry entry) async {
    if ((failText != null && entry.displayText == failText) ||
        (failWhen?.call(entry) ?? false)) {
      throw StateError('disk refused this row');
    }
    return super.upsert(entry);
  }
}

class _ArticleRelay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;

  /// The recovery's answer: (text, relay duration ms), last one terminal.
  List<(String, int)> answer = const <(String, int)>[(_partial, 5000)];
  bool endedNormally = false;

  static bool _isRecovery(Map<String, Object?> s) =>
      s['attempt_kind'] == 'auto_retry' || s['attempt_kind'] == 'user_retranscribe';
  bool get _inRecovery => starts.isNotEmpty && _isRecovery(starts.last);
  List<Map<String, Object?>> get recoveryStarts =>
      <Map<String, Object?>>[for (final Map<String, Object?> s in starts) if (_isRecovery(s)) s];

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      chunks += 1;
      if (_inRecovery && chunks % 64 == 0) {
        final int acked = chunks * 200;
        Future<void>.microtask(() => pushIncoming(FlowMicEvents.sttInterim,
            <String, Object?>{'text': '…', 'segment_idx': 0, 'acked_audio_ms': acked}));
      }
      return;
    }
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      chunks = 0;
    }
    if (event == FlowMicEvents.audioStop && starts.isNotEmpty) {
      final Map<String, Object?> s = starts.last;
      final bool recovery = _inRecovery;
      final int fed = chunks;
      final List<(String, int)> a = answer;
      final bool ended = endedNormally;
      Future<void>.delayed(const Duration(milliseconds: 20), () async {
        if (recovery) {
          for (int i = 0; i < a.length - 1; i++) {
            pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
              'text': a[i].$1, 'confidence': 0.9, 'language': 'zh',
              'segment_idx': i, 'is_segment': true, 'duration_ms': a[i].$2,
            });
            await Future<void>.delayed(const Duration(milliseconds: 5));
          }
        }
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': recovery ? a.last.$1 : '',
          'confidence': 0.9, 'language': 'zh',
          'segment_idx': recovery ? a.length - 1 : 2,
          'is_segment': false,
          'duration_ms': recovery ? a.last.$2 : 0,
          'coverage_receipt_version': 1, 'fed_frames': fed, 'seq_gaps': 0,
          'drops': 0, 'engine_leg_rollovers': 0,
          'ended_normally': recovery ? ended : false,
          'recording_id': s['recording_id'], 'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

class _ArticleRig {
  _ArticleRig._(this.tmp, this.store, this.fs, this.spill, this.persistence);

  static Future<_ArticleRig> open() async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-codex-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final MemoryJournalFs fs = MemoryJournalFs();
    final _ArticleRig r = _ArticleRig._(tmp, store, fs,
        RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs),
        _FailOne());
    r._build();
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final MemoryJournalFs fs;
  final RetainedAudioSpill spill;
  final _FailOne persistence;
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  late final _ArticleRelay relay;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;
  String? articleId;

  void _build() {
    relay = _ArticleRelay();
    session = newTestSession(
      transport: relay,
      audio: AudioCapture(recorder: recorder, spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect.noteServerCapabilities(<String, Object?>{'capabilities': _tierA});
    timeline = newTestStore(owner: SessionOwnerProbe(session), persistence: persistence);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: relay),
      localPrefs: InMemoryLocalPrefs(),
    );
    relay.pushStatus(SocketStatus.connected);
  }

  Future<void> _feedMs(int ms) async {
    recorder.feed(makePcm(ms * _bytesPerMs));
    await pumpEventQueue();
  }

  Future<void> _final(String text, int idx, int ms) async {
    relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': idx, 'is_segment': true, 'duration_ms': ms,
    });
    await pumpEventQueue();
  }

  /// The A1 recording (article_backfill_placement_test.dart): two live rows,
  /// the engine gone at 1:57, stop at 6:38.
  Future<void> recordA1AndStop() async {
    articleId = session.beginContinuous(cap: const Duration(minutes: 30), onWarning: () {});
    await controller.pttDown();
    await _feedMs(_prefixMs);
    await _final(_u4, 0, 86315);
    await _final(_u5, 1, 31351);
    relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting', 'provider': 'soniox', 'retry_count': 1,
    });
    await pumpEventQueue();
    await _feedMs(_totalMs - _prefixMs);
    await controller.pttUp();
  }

  Future<void> recoveryDone({int attempts = 1}) async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 60));
    while (DateTime.now().isBefore(deadline)) {
      if (relay.recoveryStarts.length >= attempts && !controller.backfill.isBusy) break;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  Future<RecordingManifest?> manifest() async {
    for (final String p in fs.paths) {
      if (p.endsWith(RetainedAudioJournal.manifestSuffix)) {
        return RecordingManifest.decode(String.fromCharCodes(await fs.readBytes(p)));
      }
    }
    return null;
  }

  bool get pcmPresent => fs.paths.any((String p) => p.endsWith(RetainedAudioJournal.pcmSuffix));

  List<TimelineEntry> get rows => <TimelineEntry>[...articleMembersOf(timeline, articleId!)]
    ..sort((TimelineEntry a, TimelineEntry b) =>
        (a.articleOffsetMs ?? 0).compareTo(b.articleOffsetMs ?? 0));

  Future<void> dispose() async {
    debugCancelAsrHealthTicker(controller);
    await controller.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}

/// Codex ① (both rounds) — a 256 s journal recovered by a paced runner on a
/// virtual clock, with a controller minting the rows. Returns once the sweep
/// is over.
Future<({Directory tmp, TimelineStore timeline})> _pacedRun(
    _StuckRelay relay) async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-codex1-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final RetainedAudioSpill spill =
        RetainedAudioSpill(store: store, retainFromFirstFrame: true);
    final PttSession session = newTestSession(
      transport: relay,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect.noteServerCapabilities(<String, Object?>{'capabilities': _tierA});
    final TimelineStore timeline = newTestStore();
    // The controller is what turns a final into a row (production's inbound
    // route); its own runner is silenced so the paced one below is the only
    // recovery on this session.
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: relay),
      localPrefs: InMemoryLocalPrefs(),
    );
    controller.backfill.dispose();
    final List<int> skew = <int>[0];
    final BackfillRunner runner = BackfillRunner(
      session: session,
      store: timeline,
      recoveryTimeouts: const RecoveryTimeouts(uploadProgress: Duration(seconds: 2)),
      clock: () => DateTime.now().millisecondsSinceEpoch + skew[0],
      sleep: (Duration d) async {
        skew[0] += d.inMilliseconds;
        await Future<void>.delayed(const Duration(milliseconds: 1));
      },
    );
    addTearDown(() async {
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
      while (runner.isBusy && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      relay.reporting = false;
      runner.dispose();
      debugCancelAsrHealthTicker(controller);
      await controller.dispose();
      timeline.dispose();
      await session.dispose();
      await spill.dispose();
      await store.dispose();
      await removeTempDir(tmp);
    });
    relay.pushStatus(SocketStatus.connected);
    while (runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    const int fileBytes = 20 * kRecoveryReadBlockBytes;
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: 'rec-paced',
      configSnapshot: const <String, Object?>{
        kConfigSnapshotMode: 'realtime',
        kConfigSnapshotSourceLang: 'zh',
        kConfigSnapshotPrefsDigest: '',
      },
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(fileBytes));
    await j.close();

    await runner.sweep(sourceLang: 'zh');
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 20));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }

    return (tmp: tmp, timeline: timeline);
}

void main() {
  test(
      'Codex ①: the pacing gives up after part of a 256 s range; the relay '
      'answers that part with a matching receipt ⇒ the PCM stays and the '
      'recording stays owed', () async {
    final _StuckRelay relay = _StuckRelay();
    final (:Directory tmp, :TimelineStore timeline) = await _pacedRun(relay);
    const int fileBytes = 20 * kRecoveryReadBlockBytes; // 256 s

    expect(relay.chunks * kBackfillChunkBytes, lessThan(fileBytes),
        reason: 'positive control: the pacing stopped the feed part-way');
    expect(timeline.entries.map((TimelineEntry e) => e.displayText),
        contains('只转出了开头这一句。'),
        reason: 'positive control: the relay answered the part it received');
    expect(File('${tmp.path}${Platform.pathSeparator}rec-paced.pcm').existsSync(),
        isTrue,
        reason: 'the part never sent has no words anywhere; deleting it loses it');
    final RecordingManifest m = RecordingManifest.decode(
        await File('${tmp.path}${Platform.pathSeparator}rec-paced'
                '${RetainedAudioJournal.manifestSuffix}')
            .readAsString());
    expect(m.settled, isFalse);
    expect(m.recoveryState, RecoveryQueueState.shortfall,
        reason: 'words came back for part of the range: owed again, by the user');
  }, timeout: const Timeout(Duration(seconds: 90)));

  testWidgets(
      'Codex ③: a shortfall retry whose second replacement row does not reach '
      'storage ⇒ the old partial row and the PCM both stay',
      (WidgetTester tester) async {
    late final _ArticleRig r;
    await tester.runAsync(() async {
      r = await _ArticleRig.open();
      await r.recordA1AndStop();
      await r.recoveryDone();
      r.relay
        ..answer = const <(String, int)>[(_partA, 30000), (_partB, 30000)]
        ..endedNormally = true;
      r.persistence.failText = _partB;
      final String id = r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.recoveryDone(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2), reason: 'positive control: retried');
    // ⚠️ 更正（Codex rc2 ③，2026-09-24）：原为 a positive control that _partA
    // (the retry's durable row) stayed on the page. A retry whose rows did not
    // ALL reach storage now withdraws them all, so 「no row」 is true.
    expect(r.rows.map((TimelineEntry e) => e.displayText), isNot(contains(_partA)),
        reason: 'the failed attempt\'s durable row is withdrawn, not left beside the old one');
    expect(r.rows.map((TimelineEntry e) => e.displayText), contains(_partial),
        reason: 'one replacement row is not durable: the old words stay');
    expect(r.pcmPresent, isTrue,
        reason: 'the words of the failed row exist nowhere after a restart');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isFalse);
  });

  testWidgets(
      'Codex ⑥: a recovery that comes back in three rows (relay says 30 s each) '
      'covers the whole owed range and ends where the recording ends',
      (WidgetTester tester) async {
    late final _ArticleRig r;
    await tester.runAsync(() async {
      r = await _ArticleRig.open();
      r.relay
        ..answer = const <(String, int)>[(_partA, 30000), (_partB, 30000), (_partial, 30000)]
        ..endedNormally = true;
      await r.recordA1AndStop();
      await r.recoveryDone();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final List<TimelineEntry> rec = r.rows
        .where((TimelineEntry e) => (e.articleOffsetMs ?? 0) >= _prefixMs)
        .toList();
    expect(rec, hasLength(3), reason: 'positive control: three recovered rows');
    expect(rec.first.articleOffsetMs, _prefixMs);
    final int covered =
        rec.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0));
    expect(covered, _owedMs,
        reason: 'the rows cover the audio that was fed, not 90 s of relay wall time');
    expect(rec.last.articleOffsetMs! + rec.last.durationMs!, _totalMs,
        reason: 'the recovered stretch ends where the recording ends');
  });

  // ─────────────── Codex review, round 2 (`_dispatch/2026-09-24-codex-review-rc2.out.md`)

  test(
      'Codex rc2 ①: the wire drops the SECOND chunk of the LAST block; the relay '
      'answers what it received with a matching receipt ⇒ shortfall, PCM kept',
      () async {
    final _StuckRelay relay = _StuckRelay()
      // An engine that keeps up (5 s behind what was sent), so the feed reaches
      // the last block; that block's second chunk never leaves.
      ..acked = ((int chunks) => (chunks * 200 - 5000).clamp(0, 1 << 30))
      ..throwOnChunk = 19 * (kRecoveryReadBlockBytes ~/ kBackfillChunkBytes) + 1;
    final (:Directory tmp, :TimelineStore timeline) = await _pacedRun(relay);

    expect(relay.chunks, 19 * (kRecoveryReadBlockBytes ~/ kBackfillChunkBytes) + 1,
        reason: 'positive control: 19 whole blocks and one chunk of the last');
    expect(timeline.entries.map((TimelineEntry e) => e.displayText),
        contains('只转出了开头这一句。'),
        reason: 'positive control: the relay answered what it received');
    expect(File('${tmp.path}${Platform.pathSeparator}rec-paced.pcm').existsSync(),
        isTrue,
        reason: 'the rest of the last block was never sent: deleting loses it');
    final RecordingManifest m = RecordingManifest.decode(
        await File('${tmp.path}${Platform.pathSeparator}rec-paced'
                '${RetainedAudioJournal.manifestSuffix}')
            .readAsString());
    expect(m.settled, isFalse);
    expect(m.recoveryState, RecoveryQueueState.shortfall);
  }, timeout: const Timeout(Duration(seconds: 90)));

  testWidgets(
      'Codex rc2 ③: a pending recovery whose second row did not reach storage, '
      'then a retry that succeeds ⇒ each paragraph on disk exactly once',
      (WidgetTester tester) async {
    late final _ArticleRig r;
    await tester.runAsync(() async {
      r = await _ArticleRig.open();
      r.relay
        ..answer = const <(String, int)>[(_partA, 30000), (_partB, 30000)]
        ..endedNormally = true;
      r.persistence.failText = _partB;
      await r.recordA1AndStop();
      await r.recoveryDone();
      r.persistence.failText = null;
      final String id = r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.recoveryDone(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2), reason: 'positive control: retried');
    final List<TimelineEntry> disk = (await tester.runAsync<List<TimelineEntry>>(
        () => articleMembersOnDisk(r.timeline, r.articleId!)))!;
    final List<String> texts = disk.map((TimelineEntry e) => e.displayText).toList();
    expect(texts.where((String s) => s == _partA), hasLength(1),
        reason: 'the first attempt\'s durable row came back beside the retry\'s');
    expect(texts.where((String s) => s == _partB), hasLength(1));
    expect(r.rows.where((TimelineEntry e) => e.displayText == _partB), hasLength(1),
        reason: 'on screen too');
  });

  test(
      'Codex rc2 ④: stretch A failed four times then settled; stretch B\'s '
      'first failure is its first, not its fifth', () {
    JournalAttempt a(String id, String job, String outcome) => JournalAttempt(
          attemptId: id,
          startedAtMs: 0,
          jobId: job,
          kind: RecoveryAttemptKind.autoRetry.wire,
          outcome: outcome,
        );
    // Two stretches: A concluded (done), B still owed.
    const List<OwedRange> ranges = <OwedRange>[
      OwedRange(start: 0, end: 6400, done: OwedRange.doneSettled),
      OwedRange(start: 64000, end: 70400),
    ];
    final RecordingManifest m = RecordingManifest(
      recordingId: 'rec',
      owedRanges: ranges,
      attempts: <JournalAttempt>[
        for (int i = 0; i < 4; i++) a('a$i', 'job-A', JournalAttempt.outcomeFailed),
        a('a4', 'job-A', JournalAttempt.outcomeSettled),
      ],
    );
    final RecoveryJobStatus s = RecoveryJobStatus.fromManifest(m);
    expect(s.failedAutoAttempts, 0, reason: 'A\'s budget is not B\'s');
    expect(s.stateAfterAutoFailure(), RecoveryQueueState.pending,
        reason: 'B\'s first failure leaves it retryable');
    final RecoveryJobStatus afterB = RecoveryJobStatus.fromManifest(RecordingManifest(
      recordingId: 'rec',
      owedRanges: ranges,
      attempts: <JournalAttempt>[
        ...m.attempts,
        a('b0', 'job-B', JournalAttempt.outcomeFailed),
      ],
    ));
    expect(afterB.failedAutoAttempts, 1);
    expect(afterB.budgetExhausted, isFalse);
  });

  testWidgets(
      'Codex rc2 ⑤: the fitted spans do not reach storage ⇒ the attempt does '
      'not settle and the PCM stays (storage would say 90 s for 280 s)',
      (WidgetTester tester) async {
    late final _ArticleRig r;
    await tester.runAsync(() async {
      r = await _ArticleRig.open();
      r.relay
        ..answer = const <(String, int)>[(_partA, 30000), (_partB, 30000), (_partial, 30000)]
        ..endedNormally = true;
      // The rows land as the relay reported them; every later span write fails.
      r.persistence.failWhen = (TimelineEntry e) =>
          <String>{_partA, _partB, _partial}.contains(e.displayText) &&
          e.durationMs != 30000;
      await r.recordA1AndStop();
      await r.recoveryDone();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1), reason: 'positive control');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(r.pcmPresent, isTrue,
        reason: 'what storage holds says the stretch is 90 s; the audio must stay');
    expect(m.settled, isFalse);
  });
}