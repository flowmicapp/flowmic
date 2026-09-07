// Card UX2-2 — WHEN THE 「still pending delivery」 BANNER IS WORTH SAYING.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b (「待投递」
//     may only be said while a persistent queue really backs it)
//   apps/mobile/lib/src/session/outbox_pending_view.dart (who counts)
//   apps/mobile/lib/src/ui/banner_queue.dart (who draws)
//
// 🔴 THE OBSERVED DEFECT (owner, 0.3.75, tablet on the cloud relay): EVERY
// ordinary press raised 「还有 1 条待投递，连接恢复后会自动投递」 for the length of
// one healthy round trip and then dropped it. Both halves were wrong at once:
// the item was not waiting for anything (its first frame was on the wire), and
// the link it was said to be waiting for was up. A banner that appears after
// every single press is not observability — it is a permanent fixture the eye
// learns to skip, which is exactly what makes the SAME sentence useless on the
// day something really is stuck.
//
// 🔴 WHAT IS NOT CHANGED, SAID FIRST. The queue, the count, the persistence
// and the promise behind the word 「待投递」 are untouched: every item still
// lands on disk before it goes on the wire and is still delivered however long
// it takes. This file decides only WHEN THE SENTENCE IS SHOWN, and the row's
// own per-item face (`deliveryFaceOf`) is not routed through it — a row still
// says 「排队中」 from the first millisecond, because that is a statement about
// THAT row and it is true.
//
// THE RULE (owner, this card): stay silent while the only thing pending is the
// utterance the user just spoke, on its FIRST attempt, over a healthy link.
// Speak up as soon as any of these is true:
//   (a) something was requeued or retried at least once  [anyRetried]
//   (b) more than one item is pending                    [count > 1]
//   (c) an item has been pending longer than a short grace [kOutboxNoticeGrace]
//   (d) the link is actually down                        [linkDown]
//
// ⚠️ (c) IS A CANDIDATE NUMBER, NOT A MEASURED ONE. See [kOutboxNoticeGrace].

import 'dart:async';

import 'package:meta/meta.dart';

import 'outbox_item.dart';

/// How long one item may be pending, alone and on its first attempt, before the
/// banner is raised anyway.
///
/// ⚠️ A CANDIDATE, PICKED NOT MEASURED. What it has to clear is one healthy
/// round trip on the cloud relay (a few hundred ms in the observations behind
/// this card); what it must stay well under is the queue's own inflight
/// watchdog ([kOutboxInflightTimeout], 45 s), because past that point the item
/// is requeued and rule (a) raises the banner regardless. Five seconds is an
/// order of magnitude above the first and an order of magnitude below the
/// second. Retune it with a measurement, and say what was measured.
const Duration kOutboxNoticeGrace = Duration(seconds: 5);

/// Everything the banner needs to know about one screen's pending deliveries.
///
/// 🔴 ONE VALUE, ONE READ. The count, 「has anything already failed an attempt」
/// and 「how old is the oldest」 are computed in the same pass over the same
/// list ([OutboxPendingView.of]); asking for them separately is how a banner
/// ends up saying a number from one moment with a verdict from another.
@immutable
class OutboxPendingNotice {
  const OutboxPendingNotice({
    this.count = 0,
    this.anyRetried = false,
    this.oldestPendingAt,
  });

  /// A count with no history behind it — for callers that legitimately know
  /// nothing else (tests, and any future surface that only has a number).
  ///
  /// ⚠️ AN UNKNOWN AGE READS AS 「OLD ENOUGH」, deliberately. The grace exists to
  /// swallow the round trip of an utterance we can SEE is young; a caller that
  /// cannot say when the item was enqueued has not shown us a young one, and
  /// hiding a real backlog because nobody asked its age is the failure
  /// direction that loses information.
  const OutboxPendingNotice.count(int count) : this(count: count);

  static const OutboxPendingNotice none = OutboxPendingNotice();

  /// How many deliveries this screen is still owed (unchanged semantics:
  /// `DeliveryOutbox.pendingCountFor`).
  final int count;

  /// Has any pending item already had a delivery attempt that did not land?
  ///
  /// `attempts` is incremented when a frame goes out
  /// (`delivery_outbox_attempt.dart`) and the item returns to `queued` on a
  /// retryable refusal, a failed send or the inflight watchdog — so 「queued
  /// with at least one attempt behind it」 and 「inflight for the second time」
  /// are the two shapes of 「this is no longer the first try」.
  final bool anyRetried;

  /// When the oldest pending item was enqueued, or null when nothing is
  /// pending (or the caller does not know — see [OutboxPendingNotice.count]).
  final DateTime? oldestPendingAt;

  /// Should the banner be on screen at [now]?
  bool visible({
    required DateTime now,
    required bool linkDown,
    Duration grace = kOutboxNoticeGrace,
  }) {
    if (count <= 0) return false;
    if (linkDown || anyRetried || count > 1) return true;
    final DateTime? since = oldestPendingAt;
    if (since == null) return true; // unknown age ⇒ not demonstrably young
    return !now.isBefore(since.add(grace));
  }

  /// The moment a currently-hidden notice becomes due, or null when there is
  /// nothing to wait for (it is already visible, or nothing is pending).
  ///
  /// Consumer: [armOutboxNoticeTimer] — the grace is the one condition that
  /// becomes true with NO mutation behind it, so something has to wake the UI.
  DateTime? dueAt({
    required DateTime now,
    required bool linkDown,
    Duration grace = kOutboxNoticeGrace,
  }) {
    if (visible(now: now, linkDown: linkDown, grace: grace)) return null;
    final DateTime? since = oldestPendingAt;
    if (since == null) return null;
    return since.add(grace);
  }
}

/// Has this item already spent an attempt without landing?
///
/// 🔴 `attempts >= 1 && queued` IS THE REQUEUE, and it is the case the naive
/// `attempts > 1` misses: a requeue does not increment the counter
/// (`delivery_outbox_settle.dart` `settle_requeued` copies it through), it
/// moves the state back. Both shapes are 「not the first try」.
bool outboxItemHasSpentAnAttempt(OutboxItem item) =>
    item.attempts >= 2 ||
    (item.attempts >= 1 && item.state == OutboxDeliveryState.queued);

/// Wake [onDue] when a hidden notice's grace runs out.
///
/// Returns the timer to hold (or null when nothing is owed a wake-up); the
/// caller cancels [existing] through this call and on dispose. Written here
/// rather than in `delivery_outbox.dart` so the whole rule — including the one
/// part of it that needs a clock — is in one file.
Timer? armOutboxNoticeTimer({
  required Timer? existing,
  required OutboxPendingNotice notice,
  required void Function() onDue,
  DateTime? now,
  Duration grace = kOutboxNoticeGrace,
}) {
  existing?.cancel();
  final DateTime at = now ?? DateTime.now().toUtc();
  // 🔴 `linkDown: false` ON PURPOSE. The queue does not know the link's
  // posture and must not guess one: a down link makes the banner visible
  // already, so the only thing this timer can be wrong about is arming a
  // repaint that turns out to be unnecessary. The reverse assumption would
  // skip a wake-up the user is owed.
  final DateTime? due = notice.dueAt(now: at, linkDown: false, grace: grace);
  if (due == null) return null;
  final Duration wait = due.difference(at);
  return Timer(wait.isNegative ? Duration.zero : wait, onDue);
}
