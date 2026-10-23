// NR-286 — the RETRY-WHILE-CONNECTED half of delivery_outbox.dart, a `part` of
// the same library for the same reason as the four parts beside it (the class
// file is near its 800-line cap) and in the same shape as
// delivery_outbox_settle.dart: top-level functions taking the receiver
// explicitly ([box]), so `box._retryTimers` / `box._draining` stay in scope.
//
// Contract: doc 15 `15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md` §2.6-a. Every
// rule number below refers to that list.
//
// THE DEFECT (device, 0.3.116, 2026-10-20 — report.md A1). The drain hung only
// off `DeliveryLinkUp`, a RISING edge. When the computer stays connected but
// does not answer, nothing rises: the 45 s watchdog puts the item back to
// `queued` and it then waits for an edge that never comes. On the device the
// row said 「Pending · no answer yet」 for 6.5 minutes after the computer had
// recovered, with zero copies on it, until the user left the chat and came
// back (leaving = disconnect, coming back = a fresh room join = the edge).
//
// WHAT THIS IS NOT. It is not a second drain trigger for the link coming back
// — that stays ONE subscriber of ONE fact (chat_outbox_host.dart
// `onDeliveryLinkUpRouted`, the F-1 note). It answers a different question,
// 「the link never went anywhere, the answer did」, and it refuses to act when
// the link is not up (rule 3), so the two can never both claim the same moment.

part of 'delivery_outbox.dart';

/// Rule 1 + 2 — the 45 s watchdog just put [requestId] back to `queued` with no
/// answer. Count it and schedule ONE re-drain after the backoff step for that
/// count. Re-arming replaces a pending timer (rule 6: at most one per item).
void outboxArmNoAnswerRetry(DeliveryOutbox box, String requestId) {
  if (box._disposed) return;
  final int streak = (box._noAnswerStreak[requestId] ?? 0) + 1;
  box._noAnswerStreak[requestId] = streak;
  final List<Duration> steps = box._noAnswerBackoff;
  final Duration wait = steps[(streak - 1).clamp(0, steps.length - 1)];
  _scheduleNoAnswerRetry(box, requestId, wait);
  diag('outbox.no_answer_retry_armed', <String, Object?>{
    'request_id': requestId,
    'streak': streak,
    'wait_ms': wait.inMilliseconds,
  });
}

/// Rule 1, second half — an item was just ENQUEUED. Three of the four send
/// stations put their first frame on the wire BESIDE the queue, not through
/// it (`chat_utterance.dart` `_deliverDirect`, `manual_delivery_reinject.dart`,
/// `image_send_controller.dart`: each `enqueueText`/`enqueueImage`s and then
/// calls `emitInject` itself), so that item stays `queued` with NO 45 s
/// watchdog: if the computer swallows that frame, nothing ever notices. This
/// guard is the same 45 s budget, started at enqueue: still unanswered by then
/// ⇒ count it as one unanswered attempt and treat it exactly like a watchdog
/// requeue (first backoff step). An item that goes out through a drain
/// cancels it at the `inflight` flip (rule 6) and is timed by the real
/// watchdog instead; an answered one cancels it in settle (rule 7).
void outboxArmFirstAttemptGuard(DeliveryOutbox box, String requestId) {
  if (box._disposed) return;
  final Duration wait = box._inflightTimeout + box._noAnswerBackoff.first;
  box._retryTimers.remove(requestId)?.cancel();
  box._retryTimers[requestId] = Timer(wait, () {
    box._noAnswerStreak[requestId] = (box._noAnswerStreak[requestId] ?? 0) + 1;
    outboxOnNoAnswerRetryDue(box, requestId);
  });
}

void _scheduleNoAnswerRetry(
  DeliveryOutbox box,
  String requestId,
  Duration wait,
) {
  box._retryTimers.remove(requestId)?.cancel();
  box._retryTimers[requestId] =
      Timer(wait, () => outboxOnNoAnswerRetryDue(box, requestId));
}

/// The timer fired. Rule 3: drain only while the link is up RIGHT NOW, and do
/// not re-arm when it is not — the link-up edge owns that case. Rule 6: never
/// drop a due retry because some other drain is mid-pass.
void outboxOnNoAnswerRetryDue(DeliveryOutbox box, String requestId) {
  box._retryTimers.remove(requestId);
  if (box._disposed) return;
  if (!box._retryLinkUp()) {
    // ⚠️ SELF-EXPOSING: 「why did nothing go out at the retry time」 must be
    // answerable — and the answer here is 「the link was not up, so the
    // link-up edge will drain it」, a different fault from the edge never
    // coming.
    diag('outbox.no_answer_retry_skipped', <String, Object?>{
      'request_id': requestId,
      'reason': 'link_not_up',
      'streak': box._noAnswerStreak[requestId],
    });
    return;
  }
  if (box._draining) {
    // A pass already holding the queue loaded its list BEFORE this item went
    // back to `queued` (or it is busy with other items); `drain()` would answer
    // `busy` and do nothing for it. Ask again shortly, without counting it as
    // another unanswered attempt.
    _scheduleNoAnswerRetry(box, requestId, kOutboxNoAnswerRetryBusyRecheck);
    // N4 — one line per drain pass (reset when the pass ends, delivery_outbox
    // .dart `_drainGuarded`), not one per due item every 2 s.
    if (!box._retryBusyLogged) {
      box._retryBusyLogged = true;
      diag('outbox.no_answer_retry_skipped', <String, Object?>{
        'request_id': requestId,
        'reason': 'drain_busy',
        'streak': box._noAnswerStreak[requestId],
      });
    }
    return;
  }
  diag('outbox.no_answer_retry', <String, Object?>{
    'request_id': requestId,
    'streak': box._noAnswerStreak[requestId],
  });
  // Rule 5: an AUTOMATIC drain — no `userRequestedEntryIds` — so the frame it
  // puts out is stamped by `outboxInjectOrigin` exactly as a link-up drain's
  // would be (a defer promise ⇒ `deferred`; otherwise the 60 s window).
  // 🔴 Rule 6 (review S1): THIS item only. An unscoped drain here re-sent every
  // `queued` item, including a spoken sentence whose live frame was still out
  // (it stays `queued` until answered) — a second frame the PC may judge again
  // (it records only non-Cached outcomes, socket/inject_ops.rs). An item that
  // is no longer `queued` by now is simply not picked (no I/O at all).
  unawaited(box._drainGuarded(const <String>{}, onlyRequestId: requestId));
}

/// Rule 6 — the item just went `inflight` through SOME drain (this retry, a
/// link-up edge, the user's press). Its pending retry has nothing left to do;
/// the streak stays, because the answer to this attempt is not in yet.
void outboxCancelNoAnswerRetryTimer(DeliveryOutbox box, String requestId) {
  box._retryTimers.remove(requestId)?.cancel();
}

/// Rule 7 — the item got an answer (any verdict). Back to a clean slate.
void outboxClearNoAnswerRetry(DeliveryOutbox box, String requestId) {
  box._retryTimers.remove(requestId)?.cancel();
  box._noAnswerStreak.remove(requestId);
}
