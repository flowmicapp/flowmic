// Card F11 800-line cap — the inject:result WRITE-BACK moved out of
// timeline_store.dart (781/800) into a `part` of the same library.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE except the receiver: `applyInjectResult`
// was an instance method of [TimelineStore] and is now a library-private
// top-level function taking it explicitly ([store]) — the SAME shape
// `delivery_outbox_settle.dart` established for `delivery_outbox.dart`, and it
// works for the same reason: a `part` shares the library, so `store._replace`
// is still in scope. `TimelineStore.applyInjectResult` stays on the class as a
// one-line delegate, so **no caller and no test double had to be edited**.
//
// WHY THIS IS THE RIGHT CUT. timeline_store.dart answers 「what does this phone
// remember」
// (build / find / edit / delete / purge); this file answers ONE question with
// its own red line — 「once the other side answers, which word should this row
// say, and on what grounds」 (R11). It is read
// by different people at different times, and every correction block in it is about a
// judgement basis rather than about storage.
//
// ⚠️ The edits made in the SAME window as the move are marked Card F11 ② and are
// the only diff beyond 「moved」: the correlation guard and the [wireMode] doc
// correction. Anything else here that is not in the pre-move file is a bug.

part of 'timeline_store.dart';

// ── inject:result write-back ─────────────────────────────────────────────────

