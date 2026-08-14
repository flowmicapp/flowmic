// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §2 (PTT FSM), §3 (audio pipeline + heartbeat),
//     §4 (pairing / reconnect / auth:expired drain)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A/B (utterance = entry;
//     cancel = no entry; delivery fixed at audio:start)
//
// PttSession is the composition root that fuses the socket transport, PTT FSM,
// audio capture, reconnect coordinator, token storage and STT streams into the
// single PTT chain: pair → PTT down (audio:start+chunks) → PTT up (residual +
// audio:stop) → stt:final. It also runs the inbound event dispatch loop, keyed
// entirely on generated FlowMicEvents constants (no event-name literals).
//
// The presentation binding (chat flow, destination selector UI) is WP-R3-2; this
// card stops at the data-layer streams exposed here.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_events.g.dart';
import '../audio/audio_capture.dart';
import '../audio/local_stop_reasons.dart';
import '../audio/real_audio_recorder.dart';
import '../audio/retained_audio_spill.dart';
import '../audio/audio_emitter.dart';
import '../auth/token_storage.dart';
import '../diag/diag_log.dart';
import '../session/endpoint_candidates.dart';
import '../session/instance_probe.dart';
import '../session/hold_out_retry.dart';
import '../session/local_engine_status.dart';
import '../session/machine_key.dart';
import '../session/pc_busy.dart';
import '../session/pc_presence.dart';
import '../session/pc_presence_probe.dart';
import '../session/platform_device_info.dart';
import '../signaling/auth_expired_handler.dart';
import '../signaling/health_handler.dart';
import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart';
import '../signaling/inbound_payloads.dart';
import '../signaling/mobile_reconnect_flow.dart';
import '../signaling/reconnect.dart';
import '../signaling/socket_core.dart';
import '../signaling/wire_payloads.dart';
import '../stt/segment_buffer.dart';
import '../stt/stt_stream.dart';
import '../signaling/state_machine.dart';
import 'mic_permission.dart';
import 'pair_result.dart';
import 'pair_retire.dart';
import 'platform_mic_permission.dart';

// 800-line cap: `PairResult` moved VERBATIM to pair_result.dart when Window
// B3-2a pushed this file over. Re-exported so existing imports still see it.
export 'pair_result.dart';

// 800-line cap: the whole inbound dispatch section moved VERBATIM (see its header).
part 'ptt_inbound.dart';

// 800-line cap (D2LAN-B3/B4): `pair()` + the TOFU look-once moved VERBATIM.
part 'ptt_pair.dart';

// 800-line cap: G-15① idle PC-presence poll lives here (see its header).
part 'ptt_presence_poll.dart';

// 800-line cap (card L7): the mobile:reconnect ack callbacks moved VERBATIM
// (+ two marked edits) — see that file's diff-discipline note.
part 'ptt_reconnect_ack.dart';

// 800-line cap (F-1/49-3): the keep-alive plumbing moved VERBATIM — see header.
part 'ptt_wire_keepalive.dart';

// 800-line cap: the capture pause/resume + fault/chunk pump moved VERBATIM —
// see that file's header.
part 'ptt_capture_pump.dart';

// SEG-2: the local dead-recording edge (3 s drop grace expired while the mic
// was live) — trigger doc + why-not-the-FSM in that file's header.
part 'ptt_link_loss.dart';

// 800-line cap (SEG-2): `_refreshServerChannel` moved VERBATIM — see header.
part 'ptt_channel_probe.dart';

// 800-line cap (IT-10): dispose() moved so scope.dispose + ordering comments fit.
part 'ptt_session_dispose.dart';

