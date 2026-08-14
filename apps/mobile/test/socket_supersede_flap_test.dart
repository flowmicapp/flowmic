// F-5 (2026-08-03 real device) — after reconnect the phone and PC capsules
// flash without rest.
//
// Shape: when `SocketCore.connect()` replaces a **live** adapter it emits
// `disconnected`, and ReconnectCoordinator answers that signal with
// "nobody is pulling the link, I have to dial" ⇒ every dial announces a
// drop, and the announcement arms the next rung of the ladder: 1→2→4→8
// seconds, then the 5-second stability window zeros the count, and it
// starts over, never stopping.
// Real-device forensics: 72 join/leave groups; the PC capsule surfaced /
// retreated once per group.
//
// 🔴 Why this bug survived under 800+ green tests:
// every reconnect test uses `FakeSocketTransport`, and its `connect()`
// pushes `connected` / `error` directly — **it never reproduces real
// SocketCore teardown**. The defect lives in "the layer the test double
// replaced" ⇒ invisible to the whole suite (another instance of the
// 0.2.35 rule in CLAUDE.md). So this file **must** drive a real
// SocketCore and only double at the bottom-most SocketAdapter.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('replacing a live socket is not a drop ⇒ the reconnect ladder must not dial even once', () {
    fakeAsync((FakeAsync async) {
      final List<_FlapAdapter> built = <_FlapAdapter>[];
      final SocketCore core = SocketCore(
        adapterFactory: (String url, Map<String, dynamic> opts) {
          final _FlapAdapter a = _FlapAdapter();
          built.add(a);
          return a;
        },
      );

      unawaited(core.connect(url: 'http://pc.local'));
      async.flushMicrotasks();
      expect(core.currentStatus, SocketStatus.connected);
      expect(built.length, 1);

      final ReconnectCoordinator coord = ReconnectCoordinator(
        transport: core,
        bufferedChunksProvider: () => const <Map<String, Object?>>[],
        url: 'http://pc.local',
      )..start();

      // The user taps 「重新连接」 after the countdown — this is exactly the
      // step `PttSession.resumePairing` takes, and at this moment the
      // socket is still connected (the PC only moved this phone out of
      // the room; it did not close TCP).
      unawaited(core.connect(url: 'http://pc.local'));
      async.flushMicrotasks();

      expect(
        coord.attempts,
        0,
        reason: 'swapping the socket is not a lost link; the ladder must not be armed',
      );

      // 🔴 The criterion is written on "how many times it dialed", not on
      // attempts: an assertion that only checks attempts is green for an
      // implementation that "the count did not rise but it still dialed".
      async.elapse(const Duration(seconds: 60));
      expect(
        built.length,
        2,
        reason: 'in 60 seconds there should be only those two explicit connects; '
            'the ladder must not intervene even once; '
            'before the fix this would climb 1→2→4→8 seconds',
      );
      expect(core.currentStatus, SocketStatus.connected);
    });
  });

  // 🔴 Positive control — without this case, the "zero" above could just
  // mean the probe is blind rather than the implementation being right
  // (CLAUDE.md: a negative assertion must carry its own positive control).
  // Same harness, same coordinator; the only difference is this time the
  // link **really** dropped.
  test('positive control: on a real drop the ladder dials as usual', () {
    fakeAsync((FakeAsync async) {
      final List<_FlapAdapter> built = <_FlapAdapter>[];
      final SocketCore core = SocketCore(
        adapterFactory: (String url, Map<String, dynamic> opts) {
          final _FlapAdapter a = _FlapAdapter();
          built.add(a);
          return a;
        },
      );

      unawaited(core.connect(url: 'http://pc.local'));
      async.flushMicrotasks();
      expect(built.length, 1);

      final ReconnectCoordinator coord = ReconnectCoordinator(
        transport: core,
        bufferedChunksProvider: () => const <Map<String, Object?>>[],
        url: 'http://pc.local',
      )..start();

      // Real drop: the underlying socket reported disconnect itself; nobody
      // is currently dialing.
      built.last.fireDisconnect('transport close');
      async.flushMicrotasks();
      expect(coord.attempts, 1, reason: 'a real drop must arm the first rung');

      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(built.length, 2, reason: 'the 1-second rung must actually dial out');
      expect(core.currentStatus, SocketStatus.connected);
    });
  });

  test('the replaced socket still requires the next connected to rejoin the room', () {
    fakeAsync((FakeAsync async) {
      final List<_FlapAdapter> built = <_FlapAdapter>[];
      final SocketCore core = SocketCore(
        adapterFactory: (String url, Map<String, dynamic> opts) {
          final _FlapAdapter a = _FlapAdapter();
          built.add(a);
          return a;
        },
      );
      unawaited(core.connect(url: 'http://pc.local'));
      async.flushMicrotasks();

      int rejoins = 0;
      ReconnectCoordinator(
        transport: core,
        bufferedChunksProvider: () => const <Map<String, Object?>>[],
        url: 'http://pc.local',
        onReconnected: () async => rejoins++,
      ).start();

      // Swap the socket ⇒ the new socket has no room on the server (the
      // server only rebuilds roomUuid inside the mobile:reconnect handler).
      // Do not dial, but **must** rejoin the room, otherwise this is the
      // F-1 shape of "connected but not in a room".
      unawaited(core.connect(url: 'http://pc.local'));
      async.flushMicrotasks();
      expect(rejoins, 1);
    });
  });
}

/// An adapter that does one thing: `connect()` completes the handshake
/// synchronously. SocketCore registers all callbacks before calling
/// `adapter.connect()`, so a synchronous callback is safe.
class _FlapAdapter implements SocketAdapter {
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
