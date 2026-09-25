// 🔴 CARD RC-3b — THE ENGINE CAME BACK MID-RECORDING; THE RELAY'S RING DID NOT
// HOLD THE WHOLE OUTAGE. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 `stt:engine-status` (RC-3b note)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §5 RC-3
//   test/article_backfill_placement_test.dart (the RC-3 rig this follows)
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
//
// A long recording. 40 s in, one row. 5 s later the relay loses its speech
// engine; the user keeps talking; 30 s later the engine is back and the relay
// re-feeds what its ring still holds — 12 s of it. The 18 s before that no
// engine ever heard. The row that spans the outage arrives 10 s later, and
// the relay reports its length on ITS clock: 5 + 30 + 10 = 45 s
// (server-core `orchestrator-rollover.ts` `boundaryMs = host.now()`; a ladder
// reconnect never moves `segmentStartMs`). Then 20 s more and stop.
//
//   before RC-3b: the 18 s have no words anywhere, the complete-looking
//     receipt lets the live settle delete the only copy of them, and the
//     page reads 1:45 · 3 parts with nothing to say that anything is missing;
//   after: the 18 s are owed, recovered after the stop, and placed where they
//     were spoken; the head still reads 1:45 (the spanning row gives back the
//     18 s it had claimed), now in 4 parts.
//
// ⚠️ UNDER `tester.runAsync`, for the reason article_screen_test.dart gives.

import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
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
import 'support/memory_journal_fs.dart';
import 'support/rc3_rig.dart';
import 'support/temp_teardown.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _bytesPerMs = 32; // 16 kHz mono s16le
const int _row0Ms = 40000;
const int _preDropMs = 5000;
const int _outageMs = 30000;
const int _replayedMs = 12000;
const int _afterReadyMs = 10000;
const int _lastMs = 20000;
/// What the relay reports for the row that spans the outage: its wall clock.
const int _spanningRowMs = _preDropMs + _outageMs + _afterReadyMs; // 45 s
const int _totalMs = _row0Ms + _spanningRowMs + _lastMs; // 105 s = 1:45
// ⚠️ 更正（RC-L，2026-09-24）：原为 `_outageMs - _replayedMs` (18 s) from the
// drop at 45 s. The owed stretch now reaches 1 s past each end
// (`kOwedEdgeMs`, ptt_capture_pump.dart `_noteEngineStatusForArticle`): a range
// cut mid-word loses the word on both sides. 44 s → 64 s, 20 s.
const int _edgeMs = 1000;
const int _owedMs = _outageMs - _replayedMs + 2 * _edgeMs; // 20 s
const int _holeStartMs = _row0Ms + _preDropMs - _edgeMs; // 44 s into the capture

const String _row0Text = '先把上周的数字过一遍，然后看新的排期。';
const String _spanningText = '这一行里有断线前后的话。';
const String _lastText = '最后一段，散会前再确认一次。';
const String _holeText = '断线那十八秒里说过的话。';

