// 🔴 CARD RC-K (NR-100) — TWO ENGINE OUTAGES IN ONE LONG RECORDING. MOUNTED ON
// THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b), the RC-K correction
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.4, §10-4
//   test/article_engine_back_test.dart (the single-outage RC-3b rig this doubles)
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
//
//   capture  0–40 s   row 0
//            40–45    speech, then the engine goes away (outage 1, 30 s)
//            75       engine back, the relay re-fed 12 s ⇒ 45–63 owed (18 s)
//            85       the row spanning outage 1 (the relay says 45 s: its clock)
//            85–100   row 2 — the live words BETWEEN the two outages
//            100–105  speech, then outage 2 starts — 30 s after outage 1 ended
//            135      engine back, 12 s re-fed ⇒ 105–123 owed (18 s)
//            145      the row spanning outage 2 (45 s, relay clock)
//            145–165  the last row; stop.                        total 2:45
//
// Before RC-K the second stretch WIDENED the first to [45, 123): the recovery
// re-fed the live audio between them, row 2's words came back a second time
// inside the recovered row, and that row claimed the 60 s between the
// outages, so the head read long by them. Now each stretch is its own range,
// fed on its own and placed where it was spoken.
//
// 🔴 THE FAKE RELAY TRANSCRIBES WHAT IT IS FED: a recovery's text is the
// script of every stretch the fed range overlaps. A relay that answered a fixed
// sentence could not tell a widened range from a tight one — the assertion this
// file exists for would be green for the wrong reason.
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
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
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
import 'support/memory_journal_fs.dart';
import 'support/temp_teardown.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _bytesPerMs = 32; // 16 kHz mono s16le
const int _totalMs = 165000; // 2:45
// ⚠️ 更正（RC-L，2026-09-24）：原为 18000. Each stretch now reaches 1 s past both
// ends (`kOwedEdgeMs`): 45–63 s is owed as 44–64 s, 105–123 s as 104–124 s.
const int _owedMs = 20000;

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _hole1 = '第一次断线那十八秒里说过的话。';
const String _span1 = '跨过第一次断线的这一行。';
const String _between = '两次断线之间说的这一段，只许出现一次。';
const String _hole2 = '第二次断线那十八秒里说过的话。';
const String _span2 = '跨过第二次断线的这一行。';
const String _last = '最后一段，散会前再确认一次。';

/// The recording's script on the capture clock: what an engine would hear.
const List<(int, int, String)> _script = <(int, int, String)>[
  (0, 40000, _row0),
  (40000, 45000, _span1),
  (45000, 63000, _hole1),
  (63000, 85000, _span1),
  (85000, 100000, _between),
  (100000, 105000, _span2),
  (105000, 123000, _hole2),
  (123000, 145000, _span2),
  (145000, 165000, _last),
];

String _heard(int fromMs, int toMs) {
  final List<String> out = <String>[];
  for (final (int s, int e, String t) in _script) {
    // RC-L — a stretch reaching 1 s into a neighbouring row (`kOwedEdgeMs`)
    // hears that row's edge word, not the row: only a real overlap counts.
    final int overlap = (e < toMs ? e : toMs) - (s > fromMs ? s : fromMs);
    if (overlap > 1000 && (out.isEmpty || out.last != t)) out.add(t);
  }
  return out.join();
}

class _Relay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;

  /// Codex rc2 ② — the first stretch's recovery comes back with no words.
  bool firstStretchEmpty = false;

  static bool _isRecovery(Map<String, Object?> s) =>
      s['attempt_kind'] == 'auto_retry' || s['attempt_kind'] == 'user_retranscribe';
  bool get _inRecovery => starts.isNotEmpty && _isRecovery(starts.last);
  List<Map<String, Object?>> get recoveryStarts =>
      <Map<String, Object?>>[for (final Map<String, Object?> s in starts) if (_isRecovery(s)) s];

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      chunks += 1;
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
      final int from = ((s['range_start_sample'] as int?) ?? 0) ~/ 16;
      final int to = ((s['range_end_sample'] as int?) ?? 0) ~/ 16;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': recovery
              ? (firstStretchEmpty && from == 44000 ? '' : _heard(from, to))
              : _last,
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': recovery ? 0 : 4,
          'is_segment': false,
          'duration_ms': recovery ? to - from : 20000,
          'coverage_receipt_version': 1,
          'fed_frames': fed,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 0,
          'ended_normally': true,
          'recording_id': s['recording_id'],
          'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