class PttSession {
  PttSession({
    SocketTransport? transport,
    FlowmicStateMachine? stateMachine,
    AudioCapture? audio,
    // SEG-2 (design 2026-08-11 §2-R3) — the retained-audio layer for the
    // DEFAULT capture below. The composition root (main.dart) opens the store
    // (async, path_provider) before runApp and passes the spill here; null =
    // no retention, today's behaviour, and the link-loss notice then refuses
    // to claim retention (ptt_link_loss.dart). A caller that injects [audio]
    // owns its own spill wiring — this parameter is only read by the default.
    RetainedAudioSpill? spill,
    // RV-20 / Book 13 §7 F1 ②: required — no InMemoryTokenStorage default.
    // A friendly empty impl lets a composition root omit SecureTokenStorage
    // and still look healthy — pairings vanish on relaunch with no construct-
    // time signal. Compile-time required bites a forgotten arg earlier than a
    // runtime throw (lost ctor params leave no new symbol to grep). Production:
    // SecureTokenStorage(); tests: newTestSession() / InMemoryTokenStorage().
    required TokenStorage tokenStorage,
    SttStream? sttStream,
    ReconnectCoordinator? reconnect,
    this.onAuthExpired,
    SocketTransport Function()? retireTransport,
    // card U2 — the mic-permission decision layer [pttDown] gates on. Same DI
    // rule as `audio` below: the default is the REAL platform-backed flow
    // (never a friendly no-op, Book 13 §7 F1 ②); tests inject a fake port.
    MicPermissionFlow? micPermission,
    this.heartbeatInterval = const Duration(seconds: 5),
  }) : // v0.2.4 — the seam [retirePairing] never had. It dials a SECOND,
       // isolated socket (see there for why), and that socket was a hard-coded
       // `SocketCore()`, so the whole 「删除是否真的到达了对方」("whether the
       // deletion actually reached the other side") path could not be
       // exercised without a network. A widget test asserting the honest
       // 「它那边的记录还在」("the record on their end is still there")
       // message is what surfaced it: the assertion ran while a real dial to
       // 192.168.1.5 was still outstanding.
       //
       // Defaults to the real thing, never to a friendly no-op (Book 13 §7 F1 ②).
       _retireTransport = retireTransport ?? SocketCore.new,
       transport = transport ?? SocketCore(),
       fsm = stateMachine ?? FlowmicStateMachine(),
       // owner 2026-07-27 P0 — THE MICROPHONE WAS NEVER WIRED. This default used
       // to be a bare `AudioCapture()`, whose own default recorder is a NOOP
       // stub. RealAudioRecorder existed, compiled, and was constructed by
       // nothing, anywhere: the app has never once opened the microphone.
       // Everything downstream behaved perfectly — start() succeeded, the red
       // PTT bar ran, the timer counted — and zero bytes existed to send, so
       // the server's transcript was empty and the user was told 「没有听到
       // 语音」("no speech was heard"). This is CLAUDE.md's anti-façade rule,
       // in its purest form: 能力定义了没人调用 ("a capability got defined and
       // nothing calls it"). The legacy line had it right
       // (app_bootstrap_initialization:
       // `AudioCapture(recorder: RealAudioRecorder())`); the port dropped it.
       //
       // SEG-2 — `spill` joined for the same reason, one card later: the
       // retention layer shipped complete, tested, and CONSTRUCTED BY NOTHING
       // (Book 15 §2.0-b correction block, measured against this exact line), so
       // production wrote zero bytes to disk while every retention test was
       // green. main.dart supplies the opened store's spill.
       audio =
           audio ?? AudioCapture(recorder: RealAudioRecorder(), spill: spill),
       micPermission = micPermission ??
           MicPermissionFlow(
             port: const PlatformMicPermission(),
             asked: SharedPrefsMicAskedStore(),
           ),
       tokenStorage = tokenStorage,
       stt = sttStream ?? SttStream() {
    this.reconnect =
        reconnect ??
        ReconnectCoordinator(
          transport: this.transport,
          // SEG-2 (§2-R5): the replay is trimmed at the server's own watermark
          // from THIS span's reconnect ack — null (no ack / no field /
          // malformed) = full replay, today's behaviour. See the field's doc.
          bufferedChunksProvider: () => this.audio.bufferedChunkPayloads(
            cutoffSeq: _reconnectAckAudioSeq,
          ),
          shouldReconnect: () => _authValid,
          onReconnected: _onReconnected,
          // B4-15 — after a network change, if the original address is
          // unreachable, fall back to this PC's other address. Inert until a
          // pairing records more than one candidate, and structurally unable to
          // move the ladder to a different machine (see _resolveReconnectUrl).
          dialUrlResolver: _resolveReconnectUrl,
        );
    _authHandler = AuthExpiredHandler(
      transport: this.transport,
      stateMachine: fsm,
      audio: this.audio,
      reconnect: this.reconnect,
      tokenStorage: this.tokenStorage,
      onDrained: () {
        _authValid = false;
        paired.value = false;
        connectedDeviceName.value = '';
        // Cloud (JWT) socket only: the pairing-token socket is watchdog-exempt,
        // so an auth:expired here means the SaaS bearer hit exp — clear the
        // stored JWT + drive back to login (fail-loud, never a silent retry).
        onAuthExpired?.call();
      },
    );
    _statusSub = this.transport.status.listen((SocketStatus s) {
      fsm.onSocketStatus(s);
      // G-15① (started only once PAIRED, see file) stops here same as presence.
      if (s != SocketStatus.connected) { _pcPresence.noteLinkNotLive(); _stopPresencePoll(); }
      // N1-B3 retained-audio uplink signal; body + rationale in
      // ptt_capture_pump.dart (`_noteUplinkStatus`).
      _noteUplinkStatus(s);
    });
    _incomingSub = this.transport.incoming.listen(_onIncoming);
    _chunkSub = this.audio.chunks.listen(_onCapturedChunk);
    _faultSub = this.audio.faults.listen(_onCaptureFault);
    // SEG-2 — the local dead-recording edge (3 s grace expiry while the mic is
    // live). Edge doc + why the FSM stays microphone-blind: ptt_link_loss.dart.
    _linkLossSub = fsm.changes.listen(_onLinkLossEdge);
  }

  final SocketTransport transport;
  final FlowmicStateMachine fsm;
  final AudioCapture audio;
  final TokenStorage tokenStorage;
  final SttStream stt;
  final Duration heartbeatInterval;

  /// card U2 — the mic-permission flow this session gates PTT on. Its
  /// [MicPermissionFlow.face] is the talk surface's rendered truth
  /// (ui/mic_permission_banner.dart is the renderer; chat_banner_sources.dart
  /// is the production wiring). All writes happen inside the flow — this class
  /// and the UI only call its verbs.
  final MicPermissionFlow micPermission;

  /// Fired when auth:expired drains the session (SaaS JWT socket only). The
  /// composition root routes it to LoginController.handleAuthExpired so the
  /// stored JWT is cleared and the user is driven back to login.
  final void Function()? onAuthExpired;
  late final ReconnectCoordinator reconnect;
  late final AuthExpiredHandler _authHandler;

