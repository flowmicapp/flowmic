// Lane BO — THE RECONNECT LADDER KILLED ITSELF AFTER ABOUT 25 MINUTES OFFLINE.
//
// Real-device durability round five, evidence
// `.local/session-2026-09-07-durability-drill-r5/`. The device diag, verbatim:
//
//   att=54 delay=30000
//   att=55 delay=-8070450532247928
//   att=56 delay=2305843009213693
//   (no attempt 57, while a long recording was still running)
//
// `_backoffFor` computed `initialBackoff.inMilliseconds * (1 << (attempt - 1))`
// and capped the PRODUCT with `>`. At attempt 55 the shift overflowed int64 into
// a negative number, and `negative > 30000` is false — so the cap that exists to
// make the ladder patient handed the negative delay straight to `Timer`, which
// fired it at once. The next rung wrapped to ~73,000 years and the ladder was
// over. Nothing logged an error; the phone simply stopped trying.
//
// 🔴 WHAT THIS FILE MEASURES, and why it is not the ladder test next door.
// `reconnect_test.dart` walks the first seven rungs, which is where the ladder
// is interesting to a person. This one walks EIGHTY, which is where it is
// interesting to an int64 — the defect lived past rung 54 and every existing
// test stopped at 7. A ladder that is correct for as long as anyone watches is
// the shape this repo keeps paying for.
//
// ⚠️ THE DELAYS ARE READ OFF THE PRODUCTION SCHEDULE LINE, not recomputed here.
// `_scheduleReconnect` already prints `attempt=N delay=Mms` through
// `debugPrint`, so overriding that sink measures what the timer was actually
// armed with. Recomputing the expected series in the test and comparing it to
// itself would pass against the broken implementation too.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/signaling/network_watch.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// A [NetworkWatch] a test drives by hand.
class FakeNetworkWatch implements NetworkWatch {
  final StreamController<void> _ctl = StreamController<void>.broadcast();

  void fire() => _ctl.add(null);

  @override
  Stream<void> get returned => _ctl.stream;

  @override
  Future<void> dispose() async => _ctl.close();
}

final RegExp _scheduleLine = RegExp(
  r'\[flowmic\.reconnect\] schedule attempt=(\d+) delay=(-?\d+)ms',
);

/// Runs [body] with `debugPrint` captured, returning `attempt -> delay ms` in
/// schedule order.
List<({int attempt, int delayMs})> _capture(
  void Function(List<({int attempt, int delayMs})> rungs) body,
) {
  final List<({int attempt, int delayMs})> rungs =
      <({int attempt, int delayMs})>[];
  final DebugPrintCallback previous = debugPrint;
  debugPrint = (String? message, {int? wrapWidth}) {
    final RegExpMatch? m = message == null
        ? null
        : _scheduleLine.firstMatch(message);
    if (m != null) {
      rungs.add((
        attempt: int.parse(m.group(1)!),
        delayMs: int.parse(m.group(2)!),
      ));
    }
  };
  try {
    body(rungs);
  } finally {
    debugPrint = previous;
  }
  return rungs;
}

