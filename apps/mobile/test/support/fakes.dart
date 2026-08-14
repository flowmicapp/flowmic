// Test doubles shared across the FSM / reconnect / audio / session suites.
// No platform plugins, no real sockets — everything is driven deterministically.

import 'dart:async';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/signaling/socket_core.dart';

/// A fully in-memory [SocketTransport]. Records every emit, lets a test push
/// inbound events + status transitions, and answers emitWithAck from a queue.
class FakeSocketTransport implements SocketTransport {
  final _statusCtl = StreamController<SocketStatus>.broadcast(sync: true);
  final _incomingCtl = StreamController<EventEnvelope>.broadcast(sync: true);

  // RCA-v3: the fake is born CONNECTED. ComposeGate now refuses to emit on a
  // link the client knows is down (the honest half of the dead-socket fix), so
  // a fake that starts disconnected would silently veto every test emit. A
  // test that wants the down-link behaviour pushes it explicitly
  // (pushStatus(SocketStatus.disconnected)) — which is also the truthful way
  // to say what that test means.
  SocketStatus _status = SocketStatus.connected;
  String? _lastConnectError;

  /// Every (event, payload) passed to [emit], in order.
  final List<EventEnvelope> emitted = <EventEnvelope>[];

  /// When true, [emit] THROWS instead of recording — the shape a dead socket
  /// really has (ComposeGate/TimelineSyncGate catch it and report fail-loud).
  /// Lets a test drive the "the frame never left the device" branch.
  bool failEmits = false;

  /// Acks answered by [emitWithAck], FIFO. Falls back to [defaultAck].
  /// RCA-v3: the default is the server's SUCCESS shape ({ok:true}) — the
  /// delivery ack-gate reads it, and a default of {} would silently route
  /// every test delivery into the link-recovery path. A test that wants a
  /// failing ack queues one (or sets [failEmits]).
  final List<Object?> ackQueue = <Object?>[];
  Object? defaultAck = <String, Object?>{'ok': true};

  /// What [connect] does to the status when its timer fires in a reconnect
  /// ladder test: true → push `connected`, false → push `error`.
  bool connectSucceeds = false;
  int connectCalls = 0;

  /// The handshake args of the LAST connect (so tests can assert a cloud
  /// admission dialled the SaaS endpoint carrying auth.jwt).
  String? lastConnectUrl;
  String? lastConnectToken;
  String? lastConnectJwt;

  /// D2LAN-B3 — the pinned SPKI fingerprint the dial carried, so a test can
  /// assert that a pinned pairing dials `wss://` WITH its pin rather than
  /// merely that the URL changed.
  String? lastConnectPin;

  @override
  Stream<SocketStatus> get status => _statusCtl.stream;

  @override
  SocketStatus get currentStatus => _status;

  @override
  Stream<EventEnvelope> get incoming => _incomingCtl.stream;

  @override
  String? get lastConnectError => _lastConnectError;

  void setLastConnectError(String? e) => _lastConnectError = e;

  /// D2LAN-B3 — settable so a test can say "this dial failed because the fingerprint did not match"
  /// and watch the pairing path produce a DIFFERENT message from "unreachable".
  @override
  bool lastDialPinMismatch = false;

  @override
  LinkEncryption lastLinkEncryption = LinkEncryption.unknown;

  /// Push a status transition as if the real socket changed state.
  void pushStatus(SocketStatus s) {
    _status = s;
    _statusCtl.add(s);
  }

  /// Push an inbound server event into the dispatch loop.
  void pushIncoming(String event, Object? data) {
    _incomingCtl.add(EventEnvelope(event, data));
  }

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    connectCalls++;
    lastConnectUrl = url;
    lastConnectToken = token;
    lastConnectJwt = jwt;
    lastConnectPin = pinFingerprint;
    pushStatus(connectSucceeds ? SocketStatus.connected : SocketStatus.error);
  }

  @override
  Future<void> disconnect() async {
    pushStatus(SocketStatus.disconnected);
  }

  @override
  void emit(String event, Object? payload) {
    if (failEmits) throw StateError('fake transport: emit refused');
    // Mirrors the real transport's truth: a link that is not connected cannot
    // carry a frame (the real emitWithAck times out into an error; the real
    // emit buffers into a doomed adapter). Tests reach this only when they
    // explicitly pushed a non-connected status — which is the test SAYING the
    // link is down, so the fake must not deliver anyway.
    if (_status != SocketStatus.connected) {
      throw StateError('fake transport: emit while $_status');
    }
    emitted.add(EventEnvelope(event, payload));
  }

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) async {
    // A dead socket fails BOTH emit shapes — an acked emit that still resolved
    // while [failEmits] was set would let a test "prove" a flush that could not
    // have happened.
    if (failEmits) throw StateError('fake transport: emitWithAck refused');
    if (_status != SocketStatus.connected) {
      throw StateError('fake transport: emitWithAck while $_status');
    }
    emitted.add(EventEnvelope(event, payload));
    final Object? ack = ackQueue.isNotEmpty ? ackQueue.removeAt(0) : defaultAck;
    return ack as R;
  }

  /// Event names emitted, for compact assertions.
  List<String> get emittedNames => emitted.map((e) => e.name).toList();

  List<EventEnvelope> emittedWhere(String name) =>
      emitted.where((e) => e.name == name).toList();

  Future<void> close() async {
    await _statusCtl.close();
    await _incomingCtl.close();
  }
}

/// An [AudioRecorder] whose PCM stream a test feeds by hand. Permission is
/// granted by default so the capture fast-path runs.
class FakeAudioRecorder implements AudioRecorder {
  FakeAudioRecorder({this.permission = true});

  bool permission;
  StreamController<Uint8List>? _ctl;
  bool started = false;

  @override
  Future<bool> hasPermission() async => permission;

  @override
  Future<void> start({required int sampleRate, required int numChannels}) async {
    started = true;
    _ctl = StreamController<Uint8List>.broadcast();
  }

  @override
  Stream<Uint8List> get pcmStream =>
      (_ctl ??= StreamController<Uint8List>.broadcast()).stream;

  /// Feed a PCM frame into the pipeline.
  void feed(Uint8List bytes) => _ctl?.add(bytes);

  @override
  Future<void> stop() async {
    started = false;
    await _ctl?.close();
    _ctl = null;
  }
}

/// Build [n] bytes of deterministic non-silent PCM (a low-frequency ramp so the
/// dBFS meter reads above the -100 floor).
Uint8List makePcm(int nBytes, {int amplitude = 8000}) {
  final Int16List samples = Int16List(nBytes ~/ 2);
  for (int i = 0; i < samples.length; i++) {
    samples[i] = (amplitude * ((i % 32) - 16) ~/ 16);
  }
  return samples.buffer.asUint8List();
}
