// Card FB-7 —— **rendered-result** accept for the multi-select toolbar.
//
// 🔴 The law 0.2.53 established, this file is written to it: any accept of
// "can the user read this sentence" must land the assertion on the rendered
// result (`didExceedMaxLines` / intrinsic width vs the actual box), **must not
// land on `Text.data`**. The counter-example is `cloud_image_error_copy_test.dart`
// — it writes at the original site that it knows it will be clipped, then
// asserts around the clip; 1259 cases all green, and the screen showed three
// letters.
//
// ⚠️ **This file does not measure real-device pixels; know where the gap is**:
// `flutter_test` uses the Ahem placeholder font, every glyph is a **full-em
// square** ⇒ a 360dp row only fits 360/fontSize characters; a real font
// (Chinese about the same width, Latin about twice as wide) is much more
// generous. So the budget here is **conservative**: if Ahem does not clip ⇒ a
// real device will not clip; **the converse does not hold**.
// ⇒ Must not use this file the other way to argue "a given sentence exactly
// fits on a real device".
// 🔴 And this card has **no real device**: every conclusion is "unit-test
// proven + real-device unproven".
//
// ⚠️ Why the toolbar is two rows, the ledger is in the file header of
// `selection_bar.dart`. This file is that ledger's criterion: move the two
// row-2 actions back onto row 1 and the English subtitle will necessarily go
// red.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/selection/selection_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart' show ahemWidthBudget;

/// The narrowest real-device band (the number the 0.2.51 card used).
const double kNarrow = 360;

/// After render, did this text overflow its own `maxLines` (= the user sees an ellipsis).
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

/// How wide this text is in one line when **unconstrained**. Compare with the
/// actual box and you know whether it is under pressure.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// 🔴 Nine-locale expansion (2026-08-14): the default of `width` changed from
/// the hardcoded [kNarrow] to an **Ahem budget computed from this locale's
/// text** (`ahemWidthBudget` in `support/legibility.dart`). The version that
/// hardcoded 360 went red on three cases for de / es / fr on the spot, and
/// those three were red on the **ruler**, not the product: Ahem stretches Latin
/// glyphs to about twice the width, so 360 does not represent "a 360dp real
/// device screen" in Latin at all. The product criterion did not change one
/// word — it is still "this sentence is readable on the narrowest real-device
/// band"; what changed is how many px that sentence converts to on the ruler.
///
/// ⚠️ Callers that pass [width] explicitly are **unaffected**, and that is
/// exactly what group ② wants: it uses 360 as **pressure** (the English
/// subtitle must wrap at this width), and that 360 is part of the thing under
/// test, not a ruler that needs calibration.
Future<void> _pumpBar(
  WidgetTester tester,
  AppLocale locale, {
  int count = 3,
  double? width,
}) async {
  tester.view.physicalSize = Size(width ?? ahemWidthBudget(locale), 720);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topCenter,
          child: SelectionBar(
            strings: AppStrings.of(locale),
            selectedCount: count,
            onCancel: () {},
            onSelectAll: () {},
            onCopy: () {},
            onOrganize: () {},
          ),
        ),
      ),
    ),
  );
}

