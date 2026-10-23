// 🔴 POL-M1 / R12 — A ROW IS FROZEN AT ITS FIRST HANDOFF TO ANY DELIVERY PATH.
//
// Contract: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §4 R12 and
// docs/rebuild/15-MESSAGE-STATES.md §2.0-c 「冻结规则」; design
// docs/strategy/2026-10-14-two-stage-polish-design.md §12.1 / §12.3 / §12.7.
// owner 2026-10-14: 「本地历史必须和投递出去的字一致」 — once a row's words have
// been handed to the PC (or a web target), no machine rewrite may change them on
// the phone. NR-261 was the live violation: `stt:refined` replaced the PC-path
// tail row although the PC had already typed the old words.
//
// WHAT THIS FILE PINS (every case drives the production chain — PTT, the real
// inbound `stt:refined` arm, the real outbox — never `_applyRefined` directly):
//   A. a delivered + acknowledged row: the refine is dropped, and the light-
//      record SCREEN still shows the words that went out (anti-façade ⑥);
//   B. a row still owed by the queue (no receipt yet) is already frozen —
//      the freeze is at handoff, not at receipt;
//   C. the 「+」 panel's ticked SOURCE row is frozen, not only the new row the
//      send builds;
//   D. a rewrite that lands BEFORE the handoff is what goes out (R2);
//   E. long-press deferred delivery freezes the row and sends the row's text;
//   F. the stamp persists, is write-once, and survives an FPR round trip;
//   G. the census: every place a row's text is handed to a delivery primitive
//      freezes first, before its first `await`.
//
// Each negative is paired with its positive control: the same refine DOES land
// on a row that was never handed off (a light record), so 「not rewritten」 below
// cannot be a refine that never arrived.
//
// ── reverse controls (measured red 2026-10-14, restored; see the card report) ──
// R-A. Drop the `isHandedOff` check in `_applyRefined`
//      (timeline_store_edit_family.dart; since the review fixes it lives in
//      `_refusesMachineRewrite`, shared with `_applyProcessed`) ⇒ A, B, C, E red.
// R-B. Move the freeze from handoff to receipt (no `markHandedOff` in
//      `_deliverDirect`; stamp it in `applyInjectResult` instead) ⇒ B red
//      (`isHandedOff` false while the queue still owes it), F and the
//      `_deliverDirect` census row red too; A still green (A has its receipt).
// R-C. Freeze only the new row in `sendPlusSelection` (drop its
//      `markHandedOff`) ⇒ C red.
// R-G. Drop the `markHandedOff` in `outboxSend` ⇒ G red, naming the function.

import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading, ServerChannel;
import 'package:flowmic/src/session/session_instance_owner.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String kSpoken = '下午三点开会';
const String kRefined = '下午三点开会，记得带材料';
const String kUtt = 'utt-pol-m1-0001';

Future<PttSession> _pairedSession(FakeSocketTransport t) async {
  final PttSession session = newTestSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  t.defaultAck = <String, Object?>{
    'token': 'tok-pol-m1-abcdefghijklmnopqrstuvwxyz12',
    'pairing_id': 'pair-pol-m1-1',
    'pc_id': 'pc-pol-m1-0001',
    'pc_name': 'POL-M1 Test PC',
  };
  final PairResult r = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://127.0.0.1:41883',
  );
  expect(r.ok, isTrue, reason: 'setup: pairing must succeed');
  t.defaultAck = <String, Object?>{'ok': true};
  await pumpEventQueue();
  return session;
}

class _Rig {
  _Rig._(this.transport, this.session) {
    store = newTestStore(owner: SessionInstanceOwner(session));
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
    session.serverChannel.value = ServerChannel.lan;
    transport.pushStatus(SocketStatus.connected);
  }