/// The relay for this recording: live finals are pushed by the rig; the live
/// stop is answered with the terminal row and a COMPLETE receipt (the relay did
/// take every frame — `FrameTally.note` counts the evicted ones as taken); a
/// recovery stop with [_holeText].
class _Relay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;
  String recoveryText = _holeText;
  bool recoveryEndedNormally = true; // Codex ② — a shortfall first

  static bool _isRecovery(Map<String, Object?> s) =>
      s['attempt_kind'] == 'auto_retry' || s['attempt_kind'] == 'user_retranscribe';
  bool get _inRecovery => starts.isNotEmpty && _isRecovery(starts.last);
  List<Map<String, Object?>> get recoveryStarts =>
      <Map<String, Object?>>[for (final Map<String, Object?> s in starts) if (_isRecovery(s)) s];

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      chunks += 1;
      // RC-2 pacing: an engine that processes at once (see the RC-3 rig).
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
      chunks = 0;
    }
    if (event == FlowMicEvents.audioStop && starts.isNotEmpty) {
      final Map<String, Object?> s = starts.last;
      final bool recovery = _inRecovery;
      final int fed = chunks;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': recovery ? recoveryText : _lastText,
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': recovery ? 0 : 2,
          'is_segment': false,
          'duration_ms': recovery ? 5000 : _lastMs,
          'coverage_receipt_version': 1,
          'fed_frames': fed,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 0,
          'ended_normally': !recovery || recoveryEndedNormally,
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

  static Future<_Rig> open() async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rc3b-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final MemoryJournalFs fs = MemoryJournalFs();
    final _Rig r = _Rig._(tmp, store, fs,
        RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs));
    r._build();
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

  void _build() {
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
    timeline = newTestStore(owner: SessionOwnerProbe(session));
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

  Future<void> _push(String event, Map<String, Object?> data) async {
    relay.pushIncoming(event, data);
    await pumpEventQueue();
  }

  /// The recording described in the file header. [replayedMs] null = a relay
  /// older than RC-3b (no field on `ready`).
  Future<void> recordAndStop({int? replayedMs}) async {
    articleId = session.beginContinuous(cap: const Duration(minutes: 30), onWarning: () {});
    await controller.pttDown();
    await _feedMs(_row0Ms);
    await _push(FlowMicEvents.sttFinal, <String, Object?>{
      'text': _row0Text, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': 0, 'is_segment': true, 'duration_ms': _row0Ms,
    });
    await _feedMs(_preDropMs);
    await _push(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting', 'provider': 'soniox', 'retry_count': 1,
    });
    await _feedMs(_outageMs ~/ 2);
    await _push(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting', 'provider': 'soniox', 'retry_count': 2,
    });
    await _feedMs(_outageMs - _outageMs ~/ 2);
    await _push(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'ready', 'provider': 'soniox',
      'replayed_ms': ?replayedMs,
    });
    await _feedMs(_afterReadyMs);
    await _push(FlowMicEvents.sttFinal, <String, Object?>{
      'text': _spanningText, 'confidence': 0.95, 'language': 'zh',
      'segment_idx': 1, 'is_segment': true, 'duration_ms': _spanningRowMs,
    });
    await _feedMs(_lastMs);
    await controller.pttUp();
  }

  /// Wait for [attempts] recoveries to finish, or — with 0 — give any that
  /// might start a fair chance to, then settle.
  Future<void> settle({int attempts = 1}) async {
    final DateTime deadline =
        DateTime.now().add(Duration(seconds: attempts == 0 ? 2 : 60));
    while (DateTime.now().isBefore(deadline)) {
      if (attempts > 0 &&
          relay.recoveryStarts.length >= attempts &&
          !controller.backfill.isBusy) {
        break;
      }
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

List<String> _metaFor(int parts) => <String>[
      for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
        _zh.articleCardMeta(formatEntryDuration(s * 1000), parts),
    ];

void main() {
  testWidgets(
      '🔴 RC-3b: engine back after 30 s with 12 s replayed ⇒ the other 18 s are '
      'recovered where they were spoken, and the head still reads 1:45',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop(replayedMs: _replayedMs);
      await r.settle();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The owed stretch, as fed: from where the engine went away, for 18 s.
    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(1), reason: 'positive control: the owed stretch was fed');
    expect(rec.single['range_start_sample'], _holeStartMs * 16);
    expect(rec.single['range_end_sample'], (_holeStartMs + _owedMs) * 16,
        reason: '18 s = 30 s of outage − the 12 s the relay re-fed, and not one '
            'byte of the live rows after it');

    final List<TimelineEntry> rows = <TimelineEntry>[...r.rows]
      ..sort((TimelineEntry a, TimelineEntry b) =>
          (a.articleOffsetMs ?? 0).compareTo(b.articleOffsetMs ?? 0));
    expect(rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0Text, _holeText, _spanningText, _lastText]);
    final TimelineEntry hole = rows[1];
    expect(hole.articleOffsetMs, _row0Ms,
        reason: 'where the spanning segment began: the live clock when the engine came back');
    expect(hole.durationMs, _owedMs);
    expect(rows[2].durationMs, _spanningRowMs - _owedMs,
        reason: 'the spanning row gives back the 18 s the recovered row now holds');
    expect(rows[2].articleOffsetMs, _row0Ms + _owedMs);
    expect(rows[3].articleOffsetMs, _row0Ms + _spanningRowMs,
        reason: 'the rows after the outage are where they were said');
    // The recovery settled and released the bytes.
    expect((await tester.runAsync<RecordingManifest?>(r.manifest))!.settled, isTrue);
    expect(r.pcmPresent, isFalse);

    await _mountAndOpen(tester, r);
    expect(_metaFor(4), contains(_textOf(tester, const Key('article.meta'))),
        reason: 'counted twice it would read 2:03');
    expect(find.textContaining(_holeText), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      '🔴 RC-3b follow-up: the owed stretch comes back EMPTY (the outage began '
      'in a pause the relay never replayed) ⇒ the spanning row gets its 18 s '
      'back and the head reads 1:45 again', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay.recoveryText = '';
      await r.recordAndStop(replayedMs: _replayedMs);
      await r.settle();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'positive control: the owed stretch was fed');
    final List<TimelineEntry> rows = <TimelineEntry>[...r.rows]
      ..sort((TimelineEntry a, TimelineEntry b) =>
          (a.articleOffsetMs ?? 0).compareTo(b.articleOffsetMs ?? 0));
    expect(rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0Text, _spanningText, _lastText]);
    expect(rows[1].durationMs, _spanningRowMs,
        reason: 'the 18 s it lent come back: nobody else holds them');
    expect(rows[1].articleOffsetMs, _row0Ms);

    await _mountAndOpen(tester, r);
    expect(_metaFor(3), contains(_textOf(tester, const Key('article.meta'))),
        reason: 'without the give-back the head reads 1:27');
  });

  testWidgets(
      'RC-3b: a relay without replayed_ms (older than RC-3b) ⇒ today\'s '
      'behaviour: nothing owed, nothing recovered, the audio released on the '
      'live receipt, the head 1:45 in 3 parts', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop(); // no replayed_ms
      await r.settle(attempts: 0);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, isEmpty);
    expect(r.rows.map((TimelineEntry e) => e.displayText),
        isNot(contains(_holeText)));
    expect(r.rows, hasLength(3));
    // ⚠️ THE STATED BEHAVIOUR, NOT A GOAL: the live receipt counts the frames
    // the relay's ring evicted as taken, so the live settle deletes the only
    // copy of the 18 s nobody heard.
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);
    expect(m.transcribedPrefixBytes, isNull);
    expect(r.pcmPresent, isFalse);

    await _mountAndOpen(tester, r);
    expect(_metaFor(3), contains(_textOf(tester, const Key('article.meta'))));
  });

  testWidgets(
      'RC-3b positive control: the relay re-fed the whole outage ⇒ nothing is '
      'owed and the spanning row keeps its length', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop(replayedMs: _outageMs + 2000);
      await r.settle(attempts: 0);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, isEmpty);
    expect(r.rows, hasLength(3));
    expect(r.rows.map((TimelineEntry e) => e.durationMs),
        containsAll(<int>[_row0Ms, _spanningRowMs, _lastMs]));
  });

  testWidgets(
      '🔴 Codex ②: a shortfall of the owed stretch, the app restarts, the user '
      'retries ⇒ the retry lands where the first attempt did: the partial row '
      'is replaced and the live row spanning the outage survives',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay
        ..recoveryText = '断线那。'
        ..recoveryEndedNormally = false;
      await r.recordAndStop(replayedMs: _replayedMs);
      await r.settle();
      // A RESTART, as far as placement can see one: the in-memory stretch start
      // is gone (`ArticleScribe` is rebuilt empty), only the manifest remains.
      r.session.articles.dropStretchStart(r.articleId!);
      r.relay
        ..recoveryText = _holeText
        ..recoveryEndedNormally = true;
      final String id = r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.settle(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2), reason: 'positive control: retried');
    final List<TimelineEntry> rows = <TimelineEntry>[...r.rows]
      ..sort((TimelineEntry a, TimelineEntry b) =>
          (a.articleOffsetMs ?? 0).compareTo(b.articleOffsetMs ?? 0));
    final List<String> texts = rows.map((TimelineEntry e) => e.displayText).toList();
    expect(texts, contains(_spanningText),
        reason: 'the live row spanning the outage (at 58 s) is not the partial one');
    expect(texts, isNot(contains('断线那。')), reason: 'the partial row is replaced');
    expect(texts, <String>[_row0Text, _holeText, _spanningText, _lastText]);
    expect(rows[1].articleOffsetMs, _row0Ms,
        reason: 'the article clock (40 s), not the capture byte offset (45 s)');
  });

  testWidgets(
      '🔴 RC-L (phone half): the dead leg had answered only to 88.5 s when the '
      'engine went at 91.0 s ⇒ the owed stretch starts at 87.5 s (answered − '
      '1 s) and ends at 97.0 s (ready 123.0 − replayed 27 + 1 s)',
      (WidgetTester tester) async {
    // The rc3 rig: its capture clock stamps frame k at k × 200 ms, so the
    // interim's `acked_audio_ms` names a capture position as a live relay's does.
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(
              FlowMicEvents.sttFinal,
              stop.recovery
                  ? r.relay.terminal(stop, text: _holeText, durationMs: stop.toMs - stop.fromMs)
                  : r.relay.terminal(stop, text: _lastText, durationMs: 7000, segmentIdx: 2));
        });
      };
      await r.begin();
      await r.feedMs(60000);
      await r.segment(_row0Text, 0, 60000);
      await r.feedMs(31000); // to 91.0 s
      await r.interim(1, ackedMs: 88500); // answered to 88.5 s — 2.5 s behind
      await r.engine('reconnecting');
      await r.feedMs(32000); // to 123.0 s
      await r.engine('ready', replayedMs: 27000);
      await r.feedMs(10000);
      await r.segment(_spanningText, 1, 73000); // the relay's clock: 60 → 133 s
      await r.feedMs(7000);
      await r.controller.pttUp();
      await r.recoveries(1);
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _holeText));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final Map<String, Object?> fed = r.relay.recoveryStarts.single;
    expect(fed['range_start_sample'], 87500 * 16,
        reason: 'before RC-L the stretch began at the drop (91.0 s): the 2.5 s '
            'the dead leg heard and never answered were owed by nobody');
    expect(fed['range_end_sample'], 97000 * 16);
    expect(r.rows.where((TimelineEntry e) => e.displayText == _holeText), hasLength(1));
    expect(r.rowsMs, 140000, reason: 'the head still adds up: trimmed = owed');

    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_holeText), findsOneWidget);
  });

  testWidgets(
      'RC-L positive control: a relay that replays from where the dead leg had '
      'answered (its own RC-L half) ⇒ nothing is owed — the 1 s edges widen a '
      'real hole only, not a zero one', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _lastText, durationMs: 7000, segmentIdx: 2));
        });
      };
      await r.begin();
      await r.feedMs(60000);
      await r.segment(_row0Text, 0, 60000);
      await r.feedMs(31000);
      await r.interim(1, ackedMs: 88500);
      await r.engine('reconnecting');
      await r.feedMs(32000);
      await r.engine('ready', replayedMs: 123000 - 88500); // back to the answer
      await r.feedMs(10000);
      await r.segment(_spanningText, 1, 73000);
      await r.feedMs(7000);
      await r.controller.pttUp();
      await r.untilAsync(() async => (await r.manifest())?.settled ?? false,
          max: const Duration(seconds: 5));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'a 2 s range at every outage would be a recovery and a '
            'duplicate row for words the relay already has');
    expect(r.rows.map((TimelineEntry e) => e.durationMs).toList(),
        <int>[60000, 73000, 7000]);
  });
}
