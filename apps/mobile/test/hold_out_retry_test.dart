// 🔴 49-2 (owner 2026-08-03 real device) — 「一台手机连接在线，我用另一台连接后…占用的那台
// 退出后，我这台也要退出到实例清单页面再重连进来才能正常并发出消息。」
// 🔴 49-3 (machine 2026-08-03 real device) — after tapping 「断开」 on the PC, the
//    phone socket reconnects, yet **never joins the room again**: frames sent six
//    minutes later are still bounced with `INJECT_NOT_IN_ROOM`.
//
// Two faces of the same defect. The root cause is not "nobody told us we could
// come in", it is that **we were not listening to a sentence we had already
// received**: the server answered `PC_BUSY` / `PAIR_RELEASED` together with
// `retryable: true` and `retry_after_ms` (`mobile.handler.ts:221-233`, taken from
// `ReleaseSuppression.remainingMs`), and the phone stored that number in
// `lastReconnectRefusal` **only to display it** — nothing consumed it. The third
// occurrence of the L-② shape — **the fact arrived and was then dropped** — and
// this time dropping it left a stuck state.
//
// 🔴 Why the reconnect ladder cannot save us: when we are held at the door the
// server refuses **before we join the room**, the socket is still connected, and
// the ladder is a pure connection-layer thing that only dials on TCP drop.
// **The window expiring produces no TCP event** ⇒ the ladder will never ask
// again for us. So we need a timer of our own.
//
// ⚠️ Reverse control on the second case: **no budget ⇒ must not dial even once**.
// Without it, "it re-asks when the time is up" could just mean this timer
// ignores the budget and polls blindly — that is a different implementation,
// with a different pile of bugs.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/session/hold_out_retry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('server gave a budget ⇒ re-ask once when it is due; stop the timer once in', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      addTearDown(t.cancel);
      int asked = 0;

      // First refusal: the server said "still occupied, come back in 8 seconds".
      t.note(
        retryAfterMs: 8000,
        retry: () async {
          asked++;
          // This ask's result walks back into the same entry. Still held out;
          // the server gave a new budget.
          t.note(
            retryAfterMs: 8000,
            retry: () async {
              asked++;
              t.cancel(); // this time we got in ⇒ timer withdrawn (production: onAccepted)
            },
          );
        },
      );

      expect(asked, 0, reason: 'must not dial immediately — the server said "in 8 seconds"');
      async.elapse(const Duration(seconds: 7));
      expect(asked, 0, reason: 'dialing before the budget is ignoring the server');

      async.elapse(const Duration(seconds: 2));
      expect(asked, 1, reason: 'due and we did not re-ask ⇒ the user still has to leave and reconnect');

      async.elapse(const Duration(seconds: 9));
      expect(asked, 2, reason: 'still held out, so keep waiting for the next round instead of giving up after one ask');
      expect(t.armed, isFalse, reason: 'we are in; the timer must be withdrawn');

      // After getting in there must be no third ask: the loop is driven by
      // facts, not by a counter.
      async.elapse(const Duration(minutes: 5));
      expect(asked, 2, reason: 'the matter ended long ago and this timer is still spinning idle');
    });
  });

  test('reverse control: no budget from the server ⇒ must not dial even once', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      addTearDown(t.cancel);
      int asked = 0;
      t.note(retry: () async => asked++);
      async.elapse(const Duration(minutes: 10));
      expect(asked, 0, reason: 'this timer is polling blindly instead of listening to the number the server said');
      expect(t.armed, isFalse);
    });
  });

  test('leaving this screen must stop the timer — a screen nobody is looking at must not keep sending frames', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      int asked = 0;
      t.note(retryAfterMs: 8000, retry: () async => asked++);
      t.cancel(); // = the path connections_controller.leaveRoom() takes
      async.elapse(const Duration(minutes: 10));
      expect(asked, 0);
    });
  });

  test('absurd numbers from the server must be clamped: no busy-wait, and no nailing the user in place', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry a = HoldOutRetry();
      addTearDown(a.cancel);
      int askedFast = 0;
      // 0 ms: without a clamp this is a busy-wait loop.
      a.note(retryAfterMs: 0, retry: () async => askedFast++);
      async.elapse(const Duration(milliseconds: 999));
      expect(askedFast, 0, reason: 'floor did not take effect ⇒ we are hitting ourselves with a 0 from the server');
      async.elapse(const Duration(milliseconds: 2));
      expect(askedFast, 1);

      final HoldOutRetry b = HoldOutRetry();
      addTearDown(b.cancel);
      int askedSlow = 0;
      // One hour: without a clamp the user is held at the door for an hour.
      b.note(retryAfterMs: 3600000, retry: () async => askedSlow++);
      async.elapse(const Duration(seconds: 61));
      expect(askedSlow, 1, reason: 'ceiling did not take effect ⇒ one absurd number can nail the user in place');
    });
  });

  test('a new note displaces the previous timer — two timers must not run at once', () {
    fakeAsync((FakeAsync async) {
      final HoldOutRetry t = HoldOutRetry();
      addTearDown(t.cancel);
      int first = 0, second = 0;
      t.note(retryAfterMs: 10000, retry: () async => first++);
      async.elapse(const Duration(seconds: 3));
      t.note(retryAfterMs: 10000, retry: () async => second++);
      async.elapse(const Duration(seconds: 20));
      expect(first, 0, reason: 'the displaced timer is still running ⇒ one refusal dials twice');
      expect(second, 1);
    });
  });
}
