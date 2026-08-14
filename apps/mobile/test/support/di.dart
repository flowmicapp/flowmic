// Test-only DI helpers for RV-20 / D5.
//
// Production constructors take required persistence / tokenStorage /
// accountStore — no friendly InMemory* defaults (13 册 §7 F1 ②). These helpers
// exist so the harness can say "this is a test double" in the name, while the InMemory*
// classes themselves stay (they are legitimate doubles; the ban is only on
// production-path defaults).

import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/mic_permission.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/lan_pinning.dart' show LanFingerprintLearner;
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;

import 'mic_permission_fakes.dart';

/// 窗口B3-2a — the delivery queue's two stores, as test doubles.
///
/// ChatController requires both with NO default (a nullable outbox would mean
/// "the queue silently does not run", the exact façade the card removes), so every harness has to
/// name what it is wiring. These say "this is a test double" in the name; the
/// InMemory* classes are legitimate doubles, and the ban in 13 册 §7 F1 ② is
/// only on production-path defaults.
OutboxStore newTestOutboxStore() => InMemoryOutboxStore();
OutboxBlobStore newTestOutboxBlobs() => InMemoryOutboxBlobStore();

/// A drain host for harnesses whose subject is NOT the queue — it records what
/// the queue handed it and reports a healthy link.
///
/// Legitimate as a double, and deliberately NOT importable from production: the
/// real host is ChatController. Note it does not fake a SUCCESS — `send`
/// returning true means 「the frame left」, exactly what the production adapter
/// promises; the PC's verdict still has to be delivered via `settle`.
class RecordingDrainHost implements OutboxDrainHost {
  RecordingDrainHost({this.liveConnection = const LiveConnection(
    machineUid: 'test-machine',
    pairingIdentity: 'standalone|instance:test',
    pcId: 'test-pc',
    // 卡 B4-17: LAN, so harnesses whose subject is NOT the queue keep draining
    // pictures of any size. A cloud default would silently hold the over-cap
    // ones and their failures would read as unrelated bugs.
    channel: ServerChannel.lan,
  )});

  @override
  final LiveConnection liveConnection;

  final List<OutboxItem> sent = <OutboxItem>[];

  /// 🔴 L8 — the inject-origin stamp for each send, index-aligned with [sent].
  final List<InjectOrigin> sentOrigins = <InjectOrigin>[];

  /// What the queue handed over with each [sent] item, same order. Recorded so a
  /// harness can assert "whether this frame carried a picture" without a real ComposeGate — the G-6
  /// regression (an image frame built with no bytes) is invisible otherwise.
  final List<Uint8List?> sentImageBytes = <Uint8List?>[];

  /// The address the queue resolved for each [sent] item, same order.
  final List<String> sentTargets = <String>[];

  bool linkOk = true;
  bool sendOk = true;

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
  }) async {
    sentOrigins.add(origin);
    sent.add(item);
    sentImageBytes.add(imageBytes);
    sentTargets.add(targetPcId);
    return sendOk;
  }

  @override
  void onOutboxChanged() {}
}

/// One-liner DeliveryOutbox over in-memory stores, for harnesses that need a
/// ManualDeliveryHost.outbox but are not testing the queue itself.
DeliveryOutbox newTestOutbox({RecordingDrainHost? host}) => DeliveryOutbox(
  store: newTestOutboxStore(),
  blobs: newTestOutboxBlobs(),
  host: host ?? RecordingDrainHost(),
);

/// 窗口C2 — the ONE DELETER over in-memory doubles.
///
/// `TimelineStore.reaper` is `required` on purpose (15 册 G-21: a deletion path
/// that does not know about the row's bytes is how the phone kept every deleted
/// picture forever). This helper exists so a test can say "test double" in the name
/// rather than the production ctor growing a friendly default.
TimelineReaper newTestReaper({
  TimelinePersistence? persistence,
  OutboxBlobStore? images,
  UnknownFieldVault? vault,
  CutoffStore? cutoffs,
}) => TimelineReaper(
  persistence: persistence ?? InMemoryTimelinePersistence(),
  images: images ?? newTestOutboxBlobs(),
  vault: vault ?? InMemoryUnknownFieldVault(),
  cutoffs: cutoffs ?? InMemoryCutoffStore(),
);

/// One-liner TimelineStore with an explicit InMemoryTimelinePersistence.
TimelineStore newTestStore({
  TimelinePersistence? persistence,
  String deviceId = 'mobile',
  InstanceOwnerProbe? owner,
  TimelineReaper? reaper,
}) {
  final TimelinePersistence p = persistence ?? InMemoryTimelinePersistence();
  return TimelineStore(
    persistence: p,
    // Same persistence instance on both sides by default: a reaper deleting from
    // a DIFFERENT table than the store reads would make every deletion test pass
    // while proving nothing.
    reaper: reaper ?? newTestReaper(persistence: p),
    deviceId: deviceId,
    owner: owner,
  );
}

