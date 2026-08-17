// GA-01 (widget half) — the translate target chip beside the mode chip.
//
// SPEC-REF: docs/ui-design/REDESIGN-PLAN.md D4 ("choose in place with translate mode");
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01 ruling 2.
//
// WP3 C12 (2026-08-18): the chip's tap is a PICKER SHEET now, not a two-value
// cycle — the cycle's own rationale (「two languages is not a list」) ended when
// owner grew the targets to nine. This file was rewritten with it; the old
// cycle assertions would pass against a broken sheet and fail against the
// working one.
//
// Fake callbacks only — the controller/wire half is covered by
// utterance_compose_test.dart's plain `test()`s (the real PTT chain deadlocks
// inside testWidgets' FakeAsync zone).

import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, appLocaleForLanguageTag;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart' show kTranslateTargets;
import 'package:flowmic/src/ui/mode_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();

Widget _host(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  testWidgets('shows the current target as its endonym, and tapping opens the '
      'nine-row picker', (WidgetTester tester) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'en', strings: _zh, onTap: picked.add)),
    );
    expect(find.text('→ English'), findsOneWidget);

    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    // The sheet titles itself — nine language names with no question would
    // read as a UI-language picker (WP3 §0's conflation).
    expect(find.text(_zh.translateTargetSheetTitle), findsOneWidget);
    for (final String tag in kTranslateTargets) {
      expect(find.text(_zh.translateTargetRowLabel(tag)), findsOneWidget,
          reason: 'row for $tag missing');
    }
    expect(picked, isEmpty, reason: 'opening the sheet chooses nothing');
  });

  testWidgets('choosing a row hands that tag to onTap — including the two '
      'Chinese targets as distinct rows', (WidgetTester tester) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'en', strings: _zh, onTap: picked.add)),
    );
    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.translateTargetRowLabel('zh-TW')));
    await tester.pumpAndSettle();
    expect(picked, <String>['zh-TW'],
        reason: 'Traditional is its own value, never folded into zh');

    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    // ru is the ninth row — below the sheet's half-screen cap, reachable by
    // the sheet's own scroll (the same measured reason the sheet scrolls).
    final Finder ruRow = find.text(_zh.translateTargetRowLabel('ru'));
    await tester.scrollUntilVisible(ruRow, 80);
    await tester.pumpAndSettle();
    await tester.tap(ruRow);
    await tester.pumpAndSettle();
    expect(picked.last, 'ru');
  });

  testWidgets('dismissing the sheet without a choice changes nothing', (
    WidgetTester tester,
  ) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'en', strings: _zh, onTap: picked.add)),
    );
    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    // Tap the barrier above the sheet.
    await tester.tapAt(const Offset(400, 20));
    await tester.pumpAndSettle();
    expect(picked, isEmpty);
    expect(find.text(_zh.translateTargetSheetTitle), findsNothing);
  });

  testWidgets('an unknown stored tag still renders (verbatim, uppercased) and '
      'the picker still opens', (WidgetTester tester) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'tlh', strings: _zh, onTap: picked.add)),
    );
    // Never a blank chip: a tag outside the offered set is shown verbatim
    // rather than silently rendering nothing.
    expect(find.text('→ TLH'), findsOneWidget);
    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.translateTargetRowLabel('en')));
    await tester.pumpAndSettle();
    expect(picked.single, 'en');
  });

  testWidgets('goes inert while an utterance is being transformed', (
    WidgetTester tester,
  ) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(
        TranslateTargetChip(
          target: 'en',
          strings: _zh,
          enabled: false,
          onTap: picked.add,
        ),
      ),
    );
    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    // Re-aiming mid-flight would say nothing about the sentence already in the
    // air, so the tap must not pretend to have done something.
    expect(picked, isEmpty);
    expect(find.text(_zh.translateTargetSheetTitle), findsNothing);
  });

  testWidgets('0.2.53 law — every row of the sheet renders un-clipped at 360dp '
      '(row labels are endonym+tag, locale-invariant)', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(360 * 3, 800 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'zh-TW', strings: _zh, onTap: (_) {})),
    );
    await tester.tap(find.byType(TranslateTargetChip));
    await tester.pumpAndSettle();
    for (final String tag in kTranslateTargets) {
      final Finder row = find.text(_zh.translateTargetRowLabel(tag));
      await tester.scrollUntilVisible(row, 80);
      await tester.pumpAndSettle();
      expect(row, findsOneWidget, reason: 'row for $tag did not render');
      expect(
        tester.renderObject<RenderParagraph>(row).didExceedMaxLines,
        isFalse,
        reason: 'row label for $tag was eaten by an ellipsis at 360dp',
      );
      // Every offered target must resolve to a REAL endonym row — a picker row
      // showing a bare code would mean the tag has no registry entry to name it.
      expect(appLocaleForLanguageTag(tag), isNotNull,
          reason: '$tag has no AppLocale row');
    }
    // The current one is marked — nine names with no current marker leaves the
    // user to remember what they chose.
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    expect(appLocaleForLanguageTag('zh-TW'), AppLocale.zhTw);
  });
}
