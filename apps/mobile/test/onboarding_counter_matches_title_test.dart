// FR-M3 — the quick guide's page counter must not contradict the title on the
// same page.
//
// SPEC-REF: docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2.2 (the
// 2026-11-06 correction block); apps/mobile/lib/src/ui/onboarding/onboarding_view.dart
// `_dots`.
//
// 🔴 THE COUNTER IS NOT ON SCREEN. The three dots are all a sighted reader gets
// (flowmic-0.3.120-android-guide-2-install-desktop-en.png shows dots and nothing
// else); `onboardingStepOf` is their screen-reader label. So the contradiction
// this card was raised on — title 「Step 1」 under a counter 「Step 2 of 3」 —
// exists for TalkBack users only, and only a semantics read can see it. A test on
// `Text.data` would have been green while the defect stood.
//
// The titles keep their own 「Step 1 / Step 2」 numbering: those count what the
// user has to DO (page 1 asks for nothing). The counter counts PAGES. Two numbers
// are both true as long as they do not use the same word.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/onboarding/first_run_onboarding_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The word a locale's page titles use for 「step」, read off the titles themselves
/// so that a new language needs no edit here (verify:lint i18n-add-locale-cost): the
/// longest run the two numbered titles share, earliest first, cut down to its letters.
String _stepWordOf(AppStrings s) {
  final String a = s.onboardingInstallTitle;
  final String b = s.onboardingPairTitle;
  String best = '';
  for (int i = 0; i < a.length; i++) {
    for (int j = a.length; j > i + best.length; j--) {
      if (b.contains(a.substring(i, j))) {
        best = a.substring(i, j);
        break;
      }
    }
  }
  return RegExp(r'\p{L}+', unicode: true).firstMatch(best)?.group(0) ?? '';
}

void main() {
  test('the ruler: it finds the real word where it can be checked by eye, and a word '
      'in every language', () {
    expect(_stepWordOf(AppStrings.of(AppLocale.en)), 'Step');
    for (final AppLocale locale in AppLocale.values) {
      expect(_stepWordOf(AppStrings.of(locale)), isNotEmpty, reason: locale.name);
    }
  });

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('${locale.name}: the counter read out on each guide page is a '
        'page count and never uses the title\'s word for step',
        (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController c = AppSettingsController(prefs: prefs);
      addTearDown(c.dispose);
      await c.load();
      c.setLocale(locale);
      final AppStrings s = AppStrings.of(locale);

      await tester.pumpWidget(
        MaterialApp(home: FirstRunOnboardingPage(appSettings: c)),
      );
      await tester.pumpAndSettle();

      final String word = _stepWordOf(s);
      final List<String> titles = <String>[
        s.onboardingWhatTitle,
        s.onboardingInstallTitle,
        s.onboardingPairTitle,
      ];
      for (int page = 1; page <= 3; page++) {
        // On the REAL page: the title is the one the user is on, and the label
        // is found through the semantics tree the screen reader reads.
        expect(find.text(titles[page - 1]), findsOneWidget,
            reason: 'the walk is not on page $page');
        final String counter = s.onboardingStepOf(page, 3);
        expect(find.bySemanticsLabel(counter), findsOneWidget,
            reason: 'the dots are not announcing $counter');
        expect(counter, contains('$page'));
        expect(counter, contains('3'));
        expect(counter, isNot(contains(word)),
            reason: 'page $page reads out 「$counter」 beside a title that '
                'counts steps: 「${titles[page - 1]}」');
        if (page > 1) {
          // Positive control: the word really is the title's, so the negative
          // above is measuring something.
          expect(titles[page - 1], contains(word));
          // Page 2 is 「Step 1」: this is the contradiction the card was raised
          // on, kept reachable so the two numbers staying different is visible.
          expect(page - 1, isNot(page));
        }
        if (page < 3) {
          await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
          await tester.pumpAndSettle();
        }
      }
      expect(tester.takeException(), isNull);
      semantics.dispose();
    });
  }
}
