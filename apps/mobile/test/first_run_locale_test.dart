// U1 — the one-time first-run language question (phone). Mechanism tests.
//
// What this file has to prove, in the card's own words:
//   ① the picker FIRES for a new install and NEVER for an existing user (a
//      never-fires façade and a nag loop are both failures);
//   ② the answer goes to the SAME setting the settings row writes, and takes
//      effect immediately;
//   ③ 🔴 the no-OS-locale red line still holds — asking a human once is not
//      inferring from the environment.
//
// ⚠️ THE MEASUREMENT THIS FILE IS BUILT ON (stated so the next reader does not
// have to re-derive it): neither `flowmic.pref.locale` nor its desktop twin is
// ever written eagerly — `setLocale` is its only writer and it runs on an
// explicit user change. So「the language key is missing」is true for a brand-new
// install AND for every existing user who never opened the language row: those
// two populations are byte-for-byte identical on that signal, and they must go
// opposite ways. The witness that separates them is the REST of the profile,
// and the key used below to stand for「an existing user」is the real one:
// `flowmic.timeline.migrated.sqlite.v1`, which timeline_sqlite.dart stamps on
// the first boot of every install — including a fresh one, which is exactly why
// the resolution has to happen in load(), before that write.

import 'dart:io';

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/first_run_locale_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/legibility.dart';

/// The witness of an install that has booted before — the real key, not a
/// stand-in. See the file header.
const String kExistingUserWitness = 'flowmic.timeline.migrated.sqlite.v1';
const String kPromptKey = 'flowmic.pref.locale_prompt';
const String kLocaleKey = 'flowmic.pref.locale';

/// One "boot": a fresh controller over the prefs as they stand right now.
Future<AppSettingsController> boot(SharedPreferences prefs) async {
  final AppSettingsController c = AppSettingsController(prefs: prefs);
  await c.load();
  return c;
}

Future<SharedPreferences> prefsWith(Map<String, Object> initial) async {
  SharedPreferences.setMockInitialValues(initial);
  return SharedPreferences.getInstance();
}

