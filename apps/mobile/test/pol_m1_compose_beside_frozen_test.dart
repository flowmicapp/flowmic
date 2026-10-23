// 🔴 POL-M1 / R12 × translate/organize — a row handed off WHILE its transform
// is still running keeps the words that went out; the product becomes its OWN
// row (the re-run shape, `_deliverRerun`) and follows `_ucDone`'s fork.
//
// Found by MAIN's item-1 probe (2026-10-14): speak in translate mode, long-press
// 补投 before compose:done ⇒ the raw words reach the PC, then `_ucDone` wrote
// the translation over that same (frozen) row — under the manual policy the
// row said "hello world" while the PC had only "你好世界".
//
// THE ONE ASSERTION SHAPE: for every frame that left, the row it names shows
// exactly that frame's text; and a row that never left says so (no frame).
//
// Reverse control (measured red 2026-10-14, restored): drop the `isHandedOff`
// branch in `_ucDone` (chat_utterance_processing.dart) ⇒ every case below red
// (the frozen row's face becomes the product).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
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


const String kRaw = '你好世界';
const String kProduct = 'hello world';

/// Every inject frame's text agrees with the row it names. A ➤ frame over
/// buffered rows names none (`wireEntryId: null`, outbox_item.dart); its rows
/// are asserted by the case itself.
void _expectRowsMatchFrames(_Rig rig) {
  final List<Map<String, Object?>> named = <Map<String, Object?>>[
    for (final Map<String, Object?> f in rig.injectFrames)
      if (f['entry_id'] is String) f,
  ];
  expect(named, isNotEmpty, reason: 'probe not blind');
  for (final Map<String, Object?> f in named) {
    final TimelineEntry? row = rig.store.findById(f['entry_id']! as String);
    expect(row, isNotNull, reason: 'frame ${f['request_id']} names a row');
    expect(row!.displayText, f['text'], reason: 'history == what was delivered');
  }
}

Future<TimelineEntry> _speakTranslate(_Rig rig, {SendPolicy policy = SendPolicy.direct}) async {
  await rig.controller.setSendPolicy(policy);
  rig.controller.setMode(FlowMode.translate);
  final TimelineEntry row = await rig.speak(kRaw);
  expect(rig.controller.utteranceCompose.isRunning, isTrue, reason: 'setup: the transform is in flight');
  expect(rig.injectFrames, isEmpty, reason: 'setup: nothing has gone out yet');
  return row;
}

Future<void> _composeDone(_Rig rig, TimelineEntry row) async {
  rig.transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
    'output_text': kProduct,
    'request_id': row.clientId,
  });
  await pumpEventQueue();
}

TimelineEntry _productRow(_Rig rig, TimelineEntry frozen) => rig.store.entries
    .singleWhere((TimelineEntry e) => e.id != frozen.id && e.processedText == kProduct);

void main() {
  test('control: no handoff mid-run ⇒ the product lands on the row as before (one row)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await _speakTranslate(rig);
    await _composeDone(rig, row);
    expect(rig.store.entries, hasLength(1));
    expect(rig.store.findById(row.id)!.outputText, kProduct);
    expect(rig.injectFrames.single['text'], kProduct);
    _expectRowsMatchFrames(rig);
    await rig.dispose();
  });

  test('direct: long-press 补投 mid-run ⇒ frozen row keeps the raw words; the product is '
      'a NEW row, delivered as its own frame', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await _speakTranslate(rig);
    rig.controller.reInject(rig.store.findById(row.id)!);
    await pumpEventQueue();
    expect(rig.injectFrames.single['text'], kRaw, reason: 'setup: the raw words went out');

    await _composeDone(rig, row);

    expect(rig.store.findById(row.id)!.outputText, kRaw);
    expect(rig.store.findById(row.id)!.processedText, isNull);
    final TimelineEntry product = _productRow(rig, row);
    expect(product.outputText, kProduct);
    expect(product.sourceText, kRaw, reason: 'the 原文 line names the same words');
    expect(product.isHandedOff, isTrue, reason: 'direct ⇒ delivered');
    expect(rig.injectFrames.map((Map<String, Object?> f) => f['text']).toList(),
        <String>[kRaw, kProduct]);
    _expectRowsMatchFrames(rig);
    await rig.dispose();
  });

  test('manual: long-press 补投 mid-run ⇒ frozen row keeps the raw words; the product is a '
      'NEW row in the buffer, delivered only by ➤, and then matches its frame', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await _speakTranslate(rig, policy: SendPolicy.manual);
    rig.controller.reInject(rig.store.findById(row.id)!);
    await pumpEventQueue();

    await _composeDone(rig, row);

    expect(rig.store.findById(row.id)!.outputText, kRaw,
        reason: 'the PC has only these words; the row must say them');
    final TimelineEntry product = _productRow(rig, row);
    expect(product.isHandedOff, isFalse, reason: 'manual ⇒ waits for ➤');
    expect(rig.controller.buffer, kProduct);
    expect(rig.injectFrames.single['text'], kRaw);
    _expectRowsMatchFrames(rig);

    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();
    // By delivery (request_id), not by frame: the ➤ drain also re-offers the
    // still-owed raw delivery under its SAME request_id (an idempotent retry the
    // PC de-duplicates), so the frame count is not the delivery count.
    final Map<Object?, Object?> byDelivery = <Object?, Object?>{
      for (final Map<String, Object?> f in rig.injectFrames) f['request_id']: f['text'],
    };
    expect(byDelivery.values.toList(), <String>[kRaw, kProduct]);
    _expectRowsMatchFrames(rig);
    expect(rig.store.findById(product.id)!.isHandedOff, isTrue, reason: 'covered by ➤');
    expect(rig.store.findById(product.id)!.displayText, kProduct);
    expect(rig.store.findById(row.id)!.outputText, kRaw);
    await rig.dispose();
  });

  test('「+」: a translate light record ticked and sent mid-run ⇒ the source row keeps the '
      'raw words; the product is a NEW light record that never left the phone', () async {
    final _Rig rig = await _Rig.paired();
    rig.destination.setRecordOnly();
    final TimelineEntry note = await _speakTranslate(rig);
    rig.destination.setInject();
    expect(note.delivery, Delivery.none, reason: 'setup: a light record');

    await rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    expect(rig.injectFrames.single['text'], kRaw, reason: 'setup: the raw words went out');

    await _composeDone(rig, note);

    expect(rig.store.findById(note.id)!.outputText, kRaw);
    expect(rig.store.findById(note.id)!.isHandedOff, isTrue);
    final TimelineEntry product = _productRow(rig, note);
    expect(product.delivery, Delivery.none, reason: 'inherits the light record');
    expect(product.isHandedOff, isFalse);
    expect(rig.injectFrames, hasLength(1), reason: 'the product was not delivered');
    _expectRowsMatchFrames(rig);
    await rig.dispose();
  });
}
