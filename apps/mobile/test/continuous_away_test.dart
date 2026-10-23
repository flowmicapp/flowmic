// NR-213 — the away log (continuous_away.dart) and the gap placement /
// persistence (article_away_gaps.dart), as pure units. The screens are pinned
// in nr213_away_screen_test.dart.

import 'package:flowmic/src/audio/continuous_away.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_away_gaps.dart';
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _row(String id, int offsetMs, {int durationMs = 30000}) {
  final DateTime t = DateTime.utc(2026, 10, 14, 9).add(Duration(milliseconds: offsetMs));
  return TimelineEntry(
    id: id,
    clientId: id,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: id,
    outputText: id,
    status: EntryStatus.noted,
    origin: 'cloud',
    articleId: 'a1',
    articleOffsetMs: offsetMs,
    durationMs: durationMs,
    createdAt: t,
    updatedAt: t,
  );
}

void main() {
  group('ContinuousAway', () {
    late DateTime now;
    late ContinuousAway away;
    setUp(() {
      now = DateTime.utc(2026, 10, 14, 9);
      away = ContinuousAway(now: () => now);
    });

    test('one away-and-back: audio position, time away, resumed', () {
      away.begin('a1');
      now = now.add(const Duration(seconds: 60));
      away.left();
      now = now.add(const Duration(seconds: 130));
      final ContinuousAwayReturn r = away.returned()!;
      expect(r.articleId, 'a1');
      expect(r.atAudioMs, 60000);
      expect(r.notRecordedMs, 130000);
      expect(r.outcome, ContinuousAwayOutcome.resumed);
      expect(away.noticeTicket, r.ticket);
      expect(away.lastReturn.value, same(r));
    });

    test('the second absence is placed in AUDIO time, net of the first', () {
      away.begin('a1');
      now = now.add(const Duration(seconds: 10));
      away.left();
      now = now.add(const Duration(seconds: 50)); // away 50 s
      away.returned();
      now = now.add(const Duration(seconds: 20));
      away.left();
      now = now.add(const Duration(seconds: 5));
      // 10 s + 20 s recorded; the 50 s away is not audio.
      expect(away.returned()!.atAudioMs, 30000);
    });

    test('🔴 D5 — a reminder that came due while away is carried by the return', () {
      away.begin('a1');
      away.noteWarning(); // in the foreground: seen, not carried
      away.left();
      expect(away.returned()!.outcome, ContinuousAwayOutcome.resumed);
      away.left();
      away.noteWarning();
      expect(away.returned()!.outcome, ContinuousAwayOutcome.resumedNearCap);
    });

    test('🔴 D5 — the ceiling stopped it while away: not-recorded ends at the stop',
        () {
      away.begin('a1');
      away.left();
      now = now.add(const Duration(seconds: 40));
      away.noteCapStop();
      away.noteEnded();
      now = now.add(const Duration(minutes: 5));
      final ContinuousAwayReturn r = away.returned()!;
      expect(r.outcome, ContinuousAwayOutcome.stoppedAtCap);
      expect(r.notRecordedMs, 40000);
      expect(away.noticeTicket, r.ticket);
    });

    test('🔴 review F3 — frozen past the ceiling: not-recorded stops at the '
        'deadline, not at the thaw', () {
      away.begin('a1', cap: const Duration(minutes: 30));
      now = now.add(const Duration(minutes: 25));
      away.left();
      now = now.add(const Duration(minutes: 15)); // thawed at 40:00
      away.noteCapStop(); // the overdue cap timer fires on the thaw
      away.noteEnded();
      final ContinuousAwayReturn r = away.returned()!;
      expect(r.outcome, ContinuousAwayOutcome.stoppedAtCap);
      expect(r.notRecordedMs, 300000);
    });

    test('🔴 review F1/F3 — the resume edge runs before the overdue cap stop: '
        'the notice is relabelled, clamped to the deadline', () {
      away.begin('a1', cap: const Duration(minutes: 30));
      now = now.add(const Duration(minutes: 25));
      away.left();
      now = now.add(const Duration(minutes: 15));
      expect(away.returned()!.notRecordedMs, 300000);
      expect(away.notice!.outcome, ContinuousAwayOutcome.resumed);
      away.noteCapStop();
      away.noteEnded();
      expect(away.notice!.outcome, ContinuousAwayOutcome.stoppedAtCap);
      expect(away.notice!.notRecordedMs, 300000);
    });

    test('🔴 review F1 — any other ending withdraws 「recording again」', () {
      away.begin('a1');
      away.left();
      away.returned();
      expect(away.notice, isNotNull);
      away.noteEnded();
      expect(away.notice, isNull);
      expect(away.lastReturn.value, isNotNull, reason: 'the gap fact stays');
    });

    test('another ending while away keeps the gap but raises no notice', () {
      away.begin('a1');
      away.left();
      now = now.add(const Duration(seconds: 3));
      away.noteEnded();
      final ContinuousAwayReturn r = away.returned()!;
      expect(r.outcome, ContinuousAwayOutcome.endedOther);
      expect(r.notRecordedMs, 3000);
      expect(away.noticeTicket, 0);
    });

    test('no return without a long recording, and none after it ended', () {
      away.left();
      expect(away.returned(), isNull);
      away.begin('a1');
      away.noteEnded();
      away.left(); // the recording is over: leaving now is not a gap
      expect(away.isAway, isFalse);
      expect(away.returned(), isNull);
    });
  });

  group('paragraphsWithAwayGaps', () {
    // Short rows: without a gap all four are ONE paragraph (positive control
    // in the last case), so a break between r1 and r2 is the gap's doing.
    final List<TimelineEntry> rows = <TimelineEntry>[
      _row('r0', 0, durationMs: 5000),
      _row('r1', 5000, durationMs: 5000),
      _row('r2', 10000, durationMs: 5000),
      _row('r3', 15000, durationMs: 5000),
    ];

    test('🔴 the gap breaks the paragraph and sits before the first row after it',
        () {
      final laid = paragraphsWithAwayGaps(
        rows,
        const <ArticleAwayGap>[ArticleAwayGap(atMs: 10000, awayMs: 130000)],
      );
      expect(laid.paragraphs.map((p) => p.rows.map((r) => r.id).toList()).toList(),
          <List<String>>[
            <String>['r0', 'r1'],
            <String>['r2', 'r3'],
          ]);
      expect(laid.gapsBefore.keys, <int>[1]);
    });

    test('a row starting within the slack before the pause goes after the gap', () {
      final laid = paragraphsWithAwayGaps(
        rows,
        const <ArticleAwayGap>[ArticleAwayGap(atMs: 10800, awayMs: 1000)],
      );
      expect(laid.paragraphs.first.rows.last.id, 'r1');
      expect(laid.gapsBefore.keys, <int>[1]);
    });

    test('a gap after the last row is drawn at the end', () {
      final laid = paragraphsWithAwayGaps(
        rows,
        const <ArticleAwayGap>[ArticleAwayGap(atMs: 200000, awayMs: 1000)],
      );
      expect(laid.gapsBefore.keys, <int>[laid.paragraphs.length]);
    });

    test('no gaps ⇒ exactly the paragraphs the page drew before', () {
      final laid = paragraphsWithAwayGaps(rows, const <ArticleAwayGap>[]);
      expect(laid.gapsBefore, isEmpty);
      expect(laid.paragraphs.length, 1);
      expect(paragraphsOf(rows).length, 1);
    });
  });

  test('ArticleAwayGapStore persists through local prefs', () async {
    final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
    final ArticleAwayGapStore a = ArticleAwayGapStore(prefs: prefs);
    await pumpEventQueue();
    await a.add('a1', const ArticleAwayGap(atMs: 60000, awayMs: 130000));
    final ArticleAwayGapStore b = ArticleAwayGapStore(prefs: prefs);
    await pumpEventQueue();
    expect(b.gapsOf('a1').single.awayMs, 130000);
    expect(b.gapsOf('a1').single.atMs, 60000);
    expect(b.gapsOf('other'), isEmpty);
    a.dispose();
    b.dispose();
  });
}
