// 800-line cap (窗口B3-2b): [OutboxDrainReport] moved VERBATIM out of
// delivery_outbox.dart, which sat exactly ON the cap, so the queue's user-facing
// surface could be built without deleting reasoning to make room. the lead's card:
// 「what gets squeezed out is always the reasoning prose, and that is the
// most expensive thing in this repo」.
//
// NOTHING WAS CHANGED — not a word of the doc comment, not a field, not an
// order. `delivery_outbox.dart` re-exports this file, so every existing import
// keeps resolving and the move is invisible to callers and tests alike. Any
// diff here beyond 「moved」 is a bug.
//
// It also belongs here on its own merits: this is the drain's PUBLIC answer,
// read by callers and by the whole outbox suite, whereas `_Attempt` (the loop's
// private vocabulary) stayed behind with the loop that speaks it.
//
// ⚠️ Correction (卡 B4-17): the last clause is now half true. `_Attempt` was moved to
// `delivery_outbox_terms.dart` for the same cap — but as a `part`, so it is
// still in the same LIBRARY and still library-private; only the FILE differs.
// The distinction this paragraph draws (public answer vs private vocabulary)
// stands; 「stayed behind」 no longer does, and is corrected rather than
// rewritten because a comment defending a design is itself a greppable claim.

import 'outbox_destination.dart';

/// The result of one drain pass, for callers and for tests.
///
/// 🔴 THREE DISPOSITIONS, NOT TWO. 「it's on its way」/「still in the queue,
/// for reason X」/「will never
/// go out, for reason X」 are three different facts about an item, and a report that
/// could only carry the first two would have to file a terminal refusal under
/// one of them: counted in [sent] it claims a delivery that never happened
/// (red line F2「must not describe something that did not happen as having
/// happened」), counted in [held] it promises a retry
/// that will never come. So [refused] is its own map, and
/// `attempted == sent + held.length + refused.length`.
class OutboxDrainReport {
  const OutboxDrainReport({
    required this.attempted,
    required this.sent,
    required this.held,
    required this.refused,
    required this.linkOk,
    this.busy = false,
  });

  final int attempted;
  final int sent;

  /// Items that stayed `queued` — with the reason each one stayed, which is the
  /// answer to 「why is this item still in the queue」. Every one of these will be tried again.
  final Map<String, OutboxAddressRefusal> held;

  /// Items this pass settled TERMINALLY (`refused`), by their named code. None
  /// of these will ever be tried again — that is what makes them a different
  /// answer from [held] rather than a shade of it.
  final Map<String, String> refused;

  /// 🔴 Card F2 (2026-09-02) — 「the link is down」 and 「someone else is
  /// already draining」 USED TO BE THE SAME VALUE, and that one value was read
  /// by `ManualDelivery.deliverText` as grounds to settle the rows the user
  /// just pressed as ✗ `LINK_DOWN`. The link was never probed on that path;
  /// nothing measured it; the sentence was invented.
  ///
  /// So this is nullable, deliberately: **null means nobody asked the
  /// question this pass**. It is nullable rather than defaulted-false so the
  /// compiler refuses `if (!report.linkOk)` and every reader has to say what
  /// it wants — the same reason [DeliveryOutbox.drain]'s `queued` parameter in
  /// `status_badge.dart` is required rather than defaulted.
  final bool? linkOk;

  /// True when this call did nothing because a drain was ALREADY running.
  ///
  /// It is not a failure and not a refusal: the ids the caller named were
  /// merged into the running drain's follow-up pass (see
  /// [DeliveryOutbox.drain]), so the delivery is still owed and still coming.
  final bool busy;
}
