// SPEC-REF:
//   packages/protocol/src/format-timeline.ts (the desktop's shared rule)
//   docs/decisions/2026-07-25-ga-22-handwritten-wire-mirrors.md (hand mirrors
//     are the accepted pattern; this one carries its own pin tests)
//
// owner 2026-07-26 ④ finding: the chat tile stamped BARE `HH:mm` on every row
// regardless of age, so yesterday's 19:08 was indistinguishable from today's —
// the owner's own tablet showed two day-old rows as if they were fresh. Same
// rule as the desktop now: today keeps the short form, anything older carries
// its date, an older year carries the year. Numeric forms only, so the label is
// locale-free (the "UI does not follow the OS locale" red line stays untouched).

/// Timeline row label for [utc], judged against [now] (defaults to the real
/// clock; injectable so the rule is testable at fixed instants).
String timelineTimeLabel(DateTime utc, {DateTime? now}) {
  final DateTime t = utc.toLocal();
  final DateTime ref = (now ?? DateTime.now()).toLocal();
  final String hhmm =
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  final bool sameDay =
      t.year == ref.year && t.month == ref.month && t.day == ref.day;
  if (sameDay) return hhmm;
  if (t.year == ref.year) return '${t.month}/${t.day} $hhmm';
  return '${t.year}/${t.month}/${t.day} $hhmm';
}
