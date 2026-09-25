// Card CR-12-D — `pause_before_ms` on the phone: off the wire, onto the row,
// through the payload column, and back.
//
// 🔴 WHAT THESE ROWS ARE DEFENDING IS THE DIFFERENCE BETWEEN null AND 0.
// The number says 「这一段开始前静了多久」; the paragraph rule (card CR-12-A) splits
// on it. Four separate causes make it unknowable — an old relay that strips the
// key, an engine with no word timestamps, an engine reconnect, and a row that
// covers more than one engine segment — and every one of them has to land on
// null, because a 0 is a CLAIM that the speaker did not stop. The failure this
// prevents is invisible: a 0 reads as a perfectly ordinary measurement.
//
// 🔴 WALKS THE REAL CHAIN for the reason `article_rows_test.dart` writes down:
// the interesting part sits BETWEEN the wire parser, the settle path and the
// store, and a test that called any one of them directly would measure what
// this file believes the others do.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flowmic/src/timeline/article.dart';
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  /// [extra] is what a NEWER relay adds to the frame. Passing nothing is what
  /// an OLDER relay sends — the compat direction, produced by omission rather
  /// than by a flag, so the two cases really do differ by one key.
  Future<void> pushFinal({
    required String text,
    required int idx,
    required bool isSegment,
    required int durationMs,
    Map<String, Object?> extra = const <String, Object?>{},
  }) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': isSegment,
      'duration_ms': durationMs,
      ...extra,
    });
    await pumpEventQueue();
  }

  Future<String> startContinuous() async {
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    )!;
    await controller.pttDown();
    return id;
  }

  List<TimelineEntry> membersOf(String articleId) =>
      articleMembersOf(store, articleId);

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
  }
}

