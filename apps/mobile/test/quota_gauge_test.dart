// The two-way quota gauge (owner 2026-08-27 —「从左到右＝语音分钟数，从右到左＝
// token（上下文）」).
//
// 🔴 THE ASSERTIONS LAND ON THE RENDERED BOXES, NOT ON THE FRACTIONS THIS FILE
// COMPUTED. Group ① drives the pure layout type and is arithmetic about
// arithmetic; group ② MEASURES the painted fills with `tester.getSize` and
// compares them against the track's own measured width. Both are needed and
// they are not the same test: a gauge whose maths is perfect and whose
// `Positioned` is anchored to the wrong edge passes ① and fails ②, and that is
// precisely the defect a reader would never see in a diff (0.2.53's rule — a
// question about what the user can SEE is answered on the rendered result).
//
// ⚠️ 320dp IS THE NARROW BOUND THIS PRODUCT SUPPORTS, and the labels are the
// part that can overflow, not the bar. Under `flutter_test`'s Ahem font every
// glyph is a full em square, so a label that fits here fits on a real device —
// the direction is conservative. It does NOT run the other way: nothing here
// may be read as「it fits exactly」 on hardware (0.2.53's Ahem note).

import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/quota_gauge.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A summary with both ends readable. `noMinutes` / `noTokens` produce the
/// 「that end could not be read」 shape, which is a MISSING side — see
/// [CloudMeter]'s header for why it is not an 「unlimited」 one.
CloudSummary _summary({
  double usedMin = 0,
  double limitMin = 900,
  double usedTokens = 0,
  double limitTokens = 5000000,
  bool noMinutes = false,
  bool noTokens = false,
  DateTime? resetsAt,
}) => CloudSummary(
  minutes: noMinutes ? null : CloudMeter(used: usedMin, limit: limitMin),
  tokens: noTokens ? null : CloudMeter(used: usedTokens, limit: limitTokens),
  resetsAt: resetsAt,
);

Widget _host(
  CloudSummary summary, {
  double width = 320,
  AppLocale locale = AppLocale.en,
  DateTime? now,
}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: SizedBox(
        width: width,
        child: QuotaGauge(summary: summary, strings: AppStrings.of(locale), now: now),
      ),
    ),
  ),
);

BoxDecoration _decorationOf(WidgetTester tester, Key key) =>
    tester.widget<DecoratedBox>(find.byKey(key)).decoration as BoxDecoration;

