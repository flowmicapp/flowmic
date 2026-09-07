// Card CR-9 — the continuous-recording entry, as RENDERED.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/continuous_entry_row.dart
//   docs/ui-design/2026-08-29-continuous-recording-demo.html (A-1 / A-2)
//   task unit §6 C6 — 「unavailable ⇒ and a reason」, and the ruling that this
//     kind of criterion is asserted on the render result
//
// 🔴 WHY A SECOND FILE. `continuous_offer_test.dart` proves the DECISION; a
// green decision says nothing about whether the user can read the outcome. The
// 0.2.53 defect is the whole reason that sentence is written twice in this repo:
// 1259 tests were green while the screen showed 「INJ…」, because every one of
// them asserted `Text.data` and the user reads what survived layout.

import 'package:flowmic/src/audio/continuous_offer.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

const double _kDockWidth = 360 - 24; // 360dp phone, the dock's 12dp padding

class _Spy {
  int starts = 0;
}

Widget _host({
  required ContinuousOffer offer,
  required _Spy spy,
  AppLocale locale = AppLocale.zh,
}) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topCenter,
      child: SizedBox(
        width: _kDockWidth,
        child: ContinuousEntryRow(
          offer: offer,
          strings: AppStrings.of(locale),
          onStart: () => spy.starts++,
        ),
      ),
    ),
  ),
);

/// The shape a REFUSED ceiling read produces: no summary at all (the route
/// answered 4xx, so there are no numbers), plus the named reason it refused.
///
/// `refusal: null` with a null summary is the OTHER case this file has to keep
/// apart — a timeout, a 5xx, a socket that went away — and the two must not
/// render the same sentence.
ContinuousOffer _refused(CloudSummaryRefusal? refusal) => continuousOffer(
  recordOnly: true,
  mode: FlowMode.realtime,
  linkUp: true,
  signedIn: true,
  summary: null,
  refusal: refusal,
);

ContinuousOffer _offer({
  FlowMode mode = FlowMode.realtime,
  bool linkUp = true,
  int? cap = 30,
  double usedMin = 88,
  double limitMin = 900,
  bool noMeter = false,
}) => continuousOffer(
  recordOnly: true,
  mode: mode,
  linkUp: linkUp,
  signedIn: true,
  summary: CloudSummary(
    minutes: noMeter ? null : CloudMeter(used: usedMin, limit: limitMin),
    tokens: const CloudMeter(used: 1, limit: 20000000),
    continuousMinutes: cap,
  ),
);

final Finder _row = find.byKey(ContinuousEntryKeys.row);
final Finder _numbers = find.byKey(ContinuousEntryKeys.numbers);
final Finder _reason = find.byKey(ContinuousEntryKeys.reason);

String _text(WidgetTester tester, Finder f) => tester.widget<Text>(f).data!;

