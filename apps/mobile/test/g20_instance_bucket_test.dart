// Card G-20 (ruling 2026-08-05, landed 2026-08-13) — the six cross-session transient
// notices are bucketed per instance.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5.1 (scope =
//     「这块转录屏幕现在是哪个实例的」; hide, never drop; scope read at the
//     moment the fact is produced; actions on this screen only retire this
//     screen's conclusions) and §6 G-20 (the six sites, by coordinate)
//   docs/decisions/2026-08-05-it18-leftover-items-rulings.md §G-20 (「一次做完
//     六件，不许做三件」 — this file is why the six are one suite, not six)
//
// THE SIX, in the ruling's numbering:
//   ① `_autoStopped`            (recording auto-stop banner)
//   ② `_sttStalled`             (no-transcript banner)
//   ③ `_utteranceFailure`       (translate/organize failed banner)
//   ④ `AiComposeController._failure`   (AI action row failed banner)
//   ⑤ `DeliveryOutbox._terminalNotice` (queue's own terminal banner)
//   ⑥ `ImageSendController.progress`   (top image-transfer strip)
//
// 🔴 THE RULING'S OWN TRAP IS PINNED HERE: ①–⑤ flow through the banner table
// (chat_banner_sources.dart) but ⑥ does NOT — chat_flow_page binds the
// ValueNotifier directly — so 「changing banner sources alone is enough」 passes five of
// these groups and fails the ⑥ group. That asymmetry is why ⑥ gets both a
// controller-level test and a widget-level wiring test.
//
// Every group asserts the same three-beat contract:
//   park (raise on screen A) → hide (invisible on screen B, raw value intact)
//   → return (visible again back on A). 「hide」 must never degrade into 「drop」.

import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/ai_compose_controller.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ptt/ptt_session.dart' show PttSession;
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show ComposeTask, FlowMode, InjectOrigin;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/image_transfer_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

// ── ①②③: a real ChatController, instances switched the production way ────────

/// Two pairings the session can actually be on. `applyPairedIdentity` is the
/// SAME hook production pairing acks arrive through — a fixed fake id here
/// could never catch the defect (one app-level controller serving every
/// instance in turn).
const MobileSession kPairA =
    MobileSession(token: 'tok-A', endpoint: 'ws://a', pcId: 'pc-A');
const MobileSession kPairB =
    MobileSession(token: 'tok-B', endpoint: 'ws://b', pcId: 'pc-B');

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  void onA() => session.applyPairedIdentity(kPairA);
  void onB() => session.applyPairedIdentity(kPairB);

  Future<void> close() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

_Rig _rig() {
  final _Rig r = _Rig();
  addTearDown(r.close);
  return r;
}

