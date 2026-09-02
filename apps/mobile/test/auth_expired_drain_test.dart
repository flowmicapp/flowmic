// auth:expired coupling-edge test (WP-R3-1 acceptance): a single drain must
// tear down BOTH the PAIRING subsystem (reconnect ladder + stored token +
// transport) AND the live SESSION subsystem (audio capture + PTT FSM). Draining
// only one leaves a zombie (13-LESSONS-LEARNED §3 D4).
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §4.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/signaling/auth_expired_handler.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// P2-7 (2026-09-02 audit) — a storage backend that throws on its FIRST call
/// only (a transient failure, the realistic shape), to prove `_draining`
/// unlatches even when the body does not run to completion — and that a
/// LATER, otherwise-ordinary drain still works once the transient fault is
/// gone.
class _ThrowingTokenStorage extends InMemoryTokenStorage {
  int calls = 0;

  @override
  Future<void> removeByToken(String token) async {
    calls++;
    if (calls == 1) throw StateError('storage exploded (test double)');
    await super.removeByToken(token);
  }
}

void main() {
  test('auth:expired drains PAIRING + SESSION in one step', () async {
    const token = 'tok-abcdefghijklmnopqrstuvwxyz012345';
    final t = FakeSocketTransport();
    final fsm = FlowmicStateMachine();
    final audio = AudioCapture(recorder: FakeAudioRecorder());
    final store = InMemoryTokenStorage();
    await store.addOrUpdatePairing(
      const MobileSession(token: token, endpoint: 'ws://x'),
    );
    final coord = ReconnectCoordinator(
      transport: t,
      bufferedChunksProvider: audio.bufferedChunkPayloads,
      url: 'ws://x',
      token: token,
    )..start();

    var drained = false;
    final handler = AuthExpiredHandler(
      transport: t,
      stateMachine: fsm,
      audio: audio,
      reconnect: coord,
      tokenStorage: store,
      onDrained: () => drained = true,
    );

    // Arrange a live, recording session.
    fsm.onSocketStatus(SocketStatus.connected);
    await audio.start();
    fsm.onPttDown();
    expect(fsm.session, SessionState.recording);
    expect(coord.isRunning, isTrue);
    expect(await store.readToken(), token);

    // auth:expired.
    await handler.drain();

    // SESSION drained.
    expect(fsm.session, SessionState.disconnected);
    expect(audio.currentState, RecorderState.stopped);
    // PAIRING drained.
    expect(coord.isRunning, isFalse);
    expect(await store.readToken(), isNull);
    expect(t.currentStatus, SocketStatus.disconnected);
    expect(drained, isTrue);

    await fsm.dispose();
    await audio.dispose();
  });

  test('re-entrant drain is guarded (a cascade during drain does not double-run)', () async {
    final t = FakeSocketTransport();
    final fsm = FlowmicStateMachine();
    final audio = AudioCapture(recorder: FakeAudioRecorder());
    final store = InMemoryTokenStorage();
    final coord = ReconnectCoordinator(
      transport: t,
      bufferedChunksProvider: audio.bufferedChunkPayloads,
      url: 'ws://x',
    )..start();
    var drains = 0;
    final handler = AuthExpiredHandler(
      transport: t,
      stateMachine: fsm,
      audio: audio,
      reconnect: coord,
      tokenStorage: store,
      onDrained: () => drains++,
    );
    // Two concurrent drains (e.g. the disconnect inside drain re-triggers
    // auth:expired): the second must be a no-op while the first is in flight.
    final f1 = handler.drain();
    final f2 = handler.drain();
    await Future.wait(<Future<void>>[f1, f2]);
    expect(drains, 1);
    await fsm.dispose();
    await audio.dispose();
  });

  test(
      'P2-7: a throw mid-drain still unlatches _draining — a LATER, unrelated '
      'auth:expired must not become a permanent no-op', () async {
    const token = 'tok-abcdefghijklmnopqrstuvwxyz012345';
    final t = FakeSocketTransport();
    final fsm = FlowmicStateMachine();
    final audio = AudioCapture(recorder: FakeAudioRecorder());
    final store = _ThrowingTokenStorage();
    await store.addOrUpdatePairing(
      const MobileSession(token: token, endpoint: 'ws://x'),
    );
    final coord = ReconnectCoordinator(
      transport: t,
      bufferedChunksProvider: audio.bufferedChunkPayloads,
      url: 'ws://x',
      token: token,
    )..start();

    var drains = 0;
    final handler = AuthExpiredHandler(
      transport: t,
      stateMachine: fsm,
      audio: audio,
      reconnect: coord,
      tokenStorage: store,
      onDrained: () => drains++,
    );

    // The first drain throws (the storage backend is wired to explode) —
    // production reaches this via `unawaited(_authHandler.drain())`, so the
    // exception becomes an unhandled async error there; this test catches it
    // directly to observe the one fact that matters afterwards.
    Object? caught;
    try {
      await handler.drain();
    } on Object catch (e) {
      caught = e;
    }
    expect(caught, isA<StateError>());
    expect(drains, 0, reason: 'onDrained never ran — the throw pre-empted it');

    // 🔴 THE ASSERTION THAT MATTERS (P2-7). Before the fix, `_draining` was
    // set back to `false` only on the SUCCESS path (the last line of the old
    // body), so the throw above left it latched `true` forever and this
    // second, otherwise-ordinary drain would silently do nothing — SESSION
    // and PAIRING both stay live for an auth that really did expire.
    fsm.onSocketStatus(SocketStatus.connected);
    await audio.start();
    fsm.onPttDown();
    await handler.drain();
    expect(drains, 1,
        reason: 'a later drain must still run to completion, not be '
            'swallowed by a stuck latch from the earlier throw');
    expect(fsm.session, SessionState.disconnected);
    expect(audio.currentState, RecorderState.stopped);

    await fsm.dispose();
    await audio.dispose();
  });
}