void main() {
  const int initialMs = 1000;
  const int maxMs = 30000;

  test('80 rungs stay inside [initial, max]: none negative, none wrapped', () {
    final List<({int attempt, int delayMs})> rungs = _capture((
      List<({int attempt, int delayMs})> rungs,
    ) {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()
          ..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        )..start();

        t.pushStatus(SocketStatus.disconnected);
        // Elapse exactly the delay this rung was armed with — and never more
        // than [maxMs], because 「等得比上限还久」 is the very thing under test:
        // a wrapped rung must show up as SILENCE (no attempt 57, as on the
        // device), not as a rung this driver generously waited 73,000 years for.
        // A negative delay elapses as zero, which is what the device saw it do.
        // 🔴 The loop is COUNTED, not open-ended: a ladder that has stopped
        // must fail an assertion, never hang the suite.
        for (int i = 0; i < 79 && coord.attempts < 80; i++) {
          final int delay = rungs.last.delayMs;
          async.elapse(Duration(milliseconds: delay.clamp(0, maxMs)));
        }
      });
    });

    // 🔴 THE TWO THE DEVICE FAILED, asserted before the aggregates so that a
    // regression is named rather than merely counted.
    expect(
      rungs
          .firstWhere(
            (r) => r.attempt == 55,
            orElse: () => (attempt: 55, delayMs: -1),
          )
          .delayMs,
      maxMs,
      reason: 'attempt 55 was -8070450532247928 ms on the device',
    );
    expect(
      rungs
          .firstWhere(
            (r) => r.attempt == 56,
            orElse: () => (attempt: 56, delayMs: -1),
          )
          .delayMs,
      maxMs,
      reason: 'attempt 56 was 2305843009213693 ms on the device',
    );
    expect(
      rungs.length,
      80,
      reason: 'attempt 80 must still be a scheduled rung, not silence',
    );
    for (final ({int attempt, int delayMs}) r in rungs) {
      expect(
        r.delayMs,
        greaterThan(0),
        reason: 'rung ${r.attempt} is not a wait',
      );
      expect(
        r.delayMs,
        greaterThanOrEqualTo(initialMs),
        reason: 'rung ${r.attempt} waits less than the first rung',
      );
      expect(
        r.delayMs,
        lessThanOrEqualTo(maxMs),
        reason: 'rung ${r.attempt} waits longer than maxBackoff',
      );
    }

    // Monotone non-decreasing, then flat at the cap forever.
    for (int i = 1; i < rungs.length; i++) {
      expect(
        rungs[i].delayMs,
        greaterThanOrEqualTo(rungs[i - 1].delayMs),
        reason: 'rung ${rungs[i].attempt} went backwards',
      );
    }
    expect(rungs.take(6).map((r) => r.delayMs).toList(), <int>[
      1000,
      2000,
      4000,
      8000,
      16000,
      30000,
    ]);
    expect(rungs.skip(6).every((r) => r.delayMs == maxMs), isTrue);

    expect(rungs.last.attempt, 80);
  });

  test('a non-positive initialBackoff waits the cap and says so once', () {
    final List<({int attempt, int delayMs})> rungs = _capture((
      List<({int attempt, int delayMs})> rungs,
    ) {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()
          ..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
          initialBackoff: Duration.zero,
        )..start();

        t.pushStatus(SocketStatus.disconnected);
        expect(coord.attempts, 1);
        // 🔴 NOT ONE MILLISECOND IS ELAPSED HERE, and that is the test design.
        // Without the guard the first rung is armed for 0 ms and re-arms for
        // 0 ms on failure, so ANY elapse — including `Duration.zero` — is an
        // unbounded dial storm inside fake_async that hangs the suite instead
        // of failing it. The rung's armed delay is read off the schedule line
        // before any timer runs.
      });
    });

    expect(
      rungs.single.delayMs,
      maxMs,
      reason: 'a non-positive rung must become the cap, never 0 ms',
    );
  });

  test('after 80 rungs the network-returned kick still dials at once', () {
    final List<({int attempt, int delayMs})> rungs = _capture((
      List<({int attempt, int delayMs})> rungs,
    ) {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()
          ..connectSucceeds = false;
        final FakeNetworkWatch watch = FakeNetworkWatch();
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        );
        coord.attachNetworkWatch(watch);
        coord.start();

        t.pushStatus(SocketStatus.disconnected);
        // ~40 minutes offline, well past the rung where the ladder used to die.
        for (int i = 0; i < 200 && coord.attempts < 80; i++) {
          async.elapse(const Duration(seconds: 30));
        }
        expect(
          coord.attempts,
          80,
          reason: 'the ladder must still be climbing after 40 min offline',
        );
        final int before = t.connectCalls;

        watch.fire();
        async.flushMicrotasks();
        async.elapse(Duration.zero);

        expect(
          t.connectCalls,
          before + 1,
          reason:
              'the kick is gated on transport status, never on the rung '
              'count — a long outage must not disarm it',
        );
      });
    });

    // The kick dials AT ONCE and re-enters the ladder at rung 1: the pending
    // delay was computed for a world that no longer exists, and a failed kick
    // must not storm.
    expect(rungs[80].attempt, 1);
    expect(rungs[80].delayMs, 0);
    expect(rungs[81].delayMs, 1000 * 2, reason: 'the ladder resumes at rung 2');
  });
}