void main() {
  group('G-20 ① auto-stop notice follows its instance', () {
    test('park on A → hidden on B → back on A it is still there', () {
      final _Rig r = _rig();
      r.onA();
      expect(r.controller.autoStopped, isFalse, reason: 'positive control');
      onAutoStoppedRouted(r.controller);
      expect(r.controller.autoStopped, isTrue);
      expect(r.controller.autoStopReason, isNotNull,
          reason: 'the reason gate must agree with the banner gate');

      r.onB();
      expect(r.controller.autoStopped, isFalse,
          reason: 'another instance\'s notice must not paint on this screen');
      expect(r.controller.autoStopReason, isNull,
          reason: 'a reason handed out for a hidden banner is a leak');

      r.onA();
      expect(r.controller.autoStopped, isTrue,
          reason: '§2.5.1 is 「hide」 not 「drop」 — switching back shows it again');
    });

    test('✕ on B refuses to sweep A\'s parked notice', () {
      final _Rig r = _rig();
      r.onA();
      onAutoStoppedRouted(r.controller);
      r.onB();
      r.controller.dismissAutoStopped();
      r.onA();
      expect(r.controller.autoStopped, isTrue,
          reason: 'clearing it from B would delete a failure nobody has seen');
      r.controller.dismissAutoStopped();
      expect(r.controller.autoStopped, isFalse,
          reason: 'the owning screen\'s ✕ still works');
    });
  });

  group('G-20 ② stt-stall notice follows its instance', () {
    const SttStall engineStall = SttStall(
      SttStallReason.engineError,
      code: 'STT_CONFIG_MISSING',
    );
    const SttStall emptyStall = SttStall(SttStallReason.emptyTranscript);

    test('park on A → hidden on B → back on A it is still there', () {
      final _Rig r = _rig();
      r.onA();
      onSttStalledRouted(r.controller, engineStall);
      expect(r.controller.sttStalled, engineStall);

      r.onB();
      expect(r.controller.sttStalled, isNull);
      r.controller.dismissSttStalled();

      r.onA();
      expect(r.controller.sttStalled, engineStall,
          reason: 'a ✕ on B must not have swept A\'s parked stall');
    });

    test('ENG-3 hold applies within one screen only: a refusal parked on A '
        'must not suppress B\'s own empty-transcript stall', () {
      final _Rig r = _rig();
      r.onA();
      onSttStalledRouted(r.controller, engineStall);
      r.onB();
      onSttStalledRouted(r.controller, emptyStall);
      expect(r.controller.sttStalled, emptyStall,
          reason: 'the empty-final race guard reasons about ONE utterance, '
              'and an utterance happens on one instance');
    });
  });

  group('G-20 ③ utterance-transform failure follows its instance', () {
    const AiComposeOutcome outcome = AiComposeOutcome(
      reason: AiComposeFailure.serverError,
      code: 'QUOTA_EXCEEDED',
    );

    test('park on A → hidden on B → back on A it is still there', () {
      final _Rig r = _rig();
      r.onA();
      // `ucFailed` with an entry id the store does not know settles no row —
      // the banner raise is the whole effect, which is exactly the surface
      // under test.
      r.controller.ucFailed('no-such-entry', outcome);
      expect(r.controller.utteranceFailure, outcome);

      r.onB();
      expect(r.controller.utteranceFailure, isNull);
      r.controller.dismissUtteranceFailure();

      r.onA();
      expect(r.controller.utteranceFailure, outcome);
      r.controller.dismissUtteranceFailure();
      expect(r.controller.utteranceFailure, isNull);
    });
  });

  group('G-20 ④ AI action-row failure follows its instance', () {
    test('raise stamps the screen; the getter hides it elsewhere', () {
      final _AiHost host = _AiHost()..instanceId = 'inst-A';
      final AiComposeController ai = AiComposeController(
        host: host,
        gate: ComposeGate(transport: FakeSocketTransport()),
      );
      addTearDown(ai.dispose);
      // aiCanStart=false ⇒ start() refuses loudly — the same `_raise` every
      // failure path uses, reached without a socket.
      expect(ai.start(ComposeTask.draftPolish), isNotNull);
      expect(ai.failure, isNotNull);

      host.instanceId = 'inst-B';
      expect(ai.failure, isNull,
          reason: 'switching instances itself can raise one of these (the disconnect-edge '
              'abort), so following the user around is the defect itself');

      host.instanceId = 'inst-A';
      expect(ai.failure, isNotNull, reason: 'hidden, not dropped');
      ai.dismissFailure();
      expect(ai.failure, isNull);
    });
  });

  group('G-20 ⑤ the queue\'s own terminal follows its instance', () {
    test('overflow noted on A is A\'s news, not B\'s', () async {
      final _DrainHost host = _DrainHost(kOnALan)..linkOk = false;
      final DeliveryOutbox box = DeliveryOutbox(
        store: InMemoryOutboxStore(),
        blobs: newTestOutboxBlobs(),
        host: host,
        capacity: 1,
        inflightTimeout: const Duration(seconds: 45),
      );
      addTearDown(box.dispose);
      for (int i = 0; i < 2; i++) {
        await box.enqueueText(
          requestId: 'cap-$i',
          entryId: 'loc-$i',
          wireEntryId: 'loc-$i',
          source: 'manual',
          text: 'x',
          mode: 'realtime',
          createdAt: DateTime.utc(2026, 8, 13, 9, i),
        );
      }
      expect(box.terminalNotice, isNotNull, reason: 'positive control (raw)');
      expect(box.terminalNoticeFor(kPairALanId), isNotNull,
          reason: 'the screen the overflow happened on reads it');
      expect(box.terminalNoticeFor(kPairBLanId), isNull,
          reason: 'another instance\'s screen must not');
      expect(box.terminalNoticeFor(kPairALanId), isNotNull,
          reason: 'hidden for B ≠ dropped for A');
      box.dismissTerminalNotice();
      expect(box.terminalNoticeFor(kPairALanId), isNull);
    });
  });

  group('G-20 ⑥ image transfer progress follows its instance', () {
    test('a transfer started on A is not painted for B (controller half)',
        () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final _ImageHost host = _ImageHost(
        store: newTestStore(),
        syncGate: TimelineSyncGate(transport: transport),
      )..instanceId = 'inst-A';
      final ComposeGate gate = ComposeGate(transport: transport);
      final ImageSendController imageSend = ImageSendController(
        host: host,
        gate: gate,
        delivery: ManualDelivery(host: host, gate: gate),
        picker: _Picker(_jpeg(120000)),
        rowImages: newTestOutboxBlobs(),
        thumbnailEncoder: (Uint8List bytes) async => null,
        liveChannel: () => ServerChannel.lan,
      );
      addTearDown(imageSend.dispose);

      expect(await imageSend.pickAndSend(), isNull);
      expect(imageSend.progress.value, isNotNull,
          reason: 'positive control: the socket path parks the bar at '
              'waitingSocketAck until the verdict or the 20 s auto-clear');
      expect(imageSend.progressOnScreen, isNotNull);

      host.instanceId = 'inst-B';
      expect(imageSend.progressOnScreen, isNull,
          reason: 'the bar bypasses the banner table, so it carries its own '
              'scope — without this, one instance\'s transfer paints on '
              'another\'s screen');
      expect(imageSend.progress.value, isNotNull,
          reason: 'hidden, not cancelled — the raw transfer is still running');

      host.instanceId = 'inst-A';
      expect(imageSend.progressOnScreen, isNotNull);
    });

    testWidgets('the bar renders the SCOPED read, not the raw notifier',
        (WidgetTester tester) async {
      final ValueNotifier<ImageSendProgress?> raw =
          ValueNotifier<ImageSendProgress?>(
        const ImageSendProgress(ImageSendStage.preparing),
      );
      addTearDown(raw.dispose);
      ImageSendProgress? scoped;
      Widget app() => MaterialApp(
            home: Scaffold(
              body: ImageTransferBar(
                progress: raw,
                onScreen: () => scoped,
                strings: AppStrings(AppLocale.zh),
              ),
            ),
          );

      // Raw says 「in flight」, the scoped read says 「not this screen's」 —
      // the bar must stay empty. A bar reading the raw value paints here,
      // which is the exact regression this case exists to catch.
      scoped = null;
      await tester.pumpWidget(app());
      expect(find.byIcon(Icons.image_outlined), findsNothing);

      scoped = raw.value;
      await tester.pumpWidget(app());
      expect(find.byIcon(Icons.image_outlined), findsOneWidget,
          reason: 'positive control: on its own screen the bar still draws');
    });
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

Uint8List _jpeg(int length) {
  final Uint8List bytes = Uint8List(length);
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  bytes[2] = 0xFF;
  return bytes;
}

class _AiHost implements AiComposeHost {
  String buffer = 'hello';
  String? instanceId;
  @override
  String get aiBuffer => buffer;
  @override
  set aiBuffer(String value) => buffer = value;
  @override
  bool get aiCanStart => false;
  @override
  String? get aiInstanceId => instanceId;
  @override
  void aiNotify() {}
}

class _Picker implements ImagePickerPort {
  _Picker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

class _ImageHost implements ManualDeliveryHost {
  _ImageHost({required this.store, required this.syncGate});

  String? instanceId;

  @override
  late final DeliveryOutbox outbox = newTestOutbox();
  @override
  bool get canCompose => true;
  @override
  bool get noPcTarget => false;
  @override
  FlowMode get mode => FlowMode.realtime;
  @override
  final TimelineStore store;
  @override
  final TimelineSyncGate syncGate;
  @override
  String? get pcDisplayName => null;
  @override
  String? get targetPcId => null;
  @override
  String? get deliveryInstanceId => instanceId;
  @override
  void deliveryNotify() {}
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;
  @override
  LanImageIngress? get lanImageIngress => null;
}

const String kPairALanId = 'standalone|instance:inst-A-lan';
const String kPairBLanId = 'standalone|instance:inst-B-lan';

const LiveConnection kOnALan = LiveConnection(
  machineUid: 'machine-uid-AAAA',
  pairingIdentity: kPairALanId,
  pcId: 'pc-A-lan',
  channel: ServerChannel.lan,
);

class _DrainHost implements OutboxDrainHost {
  _DrainHost(this._connection);
  LiveConnection _connection;
  bool linkOk = true;

  @override
  LiveConnection get liveConnection => _connection;
  @override
  Future<bool> ensureLink() async => linkOk;
  @override
  Future<void> reseedDestination() async {}
  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async =>
      true;
  @override
  void onOutboxChanged() {}
}
