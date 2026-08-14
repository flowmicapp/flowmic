// 卡 B4-17 / L8 800-line cap — the SETTLE half of delivery_outbox.dart, moved
// VERBATIM into a `part` of the same library.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE except the receiver: every member below was
// an instance method of [DeliveryOutbox] and is now a library-private top-level
// function taking it explicitly ([box]) — the SAME shape chat_outbox_host.dart
// established for chat_controller.dart, and the reason it works is that a `part`
// shares the library, so `box._store` / `box._watchdogs` are still in scope.
// `DeliveryOutbox.settle` itself stays on the class as a one-line delegate, so no
// caller and no test double had to be edited. **Any diff here beyond 「moved」 is a
// bug.**
//
// ⚠️ Correction (D9, 0.3.0): the sentence above described the L8 move and is kept as
// history, not as a ban. D9 rerouted every `_store.upsert` /
// `_store.findByRequestId` in this file through `DeliveryOutbox._persistItem` /
// `_findItemByRequestId` — the disk-degradation seam — so a settle on a broken
// disk updates the in-memory shadow instead of throwing the verdict away. The
// settle RULES below are unchanged.
//
// WHY THIS IS THE RIGHT CUT and not just the biggest one. delivery_outbox.dart
// answers 「when, which item, and where it goes」; this file answers 「after the
// other side replies, is this item finished or not」. They are read at different
// times by different people, and they have different red lines — the drain's is
// cross-wiring IDs is absolutely forbidden, this one's is 「`inflight →
// delivered` can only be flipped by the PC's own inject:result」.

part of 'delivery_outbox.dart';

// ── settle ─────────────────────────────────────────────────────────────────