  final SegmentBuffer segments = SegmentBuffer();

  /// Header state, consumed by WP-R3-2.
  final ValueNotifier<bool> paired = ValueNotifier<bool>(false);
  final ValueNotifier<String> connectedDeviceName = ValueNotifier<String>('');

  /// v0.2.1 — which CHANNEL the live connection actually runs on, as reported by
  /// the server itself (`/api/health.mode`). `null` = not asked / could not ask.
  ///
  /// owner 2026-07-28: a PC reached through the cloud relay was labelled 本地
  /// 局域网 ("Local LAN") because the chip read `destination.isFixed`, i.e.
  /// 「对端是不是虚拟云端实例」("whether the other end is a virtual cloud
  /// instance") — a different question with a different answer. This is the
  /// real one, and it
  /// stays `null` rather than guessing when the probe cannot answer: a chip that
  /// is absent tells the truth, a chip that is wrong does not.
  final ValueNotifier<ServerChannel?> serverChannel =
      ValueNotifier<ServerChannel?>(null);

  /// 🔴 RV-92 — whether 「**the PC this session is paired to**」 is right now
  /// in its room. The writer and the criteria table both live in
  /// [PcPresenceTracker] (`session/pc_presence.dart`), this class only
  /// **forwards** the wire fact: that value must not have a second writer,
  /// and a private field + read-only getter makes that structurally true.
  ///
  /// ⚠️ **A different question** from [serverChannel] / the socket's
  /// `ConnectionState` (those two answer 「what server am I connected to /
  /// is it up」). When the cloud relay is online but the PC has already left,
  /// they are all 「fine」, while this value is [PcPresence.offline] — that
  /// is exactly the scene owner ran into on 2026-08-01.
  final PcPresenceTracker _pcPresence = PcPresenceTracker();
  ValueListenable<PcPresence> get pcPresence => _pcPresence.listenable;

  /// 🔴 card L7 / owner 2026-08-02 item five —— 「another phone is currently
  /// connected to this PC」. The criteria, the bucketing rule, and 「why it is
  /// not inferred from a delivery failure」 all live in [PcBusyTracker]
  /// (session/pc_busy.dart), the same shape as [_pcPresence]: **privately
  /// held, single writer, this class only forwards**.
  final PcBusyTracker _pcBusy = PcBusyTracker();
  ValueListenable<bool> get pcBusyListenable => _pcBusy.listenable;
  bool pcBusyOnScreen(String? instanceId) => _pcBusy.isOnScreen(
    scopeKeyFor(machineUid: _pcMachineUid, pairingIdentity: instanceId),
  );
  // `_notePcBusy` is this tracker's one forwarding port, living in
  // ptt_reconnect_ack.dart (49-2).

  /// P-8 —— 「what the transcription engine on this PC itself said, the last
  /// time transcription started」. The criteria, the identity triple, and
  /// 「why `ready` may only be phrased as 'connected'」 all live in
  /// [LocalEngineStatusStore] (session/local_engine_status.dart); the sole
  /// writer is the `stt:engine-status` case in ptt_inbound.dart, and the
  /// reader is the connection-diagnostics sheet.
  final LocalEngineStatusStore engineStatus = LocalEngineStatusStore();

  /// card F2 / ruling ④ — 「which rows this screen reads, which bucket this
  /// screen's instantaneous state falls into」. The sole writer is
  /// [applyPairedIdentity] / [clearConnectedInstance] below, living and
  /// dying with the identity; the rules all live in [SessionScope]
  /// (session/machine_key.dart).
  final SessionScope scope = SessionScope();

  /// 49-2 / 49-3 —— 「whatever time the server says to come back, come back
  /// exactly then」. The criteria, the lower/upper bound, and 「why it must be
  /// kept separate from the occupancy banner」 are in [HoldOutRetry]; the
  /// wiring is in ptt_reconnect_ack.dart.
  final HoldOutRetry _holdOut = HoldOutRetry();
  /// Stops the timer on leaving the transcription page
  /// (connections_controller `leaveRoom()`).
  void cancelHoldOutRetry() => _holdOut.cancel();
  @visibleForTesting
  bool get holdOutArmed => _holdOut.armed;

  /// 🔴 F-1 (2026-08-03 real device) — **nobody could previously subscribe to
  /// the fact 「successfully joined the room」**, so the outbound queue had no
  /// choice but to drain off the earlier socket-connect edge. Why that was
  /// wrong, and what it cost, is at the sole-writer site of
  /// [PttSession.noteRoomJoined] in ptt_reconnect_ack.dart.
  final ValueNotifier<int> roomJoins = ValueNotifier<int>(0);
  void noteRoomJoined() => roomJoins.value++;

  /// Seam so the channel reading is testable without a network.
  HealthReader healthReader = httpHealthRead;

  /// G-15① seam + timeout for the idle presence poll; see ptt_presence_poll.dart.
  ///
  /// ⚠️ D2LAN-B3 made it NULLABLE, and null is the production value. The poll
  /// needs to hand `httpPcPresenceRead` this pairing's pin, which is a named
  /// argument [PcPresenceReader] does not carry — and widening that typedef
  /// would have invalidated every test double implementing it. Null therefore
  /// means 「use the production implementation, carrying the pin」, not 「don't
  /// poll」.
  PcPresenceReader? presenceReader;