void main() {
  testWidgets('A-1: both numbers, both readable, and the press lands', (
    WidgetTester tester,
  ) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(_host(offer: _offer(), spy: spy));

    expect(_row, findsOneWidget);
    expect(find.byKey(ContinuousEntryKeys.title), findsOneWidget);
    expect(_reason, findsNothing, reason: 'nothing is wrong; there is nothing to explain');

    final String line = _text(tester, _numbers);
    expect(line, contains('30'));
    expect(line, contains('812'));

    await tester.tap(_row);
    await tester.pump();
    expect(spy.starts, 1);
  });

  testWidgets('🔴 A-2: translate is refused, the reason is ON SCREEN, and the '
      'row cannot be pressed', (WidgetTester tester) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(
      _host(offer: _offer(mode: FlowMode.translate), spy: spy),
    );

    expect(_row, findsOneWidget, reason: 'C6: refused means visible-and-explained, never gone');
    expect(_reason, findsOneWidget);
    expect(_numbers, findsNothing,
        reason: 'the refusal takes the slot — 「why」 is what is needed here, and '
            'the ceiling is a fact about the plan readable on any other day');

    await tester.tap(_row, warnIfMissed: false);
    await tester.pump();
    expect(spy.starts, 0, reason: 'a dimmed control that still fires is worse than an enabled one');
  });

  testWidgets('🔴 the refusal is not clipped in any of the nine locales', (
    WidgetTester tester,
  ) async {
    // ⚠️ THE RULER IS CONSERVATIVE IN ONE DIRECTION ONLY. `flutter_test` renders
    // in Ahem, whose every glyph is a full em square — roughly 35 characters to
    // a 411dp line where a real Latin face fits 70+. 「not clipped under Ahem」
    // therefore implies 「not clipped on a real device」, and the converse does
    // NOT hold: this may not be read as evidence that a longer sentence would
    // fit. (0.2.53 established both halves.)
    for (final AppLocale locale in AppLocale.values) {
      await tester.pumpWidget(
        _host(offer: _offer(mode: FlowMode.organize), spy: _Spy(), locale: locale),
      );
      await tester.pumpAndSettle();
      expect(
        tester.renderObject<RenderParagraph>(_reason).didExceedMaxLines,
        isFalse,
        reason: '$locale: the sentence explaining why this control is dead was '
            'itself cut off — 0.2.53, verbatim',
      );
    }
  });

  testWidgets('🔴 link down: dimmed, inert, and it does NOT invent a sentence', (
    WidgetTester tester,
  ) async {
    // The dock one centimetre up already says 未连接. A second copy here would be
    // the third voice on one fact — `compose_band.dart`'s A8 branch refuses the
    // same thing in the same place.
    final _Spy spy = _Spy();
    await tester.pumpWidget(_host(offer: _offer(linkUp: false), spy: spy));

    expect(_row, findsOneWidget);
    expect(_reason, findsNothing);
    expect(_numbers, findsOneWidget,
        reason: '「最多 30 分」 is a property of the plan, true while the link is '
            'down; withholding it would make a dimmed row say less about the '
            'product than a live one');

    await tester.tap(_row, warnIfMissed: false);
    await tester.pump();
    expect(spy.starts, 0);
  });

  testWidgets('🔴 §5-2: an unreadable balance prints ONE number, never a zero', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(offer: _offer(noMeter: true), spy: _Spy()));

    // 🔴 THE FIRST VERSION OF THIS ASSERTION WAS `isNot(contains('0 '))`, AND IT
    // WENT RED ON 「最多 30 分」 — the ruler matched the zero inside the thirty.
    // Stated instead as the two sentences by name: the one that must have been
    // drawn, and the one that must not.
    final AppStrings s = AppStrings.of(AppLocale.zh);
    expect(_text(tester, _numbers), s.continuousEntryCap(30));
    expect(_text(tester, _numbers), isNot(s.continuousEntryCapAndLeft(30, 0)),
        reason: '「还剩 0 分」 for a balance we never received is a claim we do '
            'not have — quota_gauge.dart set this rule: an end we could not '
            'read is an end we do not draw');
    expect(_reason, findsNothing, reason: 'the ceiling was readable, so it may still be started');
  });

  testWidgets('the month being spent says so, in its own words', (
    WidgetTester tester,
  ) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(
      _host(offer: _offer(usedMin: 20, limitMin: 20, cap: 10), spy: spy),
    );
    expect(_reason, findsOneWidget);
    // Not the ceiling's sentence, and not a digit in sight: the per-plan numbers
    // live in billing/plans.ts and a copy here goes stale in silence.
    expect(_text(tester, _reason), isNot(contains('10')));
    await tester.tap(_row, warnIfMissed: false);
    await tester.pump();
    expect(spy.starts, 0);
  });

  testWidgets('🔴 the row keeps its geometry when it is refused', (
    WidgetTester tester,
  ) async {
    // A dock that re-arranges when the mode chip is tapped is the 0.3.1 P3
    // defect in miniature. The refusal has to be readable in the place the user
    // was already looking.
    await tester.pumpWidget(_host(offer: _offer(), spy: _Spy()));
    final double live = tester.getSize(_row).height;

    await tester.pumpWidget(
      _host(offer: _offer(mode: FlowMode.translate), spy: _Spy()),
    );
    await tester.pumpAndSettle();
    expect(tester.getSize(_row).height, live,
        reason: 'the enabled and refused faces occupy the same box');
  });

  testWidgets('a screen reader can still reach the refusal', (
    WidgetTester tester,
  ) async {
    // ExcludeSemantics on the disabled face would hide the explanation from
    // exactly the users who most need it read aloud.
    //
    // 🔴 MATCHED AS A SUBSTRING, AND THAT IS NOT LAZINESS. `Semantics(button:
    // true)` is a container: it MERGES its descendants, so the node's label is
    // 「长程转录\n只支持实时模式」 — title and reason joined. An equality match on
    // the reason alone finds nothing, which is how the first version of this
    // case failed. Same shape as the UIA `Name` trap this repo already recorded
    // (「最近活动 刚刚」 + 「断开」 read back as one sentence): a tree that
    // concatenates children will hand you a string you did not write.
    final SemanticsHandle handle = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(offer: _offer(mode: FlowMode.translate), spy: _Spy()),
    );
    final AppStrings s = AppStrings.of(AppLocale.zh);
    expect(find.bySemanticsLabel(RegExp(RegExp.escape(s.continuousEntryModeNote))),
        findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(RegExp.escape(s.continuousEntryTitle))),
        findsOneWidget,
        reason: 'positive control: the merged label carries the title too, so a '
            'zero above would mean the node vanished rather than the reason');
    handle.dispose();
  });

  // ── R3F-2: A REFUSAL THAT NAMES ITSELF ─────────────────────────────────────
  //
  // Device round three (2026-09-06): an account whose email was never verified,
  // past the 3-day grace, gets `403 EMAIL_NOT_VERIFIED` on every
  // `GET /api/cloud/summary`. The row read 「Account limit unavailable — try
  // again」 — a sentence that promises a retry which cannot help and hides the
  // one action that does. The generic sentence is still right for a timeout, so
  // both halves are asserted here: the named one appears, and the generic one
  // survives for the case it is actually true of.

  testWidgets('🔴 403 EMAIL_NOT_VERIFIED says what to do, not 「try again」', (
    WidgetTester tester,
  ) async {
    final _Spy spy = _Spy();
    await tester.pumpWidget(
      _host(
        offer: _refused(CloudSummaryRefusal.emailNotVerified),
        spy: spy,
        locale: AppLocale.en,
      ),
    );
    final AppStrings s = AppStrings.of(AppLocale.en);

    expect(_row, findsOneWidget);
    expect(_text(tester, _reason), s.continuousEntryVerifyEmailNote);
    // 🔴 THE DISCRIMINATING HALF. Before the fix this was the sentence on
    // screen, and every retry it asked for got the same 403.
    expect(_text(tester, _reason), isNot(s.continuousEntryNoCeilingNote));

    await tester.tap(_row, warnIfMissed: false);
    await tester.pump();
    expect(spy.starts, 0);
  });

  testWidgets('🔴 a transient miss KEEPS the generic sentence', (
    WidgetTester tester,
  ) async {
    // A timeout / 5xx / dropped socket names no refusal, and 「try again」 is
    // true of all three. Without this case the fix could have been 「replace the
    // sentence」 rather than 「tell the two causes apart」, and nothing would have
    // said so.
    await tester.pumpWidget(
      _host(offer: _refused(null), spy: _Spy(), locale: AppLocale.en),
    );
    final AppStrings s = AppStrings.of(AppLocale.en);
    expect(_text(tester, _reason), s.continuousEntryNoCeilingNote);
  });

  testWidgets('🔴 the two other named refusals get their own sentences', (
    WidgetTester tester,
  ) async {
    final AppStrings s = AppStrings.of(AppLocale.en);
    for (final (CloudSummaryRefusal refusal, String want) in <(
      CloudSummaryRefusal,
      String,
    )>[
      (CloudSummaryRefusal.accountRestricted, s.continuousEntryRestrictedNote),
      (CloudSummaryRefusal.authExpired, s.continuousEntrySessionExpiredNote),
    ]) {
      await tester.pumpWidget(
        _host(offer: _refused(refusal), spy: _Spy(), locale: AppLocale.en),
      );
      expect(_text(tester, _reason), want, reason: '$refusal');
    }
  });

  testWidgets('🔴 none of the three is clipped, in any of the nine locales', (
    WidgetTester tester,
  ) async {
    // Same ruler and same one-way conservatism as the A-2 locale sweep above:
    // Ahem's full-em glyphs mean 「fits here」 implies 「fits on a device」, and
    // the converse does not hold. These three sentences are the longest in the
    // sub-line's vocabulary, which is exactly why they get their own sweep —
    // 0.2.53 was a sentence that fitted everywhere except where it was shown.
    for (final CloudSummaryRefusal refusal in CloudSummaryRefusal.values) {
      for (final AppLocale locale in AppLocale.values) {
        await tester.pumpWidget(
          _host(offer: _refused(refusal), spy: _Spy(), locale: locale),
        );
        await tester.pumpAndSettle();
        expect(
          tester.renderObject<RenderParagraph>(_reason).didExceedMaxLines,
          isFalse,
          reason: '$locale / $refusal: the sentence explaining why this control '
              'is dead was itself cut off — 0.2.53, verbatim',
        );
      }
    }
  });

}
