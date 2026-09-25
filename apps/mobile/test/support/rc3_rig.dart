// The CR-12-E rerun-3 phone cards' shared rig (RC-M / RC-N / RC-P / RC-L /
// ruling 5): a long recording on the REAL chain — `PttSession` →
// `ChatController` → `BackfillRunner` → `RecoveryJournalLeg` — against a fake
// relay whose every answer the test scripts, mounted on `ChatFlowPage` →
// `ArticlePage` (anti-façade ⑥: the screen the user reads the piece on).
//
// Built on the pattern of article_backfill_placement_test.dart /
// article_engine_back_test.dart, with two additions those rigs did not need:
//   · the capture clock is injected (`ts_ms` of frame k = k × 200 ms), so an
//     interim's `acked_audio_ms` names a capture position the way a live relay's
//     does (ptt_capture_pump.dart `_noteAnsweredForArticle`);
//   · the relay's answer to each `audio:stop` is a callback the test sets, so a
//     test can answer late, answer twice, or answer out of order.
//
// ⚠️ Used under `tester.runAsync` — the production chain awaits real timers.

import 'dart:async';
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'article_rig.dart' show SessionOwnerProbe;
import 'di.dart';
import 'fakes.dart';
import 'memory_journal_fs.dart';
import 'temp_teardown.dart';

const int kRc3BytesPerMs = 32; // 16 kHz mono s16le

/// One `audio:stop` the relay saw: the start frame it closes and the frames fed.
class Rc3Stop {
  Rc3Stop(this.start, this.fed);
  final Map<String, Object?> start;
  final int fed;
  bool get recovery =>
      start['attempt_kind'] == 'auto_retry' ||
      start['attempt_kind'] == 'user_retranscribe';
  int get fromMs => ((start['range_start_sample'] as int?) ?? 0) ~/ 16;
  int get toMs => ((start['range_end_sample'] as int?) ?? 0) ~/ 16;
}

class Rc3Relay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;

  /// How the relay answers each `audio:stop`. Default: nothing.
  void Function(Rc3Stop stop) onStop = (_) {};

  /// Follow-up (yield) — the relay receiving a discarding `audio:stop` sent
  /// with an ack: what it had already produced for that session is pushed
  /// here, BEFORE the ack resolves (the socket is ordered).
  Future<void> Function(Map<String, Object?> start)? onDiscard;

  /// What happened, in order, for tests that assert an ordering.
  final List<String> events = <String>[];

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) async {
    final Map<String, Object?>? start = starts.isEmpty ? null : starts.last;
    if (event == FlowMicEvents.audioStop && start != null) {
      events.add('discard-stop');
      // The frames still in flight arrive first; the ack after them.
      await onDiscard?.call(start);
    }
    return super.emitWithAck<R>(event, payload, timeout: timeout);
  }

  static bool isRecovery(Map<String, Object?> s) =>
      s['attempt_kind'] == 'auto_retry' || s['attempt_kind'] == 'user_retranscribe';
  bool get _inRecovery => starts.isNotEmpty && isRecovery(starts.last);
  List<Map<String, Object?>> get recoveryStarts =>
      <Map<String, Object?>>[for (final Map<String, Object?> s in starts) if (isRecovery(s)) s];

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      chunks += 1;
      // An engine that processes at once, reporting every 3.2 s of audio.
      if (_inRecovery && chunks % 16 == 0) {
        final int acked = chunks * 200;
        Future<void>.microtask(() => pushIncoming(FlowMicEvents.sttInterim,
            <String, Object?>{'text': '…', 'segment_idx': 0, 'acked_audio_ms': acked}));
      }
      return;
    }
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      events.add(isRecovery(payload) ? 'recovery-start' : 'live-start');
      chunks = 0;
    }
    if (event == FlowMicEvents.audioStop && starts.isNotEmpty) {
      onStop(Rc3Stop(starts.last, chunks));
    }
  }

  /// A terminal final for [stop], with a receipt echoing its start frame.
  Map<String, Object?> terminal(
    Rc3Stop stop, {
    required String text,
    required int durationMs,
    int segmentIdx = 0,
    bool endedNormally = true,
  }) =>
      <String, Object?>{
        'text': text,
        'confidence': 0.9,
        'language': 'zh',
        'segment_idx': segmentIdx,
        'is_segment': false,
        'duration_ms': durationMs,
        'coverage_receipt_version': 1,
        'fed_frames': stop.fed,
        'seq_gaps': 0,
        'drops': 0,
        'engine_leg_rollovers': 0,
        'ended_normally': endedNormally,
        'recording_id': stop.start['recording_id'],
        'attempt_id': stop.start['attempt_id'],
        'range_start_sample': stop.start['range_start_sample'],
        'range_end_sample': stop.start['range_end_sample'],
      };
}

class Rc3Rig {
  Rc3Rig._(this.tmp, this.store, this.fs, this.spill);

