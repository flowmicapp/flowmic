// 🔴 POL-M1 / R12 — the fixes from the 2026-10-14 adversarial review of the
// branch, one group per finding (P1 / P2 / P3 + the single store check).
//
// Reverse controls (each measured red 2026-10-14, then restored):
//   P2  drop `!noPcTarget && canCompose` from `sendPlusSelection`'s freeze
//       condition ⇒ the three P2 cases red;
//   P3  the pre-fix shape — text read off the live row, every other field off
//       the caller's snapshot ⇒ P3 red (`Expected: '下午三点开会' Actual: <null>`
//       on `source_text`);
//   P1  drop the `_bufferedEntryIds` guard in `_applyRefined` ⇒ P1 red;
//   store  drop `_refusesMachineRewrite` from `_applyProcessed` ⇒ the store case red.

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



const String kProduct = 'hello world';

Future<void> _composeDone(_Rig rig, TimelineEntry row) async {
  rig.transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
    'output_text': kProduct,
    'request_id': row.clientId,
  });
  await pumpEventQueue();
}

void main() {
  // ── P2: no freeze when nothing can leave the phone ────────────────────────
  test('P2. fixed light-record destination: a 「+」 send commits locally, the source row is '
      'NOT frozen, and a later refine still lands on it', () async {
    final _Rig rig = await _Rig.paired();
    rig.destination.configureFixed(fixedRecordOnly: true);
    final TimelineEntry note = await rig.speak(kSpoken);
    expect(note.isHandedOff, isFalse, reason: 'setup');

    await rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    expect(rig.injectFrames, isEmpty, reason: 'setup: nothing left the phone');
    expect(rig.store.findById(note.id)!.isHandedOff, isFalse);

    await rig.refine(kRefined);
    expect(rig.store.findById(note.id)!.outputText, kRefined);
    await rig.dispose();
  });

  test('P2. link known down: the 「+」 send is refused, the source row is NOT frozen', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry note = await rig.speakNote(kSpoken);
    rig.transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
    expect(rig.controller.canCompose, isFalse, reason: 'setup: the link is down');

    await rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    expect(rig.injectFrames, isEmpty);
    expect(rig.store.findById(note.id)!.isHandedOff, isFalse);
    await rig.dispose();
  });

  test('P2. translate on a fixed light-record destination, 「+」 mid-run (no handoff) ⇒ the '
      'product lands on the source row: 2 rows (source + local note), not 3', () async {
    final _Rig rig = await _Rig.paired();
    rig.destination.configureFixed(fixedRecordOnly: true);
    rig.controller.setMode(FlowMode.translate);
    final TimelineEntry note = await rig.speak(kSpoken);
    expect(rig.controller.utteranceCompose.isRunning, isTrue, reason: 'setup');

    await rig.controller.sendPlusSelection(
      text: note.displayText,
      images: const <TimelineEntry>[],
      sourceRows: <TimelineEntry>[note],
    );
    await _composeDone(rig, note);

    expect(rig.injectFrames, isEmpty);
    expect(rig.store.entries, hasLength(2));
    expect(rig.store.findById(note.id)!.outputText, kProduct,
        reason: 'not frozen ⇒ the transform lands where it always did');
    await rig.dispose();
  });

  // ── P3: runReInject reads every field off the live row ────────────────────
  test('P3. 补投 from a snapshot taken before the translation landed ⇒ the frame carries the '
      'live row\'s text AND source_text', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual); // keep the product off the wire
    rig.controller.setMode(FlowMode.translate);
    final TimelineEntry snapshot = await rig.speak(kSpoken);
    await _composeDone(rig, snapshot);
    final TimelineEntry live = rig.store.findById(snapshot.id)!;
    expect(live.showsSourceLine, isTrue, reason: 'setup: the row is now a translation');
    expect(snapshot.showsSourceLine, isFalse, reason: 'setup: the snapshot predates it');

    rig.controller.reInject(snapshot);
    await pumpEventQueue();

    final Map<String, Object?> f = rig.injectFrames.single;
    expect(f['text'], kProduct);
    expect(f['source_text'], kSpoken, reason: 'the 原文 the row shows rides the frame');
    expect(f['mode'], 'translate');
    await rig.dispose();
  });

  // ── P1: a buffered (manual, unsent) row refuses a machine rewrite ─────────
  test('P1. manual send: a refine that lands while the row sits in the send buffer is '
      'dropped, and ➤ then sends exactly what the row shows', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    expect(rig.controller.buffer, kSpoken, reason: 'setup: staged in the buffer');
    expect(row.isHandedOff, isFalse, reason: 'setup: not sent yet');

    await rig.refine(kRefined);
    expect(rig.store.findById(row.id)!.outputText, kSpoken,
        reason: 'the buffer still holds the old words; the row must too');

    expect(await rig.controller.sendBuffer(), isNull);
    await pumpEventQueue();
    expect(rig.injectFrames.single['text'], rig.store.findById(row.id)!.displayText);
    await rig.dispose();
  });

  test('P1 control: after ✕ discards the buffer, the row is no longer staged and a refine lands', () async {
    final _Rig rig = await _Rig.paired();
    await rig.controller.setSendPolicy(SendPolicy.manual);
    final TimelineEntry row = await rig.speak(kSpoken);
    rig.controller.discardBuffer();
    await rig.refine(kRefined);
    expect(rig.store.findById(row.id)!.outputText, kRefined);
    expect(rig.injectFrames, isEmpty);
    await rig.dispose();
  });

  // ── the one store-level check covers applyProcessed too ───────────────────
  test('store: applyProcessed refuses a frozen row (the same check as applyRefined)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry row = await rig.speak(kSpoken);
    expect(rig.store.findById(row.id)!.isHandedOff, isTrue, reason: 'setup');
    expect(rig.store.applyProcessed(row.id, kProduct, FlowMode.translate), isNull);
    expect(rig.store.findById(row.id)!.outputText, kSpoken);
    final TimelineEntry note = await rig.speakNote('另一句', utteranceId: 'utt-pol-m1-0009');
    expect(rig.store.applyProcessed(note.id, kProduct, FlowMode.translate), isNotNull,
        reason: 'control: a row never handed off is still writable');
    await rig.dispose();
  });
}
