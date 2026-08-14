// N1-B2 — THE PRODUCTION WIRING OF THE N1-B3 RETAINED-AUDIO LAYER.
//
// N1-B3 (720d278) shipped the layer complete and tested, but DORMANT: its two
// inputs — 「the uplink is down」 and 「which segment_idx are we on」 — had no
// production caller, and `uplinkUp` defaults to true, so an unwired build wrote
// nothing. These tests pin the callers.
//
// 🔴 WHY THE SIGNAL IS TAKEN OFF THE TRANSPORT STATUS AND NOT OFF
// `_emitChunk`'s CATCH BLOCK, which is where N1-B3's own header pointed:
// `AudioEmitter.emitChunk` documents 「Throws if the transport is closed」, but
// the only throw underneath it is `SocketCore.emit`'s
// `StateError('SocketCore.emit(...) before connect()')`, guarded by
// `_adapter == null`. A network outage does not null the adapter — the socket
// object survives and `emit` returns normally with the frame going nowhere. So
// that catch arm fires for 「never connected / torn down」 and is SILENT for
// precisely the outage this layer exists to survive. `_emitChunkDoesNotThrow`
// the test below MEASURES that against a REAL `SocketCore` rather than
// asserting it from the doc comment.
//
// SPEC-REF: docs/strategy/2026-08-08-design-n1-long-recording.md §2.2 / J3;
//           docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;
  late FakeSocketTransport transport;
  late FakeAudioRecorder recorder;
  late AudioCapture capture;
  late PttSession session;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-retain-wire-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
    transport = FakeSocketTransport()..connectSucceeds = true;
    recorder = FakeAudioRecorder();
    capture = AudioCapture(recorder: recorder, spill: spill);
    session = newTestSession(transport: transport, audio: capture);
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
  });

  tearDown(() async {
    await session.dispose();
    await transport.close();
    await store.dispose();
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  group('the uplink signal has a production caller', () {
    test('a non-connected transport status puts the spill into retain mode',
        () {
      expect(spill.uplinkUp, isTrue, reason: 'the documented default');

      transport.pushStatus(SocketStatus.connected);
      expect(spill.uplinkUp, isTrue);

      transport.pushStatus(SocketStatus.disconnected);
      expect(spill.uplinkUp, isFalse,
          reason: 'ring evictions must now be retained instead of discarded');
    });

    test('reconnecting turns retention back off', () {
      transport.pushStatus(SocketStatus.disconnected);
      expect(spill.uplinkUp, isFalse);
      transport.pushStatus(SocketStatus.connected);
      expect(spill.uplinkUp, isTrue);
    });

    test('🔴 the measurement behind the wiring choice: on a REAL SocketCore, '
        'emitting after the link drops does NOT throw — so the catch block in '
        '_emitChunk cannot be the outage signal', () async {
      // 🔴 THIS RUNS AGAINST THE REAL `SocketCore`, faking only the lowest layer
      // (`SocketAdapter`), because the claim under test is about SocketCore's
      // own `emit`. Written against `FakeSocketTransport` first, this test
      // FAILED — that fake throws when it is not connected, which is the
      // opposite of production. A signal wired on the strength of that green
      // would have been dead in exactly the outage it was built for, and no
      // amount of suite-green would have said so. (repo law: when a bug lives in
      // the layer the test double replaced, it is invisible to the entire suite.)
      final _StubAdapter adapter = _StubAdapter();
      final SocketCore core = SocketCore(
        adapterFactory: (String url, Map<String, dynamic> opts) => adapter,
      );
      await core.connect(url: 'ws://127.0.0.1:41879');
      expect(core.currentStatus, SocketStatus.connected);

      // The network goes away. socket.io keeps the object; only the link died.
      adapter.fireDisconnect('transport close');
      expect(core.currentStatus, isNot(SocketStatus.connected),
          reason: 'positive control: the drop really was observed');

      expect(
        () => core.emit(FlowMicEvents.audioChunk, <String, Object?>{
          'seq': 1,
          'ts_ms': 0,
          'data_b64': '',
        }),
        returnsNormally,
        reason: '`_adapter` is still non-null, so the StateError guard — the '
            'ONLY throw in SocketCore.emit — does not fire',
      );
      await core.disconnect();
    });
  });

  group('the segment key has a production caller', () {
    test('an inbound stt:interim advances the retained-audio segment key', () {
      expect(spill.currentSegmentIdx, 0);
      transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': '第二段的开头',
        'confidence': 0.8,
        'language': 'zh',
        'segment_idx': 2,
      });
      expect(spill.currentSegmentIdx, 2,
          reason: 'unwired, every outage in every utterance appends into '
              'segment 0');
    });

    test('an inbound stt:final advances it too, and the key never walks back',
        () {
      transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '第三段',
        'confidence': 0.9,
        'language': 'zh',
        'segment_idx': 3,
        'is_segment': true,
        'duration_ms': 1000,
      });
      expect(spill.currentSegmentIdx, 3);

      // A replayed older frame must not re-key live audio onto a closed
      // segment. (This one is also dropped by the N1-B2 settlement claim; the
      // assertion is about the KEY, which `noteSegmentObserved` guards
      // independently.)
      transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': '迟到的第一段',
        'confidence': 0.8,
        'language': 'zh',
        'segment_idx': 1,
      });
      expect(spill.currentSegmentIdx, 3);
    });
  });

  test('🔴 END TO END: audio evicted from the ring during an outage is on disk, '
      'keyed by the segment the server last delimited', () async {
    // The server got as far as segment 2, then the link died.
    transport.pushStatus(SocketStatus.connected);
    transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': '说到第二段',
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': 2,
    });
    transport.pushStatus(SocketStatus.disconnected);

    // A chunk ages out of the 30 s ring while the link is down.
    spill.onEvicted(BufferedChunk(seq: 1, tsMs: 0, payload: pcm()));
    await spill.flush();

    expect(await spill.pendingSegments(), <int>[2]);
    final Uint8List? bytes = await spill.readSegment(2);
    expect(bytes, isNotNull);
    expect(bytes!.length, pcm().length);
  });
}

Uint8List pcm() => makePcm(6400, amplitude: 1200);

/// Lowest-layer double: everything above it in this test is production code.
class _StubAdapter implements SocketAdapter {
  void Function()? _onConnect;
  void Function(dynamic)? _onDisconnect;

  void fireDisconnect(Object? reason) => _onDisconnect?.call(reason);

  @override
  void connect() => _onConnect?.call();
  @override
  void disconnect() {}
  @override
  void dispose() {}
  @override
  void emit(String event, Object? data) {}
  @override
  void emitWithAck(String e, Object? d, void Function(dynamic) ack) {}
  @override
  void onAny(void Function(String, List<dynamic>) cb) {}
  @override
  void onConnect(void Function() cb) => _onConnect = cb;
  @override
  void onConnectError(void Function(dynamic) cb) {}
  @override
  void onDisconnect(void Function(dynamic) cb) => _onDisconnect = cb;
  @override
  void onReconnect(void Function(int) cb) {}
  @override
  void onReconnectAttempt(void Function(int) cb) {}
}