void main() {
  group('① layout maths — fractions are OF THE WHOLE TRACK, each side caps at .5', () {
    test('half of the allowance fills a quarter of the track', () {
      final QuotaGaugeLayout l = QuotaGaugeLayout.of(
        _summary(usedMin: 450, limitMin: 900, usedTokens: 2500000, limitTokens: 5000000),
      );
      expect(l.minutes!.fillFraction, closeTo(0.25, 1e-9));
      expect(l.tokens!.fillFraction, closeTo(0.25, 1e-9));
      expect(l.minutes!.overLimit, isFalse);
      expect(l.tokens!.overLimit, isFalse);
    });

    test('a tenth of the allowance fills a twentieth of the track', () {
      final QuotaGaugeLayout l = QuotaGaugeLayout.of(
        _summary(usedMin: 90, limitMin: 900, usedTokens: 500000, limitTokens: 5000000),
      );
      expect(l.minutes!.fillFraction, closeTo(0.05, 1e-9));
      expect(l.tokens!.fillFraction, closeTo(0.05, 1e-9));
    });

    test('exactly spent reaches the centre and IS a warning (>=, not >)', () {
      final QuotaGaugeLayout l = QuotaGaugeLayout.of(
        _summary(usedMin: 900, limitMin: 900, usedTokens: 5000000, limitTokens: 5000000),
      );
      expect(l.minutes!.fillFraction, closeTo(0.5, 1e-9));
      expect(l.minutes!.overLimit, isTrue);
      expect(l.tokens!.overLimit, isTrue);
    });

    test('over-spent CLAMPS at the centre — the two sides can never collide', () {
      final QuotaGaugeLayout l = QuotaGaugeLayout.of(
        _summary(usedMin: 4000, limitMin: 900, usedTokens: 50000000, limitTokens: 5000000),
      );
      expect(l.minutes!.fillFraction, 0.5);
      expect(l.tokens!.fillFraction, 0.5);
      expect(l.minutes!.fillFraction + l.tokens!.fillFraction, lessThanOrEqualTo(1.0));
      expect(l.minutes!.overLimit, isTrue);
    });

    test('an unreadable side is ABSENT — never a zero-length bar', () {
      // 🔴 The 2026-08-07 narrowing: a missing ceiling can only mean 「we failed
      // to read it」 now, so there is no side to draw and no 「unlimited」 to
      // print. A zero bar would read as 「you have used none of it」 — an answer
      // we do not have.
      final QuotaGaugeLayout l = QuotaGaugeLayout.of(
        _summary(noMinutes: true, usedTokens: 1000000, limitTokens: 5000000),
      );
      expect(l.minutes, isNull);
      expect(l.tokens, isNotNull);
      expect(l.tokens!.fillFraction, closeTo(0.1, 1e-9));
    });

    test('a zero ceiling does not divide by zero', () {
      final QuotaGaugeLayout untouched =
          QuotaGaugeLayout.of(_summary(usedMin: 0, limitMin: 0));
      expect(untouched.minutes!.fillFraction, 0);
      expect(untouched.minutes!.overLimit, isFalse);

      final QuotaGaugeLayout spent =
          QuotaGaugeLayout.of(_summary(usedMin: 1, limitMin: 0));
      expect(spent.minutes!.fillFraction, 0.5);
      expect(spent.minutes!.overLimit, isTrue);
      expect(spent.minutes!.fillFraction.isNaN, isFalse);
    });

    test('amounts print whole when whole, one decimal otherwise', () {
      expect(formatQuotaAmount(900), '900');
      expect(formatQuotaAmount(12.04), '12');
      expect(formatQuotaAmount(12.35), '12.4');
      expect(formatQuotaTokensInMillions(5000000), '5');
      expect(formatQuotaTokensInMillions(1234567), '1.2');
      expect(formatQuotaTokensInMillions(0), '0');
    });
  });

  group('② the painted bar', () {
    testWidgets('left fill grows from the LEFT edge, right fill from the RIGHT', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _host(_summary(usedMin: 450, limitMin: 900, usedTokens: 1000000, limitTokens: 5000000)),
      );
      await tester.pumpAndSettle();

      final double track = tester.getSize(find.byKey(QuotaGauge.trackKey)).width;
      final Rect left = tester.getRect(find.byKey(QuotaGauge.minutesFillKey));
      final Rect right = tester.getRect(find.byKey(QuotaGauge.tokensFillKey));
      final Rect trackRect = tester.getRect(find.byKey(QuotaGauge.trackKey));

      // 450/900 ⇒ a quarter of the track; 1M/5M ⇒ a tenth of it.
      expect(left.width, closeTo(track * 0.25, 0.5));
      expect(right.width, closeTo(track * 0.10, 0.5));
      // The anchors — this is the half the pure maths cannot see.
      expect(left.left, closeTo(trackRect.left, 0.5));
      expect(right.right, closeTo(trackRect.right, 0.5));
      // ...and they have not met.
      expect(left.right, lessThan(right.left));
    });

    testWidgets('spent to the last minute reaches the centre and turns to the warning colour', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _host(_summary(usedMin: 1200, limitMin: 900, usedTokens: 1000000, limitTokens: 5000000)),
      );
      await tester.pumpAndSettle();

      final Rect trackRect = tester.getRect(find.byKey(QuotaGauge.trackKey));
      final Rect left = tester.getRect(find.byKey(QuotaGauge.minutesFillKey));
      expect(left.width, closeTo(trackRect.width * 0.5, 0.5));
      expect(left.right, closeTo(trackRect.center.dx, 0.6));

      expect(_decorationOf(tester, QuotaGauge.minutesFillKey).color, FlowMicColors.amber);
      // 🔴 The OTHER side is untouched — a warning belongs to the meter that
      // earned it, and a bar that went amber end to end would be saying
      // something false about the context tokens.
      expect(_decorationOf(tester, QuotaGauge.tokensFillKey).color, FlowMicColors.teal);
    });

    testWidgets('the numbers stay truthful past 100% (they are not clamped with the bar)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_host(_summary(usedMin: 1200, limitMin: 900)));
      await tester.pumpAndSettle();
      final Text label = tester.widget<Text>(find.byKey(QuotaGauge.minutesLabelKey));
      expect(label.data, contains('1200'));
      expect(label.data, contains('900'));
    });

    testWidgets('an unreadable side draws NOTHING — no bar, no label, no sentence', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _host(_summary(noMinutes: true, usedTokens: 3000000, limitTokens: 5000000)),
      );
      await tester.pumpAndSettle();

      // 🔴 Not「a bar of width 0」and not「an empty string」 — absent. Both of
      // those would still be a claim about a number we never read.
      expect(find.byKey(QuotaGauge.minutesFillKey), findsNothing);
      expect(find.byKey(QuotaGauge.minutesLabelKey), findsNothing);
      // The other half still measures what it can, and stays at ITS end.
      expect(tester.getSize(find.byKey(QuotaGauge.tokensFillKey)).width, greaterThan(0));
      final Rect right = tester.getRect(find.byKey(QuotaGauge.tokensFillKey));
      final Rect track = tester.getRect(find.byKey(QuotaGauge.trackKey));
      expect(right.right, closeTo(track.right, 0.5));
    });
  });

  group('③ 320dp', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('no overflow at 320dp — ${locale.name}', (WidgetTester tester) async {
        await tester.pumpWidget(
          _host(
            _summary(usedMin: 812.5, limitMin: 900, usedTokens: 14900000, limitTokens: 15000000),
            width: 320,
            locale: locale,
          ),
        );
        await tester.pumpAndSettle();
        // A RenderFlex overflow is reported as an exception on the binding, so
        // this is a real measurement of the laid-out tree and not a hope.
        expect(tester.takeException(), isNull);
        expect(find.byKey(QuotaGauge.trackKey), findsOneWidget);
      });
    }

    testWidgets('the labels sit inside their own half at 320dp', (WidgetTester tester) async {
      await tester.pumpWidget(
        _host(_summary(usedMin: 812.5, limitMin: 900, usedTokens: 14900000), width: 320),
      );
      await tester.pumpAndSettle();
      final Rect left = tester.getRect(find.byKey(QuotaGauge.minutesLabelKey));
      final Rect right = tester.getRect(find.byKey(QuotaGauge.tokensLabelKey));
      expect(left.right, lessThanOrEqualTo(right.left + 0.01));
      expect(right.width, greaterThan(0));
    });
  });

  // ── ④ when the allowance starts over (owner 2026-09-07) ───────────────────
  //
  // 🔴 EVERY INSTANT IN THIS GROUP IS BUILT FROM A **LOCAL** DateTime AND THEN
  // CONVERTED. `DateTime(2026, 9, 24, 8).toUtc()` is 08:00 local wherever the
  // suite runs, so the sentence under test is the same on this machine, on the
  // Mac and on a runner in another zone. Writing `DateTime.utc(2026, 9, 24)`
  // here instead would produce a different sentence per timezone and the file
  // would be a machine-local baseline — the trap this repo already pays for in
  // its rendered-copy snapshots.
  group('④ the reset line', () {
    testWidgets('says the local date, the local time and the days remaining', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _host(
          _summary(usedMin: 12, resetsAt: DateTime(2026, 9, 24, 8).toUtc()),
          width: 411,
          now: DateTime(2026, 9, 10, 9, 30),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Resets 9/24 08:00 · in 14 days'), findsOneWidget);
    });

    testWidgets('🔴 wire → screen, through the real parser and nothing else', (
      WidgetTester tester,
    ) async {
      // 🔴 THE OTHER TESTS IN THIS GROUP HAND [QuotaGauge] A `CloudSummary` THEY
      // BUILT, so they prove the widget draws what it is given and prove nothing
      // about whether anything gives it that. Deleting the one line in
      // `parseCloudSummary` that reads `quota.period.end` leaves every one of
      // them green — measured, not assumed — which is rule ⑥ exactly: two ends
      // each tested and nothing walking the middle. This one starts at the bytes
      // the server sends.
      final DateTime boundary = DateTime.utc(2026, 9, 24);
      final DateTime local = boundary.toLocal();
      final CloudSummary? parsed = parseCloudSummary(<String, Object?>{
        'plan': <String, Object?>{'plan': 'free'},
        'quota': <String, Object?>{
          'stt': <String, Object?>{'used_min': 12, 'limit_min': 900},
          'llm': <String, Object?>{'used': 1200000, 'used_in': 40000, 'limit': 5000000},
          'month': '2026-08-24',
          'period': <String, Object?>{'start': '2026-08-24', 'end': '2026-09-24'},
        },
        'devices': <String, Object?>{'pc_count': 1, 'mobile_count': 1},
        'continuous_minutes': 10,
      });
      expect(parsed, isNotNull);
      await tester.pumpWidget(
        _host(
          parsed!,
          width: 411,
          now: DateTime(local.year, local.month, local.day - 14, 9),
        ),
      );
      await tester.pumpAndSettle();
      final String hhmm =
          '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
      // Derived from `boundary.toLocal()`, never typed out: a literal
      // '9/24 08:00' would pass here and fail on a machine in another zone.
      expect(
        find.text('Resets ${local.month}/${local.day} $hhmm · in 14 days'),
        findsOneWidget,
      );
    });

    testWidgets('the count is calendar days, so 1 and 0 are words not numbers', (
      WidgetTester tester,
    ) async {
      // 🔴 「in 1 days」 is the failure this pair exists to prevent, and it is
      // not a grammar nicety: it is the one string on this card that arrives on
      // the day a user is most likely to be reading it.
      for (final (DateTime now, String expected) in <(DateTime, String)>[
        (DateTime(2026, 9, 23, 23, 59), 'Resets 9/24 08:00 · tomorrow'),
        (DateTime(2026, 9, 24, 0, 1), 'Resets 9/24 08:00 · today'),
        // 20 hours out, but on the far side of local midnight: a duration
        // rounded to days would call this 「in 1 day」 and it is tomorrow.
        (DateTime(2026, 9, 23, 12), 'Resets 9/24 08:00 · tomorrow'),
        (DateTime(2026, 9, 22, 12), 'Resets 9/24 08:00 · in 2 days'),
      ]) {
        await tester.pumpWidget(
          _host(
            _summary(resetsAt: DateTime(2026, 9, 24, 8).toUtc()),
            width: 411,
            now: now,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(expected), findsOneWidget, reason: 'now=$now');
      }
    });

    testWidgets('no field, no line — and no dash standing in for one', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_host(_summary(usedMin: 12), width: 411));
      await tester.pumpAndSettle();
      expect(find.byKey(QuotaGauge.resetLabelKey), findsNothing);
      // The gauge itself is untouched — the whole point of the absent case.
      expect(find.byKey(QuotaGauge.minutesLabelKey), findsOneWidget);
      expect(find.byKey(QuotaGauge.trackKey), findsOneWidget);
    });

    testWidgets('a boundary already past says nothing rather than a stale date', (
      WidgetTester tester,
    ) async {
      // The summary on screen is then old, and a past instant printed as a
      // future one would be a confident claim about somebody's allowance.
      await tester.pumpWidget(
        _host(
          _summary(resetsAt: DateTime(2026, 9, 24, 8).toUtc()),
          width: 411,
          now: DateTime(2026, 9, 25, 9),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(QuotaGauge.resetLabelKey), findsNothing);
    });

    for (final AppLocale locale in AppLocale.values) {
      testWidgets('reads inside 320dp, unclipped — ${locale.name}', (
        WidgetTester tester,
      ) async {
        await tester.pumpWidget(
          _host(
            _summary(usedMin: 812.5, limitMin: 900, resetsAt: DateTime(2026, 12, 24, 8).toUtc()),
            width: 320,
            locale: locale,
            now: DateTime(2026, 12, 10, 9),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        // 🔴 MEASURED, NOT INSPECTED. `Text.data` was intact in 0.2.53 too; what
        // the user could read was three letters. This line is allowed to wrap,
        // so the assertion is that it stayed inside its box — which is what
        // 「the whole sentence is on screen」 means for a wrapping paragraph.
        final Finder line = find.byKey(QuotaGauge.resetLabelKey);
        expect(line, findsOneWidget);
        final RenderParagraph p = tester.renderObject<RenderParagraph>(line);
        expect(p.didExceedMaxLines, isFalse, reason: '${locale.name} was clipped');
        expect(tester.getSize(line).width, lessThanOrEqualTo(320.01));
      });
    }
  });
}
