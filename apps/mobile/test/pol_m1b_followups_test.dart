// 🔴 POL-M1b — three older defects the second review of the POL-M1 branch found.
//
//   1. A 「+」 send while a ➤ is still inside the ack gate hit `deliverText`'s
//      double-tap guard and returned having sent NOTHING (no frame, no banner,
//      source rows frozen). Now it queues behind the ➤ (`ManualDelivery.whenIdle`).
//   2. Manual send: the user cleared the composer and typed something else, and
//      ➤ still marked the old buffered rows delivered (and froze them) although
//      their words never went out. Now emptying the box releases the rows that
//      fed it into the ✕ state (noted, unfrozen); an edit that keeps the box
//      non-empty still covers them (a correction, and T-7's original-text link).
//   (3. the cloud-copy churn is pinned in blind_store_payload_test.dart.)
//
// Reverse controls (measured red 2026-10-14, then restored):
//   1  drop the `while (delivery.sendPending)` wait in `sendPlusSelection`
//      ⇒ case 1 red (the 「+」 words never reach a frame);
//   2  drop the `_releaseBufferedRowsOnEmpty` call in `setBufferRouted`
//      (chat_mode_chip.dart) ⇒ case 2a red;
//   3a drop the `while (delivery.sendPending)` wait in `sendFavorite` ⇒ 3a red;
//   3b drop the `pendingFavorites` dedupe in `sendFavorite` ⇒ 3b red;
//   2c `text.isEmpty` instead of `text.trim().isEmpty` in `setBufferRouted` ⇒ 2c red.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading, ServerChannel;
import 'package:flowmic/src/session/session_instance_owner.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
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
    final _HoldTransport t = _HoldTransport()..connectSucceeds = true;
    return _Rig._(t, await _pairedSession(t));
  }

  final _HoldTransport transport;
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




/// Holds the delivery queue's link probe (`heartbeat` ack) while [hold] is
/// set, so a ➤ can be kept inside the ack gate for as long as a case needs.
class _HoldTransport extends FakeSocketTransport {
  Completer<void>? hold;

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) async {
    final Completer<void>? h = hold;
    if (h != null && event == FlowMicEvents.heartbeat) await h.future;
    return super.emitWithAck<R>(event, payload, timeout: timeout);
  }
}

List<String> _texts(_Rig rig) =>
    <String>[for (final Map<String, Object?> f in rig.injectFrames) f['text']! as String];

