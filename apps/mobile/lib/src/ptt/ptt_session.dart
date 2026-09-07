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
import '../audio/article_scribe.dart';
import '../audio/continuous_cap_timer.dart';
import '../audio/continuous_recording.dart';
import '../audio/screen_wake.dart';
import '../audio/local_stop_reasons.dart';
import '../audio/real_audio_recorder.dart';
import '../audio/replay_ownership.dart';
import '../audio/retained_audio_manifest.dart'
    show JournalInterrupt, RecordingManifest;
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
import '../session/presence_route.dart';
import '../session/recovery_identity.dart';
import '../session/platform_device_info.dart';
import '../timeline/article.dart' show pcmBytesToMs;
import '../signaling/auth_expired_handler.dart';
import '../signaling/health_handler.dart';
import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart';
import '../signaling/inbound_payloads.dart';
import '../signaling/mobile_reconnect_flow.dart';
import '../signaling/node_follow.dart' show answeringNode, pcHomeNodeOf, settledAtHomeNode;
import '../signaling/node_list_client.dart' show httpNodeListFetch, planNodeHop, planSelfNodeHop;
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

// 800-line cap: `PairResult` moved VERBATIM to pair_result.dart (Window B3-2a),
// re-exported so existing imports still see it.
export 'pair_result.dart';

// 800-line cap: the whole inbound dispatch section moved VERBATIM (see its header).
part 'ptt_inbound.dart';

// 800-line cap (D2LAN-B3/B4): `pair()` + the TOFU look-once moved VERBATIM.
part 'ptt_pair.dart';

// 800-line cap: G-15① idle PC-presence poll lives here (see its header).
part 'ptt_presence_poll.dart';

// 800-line cap (card L7): the mobile:reconnect ack callbacks moved VERBATIM (+2 marked edits) — see that file's diff-discipline note.
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

// 800-line cap: the three PTT edges (down / up / cancel) moved VERBATIM —
// see that file's header.
part 'ptt_edges.dart';
part 'ptt_continuous.dart'; // CR-2/CR-6/CR-9 — the continuous lifecycle.
part 'ptt_backfill.dart'; // CR-5 — the re-transcription channel's wire half.

