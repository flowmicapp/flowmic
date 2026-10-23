// SPEC-REF:
//   docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md (owner ruling)
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md (two-segment terminology)
//   packages/protocol/src/protocol-schemas-inject.ts (`inject_request.inject_origin`)
//   CLAUDE.md red line: one value answers only one question / no silent
//     failure (banned both directions)
//
// ── ONE DEFINITION OF 「is the user, right now, waiting for this delivery to
//    land on screen」 ───────────────────────────────────────────────────────
//
// owner 2026-08-02: 「a message that failed to send before, and later gets
// backfilled to the PC (once back online), must not be casually injected by
// the PC — at that moment the user has no way to predict this action and is
// unprepared for it; injecting straight into the current input window can
// cause an accident. Injection is an action the user expects.」
//
// 🔴 WHY THE PHONE DECIDES AND NOT THE PC. The PC cannot know: every frame looks the
// same from over there, and the only fact it could reason from is `created_at`,
// which answers 「when it was said」 and not 「whether it should be injected」
// (a resend the user pressed one second ago carries last week's
// `created_at`). The phone is the only end that knows
// whether a human just did something. It compares its OWN clock against its OWN
// `created_at`, so 🔴 **no cross-device clock comparison exists on this path** —
// which is what the ruling requires and what makes the judgement unfalsifiable by a
// PC whose clock is wrong.
//
// 🔴 ONE FUNCTION, N CALL SITES — not N judgements. The queue is the funnel but not
// the only emitter (chat_utterance / manual_delivery_reinject / image_send_controller
// each emit LIVE beside their enqueue), so 「who counts as live」 would otherwise be answered in
// four places and the fifth one added later would answer it differently. Everything
// that puts an `inject:request` on the wire goes through [outboxInjectOrigin] or
// states `InjectOrigin.live` at a site whose whole existence is a user action.

import '../signaling/wire_payloads.dart';

/// How long after speaking a delivery still counts as 「live」.
///
/// ⚠️⚠️ **An ASSUMPTION, not owner's own words.** Source: the lead
/// proposed 「N suggested at 60s」 in
/// `docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md`
/// §lead's analysis 3, and explicitly wrote 「**owner did not state this
/// number**」. What owner ruled on is only a three-row provenance table
/// (live / user-manual / auto-backfill), with no number given. **Citing this
/// must never be written as owner having set it.**
///
/// WHY A WINDOW EXISTS AT ALL rather than 「only instant delivery counts as live」: the link flaps. A
/// sentence whose first emit is lost and whose queued retry lands three seconds
/// later is still the sentence the user is watching for, and refusing it would make
/// a working feature look broken on exactly the flaky networks the queue was built
/// for. 60 s is wide enough to cover a reconnect ladder and far narrower than the
/// scenario owner described (a half-hour offline backlog).
///
/// WHAT IT IS NOT ALLOWED TO DECIDE: a user's explicit press. 「a manual user
/// action unconditionally counts as expected, regardless of time」 — that is
/// [OutboxOriginRequest.userRequested], and it short-circuits this
/// window entirely.
const Duration kLiveDeliveryWindow = Duration(seconds: 60);

/// The two facts this judgement is made from, as ONE argument.
///
/// A record rather than three loose parameters so a call site cannot pass
/// `attemptAt` where `createdAt` belongs — the two are both `DateTime`, both
/// plausible, and swapping them silently inverts the answer.
typedef OutboxOriginRequest = ({
  /// When the user SPOKE / typed / picked it (the item's frozen gate-3 instant).
  DateTime createdAt,

  /// The instant this frame is being put on the wire — the item's own
  /// `lastAttemptAt`, never a second `DateTime.now()` read.
  DateTime attemptAt,

  /// 🔴 Did the user ASK for this delivery, right now, by pressing something?
  /// owner: 「a manual user action … the user pressed something, they're
  /// prepared」 ⇒ injection is allowed, unconditionally and
  /// without looking at the clock. True for ➤ / Favorites / inline resend; false for every
  /// automatic drain (reconnect edge, PC_BUSY release).
  bool userRequested,

  /// 🔴 NR-279 — has the phone already TOLD the user, on this item's row, that
  /// the computer will not type it in on its own? The item's write-once
  /// [OutboxItem.deferPromisedAt] fact, read as a bool (see [kDeferPromiseCodes]
  /// for what writes it). True ⇒ every automatic attempt is `deferred`, however
  /// young the item is.
  bool deferPromised,
});