/// The PC answered. [correlationId] is the A-58 echo (`request_id` or
/// `entry_id`); [ok] is its verdict; [code] its error code when it failed.
///
/// 🔴 `inflight → delivered` happens HERE AND ONLY HERE — the PC's own
/// `inject:result` is the only thing allowed to flip that latch. Nothing local
/// (not a timer, not an emit returning true) may claim a delivery.
///
/// 🔴 卡 F2 — **`ok` is not the only form of success**. The question at this
/// layer is 「is this item still owed **delivery**」, while `ok` answers
/// whether the **injection** succeeded or not. An `ok:false` — as long as it
/// is a verdict the PC itself made on the injection segment — already means
/// the delivery segment is finished (doc 15 §2.0.1). The criterion is
/// [isPcInjectionVerdictCode], whose single source of truth is
/// `packages/protocol/src/inject-verdict-authorship.ts`.
/// ⚠️ **`mode` is deliberately NOT threaded through**: it cannot determine
/// authorship in either direction (the server's stand-in reply also stamps
/// `mode:'cached'`, and the PC's admission-layer refusal stamps
/// `mode:'sendinput'`); the reasoning and grep coordinates are written in the
/// file header of `outbox_inject_authorship.dart`.
Future<void> outboxSettle(
  DeliveryOutbox box, {
  required String correlationId,
  required bool ok,
  String? code,
}) async {
  final OutboxItem? item = await _find(box, correlationId);
  if (item == null) return;
  // ── 🔴 卡 F11 ① — AN ANSWERED ITEM IS ANSWERED ──────────────────────────────
  //
  // Every branch below writes a state unconditionally, so a SECOND verdict for
  // the same delivery rewrites the first one. That is not hypothetical: the PC
  // replays a cached verdict for a repeated `request_id` (dedup.rs `record()`
  // caches per id and `classify()` looks it up for every source), the queue's
  // own retry re-sends under that same id by design, and the relay can answer a
  // frame the PC also answers. A late or duplicate arrival therefore drags a
  // settled item BACKWARDS — `delivered` → `queued` on any retryable code (the
  // queue then re-delivers a sentence that already landed, and the row's
  // 「delivered」 goes back to 「pending delivery」), or a named terminal →
  // `queued`, undoing the 「no unlimited retries」 stop.
  //
  // 🔴 THE SHAPE, NAMED: this is the RV-90 hazard this file's own footer warns
  // about (a second write of the same primary key rolls the state back). The
  // invariant claimed there — each path writes its settled item exactly once —
  // is only true PER CALL. Nothing was stopping a second CALL.
  //
  // ⚠️ NO PATH IS ADDED FOR `refused → delivered`. A genuine `ok:true` after a
  // terminal refusal has no producer today (one frame earns one verdict, and
  // every terminal code here is a refusal that precedes any injection), and
  // 0.2.52 §4 ruled that inventing a recovery path for a state nobody has
  // observed is how façades get built. The diag below is the honest version of
  // that worry: if it ever happens, it is readable.
  if (item.isTerminal) {
    // ⚠️ SELF-EXPOSING: 「why didn't this item move along with the final
    // receipt」 must be answerable,
    // and a duplicate verdict is also the first symptom of a dedup/replay bug on
    // the other end.
    diag('outbox.settle_ignored_terminal', <String, Object?>{
      'request_id': item.requestId,
      'state': item.state.name,
      'refused_code': item.refusedCode,
      'late_ok': ok,
      'late_code': code,
    });
    return;
  }
  outboxCancelWatchdog(box, item.requestId);
  if (ok) {
    final OutboxItem delivered =
        item.copyWith(state: OutboxDeliveryState.delivered);
    await box._persistItem(delivered, op: 'settle_delivered');
    // ⚠️⚠️ `await _releaseBytes(delivered)` STOOD HERE AND IS GONE (RV-93).
    // owner 2026-08-01 revoked ①「delete on successful delivery」: 「changed to:
    // keep it」. The delivered picture is the ONE copy the tap-to-enlarge view
    // shows on this phone, and it is the same one that went into the PC's
    // focused window. Deleting it here made 「look at the picture I just sent」
    // impossible the instant it succeeded.
    //
    // 🔴 THE INVARIANT THIS BREAKS, AND WHERE IT WENT: the byte deletion WAS
    // what kept a delivered picture from showing a resend button
    // (「button ⇔ bytes」). With the bytes permanent that equivalence is vacuously
    // true, so the gate moved to the DELIVERY STATE —
    // `OutboxPendingView.resendableImageEntryIds`. If you are here because a
    // delivered picture grew a resend button, that projection is what to read.
    diag('outbox.settled', <String, Object?>{
      'request_id': item.requestId,
      'state': 'delivered',
      'attempts': item.attempts,
    });
  } else if (isPcInjectionVerdictCode(code)) {
    // ── 🔴 卡 F2 · The PC answered the injection segment in its own words ⇒
    // **the delivery segment is finished, and it succeeded** ──────────────
    //
    // owner's iron rule 2026-08-02: 「The status of a transcript message must
    // be correct.」 Doc 15 §2.0.1's very first line already nailed this rule
    // down cold — 「an `ok:false` that **the PC itself answered** (e.g.
    // `INJECT_NO_TEXT_TARGET`) equally proves **this delivery segment
    // succeeded**」 — and this layer only truly implemented it with this card.
    //
    // 🔴 This branch **replaces the L8 special-case that recognized only one
    // code** (`kInjectDeferredNotAutoinjected` is now one member of
    // [kPcInjectionVerdictCodes]). The reasoning in L8's own comment applies
    // word-for-word to the whole family, and back then it could only cover
    // one code because the settle layer had no concept of 「authorship」:
    //   The PC RECEIVED this frame. It minted its timeline row for it
    //   (`socket/client.rs`'s `row_transit::mint_row(…, run_inject(…))`
    //    —— the row and the receipt are produced by the same expression) and
    //   then did not type it. In the delivery/injection two-segment model
    //   that is **delivery succeeded + not injected · cached**, and the only
    //   question this layer has is 「is this item still owed delivery」 ⇒ the
    //   answer is no, it isn't. `delivered`, terminal.
    //
    // 🔴 **What happens if this is NOT done** (this card's symptom, hit by
    // owner on a real device): speaking while focus is on FlowMic's own
    // window ⇒ the PC replies `ok:false, mode:'cached', INJECT_FOCUS_LOST`
    // and **mints the row**, and that verdict falls into the retryable `else`
    // below ⇒ the item goes back to `queued` ⇒ the phone row shows 「pending
    // delivery」, and the banner 「N items still pending delivery」 keeps
    // counting it forever — **the message is sitting on the user's PC screen
    // at this very moment**. That is exactly the second direction of red line
    // R2: reporting something that succeeded as if it had not.
    //
    // ⚠️ Not `refused`: `refused` means **delivery failed (not delivered)**,
    // which is false here. [isTerminalRefusalCode] is therefore not where
    // these codes belong — they are terminal, but terminal on the
    // **success** side.
    //
    // ⚠️ `INJECT_NOT_PRIMARY` does not reach this branch, and deliberately
    // so: it is likewise something the PC said in its own words, but it
    // speaks for the **admission layer** (has not yet entered the injection
    // segment); owner's 2026-08-02 ruling is that when occupied, the row =
    // pending delivery ⇒ it falls into the retryable `else` below, and the
    // queue keeps owing it. The criterion is in `outbox_inject_authorship.dart`.
    //
    // ── 🔴 卡 fix-018 · owner's 63-transient / 64-standing split, landed ────────
    //
    // owner 2026-08-07 ruled OPPOSITE queue semantics for the two macOS codes
    // (63 「retryable; the next drain should try again」 / 64 「terminal; no
    // unlimited re-delivery」). Until this
    // card both settled `delivered` right here, so the ruling produced ZERO
    // behavioural difference — a self-declared debt, recorded in this file's
    // companion (`outbox_inject_authorship.dart`) and in the protocol's own
    // authorship table, both of which said in as many words that the half was
    // 「stopped-and-reported, not finished」.
    //
    // 🔴 THE SPLIT IS *INSIDE* THIS BRANCH, NOT BEFORE IT, AND THAT IS THE DESIGN.
    // Segment ① finished for BOTH codes — same producer, same `mode: Cached`, the PC
    // minted its row for both — so neither may leave [kPcInjectionVerdictCodes]
    // and neither may be re-judged as 「not delivered」. What differs is only
    // 「whether to ask the operating system again」, and that is a SECOND
    // question with its own predicate.
    //
    // ⚠️ THE STATE THIS WRITES IS `queued`, i.e. 「pending delivery」 ON THE ROW,
    // AND THAT IS NOT A REGRESSION OF F2 — it is the R11 answer to 「what
    // grounds justify saying so」. A retry is
    // genuinely pending: this frame IS going out again, so a finished word would
    // be the lie. It differs from the 0.2.48 P0 (permanently stuck at 「pending
    // delivery」) in the one property
    // that matters — it CONVERGES: [transientVerdictEarnsAnotherAttempt] goes
    // false on the wall clock (see its ① clause), so at most one more automatic
    // attempt exists and the verdict after it settles regardless.
    //
    // 🔴 AND THE RE-DELIVERY DOES NOT DUPLICATE THE PC'S ROW — measured, because
    // the protocol table's own note claims the opposite (「mints a SECOND timeline
    // row on the user's PC — once per drain」). It is wrong for THIS path: the
    // item re-sends under its FROZEN `request_id` (Gate 1, minted once at enqueue and
    // never re-minted), and the desktop addresses the row `format!("req:{rid}")`
    // (`socket/row_transit.rs` `row_id`, `RowIdOrigin::Request`), whose own doc
    // states it is 「DERIVED rather than random so an INJ-3 replay of the SAME
    // delivery … upserts the same row instead of adding a second one」. The claim
    // is true of resend / `manual_delivery`, which MINT A NEW `request_id` — a
    // different mechanism from this one. 🔴 Grep `RowIdOrigin::Request` before
    // trusting either sentence; that is what this comment is for.
    final DateTime settleAt = DateTime.now().toUtc();
    // ONE definition of 「whether this frame counts as live」 — read, never re-implemented
    // (`outbox_inject_origin.dart`: 「ONE FUNCTION, N CALL SITES」).
    // `userRequested: false` because the question asked here is specifically
    // whether an AUTOMATIC re-delivery could still be injected; a user's press is
    // a different event on a different entry point, and it is `live` regardless.
    // ⚠️ This is not a second answer to the send-time stamp in `_attempt`: that
    // one is authoritative for the frame that actually goes out, this one only
    // decides whether it is worth putting one on the wire at all.
    final InjectOrigin nextOrigin = outboxInjectOrigin((
      createdAt: item.createdAt,
      attemptAt: settleAt,
      userRequested: false,
    ));
    if (transientVerdictEarnsAnotherAttempt(
      code: code,
      nextOrigin: nextOrigin,
      attempts: item.attempts,
    )) {
      await box._persistItem(
        item.copyWith(
          state: OutboxDeliveryState.queued,
          lastRefusalNote: code,
        ),
        op: 'settle_transient_verdict_requeued',
      );
      // ⚠️ SELF-EXPOSING: 「what justifies this item going back into the queue
      // again」 must be answerable, and the
      // two facts the bound was decided FROM are logged beside the decision —
      // without them 「the window is still open」 and 「this is only the first
      // attempt」 read identically, and
      // they are the two ways this can stop.
      diag('outbox.settled', <String, Object?>{
        'request_id': item.requestId,
        'state': 'requeued',
        'code': code,
        'attempts': item.attempts,
        'requeue_reason': 'transient_injection_verdict',
        'next_origin': nextOrigin.name,
        'utterance_age_ms':
            settleAt.difference(item.createdAt).inMilliseconds,
        'attempt_cap': kTransientVerdictAttemptCap,
      });
    } else {
      final OutboxItem landed =
          item.copyWith(state: OutboxDeliveryState.delivered);
      await box._persistItem(landed, op: 'settle_pc_verdict');
      diag('outbox.settled', <String, Object?>{
        'request_id': item.requestId,
        'state': 'delivered',
        // ⚠️ SELF-EXPOSING: 「delivered but not injected」 must not read like an ordinary
        // success in the log, or a future 「why didn't the user's speech show
        // up on screen」 investigation
        // sees a clean delivered row and stops. The code IS the difference.
        'code': code,
        'attempts': item.attempts,
        // 卡 fix-018 — 「whether this item just stopped because it ran out of
        // its transient budget」. For a transient
        // code this names WHICH clause ended the retry; for every other code in
        // the family it is the constant answer 「there was never a budget」, which is also the
        // honest one.
        'transient_retry': isTransientInjectionVerdictCode(code),
        'next_origin': nextOrigin.name,
      });
    }
  } else if (code != null && isTerminalRefusalCode(code)) {
    // 🔴 A NAMED TERMINAL. Retrying this exact frame cannot produce a
    // different answer, so it stops here rather than being retried on every
    // reconnect for the life of the install (the lead 2026-07-31: 「no unlimited retries」).
    final OutboxItem stopped = item.copyWith(
      state: OutboxDeliveryState.refused,
      refusedCode: code,
    );
    await box._persistItem(stopped, op: 'settle_refused');
    // 🔴 RV-93 — a terminal refusal keeps its bytes too, and for a sharper
    // reason than the success path: this row is one the user may still want to
    // look at (it never landed anywhere), and its picture exists nowhere else.
    diag('outbox.settled', <String, Object?>{
      'request_id': item.requestId,
      'state': 'refused',
      'code': code,
      'attempts': item.attempts,
    });
  } else {
    // A retryable failure: 「not right now」. Back to queued — owner ruled 「no
    // matter how long it takes, everything must be delivered — unless the
    // connection never comes back」.
    await box._persistItem(
      item.copyWith(
        state: OutboxDeliveryState.queued,
        lastRefusalNote: code ?? 'INJECT_FAILED',
      ),
      op: 'settle_requeued',
    );
    diag('outbox.settled', <String, Object?>{
      'request_id': item.requestId,
      'state': 'requeued',
      'code': code,
      'attempts': item.attempts,
    });
  }
  await box.refreshDerivedForSettle();
  box._host.onOutboxChanged();
}

