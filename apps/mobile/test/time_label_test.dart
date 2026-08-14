// owner 2026-07-26 ④ — the dated timeline label.
//
// The defect this pins: a bare HH:mm on every row made a day-old entry
// indistinguishable from a fresh one (seen live on the owner's tablet: two
// 7/25 rows reading as if they were today's).

import 'package:flowmic/src/ui/time_label.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // A fixed LOCAL reference instant: 2026-07-26 13:00 local.
  final DateTime now = DateTime(2026, 7, 26, 13, 0);

  test('today keeps the short form', () {
    final DateTime t = DateTime(2026, 7, 26, 9, 5).toUtc();
    expect(timelineTimeLabel(t, now: now), '09:05');
  });

  test('yesterday carries its date — the tablet defect', () {
    final DateTime t = DateTime(2026, 7, 25, 19, 8).toUtc();
    expect(timelineTimeLabel(t, now: now), '7/25 19:08');
  });

  test('an older year carries the year', () {
    final DateTime t = DateTime(2025, 12, 31, 23, 59).toUtc();
    expect(timelineTimeLabel(t, now: now), '2025/12/31 23:59');
  });

  test('midnight boundary: 23:59 vs 00:01 across the day line', () {
    // One minute apart on the clock, different days — the label must say so.
    final DateTime lateYesterday = DateTime(2026, 7, 25, 23, 59).toUtc();
    final DateTime earlyToday = DateTime(2026, 7, 26, 0, 1).toUtc();
    expect(timelineTimeLabel(lateYesterday, now: now), '7/25 23:59');
    expect(timelineTimeLabel(earlyToday, now: now), '00:01');
  });
}
