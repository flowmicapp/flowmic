// card M acceptance — 🔴 owner 2026-07-31 iron rule「绝不许串号」: every inject:request
// this app can emit must carry `target_pc_id`, and it must be the REAL `pc_id`
// this session paired against (never a sentinel, never guessed at drain time).
//
// One test per production emission path (ComposeGate.emitInject has exactly
// ONE wire hop, but four call sites build the payload — see compose_gate.dart's
// header assertion, re-verified true as of this card):
//   1. chat_utterance.dart  _deliverDirect      (direct-send, source:'stt')
//   2. manual_delivery.dart deliverText          (➤ / favourites)
//   3. manual_delivery.dart reInject             (long-press deferred resend)
//   4. image_send_controller.dart _send          (「+」 panel album image, socket leg)
//
// Each test PAIRS the session for real (session.pair(), a queued ack carrying
// pc_id) rather than poking a private field — PttSession.pcId has no test-only
// setter on purpose (RV-63 is exactly the shape of bug a backdoor setter could
// reintroduce: a value nothing production ever populates).
//
// SPEC-REF: docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//   (card P "protocol shape"); packages/protocol/src/protocol-schemas-inject.ts
//   (InjectRequestSchema.target_pc_id).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/device_label.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/platform_device_info.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

const String kTargetPc = 'pc-card-m-0001';

/// A minimal picker returning fixed bytes — reuses the same 2×2 PNG the other
/// image tests use, kept local so this file has no cross-file test coupling.
class _FixedPicker implements ImagePickerPort {
  _FixedPicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

final Uint8List _kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

/// A REAL, connected, paired session — pcId comes from a genuine pair() ack,
/// the exact production path (PttSession.pair → enrichFromAck → this._pcId).
Future<PttSession> _pairedSession(FakeSocketTransport t) async {
  final PttSession session = newTestSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  // 🔴 RV-89 — PIN THE CHANNEL PROBE, OR THIS FIXTURE READS THE DEV MACHINE.
  //
  // `pair()` fires a real `/api/health` probe at its endpoint. Until RV-89 that
  // probe was structurally incapable of answering for a `ws://` endpoint, so
  // this fixture silently ran on "channel not probed" and every image left on the
  // SOCKET — which is the leg the assertions below read (`t.emittedWhere`).
  // Now that the probe works, `ws://127.0.0.1:41879` reaches whatever is
  // listening on that port; on a developer machine running FlowMic that is a
  // live standalone server, the session flips to the LAN http image ingress,
  // and this test starts failing because of what else is running on the box.
  // Stating the leg is not a workaround — it is the fixture finally SAYING
  // which channel it always meant.
  session.healthReader =
      (Uri url, Duration timeout) async => HealthReading.offline;
  t.defaultAck = <String, Object?>{
    'token': 'tok-card-m-abcdefghijklmnopqrstuvwxyz01',
    'pairing_id': 'pair-card-m-1',
    'pc_id': kTargetPc,
    'pc_name': 'Card M Test PC',
  };
  final PairResult r = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://127.0.0.1:41879',
  );
  expect(r.ok, isTrue, reason: 'setup: pairing must succeed');
  expect(
    session.pcId,
    kTargetPc,
    reason: 'setup: PttSession.pcId must come from the real pairing ack',
  );
  // The delivery paths below make their OWN emitWithAck calls (heartbeat probe
  // / mobile:reconnect on a later edge); reset to the ordinary {ok:true} shape
  // so none of them misparse the pairing ack's fields as their own answer.
  t.defaultAck = <String, Object?>{'ok': true};
  await pumpEventQueue();
  return session;
}

Map<String, Object?> _payloadOf(EventEnvelope e) =>
    Map<String, Object?>.from(e.data! as Map);

/// The label [_warmDeviceLabelCache] resolves to — computed once so tests
/// assert the REAL value `buildDeviceLabel` produces, not just "non-null".
final String kExpectedDeviceLabel = buildDeviceLabel(
  const DeviceIdentity(manufacturer: 'CardM', model: 'Rig', seed: 'seed-card-m'),
);

