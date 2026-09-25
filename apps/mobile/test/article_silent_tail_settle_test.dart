// 🔴 CARD RC-B — A LONG RECORDING THAT ENDS IN SILENCE IS FINISHED, NOT OWED.
// MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b), the RC-B note
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.1, §7 RC-B, §10-2
//   test/article_backfill_placement_test.dart (the RC-3 rig this follows)
//
// ── THE SHAPE (CR-12-E rerun, RB) ───────────────────────────────────────────
//
// A long recording. Two rows; the second is cut by a pause. The user stays
// silent a few seconds and presses stop. The relay answers with the terminal
// final `text:''` and a COMPLETE receipt. That final used to end in a bare
// `return` (`chat_utterance.dart`, the `fromIdx > 0` arm), so the live settle
// never ran: 30 s later the SD-2 stamp expired and the recovery queue took the
// whole recording, from byte 0, as owed — on this tier-A server it would be
// transcribed again, filed into the article a second time and billed again.
//
// ⚠️ 「30 s later」 IS SIMULATED, NOT SLEPT: any SD-2 stamp still on the manifest
// is aged past `kLiveSettlePendingGraceMs` (that is what time would do to it),
// then the sweep runs. A settled recording has no stamp and is not touched.
//
// ⚠️ UNDER `tester.runAsync`, for the reason article_screen_test.dart gives.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/live_settle.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart' show SessionOwnerProbe;
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/live_settle_rig.dart' show FailingPersistence;
import 'support/memory_journal_fs.dart';
import 'support/temp_teardown.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _bytesPerMs = 32; // 16 kHz mono s16le
const int _row0Ms = 40000;
const int _row1Ms = 30000;
const int _silentTailMs = 6000;
// ⚠️ 更正（ruling 5，2026-09-24）：原为 `_row0Ms + _row1Ms` (1:10, 「the silence is
// no row」). MAIN ruled the head is the RECORDED length: the silent tail's span
// goes onto the last row (chat_utterance_owner.dart `_recordSilentTail`), 1:16.
const int _totalMs = _row0Ms + _row1Ms + _silentTailMs;

const String _row0Text = '先把上周的数字过一遍，然后看新的排期。';
const String _row1Text = '这一段在停顿处被切成了行。';