  /// D2LAN-B4 seam — TOFU's first look. A field for the same reason
  /// [healthReader] is one: the production implementation opens a real TLS
  /// connection, and the pairing tests must be able to run without a network
  /// (and to state, deterministically, whether this address had a key to learn).
  LanFingerprintLearner lanFingerprintLearner = learnLanTlsFingerprint;
  Duration presencePollTimeout = const Duration(seconds: 3);

  /// 🔴 RV-89 addendum —— **which endpoint this measurement was taken on**.
  ///
  /// Without it, [serverChannel] is a value that 「doesn't say who it's
  /// about」, and since 0.2.34 it has been a **security criterion**:
  /// `imageOriginalAllowed(channel)` only offers the 「original image」 when
  /// `lan`; `null` is treated as cloud (Book 15 §1.1, fail-closed). ⇒ A stale
  /// `lan` would open the original image over the relay — exactly the thing
  /// owner explicitly forbade.
  String? _serverChannelEndpoint;

  // ── channel probe —— `_refreshServerChannel` (RV-89's three criteria in
  //    full) moved VERBATIM to ptt_channel_probe.dart (the 800-line gate,
  //    split along with SEG-2). See that file's header.

  /// owner 2026-07-27: the label of the PC this phone is connected to, or null
  /// when there isn't one. Lives here rather than at the call site because the
  /// name is session state — [connectedDeviceName] is maintained by the pair /
  /// reconnect acks and the device.pc_name rename event, all of which are this
  /// class's business. Stamped onto a timeline row when a delivery succeeds
  /// (see TimelineEntry.pcName for why the row keeps its own copy).
  String? get pcDisplayName {
    final String n = connectedDeviceName.value.trim();
    return n.isEmpty ? null : n;
  }

  /// V2-06a-1: the stable identity of the instance this phone is connected to,
  /// or null when it is not connected to one.
  ///
  /// Distinct from [pcDisplayName]: the name is what the user reads and can
  /// change, this is what history is keyed on and must survive a rename. Set
  /// on a successful pair / resume, cleared on leave — never guessed.
  String? get connectedInstanceId => _connectedInstanceId;
  String? _connectedInstanceId;

  /// card M / 🔴 owner 2026-07-31 iron rule (never cross-wire ids): the `pc_id` this session is
  /// PAIRED TO — the SAME value `TokenStorage`'s `MobileSession.pcId` persists
  /// (the pairing/reconnect ack's `pc_id`, mobile.handler.ts:143/:186/:245 →
  /// `pc.id`, i.e. `pc_devices.id`). Kept live here, synchronously, for the
  /// exact reason [connectedDeviceName] is: the delivery paths (ComposeGate's
  /// callers) stamp `inject:request.target_pc_id` from this on every send, and
  /// none of them can afford an async secure-storage read to do it — naming
  /// already established that rule, and this is the field the no-crosstalk red
  /// line is actually about.
  ///
  /// Null exactly when the stored [MobileSession.pcId] would be: a pairing made
  /// before 0.2.4 that has not yet completed one reconnect round-trip since.
  /// Every mobile:pair / mobile:reconnect ack carries `pc_id` unconditionally
  /// (mobile.handler.ts never omits it, cloud instance included), so this heals
  /// itself on the very next successful reconnect and is not a standing gap.
  String? get pcId => _pcId;
  String? _pcId;

  /// 🔴 Window B3-2a (gate 2) — the PHYSICAL MACHINE this connection reaches.
  /// **A queued delivery's destination is THIS; [pcId] is only what that
  /// machine is CALLED on the current channel** (outbox_destination.dart's
  /// header). Null before 0.2.4 and for the virtual cloud instance — forces
  /// the legacy branch, and NEVER guessed.
  String? get pcMachineUid => _pcMachineUid;
  String? _pcMachineUid;

  /// G-15① — same-ack identity as [_pcId]/[_pcMachineUid]; see ptt_presence_poll.dart.
  String? _channel;

  /// 🔴 THE ONE PLACE THIS CONNECTION LEARNS WHO IT IS TALKING TO — all off ONE
  /// enriched ack, so the identities share a lifetime by construction;
  /// [clearConnectedInstance] below is its exact inverse. EXTRACTED (Window B3-2c):
  /// `pair()` and `resumePairing()` each wrote these four lines verbatim, and the
  /// field that would eventually go missing from one copy is `pc_machine_uid` —
  /// the destination of every queued delivery.
  /// ⚠️ NOT A TEST BACKDOOR: RV-63 bans a setter for a value NOTHING IN
  /// PRODUCTION populates; this has two production callers (grep the name), so a
  /// harness calling it exercises the product's own stamping.
  /// D2LAN-B3 — the pinned LAN TLS fingerprint of the pairing this session is
  /// connected to, or null when it is not pinned (every relay pairing, every
  /// pre-D2-LAN row, every sidecar serving plain).
  ///
  /// 🔴 ONE READER OF THE STORED PIN, not a copy of it: it is written by
  /// [applyPairedIdentity] from the SAME `MobileSession` that supplies `pcId` and
  /// the scope, so it cannot describe a different pairing from the one those two
  /// describe. Every LAN http funnel takes its pin from here.
  String? get lanPin => _lanPin;
  String? _lanPin;

