// SPEC-REF:
//   apps/server-core/src/room/release-suppression.ts (RELEASE_SUPPRESS_MS = 60s)
//   apps/server-core/src/socket/handlers/mobile.handler.ts
//     (the ack carries `retry_after_ms` when `mobile:reconnect` is refused)
//   apps/mobile/lib/src/signaling/mobile_reconnect_flow.dart (kHoldOutCodes)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d
//
// 🔴 "When the server says when to come back, come back exactly then."
//
// The server has two kinds of **shut-out-at-the-door** replies, both carrying
// a millisecond-measured budget:
//   · `PC_BUSY`       — another phone is occupying this PC (`BUSY_SUPPRESS_MS`)
//   · `PAIR_RELEASED` — "disconnect" was just pressed on the PC
//     (`RELEASE_SUPPRESS_MS` = 60 s)
// Both are `retryable: true`, both keep the token — **the only difference is
// wording and window length**.
//
// ── WHY THIS TIMER HAS TO EXIST (real device, measured, 2026-08-03) ─────────
// While shut out at the door, the socket is **usually still connected**: the
// server refuses **before joining the room** (in `mobile.handler.ts`'s
// `mobile:reconnect` handler, the early-return branch for a `suppressedFor`
// hit runs BEFORE `joinAndNotify`), and TCP is entirely fine. The reconnect
// ladder, meanwhile, is **pure connection layer** — it only dials on a drop
// ⇒ **the window expiring produces no event at all, and nothing will ever ask
// again for us.** The phone is then stuck at "socket connected, but not in
// the room" — green dot, channel chip, all present — and every frame it sends
// bounces back with `INJECT_NOT_IN_ROOM`, while the queue banner keeps
// promising "delivery resumes automatically once the connection recovers".
//
// The measured trace (the phone's own diagnostic log, landed on the PC via
// `/api/diag/mobile`):
//   04:51:26 socket.drop io_reason=io server disconnect      ← "disconnect" pressed on the PC
//   04:57:23 probe.link alive=true                           ← the link probe says "alive"
//   04:57:23 emit.inject … handed_to_socket=true
//   04:57:23 recv.inject_result ok=false error=INJECT_NOT_IN_ROOM
//   04:57:23 outbox.settled state=requeued
// Six minutes passed, the window had long expired, and the phone never asked
// again — not once.
//
// 🔴 The server-side file's own header comment says "then flows again on its
// own" — **it asserts client behaviour, and the client does not do that.**
// The standard shape of 反 façade ④ (anti-facade rule 4): a comment that may
// have been true when written, whose truth depends on code elsewhere. This
// timer is the thing that makes that sentence true.
//
// ── WHY THIS IS A DIFFERENT THING FROM THE "OCCUPIED" BANNER ────────────────
// `PcBusyTracker` answers "**should the banner be drawn**", with the ONLY
// criterion being `PC_BUSY`; this timer answers "**when to ask again**", with
// the criterion being "did the server give a budget". They used to be crammed
// into one class, so `PAIR_RELEASED` (which has a budget but should NOT draw
// the banner) went down the clear-banner branch and took the timer down with
// it — one value answering two questions, yet another instance of this repo's
// #1 bug shape.

import 'dart:async';

/// The timer that asks again once its time is up. **One-shot, not periodic.**
///
/// It asks once when it fires, and that ask's result flows back through here
/// again — still blocked re-arms with the server's **new** budget, getting in
/// calls [cancel]. **The loop is driven by facts, not by a counter**, so it
/// never keeps spinning after the situation has already resolved.
///
/// 🔴 fix-013 (2026-08-10) — that is true only for as long as the server keeps
/// ANSWERING. An ask that goes unanswered produces no fact to drive the next
/// turn, so that one branch — and only that one — is bounded by a counter
/// instead ([noteLostAck] / [lostAckWaits]). The two entry points are separate
/// on purpose: "the server said when to come back" and "nobody answered at
/// all" are different answers to different questions, and this class exists
/// because they were once the same `null`.
class HoldOutRetry {
  Timer? _timer;