/// 🔴 NR-279 — the verdicts after which an automatic re-delivery may NEVER be
/// stamped `live`.
///
/// Membership rule: a code belongs here iff the row sentence it selects
/// promises the user that the computer will not type the item in by itself.
/// Today that is only `INJECT_PC_OFFLINE`, whose note
/// (`deliveryRefusalNote_INJECT_PC_OFFLINE`, selected in
/// `settings/strings/inject_note_strings.dart` `deliveryRefusalNote`) ends with
/// 「the computer will not type it in on its own」. Pinned by
/// test/outbox_defer_promise_test.dart (membership + that the note exists).
///
/// WHY THE WINDOW MUST NOT APPLY TO THESE. [kLiveDeliveryWindow] exists for a
/// lost emit the user never saw fail. A delivery the phone has openly reported
/// as refused is the opposite case: the user was told what will NOT happen, and
/// a PC that comes back 20 s later typing it into whatever window has focus is
/// exactly the accident owner's 2026-08-02 ruling (provenance row 3, 「auto
/// backfill ⇒ never auto-inject」) exists to prevent. Root cause:
/// `.local/device-evidence/0315-upgrade/rca-anomalies.md` §1.
///
/// ⚠️ NOT `pc_presence.dart` `kPcAbsentInjectCodes`, although the members
/// coincide today: that set answers 「is the PC absent」, this one answers
/// 「did we promise the user it will not be typed」. One value, one question.
const Set<String> kDeferPromiseCodes = <String>{'INJECT_PC_OFFLINE'};

/// 🔴 NR-279 S4a — does this verdict make the promise (on the row) and record
/// the fact (on the queue item, `outboxSettle`'s retryable branch)?
///
/// The two writers of ONE verdict must then run in a fixed order: the queue
/// item's `deferPromisedAt` is persisted FIRST and the row is written AFTER it
/// (`chat_outbox_host.dart` `onInjectResultRouted`; `image_send_http.dart` the
/// `pcOffline` arm, which is the only arm of that leg that can carry this code
/// — `image_upload.dart` maps a 200 with `error == 'INJECT_PC_OFFLINE'` to
/// `ImageUploadStatus.pcOffline` before the verdict arm). A kill between the two leaves either
/// both or the fact alone — never a row that promises 「will not type it in」
/// over an item that does not know it (the A1 shape: boot revive, then a live
/// drain inside the 60 s window). Pinned by
/// test/outbox_defer_promise_order_test.dart.
///
/// Every other verdict keeps its old order (row first, queue write unawaited).
bool verdictRecordsDeferPromise({required bool ok, String? code}) =>
    !ok && code != null && kDeferPromiseCodes.contains(code);

/// 🔴 THE STAMP. Everything that reaches the wire carries this answer.
InjectOrigin outboxInjectOrigin(OutboxOriginRequest req) {
  // owner: a manual user action unconditionally counts as expected,
  // regardless of time. Checked FIRST and returning
  // immediately, because the whole point is that the clock does not get a vote —
  // an `&&` with the age test would silently re-introduce one.
  if (req.userRequested) return InjectOrigin.live;
  // NR-279 — checked AFTER the user's press (a press still types) and BEFORE
  // the clock (the window must not overrule what the row already promised).
  if (req.deferPromised) return InjectOrigin.deferred;
  final Duration age = req.attemptAt.difference(req.createdAt);
  // A NEGATIVE age means the two clocks disagree with themselves (a device clock
  // moved between enqueue and drain, or a row was built with a future stamp). It is
  // treated as live rather than as deferred for the same reason absence is on
  // the PC: the failure direction that keeps a working product working. Bounded by the
  // window on the other side, so it cannot become 「everything is live forever」.
  if (age.isNegative) return InjectOrigin.live;
  return age <= kLiveDeliveryWindow ? InjectOrigin.live : InjectOrigin.deferred;
}

/// 🔴 The PC's answer to a `deferred` frame: 「received it, and per the rules
/// deliberately did not inject it」.
///
/// A constant, not a literal at the call site, because the QUEUE keys a TERMINAL
/// state on it (delivery_outbox.dart `settle`) and a typo there would turn a
/// completed delivery into an item that is re-sent on every reconnect for the life
/// of the install.
///
/// ⚠️ IT IS A PROTOCOL CODE, unlike `kOutboxOverflow` / `kOutboxImageBytesGone`
/// (outbox_item.dart's own note on why THOSE are not): this one genuinely CROSSES A
/// BOUNDARY — the PC produces it (src-tauri/src/inject/pipeline.rs
/// `deferred_outcome`) and this end consumes it. That is exactly the test that table
/// applies, and this one passes it.
const String kInjectDeferredNotAutoinjected = 'INJECT_DEFERRED_NOT_AUTOINJECTED';