void main() {
  // card M's `device_label` field reads the SAME process-lifetime cache
  // `main.dart` warms once at boot (`await deviceLabel()`, before the first
  // frame — so production never reaches a delivery with it cold). Nothing in
  // this test harness runs `main()`, so the cache starts empty; warm it here
  // with a deterministic fake reader — the exact seam `deviceLabel()` was
  // built for (mobile/lib/src/session/platform_device_info.dart) — so these
  // tests assert what the field is REALLY populated with, not just non-null.
  setUpAll(() async {
    await deviceLabel(
      reader: () async => const DeviceIdentity(
        manufacturer: 'CardM',
        model: 'Rig',
        seed: 'seed-card-m',
      ),
    );
  });
  tearDownAll(resetDeviceLabelCache);

  test('direct-send (source:stt): inject:request carries the real target_pc_id', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final PttSession session = await _pairedSession(t);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(),
    );

    await controller.pttDown();
    await controller.pttUp();
    t.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '目标 PC 测试一',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 800,
    });
    await pumpEventQueue();

    final List<EventEnvelope> injects =
        t.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects, hasLength(1));
    final Map<String, Object?> p = _payloadOf(injects.single);
    expect(p['source'], 'stt');
    expect(p['target_pc_id'], kTargetPc);
    // The other five card M fields also rode this exact frame — device_label
    // against the REAL value the warmed cache resolves to, not just non-null.
    expect(p['device_label'], kExpectedDeviceLabel);
    expect(p.containsKey('created_at'), isTrue);
    expect(p['source_text'], isNull,
        reason: 'realtime has no distinguishable original — explicit null');

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await t.close();
  });

  test('manual send (➤): inject:request carries the real target_pc_id', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final PttSession session = await _pairedSession(t);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
    await controller.loadSendPolicy();

    controller.setBuffer('手打送出测试');
    final ComposeSendFailure? failure = await controller.sendBuffer();
    expect(failure, isNull);

    final List<EventEnvelope> injects =
        t.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects, hasLength(1));
    final Map<String, Object?> p = _payloadOf(injects.single);
    expect(p['source'], 'manual');
    expect(p['target_pc_id'], kTargetPc);

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await t.close();
  });

  test('deferred resend: inject:request carries the real target_pc_id', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final PttSession session = await _pairedSession(t);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(),
    );

    final TimelineEntry entry = store.buildFromUtterance(
      clientId: 'u-card-m-reinject',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '补投测试',
    );
    controller.reInject(entry);
    await pumpEventQueue();

    final List<EventEnvelope> injects =
        t.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects, hasLength(1));
    final Map<String, Object?> p = _payloadOf(injects.single);
    expect(p['source'], 'history');
    expect(p['target_pc_id'], kTargetPc);

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await t.close();
  });

  test('image send: inject:request carries the real target_pc_id', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final PttSession session = await _pairedSession(t);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(),
      imagePicker: _FixedPicker(_kPng),
    );

    final ImageSendFailure? failure = await controller.sendImage();
    expect(failure, isNull);

    final List<EventEnvelope> injects =
        t.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects, hasLength(1));
    final Map<String, Object?> p = _payloadOf(injects.single);
    expect(p['source'], 'image');
    expect(p['target_pc_id'], kTargetPc);
    expect(p['entry_type'], 'image');

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await t.close();
  });

  test('pcId is null on an unpaired-but-connected session ⇒ target_pc_id is '
      'OMITTED, never a guessed value', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    expect(session.pcId, isNull);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(),
    );
    t.pushStatus(SocketStatus.connected);

    await controller.pttDown();
    await controller.pttUp();
    t.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '未配对测试',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 800,
    });
    await pumpEventQueue();

    final List<EventEnvelope> injects =
        t.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects, hasLength(1));
    expect(
      _payloadOf(injects.single).containsKey('target_pc_id'),
      isFalse,
      reason: 'no pcId learned yet ⇒ the field is omitted, not invented',
    );

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await t.close();
  });
}