  /// How many asks IN A ROW have gone unanswered. Reset by [cancel], and
  /// therefore by every [note] — see [noteLostAck] for why that is the whole
  /// safety argument for the bound.
  int _lostAcks = 0;

  /// The **floor and ceiling** on the budget the server gives.
  ///
  /// The floor guards against "the budget is 0 or negative" — which would
  /// become a busy-wait; the ceiling guards against an absurdly large number
  /// pinning the user outside the door forever. Clamped between the two, this
  /// timer's interval ranges from **once a second at its fastest to once a
  /// minute at its slowest**, while both real paths
  /// (`BUSY_SUPPRESS_MS = 8s`, `RELEASE_SUPPRESS_MS = 60s`) pass through
  /// unmodified.
  static const Duration minWait = Duration(seconds: 1);
  static const Duration maxWait = Duration(seconds: 60);

  /// The cadence for a question that was **never answered** — one entry per
  /// attempt, in order, and the list's own length is the bound.
  ///
  /// 🔴 THIS IS NOT A GUESS AT THE SERVER'S WINDOW, and the difference is the
  /// reason it is a separate constant reached through a separate entry point
  /// rather than a default value for [note]'s `retryAfterMs`. [minWait] /
  /// [maxWait] clamp a number the server MEASURED (`release-suppression.ts`
  /// `remainingMs`) and the rule that the phone never computes "how much time
  /// is left" stands untouched. These durations answer a different question —
  /// "we got no answer, how long until we ask again" — which nobody can
  /// measure for us precisely because nobody answered. Feeding them into
  /// [note] instead would put a fabricated budget on the server's authority,
  /// and it would reach the user: the same value is stored as
  /// `lastReconnectRefusal` and rendered as "N more seconds to wait"
  /// (pairing_strings.dart).
  ///
  /// WHY THESE NUMBERS. First step 2 s, then doubling, four attempts: about
  /// 30 s of waiting and at most four extra `mobile:reconnect` frames per lost
  /// ack.
  ///   · Bounded at all, because [cancel]'s own comment is right — a phone
  ///     re-asking forever behind a screen nobody is looking at is traffic we
  ///     manufactured. When the bound is spent the phone is back to exactly
  ///     today's behaviour (the user re-enters from the instance list), so this
  ///     can only add recoveries, never remove one.
  ///   · 2 s first, because the shortest real hold-out window is
  ///     `BUSY_SUPPRESS_MS` = 8 s: a single dropped ack is re-asked well before
  ///     the window it was waiting out has even expired.
  ///   · Doubling after that, because the case that loses an ack is a briefly
  ///     overloaded relay, and a fixed 2 s would be us leaning on it.
  ///
  /// ⚠️ The bound counts CONSECUTIVE unanswered asks, NOT the recovery loop. An
  /// answer — any answer — resets it, so a phone that keeps being told
  /// `retry_after_ms` keeps being driven by facts, indefinitely, exactly as
  /// before this existed.
  static const List<Duration> lostAckWaits = <Duration>[
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 16),
  ];

  /// Test-visible: is the timer currently running.
  bool get armed => _timer != null;

  /// Record one "shut out at the door" reply.
  ///
  /// [retryAfterMs] is **the remaining window the server MEASURED**
  /// (`release-suppression.ts`'s `remainingMs`), not a window length — the
  /// phone must never compute "how much time is left" itself.
  ///
  /// 🔴 THIS ENTRY POINT IS FOR AN ACK WE ACTUALLY GOT. A null [retryAfterMs]
  /// here therefore means one thing only: the server answered and named no
  /// budget (e.g. `AUTH_TOKEN_INVALID`, whose only useful action is re-pairing)
  /// ⇒ **not one dial is allowed**, because dialling forever will never get us
  /// in. That
  /// half is unchanged since 49-2 and is pinned by the reverse control in
  /// hold_out_retry_test.dart / hold_out_recheck_wire_test.dart.
  ///
  /// 🔴 fix-013 (2026-08-10) — this null used to carry a SECOND meaning as
  /// well: "we never got an answer at all" (ack timeout / throw), which the
  /// old comment sent off to the reconnect ladder. True premise, false
  /// conclusion — the same trap, in the same file, that
  /// hold_out_recheck_wire_test.dart's header records for 0.2.51. The ladder
  /// dials on DROP EDGES, and the hold-out state is by definition "socket
  /// connected, but not in the room": nothing dropped, so the
  /// ladder never fires and **one lost ack ended the recovery loop for good**.
  /// That case now has its own entry point, [noteLostAck]. Which of the two a
  /// refusal is, is decided one layer up in `ptt_reconnect_ack.dart`
  /// (`_noteHoldOut`) — the layer that can still see whether there was an ack.
  ///
  /// Reaching this method at all means an answer arrived, so it also ends any
  /// unanswered streak (via [cancel]).
  void note({int? retryAfterMs, required Future<void> Function() retry}) {
    cancel();
    if (retryAfterMs == null) return;
    Duration wait = Duration(milliseconds: retryAfterMs);
    if (wait < minWait) wait = minWait;
    if (wait > maxWait) wait = maxWait;
    _arm(wait, retry);
  }

  /// Record an ask that came back with **no answer at all** — ack timeout or
  /// throw — and schedule a BOUNDED re-ask off [lostAckWaits].
  ///
  /// 🔴 Why anything at all happens here: this is the one state in which no
  /// other mechanism will ask again. The link is up (a dead link is the
  /// ladder's, and `_recheckHoldOut` hands it back by returning early), the
  /// server never spoke, and the phone is out of the room — every frame it
  /// sends bounces `INJECT_NOT_IN_ROOM` while the queue banner promises
  /// "delivery resumes automatically once the connection recovers". Reachable
  /// today from `mobile_reconnect_flow.dart`'s
  /// `onRejected(surfaceTransientFailure, false, null, null)`.
  ///
  /// 🔴 Why it is bounded when [note]'s loop is not: [note] is re-armed by a
  /// FACT (the server said "wait N more milliseconds"), so it stops when the facts stop.
  /// Here there is no fact — so the only honest stop condition is one we choose,
  /// and it must be finite. On running out we do not invent a new state: the
  /// phone is exactly where it is today, and the user's re-entry from the
  /// instance list still works.
  ///
  /// ⚠️ Deliberately does NOT reset the streak: this method is the streak. The
  /// counter is cleared only by [cancel], i.e. by an answer, a successful room
  /// join, or the user leaving the screen.
  void noteLostAck({required Future<void> Function() retry}) {
    final int attempt = _lostAcks;
    // Stop the pending timer WITHOUT forgetting the count — `cancel()` would
    // reset it, and re-using it here would make the bound unreachable, which is
    // the same as having no bound.
    _stop();
    if (attempt >= lostAckWaits.length) return;
    _lostAcks = attempt + 1;
    _arm(lostAckWaits[attempt], retry);
  }

  /// Must stop the timer when the user leaves this screen or the session is
  /// torn down — a phone that fires `mobile:reconnect` once a minute behind a
  /// screen nobody is looking at is traffic we manufactured ourselves.
  ///
  /// Also ends the unanswered streak: every caller of this is a fact (we got in,
  /// the server answered, the screen was left), and after a fact the next lost
  /// ack is the first of a new episode rather than the tail of an old one.
  void cancel() {
    _stop();
    _lostAcks = 0;
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
  }

  void _arm(Duration wait, Future<void> Function() retry) {
    _timer = Timer(wait, () {
      _timer = null;
      unawaited(retry());
    });
  }
}