  static Future<Rc3Rig> open({
    Duration processingTimeout = const Duration(seconds: 15),
    RecoveryTimeouts recoveryTimeouts = const RecoveryTimeouts(),
    // Card RC6 — a ceiling on the long-recording stop wait (5 min in production;
    // `FlowmicStateMachine.longStopCeiling`), for a test that needs the phone to
    // give up on a live final.
    Duration? longStopCeiling,
    // Card RC6 — the recovery queue's clock and RC-O retry timer.
    int Function()? recoveryClock,
    Timer Function(Duration, void Function())? recoveryRetryTimer,
  }) async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rc3-a-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    // A gated fs whose gate is open unless a test sets one (Codex rc3 ⑥).
    final GatedMemoryJournalFs fs = GatedMemoryJournalFs();
    final Rc3Rig r = Rc3Rig._(tmp, store, fs,
        RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs));
    r._build(processingTimeout, recoveryTimeouts, recoveryClock, recoveryRetryTimer);
    r.session.fsm.longStopCeiling = longStopCeiling;
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final GatedMemoryJournalFs fs;
  final RetainedAudioSpill spill;
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  late final Rc3Relay relay;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;
  String? articleId;
  int _frame = 0;

  void _build(Duration processingTimeout, RecoveryTimeouts timeouts,
      int Function()? recoveryClock, Timer Function(Duration, void Function())? recoveryRetryTimer) {
    relay = Rc3Relay();
    session = newTestSession(
      transport: relay,
      // Frame k is stamped k × 200 ms: the chunk clock IS the capture clock.
      audio: AudioCapture(recorder: recorder, spill: spill, clock: () => 200 * _frame++),
      stateMachine: FlowmicStateMachine(
        justDoneDuration: Duration.zero,
        processingTimeout: processingTimeout,
      ),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect.noteServerCapabilities(<String, Object?>{
      'capabilities': <String>[
        kCapabilityCoverageReceipt,
        kCapabilityDeliveryNoneSafe,
        kCapabilityIdempotentOperation,
      ],
    });
    timeline = newTestStore(owner: SessionOwnerProbe(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: relay),
      localPrefs: InMemoryLocalPrefs(),
      recoveryTimeouts: timeouts,
      recoveryClock: recoveryClock,
      recoveryRetryTimer: recoveryRetryTimer,
    );
    relay.pushStatus(SocketStatus.connected);
  }

  Future<void> feedMs(int ms) async {
    recorder.feed(makePcm(ms * kRc3BytesPerMs));
    await pumpEventQueue();
  }

  Future<void> push(String event, Map<String, Object?> data) async {
    relay.pushIncoming(event, data);
    await pumpEventQueue();
  }

  Future<void> segment(String text, int idx, int ms) => push(
      FlowMicEvents.sttFinal, <String, Object?>{
        'text': text, 'confidence': 0.95, 'language': 'zh',
        'segment_idx': idx, 'is_segment': true, 'duration_ms': ms,
      });

  Future<void> interim(int idx, {int? ackedMs}) => push(
      FlowMicEvents.sttInterim, <String, Object?>{
        'text': '…', 'segment_idx': idx, 'acked_audio_ms': ?ackedMs,
      });

  Future<void> engine(String status, {int? replayedMs}) => push(
      FlowMicEvents.sttEngineStatus, <String, Object?>{
        'status': status, 'provider': 'soniox', 'retry_count': 1,
        'replayed_ms': ?replayedMs,
      });

  Future<void> begin() async {
    articleId = session.beginContinuous(cap: const Duration(minutes: 30), onWarning: () {});
    await controller.pttDown();
  }

  /// Wait until [attempts] recoveries have started and the runner is idle.
  Future<void> recoveries(int attempts, {Duration max = const Duration(seconds: 60)}) async {
    final DateTime deadline = DateTime.now().add(max);
    while (DateTime.now().isBefore(deadline)) {
      if (relay.recoveryStarts.length >= attempts && !controller.backfill.isBusy) break;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  /// Poll until [done] or [max] passes.
  Future<void> until(bool Function() done, {Duration max = const Duration(seconds: 30)}) async {
    final DateTime deadline = DateTime.now().add(max);
    while (!done() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  /// [until] for a question that has to read the disk.
  Future<void> untilAsync(Future<bool> Function() done,
      {Duration max = const Duration(seconds: 30)}) async {
    final DateTime deadline = DateTime.now().add(max);
    while (!await done() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  /// Until the last recorded attempt is closed with [outcome].
  Future<void> untilLastAttempt(String outcome) => untilAsync(() async {
        final RecordingManifest? m = await manifest();
        return m != null && m.attempts.isNotEmpty && m.attempts.last.outcome == outcome;
      });

  Future<RecordingManifest?> manifest() async {
    for (final String p in fs.paths) {
      if (p.endsWith(RetainedAudioJournal.manifestSuffix)) {
        return RecordingManifest.decode(String.fromCharCodes(await fs.readBytes(p)));
      }
    }
    return null;
  }

  /// Every manifest on the (in-memory) disk.
  Future<List<RecordingManifest>> manifests() async => <RecordingManifest>[
        for (final String p in fs.paths)
          if (p.endsWith(RetainedAudioJournal.manifestSuffix))
            RecordingManifest.decode(String.fromCharCodes(await fs.readBytes(p))),
      ];

  /// Whether [recordingId]'s PCM is still on disk.
  bool pcmOf(String recordingId) => fs.paths.any((String p) =>
      p.endsWith('$recordingId${RetainedAudioJournal.pcmSuffix}'));

  bool get pcmPresent =>
      fs.paths.any((String p) => p.endsWith(RetainedAudioJournal.pcmSuffix));

  List<TimelineEntry> get rows => <TimelineEntry>[...articleMembersOf(timeline, articleId!)]
    ..sort((TimelineEntry a, TimelineEntry b) =>
        (a.articleOffsetMs ?? 0).compareTo(b.articleOffsetMs ?? 0));

  int get rowsMs => rows.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0));

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

Future<void> rc3MountAndOpen(WidgetTester tester, Rc3Rig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.tap(find.byType(ChatArticleTile));
  await tester.pumpAndSettle();
  expect(find.byType(ArticlePage), findsOneWidget,
      reason: 'positive control: the screen the user reads the piece on');
}

String rc3TextOf(WidgetTester tester, Key key) {
  final Text t = tester.widget<Text>(find.byKey(key));
  return t.data ?? t.textSpan!.toPlainText();
}