  /// D2LAN-B4 — 「what grounds do we have to trust this key」
  /// (`MobileSession.lanTlsFpSource`). A SECOND value because it is a second
  /// question: [lanPin] says WHICH key,
  /// this says WHERE IT CAME FROM, and the disclosure copy turns entirely on it.
  LanPinSource? get lanPinSource => _lanPinSource;
  LanPinSource? _lanPinSource;

  @visibleForTesting
  void applyPairedIdentity(MobileSession session) {
    _authValid = true;
    _lanPin = session.lanTlsFp;
    _lanPinSource = session.lanTlsFpSource;
    _connectedInstanceId = session.connectionIdentity;
    _pcId = session.pcId;
    _pcMachineUid = session.pcMachineUid; // gate 2: the SAME ack as `_pcId`.
    _channel = session.channel; // G-15①: same ack, see the field's doc.
    // card F2: same ack again — the read scope is learned where the identity is.
    scope.note(session: session, storage: tokenStorage);
  }

  /// Called when the phone leaves the room. Clearing is not optional: a stale
  /// identity here would stamp the NEXT instance's rows with the PREVIOUS
  /// instance's owner — history quietly attributed to the wrong machine, which
  /// is the mis-attribution class Book 13 §3 D4 records.
  /// 🔴 Window B3-2a DEPENDS ON THIS HAVING EXACTLY ONE CALLER — the user
  /// deliberately leaving (connections_controller `leaveRoom()`). A dropped
  /// socket / backgrounded app / severed TCP must NOT reach here: the outbox
  /// freezes its destination AT ENQUEUE, so every item queued during an
  /// outage would freeze an EMPTY one. Pinned by outbox_test.dart 「断网入队
  /// 冻结的是完整目的地」("what freezes into an offline-enqueued item is the
  /// FULL destination").
  void clearConnectedInstance() {
    // card L7 — the user left this instance on purpose; 「另一台手机占着**这台**
    // 电脑」("another phone is occupying **this** PC") is a statement about a
    // session that no longer exists. Cleared BEFORE the id it is bucketed by,
    // so the two can never disagree.
    this._notePcBusy(false); // extension member: Dart requires an explicit this
    scope.clear(); // card F2: exact inverse of applyPairedIdentity's note().
    _connectedInstanceId = null;
    _pcId = null;
    // Stale machine identity would let a delivery frozen for A pass the queue's
    // check on B. Clearing fails CLOSED.
    _pcMachineUid = null;
    // D2LAN-B3: a pin belongs to ONE pairing. Left behind, it would be handed to
    // the next pairing's http funnels, which refuse it against a plain URL and —
    // worse — would check the previous PC's key against this one. Fails closed:
    // null means 「treat as unpinned」, i.e. today's behaviour.
    _lanPin = null;
    _lanPinSource = null;
    _channel = null; // G-15①: fails toward a no-op poll tick, not a wrong answer.
    connectedDeviceName.value = '';
    // The channel label describes a LIVE connection. Keeping it past the end of
    // that connection is how a stale chip outlives the thing it was about.
    serverChannel.value = null;
    // RV-89 ③: drop 「which endpoint this measurement is about」 together with
    // it, otherwise reconnecting to the same address next time would be
    // judged 「the endpoint didn't change」 and skip the clear — treating an
    // already-void answer as still valid.
    _serverChannelEndpoint = null;
    // B4-15, same reasoning one layer over: a list of 「this PC's other
    // addresses」 is a fact about the pairing that just ended.
    // `_resolveReconnectUrl` already refuses to act on a list the current
    // url is not in, so this is belt on top of braces — but a stale address
    // set near the id-cross-wiring red line earns both.
    _dialCandidates = const <String>[];
    _pcPresence.noteLinkNotLive(); // RV-92/R3: by the same reasoning, presence
    // too is a statement 「said by this connection」
    _stopPresencePoll(); // G-15①: a deliberate departure doesn't wait for a
    // socket-disconnect event to turn it off.
  }

  // Presentation-facing inbound streams (WP-R3-2). Routed off the one dispatch
  // loop so the chat-flow layer never re-subscribes to the raw transport.
  final _injectResultCtl = StreamController<InjectResult>.broadcast();
  final _focusStateCtl = StreamController<FocusState>.broadcast();
  final _autoStoppedCtl = StreamController<String>.broadcast();
  final _aiComposeCtl = StreamController<AiComposeEvent>.broadcast();
  /// GA-14 stt:refined — a LATE, better version of an utterance that already
  /// settled. Deliberately its own stream: it carries no FSM meaning, and
  /// routing it through the final path would hand a finished utterance a second
  /// terminal (the wedging class GA-03 fixed).
  final _refinedCtl = StreamController<String>.broadcast();

  /// inject:result truth for the chat-flow badges (five-state write-back).
  Stream<InjectResult> get injectResults => _injectResultCtl.stream;

  /// GA-14: the second-pass transcript for the MOST RECENT utterance.
  Stream<String> get refinedTexts => _refinedCtl.stream;

  /// focus:state — the transient PC focus-app mirror for the header badge.
  Stream<FocusState> get focusStates => _focusStateCtl.stream;