void main() {
  test('1. a 「+」 send while a ➤ is in flight is not dropped: it goes out after the ➤', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    rig.controller.setBuffer('我打的字');
    rig.transport.hold = Completer<void>();
    final Future<ComposeSendFailure?> arrow = rig.controller.sendBuffer();
    await pumpEventQueue();
    expect(rig.controller.delivery.sendPending, isTrue, reason: 'setup: ➤ is inside the ack gate');

    final Future<void> plus = rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    await pumpEventQueue();
    rig.transport.hold!.complete();
    rig.transport.hold = null;
    expect(await arrow, isNull);
    await plus;
    await pumpEventQueue();

    expect(_texts(rig), containsAll(<String>['我打的字', kSpoken]),
        reason: 'both sends reached the wire; the 「+」 words were not swallowed');
    expect(rig.store.findById(note.id)!.isHandedOff, isTrue);
    expect(rig.controller.delivery.failure, isNull);
    await rig.dispose();
  });

  test('2 control. manual send, composer untouched ⇒ the buffered row is covered and frozen', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();
    expect(_texts(rig).single, kSpoken);
    expect(rig.store.findById(row.id)!.isHandedOff, isTrue);
    await rig.dispose();
  });

  test('2a. manual send, composer cleared and retyped ⇒ the old row is NOT covered: it '
      'stays on the phone (✕ state), unfrozen, and only the new words go out', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    rig.controller.setBuffer('');
    rig.controller.setBuffer('完全不同的一句');

    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();

    expect(_texts(rig).single, '完全不同的一句');
    final TimelineEntry after = rig.store.findById(row.id)!;
    expect(after.isHandedOff, isFalse, reason: 'its words never went out');
    expect(after.status, EntryStatus.noted, reason: 'the state ✕ leaves it in');
    expect(after.awaitingDelivery, isFalse);
    await rig.dispose();
  });

  test('2b control. manual send, a word corrected in a non-empty box ⇒ the row is still '
      'covered (frozen), and its original transcript stays linked (T-7)', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    rig.controller.setBuffer('下午四点开会');

    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();

    expect(_texts(rig).single, '下午四点开会');
    expect(rig.store.findById(row.id)!.isHandedOff, isTrue);
    expect(rig.store.entries, hasLength(1), reason: 'no separate typed row: the correction rides the spoken row');
    expect(rig.store.findById(row.id)!.sourceText, kSpoken);
    await rig.dispose();
  });
  // ── saved phrases: queue behind an in-flight send, dedupe the same phrase ──
  Future<Future<ComposeSendFailure?>> holdArrow(_Rig rig, String typed) async {
    rig.controller.setBuffer(typed);
    rig.transport.hold = Completer<void>();
    final Future<ComposeSendFailure?> arrow = rig.controller.sendBuffer();
    await pumpEventQueue();
    expect(rig.controller.delivery.sendPending, isTrue, reason: 'setup: ➤ is inside the ack gate');
    return arrow;
  }

  Future<void> release(_Rig rig) async {
    rig.transport.hold!.complete();
    rig.transport.hold = null;
  }

  test('3a. a saved phrase tapped while a ➤ is in flight goes out after it (not dropped)', () async {
    final _Rig rig = await _Rig.paired();
    final Future<ComposeSendFailure?> arrow = await holdArrow(rig, '我打的字');
    final Future<ComposeSendFailure?> fav = rig.controller.sendFavorite('稍等一下');
    await pumpEventQueue();
    await release(rig);
    expect(await arrow, isNull);
    expect(await fav, isNull);
    await pumpEventQueue();
    expect(_texts(rig), containsAll(<String>['我打的字', '稍等一下']));
    await rig.dispose();
  });

  test('3b. the SAME phrase tapped twice while waiting goes out once; a DIFFERENT phrase queues', () async {
    final _Rig rig = await _Rig.paired();
    final Future<ComposeSendFailure?> arrow = await holdArrow(rig, '我打的字');
    final List<Future<ComposeSendFailure?>> taps = <Future<ComposeSendFailure?>>[
      rig.controller.sendFavorite('稍等一下'),
      rig.controller.sendFavorite('稍等一下'),
      rig.controller.sendFavorite('收到'),
    ];
    await pumpEventQueue();
    await release(rig);
    await arrow;
    await Future.wait(taps);
    await pumpEventQueue();
    // By distinct delivery: the drain may re-offer an owed item under its own
    // request_id, so count request ids per text rather than frames.
    final Map<String, Set<Object?>> deliveries = <String, Set<Object?>>{};
    for (final Map<String, Object?> f in rig.injectFrames) {
      deliveries.putIfAbsent(f['text']! as String, () => <Object?>{}).add(f['request_id']);
    }
    expect(deliveries['稍等一下'], hasLength(1), reason: 'a double tap is one delivery');
    expect(deliveries['收到'], hasLength(1), reason: 'a different phrase still goes');
    expect(deliveries['我打的字'], hasLength(1));
    await rig.dispose();
  });
  test('2c. manual send, composer reduced to whitespace then retyped ⇒ the old row is '
      'released too (not handed off, not left waiting)', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    rig.controller.setBuffer('   ');
    rig.controller.setBuffer('另起的一句');

    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();

    expect(_texts(rig).single, '另起的一句');
    final TimelineEntry after = rig.store.findById(row.id)!;
    expect(after.isHandedOff, isFalse);
    expect(after.status, EntryStatus.noted, reason: 'not cached: the ✕ state');
    await rig.dispose();
  });

  test('4. order: a held ➤, then a 「+」 send, then a saved phrase ⇒ deliveries go out '
      'exactly as [➤, +, phrase]', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    final Future<ComposeSendFailure?> arrow = await holdArrow(rig, '我打的字');
    final Future<void> plus = rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    final Future<ComposeSendFailure?> fav = rig.controller.sendFavorite('稍等一下');
    await pumpEventQueue();
    await release(rig);
    await arrow;
    await plus;
    await fav;
    await pumpEventQueue();
    // First appearance of each delivery (request_id), in wire order — a drain
    // may re-offer an owed item under its own id, which is not a new delivery.
    final List<String> order = <String>[];
    final Set<Object?> seen = <Object?>{};
    for (final Map<String, Object?> f in rig.injectFrames) {
      if (seen.add(f['request_id'])) order.add(f['text']! as String);
    }
    expect(order, <String>['我打的字', kSpoken, '稍等一下']);
    await rig.dispose();
  });
}