/// One-liner PttSession with an explicit InMemoryTokenStorage.
///
/// 卡 U2: [micPermission] defaults to a GRANTED test double. `PttSession`'s own
/// default is the real, platform-backed flow (13 册 §7 F1 ② — no friendly
/// production defaults), which in a plain `test()` explodes on the first
/// platform-channel call; see `newTestMicPermission`'s doc for the measurement.
/// A fixture that wants a REFUSED microphone passes its own flow.
PttSession newTestSession({
  SocketTransport? transport,
  FlowmicStateMachine? stateMachine,
  AudioCapture? audio,
  TokenStorage? tokenStorage,
  SttStream? sttStream,
  ReconnectCoordinator? reconnect,
  void Function()? onAuthExpired,
  SocketTransport Function()? retireTransport,
  MicPermissionFlow? micPermission,
  /// D2LAN-B4 — TOFU's first look. Defaults to "this address has no TLS identity on file"
  /// because the production default opens a REAL TLS connection: a harness that
  /// pairs with a bare 4-digit code or a typed address would otherwise dial
  /// 192.0.2.x for real and sit out the probe timeout. A test that is ABOUT
  /// TOFU passes its own.
  ///
  /// ⚠️ This is a TEST-harness default, not a production one — the ban in
  /// 13 册 §7 F1 ② is on friendly no-ops reachable from production, and
  /// `PttSession`'s own default is still `learnLanTlsFingerprint`.
  LanFingerprintLearner? lanFingerprintLearner,
  Duration heartbeatInterval = const Duration(seconds: 5),
}) {
  final PttSession session = PttSession(
    transport: transport,
    stateMachine: stateMachine,
    audio: audio,
    tokenStorage: tokenStorage ?? InMemoryTokenStorage(),
    sttStream: sttStream,
    reconnect: reconnect,
    onAuthExpired: onAuthExpired,
    retireTransport: retireTransport,
    micPermission: micPermission ?? newTestMicPermission(),
    heartbeatInterval: heartbeatInterval,
  );
  session.lanFingerprintLearner =
      lanFingerprintLearner ?? (Uri url, Duration timeout) async => null;
  return session;
}

/// One-liner LoginController with an explicit InMemoryAccountStore.
LoginController newTestLogin({
  required SocketTransport transport,
  AccountStore? accountStore,
  String? saasEndpoint,
}) {
  return LoginController(
    transport: transport,
    accountStore: accountStore ?? InMemoryAccountStore(),
    saasEndpoint: saasEndpoint,
  );
}

/// Give [session] the identities a delivery is addressed by — identity, not the handshake.
///
/// WHY A HARNESS NEEDS THIS (窗口B3-2a/2c). A queued delivery is addressed to a
/// MACHINE, and the values that name it — `connectedInstanceId` / `pcId` /
/// `pcMachineUid` — are stamped in exactly ONE place, `PttSession
/// .applyPairedIdentity`, all off one enriched pairing ack. Fixtures that only
/// push `connected` have a live socket and NO pairing, so every delivery they
/// attempt is refused with `noPcTarget` — which is correct product behaviour
/// (owner 2026-07-31:「未配对的…不可能自动发向PC的」) and simply means those
/// fixtures were never describing an unpaired phone in the first place.
///
/// 🔴 WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. It calls the PRODUCTION
/// method — the same one `pair()` and `resumePairing()` call — with a canned
/// session. It is NOT a test-only setter (RV-63 bans those: a backdoor makes a
/// value look populated that nothing in production populates; here production
/// has two callers, greppable by name). And it is NOT "run the handshake": it
/// dials nothing, emits nothing, and awaits nothing, so a harness asserting
/// "which frames went out" still gets an answer about the TEST'S own actions.
///
/// ⚠️ An earlier attempt DID run the handshake, through `pair()`. It cannot
/// work and the reason is worth keeping: `pair()` dials the transport, and
/// `FakeSocketTransport.connectSucceeds` defaults to false ⇒ `Bad state:
/// pairing failed`. Making it succeed would then leave real `mobile:pair`
/// frames in `transport.emitted`, which several of these fixtures assert on by
/// index. Identity is the requirement; the handshake was never part of it.
///
/// ⇒ Net effect: identities non-null, transport untouched. No existing
/// assertion changes. If you find yourself wanting to edit an expected value to
/// make this work, stop — that fixture is asserting something else, and it is
/// an account to report rather than a red to clear.
void giveSessionAPairedIdentity(
  PttSession session, {
  String pcId = 'pc-test-0001',
  String machineUid = 'machine-test-0001',
  String endpoint = 'ws://127.0.0.1:41999',
}) {
  session.applyPairedIdentity(
    MobileSession(
      token: 'tok-test-abcdefghijklmnopqrstuvwxyz012',
      endpoint: endpoint,
      channel: 'standalone',
      // A post-0.2.4 pairing: the instance id is what `connectionIdentity` is
      // keyed on, so supplying it keeps the fixture on the SAME branch
      // production takes rather than the `legacy-token:` fallback.
      pcInstanceId: 'inst-test-1',
      pairingId: 'pair-test-1',
      pcId: pcId,
      pcMachineUid: machineUid,
      pcName: 'Test PC',
    ),
  );
}