  /// audio:auto-stopped — the recording ended without the user's release, so
  /// this drives a fail-loud, user-visible notice up to the chat flow (R6 P0-R3,
  /// 08 §B-5 never silent): the recording must NEVER just vanish from the user's
  /// view. Transient signal only — it does NOT touch the timeline schema /
  /// five-state status.
  ///
  /// 🔴 fix-026 — THE PAYLOAD IS THE WIRE `reason`, VERBATIM. This was
  /// `Stream<void>` and the arm pushed `null` into it, so the reason the server
  /// took the trouble to send (`AudioAutoStoppedSchema.reason`, filled in by
  /// fix-020's compile-checked table) was destroyed one line after it arrived —
  /// and the banner said 「录音已达 5 分钟上限」("recording has reached the
  /// 5-minute cap") for every cause there is.
  ///
  /// A `String` and not a Dart enum, deliberately: an enum here would be a
  /// SECOND hand-maintained copy of the protocol's list, and nothing binds such
  /// a copy to the registry (the open account behind the 0.2.53 defect, restated
  /// at `AppStrings.recordingAutoStoppedMessage`, which is the one place that
  /// turns this string into a sentence). Values this build has no sentence for
  /// travel through unchanged and are shown as the raw identifier rather than
  /// being smoothed into a neighbour's copy.
  ///
  /// ⚠️ Empty string = 「this frame didn't say」 (an off-contract frame;
  /// `reason` is required on the wire). It is NOT normalised to a default
  /// here — that is precisely
  /// the substitution this card removed.
  ///
  /// ⚠️ SEG-2 amendment (2026-08-11) to the fix-026 absolute above: the payload
  /// is the wire `reason` verbatim, OR one of the `local:`-prefixed values in
  /// audio/local_stop_reasons.dart (sole local writer: ptt_link_loss.dart —
  /// the connection is dead at that moment, so no wire frame exists to quote).
  /// The `local:` prefix is the collision guard: wire reasons are bare
  /// snake_case, so 「who said this」 stays answerable from the value itself.
  Stream<String> get autoStopped => _autoStoppedCtl.stream;

  /// compose:chunk / compose:done / compose:error — the AI buffer operations'
  /// reply stream (R6 T-3b ④, §3.4). Routed through this one dispatch loop like
  /// every other inbound family, so the chat-flow layer still never subscribes
  /// to the raw transport.
  Stream<AiComposeEvent> get aiComposeEvents => _aiComposeCtl.stream;

  /// GA-03: PROCESSING was closed without a terminal stt:final — the 15 s local
  /// safety net fired, or the engine reported a terminal stt:error. Re-exported
  /// straight off the FSM (NOT re-broadcast through a second controller): one
  /// source, one path, so the UI banner can never disagree with the FSM.
  Stream<SttStall> get sttStalled => fsm.sttStalled;

  StreamSubscription<SocketStatus>? _statusSub;
  StreamSubscription<EventEnvelope>? _incomingSub;
  StreamSubscription<CapturedChunk>? _chunkSub;
  StreamSubscription<String>? _faultSub;
  StreamSubscription<FlowmicStateSnapshot>? _linkLossSub; // SEG-2
  Timer? _heartbeatTimer;
  Timer? _presencePollTimer; // G-15①, see ptt_presence_poll.dart
  bool _presencePollInFlight = false; // re-entrancy guard, same file

  bool _authValid = true;
  // `_lastChunkSeq` lived here until 2026-07-31 purely to fill the
  // `audio:heartbeat` payload; both went out with that event (stage-5 cleanup).
  // AudioCapture owns the authoritative seq counter, so nothing else read it.

  // ─────────────────────────────────────────── pairing / connection
  //
  // `pair()` + `_tofuFingerprintFor()` live in ptt_pair.dart (800-line cap).

  /// Builds the isolated socket [retirePairing] dials. Production: `SocketCore`.
  final SocketTransport Function() _retireTransport;

  /// v0.2.3 — RETIRE this pairing on its own server. Body moved VERBATIM to
  /// pair_retire.dart for the 800-line cap; see there for the whole argument.
  Future<bool> retirePairing(MobileSession pairing) =>
      retirePairingOn(_retireTransport(), pairing);

  /// GA-10 — adopt a rename pushed by the PC we are actually talking to.
  /// Ignores a frame whose `pc_id` names a different machine; persists so the
  /// list shows the new name after a restart too.
  Future<void> _adoptPcName(String? pcId, String name) async {
    final MobileSession? current = await tokenStorage.readSession();
    if (current == null) return;
    if (pcId != null && current.pcId != null && current.pcId != pcId) return;
    connectedDeviceName.value = name;
    await tokenStorage.addOrUpdatePairing(current.copyWith(pcName: name));
  }

  /// Reconnect from the most-recent stored pairing on boot. Returns false when
  /// no session is stored.
  Future<bool> resumeFromStorage() async {
    final MobileSession? session = await tokenStorage.readSession();
    if (session == null) return false;
    return resumePairing(session);
  }

  /// 🔴 L-② — what the LAST `mobile:reconnect` was refused with (null = it
  /// succeeded / never asked). Sole writer: [emitMobileReconnectRouted]'s
  /// `onRejected`; cleared atop [resumePairing]. **Read synchronously right after
  /// the awaited call** — it is the return value that `bool` cannot carry, not a
  /// status to consult later.
  ReconnectRefusal? lastReconnectRefusal;

