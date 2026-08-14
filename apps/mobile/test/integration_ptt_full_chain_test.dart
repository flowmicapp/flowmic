// PTT full-chain integration test (WP-R3-1 acceptance): drive the REAL mobile
// data layer (SocketCore + AudioCapture + PttSession) against a running
// server-core, feeding a WAV file as the capture source, and assert a real
// stt:final comes back.
//
//   fake audio (zh WAV) → audio:start(delivery) → audio:chunk* → audio:stop
//     → server-core → LAN funasr → stt:interim* → terminal stt:final
//
// Opt-in: set FLOWMIC_TEST_URL to a running server (http://host:port). The
// harness apps/mobile/tool/run_integration.mjs spawns server-core, sets the env,
// and runs this. Without the env the test SKIPS (CI-safe / no LAN dependency).
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §2-4.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/stt/stt_stream.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

/// Wraps a real SocketTransport and records every emitted event name so the
/// delivery:none chain can assert the phone NEVER forwarded a history:create
/// (the emit-side filter is observable at the wire boundary).
class RecordingTransport implements SocketTransport {
  RecordingTransport(this._inner);
  final SocketTransport _inner;
  final List<EventEnvelope> emitted = <EventEnvelope>[];
  List<String> get emittedNames =>
      emitted.map((EventEnvelope e) => e.name).toList();
  EventEnvelope? firstEmitted(String name) {
    for (final EventEnvelope e in emitted) {
      if (e.name == name) return e;
    }
    return null;
  }

  @override
  Stream<SocketStatus> get status => _inner.status;
  @override
  SocketStatus get currentStatus => _inner.currentStatus;
  @override
  Stream<EventEnvelope> get incoming => _inner.incoming;
  @override
  String? get lastConnectError => _inner.lastConnectError;
  @override
  LinkEncryption get lastLinkEncryption => _inner.lastLinkEncryption;
  @override
  bool get lastDialPinMismatch => _inner.lastDialPinMismatch;
  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) => _inner.connect(
    url: url,
    token: token,
    jwt: jwt,
    pinFingerprint: pinFingerprint,
  );
  @override
  Future<void> disconnect() => _inner.disconnect();
  @override
  void emit(String event, Object? payload) {
    emitted.add(EventEnvelope(event, payload));
    _inner.emit(event, payload);
  }

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) {
    emitted.add(EventEnvelope(event, payload));
    return _inner.emitWithAck<R>(event, payload, timeout: timeout);
  }
}

/// AudioRecorder that streams a WAV file's PCM as 6400-byte (200 ms) frames on
/// a timer, so AudioCapture drives the whole pipeline from a deterministic
/// source instead of the microphone.
class WavFileRecorder implements AudioRecorder {
  WavFileRecorder(this._pcm, {this.frameBytes = 6400, this.interval = const Duration(milliseconds: 40)});

  final Uint8List _pcm;
  final int frameBytes;
  final Duration interval;
  StreamController<Uint8List>? _ctl;
  Timer? _timer;
  int _offset = 0;
  final Completer<void> _done = Completer<void>();

  /// Completes once every frame has been emitted.
  Future<void> get done => _done.future;

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start({required int sampleRate, required int numChannels}) async {
    _ctl = StreamController<Uint8List>.broadcast();
    _offset = 0;
    // First tick fires after [interval], so the caller's audio:start is emitted
    // ahead of the first audio:chunk.
    _timer = Timer.periodic(interval, (t) {
      if (_offset >= _pcm.length) {
        t.cancel();
        if (!_done.isCompleted) _done.complete();
        return;
      }
      final int end = (_offset + frameBytes).clamp(0, _pcm.length);
      _ctl?.add(Uint8List.sublistView(_pcm, _offset, end));
      _offset = end;
    });
  }

  @override
  Stream<Uint8List> get pcmStream =>
      (_ctl ??= StreamController<Uint8List>.broadcast()).stream;

  @override
  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    if (!_done.isCompleted) _done.complete();
    await _ctl?.close();
    _ctl = null;
  }
}

