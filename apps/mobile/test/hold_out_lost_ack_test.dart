// 🔴 fix-013 (2026-08-10) — **one unanswered ack permanently ends the whole recovery loop.**
//
// `hold_out_retry.dart`'s `note()` first `cancel()`s, then returns immediately
// when `retryAfterMs == null`, and that comment wrote the two meanings of null
// as the same thing:
//
//     「没有预算意味着两件事之一：这次拒绝不是 hold-out（比如 `AUTH_TOKEN_INVALID`），
//      或者我们**根本没问到**（超时 / 抛异常）。两种都不该起表：前者拨一辈子也进不去，
//      后者是重连阶梯的活。」
//
// The first sentence is true. The second sentence's **premise is true, conclusion
// is false**: the ladder only dials on a **disconnect edge**, and the definition
// of the hold-out state is "socket is connected, but not in the room" — **nothing
// dropped, the ladder will never fire**. So after this timer is taken down nobody
// asks a second time, the phone stays outside, every frame is bounced with
// `INJECT_NOT_IN_ROOM`, and the banner is still promising "will auto-deliver after
// the connection recovers". Reachability is in `mobile_reconnect_flow.dart`: the
// ack-timeout path is exactly
// `onRejected(surfaceTransientFailure, false, null, null)` — no code, no budget,
// link still alive.
//
// ── 🔴 Why this file must start by reading the sibling file's header ──────────
// `hold_out_recheck_wire_test.dart` records the 0.2.51 same-shape accident: a
// **reverse control** used "`PAIR_RELEASED` must not dial even once" to nail a
// defect into the spec, for the same reason ("that path belongs to the reconnect
// ladder"). **A reverse control that picks the wrong direction is worse than no
// reverse control.** So the negative assertions in this file only assert one
// thing: **the server really answered, and the answer was "no budget"** — that
// "must not dial" is a product judgment (dialing forever still cannot get in),
// not a secondhand claim about someone else's code. And "we never got an answer"
// is no longer treated as the same thing.
//
// ── What each test independently prevents (drop any one and this defect can
//    come back unchanged) ────────────────────────────────────────────────────
// ① Real wiring + real clock: timer is armed → recheck ack is lost → **the
//    phone asks again by itself and gets in**. Strip the fix ⇒ the third frame
//    does not exist. This case is also the **positive control** for every "zero"
//    in this file: it proves this probe (frame count) actually moves.
// ② Server answered, gave no budget ⇒ do not dial even once. Each of two codes
//    is run once: `AUTH_TOKEN_INVALID` (not a hold-out) and **`PAIR_RELEASED`
//    with a code but no budget** (old relay). The latter is the key: it proves
//    the fork criterion is "**whether anyone answered**", not "whether we
//    recognize the code".
// ③ The bound itself: under `fakeAsync`, feed "asked, nobody answered"
//    consecutively, prove it **stops**, and that it stops at
//    `lostAckWaits.length`; then prove **one answered ask zeroes the streak** —
//    the bound governs "consecutive unanswered counts", not the lifetime of
//    this loop.
//
// ── Reverse control measured red (2026-08-10, this machine dev-pc-a) ────────
// After swapping `_noteHoldOut` in `ptt_reconnect_ack.dart` back to the
// pre-fix line (delete the `code == null` branch, leave only
// `_holdOut.note(...)`) and running this file, ① **went red on the spot**:
//
//     00:12 +0 -1: ① … [E]
//       Expected: true
//         Actual: <false>
//       一次丢失的 ack 就把恢复回路终结了 —— 用户只能退回实例清单再连一次
//       test\hold_out_lost_ack_test.dart 170:5   main.<fn>
//
// Restored, this file 5/5 green again, `REVERSE-CONTROL` leftover string
// greps to 0 under lib/.
//
// 🔴 On that run ②③③b **were all green**, and that itself must be recorded:
// `HoldOutRetry.noteLostAck` was still there, just nobody called it —
// **capability defined, nobody invokes it** (anti-façade ①, this repo's #1
// historical bug class). So only the real-wired ① can catch it, and the three
// "unit" tests together with the two negative assertions have zero proving
// power for "whether this fix is actually wired".
//
// SPEC-REF:
//   lib/src/session/hold_out_retry.dart (`noteLostAck` / `lostAckWaits`)
//   lib/src/ptt/ptt_reconnect_ack.dart (`_noteHoldOut` — the fork for the two nulls)
//   lib/src/signaling/mobile_reconnect_flow.dart (`onRejected(..., null, null)`)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/hold_out_retry.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// A [FakeSocketTransport] that can lose exactly one ack, the way the real
/// transport loses one: `SocketCore.emitWithAck` completes with a
/// `TimeoutException` when its own timer wins (socket_core.dart), and
/// `runMobileReconnect` catches that into `ok = false` with `ack` left null.
///
/// ⚠️ It throws IMMEDIATELY instead of sleeping out the 5 s ack timeout. What is
/// under test is what the phone does AFTER an ask goes unanswered; the 5 s
/// belongs to the real transport's timer and burning it here would make this
/// file slower without making it truer.
///
/// 🔴 It still RECORDS the frame. That is the whole difference between a lost
/// ack and a failed emit: the question left the device, and the tests count
/// questions.
class _LosesAnAck extends FakeSocketTransport {
  /// Queue this in [FakeSocketTransport.ackQueue] where an answer would go.
  static const Object lostAck = Object();

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) async {
    if (ackQueue.isNotEmpty && identical(ackQueue.first, lostAck)) {
      ackQueue.removeAt(0);
      emitted.add(EventEnvelope(event, payload));
      throw TimeoutException('ack timeout for $event');
    }
    return super.emitWithAck<R>(event, payload, timeout: timeout);
  }
}