  /// SEG-2 (§2-R5) — the `audio_last_contiguous_seq` watermark off the MOST
  /// RECENT accepted `mobile:reconnect` ack, or null when no usable one was
  /// carried. Sole writer: `emitMobileReconnectRouted`'s `onAccepted`
  /// (ptt_reconnect_ack.dart, marked edit ④); reset to null atop
  /// [_onReconnected] so every ring replay is trimmed by THIS span's ack or
  /// not at all — a stale watermark from an earlier span (or an earlier
  /// recording, whose seqs restart at 0) must degrade to FULL replay
  /// (duplication, deduped server-side), never to trimming unproven audio.
  int? _reconnectAckAudioSeq;

  /// Connect to [session]'s endpoint and rejoin by token (mobile:reconnect) — the
  /// path the connections list drives when the user taps a remembered PC (Option
  /// B: startup does NOT auto-connect; a tap does). Fail-loud: a bad endpoint or a
  /// rejected token returns false, and [lastReconnectRefusal] says WHY in the
  /// server's own words. ⚠️ Only an `AUTH_TOKEN_INVALID` reject purges the local
  /// session inside the reconnect flow — a hold-out (`PAIR_RELEASED` / `PC_BUSY`)
  /// deliberately keeps the token, so the caller must not treat the two alike.
  Future<bool> resumePairing(MobileSession session) async {
    lastReconnectRefusal = null; // never answer this attempt with the last one's
    if (session.endpoint.isEmpty) return false;
    // B4-15 — after a network change, if the original address is unreachable,
    // fall back to this PC's other address. The stored endpoint leads
    // (it is where a connection last really succeeded), so an unchanged network
    // picks the same address again and nothing is rewritten.
    final List<String> candidates =
        rememberedDialCandidates(session.endpoint, session.endpointCandidates);
    final EndpointChoice choice = await chooseDialEndpoint(
      candidates: candidates,
      read: healthReader,
      timeout: candidateProbeTimeout,
    );
    final String dial = choice.endpoint.isEmpty ? session.endpoint : choice.endpoint;
    try {
      await transport.connect(
        url: dial,
        token: session.token,
        // D2LAN-B3 — a remembered pairing dials under the key it remembers. Null
        // for an unpinned row, which is every pre-D2-LAN pairing and every relay
        // one, and then this call is byte-for-byte the old one.
        pinFingerprint: session.lanTlsFp,
      );
    } on Object {
      // 🔴 D2LAN-B3 — 「the other side rotated its key」 must not arrive as
      // 「unknown error」 either.
      // Reported through the SAME loud-candidate channel `pair` uses, so there is
      // one sentence for one fact rather than a second wording that can drift.
      if (transport.lastDialPinMismatch) {
        lastReconnectRefusal = ReconnectRefusal(
          code: encodeCandidateFailure(
            attempts: choice.attempts,
            dialed: dial,
            dialedPinMismatch: true,
          ),
        );
        return false;
      }
      // PC unpaired ⇒ the handshake itself is refused, there is no ack to read,
      // and the answer is on lastConnectError (see [handshakeRefusal]).
      // Previously this just returned false, so the UI said 「unknown error」.
      lastReconnectRefusal = handshakeRefusal(transport);
      return false;
    }
    // The row is keyed on the PC's instance id, not on its address, so this
    // UPDATES the remembered pairing rather than forking a second one.
    final MobileSession live =
        dial == session.endpoint ? session : session.copyWith(endpoint: dial);
    applyPairedIdentity(live);
    // Tapped PC → most-recent resume target (move-to-front, same identity).
    await tokenStorage.addOrUpdatePairing(live);
    final String? name = live.pcName;
    if (name != null && name.isNotEmpty) connectedDeviceName.value = name;
    unawaited(_refreshServerChannel(dial));
    _dialCandidates = candidates.length > 1 ? candidates : const <String>[];
    reconnect.configure(
      url: dial,
      token: live.token,
      replaceToken: true,
      // D2LAN-B3 — the SAME key this dial just succeeded under. Without it the
      // ladder re-dialled unpinned, which on a pinned pairing cannot connect at
      // all (see ReconnectCoordinator._pin) — so one drop ended the session
      // until the user tapped this PC again by hand.
      pinFingerprint: live.lanTlsFp,
      replacePin: true,
    );
    reconnect.start();
    return _emitMobileReconnect(live.token);
  }

  /// B4-15 — the addresses the CURRENT pairing may be dialled on, as its QR
  /// declared them, in the shape the ladder dials. Written by [pair] /
  /// [resumePairing] only; empty for every single-address pairing, which is what
  /// keeps the ladder's resolver inert. The whole decision lives in
  /// `endpoint_candidates.resolveLadderUrl` (incl. the id-cross-wiring refusal).
  List<String> _dialCandidates = const <String>[];

  /// How long one candidate probe may take. A field so a harness can shrink it;
  /// 2 s is a LAN round-trip with room to spare, and it is also the WORST the
  /// whole selection can cost, because the probes run in parallel.
  Duration candidateProbeTimeout = const Duration(seconds: 2);

  Future<String?> _resolveReconnectUrl(String current) => resolveLadderUrl(
    current: current,
    known: _dialCandidates,
    read: healthReader,
    timeout: candidateProbeTimeout,
  );