/// A verdict can echo either key (A-58): `request_id` is the primary key, and
/// `entry_id` is the fallback for the paths whose result comes back under the
/// row id.
///
/// D9 ②: both lookups are shadow-aware — an item whose enqueue never reached
/// disk must still be findable when its verdict comes back, or the delivery
/// this class just carried out would sit at `inflight` until the watchdog
/// re-queues it and it is delivered AGAIN.
Future<OutboxItem?> _find(DeliveryOutbox box, String correlationId) async {
  final OutboxItem? byRequest = await box._findItemByRequestId(correlationId);
  if (byRequest != null) return byRequest;
  for (final OutboxItem i in await box._loadPendingMerged()) {
    if (i.entryId == correlationId) return i;
  }
  return null;
}

/// 🔴 Red line 「a latch closed by a remote event must have a local
/// watchdog」, applied to the ITEM.
///
/// If no verdict arrives, the item returns to `queued` — NOT to `refused`.
/// Silence does not prove the delivery is impossible, only that this attempt
/// went unanswered, and owner ruled that those keep trying.
void outboxArmItemWatchdog(DeliveryOutbox box, OutboxItem item) {
  outboxCancelWatchdog(box, item.requestId);
  box._watchdogs[item.requestId] = Timer(box._inflightTimeout, () async {
    box._watchdogs.remove(item.requestId);
    final OutboxItem? current = await box._findItemByRequestId(item.requestId);
    // Already answered (or superseded) — re-settling would be the stale-timer
    // lie the row-level watchdog was fixed for in 0.2.8.
    if (current == null || current.state != OutboxDeliveryState.inflight) {
      return;
    }
    await box._persistItem(
      current.copyWith(
        state: OutboxDeliveryState.queued,
        lastRefusalNote: 'INJECT_NO_RESULT',
      ),
      op: 'watchdog_requeue',
    );
    diag('outbox.inflight_timeout', <String, Object?>{
      'request_id': item.requestId,
      'attempts': current.attempts,
      'budget_ms': box._inflightTimeout.inMilliseconds,
    });
    await box.refreshDerivedForSettle();
    box._host.onOutboxChanged();
  });
}