// 800-line cap: the stored-pairing resume / reconnect-dial family moved
// VERBATIM — see that file's header.
part 'ptt_resume.dart';

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
    required this.tokenStorage,
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
             asked: const SharedPrefsMicAskedStore(),
           ),
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
          // 🔴 CARD RC-1a / AUDIT P1-2 - the ring replay asks before it emits.
          // Inert while the journal storage face is off (the gate answers null
          // and the replay is byte-for-byte what it always was); once RC-1
          // turns it on, this stops the ladder and a recovery attempt sending
          // the same samples on the same socket.
          replayGate: () => replayRefusalFor(
            journalFaceOn: this.audio.retainedAudio?.retainFromFirstFrame ?? false,
            ownership: this.audio.retainedAudio?.replayOwnership,
            recorderRunning: fsm.session == SessionState.recording,
            serverAudioWatermark: _reconnectAckAudioSeq,
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
      tokenStorage: tokenStorage,
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
    // Card CR-3 — the 「is this capture a continuous one?」 fact. Bound to the
    // recorder's own transition stream so it clears itself on every ending
    // path rather than having to be remembered; the asymmetry of the two
    // failure directions is written out in continuous_recording.dart.
    continuous = ContinuousRecording(recorderState: this.audio.state);
    wireCaptureEndedEdge(); // D-1b, body + rationale in ptt_continuous.dart
  }

  /// Card CR-6 — the per-sitting ceiling, armed with the number the SERVER
  /// issued. Card CR-2 — the screen hold. Cards CR-7/CR-8 — which article a row
  /// belongs to and where inside it. One lifecycle, written in
  /// ptt_continuous.dart: [beginContinuous] / [endContinuous] — except that the
  /// scribe is deliberately NOT closed by the latter (article_scribe.dart says
  /// why, and it is not the C8 bug it resembles).
  final ContinuousCapTimer capTimer = ContinuousCapTimer();
  final ScreenWakeHold screenWake = ScreenWakeHold();
  final ArticleScribe articles = ArticleScribe();

  final SocketTransport transport;
  final FlowmicStateMachine fsm;
  final AudioCapture audio;
  final TokenStorage tokenStorage;
  final SttStream stt;

  /// Card CR-3 — set by the continuous-recording entry, read by the link-loss
  /// edge. Ordinary push-to-talk never touches it, which is what keeps its
  /// behaviour unchanged.
  late final ContinuousRecording continuous;
  /// D-1b — 「a capture just ended」 as an EDGE; `wireCaptureEndedEdge`
  /// (ptt_continuous.dart) has the account. Consumers re-ask the predicate.
  final ValueNotifier<int> captureStopped = ValueNotifier<int>(0);
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
  final PcReleaseCooldown releaseCooldown = PcReleaseCooldown(); // owner 2026-08-20 — full rationale in its own file; the OPPOSITE of _holdOut above: a deadline, never a dialler.
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
  void noteRoomJoined({required bool atHomeNode}) { reconnect.noteJoinAtHomeNode(atHomeNode); roomJoins.value++; } // P0: the verdict BEFORE the edge — see ReconnectCoordinator.lastJoinAtHomeNode

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

  // ── identity lifecycle —— bodies moved VERBATIM to ptt_resume.dart (800-line
  //    cap) as routed top-level functions (exactly `_emitMobileReconnect`'s
  //    own pattern, not an extension): both names are called under a `show
  //    PttSession`-only import in test/g20_instance_bucket_test.dart, and an
  //    extension member is invisible there — only a REAL instance method is.
  //    The fields above stay here (Dart has no partial classes).
  @visibleForTesting
  void applyPairedIdentity(MobileSession session) =>
      applyPairedIdentityRouted(this, session);

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
  void clearConnectedInstance() => clearConnectedInstanceRouted(this);

  // Presentation-facing inbound streams (WP-R3-2). Routed off the one dispatch
  // loop so the chat-flow layer never re-subscribes to the raw transport.
  final _injectResultCtl = StreamController<InjectResult>.broadcast();
  final _focusStateCtl = StreamController<FocusState>.broadcast();
  final _autoStoppedCtl = StreamController<String>.broadcast();
  final _aiComposeCtl = StreamController<AiComposeEvent>.broadcast();
  /// GA-14 stt:refined — a LATE, better version of an utterance that already
  /// settled. Deliberately its own stream: it carries no FSM meaning, and routing
  /// it through the final path would hand a finished utterance a second terminal
  /// (the wedging class GA-03 fixed).
  final _refinedCtl = StreamController<SttRefined>.broadcast();

  /// inject:result truth for the chat-flow badges (five-state write-back).
  Stream<InjectResult> get injectResults => _injectResultCtl.stream;

  /// GA-14 / D7 ③: the second-pass transcript, NAMED by its utterance id (frames without one never reach here).
  Stream<SttRefined> get refinedTexts => _refinedCtl.stream;

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
  StreamSubscription<RecorderState>? _recorderStateSub; // D-1b, see the ctor
  Timer? _heartbeatTimer;
  Timer? _presencePollTimer; // G-15①, see ptt_presence_poll.dart
  bool _presencePollInFlight = false; // re-entrancy guard, same file

  bool _authValid = true;

  /// Card FX-2 — the `delivery` that went out on the `audio:start` currently
  /// open, whoever opened it.
  ///
  /// 🔴 IT EXISTS BECAUSE THE ROW LAYER WAS READING THE WRONG SNAPSHOT.
  /// `ChatController._activeDelivery` is written in `pttDown` and nowhere else,
  /// so after a relaunch it holds the DEFAULT (`inject`) and after a live press
  /// it holds THAT PRESS's destination. `beginBackfill` opens a session with
  /// `delivery: none` and never touched it — so the terminal final of a
  /// RECOVERY attempt was minted as an injectable row and delivered to the PC.
  ///
  /// MEASURED 2026-09-06 (drill DF-2 note (a) / B-11): after a force-stop
  /// mid-press and a relaunch, the recovery attempt's transcript reached the PC
  /// as `inject:request` with `inject_origin:"live"`, while the manifest called
  /// the attempt `auto_retry`. The server was not the leak — it gates its own
  /// fan-out on `delivery !== 'none'` (`audio.handler.ts`) and correctly sent
  /// nothing; the phone delivered it itself, out of its own outbox.
  ///
  /// ⚠️ NOT CLEARED WHEN A BACKFILL ENDS. The terminal final can arrive inside
  /// `endBackfill` (see `RecoveryJournalLeg`'s note on that), so a flag that
  /// went false there would be false exactly when it is read. It is overwritten
  /// by whoever opens the NEXT session, which is the only moment the answer
  /// legitimately changes.
  Delivery _openSessionDelivery = Delivery.inject;

  /// See [_openSessionDelivery]. `Delivery.none` while a recovery attempt owns
  /// the wire.
  Delivery get openSessionDelivery => _openSessionDelivery;

  /// Card FX-3 — the sample range the open session is re-feeding, or null when
  /// the open session is a live press.
  ///
  /// It is HOW MUCH AUDIO WENT IN, which for a recovery is the only measure of
  /// the recording that anything on this phone can take. The row layer used to
  /// have nothing but the engine's own `duration_ms` per span, and drill DF-2
  /// (b) measured what that is worth on this leg: 「0.5s · 10 words」 for 7.6 s
  /// of audio the server itself logged as `audioMs 7600`.
  RecoverySampleRange? _openSessionRange;

  /// See [_openSessionRange].
  RecoverySampleRange? get openSessionRange => _openSessionRange;
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

  // ── stored-pairing resume —— `_adoptPcName` / `resumeFromStorage` /
  //    `resumePairing` / `_resolveReconnectUrl` / `_onReconnected` moved
  //    VERBATIM to ptt_resume.dart (800-line cap). The fields below stay here
  //    (Dart has no partial classes); see that file's header.

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

  // 800-line cap (card L7): the body moved VERBATIM to ptt_reconnect_ack.dart —
  // the NAME stays here so every call site is untouched, exactly as
  // chat_controller.dart does for its own part families.
  Future<bool> _emitMobileReconnect(String token) =>
      emitMobileReconnectRouted(this, token);

  // ─────────────────────────────────────────── PTT gestures

  /// PTT down: gate on CONNECTED + [sessionAcceptsPttDown] (NR-4-P1 (a): IDLE
  /// or the cosmetic JUST_DONE window — that predicate owns the rationale and
  /// the PROCESSING boundary), then the mic permission (card U2 —
  /// [micPermission], which renders its own refusal), then start capture and
  /// emit audio:start with the fixed [delivery] (§4.0 B).
  // ── PTT edges —— `pttDown` / `pttUp` / `pttCancel` moved VERBATIM to
  //    ptt_edges.dart (800-line cap, the tenth split on this file). See that
  //    file's header for the diff discipline.

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