  Future<void> _onReconnected() async {
    // SEG-2 — every ring replay is chained on THIS future (`_fireRejoin`), so
    // start from 「no watermark」 and let this attempt's ack supply one. This
    // one line covers the empty-token early return below, every rejected /
    // timed-out attempt, and staleness across recordings, in the safe
    // direction (null = full replay).
    _reconnectAckAudioSeq = null;
    final String? token = reconnect.token;
    if (token == null || token.isEmpty) return;
    // RV-89 ①: re-ask on every reconnect, so a probe that failed once (a dead
    // moment, a `ws://` endpoint on a pre-fix build) is not a life sentence of
    // 「channel unknown」 for the whole session. Fire-and-forget for the same reason the
    // pair/resume calls are: the label is not a precondition for talking.
    final String? url = reconnect.url;
    if (url != null && url.isNotEmpty) unawaited(_refreshServerChannel(url));
    final bool ok = await _emitMobileReconnect(token);
    // B4-15 — the ladder may have healed onto a different NIC of the same PC.
    // Persisted only after the token was ACCEPTED there: a dial that connects
    // proves nothing about admission, and writing the address down earlier is
    // the same mistake `resumePairing`'s own comment warns about.
    if (ok && url != null && url.isNotEmpty) {
      await persistDialedEndpoint(storage: tokenStorage, token: token, url: url);
    }
  }

  // 800-line cap (card L7): the body moved VERBATIM to ptt_reconnect_ack.dart —
  // the NAME stays here so every call site is untouched, exactly as
  // chat_controller.dart does for its own part families.
  Future<bool> _emitMobileReconnect(String token) =>
      emitMobileReconnectRouted(this, token);

  // ─────────────────────────────────────────── PTT gestures

  /// PTT down: gate on CONNECTED+IDLE via the FSM, then on the mic permission
  /// (card U2 — [micPermission], which renders its own refusal), then start
  /// capture and emit audio:start with the fixed [delivery] (§4.0 B). Returns
  /// false if any gate refused (not connected / already recording / mic
  /// permission missing / capture failed to start).
  Future<bool> pttDown({
    FlowMode mode = FlowMode.realtime,
    String sourceLang = 'zh',
    String? targetLang,
    Delivery delivery = Delivery.inject,
    SendPolicy sendPolicy = SendPolicy.direct,
  }) async {
    if (fsm.connection != ConnectionState.connected) return false;
    if (fsm.session != SessionState.idle) return false;
    // card U2 ① — the permission gate runs BEFORE capture, so the FIRST OS dialog
    // is never cold-fired in mid-gesture (the audit's finding): the request is
    // born on the rendered rationale surface, not under the user's thumb. A
    // false return has already written the face the banner renders, so the
    // refusal is on screen — and the FSM never left IDLE, so the next hold
    // starts clean (no stuck RECORDING, nothing to unwind).
    if (!await micPermission.gateForPtt()) return false;
    segments.clear();
    try {
      await audio.start();
    } on Object {
      // U2 ④ — this branch used to `return false` behind a comment claiming
      // 「fail-loud」 while surfacing nothing (anti-façade ④: the comment was an
      // expired truth). Now it IS loud: the flow re-probes the OS and renders
      // the honest face — denied / permanently-denied / 「recording could not
      // start」 when the permission is actually green. PTT still never entered
      // RECORDING.
      await micPermission.noteCaptureStartRefused();
      return false;
    }
    fsm.onPttDown();
    transport.emit(
      FlowMicEvents.audioStart,
      AudioStartPayload(
        mode: mode,
        sourceLang: sourceLang,
        targetLang: targetLang,
        sendPolicy: sendPolicy,
        delivery: delivery,
      ).toJson(),
    );
    _startHeartbeat();
    return true;
  }

  /// PTT up: flush the < 200 ms residual tail AHEAD of audio:stop (F-2223), then
  /// stop capture and move the FSM to PROCESSING (awaits stt:final).
  Future<void> pttUp() async {
    if (fsm.session != SessionState.recording) return;
    final CapturedChunk? residual = audio.takeResidualChunk();
    if (residual != null) {
      _emitChunk(residual);
    }
    _stopHeartbeat();
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    await audio.stop();
    fsm.onPttUp();
  }

  /// PTT swipe-up cancel: abort mid-utterance. The utterance never completed, so
  /// NO timeline entry is built (§4.0 A). Fences audio immediately, tells the
  /// server to discard (audio:stop), and returns the FSM to IDLE.
  Future<void> pttCancel() async {
    if (fsm.session != SessionState.recording) return;
    audio.fenceAndStop();
    _stopHeartbeat();
    segments.clear();
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    fsm.onPttCancel();
  }

  // ── capture pump —— `pauseCapture` / `resumeCapture` / `_onCaptureFault` /
  //    `_onCapturedChunk` / `_emitChunk` moved VERBATIM to
  //    ptt_capture_pump.dart (800-line cap). See that file's header.

  // ── keep-alive —— the whole `_startHeartbeat` / `_stopHeartbeat` /
  //    `_safeEmit` family moved VERBATIM to ptt_wire_keepalive.dart (the
  //    800-line gate). See that file's header.

  // ── inbound dispatch —— the whole section moved VERBATIM to
  //    ptt_inbound.dart (a split that came along with RV-92: this file was
  //    already up against the 800-line cap). See that file's header.
  void _onIncoming(EventEnvelope env) => _onIncomingRouted(env);

  // _handleResendRequest() was retired together with `audio:resend-request`
  // on 2026-07-31 — see the dispatch site.

  // ── teardown —— dispose() in ptt_session_dispose.dart (800-line cap / IT-10).
  Future<void> dispose() async => _disposeRouted();
}
