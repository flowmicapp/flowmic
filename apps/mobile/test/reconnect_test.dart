// Reconnect-coordinator contract test (WP-R3-1 acceptance): the backoff ladder
// 1→2→4→8→16→30 s, the 5 s stability threshold before the counter resets, the
// rejoin-once-per-span guard, ring-buffer replay on the connected edge, and the
// AUTH_TOKEN_INVALID storm stop.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §4.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  test('backoff ladder climbs 1→2→4→8→16→30→30 s', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = false;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => const [],
        url: 'ws://x',
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      expect(coord.attempts, 1); // scheduled immediately

      // Each rung: connect must NOT fire before the delay, and DOES at it, then
      // the failed connect climbs to the next rung.
      void rung(int delayMs, int expectAttemptsAfter, int expectConnectCalls) {
        async.elapse(Duration(milliseconds: delayMs - 1));
        async.elapse(const Duration(milliseconds: 1));
        expect(coord.attempts, expectAttemptsAfter);
        expect(t.connectCalls, expectConnectCalls);
      }

      rung(1000, 2, 1); // rung 1 = 1 s
      rung(2000, 3, 2); // rung 2 = 2 s
      rung(4000, 4, 3); // rung 3 = 4 s
      rung(8000, 5, 4); // rung 4 = 8 s
      rung(16000, 6, 5); // rung 5 = 16 s
      rung(30000, 7, 6); // rung 6 = 30 s (capped, not 32)
      rung(30000, 8, 7); // rung 7 = 30 s (held at cap)
    });
  });

  test('a connect that survives the stability window resets the backoff', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = false;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => const [],
        url: 'ws://x',
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1)); // climb to attempt 2
      async.elapse(const Duration(seconds: 2)); // climb to attempt 3
      expect(coord.attempts, 3);

      // Let the NEXT ladder connect actually land (as the real transport would),
      // so the connected edge leaves no pending reconnect timer behind.
      t.connectSucceeds = true;
      async.elapse(const Duration(seconds: 4)); // rung-3 timer fires → connected
      // The connect then survives 5 s with no drop → counter resets to 0.
      async.elapse(const Duration(seconds: 5));
      expect(coord.attempts, 0);

      // The next drop starts back at the 1 s rung.
      t.connectSucceeds = false;
      t.pushStatus(SocketStatus.disconnected);
      expect(coord.attempts, 1);
    });
  });

  test('a flap inside the stability window keeps climbing (no reset)', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = false;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => const [],
        url: 'ws://x',
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1)); // attempt 2
      t.pushStatus(SocketStatus.connected); // connect...
      async.elapse(const Duration(seconds: 2)); // ...but re-drops before 5 s
      t.pushStatus(SocketStatus.disconnected);
      // The unstable connect never credited a reset, so the counter kept going.
      expect(coord.attempts, greaterThanOrEqualTo(3));
    });
  });

  test('rejoin fires once per span, only after a drop (never on cold connect)', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = true;
      var rejoins = 0;
      ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => const [],
        url: 'ws://x',
        onReconnected: () async => rejoins++,
      ).start();

      // Cold connect (no prior drop) must NOT rejoin.
      t.pushStatus(SocketStatus.connected);
      async.flushMicrotasks();
      expect(rejoins, 0);

      // A drop then a reconnect rising edge → rejoin once.
      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1)); // ladder connect → connected
      async.flushMicrotasks();
      expect(rejoins, 1);
    });
  });

  test('ring buffer is replayed as audio:chunk on the connected edge', () {
    fakeAsync((async) {
      final buffered = <Map<String, Object?>>[
        {'seq': 0, 'ts_ms': 1, 'data_b64': 'AA=='},
        {'seq': 1, 'ts_ms': 2, 'data_b64': 'AQ=='},
      ];
      final t = FakeSocketTransport()..connectSucceeds = true;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => buffered,
        url: 'ws://x',
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1)); // ladder connect → connected
      async.flushMicrotasks();

      expect(coord.replayed.length, 2);
      expect(t.emittedWhere('audio:chunk').length, 2);
    });
  });

  // GA-04M: the replay must land AFTER the rejoin ack. Before this fix the
  // buffer was flushed on the raw connected edge, i.e. onto a socket the server
  // had not yet re-associated with a room — audio.handler dropped every frame.
  test('replay happens AFTER the rejoin ack, never before (GA-04M)', () {
    fakeAsync((async) {
      final buffered = <Map<String, Object?>>[
        {'seq': 0, 'ts_ms': 1, 'data_b64': 'AA=='},
        {'seq': 1, 'ts_ms': 2, 'data_b64': 'AQ=='},
      ];
      final t = FakeSocketTransport()..connectSucceeds = true;
      final order = <String>[];
      final rejoinGate = Completer<void>();
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () {
          order.add('replay');
          return buffered;
        },
        url: 'ws://x',
        onReconnected: () async {
          order.add('rejoin');
          await rejoinGate.future; // the ack is still in flight
        },
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1)); // ladder connect → connected
      async.flushMicrotasks();
      // The ack has not come back yet: nothing may have been replayed.
      expect(order, <String>['rejoin']);
      expect(coord.replayed, isEmpty);
      expect(t.emittedWhere('audio:chunk'), isEmpty);

      rejoinGate.complete(); // ack lands → the socket has a room again
      async.flushMicrotasks();
      expect(order, <String>['rejoin', 'replay']);
      expect(coord.replayed.length, 2);
      expect(t.emittedWhere('audio:chunk').length, 2);
    });
  });

  test('replay never re-sends audio:start (the server session survived)', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = true;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => <Map<String, Object?>>[
          {'seq': 4, 'ts_ms': 9, 'data_b64': 'AA=='},
        ],
        url: 'ws://x',
        onReconnected: () async {},
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();

      expect(coord.replayed.length, 1);
      expect(t.emittedWhere('audio:start'), isEmpty);
      expect(t.emittedNames, <String>['audio:chunk']);
    });
  });

  test('a rejected rejoin replays nothing — the buffer waits for the next span', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = true;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => <Map<String, Object?>>[
          {'seq': 0, 'ts_ms': 1, 'data_b64': 'AA=='},
        ],
        url: 'ws://x',
        onReconnected: () async => throw StateError('rejoin failed'),
      )..start();

      t.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();

      expect(coord.replayed, isEmpty);
      expect(t.emittedWhere('audio:chunk'), isEmpty);
    });
  });

  test('a cold connect (no prior drop) replays nothing', () {
    fakeAsync((async) {
      final t = FakeSocketTransport()..connectSucceeds = true;
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => <Map<String, Object?>>[
          {'seq': 0, 'ts_ms': 1, 'data_b64': 'AA=='},
        ],
        url: 'ws://x',
        onReconnected: () async {},
      )..start();

      t.pushStatus(SocketStatus.connected);
      async.flushMicrotasks();
      expect(coord.replayed, isEmpty);
    });
  });

  test('AUTH_TOKEN_INVALID predicate stops the reconnect storm', () {
    fakeAsync((async) {
      final t = FakeSocketTransport();
      final coord = ReconnectCoordinator(
        transport: t,
        bufferedChunksProvider: () => const [],
        url: 'ws://x',
        shouldReconnect: () => false, // dead token
      )..start();

      t.pushStatus(SocketStatus.error);
      expect(coord.isRunning, isFalse);
      expect(coord.attempts, 0);
      async.elapse(const Duration(seconds: 60));
      expect(t.connectCalls, 0); // never tried
    });
  });
}
