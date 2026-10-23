// SPEC-REF:
//   docs/decisions/2026-10-10-owner-rulings-renewal-longrec-billing-eu.md item 2
//   apps/mobile/lib/src/audio/continuous_away.dart (the fact)
//
// NR-213 — the ONE wording of 「you came back to a long recording」, read by both
// screens that can be in front of the user at that moment: the notes list's
// banner queue (`chat_banner_sources.dart`) and the in-progress article page's
// status lines (`article_page_live.dart`). One function, so the two screens
// cannot word one return differently; both go away together, because both read
// the same ticket and the reconciler's dismiss clears it.

import '../audio/continuous_away.dart';
import '../settings/app_strings.dart';
import '../timeline/entry_metrics.dart' show formatEntryDuration;

/// The return notice that is standing right now, or null.
String? continuousAwayNotice(ContinuousAway away, AppStrings strings) {
  // Read off the NOTICE, not the return: an ending after the return can
  // withdraw or relabel it (`ContinuousAway.notice`, review F1).
  final n = away.notice;
  if (n == null) return null;
  final String clock = formatEntryDuration(n.notRecordedMs);
  return switch (n.outcome) {
    ContinuousAwayOutcome.resumed => strings.continuousAwayResumed(clock),
    ContinuousAwayOutcome.resumedNearCap =>
      strings.continuousAwayResumedNearCap(clock),
    ContinuousAwayOutcome.stoppedAtCap =>
      strings.continuousAwayStoppedAtCap(clock),
    // Never standing (`ContinuousAway.noticeTicket`): that ending raised its
    // own notice.
    ContinuousAwayOutcome.endedOther => null,
  };
}