/// inject:result write-back. [correlationId] is the A-58 echo — the entry id
/// (exact, a Re-inject) or the utterance client id/request_id. When the frame
/// carries NO id at all (the live STT path echoes none), the truth applies to
/// [TimelineStore.lastAwaitingInject] — safe because the FSM allows only one
/// utterance in flight. A noted entry is never touched by a stray
/// inject:result.
///
/// N2 / RV-42 — **`ok:false` is not one fact.** This used to read
/// `status: ok ? injected : failed`, unconditionally, so a verdict that said
/// 「not delivered, can be redelivered later」 (`mode:'cached'`, e.g.
/// `INJECT_FOCUS_LOST`) was announced
/// on the phone as 「✗ injection failed」 while the PC capsule said the opposite about
/// the same message. The wire always carried the distinction; nobody read it.
bool timelineApplyInjectResult(
  TimelineStore store, {
  String? correlationId,
  required bool ok,
  InjectTarget? target,

  /// owner 2026-07-27: the PC this row landed on, stamped WITH the target so
  /// the row remembers where it went even after the phone pairs elsewhere.
  String? pcName,
  String? failureReason,

  /// The verdict's `mode` field, verbatim off inject:result — see
  /// [TimelineStore.kWireModeCached]. Named `wireMode` rather than `mode` on
  /// purpose: [TimelineStore] already has a `mode` (the [FlowMode] of an
  /// utterance), and two unrelated things sharing a name here is how the
  /// write-back gets misread.
  ///
  /// **Null means 「this layer did not get a mode」**, and Card F11 ③ gave that
  /// null a second,
  /// equally honest producer. It used to mean only 「no remote verdict」 — every LOCAL
  /// settle path (link known down, socket refused the frame, the 20 s watchdog)
  /// leaves it null, and those rows failed on this device with no PC answering
  /// for them. As of F11 ③ a REMOTE verdict that simply did not carry `mode`
  /// also arrives as null instead of as a fabricated `'sendinput'`
  /// (`signaling/inbound_payloads.dart`).
  ///
  /// ⚠️ THAT IS NOT ONE VALUE ANSWERING TWO QUESTIONS, and the difference is
  /// worth the words: the only question asked of this field below is 「did the
  /// verdict say
  /// cached」, and both producers of null answer it identically and
  /// truthfully — **it did not say**. What the fabricated default did was
  /// answer it with
  /// 「it said something, and it was not cached」, which is a claim this device
  /// invented. If a future
  /// consumer ever needs 「did the remote end actually answer at all」, that is
  /// the ERROR CODE's job
  /// (`session/outbox_inject_authorship.dart`), not this field's — `mode` has
  /// two authors and cannot answer it (Card F2).
  String? wireMode,
}) {
  TimelineEntry? entry;
  if (correlationId != null && correlationId.isNotEmpty) {
    entry = store.findById(correlationId) ?? store.findByClientId(correlationId);
    // ── 🔴 Card F11 ② — 「could not find that row」 IS NOT 「did not say which
    // row」 ────────────────────
    //
    // The fallback below exists for ONE case, named in this function's own doc:
    // a frame that echoes NO correlation id (the live STT path). A frame that
    // named a row we no longer have is a different fact entirely, and this layer
    // has nothing with which to identify the row it is about — R11's first
    // question, answered honestly: **this layer does not have the fact needed
    // to make this judgement**.
    //
    // WHAT IT COST WHILE THE TWO SHARED A BRANCH: the user deletes a row whose
    // delivery is still owed (deleting a row does not cancel its queue item —
    // `TimelineStore.delete` reaps the row, nothing tells the outbox), the drain
    // sends it, the PC answers under an id nothing resolves, and the verdict is
    // written onto **whichever other row happens to be waiting**. That is a
    // status word for message B produced by the delivery of message A.
    //
    // 🔴 THIS IS THE ROOT THE RE-INJECT PATH ALREADY GUARDS AGAINST, from the
    // other end: `manual_delivery_reinject.dart` refuses to emit for a row that
    // has been deleted underfoot and says why in as many words — 「emitting
    // anyway would let the verdict fall back onto `lastAwaitingInject` and write
    // this delivery's truth onto somebody else's row」. It could afford that
    // guard because nothing was owed yet. A DRAIN cannot: owner ruled
    // 「no matter how long it takes, everything must be delivered」, so refusing
    // to drain an owed delivery would
    // either drop it (an owner-level product decision nobody has taken) or park
    // it queued forever (「a wait no mechanism makes good on」, the red line
    // itself). ⇒ the
    // fix belongs where both paths already point: HERE, at the guess.
    //
    // ⚠️ WHAT IS HONESTLY LOST. One shape stops being rescued by luck: a manual
    // send that covered rows it did not build (`wireEntryId == null`) whose
    // in-flight claim did not survive a process death — its verdict echoes only
    // a `request_id` no row is keyed by, and it now leaves the row waiting
    // instead of settling 「the most recent waiting row」. That guess was right
    // only when there happened to be exactly one candidate. A row left waiting
    // is a truth this device does not have; a row settled from another
    // delivery's verdict is a lie it does have. The failure direction is chosen.
    //
    // 📌 The QUEUE's own resolution has never had this fallback: `_find`
    // (delivery_outbox_settle.dart) tries request_id then entry_id and returns
    // null, and `outboxSettle` does nothing at all with an unresolved verdict.
    // This makes the row layer agree with it.
    if (entry == null) {
      // ⚠️ SELF-EXPOSING: a verdict that lands nowhere must be readable, or the
      // next 「why has this row been waiting the whole time」 investigation has
      // no trail. It is also the
      // signal that some path is echoing an id this device does not key rows by.
      diag('timeline.inject_result_unresolved', <String, Object?>{
        'correlation': correlationId,
        'ok': ok,
        'error': failureReason,
      });
      return false;
    }
  }
  entry ??= store.lastAwaitingInject;
  if (entry == null) return false;
  // Never silently downgrade a delivered row on a late duplicate.
  //
  // ⚠️ Correction (Card F11②, 2026-08-05) — THE SENTENCE ABOVE IS KEPT VERBATIM BECAUSE
  // IT IS THE INTENT, BUT UNTIL THIS CARD THE LINE BELOW DID NOT IMPLEMENT IT.
  // It read `if (entry.status == EntryStatus.injected && ok) return false;`, and
  // `&& ok` made it fire only on `injected` + `ok:true` — a repeat of the SAME
  // word, which is not a downgrade at all. The one case the comment names, a
  // late `ok:false` landing on a row the PC had already confirmed, walked
  // straight past it and rewrote the row to undelivered / ✗. Red line R2's
  // second direction
  // (reporting something that succeeded as having failed), on a sentence that
  // is on the user's screen.
  //
  // 🔴 WHY THE ANSWER IS A LATCH AND NOT A DUPLICATE-DETECTOR. This layer cannot
  // tell 「the same answer said again」 from 「a different answer to the same
  // question」, and that is a
  // property of the wire, not of this function: `InjectResultSchema`
  // (packages/protocol/src/protocol-schemas-inject.ts) carries ok /
  // target_window / mode / error / inject_target / entry_id / request_id — no
  // sequence, no timestamp, no attempt counter. Book 15 §3.2 goes further and
  // REQUIRES a dedup replay to be 「exactly the same result as the first time」.
  // So the choice here is
  // not 「detect it」; it is 「pick which way to be wrong, per status, out loud」:
  //   · `injected` — the ONE status backed by a historical fact the PC witnessed
  //     (「this sentence has landed on that computer」). Mistaking a real update
  //     for a duplicate
  //     costs a stale `pcName`/`target` on a row that IS still delivered.
  //     Mistaking a duplicate for an update costs the opposite, and it is a lie
  //     this device cannot walk back — the row has no second write-back door.
  //     ⇒ latch.
  //   · `failed` / undelivered — NOT settled facts. They are the current
  //     reading of a
  //     delivery the queue still owes (owner: 「no matter how long it takes,
  //     everything must be delivered」), and
  //     four live paths depend on a later `ok:true` landing on them
  //     (image_send_http.dart INJECT_PC_OFFLINE, manual_delivery.dart
  //     WIRE_EMIT_FAILED/LINK_DOWN and the 20 s watchdog, and the server's
  //     INJECT_NOT_IN_ROOM — the whole second half of the F-1 fix).
  //     ⇒ NOT latched. Freezing them would re-create RV-97 ② verbatim.
  //
  // 🔴 A USER'S RESEND IS NOT BLOCKED BY THIS, structurally rather than by luck:
  // every path that re-asks the question stamps `TimelineStore.markReinjecting`
  // first (3 call sites / 2 files across apps/mobile/lib — chat_outbox_host.dart
  // and manual_delivery_reinject.dart), which puts the row back to delivering
  // BEFORE
  // any answer can return. The latch therefore only ever catches a verdict
  // nobody is waiting for.
  // ── Card IT-05 (2026-08-05, Book 15 §2.0.1-d) — the latch also covers the
  // 「delivered · not injected」 face ──────────────────────────────────────────────────
  //
  // Before this card the latch below only fired on `EntryStatus.injected`. A
  // row that is `cached && cachedByVerdict` because the PC itself ran to the
  // injection stage and answered (`isPcInjectionVerdictCode` — e.g. error code
  // 60 INJECT_DEFERRED_NOT_AUTOINJECTED or 61 INJECT_SELF_WINDOW_NO_INPUT) is
  // ALSO a terminal fact: §2.0.1-a already settles the matching queue item to
  // `delivered` for exactly this reason (delivery_outbox_settle.dart) — the PC
  // received the frame and minted its row for it, so delivery succeeded even
  // though injection did not. Without this clause, a late contradicting receipt
  // (`ok:false`, neither `wireMode:'cached'` nor a `pc-admission` code) falls
  // straight through to the `undelivered` recompute below, lands on the
  // `false` branch, and rewrites the row to `EntryStatus.failed` — announcing
  // 「undelivered」 for a message the PC itself already confirmed arrived. That is
  // R11's forbidden direction (reporting something that succeeded as having
  // failed), on a sentence on the
  // user's screen.
  //
  // WHY THE EXISTING LATCH'S REASONING APPLIES VERBATIM: every path that
  // re-asks the question calls `markReinjecting` first, which clears
  // `cachedByVerdict` and puts the row back to delivering BEFORE a fresh answer can
  // return (see the doc comment on this function). A verdict landing on a row
  // that is still `cached && cachedByVerdict` with a pc-injection code is, by
  // construction, a verdict nobody is waiting for — the same property that
  // makes the `injected` latch safe.
  //
  // 🔴 DELIBERATELY NOT extended to `cachedByVerdict` in general: `pc-admission`
  // (`INJECT_NOT_PRIMARY`) and unrecognised codes are NOT terminal (owner
  // 2026-08-02: 「when occupied, only record for now and wait for it to exit」,
  // §2.0.1-a / §3.2「PC busy」 row) — the
  // queue still owes them, the same as the `failed`/undelivered bullet above, and
  // `late_verdict_terminal_row_test.dart` group ② depends on a later `ok:true`
  // landing on them. Latching the whole face would re-create RV-97 ② verbatim.
  final bool settledByPcInjectionVerdict =
      entry.status == EntryStatus.cached &&
      entry.cachedByVerdict &&
      isPcInjectionVerdictCode(entry.failureReason);
  if (entry.status == EntryStatus.injected || settledByPcInjectionVerdict) {
    // ⚠️ SELF-EXPOSING, same shape as the queue's own terminal gate
    // (`outbox.settle_ignored_terminal`, delivery_outbox_settle.dart): 「why
    // didn't this row move with that last receipt」 has to be answerable from
    // the trail, or the
    // next 「on what grounds does it still say delivered」 investigation has
    // nothing to read.
    diag('timeline.inject_result_ignored_terminal', <String, Object?>{
      'entry_id': entry.id,
      'entry_status': entry.status.name,
      'late_ok': ok,
      'late_code': failureReason,
      'late_mode': wireMode,
    });
    return false;
  }
  // The verdict itself says 「not delivered, can be redelivered later」. That is
  // EntryStatus.cached — the
  // same status a waiting row sits at, distinguished by cachedByVerdict so the
  // two never render as one word (RV-43 §4.1).
  // 🔴 Card F2 addendum (owner 2026-08-02 「when occupied, the row = pending
  // delivery, never show undelivered」) ————
  // The second clause is not a relaxation, it is **plugging a fabricated value**.
  //
  // The original criterion was only `wireMode == kWireModeCached`. For
  // `INJECT_NOT_PRIMARY` (another phone
  // occupying this computer) it gives the **wrong** answer, and the reason is
  // not here: the `mode` the desktop stamps for that code
  // is **invented** — `socket/client.rs`'s
  // `build_inject_result(false, "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)`
  // stamps `"sendinput"`, while it never
  // pressed a single key; that comment itself says 「none of the three modes
  // describe 'nothing was tried at all' ... any value that is not `cached`
  // is an acceptable choice」. ⇒ reading the invented value here ⇒ the row
  // lands on `failed` ⇒ the interface says
  // 「**undelivered** · unsuccessful」, while what owner ruled that day was
  // **pending delivery** (Book 15 §3.2「PC busy」 row:
  // `PC_BUSY` / `INJECT_NOT_PRIMARY` / `INJECT_NOT_IN_ROOM`, all three codes
  // **are non-terminal**,
  // the queue keeps waiting for the other one to exit).
  //
  // 🔴 **The rule: a fabricated value must never be used as a criterion.**
  // Replace it by asking 「who made this verdict, and at which layer」
  // — the single source of truth is
  // `packages/protocol/src/inject-verdict-authorship.ts`, the phone mirrors it in
  // `session/outbox_inject_authorship.dart`, checked against that TS source by
  // `test/inject_verdict_authorship_
  // mirror_test.dart`.
  //
  // ⚠️ Deliberately **did NOT** change the `mode` the desktop emits: changing it
  // would change what **old phones** see
  // (that is a protocol-behaviour-surface matter, requires an owner/lead
  // ruling). This side just stops trusting it.
  // ⚠️ Also deliberately does **NOT** ask about `pc-injection` here: that family
  // is 「delivery succeeded」, going through a different criterion beyond `ok`,
  // landing in `status_badge.dart`'s `DeliveryFace.deliveredNotInjected`.
  // Here the only question answered is 「did this attempt not get through, and
  // is the queue still owed it」.
  final bool undelivered =
      !ok &&
      (wireMode == TimelineStore.kWireModeCached ||
          isPcAdmissionRefusalCode(failureReason));
  final TimelineEntry updated = entry.copyWith(
    status: ok
        ? EntryStatus.injected
        : (undelivered ? EntryStatus.cached : EntryStatus.failed),
    // Written on EVERY outcome, `false` included: copyWith treats false as an
    // explicit clear, so a row that is injected/failed/delivering can never
    // keep a
    // stale 「the verdict said undelivered」 bit from an earlier attempt.
    cachedByVerdict: undelivered,
    injectTarget: target,
    // Only a row that actually landed gets a PC stamp — a failed delivery
    // has no 「where did it go」 to report.
    pcName: ok ? pcName : null,
    // Persist the named code on fail. On ok we pass null; copyWith cannot
    // clear a prior reason (documented on TimelineEntry.failureReason), and
    // the UI only reads it while status is failed. An undelivered row keeps
    // the code too — it costs nothing, the pill does not show it (§4 gives
    // undelivered no reason line), and the local diag log is better for having it.
    failureReason: ok ? null : failureReason,
    updatedAt: DateTime.now().toUtc(),
  );
  store._replace(entry, updated);
  return true;
}