/// The relay: live stop ⇒ the empty terminal final of a recording that ended in
/// silence, on a receipt shaped by [fedDelta] / [endedNormally]; any recovery
/// stop ⇒ the whole recording's words (so a re-transcription would show up).
class _Relay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;
  int fedDelta = 0;
  bool endedNormally = true;

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
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': recovery ? '$_row0Text$_row1Text' : '',
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': recovery ? 0 : 2,
          'is_segment': false,
          'duration_ms': recovery ? _totalMs : _silentTailMs,
          'coverage_receipt_version': 1,
          'fed_frames': recovery ? fed : fed + fedDelta,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 2,
          'ended_normally': recovery || endedNormally,
          'recording_id': s['recording_id'],
          'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.fs, this.spill);

  static Future<_Rig> open({TimelinePersistence? persistence}) async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rcb-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final MemoryJournalFs fs = MemoryJournalFs();
    final _Rig r = _Rig._(tmp, store, fs,
        RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs));
    r._build(persistence);
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final MemoryJournalFs fs;
  final RetainedAudioSpill spill;
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  late final _Relay relay;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;
  String? articleId;
  String? recordingId;

  void _build(TimelinePersistence? persistence) {
    relay = _Relay();
    session = newTestSession(
      transport: relay,
      audio: AudioCapture(recorder: recorder, spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect.noteServerCapabilities(<String, Object?>{
      'capabilities': <String>[
        kCapabilityCoverageReceipt,
        kCapabilityDeliveryNoneSafe,
        kCapabilityIdempotentOperation,
      ],
    });
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

  Future<void> _segment(String text, int idx, int ms) async {
    relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': idx, 'is_segment': true, 'duration_ms': ms,
    });
    await pumpEventQueue();
  }

  /// Two rows, the second cut by a pause, then [_silentTailMs] of silence and
  /// stop. [continuous] false = an ordinary press with the same shape.
  Future<void> recordAndStop({bool continuous = true}) async {
    if (continuous) {
      articleId = session.beginContinuous(cap: const Duration(minutes: 30), onWarning: () {});
    }
    await controller.pttDown();
    recordingId = spill.liveAttempt?.recordingId;
    await _feedMs(_row0Ms);
    await _segment(_row0Text, 0, _row0Ms);
    await _feedMs(_row1Ms);
    await _segment(_row1Text, 1, _row1Ms);
    await _feedMs(_silentTailMs);
    await controller.pttUp();
  }

  /// Wait for the live attempt on the manifest to carry an outcome.
  Future<void> awaitLiveOutcome() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 20));
    while (DateTime.now().isBefore(deadline)) {
      final RecordingManifest? m = await manifest();
      if (m != null && m.attempts.any((JournalAttempt a) => a.kind == 'live' && a.outcome != null)) {
        if (!m.settled || !pcmPresent) break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  /// 「30 s later」: age any SD-2 stamp past its grace, then let the queue run.
  Future<void> thirtySecondsLaterSweep() async {
    await thirtySecondsLater();
    await sweep();
  }

  /// Age any SD-2 stamp past its grace — what 30 s would do to it.
  Future<void> thirtySecondsLater() async {
    for (final String p in fs.paths.toList()) {
      if (!p.endsWith(RetainedAudioJournal.manifestSuffix)) continue;
      final RecordingManifest m =
          RecordingManifest.decode(String.fromCharCodes(await fs.readBytes(p)));
      final int? at = m.liveSettlePendingAtMs;
      if (at == null) continue;
      final RecordingManifest aged = m.copyWith(
          liveSettlePendingAtMs: at - kLiveSettlePendingGraceMs - 1000);
      await fs.writeBytes(p, Uint8List.fromList(aged.encode().codeUnits));
    }
  }

  Future<void> sweep() async {
    await controller.backfill.sweep(sourceLang: 'zh');
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 60));
    while (controller.backfill.isBusy && DateTime.now().isBefore(deadline)) {
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

  List<TimelineEntry> get rows => articleMembersOf(timeline, articleId!);

  /// The press's / recording's live rows, article or not.
  List<TimelineEntry> get spokenRows => timeline.entries
      .where((TimelineEntry e) =>
          !e.isArticle && // the head of a long recording is not a spoken row
          (e.displayText == _row0Text || e.displayText == _row1Text))
      .toList();

  Future<List<PendingRecoveryItem>> pending() => PendingRecoveryStore(
        runner: controller.backfill,
        sourceLang: () => 'zh',
      ).list();

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

Future<void> _mountAndOpen(WidgetTester tester, _Rig r) async {
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

String _textOf(WidgetTester tester, Key key) {
  final Text t = tester.widget<Text>(find.byKey(key));
  return t.data ?? t.textSpan!.toPlainText();
}

List<String> _meta(int parts) => <String>[
      for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
        _zh.articleCardMeta(formatEntryDuration(s * 1000), parts),
    ];

/// The bytes stay and nothing re-transcribes, whatever the refusal was.
Future<RecordingManifest> _expectKept(WidgetTester tester, _Rig r, String refusal) async {
  final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
  expect(m.settled, isFalse, reason: 'condition failed ⇒ not settled');
  expect(r.pcmPresent, isTrue, reason: 'condition failed ⇒ not one byte goes');
  final JournalAttempt live =
      m.attempts.lastWhere((JournalAttempt a) => a.kind == 'live');
  expect(live.outcome, JournalAttempt.outcomeSettledUnverified);
  expect(live.failureCode, contains(refusal));
  expect(r.relay.recoveryStarts, isEmpty,
      reason: 'kept is not owed: the words are all in the article');
  return m;
}

void main() {
  testWidgets(
      '🔴 RC-B: a long recording that ends in silence settles on its own rows — '
      'bytes released, not on the pending page, no sweep 30 s later, the page '
      'unchanged', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop();
      await r.awaitLiveOutcome();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.rows, hasLength(2), reason: 'positive control: two live rows');
    // What the user would see 30 s later: the pending page, then the queue.
    await tester.runAsync(r.thirtySecondsLater);
    final List<PendingRecoveryItem> items =
        (await tester.runAsync<List<PendingRecoveryItem>>(r.pending))!;
    await tester.runAsync(r.sweep);
    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'the device showed the whole recording taken as owed here');
    expect(items, isEmpty, reason: 'nothing is owed, so nothing is listed');
    expect(r.rows, hasLength(2), reason: 'no second copy filed into the article');

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.recordingId, r.recordingId);
    expect(m.settled, isTrue, reason: 'all four held: the recording is finished');
    expect(m.recoveryState, RecoveryQueueState.settled);
    expect(m.liveSettlePendingAtMs, isNull, reason: 'the SD-2 stamp is cleared');
    expect(m.resultRef, isIn(r.rows.map((TimelineEntry e) => e.id)),
        reason: 'the result is one of this recording\'s rows');
    expect(r.pcmPresent, isFalse, reason: 'ruling O-1: success ⇒ delete');

    await _mountAndOpen(tester, r);
    expect(_meta(2), contains(_textOf(tester, const Key('article.meta'))));
    final String body = <String>[
      for (int k = 0; k < 8; k++)
        if (find.byKey(Key('article.paragraph.$k.text')).evaluate().isNotEmpty)
          _textOf(tester, Key('article.paragraph.$k.text')),
    ].join('\n');
    expect(_row0Text.allMatches(body), hasLength(1), reason: 'the opening, once');
    expect(_row1Text.allMatches(body), hasLength(1), reason: 'the last row, once');
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  for (final bool continuous in <bool>[true, false]) {
    final String kind = continuous ? 'long recording' : 'ordinary press';

    testWidgets('RC-B negative ② ($kind): fed_frames short by one ⇒ no deletion',
        (WidgetTester tester) async {
      late final _Rig r;
      await tester.runAsync(() async {
        r = await _Rig.open();
        r.relay.fedDelta = -1;
        await r.recordAndStop(continuous: continuous);
        await r.awaitLiveOutcome();
        await r.thirtySecondsLaterSweep();
      });
      addTearDown(() => tester.runAsync(r.dispose));
      await _expectKept(tester, r, 'frameCountMismatch');
    });

    testWidgets('RC-B negative ③ ($kind): ended_normally false ⇒ no deletion',
        (WidgetTester tester) async {
      late final _Rig r;
      await tester.runAsync(() async {
        r = await _Rig.open();
        r.relay.endedNormally = false;
        await r.recordAndStop(continuous: continuous);
        await r.awaitLiveOutcome();
        await r.thirtySecondsLaterSweep();
      });
      addTearDown(() => tester.runAsync(r.dispose));
      await _expectKept(tester, r, 'notEndedNormally');
    });

    testWidgets(
        'RC-B negative ④ ($kind): no row of this recording reads back ⇒ no deletion',
        (WidgetTester tester) async {
      late final _Rig r;
      await tester.runAsync(() async {
        r = await _Rig.open(persistence: FailingPersistence());
        await r.recordAndStop(continuous: continuous);
        await r.awaitLiveOutcome();
        await r.thirtySecondsLaterSweep();
      });
      addTearDown(() => tester.runAsync(r.dispose));
      expect(r.spokenRows, hasLength(2), reason: 'positive control: rows exist, unread');
      await _expectKept(tester, r, 'rowNotPersisted');
    });

    testWidgets(
        'RC-B negative ① ($kind): the entry decides nothing for a terminal final '
        'that carried words (that is the ordinary settle\'s case)',
        (WidgetTester tester) async {
      late final _Rig r;
      await tester.runAsync(() async {
        r = await _Rig.open();
        r.relay.fedDelta = -1; // keep the bytes, so a second verdict would show
        await r.recordAndStop(continuous: continuous);
        await r.awaitLiveOutcome();
      });
      addTearDown(() => tester.runAsync(r.dispose));
      final int before =
          (await tester.runAsync<RecordingManifest?>(r.manifest))!.attempts.length;
      final Object? d = await tester.runAsync<Object?>(() => settleSilentTail(
            session: r.session,
            timeline: r.timeline,
            receipt: null,
            finalText: '有字的终稿',
            pressRecordingId: r.recordingId,
            pressRowIds: <String>[for (final TimelineEntry e in r.spokenRows) e.id],
          ));
      expect(d, isNull);
      final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
      expect(m.attempts, hasLength(before), reason: 'nothing written');
      expect(r.pcmPresent, isTrue);
    });
  }

  testWidgets(
      '🔴 RC-B follow-up: an ORDINARY press whose words were cut into a row and '
      'which then ended in silence settles on its own rows — bytes released, no '
      'sweep 30 s later, each row on the chat page once',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop(continuous: false);
      await r.awaitLiveOutcome();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.spokenRows, hasLength(2), reason: 'positive control: two live rows');
    expect(r.articleId, isNull, reason: 'positive control: not a long recording');
    await tester.runAsync(r.thirtySecondsLater);
    final List<PendingRecoveryItem> items =
        (await tester.runAsync<List<PendingRecoveryItem>>(r.pending))!;
    await tester.runAsync(r.sweep);
    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'production reaches this: the whole press re-transcribed and re-billed');
    expect(items, isEmpty, reason: 'nothing is owed, so nothing is listed');
    expect(r.spokenRows, hasLength(2), reason: 'no second copy filed');

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue, reason: 'all four held');
    expect(m.recoveryState, RecoveryQueueState.settled);
    expect(m.resultRef, isIn(r.spokenRows.map((TimelineEntry e) => e.id)));
    expect(r.pcmPresent, isFalse, reason: 'ruling O-1: success ⇒ delete');

    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text(_row0Text), findsOneWidget, reason: 'the chat page, once');
    expect(find.text(_row1Text), findsOneWidget);
  });
}