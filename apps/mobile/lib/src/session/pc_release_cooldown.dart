// SPEC-REF:
//   docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md
//   apps/server-core/src/room/release-suppression.ts (RELEASE_SUPPRESS_MS = 60s)
//   apps/server-core/src/socket/handlers/pc.handler.ts (emits `mobile:released`
//     with the SAME budget, immediately before it closes the socket)
//
// 「电脑上把这台手机断开了，60 秒后才能再连」 — when the connect button on the
// instance list may be pressed again, per PC.
//
// ── WHY THIS IS NOT A TIMER THAT RECONNECTS ─────────────────────────────────
// 🔴 The class it must NOT become is [HoldOutRetry], which sits one file over
// and answers a question that LOOKS identical: 「什么时候再问一次」("when to
// ask again"). That one dials by itself when its time is up, and that is
// precisely the behaviour owner ruled out on 2026-08-20 — measured on the
// owner's machine, the phone that had been disconnected came back at
// release + 60.04 s, on the dot, and took the capsule before the person who
// actually wanted it could. The server's suppression window turns out to be a
// RESERVATION for whoever was evicted: it tells that phone exactly when to
// return and tells nobody else anything.
//
// So this holds a DEADLINE and nothing else. Nothing here has a `Timer`, and
// that absence is the design: when the deadline passes, a button becomes
// pressable. No frame is sent, no ladder is armed, and if the phone is in a
// pocket when the window expires, nothing at all happens — which is the
// correct amount of things to happen.
//
// ── WHY IT IS KEYED BY SCOPE KEY ────────────────────────────────────────────
// owner has several PCs. Disconnecting on one must not grey out the others; a
// single global deadline would be one value answering 「哪台不能连」("which one
// cannot be connected") for every row at once. The key is [scopeKeyFor]'s
// output (`machine:…` / `instance:…`) — the SAME bucket [PcBusyTracker] uses,
// written at the instant the fact is produced (`SessionScope.key`), re-derived
// from the pairing row at the instant it is read (`connectTo`'s guard).
//
// ── THE LATCH HALF (why one class carries both) ─────────────────────────────
// The chat page needs the MOMENT (「刚被断开 ⇒ 退回清单并说明」), the list needs
// the DEADLINE (「这台还要等多久」). Both are born from the same single event,
// `mobile:released`, and splitting them across two objects would re-create the
// exact drift 49-3 came from (one event, two holders, one forgets). The latch
// is the moment; [remaining] is the deadline; [tick] is the edge the page rides.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// Lower/upper bounds on a server-supplied window, same idiom and same reason as
/// `PcBusyTracker`: the number arrives over the wire, and neither `0` nor an
/// hour is a sentence this UI can honestly render. Below the floor the button
/// would flash disabled-then-enabled for no reason a person could perceive;
/// above the ceiling a bogus value would strand the row with no way back.
const Duration kPcReleaseCooldownFloor = Duration(seconds: 1);
const Duration kPcReleaseCooldownCeiling = Duration(seconds: 60);

/// One PC's cooldown, as a deadline rather than a countdown — a stored
/// remaining-duration would go stale the moment the app is backgrounded, and
/// this survives that by construction.
class PcReleaseCooldown {
  PcReleaseCooldown({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;
  final Map<String, DateTime> _until = <String, DateTime>{};

  /// Bumped once per [note] — the EDGE the transcription page rides to leave
  /// (`chat_flow_exits.dart`). A bare int, not the fact itself: the fact is
  /// read back through [isOnScreen] + [latchedRevoked], bucketed, so a
  /// singleton controller serving another instance's screen ignores it
  /// (RV-91's lesson, same shape as `PcBusyTracker.listenable`).
  final ValueNotifier<int> tick = ValueNotifier<int>(0);

  String? _latchedScopeKey;
  bool _latchedRevoked = false;

  /// Which screen the latched release belongs to, or null when nothing is
  /// latched. Null-vs-null never matches: a released moment with no scope is
  /// not attributable to any screen, so nobody gets ejected over it.
  bool isOnScreen(String? currentScopeKey) =>
      _latchedScopeKey != null && _latchedScopeKey == currentScopeKey;

  /// Whether the latched release was a REVOKE (取消配对) rather than a
  /// disconnect (断开). The two eject sentences are different because the next
  /// action is: wait a minute, versus scan a code again.
  bool get latchedRevoked => _latchedRevoked;

  /// The latched PC's remaining wait, for the eject sentence's 「N 秒」.
  Duration? latchedRemaining() {
    final String? key = _latchedScopeKey;
    return key == null ? null : remaining(key);
  }

  /// The page has said its sentence and left. The DEADLINE half is untouched:
  /// clearing the latch does not shorten anyone's wait.
  void clearLatch() {
    _latchedScopeKey = null;
    _latchedRevoked = false;
  }

  /// The PC released this phone. [retryAfterMs] is the server's own budget;
  /// [scopeKey] is `SessionScope.key` at the instant the event landed (the
  /// scope is read when the fact is PRODUCED, not when it is displayed —
  /// 15 册 §2.5.1's fourth rule, same as `PcBusyTracker.note`).
  ///
  /// 🔴 [revoked] is NOT 「a zero budget」, and conflating them is the bug this
  /// signature exists to prevent. 取消配对 deletes the pairing row, so there is
  /// no window to wait out and no coming back without scanning a code again —
  /// rendering that as 「retry in 0 seconds」 would send the user to tap a button
  /// that cannot work. A revoke therefore records NO deadline: the row itself
  /// is about to disappear from the list, and a countdown on a row that no
  /// longer exists is a promise about a thing that is gone. It still LATCHES —
  /// the user must leave the page either way, with the re-pair sentence.
  void note({
    required String? scopeKey,
    required int? retryAfterMs,
    required bool revoked,
  }) {
    if (scopeKey == null || scopeKey.isEmpty) return;
    _latchedScopeKey = scopeKey;
    _latchedRevoked = revoked;
    if (!revoked) {
      final int ms = retryAfterMs ?? kPcReleaseCooldownCeiling.inMilliseconds;
      final int clamped = math.max(
        kPcReleaseCooldownFloor.inMilliseconds,
        math.min(kPcReleaseCooldownCeiling.inMilliseconds, ms),
      );
      _until[scopeKey] = _now().add(Duration(milliseconds: clamped));
    }
    tick.value += 1;
  }

  /// How long until this PC may be connected to again, or `null` when it may be
  /// connected to right now. Expired entries are dropped on read so the map
  /// cannot grow without bound across a long session.
  Duration? remaining(String? scopeKey) {
    if (scopeKey == null) return null;
    final DateTime? until = _until[scopeKey];
    if (until == null) return null;
    final Duration left = until.difference(_now());
    if (left <= Duration.zero) {
      _until.remove(scopeKey);
      return null;
    }
    return left;
  }

  /// The user got in (or the row went away). Nothing to wait for any more, and
  /// no moment left to announce.
  void clear(String? scopeKey) {
    if (scopeKey != null) _until.remove(scopeKey);
    clearLatch();
  }

  /// Test/diagnostic view. Deliberately not exposed as the map itself: callers
  /// asking 「这台还要等多久」 must go through [remaining], which is the only
  /// place that knows an entry can be expired.
  int get trackedCount => _until.length;
}
