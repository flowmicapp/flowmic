// 🔴 CARD RC-G — AN ARTICLE PAGE SAYS WHAT *THIS* PIECE STILL OWES.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.5 / §6 G / §7 RC-G
//   test/article_backfill_placement_test.dart (the rig this one is cut from)
//
// ── WHAT THE DEVICE SHOWED (R100, CR-12-E re-run, 2026-09-24) ───────────────
//
// A piece that owed 1:35 said 「断网时录下的 10:51 还在转写」. 10:51 was the
// PHONE's debt: this piece's 1:35 plus other recordings' (one of which never
// lost the network at all), all read off `BackfillProgress.pendingMs` and all
// labelled 「recorded offline」 because ANY of them was.
//
// Two recordings here, both ending with the engine gone so each owes its tail
// (the RC-3 shape): A owes 1:35, B owes 6:23. The server advertises none of the
// recovery capabilities, so nothing is recovered and both debts stay on disk
// (tier C) — the state the device was in.
//
// ⚠️ UNDER `tester.runAsync`, like article_backfill_placement_test.dart and for
// its reason: the production chain awaits real timers.

import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_manifest.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart' show RecoveryQueueState;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart'
    show ArticleRig, SessionOwnerProbe, mountLightRecordScreen;
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/memory_journal_fs.dart';
import 'support/temp_teardown.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _bytesPerMs = 32; // 16 kHz mono s16le
const int _prefixMs = 10000; // one live row, then the engine goes
const int _owedA = 95000; // 1:35
const int _owedB = 383000; // 6:23

/// Takes frames, answers a live stop. [cleanStop] false ⇒ the empty terminal
/// final of an engine-less session (the recording owes its tail); true ⇒ a
/// terminal final with words on a whole receipt (nothing owed).
class _Relay extends FakeSocketTransport {
  int chunks = 0;
  int starts = 0;
  bool cleanStop = false;
  Map<String, Object?>? _start;

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      chunks += 1;
      return;
    }
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      _start = payload;
      starts += 1;
      chunks = 0;
    }
    if (event == FlowMicEvents.audioStop && _start != null) {
      final Map<String, Object?> s = _start!;
      final int fed = chunks;
      final bool clean = cleanStop;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': clean ? '收尾的一句。' : '',
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': 1,
          'is_segment': false,
          'duration_ms': clean ? 2000 : 0,
          'coverage_receipt_version': 1,
          'fed_frames': fed,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 0,
          'ended_normally': clean,
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
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rcg-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final MemoryJournalFs fs = MemoryJournalFs();
    final _Rig r = _Rig._(
      tmp,
      store,
      fs,
      RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs),
    );
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

  void _build() {
    relay = _Relay();
    session = newTestSession(
      transport: relay,
      audio: AudioCapture(recorder: recorder, spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    serverCan(false);
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

  /// [can] false: an ack that names NONE of the recovery capabilities ⇒ tier
  /// C: the debt is counted and nothing is attempted, as on the device.
  void serverCan(bool can) {
    session.reconnect.noteServerCapabilities(<String, Object?>{
      'capabilities': <String>[
        if (can) ...<String>[
          kCapabilityCoverageReceipt,
          kCapabilityDeliveryNoneSafe,
          kCapabilityIdempotentOperation,
        ],
      ],
    });
  }

  Future<void> _feedMs(int ms) async {
    recorder.feed(makePcm(ms * _bytesPerMs));
    await pumpEventQueue();
  }

  /// One long recording: a live row for [_prefixMs], then — unless
  /// [owedMs] is zero — the engine goes and [owedMs] more is spoken into the
  /// journal before stop. Returns the article id.
  Future<String> record({required int owedMs}) async {
    relay.cleanStop = owedMs == 0;
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    )!;
    await controller.pttDown();
    await _feedMs(_prefixMs);
    relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '第一段话，先说到这里。',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': true,
      'duration_ms': _prefixMs,
    });
    await pumpEventQueue();
    if (owedMs > 0) {
      relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
        'status': 'reconnecting',
        'provider': 'soniox',
        'retry_count': 1,
      });
      await pumpEventQueue();
      await _feedMs(owedMs);
    }
    await controller.pttUp();
    await _settle();
    return id;
  }

  Future<void> _segment(String text, int idx, int ms) async {
    relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': true,
      'duration_ms': ms,
    });
    await pumpEventQueue();
  }

  /// RC-K merge — ONE long recording that owes TWO stretches (the
  /// article_two_outages_test.dart shape, on this file's tier-C relay): 5 s of
  /// speech, the engine goes for 30 s, comes back having re-fed 12 s ⇒ 18 s
  /// owed; 15 s of live words; the same outage again ⇒ another 18 s owed; then
  /// a clean stop (the engine is up by then, so no owed tail). Returns the
  /// article id.
  Future<String> recordTwoOutages() async {
    relay.cleanStop = true;
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    )!;
    await controller.pttDown();
    await _feedMs(_prefixMs);
    await _segment('第一段话，先说到这里。', 0, _prefixMs);
    for (int i = 0; i < 2; i++) {
      await _feedMs(5000);
      relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
        'status': 'reconnecting',
        'provider': 'soniox',
        'retry_count': 1,
      });
      await pumpEventQueue();
      await _feedMs(30000);
      relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
        'status': 'ready',
        'provider': 'soniox',
        'replayed_ms': 12000,
      });
      await pumpEventQueue();
      await _feedMs(10000);
      await _segment('跨过这次断线的这一行。', 1 + 2 * i, 45000);
      await _feedMs(15000);
      await _segment('两次断线之间说的一段。', 2 + 2 * i, 15000);
    }
    await controller.pttUp();
    await _settle();
    return id;
  }

  Future<RecordingManifest> manifestOf(String articleId) async {
    for (final String path in fs.paths) {
      if (path.contains(articleId) &&
          path.endsWith(RetainedAudioJournal.manifestSuffix)) {
        return RecordingManifest.decode(
            String.fromCharCodes(await fs.readBytes(path)));
      }
    }
    throw StateError('no manifest for $articleId');
  }

  /// Wait for the stop to land and any owed-tail sweep to finish.
  Future<void> _settle() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 30));
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      if (session.recordingArticleId == null &&
          session.fsm.session == SessionState.idle &&
          !controller.backfill.isBusy) {
        break;
      }
    }
    await pumpEventQueue();
  }

  /// One more pass, so the published progress is the tally over every
  /// recording on disk.
  Future<void> tally() async {
    await controller.backfill.sweep(sourceLang: 'zh');
    await _settle();
  }

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