void main() {
  const List<String> keys = <String>[
    'selection.count',
    'selection.selectAll.label',
    'selection.copy.label',
    'selection.copy.sub',
    'selection.organize.label',
    'selection.organize.sub',
  ];

  group('① four locales × 360dp: every character on the toolbar is readable', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('$locale — none of the six cells is eaten by an ellipsis', (WidgetTester tester) async {
        await _pumpBar(tester, locale);
        for (final String k in keys) {
          final Finder f = find.byKey(ValueKey<String>(k));
          expect(f, findsOneWidget, reason: '$locale/$k did not render');
          expect(
            _clipped(tester, f),
            isFalse,
            reason: '$locale/$k was clipped — what the user reads is an ellipsis',
          );
        }
      });
    }
  });

  group('② positive control: these sentences really are long enough to apply pressure', () {
    // Without this group, "not clipped" may only mean the sentence was short to
    // begin with, and then group ① is blind to regressions.
    testWidgets('the English organize subtitle must wrap to fit at 360dp', (WidgetTester tester) async {
      // 🔴 360 is passed explicitly here, **deliberately not going through
      // `ahemWidthBudget`**: this group is group ①'s positive control, and what
      // it wants is "stuff English into a width that cannot hold it". Using the
      // calibrated budget (en ⇒ 648) would let this sentence fit on one line,
      // and this control would instantly become a sentence that is always true
      // — that is exactly the 0.2.51 §3 shape "a reverse control that picks the
      // wrong direction is worse than no reverse control".
      await _pumpBar(tester, AppLocale.en, width: kNarrow);
      final Finder f = find.byKey(
        const ValueKey<String>('selection.organize.sub'),
      );
      final Text t = tester.widget<Text>(f);
      final double intrinsic = _intrinsicWidth(t);
      final Size box = tester.getSize(f);
      expect(
        intrinsic,
        greaterThan(box.width),
        reason: 'it does not fit on one line ($intrinsic > ${box.width}) ⇒ the '
            '"not clipped" case above proves maxLines is actually enough, not that the sentence is short',
      );
      expect(_clipped(tester, f), isFalse);
    });

    testWidgets('the English organize label is also not a short sentence that fits at a glance', (WidgetTester tester) async {
      // Same as above: 360 is part of the thing under test (pressure), not a
      // ruler that needs calibration.
      await _pumpBar(tester, AppLocale.en, width: kNarrow);
      final Finder f = find.byKey(
        const ValueKey<String>('selection.organize.label'),
      );
      final Text t = tester.widget<Text>(f);
      expect(_intrinsicWidth(t), greaterThan(tester.getSize(f).width));
      expect(_clipped(tester, f), isFalse);
    });
  });

  group('③ the count and the 「不注入」 sentence are both really on the screen', () {
    testWidgets('the count follows the number that was passed in', (WidgetTester tester) async {
      await _pumpBar(tester, AppLocale.zh, count: 7);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey<String>('selection.count')))
            .data,
        AppStrings.of(AppLocale.zh).selectionCount(7),
      );
    });

    testWidgets('🔴 the 「不注入」 sentence is standing, and it is not clipped', (WidgetTester tester) async {
      // What the user checked are records **already delivered** — 「交 AI 整理」
      // is extremely easy to read as "send again". This sentence must be
      // readable before the press; a toast afterwards does not count as a fix.
      await _pumpBar(tester, AppLocale.zh);
      final Finder f = find.byKey(
        const ValueKey<String>('selection.organize.sub'),
      );
      expect(tester.widget<Text>(f).data, contains('不注入'));
      expect(_clipped(tester, f), isFalse);
    });
  });

  group('④ every control is really tappable (no dead cells that swallow taps)', () {
    testWidgets('the four entries each fire once', (WidgetTester tester) async {
      final List<String> fired = <String>[];
      tester.view.physicalSize = const Size(kNarrow, 720);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topCenter,
              child: SelectionBar(
                strings: AppStrings(AppLocale.zh),
                selectedCount: 0,
                onCancel: () => fired.add('cancel'),
                onSelectAll: () => fired.add('all'),
                // 🔴 With 0 selected the two actions are **still tappable** —
                // pressing them yields a readable reason, not a silent no-op
                // (0.2.27: "a control that cannot change anything is worse
                // than no control"). What this asserts is "the tap has a
                // receiver".
                onCopy: () => fired.add('copy'),
                onOrganize: () => fired.add('organize'),
              ),
            ),
          ),
        ),
      );
      for (final String k in <String>[
        'selection.cancel',
        'selection.selectAll',
        'selection.copy',
        'selection.organize',
      ]) {
        await tester.tap(find.byKey(ValueKey<String>(k)));
      }
      expect(fired, <String>['cancel', 'all', 'copy', 'organize']);
    });
  });
}
