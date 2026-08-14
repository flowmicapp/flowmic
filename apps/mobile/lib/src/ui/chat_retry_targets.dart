// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A/D (each utterance
//     keeps its own row; status = delivery truth only)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (inject:result write-back)
//
// RV-15 — WHICH rows the send-failure banner's resend (重发) re-delivers.
//
// Split out of chat_flow_page.dart because it is a judgement, not a render: it
// answers "which rows should this failure resend" from four plain inputs and
// touches no widget, so it is unit-testable without pumping a page (and the
// page stays under its 800-line cap). ChatFlowPage keeps only the call.

import '../session/compose_gate.dart' show ComposeSendFailure;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';

/// The rows the banner's resend must re-deliver: EXACTLY the rows the failed send
/// settled as ✗, named by [coveredIds] (ManualDelivery.lastFailedCoveredIds).
///
/// RV-15: the retired implementation walked [store] and returned the single
/// NEWEST failed row, which is only ever right when the send covered one row.
/// One ➤ in organize mode routinely covers N utterances and settles all N as ✗,
/// so resend re-sent 1 of N and the other N-1 vanished from the retry — while
/// their text was gone from the composer too. The delivery layer knew the whole
/// batch all along; nobody had asked it.
///
/// Offered only for [ComposeSendFailure.wireFailed] / [ComposeSendFailure
/// .noResult] — those two actually settled rows as ✗. The other reasons
/// (notConnected / emptyBuffer / noPcTarget) never built a row and the text is
/// still sitting in the buffer, so re-sending some failed row would deliver the
/// wrong words. Image rows are excluded: the bytes are not retained, so there is
/// genuinely nothing to re-send (see entry_context_menu's deferred-delivery
/// (补投) gate).
///
/// [instanceId] narrows to the connected instance for the same reason the chat
/// scroll is narrowed (V2-06b requirement ④): a row born talking to another PC must never
/// be re-delivered to this one. Null ⇒ nothing.
///
/// Order follows [coveredIds] — the order the send covered the rows, i.e. the
/// order the utterances were spoken. The store is newest-first, which would
/// replay them backwards into the user's document.
///
/// Empty ⇒ the caller offers no resend (the banner stays a plain notice). There is
/// deliberately NO fallback to 「the newest failed row」 when the recorded ids
/// resolve to nothing (rows deleted since the failure): guessing a target would
/// push the WRONG words into the user's document, which is worse than
/// withholding the button.
List<TimelineEntry> sendRetryTargets({
  required ComposeSendFailure? failure,
  required List<String> coveredIds,
  required TimelineStore store,
  required String? instanceId,
}) {
  if (failure != ComposeSendFailure.wireFailed &&
      failure != ComposeSendFailure.noResult) {
    return const <TimelineEntry>[];
  }
  if (coveredIds.isEmpty || instanceId == null) return const <TimelineEntry>[];
  final Map<String, TimelineEntry> live = <String, TimelineEntry>{
    for (final TimelineEntry e in store.entriesForInstance(instanceId)) e.id: e,
  };
  final List<TimelineEntry> targets = <TimelineEntry>[];
  for (final String id in coveredIds) {
    final TimelineEntry? e = live[id];
    if (e == null) continue; // deleted since the failure — skip, never guess
    if (e.status != EntryStatus.failed) continue;
    if (e.isImage) continue;
    if (e.origin == 'cloud') continue;
    if (e.displayText.trim().isEmpty) continue;
    targets.add(e);
  }
  return targets;
}
