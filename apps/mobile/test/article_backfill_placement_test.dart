// 🔴 CARD RC-3 — THE CR-12-E RECORDING, REPLAYED ON THE SCREEN IT WAS READ ON.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.7 / §1.8 / §5 RC-3
//   test/article_screen_test.dart (the mount pattern and the `runAsync` rule)
//
// ── WHAT THE DEVICE SHOWED (A1, 2026-09-23) ─────────────────────────────────
//
// A 6:38 long recording. The relay lost its speech engine at 1:57; the phone
// kept recording and journalling. Ten minutes later the recovery queue fed the
// whole 398 s back and got eight words. The list then said 「8:36 · 3 parts」:
// the third part ran 01:57–08:36 and held 「今天上午我们先。」 — the recording's
// OPENING, pasted at its end. The page said 7:01 was 「awaiting confirmation」,
// and nothing ever retried it.
//
// Three phone-side causes, each pinned below:
//   ① the journal leg never opened the replay cursor, so the row went out on the
//      live clock (after 1:57) with the whole range's length (398 s);
//   ② the range always started at byte 0 — no 「already transcribed」 prefix;
//   ③ a receipt that said 「short」 was filed as `settled_unverified`, i.e.
//      「kept, never retried」.
//
// ⚠️ THE NUMBERS ARE THE DEVICE'S: rows of 86,315 ms and 31,351 ms (A1.db u4,
// u5), 398,480 ms captured (relay.log `audioMs`). The PCM is held by an
// in-memory journal filesystem (support/memory_journal_fs.dart) so that
// 12.75 MB of it never lands on anybody's disk.
//
// ⚠️ UNDER `tester.runAsync`, like article_screen_test.dart and for its reason:
// the production chain awaits real timers.

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
import 'package:flowmic/src/session/recovery_backoff.dart';
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
import 'support/temp_teardown.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

// The device's numbers (A1.db / relay.log, root-cause §1.1).
const int _u4Ms = 86315;
const int _u5Ms = 31351;
const int _prefixMs = _u4Ms + _u5Ms; // 117,666 — where the engine went away
const int _totalMs = 398480; // 6:38.48
const int _bytesPerMs = 32; // 16 kHz mono s16le

const String _u4Text = '今天上午我们先开个短会，把库存口径对一下。';
const String _u5Text = '珊瑚二号，先在备份上把每一步演练一次。';
const String _tailText = '下午的发布推迟到四点，灰度先放百分之五。';
const String _eightWords = '今天上午我们先。';
const String _shortAgain = '下午的发布推迟。'; // RC-3b — a second short answer
const String _userEdit = '今天上午我们先开短会（我补的）。'; // RC-3b — the user's edit