void main() {
  group('U1 — when the first-run question may be asked', () {
    test('NEW INSTALL: nothing stored at all → asks, and the ask is recorded',
        () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isTrue);
      expect(prefs.getString(kPromptKey), AppSettingsController.kPromptPending);
      // The app behind the question is still the documented default — the
      // picker does not pre-answer anything.
      expect(c.locale, AppLocale.en);
      expect(prefs.getString(kLocaleKey), isNull);
    });

    test('🔴 EXISTING USER who never opened the language row → never asked, '
        'and their language is left exactly as it was', () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{
        kExistingUserWitness: true,
      });
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isFalse);
      expect(prefs.getString(kPromptKey), AppSettingsController.kPromptSettled);
      // Grandfathering writes the PROMPT key, never the LOCALE key: the status
      // quo (implicit default, now English) is preserved, not re-declared as a
      // choice they never made.
      expect(prefs.getString(kLocaleKey), isNull);
      expect(c.locale, AppLocale.en);
    });

    test('EXISTING USER with an explicit choice → never asked, choice kept',
        () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{
        kExistingUserWitness: true,
        kLocaleKey: 'ja',
      });
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isFalse);
      expect(c.locale, AppLocale.ja);
    });

    test('any other flowmic pref is enough of a witness (send policy alone)',
        () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{
        'flowmic.compose.send_policy': 'manual',
      });
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isFalse);
    });

    test('the marker itself is not mistaken for prior state', () async {
      // Otherwise the very act of recording「we asked」would make the next boot
      // read the profile as an upgrade and drop the question on the floor.
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController first = await boot(prefs);
      addTearDown(first.dispose);
      expect(first.needsLocaleChoice, isTrue);
      // Nothing else was written; only the marker exists now.
      expect(prefs.getKeys(), <String>{kPromptKey});
      final AppSettingsController second = await boot(prefs);
      addTearDown(second.dispose);
      expect(second.needsLocaleChoice, isTrue);
    });

    test('asked ONCE: a settled install is never asked again, however many '
        'boots', () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController first = await boot(prefs);
      addTearDown(first.dispose);
      first.chooseLocale(AppLocale.ko);
      for (int i = 0; i < 3; i++) {
        final AppSettingsController later = await boot(prefs);
        addTearDown(later.dispose);
        expect(later.needsLocaleChoice, isFalse, reason: 'boot #${i + 2}');
        expect(later.locale, AppLocale.ko);
      }
    });

    test('killed mid-question → asked again next boot (pending ≠ settled)',
        () async {
      // Without this branch: first boot shows the picker → the user kills the
      // app → that boot has already stamped the timeline flag → the next boot
      // reads the profile as an upgrade → a new install is stranded in a
      // language nobody chose.
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController first = await boot(prefs);
      addTearDown(first.dispose);
      expect(first.needsLocaleChoice, isTrue);
      await prefs.setBool(kExistingUserWitness, true); // the boot got this far
      final AppSettingsController second = await boot(prefs);
      addTearDown(second.dispose);
      expect(second.needsLocaleChoice, isTrue);
    });
  });

  group('U1 — the answer is the same setting the settings row writes', () {
    test('chooseLocale writes flowmic.pref.locale — the same key setLocale does',
        () async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      c.chooseLocale(AppLocale.en);
      expect(prefs.getString(kLocaleKey), 'en');
      expect(prefs.getString(kPromptKey), AppSettingsController.kPromptSettled);
      expect(c.locale, AppLocale.en);
      expect(c.needsLocaleChoice, isFalse);
      // Positive control: the settings row's writer lands in the same slot, so
      // there is exactly one answer to「which language is the UI」and the two surfaces can
      // never disagree.
      c.setLocale(AppLocale.ja);
      expect(prefs.getString(kLocaleKey), 'ja');
      final AppSettingsController next = await boot(prefs);
      addTearDown(next.dispose);
      expect(next.locale, AppLocale.ja);
      expect(next.needsLocaleChoice, isFalse);
    });

    test('🔴 choosing English — the DEFAULT — still settles the question',
        () async {
      // The trap this second key exists for: setLocale returns early when the
      // value is unchanged, so picking the default writes NOTHING through it.
      // A picker gated on「is the language key present」would come back forever.
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isTrue);
      c.chooseLocale(AppLocale.en);
      expect(c.needsLocaleChoice, isFalse);
      final AppSettingsController next = await boot(prefs);
      addTearDown(next.dispose);
      expect(next.needsLocaleChoice, isFalse);
      expect(next.locale, AppLocale.en);
    });
  });

  group('U1 — what the user actually sees', () {
    testWidgets('renders all four languages in their own script, with nothing '
        'pre-selected, and nothing clipped on a 360dp phone',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 720);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(home: FirstRunLocalePage(appSettings: c)),
      );

      // The endonyms — the point of the screen: readable without already
      // knowing the UI language.
      for (final String name in <String>['中文', 'English', '日本語', '한국어']) {
        expect(find.text(name), findsOneWidget, reason: name);
      }
      // …and the word「language」in each of the four, so the screen says what it
      // is asking in every language it offers. Straight from the existing
      // catalogue — no new key was invented for this screen.
      for (final AppLocale l in AppLocale.values) {
        expect(find.text(AppStrings.of(l).uiLanguage), findsOneWidget);
      }

      // 🔴 RENDERED RESULT, not Text.data: the readability claim is「the user
      // can read the option」, and 15 册's lesson is that a Text whose data is
      // right can still be three dots on screen. Assert on the laid-out box.
      //
      // 🔴 CORRECTED 2026-08-07 (W5a adversarial review P1-1, measured). What
      // stood here asserted the right INTENT with two readings that cannot fail:
      //   · `didExceedMaxLines` — `first_run_locale_page.dart` never sets
      //     `maxLines` (grep: zero hits), and that getter is always false
      //     without one;
      //   · `size.width <= constraints.maxWidth` — `RenderParagraph` sets
      //     `size = constraints.constrain(textSize)`, so that inequality holds
      //     BY CONSTRUCTION, for every paragraph, always.
      // Two assertions, both permanently green, guarding nothing. They now go
      // through `support/legibility.dart`, which picks its criterion from the
      // paragraph's own structure — and `size.width > 0` is kept, because a
      // paragraph that rendered nothing would satisfy anything else here.
      for (final String name in <String>['中文', 'English', '日本語', '한국어']) {
        final Finder f = find.text(name);
        expectLegible(tester, f, reason: name);
        expect(tester.getSize(f).width, greaterThan(0), reason: name);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('a tap IS the choice: it writes the one language key and the '
        'app is in that language on the next frame — no restart',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);

      // A host shaped like main.dart's gate: the picker while the question is
      // owed, the app afterwards, rebuilt by the controller's own notification.
      await tester.pumpWidget(
        MaterialApp(
          home: ListenableBuilder(
            listenable: c,
            builder: (BuildContext context, Widget? child) =>
                c.needsLocaleChoice
                    ? FirstRunLocalePage(appSettings: c)
                    : Scaffold(
                        body: Center(
                          child: Text(AppStrings.of(c.locale).settingsTitle),
                        ),
                      ),
          ),
        ),
      );
      expect(find.text('한국어'), findsOneWidget);

      await tester.tap(find.text('한국어'));
      await tester.pumpAndSettle();

      // The setting: the same key the settings row writes.
      expect(prefs.getString(kLocaleKey), 'ko');
      expect(prefs.getString(kPromptKey), AppSettingsController.kPromptSettled);
      // Immediately: the question is gone and the app behind it is Korean.
      expect(find.text('한국어'), findsNothing);
      expect(find.text('설정'), findsOneWidget); // ko settingsTitle
      expect(find.text('设置'), findsNothing); // …and not the zh default
    });
  });

  group('U1 — 🔴 the no-OS-locale red line still holds', () {
    testWidgets('a ja/zh OS with nothing stored gets ASKED, not answered: the '
        'UI behind the question is still the English default and nothing is pre-selected',
        (WidgetTester tester) async {
      // The trap cases: an OS whose language the app DOES support, and that is
      // NOT the default. Stubbing to en-US after the default flipped to English
      // would go green even if the code started reading the platform locale.
      tester.platformDispatcher.localeTestValue = const Locale('ja', 'JP');
      addTearDown(tester.platformDispatcher.clearLocaleTestValue);

      final SharedPreferences prefs = await prefsWith(<String, Object>{});
      final AppSettingsController c = await boot(prefs);
      addTearDown(c.dispose);

      expect(c.needsLocaleChoice, isTrue); // asked
      expect(c.locale, AppLocale.en); // not answered for them
      expect(prefs.getString(kLocaleKey), isNull);

      await tester.pumpWidget(
        MaterialApp(home: FirstRunLocalePage(appSettings: c)),
      );
      // All four rows are offered flat — none is marked as the OS's.
      for (final String name in <String>['中文', 'English', '日本語', '한국어']) {
        expect(find.text(name), findsOneWidget);
      }

      // A mid-session OS flip changes nothing either: there is no OS-locale
      // listener anywhere in the language path (the THEME may follow the OS;
      // the language may NOT — two deliberately different rulings).
      tester.platformDispatcher.localeTestValue = const Locale('zh', 'CN');
      await tester.pumpAndSettle();
      expect(c.locale, AppLocale.en);
      expect(c.needsLocaleChoice, isTrue);
    });

    test('structural: the first-run path contains no platform-locale probe',
        () async {
      // The runtime case above proves today; this anchors tomorrow — a future
      // 「helpfully pre-select the row matching the phone's language」 turns this
      // red before it can ship. Same guard shape as the desktop's
      // first-run-locale.test.ts.
      //
      // 🔴 P-7 (W5a): THIS LIST IS THE GUARD'S ENTIRE FIELD OF VIEW, so anything
      // that JOINS the first-run path has to join the list on the same day.
      // Otherwise the guard keeps passing while the thing it guards grows — a
      // green check whose coverage silently shrank, which reads exactly like a
      // green check whose subject is safe. The onboarding screens below now run
      // between the language question and the instance list; they are prose
      // about how to use the app, which is precisely the kind of screen somebody
      // would later be tempted to 「helpfully」 localise off the OS.
      const List<String> sources = <String>[
        'lib/src/ui/first_run_locale_page.dart',
        'lib/src/settings/app_settings.dart',
        'lib/src/ui/onboarding/first_run_onboarding_page.dart',
        'lib/src/ui/onboarding/onboarding_view.dart',
        'lib/src/ui/onboarding/onboarding_art.dart',
      ];
      for (final String path in sources) {
        final String src = await File(path).readAsString();
        expect(src, isNot(contains('PlatformDispatcher.instance.locale')),
            reason: path);
        expect(src, isNot(contains('Platform.localeName')), reason: path);
        expect(src, isNot(contains('Localizations.localeOf')), reason: path);
        expect(src, isNot(contains('window.locale')), reason: path);
      }
    });
  });
}