void outboxCancelWatchdog(DeliveryOutbox box, String requestId) {
  box._watchdogs.remove(requestId)?.cancel();
}

// ⚠️⚠️ `_releaseBytes(OutboxItem settled)` LIVED HERE AND IS DELETED (RV-93).
// It was the app's ONE deletion point for a picture, called from the three
// settle paths above (delivered / terminal refusal / overflow). owner
// 2026-08-01 revoked the ruling it implemented (「delete on successful
// delivery, changed to: keep it」), so
// the queue now deletes nothing at all and `OutboxBlobStore.discard` has zero
// production callers until RV-96.
//
// 🔴 WHAT IS LOST WITH IT, AND WHY THAT IS SAFE — the RV-90 bug it had just
// been fixed for. It took an owner-visible defect to find (2026-08-01 real
// device: 「every cloud-relay image transfer shows as not delivered, yet the
// image has actually already reached the PC and been injected」): it did a
// SECOND upsert of the same primary key with the copy it was handed, so being
// passed the PRE-settle item silently rolled the state back — `delivered` →
// `queued`, a named terminal → `inflight` with its code dropped. The fix was to
// make it take the already-settled copy.
//
// ⚠️ THE FIX IS NOT BEING DISCARDED — THE HAZARD IS. There is no longer any
// second upsert anywhere in `settle` / `_enforceCapacity`: each path writes its
// settled item exactly once, so the state cannot be written twice and cannot be
// rolled back by a stale copy. **A future re-introduction of any post-settle
// write must take the settled copy, for the reasons above.** The regression
// tests kept that name in outbox_test.dart and now assert the stronger fact
// (state sticks AND the picture survives), so a re-introduction that rolls the
// state back still goes red.

// ⚠️ `canResendImage(String requestId)` LIVED HERE AND WAS RETIRED IN 窗口B3-2b.
// Its doc said 「The UI's resend button must be offered IFF this is true」, and
// when the UI came to offer that button it could not use this: it holds ROWS
// (entry ids), not request ids, and a widget cannot await. The answer moved to
// [resendableImageEntryIds] ⇒ this had zero production callers and three test
// assertions, i.e. the exact façade this card exists to remove. Deleted, and
// those tests now assert the set production actually reads.
// WHAT IS LOST, said out loud: it also did a `_blobs.exists` touch, so it
// could catch a file that vanished behind the record's back. Not swallowed —
// the drain reads the bytes for real and settles `OUTBOX_IMAGE_BYTES_GONE`,
// which as of this card has a sentence and a banner that shows it.