void main() {
  test('a relay that sends the field puts it on the row it belongs to',
      () async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final String articleId = await r.startContinuous();
    await r.pushFinal(text: '第一段', idx: 0, isSegment: true, durationMs: 30000);
    await r.pushFinal(
      text: '第二段',
      idx: 1,
      isSegment: true,
      durationMs: 30000,
      extra: <String, Object?>{'pause_before_ms': 5040},
    );
    await r.controller.pttUp();
    await r.pushFinal(text: '第三段', idx: 2, isSegment: false, durationMs: 15000);

    final List<TimelineEntry> rows = r.membersOf(articleId);
    expect(rows, hasLength(3));
    // Row 0 carried no field (segment 0 has no predecessor) ⇒ null, not 0.
    // Row 2 carried none either. Only the row that was told gets a number.
    expect(rows.map((TimelineEntry e) => e.pauseBeforeMs).toList(),
        <int?>[null, 5040, null]);
  });

  test('🔴 an OLD relay strips the key ⇒ every row reads null, and nothing else changes',
      () async {
    // The D-27 failure direction, exercised as a whole recording rather than as
    // one parse: the rows still exist, still carry their text and their offsets,
    // and the only thing missing is the thing that was never sent.
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final String articleId = await r.startContinuous();
    await r.pushFinal(text: '第一段', idx: 0, isSegment: true, durationMs: 30000);
    await r.pushFinal(text: '第二段', idx: 1, isSegment: true, durationMs: 30000);
    await r.controller.pttUp();
    await r.pushFinal(text: '第三段', idx: 2, isSegment: false, durationMs: 15000);

    final List<TimelineEntry> rows = r.membersOf(articleId);
    // POSITIVE CONTROL: the recording really did happen. Without this, three
    // nulls below could just as well mean 「no rows were built at all」.
    expect(rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>['第一段', '第二段', '第三段']);
    expect(rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 30000, 60000]);
    expect(rows.every((TimelineEntry e) => e.pauseBeforeMs == null), isTrue);
  });

  test('🔴 a row that covers more than one segment refuses the number',
      () async {
    // A soft-segment final that carried nothing settles nothing and does not
    // advance the watermark, so the NEXT row covers both spans. The pause the
    // server measured describes the start of the LAST of them — a real number
    // answering a different question. Null instead.
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final String articleId = await r.startContinuous();
    await r.pushFinal(text: '第一段', idx: 0, isSegment: true, durationMs: 30000);
    await r.pushFinal(text: '', idx: 1, isSegment: true, durationMs: 30000);
    await r.pushFinal(
      text: '第三段',
      idx: 2,
      isSegment: true,
      durationMs: 30000,
      extra: <String, Object?>{'pause_before_ms': 7000},
    );
    await r.controller.pttUp();
    await r.pushFinal(text: '尾', idx: 3, isSegment: false, durationMs: 5000);

    final List<TimelineEntry> rows = r.membersOf(articleId);
    // POSITIVE CONTROL: the empty span really was absorbed — the row that
    // follows it covers 60 s, so it is genuinely the multi-span case.
    final TimelineEntry wide =
        rows.firstWhere((TimelineEntry e) => e.displayText == '第三段');
    expect(wide.durationMs, 60000);
    expect(wide.pauseBeforeMs, isNull);
  });

  // 🔴 CR-12 integration — the whole chain in one case: a wire frame's
  // `pause_before_ms` becomes a paragraph break, with nothing injected. The
  // rule is called with no pause source, i.e. through `articlePauseBeforeMs`.
  //
  // Reverse check: `articlePauseBeforeMs` back to `=> null`
  //   => Expected: [[没有标点的一段话], [停过之后又说, 尾]]
  //      Actual:   [[没有标点的一段话, 停过之后又说, 尾]]
  // Restored; green.
  test('the paragraph rule reads the pause the wire carried', () async {
    Future<List<List<String>>> record(Map<String, Object?> extra) async {
      final _Rig r = _Rig();
      addTearDown(r.dispose);
      final String articleId = await r.startContinuous();
      // 45 s with no sentence end: only a >= 3 s pause can qualify the edge.
      await r.pushFinal(
          text: '没有标点的一段话', idx: 0, isSegment: true, durationMs: 45000);
      await r.pushFinal(
        text: '停过之后又说',
        idx: 1,
        isSegment: true,
        durationMs: 30000,
        extra: extra,
      );
      await r.controller.pttUp();
      await r.pushFinal(text: '尾', idx: 2, isSegment: false, durationMs: 5000);
      return <List<String>>[
        for (final ArticleParagraph p in paragraphsOf(r.membersOf(articleId)))
          <String>[for (final TimelineEntry e in p.rows) e.displayText],
      ];
    }

    expect(await record(<String, Object?>{'pause_before_ms': 5040}),
        <List<String>>[
          <String>['没有标点的一段话'],
          <String>['停过之后又说', '尾'],
        ]);
    // POSITIVE CONTROL and the old-relay direction in one: the same recording
    // without the key is one paragraph, so the split above is the field's doing.
    expect(await record(const <String, Object?>{}), <List<String>>[
      <String>['没有标点的一段话', '停过之后又说', '尾'],
    ]);
  });

  group('SttFinal.fromJson reads key by key', () {
    test('a missing key is null — 「我不知道」, never 0', () {
      final SttFinal? f = SttFinal.tryFromJson(<String, Object?>{
        'text': '话',
        'segment_idx': 1,
        'is_segment': true,
        'duration_ms': 30000,
      });
      expect(f, isNotNull);
      expect(f!.text, '话'); // POSITIVE CONTROL: the frame really did parse
      expect(f.pauseBeforeMs, isNull);
    });

    test('🔴 an unrecognised key is IGNORED — the new-relay/old-phone direction',
        () {
      // The other half of D-27's compat argument. A phone that rejected frames
      // carrying fields it does not know would turn every additive protocol
      // change into an outage; this is the shape that makes 「先中继、后 APK」 safe.
      final SttFinal? f = SttFinal.tryFromJson(<String, Object?>{
        'text': '话',
        'segment_idx': 1,
        'is_segment': true,
        'duration_ms': 30000,
        'pause_before_ms': 5040,
        'some_field_from_the_future': <String, Object?>{'nested': true},
      });
      expect(f, isNotNull);
      expect(f!.pauseBeforeMs, 5040);
      expect(f.durationMs, 30000);
    });

    test('a negative value is refused rather than stored', () {
      final SttFinal? f = SttFinal.tryFromJson(<String, Object?>{
        'text': '话',
        'segment_idx': 1,
        'is_segment': true,
        'duration_ms': 30000,
        'pause_before_ms': -5,
      });
      expect(f!.pauseBeforeMs, isNull);
    });
  });

  group('the payload column carries it with no migration', () {
    TimelineEntry rowWith(int? pause) => TimelineEntry(
          id: 'loc:dev:c1',
          clientId: 'c1',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          sourceText: '话',
          outputText: '话',
          status: EntryStatus.noted,
          createdAt: DateTime.utc(2026, 9, 22),
          updatedAt: DateTime.utc(2026, 9, 22),
          articleId: 'art-1',
          articleOffsetMs: 30000,
          pauseBeforeMs: pause,
        );

    test('round-trips through the JSON payload', () {
      final Map<String, Object?> j = timelineEntryToJson(rowWith(5040));
      expect(j['pause_before_ms'], 5040);
      expect(timelineEntryFromJson(j)!.pauseBeforeMs, 5040);
    });

    test('🔴 a legacy payload has no such key and decodes to null', () {
      final Map<String, Object?> legacy = timelineEntryToJson(rowWith(null));
      // ABSENT, not written as null: the same rule `article_offset_ms` follows.
      expect(legacy.containsKey('pause_before_ms'), isFalse);
      // POSITIVE CONTROL: the row itself decodes, so null below is the field's
      // answer and not a decode that returned nothing.
      final TimelineEntry? back = timelineEntryFromJson(legacy);
      expect(back!.articleOffsetMs, 30000);
      expect(back.pauseBeforeMs, isNull);
    });

    test('0 survives the round trip and is NOT turned into absence', () {
      // A measured zero — the speaker never stopped — must stay a measurement.
      final Map<String, Object?> j = timelineEntryToJson(rowWith(0));
      expect(j['pause_before_ms'], 0);
      expect(timelineEntryFromJson(j)!.pauseBeforeMs, 0);
    });
  });
}