  static Future<_Rig> paired() async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    return _Rig._(t, await _pairedSession(t));
  }

  final FakeSocketTransport transport;
  final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// One press with a terminal final carrying [utteranceId]. Direct send ⇒ on
  /// the PC path the row is handed to the delivery the moment it lands.
  Future<TimelineEntry> speak(String text, {String utteranceId = kUtt}) async {
    expect(await controller.pttDown(), isTrue, reason: 'setup: PTT must arm');
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.92,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
      'utterance_id': utteranceId,
    });
    await pumpEventQueue();
    return store.entries.first;
  }

  /// The same press as a LIGHT RECORD: never handed off ⇒ rewritable.
  Future<TimelineEntry> speakNote(String text, {String utteranceId = kUtt}) async {
    destination.setRecordOnly();
    final TimelineEntry row = await speak(text, utteranceId: utteranceId);
    destination.setInject();
    expect(row.delivery, Delivery.none, reason: 'setup: a light record');
    expect(row.isHandedOff, isFalse, reason: 'setup: a light record is not handed off');
    return row;
  }

  /// The late second pass, through the production inbound arm.
  Future<void> refine(String text, {String utteranceId = kUtt}) async {
    transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': text,
      'utterance_id': utteranceId,
    });
    await pumpEventQueue();
  }

  List<Map<String, Object?>> get injectFrames => <Map<String, Object?>>[
    for (final EventEnvelope e in transport.emittedWhere(FlowMicEvents.injectRequest))
      (e.data! as Map<Object?, Object?>).cast<String, Object?>(),
  ];

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  // ── positive control: a never-handed-off row IS rewritten ─────────────────
  test('control: a light record (never handed off) is rewritten by the refine', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    await rig.refine(kRefined);
    expect(rig.store.findById(note.id)!.outputText, kRefined,
        reason: 'without this the negatives below could be a refine that never arrived');
    await rig.dispose();
  });

  // ── A: delivered + acknowledged, and the SCREEN keeps the delivered words ──
  testWidgets('A. a PC-path row delivered and acknowledged is never rewritten; the '
      'light-record screen still shows the words that went out', (WidgetTester tester) async {
    late _Rig rig;
    late TimelineEntry row;
    await tester.runAsync(() async {
      rig = await _Rig.paired();
      row = await rig.speak(kSpoken);
      expect(rig.injectFrames.single['text'], kSpoken, reason: 'setup: the words went out');
      rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': true,
        'mode': 'sendinput',
        'request_id': row.clientId,
        'entry_id': row.id,
      });
      await pumpEventQueue();
      expect(rig.store.findById(row.id)!.status, EntryStatus.injected,
          reason: 'setup: the PC acknowledged it');
      await rig.refine(kRefined);
    });
    addTearDown(() async => tester.runAsync(rig.dispose));

    final TimelineEntry after = rig.store.findById(row.id)!;
    expect(after.isHandedOff, isTrue);
    expect(after.outputText, kSpoken);
    expect(after.refinedAt, isNull, reason: 'applyRefined never wrote');

    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining(kSpoken), findsWidgets,
        reason: 'the row on screen shows what the PC typed');
    expect(find.textContaining(kRefined), findsNothing,
        reason: 'the refined words appear nowhere on the screen');
    await tester.pumpWidget(const SizedBox());
  });

  // ── B: queued (owed, no receipt) is already frozen ────────────────────────
  test('B. a row the queue still owes (no receipt yet) is already frozen — the freeze is '
      'at handoff, not at receipt', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await rig.speak(kSpoken);
    expect(rig.controller.outbox.owedEntryIds, contains(row.id),
        reason: 'setup: the delivery is owed (no inject:result has arrived)');
    expect(rig.transport.emittedWhere(FlowMicEvents.injectResult), isEmpty);
    expect(rig.store.findById(row.id)!.isHandedOff, isTrue);

    await rig.refine(kRefined);

    expect(rig.store.findById(row.id)!.outputText, kSpoken,
        reason: 'the queued item holds these words; history must too');
    expect(rig.store.findById(row.id)!.refinedAt, isNull);
    await rig.dispose();
  });

  // ── C: the 「+」 panel's ticked source row is frozen ───────────────────────
  test('C. 「+」 multi-select: the ticked SOURCE row is frozen, not only the new row', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    final int rowsBefore = rig.store.entries.length;

    await rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );

    expect(rig.injectFrames.single['text'], kSpoken, reason: 'setup: one message went out');
    expect(rig.store.entries.length, rowsBefore + 1, reason: 'setup: the send built its own row');
    final TimelineEntry built = rig.store.entries.first;
    expect(built.isHandedOff, isTrue, reason: 'the new row is frozen');
    expect(rig.store.findById(note.id)!.isHandedOff, isTrue,
        reason: 'and so is the row whose words it carried');

    await rig.refine(kRefined);

    expect(rig.store.findById(note.id)!.outputText, kSpoken,
        reason: 'the PC has these words; the source row keeps them');
    expect(rig.store.findById(note.id)!.refinedAt, isNull);
    await rig.dispose();
  });

  // ── D: rewrite first, handoff second ⇒ the rewritten words go out (R2) ────
  test('D. a rewrite that lands BEFORE the handoff is what goes out (history == delivered)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    await rig.refine(kRefined);
    final TimelineEntry rewritten = rig.store.findById(note.id)!;
    expect(rewritten.outputText, kRefined, reason: 'setup: rewritten while not handed off');

    await rig.controller.sendPlusSelection(
      text: rewritten.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[rewritten],
    );

    expect(rig.injectFrames.single['text'], kRefined);
    expect(rig.store.findById(note.id)!.displayText, rig.injectFrames.single['text']);
    await rig.dispose();
  });

  // ── E: long-press deferred delivery ───────────────────────────────────────
  test('E. long-press deferred delivery freezes the row and sends the text the row holds '
      'now, even from a stale snapshot', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry stale = await rig.speakNote(kSpoken);
    await rig.refine(kRefined);
    expect(rig.store.findById(stale.id)!.outputText, kRefined, reason: 'setup');

    rig.controller.reInject(stale); // the caller still holds the pre-refine snapshot
    await pumpEventQueue();

    expect(rig.injectFrames.single['text'], kRefined,
        reason: 'the words history shows are the words that go out (R2)');
    expect(rig.store.findById(stale.id)!.isHandedOff, isTrue);

    await rig.refine('又一遍机器改写', utteranceId: kUtt);
    expect(rig.store.findById(stale.id)!.outputText, kRefined,
        reason: 'frozen at the handoff');
    await rig.dispose();
  });

  // ── F: persistence + write-once + FPR ─────────────────────────────────────
  test('F. the stamp persists, cannot be cleared or moved, and survives an FPR round trip', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await rig.speak(kSpoken);
    final DateTime first = rig.store.findById(row.id)!.firstHandedOffAt!;

    // write-once: a second handoff keeps the first instant.
    await Future<void>.delayed(const Duration(milliseconds: 5));
    rig.store.markHandedOff(<String>[row.id]);
    expect(rig.store.findById(row.id)!.firstHandedOffAt, first);
    // copyWith cannot clear it.
    expect(rig.store.findById(row.id)!.copyWith(outputText: 'x').firstHandedOffAt, first);

    final Map<String, Object?> j = rig.store.findById(row.id)!.toJson();
    expect(j['first_handed_off_at'], first.toUtc().toIso8601String());
    expect(TimelineEntry.fromJson(j)!.firstHandedOffAt, first);
    expect(rig.store.findById(row.id)!.toHistoryItem(pcDeviceId: 'pc', userId: 'u'),
        isNot(contains('first_handed_off_at')), reason: 'device-local, never on the wire');

    // FPR (16 册 §4.2 2026-10-14 补注): exported in source_ext; imported row stays frozen.
    final rec = fprRecordOfRow(rig.store.findById(row.id)!);
    expect(rec.sourceExt['first_handed_off_at'], first.toUtc().toIso8601String());
    final TimelineEntry back = TimelineEntry.fromJson(rowJsonOfFpr(rec))!;
    expect(back.isHandedOff, isTrue);
    expect(back.firstHandedOffAt, first);

    // a row never handed off carries an explicit null (absence ≠ never delivered).
    final TimelineEntry note = await rig.speakNote('另一句', utteranceId: 'utt-pol-m1-0002');
    expect(note.toJson().containsKey('first_handed_off_at'), isTrue);
    expect(note.toJson()['first_handed_off_at'], isNull);
    await rig.dispose();
  });

  // ── G: the census ─────────────────────────────────────────────────────────
  group('G. census: every handoff of a row\'s text freezes before its first await', () {
    // Delivery primitives: putting a row's words in the durable queue, or a
    // frame on the wire. A new call site anywhere in lib/ turns this red until
    // it is registered below — either as freezing, or as exempt WITH A REASON.
    final RegExp primitive = RegExp(r'\.(?:enqueueText|enqueueImage|emitInject)\(');

    // file → (function that owns the call sites, how many sites, exempt reason).
    const Map<String, (String, int, String?)> registry = <String, (String, int, String?)>{
      'lib/src/session/chat_utterance.dart': ('_deliverDirect', 2, null),
      'lib/src/session/manual_delivery.dart': ('deliverText', 1, null),
      'lib/src/session/manual_delivery_reinject.dart': ('runReInject', 2, null),
      'lib/src/session/chat_outbox_host.dart': ('outboxSend', 1, null),
      // Pictures carry no words: R12 freezes a row's TEXT, and every machine
      // rewrite selects transcript rows only (`_applyRefined`'s entryType guard).
      'lib/src/session/image_send_controller.dart': ('_send', 2, 'picture rows carry no text to rewrite'),
    };

    // Entry points that `await` BEFORE they reach a primitive and hand off
    // words they read BEFORE that wait: they must freeze before it (POL
    // design §12.3 R1 / R4). ⚠️ `ChatExplicitDelivery.reInject` is NOT here
    // (review P2, 2026-10-14): it reads nothing before its recording-hold wait
    // — `runReInject` reads the live row after it and freezes then.
    const Map<String, (String, String)> preWait = <String, (String, String)>{
      'sendPlusSelection': ('lib/src/session/chat_explicit_delivery.dart', r'\bawait\b'),
    };

    String code(String path) => File(path)
        .readAsLinesSync()
        .map((String l) {
          final int c = l.indexOf('//');
          return c < 0 ? l : l.substring(0, c);
        })
        .join('\n');

    String bodyFrom(String text, String fn) {
      final RegExpMatch? h = RegExp(
              r'(?:Future<[^\n]*?>\??|void|bool)\s+' + RegExp.escape(fn) + r'\s*\(')
          .firstMatch(text);
      expect(h, isNotNull, reason: 'cannot find the declaration of $fn');
      return text.substring(h!.start);
    }

    void expectFreezeBeforeFirst(String path, String fn, RegExp firstAsync, {RegExp? until}) {
      final String body = bodyFrom(code(path), fn);
      final int freeze = body.indexOf('markHandedOff(');
      final int stop = until == null ? body.length : (until.firstMatch(body)?.start ?? -1);
      expect(stop, greaterThan(0), reason: '$fn: no primitive found after its header');
      expect(freeze >= 0 && freeze < stop, isTrue,
          reason: '$path `$fn` hands a row off without `markHandedOff` first');
      final int wait = firstAsync.firstMatch(body)?.start ?? body.length;
      expect(freeze < wait, isTrue,
          reason: '$path `$fn` awaits before it freezes — a rewrite can land in that window');
    }

    test('every primitive call site in lib/ is registered', () {
      final Map<String, int> found = <String, int>{};
      for (final FileSystemEntity f in Directory('lib').listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final String rel = f.path.replaceAll('\\', '/');
        final int n = primitive.allMatches(code(f.path)).length;
        if (n > 0) found[rel] = n;
      }
      expect(found, <String, int>{
        for (final MapEntry<String, (String, int, String?)> e in registry.entries) e.key: e.value.$2,
      }, reason: 'a new handoff site appeared (or one moved): register it, and freeze '
          'the row before the first await unless it carries no text');
    });

    for (final MapEntry<String, (String, int, String?)> e in registry.entries) {
      if (e.value.$3 != null) continue;
      test('${e.value.$1} freezes before its first await and before its primitive', () {
        expectFreezeBeforeFirst(e.key, e.value.$1, RegExp(r'\bawait\b'), until: primitive);
      });
    }

    for (final MapEntry<String, (String, String)> e in preWait.entries) {
      test('${e.key} freezes before it waits', () {
        expectFreezeBeforeFirst(e.value.$1, e.key, RegExp(e.value.$2));
      });
    }
  });
}