int _reconnectFrames(FakeSocketTransport t) =>
    t.emitted.where((EventEnvelope e) => e.name == 'mobile:reconnect').length;

PttSession _session(FakeSocketTransport transport) {
  transport.connectSucceeds = true;
  final PttSession s = newTestSession(transport: transport);
  // Endpoint probe must not hit a real network: these cases test "will it ask
  // again after getting no answer", not address selection.
  s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  return s;
}

Future<bool> _resume(PttSession s) => s.resumePairing(
      const MobileSession(
        token: 'tok-fix013-0000000000000000000',
        endpoint: 'http://192.0.2.5:55889',
      ),
    );

/// Poll until [seen], or give up at [limit]; returns the outcome so the caller
/// asserts it (a bare `return` would read green). Same helper, and the same
/// reason, as failed_connect_stops_dialing_test.dart: a POSITIVE assertion on a
/// real clock should not be a fixed sleep sized to the slowest machine.
Future<bool> _waitFor(
  bool Function() seen, {
  Duration limit = const Duration(seconds: 10),
}) async {
  final DateTime deadline = DateTime.now().add(limit);
  while (DateTime.now().isBefore(deadline)) {
    if (seen()) return true;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  return seen();
}

/// Past the FIRST rung of the lost-ack ladder (`lostAckWaits.first` = 2 s), with
/// room to spare.
///
/// ⚠️ It has to be past that rung or every "zero" below proves nothing — it would
/// only say the timer had not fired yet. Deliberately generous rather than
/// "2 s + ε" because a negative assertion on a real clock fails SILENTLY
/// UPWARD; the positive control that these counters can move at all is test ①.
final Duration _pastFirstLostAckRung =
    HoldOutRetry.lostAckWaits.first + const Duration(milliseconds: 900);

void main() {
  test('① after one unanswered recheck, the phone asks again by itself and gets in — no human intervention',
      () async {
    final _LosesAnAck transport = _LosesAnAck();
    final PttSession session = _session(transport);
    addTearDown(session.dispose);

    transport.ackQueue.addAll(<Object?>[
      // ① Blocked at the door, server gave a budget ⇒ timer armed (1ms is clamped to 1s by `minWait`).
      <String, Object?>{
        'error': 'PC_BUSY',
        'retryable': true,
        'retry_after_ms': 1,
      },
      // ② T+1s recheck: **no answer** (timeout / throw). This frame is the defect on site.
      _LosesAnAck.lostAck,
      // ③ Bounded re-ask (T+1s+2s): the occupying device left, this time it can get in.
      <String, Object?>{
        'ok': true,
        'pc_id': 'pc-1',
        'pc_name': 'dev-pc-a',
      },
    ]);

    expect(await _resume(session), isFalse, reason: 'the first one must be refused — otherwise this is not testing being blocked at the door');
    expect(session.holdOutArmed, isTrue, reason: 'timer not armed ⇒ nothing after this will happen');
    expect(_reconnectFrames(transport), 1, reason: 'must not redial immediately');

    // First wait for that "destined to get no answer" recheck to actually leave.
    // Without this step, the assertions below may be talking about "the 49-2
    // timer is broken", not "can it still recover after getting no answer".
    expect(await _waitFor(() => _reconnectFrames(transport) >= 2), isTrue,
        reason: 'the ordinary 49-2 recheck never even left — this case is no longer testing this card');

    // 0.2.52 split "draw the banner or not" from "when to ask again"; this card
    // **must not merge them back**: when we got no answer the banner must fall
    // (we can no longer see the fact "another phone is connected"), recovery
    // rides the timer. Nailed here because "casually keep the banner too" looks
    // like an improvement, and that is exactly the 49-3 shape.
    expect(session.pcBusyListenable.value, isFalse,
        reason: 'the banner criterion is only PC_BUSY; when nobody answered, must not reuse the previous answer');

    // 🔴 The actual point: **no user action at all**, the third frame left by itself.
    expect(await _waitFor(() => _reconnectFrames(transport) >= 3), isTrue,
        reason: 'one lost ack ended the recovery loop — the user can only go back to the instance list and connect again');
    expect(await _waitFor(() =>
            session.connectedDeviceName.value == 'dev-pc-a'),
        isTrue,
        reason: 'asked again but never entered the room ⇒ we are only manufacturing traffic');

    // The other half of the bound: **one** re-ask is enough; must not walk the whole four-rung ladder.
    expect(_reconnectFrames(transport), 3, reason: 'extra frames are traffic we manufactured ourselves');
    expect(await _waitFor(() => !session.holdOutArmed), isTrue,
        reason: 'got in and still holding the timer ⇒ wasted frames');
  });

  // Server **answered**, just gave no budget ⇒ must not dial even once. This
  // half has been unchanged since 49-2.
  //
  // Each of two codes is run once, because they walk in on different paths, and
  // the fork criterion must be the same "whether anyone answered":
  //   · `AUTH_TOKEN_INVALID` — not a hold-out at all; the only useful action is
  //     to send the person to re-pair;
  //   · `PAIR_RELEASED` without `retry_after_ms` — a **recognized hold-out
  //     code**, which is how the old relay answers (connections_controller_test.dart
  //     has a same-shape case). It proves we do not fork on "whether we
  //     recognize the code": we recognize it, and still do not dial, because
  //     the server did not say when.
  for (final Map<String, Object?> ack in <Map<String, Object?>>[
    <String, Object?>{'error': 'AUTH_TOKEN_INVALID'},
    <String, Object?>{'error': 'PAIR_RELEASED', 'retryable': true},
  ]) {
    test('② server answered, gave no budget (${ack['error']}) ⇒ do not dial even once', () async {
      final _LosesAnAck transport = _LosesAnAck();
      final PttSession session = _session(transport);
      addTearDown(session.dispose);
      transport.defaultAck = ack;

      expect(await _resume(session), isFalse);
      expect(session.holdOutArmed, isFalse,
          reason: 'armed the timer ⇒ we are asking an already-answered question on a rhythm we invented');

      await Future<void>.delayed(_pastFirstLostAckRung);

      expect(_reconnectFrames(transport), 1,
          reason: 'the "never got an answer" path took "answered, no budget" with it — dialing forever still cannot get in, '
              'and this zero is live: the same counter walked from 1 to 3 in ①');
    });
  }

  test('③ the bound is real: consecutive unanswered asks stop, and they stop at lostAckWaits.length', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      addTearDown(t.cancel);
      int asked = 0;
      // Production loop shape: timer fires → `_recheckHoldOut` emits a frame → nobody answers again → walk back in.
      void loseAnother() => t.noteLostAck(retry: () async {
            asked++;
            loseAnother();
          });

      loseAnother();
      async.elapse(HoldOutRetry.lostAckWaits.first - const Duration(milliseconds: 1));
      expect(asked, 0, reason: 'dialed before the first rung ⇒ this rhythm is fake');
      async.elapse(const Duration(milliseconds: 2));
      expect(asked, 1, reason: 'first rung arrived and it did not dial ⇒ the defect is still there unchanged');

      async.elapse(const Duration(minutes: 30));
      expect(asked, HoldOutRetry.lostAckWaits.length,
          reason: 'without a bound, an unattended phone would ask forever — traffic we manufactured ourselves');
      expect(t.armed, isFalse, reason: 'bound exhausted and the timer is still held');
    });
  });

  test('③b one answered ask zeroes the streak — the bound governs "how many consecutive unanswered", not the lifetime of this loop',
      () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      addTearDown(t.cancel);
      int asked = 0;
      void loseAnother() => t.noteLostAck(retry: () async {
            asked++;
            loseAnother();
          });

      loseAnother();
      async.elapse(const Duration(minutes: 30));
      expect(asked, HoldOutRetry.lostAckWaits.length);

      // The server spoke again (this is exactly what the recovery loop looks like when it works): this ask was answered, the streak ends.
      t.note(retryAfterMs: 8000, retry: () async => asked++);
      async.elapse(const Duration(seconds: 9));
      expect(asked, HoldOutRetry.lostAckWaits.length + 1);

      // So the next "never got an answer" is the **first of a new round**, not the tail of the previous one.
      loseAnother();
      async.elapse(const Duration(minutes: 30));
      expect(asked, HoldOutRetry.lostAckWaits.length * 2 + 1,
          reason: 'streak not zeroed ⇒ a phone that ran all day, after the first four unanswered, '
              'would never recover by itself again, even though every ask after that was answered normally by the server');
    });
  });
}
