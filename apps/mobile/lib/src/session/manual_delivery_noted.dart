// P4 (0.3.1) — the noPcTarget half of the explicit text commit.
// SPEC-REF: docs/strategy/2026-08-15-031-fix-batch-design.md §6 (P4);
//   docs/rebuild/15 §2.0 (a button must not say 「投递」/"deliver" when no
//   delivery mechanism stands behind it — the label swap lives in
//   chat_flow_edit_sheet.dart, this file is the mechanism it points at).
//
// A `part` of manual_delivery.dart (the runReInject precedent) rather than a
// method on ManualDelivery: that file is pinned at 842 lines by the
// translation-bloat baseline (verify/lint/file-size.mjs), and a part file
// cannot reopen the class — so this is a top-level function taking the
// receiver explicitly, exactly like manual_delivery_reinject.dart.

part of 'manual_delivery.dart';

/// Commit typed text on a FIXED destination (light-record / cloud instance)
/// as a LOCAL noted row. No frame is emitted, no link is required.
///
/// 🔴 THE DEFECT THIS CLOSES (P4, measured on-device 2026-08-15): in a
/// light-record / cloud session the edit sheet's field accepted typing
/// (`_composeFieldEnabled` has no isFixed term) while `canSend` carried
/// `!destination.isFixed` — permanently false there — so the deliver button
/// was dead forever, `deliverText` answered `noPcTarget`, and nothing on
/// screen said why. The IMAGE path answered this correctly from the start
/// (`ImageSendController.canSend` ⇒ `_saveLocal`: a picture picked with no PC
/// becomes a local noted row). This is the text half of that same split.
///
/// REUSED MACHINERY, NOT A SECOND WRITE PATH: the row is minted through the
/// SAME `TimelineStore.buildFromUtterance` a record-only spoken utterance
/// lands through (`chat_utterance_settle.dart` `_settleSpan`) —
/// `Delivery.none` ⇒ `EntryStatus.noted` (timeline_store.dart), and
/// `origin: 'cloud'` is exactly `_settleSpan`'s `destination.isFixed ?
/// 'cloud' : 'paired'` arm, which is also what the image `_saveLocal` stamps.
///
/// What deliberately does NOT run here, and why:
///   · `exceedsInjectTextCap` — that gate is the WIRE's ceiling (card F4);
///     this row never goes on a wire. Same rule as the image `_saveLocal`'s
///     「Wire-budget / downscale do not apply」. A record-only spoken
///     utterance has no text cap either.
///   · the outbox / `ensureLink` / `armInFlight` watchdog — there is no
///     delivery for any of them to be about. The store write IS the whole
///     commit (persist + notify inside `_insertNew`), mirroring the image
///     path's 「The store write IS the whole save」.
///   · a `_deliverInFlight` guard — this body is synchronous end to end (no
///     `await` window for a double tap to interleave into). If an `await`
///     ever grows in here, add the guard with it.
ComposeSendFailure? commitNotedLocal(
  ManualDelivery d,
  String text, {
  required List<String> covered,
}) {
  if (text.isEmpty) return d.raise(ComposeSendFailure.emptyBuffer);
  // On a fixed destination nothing ever folds into the buffer's covered list:
  // `_settleSpan` only appends to `_bufferedEntryIds` when
  // `entry.origin != 'cloud'`, and a fixed destination stamps every spoken
  // row 'cloud'. So a non-empty [covered] here means a NEW writer appeared
  // upstream — fail loud in tests rather than silently orphan rows at ⏳.
  // Deliberately no runtime recovery path for a state nobody has observed.
  assert(
    covered.isEmpty,
    'commitNotedLocal: a fixed-destination commit covered existing rows '
    '(${covered.length}) — no producer of that state exists; see the fold '
    'guard in chat_utterance_settle.dart',
  );
  // One conclusion on screen at a time (same posture as deliverText): the
  // user asked again, so the previous failure banner retires with this
  // screen's scope rules intact.
  d._retireConclusion();
  final String requestId = d.mintRequestId('m');
  d._host.store.buildFromUtterance(
    clientId: requestId,
    mode: d._host.mode,
    delivery: Delivery.none,
    text: text,
    origin: 'cloud',
  );
  diag('deliver.noted_local', <String, Object?>{
    'request_id': requestId,
    'text_chars': text.length,
  });
  d._host.deliveryNotify();
  return null;
}
