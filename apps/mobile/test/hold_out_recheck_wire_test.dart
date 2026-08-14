// 🔴 49-2 / 49-3 **wiring proof** (owner + machine 2026-08-03 real-device).
//
// `hold_out_retry_test.dart` proves the timer itself is right; this file proves
// **production really wired it up**. Both are required, reason is CLAUDE.md
// anti-façade ①: a capability defined with nobody calling it is this project's
// #1 historical bug class — and 49-2's root cause was exactly that shape (the
// server sent `retry_after_ms`, the phone stored it only to display it, **nothing
// consumed it**). If you only test the timer, delete the
// `retry: _recheckHoldOut` line and the other file's five cases all stay green.
//
// This file walks the real chain, real clock: `resumePairing` → `mobile:reconnect`
// → the server answers `PC_BUSY` / `PAIR_RELEASED` + `retry_after_ms` → at the
// deadline the phone **itself** sends `mobile:reconnect` again → this time it
// gets in. The real clock is deliberate: the budget is clamped to the 1-second
// floor, the test waits a little over 1 second. Using `fakeAsync` would mean
// taming every http probe, timeout, and microtask inside `resumePairing`, which
// would swap the criterion "is it wired" for "did I set the fake clock right".
//
// ── 🔴 This file's predecessor reversed the second assertion (2026-08-03, the same day) ─
// It was originally named `pc_busy_recheck_wire_test.dart`, and the second case
// was "reverse control: a refusal that is not occupancy must not arm this
// timer", using `PAIR_RELEASED` to assert `_reconnectFrames == 1`, with the
// reason written in the comment:
//
//     「`PAIR_RELEASED`（PC 上刚点了断开）也带预算，但它归重连阶梯管：那条路
//      socket 会真的断，阶梯自己会回来。这只表要是也插一脚，同一件事就有两个东西
//      在拨号。」
//
// **The first half is true, the conclusion is false.** The socket does drop, the
// ladder does come back — then it knocks with the token, hits the server's 60 s
// release-suppression window, and is blocked by `PAIR_RELEASED`. **At that
// moment the socket is connected, the ladder's work is already done, it will
// not dial a second time.** So the phone stops at "socket connected, but not in
// the room", until the user backs out to the instance list. Machine-measured
// (.local forensic):
//
//     04:51:26 socket.drop io_reason=io server disconnect   ← PC 上点了「断开」
//     04:51:27 socket connected                             ← 阶梯回来了
//     04:51:27 mobile:reconnect → PAIR_RELEASED retry_after_ms=59xxx
//     …六分钟…（一帧都没有）
//     04:57:23 emit.inject → INJECT_NOT_IN_ROOM → outbox.settled requeued
//
// ⇒ anti-façade ④ **inside a test**: an assertion that looked reasonable when
// written, whose truth depends on someone else's behavior, and that nailed
// itself as "correct behavior". CLAUDE.md's law says "a comment that asserts
// someone else's behavior must either give a greppable anchor or be pinned by a
// test" — **this time that comment WAS the test**, so it locked a defect into
// the spec. The lesson is written here rather than deleted: **a reverse control
// that picks the wrong direction is worse than no reverse control, because it
// will go red the day the fix arrives and make people think the fix is wrong.**

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

int _reconnectFrames(FakeSocketTransport t) =>
    t.emitted.where((EventEnvelope e) => e.name == 'mobile:reconnect').length;

PttSession _session(FakeSocketTransport transport) {
  transport.connectSucceeds = true;
  final PttSession s = newTestSession(transport: transport);
  // Endpoint probe must not hit a real network: these cases measure "after
  // being refused, will it ask again by itself", not address selection.
  s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  return s;
}

Future<bool> _resume(PttSession s) => s.resumePairing(
      MobileSession(token: 't' * 32, endpoint: 'http://192.0.2.5:55889'),
    );

void main() {
  test('49-2 after occupancy refusal, the phone itself resends mobile:reconnect at the deadline — the user need not back out to the instance list',
      () async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = _session(transport);
    addTearDown(session.dispose);

    // ① First time: another phone is occupying, the server names the refusal
    // and gives a budget.
    // ② Second time: that phone left, we can get in.
    transport.ackQueue.addAll(<Object?>[
      <String, Object?>{'error': 'PC_BUSY', 'retryable': true, 'retry_after_ms': 1},
      <String, Object?>{'ok': true, 'pc_id': 'pc-1', 'pc_name': 'dev-pc-a'},
    ]);

    expect(await _resume(session), isFalse, reason: 'the first time must be refused — otherwise this is not measuring occupancy');
    expect(session.pcBusyListenable.value, isTrue, reason: 'the banner did not rise');
    expect(_reconnectFrames(transport), 1, reason: 'must not redial immediately');
    expect(session.holdOutArmed, isTrue, reason: 'timer not armed ⇒ the next frame can only come from a human');

    // The 1ms budget is clamped to 1s (without the clamp it is a busy-wait; see
    // `minWait` in hold_out_retry.dart).
    await Future<void>.delayed(const Duration(milliseconds: 1400));

    // 🔴 The actual question: **no user action at all**, the second frame went
    // out by itself.
    expect(_reconnectFrames(transport), 2,
        reason: 'recheck is not wired — owner still has to leave to the instance list and connect again');
    expect(session.pcBusyListenable.value, isFalse, reason: 'got in, the banner must fall');
    expect(session.connectedDeviceName.value, 'dev-pc-a');
    expect(session.holdOutArmed, isFalse, reason: 'got in and the timer is still there ⇒ wasted frames');
  });

  test('49-3 after 「断开」 was pressed on the PC ⇒ after the suppression window the phone itself joins the room again, must not stay outside the door', () async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = _session(transport);
    addTearDown(session.dispose);

    // The server's answer inside the release-suppression window
    // (mobile.handler.ts:221-233). The real budget is the remainder of
    // `RELEASE_SUPPRESS_MS` (max 60s); here we give 1ms so the floor clamps
    // it to 1s.
    transport.ackQueue.addAll(<Object?>[
      <String, Object?>{'error': 'PAIR_RELEASED', 'retryable': true, 'retry_after_ms': 1},
      <String, Object?>{'ok': true, 'pc_id': 'pc-1', 'pc_name': 'dev-pc-a'},
    ]);

    expect(await _resume(session), isFalse);
    // 🔴 This code **does not paint the occupancy banner**: there is no second
    // phone, saying "another phone is connected" would be a lie.
    expect(session.pcBusyListenable.value, isFalse,
        reason: 'the banner\'s only criterion is PC_BUSY — painting it here is one value answering two questions');
    expect(session.holdOutArmed, isTrue,
        reason: '🔴 49-3\'s root: the branch that does not paint the banner also withdrew the timer');

    await Future<void>.delayed(const Duration(milliseconds: 1400));

    expect(_reconnectFrames(transport), 2,
        reason: 'the window passed and nobody asked again ⇒ socket connected, yet never in the room');
    expect(session.connectedDeviceName.value, 'dev-pc-a');
  });

  test('reverse control: if the server gave no budget, must not dial even once more', () async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = _session(transport);
    addTearDown(session.dispose);

    // `AUTH_TOKEN_INVALID`＝pairing was revoked on the PC: dialing forever still
    // cannot get in, the only useful action is to have the person re-pair. The
    // server therefore **gives no budget**, and this timer's criterion is
    // exactly "was a budget given".
    transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});

    await _resume(session);
    expect(session.holdOutArmed, isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 1400));
    expect(_reconnectFrames(transport), 1,
        reason: 'this timer is polling blindly, not listening to the number the server said');
  });
}