Uint8List _wavPcm(String path) {
  final Uint8List bytes = File(path).readAsBytesSync();
  final ByteData bd = ByteData.sublistView(bytes);
  int off = 12; // skip RIFF(4) size(4) WAVE(4)
  while (off + 8 <= bytes.length) {
    final String id = String.fromCharCodes(bytes.sublist(off, off + 4));
    final int size = bd.getUint32(off + 4, Endian.little);
    if (id == 'data') return Uint8List.sublistView(bytes, off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw StateError('no data chunk in $path');
}

/// Minimal raw PC peer: register and return the 4-digit short code so the mobile
/// can pair (mirrors the desktop's pc:register). Uses socket_io_client directly.
Future<(io.Socket, String)> registerPc(String url) async {
  final socket = io.io(
    url,
    io.OptionBuilder()
        .setTransports(['websocket'])
        .disableAutoConnect()
        .disableReconnection()
        .enableForceNew()
        .build(),
  );
  final connected = Completer<void>();
  socket.onConnect((_) => connected.complete());
  socket.connect();
  await connected.future.timeout(const Duration(seconds: 8));
  final ackC = Completer<Map<dynamic, dynamic>>();
  socket.emitWithAck(
    'pc:register',
    <String, Object?>{
      'device_name': 'Integration PC',
      'client_instance_id': 'inst-integration-0123456789',
    },
    ack: (dynamic r) => ackC.complete(r as Map<dynamic, dynamic>),
  );
  final reg = await ackC.future.timeout(const Duration(seconds: 8));
  return (socket, reg['short_code'] as String);
}

void main() {
  final String? url = Platform.environment['FLOWMIC_TEST_URL'];

  if (url == null || url.isEmpty) {
    test('PTT full chain (skipped — set FLOWMIC_TEST_URL to a running server)',
        () {}, skip: 'FLOWMIC_TEST_URL not set');
    return;
  }

  test('PTT full chain: mobile PttSession → server-core → LAN funasr → stt:final',
      () async {
    final Uint8List pcm = _wavPcm('integration_test/fixtures/zh-6s.wav');

    // PC peer registers → short code.
    final (io.Socket pc, String shortCode) = await registerPc(url);

    // Mobile: the REAL data layer (SocketCore transport + AudioCapture fed by
    // the WAV recorder).
    final WavFileRecorder recorder = WavFileRecorder(pcm);
    final PttSession session = newTestSession(
      transport: SocketCore(),
      audio: AudioCapture(recorder: recorder),
    );

    final Completer<SttFinal> terminal = Completer<SttFinal>();
    session.stt.finals.listen((SttFinal f) {
      if (!f.isSegment && !terminal.isCompleted) terminal.complete(f);
    });

    final PairResult pair =
        await session.pair(PairEntry.parse(shortCode), endpoint: url);
    expect(pair.ok, isTrue, reason: 'pair failed: ${pair.error}');
    expect(session.paired.value, isTrue);

    // PTT down → audio:start(delivery:inject) + streamed chunks.
    final bool down = await session.pttDown(
      mode: FlowMode.realtime,
      sourceLang: 'zh',
      delivery: Delivery.inject,
    );
    expect(down, isTrue);

    // Let the WAV stream fully, then PTT up (flush residual + audio:stop).
    await recorder.done;
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await session.pttUp();

    final SttFinal result =
        await terminal.future.timeout(const Duration(seconds: 25));

    // ignore: avoid_print
    print('[integration] terminal stt:final text="${result.text}" '
        'interimsSeen segments joined="${session.segments.joined}"');
    expect(result.text.trim(), isNotEmpty);

    pc.dispose();
    await session.dispose();
  }, timeout: const Timeout(Duration(seconds: 90)));

  test('delivery:none full chain — record-only utterance builds a noted row, '
      'transcribes, and NO history:create is ever forwarded (§4.0 C)', () async {
    final Uint8List pcm = _wavPcm('integration_test/fixtures/zh-6s.wav');
    final (io.Socket pc, String shortCode) = await registerPc(url);

    // Full presentation stack over the real transport, wrapped so every emit is
    // observable at the wire.
    final RecordingTransport transport = RecordingTransport(SocketCore());
    final WavFileRecorder recorder = WavFileRecorder(pcm);
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
    );
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final InMemoryLocalPrefs prefs = InMemoryLocalPrefs(); // noted-sync OFF
    final TimelineSyncGate gate =
        TimelineSyncGate(transport: transport);
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: prefs,
    );

    final PairResult pair =
        await session.pair(PairEntry.parse(shortCode), endpoint: url);
    expect(pair.ok, isTrue, reason: 'pair failed: ${pair.error}');

    // Choose record-only AFTER connecting: the connect edge runs the §4.0 B stickiness
    // reset, so a pre-connect choice would (correctly) be wiped. In the product
    // the user toggles the badge on an already-connected session.
    destination.setRecordOnly();
    final bool down = await controller.pttDown();
    expect(down, isTrue);
    await recorder.done;
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await controller.pttUp();

    // Wait for the terminal final to build the row.
    final DateTime deadline =
        DateTime.now().add(const Duration(seconds: 25));
    while (store.isEmpty && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    await pumpEventQueue();

    // ignore: avoid_print
    print('[integration] delivery:none emitted=${transport.emittedNames} '
        'entries=${store.entries.length} '
        'status=${store.isEmpty ? "-" : store.entries.first.status} '
        'text="${store.isEmpty ? "" : store.entries.first.displayText}"');
    // 1) the utterance built a noted row (record of truth);
    expect(store.isEmpty, isFalse, reason: 'no row built from the utterance');
    expect(store.entries.first.status, EntryStatus.noted);
    expect(store.entries.first.displayText.trim(), isNotEmpty);
    // 2) audio:start carried delivery:'none';
    final EventEnvelope? startEv =
        transport.firstEmitted(FlowMicEvents.audioStart);
    expect(startEv, isNotNull);
    expect((startEv!.data as Map)['delivery'], 'none');
    // 3) the phone NEVER forwarded a history:create — server-side has nothing.
    expect(transport.emittedNames,
        isNot(contains(FlowMicEvents.historyCreate)));

    pc.dispose();
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
  }, timeout: const Timeout(Duration(seconds: 90)));
}