/// The relay, as far as this card needs one: it takes the frames, answers the
/// live stop with the empty terminal final an engine-less session produces,
/// and answers a recovery stop with whatever [recoveryText] says, on a receipt
/// shaped by [recoveryEndedNormally] / [recoveryWithReceipt].
class _Relay extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunks = 0;
  String recoveryText = _tailText;
  bool recoveryEndedNormally = true;
  bool recoveryWithReceipt = true;

  // Any attempt the recovery leg opens: `auto_retry` or the user's
  // `user_retranscribe`. A live press says `live` (or nothing, legacy).
  static bool _isRecovery(Map<String, Object?> s) =>
      s['attempt_kind'] == 'auto_retry' ||
      s['attempt_kind'] == 'user_retranscribe';

  bool get _inRecovery => starts.isNotEmpty && _isRecovery(starts.last);

  List<Map<String, Object?>> get recoveryStarts => <Map<String, Object?>>[
        for (final Map<String, Object?> s in starts)
          if (_isRecovery(s)) s,
      ];

  @override
  void emit(String event, Object? payload) {
    if (event == FlowMicEvents.audioChunk) {
      // Counted, not recorded: two recordings' worth of frames is ~34 MB of
      // base64 that no assertion reads.
      if (currentStatus != SocketStatus.connected) {
        throw StateError('fake relay: chunk while $currentStatus');
      }
      chunks += 1;
      // An engine answers as it goes. Without this the recovery's in-flight
      // window (recovery_leg_wire.dart) waits for a progress that never comes.
      // ⚠️ 更正（integ merge RC-phone × RC-backfill，2026-09-24）：原为 an interim with
      // no `acked_audio_ms`. RC-2 paces the recovery feed by that field and, when a
      // relay sends none, at 2× real time — this file runs on real timers, so the
      // 281 s owed range took ~140 s and ran past `recoveryDone`'s 60 s deadline.
      // The relay this card ships with (RC-2) reports what its engine processed;
      // this fake engine processes at once, i.e. everything it was handed.
      // Frames are 6400 bytes = 200 ms (`recovery_range_coordinates_test.dart`).
      // ⚠️ 更正（RC-M，2026-09-24）：原为 every 64 frames (12.8 s). The feed now
      // runs at most 10 s ahead of the last report, so a report every 12.8 s
      // left it on the 2× fallback between reports; a real engine reports far
      // more often than that.
      if (_inRecovery && chunks % 16 == 0) {
        final int acked = chunks * 200;
        Future<void>.microtask(() => pushIncoming(
              FlowMicEvents.sttInterim,
              <String, Object?>{'text': '…', 'segment_idx': 0, 'acked_audio_ms': acked},
            ));
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
          'text': recovery ? recoveryText : '',
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': recovery ? 0 : 2,
          'is_segment': false,
          'duration_ms': recovery ? 5000 : 0,
          if (!recovery || recoveryWithReceipt) ...<String, Object?>{
            'coverage_receipt_version': 1,
            'fed_frames': fed,
            'seq_gaps': 0,
            'drops': 0,
            'engine_leg_rollovers': 0,
            'ended_normally': recovery ? recoveryEndedNormally : false,
            'recording_id': s['recording_id'],
            'attempt_id': s['attempt_id'],
            'range_start_sample': s['range_start_sample'],
            'range_end_sample': s['range_end_sample'],
          },
        });
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.fs, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rc3-');
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

  Future<void> _final(String text, int idx, int durationMs) async {
    relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': true,
      'duration_ms': durationMs,
    });
    await pumpEventQueue();
  }

  /// A1 as it happened, on the phone's side: two live rows, then the relay
  /// says it lost the engine (and never gets it back), the user keeps talking
  /// to 6:38 and presses stop.
  Future<void> recordA1AndStop() async {
    articleId = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    );
    await controller.pttDown();
    await _feedMs(_prefixMs);
    await _final(_u4Text, 0, _u4Ms);
    await _final(_u5Text, 1, _u5Ms);
    relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting',
      'provider': 'soniox',
      'retry_count': 1,
    });
    await pumpEventQueue();
    await _feedMs(_totalMs - _prefixMs);
    await controller.pttUp();
  }

  /// Wait until the owed-tail sweep has run one recovery to its end.
  Future<void> recoveryDone({int attempts = 1}) async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 60));
    while (DateTime.now().isBefore(deadline)) {
      if (relay.recoveryStarts.length >= attempts && !controller.backfill.isBusy) {
        break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await pumpEventQueue();
  }

  Future<RecordingManifest?> manifest() async {
    for (final String p in fs.paths) {
      if (p.endsWith(RetainedAudioJournal.manifestSuffix)) {
        return RecordingManifest.decode(
            String.fromCharCodes(await fs.readBytes(p)));
      }
    }
    return null;
  }

  bool get pcmPresent =>
      fs.paths.any((String p) => p.endsWith(RetainedAudioJournal.pcmSuffix));

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

void main() {
  testWidgets(
      '🔴 RC-3: a 6:38 recording that lost its engine at 1:57 reads 6:38, and '
      'the recovered words sit at 01:57 — not the opening pasted at the end',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      await r.recordA1AndStop();
      await r.recoveryDone();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The attempt ran, from the prefix — or everything below is vacuous.
    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(1), reason: 'positive control: the owed-tail sweep ran');
    expect(rec.single['range_start_sample'], _prefixMs * 16,
        reason: '② the range starts after the words the live rows already have');

    final List<TimelineEntry> rows = r.rows;
    expect(rows, hasLength(3));
    final TimelineEntry tail = rows.last;
    expect(tail.displayText, _tailText);
    expect(tail.articleOffsetMs, _prefixMs,
        reason: '① on the replay cursor, where the engine went away');
    expect(tail.durationMs, _totalMs - _prefixMs,
        reason: 'the range we fed, not the whole recording');
    expect(
      rows.where((TimelineEntry e) => e.displayText.contains('今天上午我们先')),
      hasLength(1),
      reason: 'the opening exists once, at 00:00',
    );
    // FX-4 / O-1: a settled recovery releases the bytes.
    expect((await tester.runAsync<RecordingManifest?>(r.manifest))!.settled, isTrue);
    expect(r.pcmPresent, isFalse);

    await _mountAndOpen(tester, r);
    // 🔴 THE HEAD, AS THE USER READS IT. 6:38 ± 1 s, three parts.
    final String meta = _textOf(tester, const Key('article.meta'));
    expect(
      <String>[
        for (final int s in <int>[397, 398, 399])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 3),
      ],
      contains(meta),
      reason: 'the device read 8:36 here (1:57 + 6:38)',
    );
    // The paragraph holding the tail ends where the recording ends. (The
    // paragraph rule may join the tail to the row before it — design §3 — so
    // the label's START is that row's; its END is the fact the device got
    // wrong: 「01:57–08:36」.) The row's own offset is asserted on the model
    // above, where the paragraph rule cannot blur it.
    int? tailIdx;
    for (int k = 0; k < 3; k++) {
      final Finder f = find.byKey(Key('article.paragraph.$k.text'));
      if (f.evaluate().isNotEmpty &&
          _textOf(tester, Key('article.paragraph.$k.text')).contains(_tailText)) {
        tailIdx = k;
      }
    }
    expect(tailIdx, isNotNull, reason: 'the recovered words are on the page');
    expect(
      <String>['06:37', '06:38', '06:39'].any(
          _textOf(tester, Key('article.paragraph.$tailIdx')).endsWith),
      isTrue,
      reason: 'got ${_textOf(tester, Key('article.paragraph.$tailIdx'))}',
    );
    expect(_textOf(tester, Key('article.paragraph.$tailIdx.text')),
        isNot(contains('今天上午我们先')));
    expect(find.byKey(const Key('article.backfill')), findsNothing,
        reason: 'nothing is owed any more');
  });

  testWidgets(
      '🔴 RC-3: eight words back on a receipt that says 「short」 are a '
      'SHORTFALL — kept, not auto-retried (ruling 2026-09-06 §3), manual retry '
      'offered — not settled_unverified', (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay
        ..recoveryText = _eightWords
        ..recoveryEndedNormally = false; // the relay's 3 s flush cap fired
      await r.recordA1AndStop();
      await r.recoveryDone();
      // Another automatic pass must leave it alone.
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.recoveryDone();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'one attempt, and no automatic second one');
    final RecordingManifest m =
        (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.recoveryState, isNot(RecoveryQueueState.settledUnverified),
        reason: '③ 「only the proof is missing」 is not what happened');
    expect(m.recoveryState, RecoveryQueueState.shortfall);
    expect(m.nextEligibleAtMs, isNull, reason: 'no backoff loop');
    expect(m.attempts.last.outcome, JournalAttempt.outcomeFailed);
    expect(m.attempts.last.failureCode, contains('notEndedNormally'));
    expect(m.settled, isFalse);
    expect(m.transcribedPrefixBytes, _prefixMs * _bytesPerMs,
        reason: 'the owed range is still the tail, not the whole recording');
    expect(r.pcmPresent, isTrue, reason: 'not one byte goes on a shortfall');
    // The user's retry is offered.
    final List<PendingRecoveryItem> items = (await tester
        .runAsync<List<PendingRecoveryItem>>(() => PendingRecoveryStore(
              runner: r.controller.backfill,
              sourceLang: () => 'zh',
            ).list()))!;
    final PendingRecoveryItem item = items.single;
    expect(item.state, PendingRecoveryState.shortfall);
    expect(item.actions, contains(PendingRecoveryAction.retryNow));
  });

  testWidgets(
      '🔴 RC-3: a manual retry of a shortfall that comes back whole REPLACES '
      'the partial rows — one set of words, three parts, still 6:38',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay
        ..recoveryText = _eightWords
        ..recoveryEndedNormally = false;
      await r.recordA1AndStop();
      await r.recoveryDone();
      r.relay
        ..recoveryText = _tailText
        ..recoveryEndedNormally = true;
      final String id =
          r.relay.recoveryStarts.single['recording_id']! as String;
      final PendingRetryOutcome out = await r.controller.backfill
          .retranscribe(recordingId: id, sourceLang: 'zh');
      expect(out, PendingRetryOutcome.done);
      await r.recoveryDone(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2),
        reason: 'positive control: the manual retry ran');
    final List<TimelineEntry> rows = r.rows;
    expect(rows.map((TimelineEntry e) => e.displayText),
        isNot(contains(_eightWords)),
        reason: 'the partial words are replaced, not kept beside the tail');
    expect(rows, hasLength(3));
    expect(rows.last.displayText, _tailText);
    expect(rows.last.articleOffsetMs, _prefixMs);

    await _mountAndOpen(tester, r);
    final String meta = _textOf(tester, const Key('article.meta'));
    expect(
      <String>[
        for (final int sec in <int>[397, 398, 399])
          _zh.articleCardMeta(formatEntryDuration(sec * 1000), 3),
      ],
      contains(meta),
      reason: 'both sets counted would read 11:19 · 4 parts',
    );
    expect(find.textContaining(_eightWords), findsNothing);
  });

  testWidgets(
      '🔴 RC-3b: a manual retry that comes back SHORT AGAIN replaces the first '
      'partial rows too — one partial set on the page, never two',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay
        ..recoveryText = _eightWords
        ..recoveryEndedNormally = false;
      await r.recordA1AndStop();
      await r.recoveryDone();
      r.relay.recoveryText = _shortAgain; // still ended_normally:false
      final String id =
          r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill
          .retranscribe(recordingId: id, sourceLang: 'zh');
      await r.recoveryDone(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2),
        reason: 'positive control: the manual retry ran');
    final List<String> texts =
        r.rows.map((TimelineEntry e) => e.displayText).toList();
    expect(texts, contains(_shortAgain));
    expect(texts, isNot(contains(_eightWords)),
        reason: 'the first partial set is replaced, not kept beside the second');
    expect(r.rows, hasLength(3));
    final RecordingManifest m =
        (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.recoveryState, RecoveryQueueState.shortfall,
        reason: 'still short: still owed, still manual');
    expect(r.pcmPresent, isTrue);

    await _mountAndOpen(tester, r);
    expect(find.textContaining(_eightWords), findsNothing);
    expect(find.textContaining(_shortAgain), findsOneWidget);
  });

  testWidgets(
      '🔴 RC-3b: the user EDITED the whole-range partial row ⇒ the edit stays '
      'AND the new rows are added; the range settles — nothing thrown away, '
      'never stuck',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay
        ..recoveryText = _eightWords
        ..recoveryEndedNormally = false;
      await r.recordA1AndStop();
      await r.recoveryDone();
      final TimelineEntry partial = r.rows
          .singleWhere((TimelineEntry e) => e.displayText == _eightWords);
      // Positive control on the match: the partial row IS the whole range.
      expect(partial.articleOffsetMs, _prefixMs);
      expect(partial.durationMs, _totalMs - _prefixMs);
      r.timeline.applyEdit(partial.id, _userEdit);
      r.relay
        ..recoveryText = _tailText
        ..recoveryEndedNormally = true;
      final String id =
          r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill
          .retranscribe(recordingId: id, sourceLang: 'zh');
      await r.recoveryDone(attempts: 2);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2),
        reason: 'positive control: the manual retry ran');
    final List<String> texts =
        r.rows.map((TimelineEntry e) => e.displayText).toList();
    expect(texts, contains(_userEdit), reason: 'the edit by the user stays');
    expect(texts, contains(_tailText),
        reason: 'and so do the new words: the user deletes the copy they do not want');
    expect(r.rows, hasLength(4));
    final RecordingManifest m =
        (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.attempts.last.outcome, JournalAttempt.outcomeSettled);
    expect(m.recoveryState, RecoveryQueueState.settled);
    expect(m.settled, isTrue, reason: 'not stuck: nothing left owed');

    await _mountAndOpen(tester, r);
    expect(find.textContaining(_tailText), findsOneWidget);
    expect(find.textContaining(_userEdit), findsOneWidget);
  });

  testWidgets(
      'RC-3 positive control: words back with NO receipt keep the '
      'settled_unverified meaning 「only the proof is missing」',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.relay.recoveryWithReceipt = false;
      await r.recordA1AndStop();
      await r.recoveryDone();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.recoveryState, RecoveryQueueState.settledUnverified);
    expect(m.attempts.last.failureCode, contains('noReceipt'));
    expect(r.rows.last.articleOffsetMs, _prefixMs);
  });

  testWidgets(
      '🔴 RC-3 (NR-96 card F, phone half): while the engine is down the chat '
      'page says the recording goes on AND the audio is kept — not 「link down」',
      (WidgetTester tester) async {
    late final _Rig r;
    await tester.runAsync(() async {
      r = await _Rig.open();
      r.articleId = r.session.beginContinuous(
        cap: const Duration(minutes: 30),
        onWarning: () {},
      );
      await r.controller.pttDown();
      await r._feedMs(400);
    });
    addTearDown(() => tester.runAsync(() async {
          await r.controller.pttUp();
          await r.dispose();
        }));
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    expect(find.text(_zh.bannerContinuousEngineDownKept), findsNothing,
        reason: 'nothing is wrong yet');

    r.relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
      'status': 'reconnecting',
      'provider': 'soniox',
      'retry_count': 1,
    });
    await tester.pump();
    // The screen first: it is the deliverable (⑥); the model lines say why.
    expect(find.text(_zh.bannerContinuousEngineDownKept), findsOneWidget);
    expect(r.session.continuousOffline, ContinuousOffline.engineKept);
    expect(r.session.continuousCapturingOffline, isTrue);
    expect(find.text(_zh.bannerContinuousOffline), findsNothing,
        reason: 'the phone\'s link is fine; that sentence would send the user '
            'to fix the wrong thing');

    // `failed` ends the chip but not the outage: still owed, still said.
    r.relay.pushIncoming(FlowMicEvents.sttEngineStatus,
        <String, Object?>{'status': 'failed', 'provider': 'soniox'});
    await tester.pump();
    expect(find.text(_zh.bannerContinuousEngineDownKept), findsOneWidget);

    // A draft is a live leg: the banner goes.
    r.relay.pushIncoming(FlowMicEvents.sttInterim,
        <String, Object?>{'text': '回来了', 'segment_idx': 0});
    await tester.pump();
    expect(find.text(_zh.bannerContinuousEngineDownKept), findsNothing);
  });
}