Future<void> _mountAndOpen(WidgetTester tester, _Rig r, String articleId) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  final Finder tile = find.byWidgetPredicate(
    (Widget w) => w is ChatArticleTile && w.entry.articleId == articleId,
  );
  expect(tile, findsOneWidget, reason: 'positive control: the piece is listed');
  await tester.tap(tile);
  await tester.pumpAndSettle();
  expect(find.byType(ArticlePage), findsOneWidget,
      reason: 'positive control: the screen the user reads the piece on');
}

String _textOf(WidgetTester tester, Key key) {
  final Text t = tester.widget<Text>(find.byKey(key));
  return t.data ?? t.textSpan!.toPlainText();
}

/// Within a second of [ms]: the journal counts whole frames.
Matcher _about(int ms) => inInclusiveRange(ms - 1000, ms + 1000);

void main() {
  testWidgets(
      '🔴 RC-G: two pieces owe 1:35 and 6:23 — piece A\'s page says 1:35, not '
      'the phone\'s 7:58', (WidgetTester tester) async {
    late final _Rig r;
    late final String a;
    late final String b;
    await tester.runAsync(() async {
      r = await _Rig.open();
      a = await r.record(owedMs: _owedA);
      b = await r.record(owedMs: _owedB);
      await r.tally();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // Positive controls: both debts exist, and the phone's total is the number
    // the page must NOT print — or the assertion below is vacuous.
    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.pendingMs, _about(_owedA + _owedB),
        reason: 'the phone owes both pieces');
    expect(p.forArticle(a).pendingMs, _about(_owedA));
    expect(p.forArticle(b).pendingMs, _about(_owedB));
    expect(p.forArticle(a).fromOutage, isTrue,
        reason: 'an owed tail is an outage (RC-3)');

    await _mountAndOpen(tester, r, a);
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillPending(formatEntryDuration(p.forArticle(a).pendingMs)),
      reason: 'this piece\'s 1:35, not the phone\'s '
          '${formatEntryDuration(p.pendingMs)}',
    );
  });

  testWidgets(
      '🔴 RC-G: a piece that owes nothing has no 「still transcribing」 line, '
      'while another piece owes 6:23', (WidgetTester tester) async {
    late final _Rig r;
    late final String clean;
    await tester.runAsync(() async {
      r = await _Rig.open();
      // The clean piece is recorded against a server that CAN settle it, so
      // its bytes are released. The tier-C variant (bytes kept as
      // `settled_unverified`) is the follow-up case below.
      r.serverCan(true);
      clean = await r.record(owedMs: 0);
      r.serverCan(false);
      await r.record(owedMs: _owedB);
      await r.tally();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.pendingMs, _about(_owedB),
        reason: 'positive control: the phone owes the other piece');
    expect(p.forArticle(clean).pendingMs, 0);

    await _mountAndOpen(tester, r, clean);
    expect(find.byKey(const Key('article.backfill')), findsNothing,
        reason: 'the other piece\'s debt is not this one\'s');
  });

  testWidgets(
      '🔴 RC-G: the live form of the page (ArticlePage.live) reads the same '
      'per-piece number', (WidgetTester tester) async {
    late final _Rig r;
    late final String a;
    await tester.runAsync(() async {
      r = await _Rig.open();
      a = await r.record(owedMs: _owedA);
      await r.record(owedMs: _owedB);
      await r.tally();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: ArticlePage.live(
        controller: r.controller,
        articleId: a,
        strings: _zh,
        bar: () => null,
      ),
    ));
    await tester.pump();
    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.pendingMs, _about(_owedA + _owedB), reason: 'positive control');
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillPending(formatEntryDuration(p.forArticle(a).pendingMs)),
    );
  });

  testWidgets(
      '🔴 RC-G: the 「recorded offline」 sentence follows THIS piece\'s debt — '
      'another piece\'s outage does not lend it to this one',
      (WidgetTester tester) async {
    late final _Rig r;
    late final String a;
    await tester.runAsync(() async {
      r = await _Rig.open();
      a = await r.record(owedMs: _owedA);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // A phone whose total debt includes an outage, while THIS piece's own
    // debt did not come from one (a receipt that never came, say). Written
    // straight onto the notifier: the chain cannot yet produce a non-outage
    // journal debt without the settle path lane RC-B is changing.
    r.controller.backfill.progress.value = BackfillProgress(
      pendingMs: _owedA + _owedB,
      pendingFromOutage: true,
      running: false,
      byArticle: <String, ArticleBackfill>{
        a: const ArticleBackfill(pendingMs: _owedA, fromOutage: false),
        'some-other-piece': const ArticleBackfill(pendingMs: _owedB, fromOutage: true),
      },
    );

    await _mountAndOpen(tester, r, a);
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillUnconfirmed(formatEntryDuration(_owedA)),
    );
  });

  testWidgets(
      '🔴 RC-G: the 「+」 panel opens a piece with ITS debt, not the phone total',
      (WidgetTester tester) async {
    final ArticleRig rig = ArticleRig();
    addTearDown(rig.dispose);
    await mountLightRecordScreen(tester, rig);
    late String id;
    await tester.runAsync(() async => id = await rig.recordThreeAndStop());
    await tester.runAsync(pumpEventQueue);
    final TimelineEntry head = rig.store.entries.singleWhere(
      (TimelineEntry e) => e.entryType == TimelineEntry.kArticle,
    );
    expect(head.articleId, id, reason: 'positive control: the piece exists');

    final ValueNotifier<BackfillProgress> backfill =
        ValueNotifier<BackfillProgress>(BackfillProgress(
      pendingMs: _owedA + _owedB,
      pendingFromOutage: true,
      running: false,
      byArticle: <String, ArticleBackfill>{
        id: const ArticleBackfill(pendingMs: _owedA, fromOutage: true),
        'some-other-piece':
            const ArticleBackfill(pendingMs: _owedB, fromOutage: true),
      },
    ));
    addTearDown(backfill.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PlusPanelNotesTab(
          strings: _zh,
          query: LightRecordQuery(persistence: rig.persistence),
          isSignedIn: () => true,
          backfill: backfill,
        ),
      ),
    ));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey<String>('plus.notes.article.${head.id}')));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    expect(find.byType(ArticlePage), findsOneWidget, reason: 'positive control');
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillPending(formatEntryDuration(_owedA)),
    );
  });

  testWidgets(
      '🔴 RC-K merge: one piece owes TWO stretches (18 s + 18 s) — its page '
      'says their sum, 0:36, not the next stretch alone and not another '
      'piece\'s 6:23', (WidgetTester tester) async {
    late final _Rig r;
    late final String two;
    late final RecordingManifest twoManifest;
    await tester.runAsync(() async {
      r = await _Rig.open();
      two = await r.recordTwoOutages();
      await r.record(owedMs: _owedB);
      await r.tally();
      twoManifest = await r.manifestOf(two);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // Positive controls: the piece really owes two stretches, still owed (tier
    // C recovers nothing), and each is 18 s — so a tally that read only the
    // NEXT stretch (`_Candidate.range`) would print 0:18, and one that read the
    // phone would print 6:59. Both are distinguishable from the answer.
    final List<OwedRange> owed =
        twoManifest.owedRanges.where((OwedRange o) => o.isOwed).toList();
    expect(owed, hasLength(2), reason: 'two outages ⇒ two owed stretches');
    for (final OwedRange o in owed) {
      // ⚠️ 更正（RC-L，2026-09-24）：原为 18 s — each stretch now reaches 1 s past
      // both ends (`kOwedEdgeMs`), so 18 s of hole is owed as 20 s.
      expect((o.end! - o.start) ~/ _bytesPerMs, _about(20000));
    }
    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.pendingMs, _about(40000 + _owedB),
        reason: 'the phone owes both pieces');
    expect(p.forArticle(two).pendingMs, _about(40000),
        reason: 'the sum over this piece\'s stretches, and only this piece');
    expect(p.forArticle(two).fromOutage, isTrue);

    await _mountAndOpen(tester, r, two);
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillPending(formatEntryDuration(p.forArticle(two).pendingMs)),
      reason: 'this piece\'s 0:36, not the next stretch\'s 0:18 and not the '
          'phone\'s ${formatEntryDuration(p.pendingMs)}',
    );
  });

  testWidgets(
      '🔴 RC-G follow-up: a clean recording kept as settled_unverified has NO '
      'pending line on its page; an owed range on the same phone does',
      (WidgetTester tester) async {
    late final _Rig r;
    late final String clean;
    late final String owed;
    late final RecordingManifest cleanManifest;
    await tester.runAsync(() async {
      r = await _Rig.open();
      // Tier C throughout: the clean piece's live settle keeps its bytes as
      // `settled_unverified` (`serverTierKeepsBytes`) — every word is a row.
      clean = await r.record(owedMs: 0);
      owed = await r.record(owedMs: _owedA);
      await r.tally();
      for (final String path in r.fs.paths) {
        if (path.contains(clean) &&
            path.endsWith(RetainedAudioJournal.manifestSuffix)) {
          cleanManifest = RecordingManifest.decode(
              String.fromCharCodes(await r.fs.readBytes(path)));
        }
      }
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // Positive controls: the clean piece really is in the unverified state,
    // and its bytes are still held and still counted by the PHONE (the
    // pending-recovery screen's business) — so the page's silence below is
    // the filter, not an absence of data.
    expect(cleanManifest.recoveryState, RecoveryQueueState.settledUnverified);
    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.settledUnverified, 1);
    expect(p.pendingMs, _about(_prefixMs + _owedA),
        reason: 'the phone total still holds the clean 10 s');

    await _mountAndOpen(tester, r, clean);
    expect(find.byKey(const Key('article.backfill')), findsNothing,
        reason: 'every word of this piece is on the page');
    expect(p.forArticle(clean).pendingMs, 0);

    await tester.pageBack();
    await tester.pumpAndSettle();
    await _mountAndOpen(tester, r, owed);
    expect(
      _textOf(tester, const Key('article.backfill.text')),
      _zh.articleBackfillPending(formatEntryDuration(p.forArticle(owed).pendingMs)),
    );
    expect(p.forArticle(owed).pendingMs, _about(_owedA));
  });
}