/// Codex rc2 follow-up — storage that refuses the writes [refuse] names.
class _GatedPersistence extends InMemoryTimelinePersistence {
  bool Function(TimelineEntry e)? refuse;
  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (refuse?.call(entry) ?? false) throw StateError('disk refused this write');
    return super.upsert(entry);
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.fs, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rck-');
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
  final _GatedPersistence persistence = _GatedPersistence();
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

  Future<void> _push(String event, Map<String, Object?> data) async {
    relay.pushIncoming(event, data);
    await pumpEventQueue();
  }

  Future<void> _segment(String text, int idx, int ms) => _push(
      FlowMicEvents.sttFinal, <String, Object?>{
        'text': text, 'confidence': 0.95, 'language': 'zh',
        'segment_idx': idx, 'is_segment': true, 'duration_ms': ms,
      });

  /// 5 s of speech, 30 s outage, the relay re-feeds 12 s, 10 s more speech,
  /// then the row that spans it all (45 s on the relay's clock).
  Future<void> _outage(String spanText, int spanIdx) async {
    await _feedMs(5000);
    await _push(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting', 'provider': 'soniox', 'retry_count': 1,
    });
    await _feedMs(30000);
    await _push(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'ready', 'provider': 'soniox', 'replayed_ms': 12000,
    });
    await _feedMs(10000);
    await _segment(spanText, spanIdx, 45000);
  }

  Future<void> recordAndStop() async {
    articleId = session.beginContinuous(cap: const Duration(minutes: 30), onWarning: () {});
    await controller.pttDown();
    await _feedMs(40000);
    await _segment(_row0, 0, 40000);
    await _outage(_span1, 1);
    await _feedMs(15000);
    await _segment(_between, 2, 15000);
    await _outage(_span2, 3);
    await _feedMs(20000);
    await controller.pttUp();
  }

  Future<void> settle({required int attempts}) async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 60));
    while (DateTime.now().isBefore(deadline)) {
      if (relay.recoveryStarts.length >= attempts && !controller.backfill.isBusy) break;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    // A widened range is one attempt; give a second one a fair chance to show.
    await Future<void>.delayed(const Duration(milliseconds: 300));
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

void main() {
  testWidgets(
      '🔴 RC-K: two outages 30 s apart ⇒ two stretches recovered, each at its '
      'own offset; the live words between them appear exactly once; the head '
      'reads 2:45', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordAndStop();
      await r.settle(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The question this card exists for, asked first.
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_between.allMatches(all), hasLength(1),
        reason: 'the live words between the outages were fed again and came '
            'back inside the recovered row (NR-100)');

    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(2), reason: 'one attempt per stretch');
    expect(rec[0]['range_start_sample'], 44000 * 16);
    expect(rec[0]['range_end_sample'], 64000 * 16);
    expect(rec[1]['range_start_sample'], 104000 * 16);
    expect(rec[1]['range_end_sample'], 124000 * 16);

    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0, _hole1, _span1, _between, _hole2, _span2, _last]);
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 40000, 60000, 85000, 100000, 120000, 145000],
        reason: 'each stretch where it was spoken; the live rows where they were');
    expect(r.rows[1].durationMs, _owedMs);
    expect(r.rows[4].durationMs, _owedMs);

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.owedRanges, hasLength(2));
    expect(m.owedRanges.first.done, OwedRange.doneSettled);
    expect(m.settled, isTrue, reason: 'both stretches proven ⇒ the recording is done');
    expect(r.pcmPresent, isFalse);

    await _mountAndOpen(tester, r);
    final String meta = _textOf(tester, const Key('article.meta'));
    expect(
      <String>[
        for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 7),
      ],
      contains(meta),
      reason: 'widened, the recovered row claimed the 60 s between the outages',
    );
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      '🔴 Codex rc2 ②: the FIRST stretch comes back empty and the second '
      'settles ⇒ the user can still retry, and the retry feeds the first stretch',
      (WidgetTester tester) async {
    late final _Rig r;
    late final List<PendingRecoveryItem> items;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay.firstStretchEmpty = true;
      await r.recordAndStop();
      await r.settle(attempts: 2);
      items = await PendingRecoveryStore(
        runner: r.controller.backfill,
        sourceLang: () => 'zh',
      ).list();
      r.relay.firstStretchEmpty = false;
      final String id = r.relay.recoveryStarts.first['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.settle(attempts: 3);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts.length, greaterThanOrEqualTo(2),
        reason: 'positive control: both stretches were fed');
    final PendingRecoveryItem item = items.single;
    expect(item.actions, contains(PendingRecoveryAction.retryNow),
        reason: 'the audio of the empty stretch is kept; a retry is the only '
            'thing that can bring its words back');
    expect(r.relay.recoveryStarts, hasLength(3), reason: 'the retry ran');
    expect(r.relay.recoveryStarts.last['range_start_sample'], 44000 * 16,
        reason: 'and it fed the stretch that came back empty');
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_hole1.allMatches(all), hasLength(1));
    expect(_between.allMatches(all), hasLength(1));
    expect(r.rows.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0)),
        _totalMs,
        reason: 'the time the empty stretch gave back is taken back when its '
            'words arrive: counted once, the head reads 2:45');
  });

  testWidgets(
      '🔴 Codex rc2 follow-up: the take-back write of a reopened empty stretch '
      'does not reach storage ⇒ the audio stays and the stretch stays owed; the '
      'next retry settles and the head read from storage is correct',
      (WidgetTester tester) async {
    late final _Rig r;
    late final RecordingManifest afterRefused;
    late final bool pcmAfterRefused;
    late final List<TimelineEntry> disk;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay.firstStretchEmpty = true;
      await r.recordAndStop();
      await r.settle(attempts: 2);
      r.relay.firstStretchEmpty = false;
      // Only the take-back: the spanning row moved back to 60 s.
      r.persistence.refuse = (TimelineEntry e) =>
          e.displayText == _span1 && e.articleOffsetMs == 60000;
      final String id = r.relay.recoveryStarts.first['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.settle(attempts: 3);
      afterRefused = (await r.manifest())!;
      pcmAfterRefused = r.pcmPresent;
      r.persistence.refuse = null;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.settle(attempts: 4);
      disk = await articleMembersOnDisk(r.timeline, r.articleId!);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(pcmAfterRefused, isTrue,
        reason: 'the take-back is not on disk: storage would count the stretch twice');
    expect(afterRefused.settled, isFalse);
    expect(afterRefused.owedRanges.first.isOwed, isTrue,
        reason: 'the first stretch is still owed');
    expect(r.relay.recoveryStarts, hasLength(4), reason: 'positive control');
    expect(r.relay.recoveryStarts[2]['range_start_sample'], 44000 * 16);
    // The retry that settles.
    expect(r.pcmPresent, isFalse);
    expect(_hole1.allMatches(disk.map((TimelineEntry e) => e.displayText).join('\n')),
        hasLength(1));
    expect(disk.fold<int>(0, (int s, TimelineEntry e) => s + (e.durationMs ?? 0)),
        _totalMs,
        reason: 'the head read back from storage: 2:45, the stretch counted once');
  });
}