// owner 2026-08-20 — 「PC端主动断开了连接，请60秒后重新尝试连接」.
// docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md
//
// 🔴 WHAT THESE TESTS ARE GUARDING AGAINST IS A CLASS THAT ALREADY EXISTS.
// `HoldOutRetry` answers a question that sounds the same — 「什么时候再问一次」 —
// and answers it by DIALLING when its time is up. Measured on the owner's
// machine, that is what let the disconnected phone return at release + 60.04 s,
// on the dot, and take the capsule back before the person who wanted it could.
// This class must never grow that behaviour, so the tests below assert what it
// does NOT do as carefully as what it does.

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/session/pc_release_cooldown.dart';

void main() {
  late DateTime clock;
  PcReleaseCooldown make() => PcReleaseCooldown(now: () => clock);

  setUp(() => clock = DateTime.utc(2026, 8, 20, 12, 0, 0));

  test('a disconnect starts a countdown for THAT pc only', () {
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 60000, revoked: false);

    expect(c.remaining('machine:a'), const Duration(seconds: 60));
    // owner has several PCs; disconnecting on one must not grey out the others.
    expect(c.remaining('machine:b'), isNull);
  });

  test('the countdown runs down and then the button is free', () {
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 60000, revoked: false);

    clock = clock.add(const Duration(seconds: 59));
    expect(c.remaining('machine:a'), const Duration(seconds: 1));

    clock = clock.add(const Duration(seconds: 1));
    expect(c.remaining('machine:a'), isNull, reason: 'at the deadline it is over');
    expect(c.trackedCount, 0, reason: 'an expired entry is dropped on read');
  });

  test('a REVOKE records no deadline — it is not a zero-second wait', () {
    // 🔴 The whole reason `revoked` is a field instead of a zero budget.
    // 取消配对 deletes the pairing row: there is no window, and the row is about
    // to leave the list entirely. Rendering that as「retry in 0 seconds」would
    // point the user at a button that cannot work no matter how long they wait.
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 0, revoked: true);
    expect(c.remaining('machine:a'), isNull);
    expect(c.trackedCount, 0);
    // …but it still LATCHES: the user must leave the page either way, and the
    // eject sentence for a revoke is the re-pair one.
    expect(c.isOnScreen('machine:a'), isTrue);
    expect(c.latchedRevoked, isTrue);
  });

  test('a server budget is clamped at both ends', () {
    final c = make();
    // Absurdly long: a bogus value must not strand the row for an hour.
    c.note(scopeKey: 'machine:long', retryAfterMs: 3600000, revoked: false);
    expect(c.remaining('machine:long'), kPcReleaseCooldownCeiling);

    // Absurdly short: a sub-second disable is a flicker, not information.
    c.note(scopeKey: 'machine:short', retryAfterMs: 5, revoked: false);
    expect(c.remaining('machine:short'), kPcReleaseCooldownFloor);
  });

  test('a missing budget falls back to the full window, never to zero', () {
    // An older relay that emits the event without the field must not read as
    // 「no wait at all」 — that would put us straight back into the race the
    // ruling exists to end.
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: null, revoked: false);
    expect(c.remaining('machine:a'), kPcReleaseCooldownCeiling);
  });

  test('getting in clears the wait AND the moment', () {
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 60000, revoked: false);
    c.clear('machine:a');
    expect(c.remaining('machine:a'), isNull);
    expect(c.isOnScreen('machine:a'), isFalse);
  });

  test('an empty scope key is ignored rather than tracked under ""', () {
    // A blank key would be a single global cooldown wearing a per-PC signature —
    // exactly the one-value-two-questions shape this class is keyed to avoid.
    final c = make();
    c.note(scopeKey: '', retryAfterMs: 60000, revoked: false);
    c.note(scopeKey: null, retryAfterMs: 60000, revoked: false);
    expect(c.trackedCount, 0);
    expect(c.tick.value, 0, reason: 'no fact was recorded, so no edge fires');
  });

  // ── the latch half (the moment the chat page rides) ──────────────────────

  test('note latches the scope and bumps the tick — the page\'s edge', () {
    final c = make();
    expect(c.tick.value, 0);
    c.note(scopeKey: 'machine:a', retryAfterMs: 60000, revoked: false);
    expect(c.tick.value, 1);
    expect(c.isOnScreen('machine:a'), isTrue);
    // Bucketed: a singleton controller painting machine B's screen must not
    // eject that user over machine A's release (RV-91's lesson).
    expect(c.isOnScreen('machine:b'), isFalse);
    expect(c.isOnScreen(null), isFalse, reason: 'null-vs-null never matches');
  });

  test('clearLatch ends the moment without shortening the wait', () {
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 60000, revoked: false);
    c.clearLatch();
    expect(c.isOnScreen('machine:a'), isFalse);
    expect(c.remaining('machine:a'), const Duration(seconds: 60),
        reason: 'the deadline half is untouched — the page leaving does not '
            'earn anyone an earlier reconnect');
  });

  test('latchedRemaining reads through the latched key', () {
    final c = make();
    c.note(scopeKey: 'machine:a', retryAfterMs: 30000, revoked: false);
    expect(c.latchedRemaining(), const Duration(seconds: 30));
    c.clearLatch();
    expect(c.latchedRemaining(), isNull);
  });
}
