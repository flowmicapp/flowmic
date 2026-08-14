// 🔴 L8 — the rule itself for "this delivery: is the user waiting for it on
// screen right now" (owner 2026-08-02).
//
// Criterion: docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md.
// Queue-level behaviour (each item judged on its own / terminal convergence)
// lives in outbox_test.dart; this file only asserts the rule, because it is a
// pure function, and once it judges wrong the cost is asymmetric in both
// directions:
//   · live judged as deferred ⇒ the user speaks and nothing lands on screen
//     (the shape of those two days in 0.2.19);
//   · deferred judged as live ⇒ owner quote 「可能引起事故」.

import 'package:flowmic/src/session/outbox_inject_origin.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

final DateTime kSpoke = DateTime.utc(2026, 8, 2, 10, 0, 0);

InjectOrigin at(Duration after, {bool userRequested = false}) =>
    outboxInjectOrigin((
      createdAt: kSpoke,
      attemptAt: kSpoke.add(after),
      userRequested: userRequested,
    ));

void main() {
  group('🔴 live vs deferred', () {
    test('delivered immediately ⇒ live', () {
      expect(at(Duration.zero), InjectOrigin.live);
    });

    test('a brief flap, retry succeeds a few seconds later ⇒ still live', () {
      // The entire reason this window exists: the link will flap. A sentence
      // whose first emit was lost and that landed three seconds later after a
      // queued retry is still the sentence the user is staring at; blocking it
      // would make a good feature look broken on the bad network it was built
      // for.
      expect(at(const Duration(seconds: 3)), InjectOrigin.live);
    });

    test('exactly on the window boundary ⇒ live (closed interval; the boundary belongs to the "inject" side)', () {
      expect(at(kLiveDeliveryWindow), InjectOrigin.live);
    });

    test('one millisecond past the window ⇒ deferred', () {
      expect(
        at(kLiveDeliveryWindow + const Duration(milliseconds: 1)),
        InjectOrigin.deferred,
      );
    });

    test('offline for half an hour, then reconnect-drain ⇒ deferred (the scene owner described)', () {
      expect(at(const Duration(minutes: 30)), InjectOrigin.deferred);
    });

    test('⚠️ the number 60 seconds is a lead assumption, not owner\'s words — only assert it is a positive window', () {
      // Source: the ruling's §主控分析 3 writes explicitly 「N 建议 60s，**owner 没说这个数**」.
      // So this case deliberately does not freeze 60 as an assertion: things
      // that can change should not be frozen by a test, and things owner will
      // change even less so. What to assert is that the constant exists, is
      // positive, and the rule actually uses it.
      expect(kLiveDeliveryWindow, greaterThan(Duration.zero));
      expect(at(kLiveDeliveryWindow * 2), InjectOrigin.deferred);
    });
  });

  group('🔴 user manual action: unconditionally expected, clock does not vote', () {
    test('user tapped resend ⇒ live, even if this sentence was spoken last week', () {
      // owner:「用户自己手动操作点了注入到 PC——也可以注入」。The clock has no vote
      // here, so this returns first rather than being &&-ed with age — an &&
      // would quietly hand the vote back.
      expect(at(const Duration(days: 7), userRequested: true), InjectOrigin.live);
    });

    test('did not tap ⇒ the same sentence is deferred (positive/negative control: proves "tapped" is what is doing the work)', () {
      expect(at(const Duration(days: 7)), InjectOrigin.deferred);
    });
  });

  group('the clock itself walked backwards', () {
    test('negative age ⇒ treat as live, not deferred', () {
      // The device clock was changed between enqueue and drain, or the row
      // carries a future timestamp. Judging deferred would leave a phone with
      // a wrong clock unable to speak at all; judging live at worst misses
      // blocking one item, and the window still covers the other side, so it
      // does not become "always live". Same direction as the PC end when it
      // reads "this field is absent".
      expect(at(const Duration(seconds: -5)), InjectOrigin.live);
    });
  });

  group('wire words', () {
    test('the wire form of both values is the enum name, and matches the protocol zod', () {
      // packages/protocol: `z.enum(['live','deferred'])`. These two strings are
      // the only thing that crosses the boundary; renaming them is changing
      // the protocol.
      expect(InjectOrigin.live.name, 'live');
      expect(InjectOrigin.deferred.name, 'deferred');
    });

    test('the PC\'s "deliberately did not inject" code is a constant, not a scattered literal', () {
      // The queue hangs a terminal state on it; one wrong letter would make an
      // already-delivered delivery retry forever.
      expect(kInjectDeferredNotAutoinjected, 'INJECT_DEFERRED_NOT_AUTOINJECTED');
    });
  });
}
