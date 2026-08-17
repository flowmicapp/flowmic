// 🔴 P-7 first-run onboarding (3 pages · skippable · reviewable) — mechanism test.
//
// Source: `docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md` §2 / §6.
//
// ── What this file must prove ──────────────────────────────────────────────
// ① 🔴 **It did not break U1**: a brand-new install is still asked for
//    language first, **then** sees the guide;
// ② 🔴 The guide appears only for a brand-new install, never for an upgrade;
// ③ 🔴 The marker is written **only at the moment of finish/skip**, not one
//    byte at boot;
// ④ Finish / skip land in the same place; a restart does not show it again;
// ⑤ Three pages can be flipped; buttons are where they should be;
// ⑥ The settings-page row really can pop the guide (wiring, not 「the
//    widget was written」);
// ⑦ Reviewing **does not change** the fact of 「whether first-run was seen」;
// ⑧ All four languages are complete, and long sentences are readable on
//    the narrowest screen (assert the rendered result, not Text.data).
//
// ── 🔴 WHAT PROTECTS THE TWO FIRST-RUN GATES, AND WHICH HALF THIS FILE PINS ──
// `AppSettingsController._resolveFirstRunPrompt` has a SIDE EFFECT: it WRITES
// `flowmic.pref.locale_prompt`. Both first-run gates lean on the same witness —
// 「does this device already hold any OTHER `flowmic.*` pref」— so that write is
// the thing that could poison the other gate. THREE independent defences stand
// between that write and a broken first run, and any ONE of them alone suffices:
//   ① `_resolveFirstRunOnboarding()` is called FIRST, before the key is written;
//   ② `_firstRunMarkers` excludes `_kLocalePrompt` from the witness set;
//   ③ `_resolveFirstRunOnboarding` treats `kPromptPending` as 「this install's
//      first boot has not finished yet」.
//
// 🔴 WHICH OF THE THREE THIS FILE ACTUALLY PINS — MEASURED 2026-08-07 (W5a fix
// lane B) by deleting each defence in turn and running
// `flutter test test/first_run_locale_test.dart test/onboarding_first_run_test.dart
//  --timeout 90s`, verdict taken from the EXIT CODE, not from reading output:
//   ① swap the two lines in `load()` ⇒ **exit 0, all 30 GREEN**. Not pinned by
//      anything, and not load-bearing today: on a genuinely fresh install the
//      prompt gate writes `pending`, and ③ then answers the very question the
//      ordering would have answered ⇒ nothing observable changes. (The same
//      swap also leaves `first_run_locale_test.dart` green.)
//   ② drop `_kLocalePrompt` from `_firstRunMarkers` ⇒ **5 red** (④×3, ⑤, ⑧):
//      those groups seed a profile whose ONLY pref is the prompt marker, so
//      without the exclusion it reads as an upgrade and the guide never renders.
//   ③ delete the `kPromptPending` clause ⇒ **1 red**, ③ group 「killed on the
//      language page ⇒ next boot still owes both questions」, verbatim:
//        Expected: true
//          Actual: <false>
//        语言都还没选完，引导就已经被判成「升级安装不用看」了
// ⇒ HONEST STATEMENT: this file pins ② and ③. It does NOT pin ①, and nothing
//   else does either — `grep -rln "needsOnboarding\|needsLocaleChoice" test/`
//   returns exactly this file and `first_run_locale_test.dart`.
//
// 🔴 WHY THIS BLOCK IS WORDED LIKE THIS — the version it replaces was the exact
// defect this window's own headline law names. It read, verbatim:
//   「🔴 **反向对照（实测执行，见报告）**：把 `load()` 里那两行的顺序对调
//    （引导闸挪到语言闸后面），① 组的「全新安装两问都要出现」当场见红。
//    还原后复绿，残留串 grep = 0。」
// That red was never obtained. The production comment added in the SAME commit
// (`app_settings.dart`, inside `load()`: 「本轮做反向对照时把这两行**对调**，
// `onboarding_first_run_test.dart` **一条都没红**」) said the opposite, and the
// production comment is the true one — re-measured above, twice, by exit code.
// A reverse control that claims a red it never got is WORSE than no reverse
// control: it certifies a mechanism nobody checked, and the next reader sees
// 「pinned」 where nothing is pinned. Anti-façade ④ turned on this very file — an
// assertion about behaviour elsewhere must carry a greppable anchor or be
// nailed by a test; ① carries neither, so it is written down as UNPINNED
// instead of as proved.
//
// ⚠️ ① is still worth KEEPING in production, for the weaker but true reason
// `app_settings.dart` states: it is the only one of the three that does not
// depend on a second mechanism staying right. That is defence in depth, not a
// pinned contract, and this file must not pretend otherwise.
//
// ⚠️ DO NOT borrow U1's evidence for it — that is what the old header did.
// `main.dart` calling `load()` BEFORE `openTimelinePersistence` IS load-bearing
// and IS pinned (`first_run_locale_test.dart` runs the profile with
// `flowmic.timeline.migrated.sqlite.v1` already present). The ordering INSIDE
// `load()` is a DIFFERENT claim about a different pair of lines and inherits
// none of that proof. U1's own words, quoted only as the thing this file must
// not be confused with:
//   「🔴 U1 — THIS CALL'S POSITION IS PART OF A MECHANISM, not just an ordering
//    habit. load() also resolves「does this install still owe the user the
//    first-run language question?」, and its signal for「brand-new install」is
//    「no flowmic.* pref exists yet」. That is only true BEFORE this boot writes
//    any of its own …… Move this line under that one and every install reads as
//    an upgrade ⇒ the picker never fires.」
//
// ⚠️ **Ruler**: `flutter_test` uses the Ahem placeholder font; every glyph is
// a full-em square, much wider than a real font ⇒ 「not clipped under Ahem ⇒
// will not be clipped on a real device」holds, **the converse does not**.
// Group ⑧ answers only the 「will it be clipped」direction; do not use it to
// argue 「it happens to fit on a real device」.
//
// 🔴 **⑧'s instrument was swapped once on 2026-08-07 (W5a adversarial
// review P1-1, [measured])**: the original was
// `expect(p.didExceedMaxLines, isFalse)`, but in `onboarding_view.dart`
// `maxLines` **appears only in a comment**, never set in the body ⇒ that
// reading is **always false**, and ⑧ is structurally unable to go red.
// It now goes through `support/legibility.dart`: read `didExceedMaxLines`
// only when maxLines is set; otherwise assert 「why it cannot be clipped」.
// **That production comment was corrected in place the same day.**
//
// 🔴 THE REVERSE CONTROLS IN THIS FILE THAT ARE REAL, and what each controls FOR:
//   · ② and ③ above — each one measured red, each red quoted verbatim, both
//     restored afterwards (`git status` on `app_settings.dart` clean, leftover
//     string grep = 0), both files green again.
//   · ⑥ below — delete the production row `settings.openGuide` from
//     `settings_preferences.dart` and ⑥ fails AT THE TAP. Measured in the same
//     session; the red is quoted at that test. Before this window ⑥ built a
//     `TextButton` of its own and tapped that, so the production row had ZERO
//     references anywhere in `test/` and could be deleted with the suite green.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/first_run_locale_page.dart';
import 'package:flowmic/src/ui/onboarding/first_run_onboarding_page.dart';
import 'package:flowmic/src/ui/onboarding/onboarding_view.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

/// Same witness as `first_run_locale_test.dart` — the real key, not a stand-in:
/// `timeline_sqlite.dart` stamps it on the **first** boot of **every** install
/// (including a brand-new one, which is exactly why both gates must resolve
/// before it).
const String kExistingUserWitness = 'flowmic.timeline.migrated.sqlite.v1';
const String kPromptKey = 'flowmic.pref.locale_prompt';
const String kLocaleKey = 'flowmic.pref.locale';
const String kOnboardingKey = 'flowmic.pref.onboarding_seen';

Future<SharedPreferences> _prefsWith(Map<String, Object> initial) async {
  SharedPreferences.setMockInitialValues(initial);
  return SharedPreferences.getInstance();
}

/// One 「boot」: build a fresh controller from the prefs of this moment and load.
Future<AppSettingsController> _boot(SharedPreferences prefs) async {
  final AppSettingsController c = AppSettingsController(prefs: prefs);
  await c.load();
  return c;
}

/// A REAL [SettingsPage] with the nine controllers it demands, all faked.
///
/// 🔴 WHY THIS EXISTS. The version of ⑥ that this replaces built a `TextButton`
/// of its own and tapped THAT, with a comment explaining that pumping the whole
/// page would need「9 个真控制器」. The consequence was measured by this window's
/// adversarial audit: `settings.openGuide` had ZERO references anywhere under
/// `test/`, so **deleting the production row made owner ruling 7-2 disappear
/// with the entire suite still green** — the very shape 0.2.51 and booklet 13 §7 F1 ①
/// are about (a lost call site leaves no new symbol to grep, only an absence).
/// The nine controllers turned out to be ~30 lines, copied from the rig in
/// `about_version_widget_test.dart`, which pumps this same page.
///
/// This window already did it the right way twice — `page_guides_test.dart` taps
/// the two real "?" entries on a real `ConnectionsPage`. So this was an
/// inconsistency between lanes, not a technical obstacle.
class _SettingsRig {
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ScenarioCardController scenario;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;
  late final AppSettingsController appSettings;

  /// [c] is owned by the caller (it is the controller under test); everything
  /// else is created and disposed here.
  static Future<_SettingsRig> create(AppSettingsController c) async {
    final _SettingsRig r = _SettingsRig();
    r.appSettings = c;
    r.settingsTransport = FakeSocketTransport();
    r.settingsClient = SettingsClient(
        transport: r.settingsTransport, roomJoins: ValueNotifier<int>(0));
    r.scenario = ScenarioCardController(
      settingsClient: r.settingsClient,
      cache: InMemoryScenarioCardCache(),
    );
    await r.scenario.load();
    r.session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.login = newTestLogin(transport: r.session.transport);
    r.destination = DestinationController();
    return r;
  }

  Widget widget() => MaterialApp(
    home: SettingsPage(
      scenario: scenario,
      appSettings: appSettings,
      login: login,
      destination: destination,
      session: session,
      portable: newTestPortableController(),
      inventory: newTestInventory(
        rows: const <TimelineEntry>[],
        images: InMemoryOutboxBlobStore(),
      ),
      timeline: newTestStore(),
      version: const FixedAppVersion('0.0.0-test'),
      update: newTestUpdateController(),
    ),
  );

  Future<void> dispose() async {
    await settingsClient.dispose();
    login.dispose();
    scenario.dispose();
    destination.dispose();
    await session.dispose();
    await settingsTransport.close();
  }
}

/// A viewport tall enough that the whole settings `ListView` is laid out, so the
/// About card at the bottom is really built. Same trick and same reason as
/// `about_version_widget_test.dart`'s `tallViewport`.
void _tallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 4200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

/// A host byte-identical in shape to `main.dart`'s `home:`: language page →
/// guide → the app body.
///
/// 🔴 It is the **carrier of the wiring criterion**: a test that only pumps
/// `OnboardingView` stays all-green if `main.dart` never wired this page at
/// all (the shape 0.2.51 stepped on). What is reproduced here is the ternary
/// branch itself.
/// [freshKey] is used to swap in a **brand-new** tree inside the same
/// `testWidgets`.
/// 🔴 Without a key Flutter reuses the element by type+position, and
/// `OnboardingView`'s `_step` continues from page 3 of the previous
/// iteration — measured this round: in the four-language loop zh was
/// green, en went red on a 「Found 0 widgets」, looking like missing copy
/// when it was the harness itself that did not reset.
/// (**Check your ruler first**: what is red is the instrument, not the
/// thing being measured.)
Widget _homeLikeMain(AppSettingsController c, {Object? freshKey}) => MaterialApp(
  key: freshKey == null ? null : ValueKey<Object>(freshKey),
  home: ListenableBuilder(
    listenable: c,
    builder: (BuildContext context, Widget? child) => c.needsLocaleChoice
        ? FirstRunLocalePage(appSettings: c)
        : c.needsOnboarding
            ? FirstRunOnboardingPage(appSettings: c)
            : child!,
    child: Scaffold(
      body: Center(
        child: Text(AppStrings.of(c.locale).settingsTitle),
      ),
    ),
  ),
);

void main() {
  // ── ① 🔴 Brand-new install: both questions must appear, order is
  // 「language → guide」 ───────────────────────────────────────────────────
  group('① brand-new install: both the language page and the guide page must appear; neither may eat the other', () {
    test('empty prefs ⇒ needsLocaleChoice and needsOnboarding are both true', () async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{});
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isTrue, reason: 'U1 was broken by this card');
      expect(c.needsOnboarding, isTrue, reason: 'the guide gate was eaten by the language gate\'s side effect');
    });

    testWidgets('🔴 the screen really is this order: four-language picker first, then immediately guide page 1',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{});
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(_homeLikeMain(c));

      // First screen: language.
      expect(find.text('한국어'), findsOneWidget);
      expect(find.byType(OnboardingView), findsNothing,
          reason: 'the guide jumped ahead of language ⇒ the user is reading a guide written in a language they never chose');

      await tester.tap(find.text('한국어'));
      await tester.pumpAndSettle();

      // Second screen: the guide, and already in Korean.
      expect(find.byType(OnboardingView), findsOneWidget);
      final AppStrings ko = AppStrings.of(AppLocale.ko);
      expect(find.text(ko.onboardingWhatTitle), findsOneWidget);
      // …and not the instance list (that screen only comes after the guide).
      expect(find.text(ko.settingsTitle), findsNothing);
    });
  });

  // ── ② Upgrade install: never appears even once ──────────────────────────
  group('② upgrade install: existing users must not be popped the guide', () {
    test('an existing flowmic.* pref ⇒ neither question is owed', () async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kExistingUserWitness: true,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsLocaleChoice, isFalse);
      expect(c.needsOnboarding, isFalse);
      // An existing user's prefs must not grow an onboarding marker: they
      // have not seen it, and must not be recorded as having seen it.
      // The basis of 「not owed」is the **witness**, not a stamp we put
      // on for them.
      expect(prefs.getString(kOnboardingKey), isNull);
      expect(prefs.getBool(kOnboardingKey), isNull);
    });

    test('even if that flowmic pref is an unrelated key like send policy, it still counts as a witness', () async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        'flowmic.compose.send_policy': 'manual',
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsOnboarding, isFalse);
    });
  });

  // ── ③ 🔴 The marker is written only on finish/skip, not one byte at boot ─
  group('③ the guide gate must not write anything at boot', () {
    test('after the first load of a brand-new install, prefs hold only the one key the language gate wrote', () async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{});
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      // 🔴 This case IS the red line itself: an extra kOnboardingKey ⇒
      // the next brand-new install's language gate will take it as a
      // witness ⇒ the first-run language page never appears.
      expect(prefs.getKeys(), <String>{kPromptKey});
    });

    test('killed on the language page ⇒ next boot still owes both questions', () async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{});
      final AppSettingsController first = await _boot(prefs);
      addTearDown(first.dispose);
      expect(first.needsOnboarding, isTrue);
      // That boot did reach the step that writes the migration flag
      // (in the real world it always will).
      await prefs.setBool(kExistingUserWitness, true);

      final AppSettingsController second = await _boot(prefs);
      addTearDown(second.dispose);
      expect(second.needsLocaleChoice, isTrue, reason: 'U1\'s pending branch');
      expect(
        second.needsOnboarding,
        isTrue,
        reason: 'language has not even been chosen yet, but the guide was already judged 「upgrade install, no need to see」',
      );
    });

    test('🔴 on the books: killed after language is chosen and before the guide is finished ⇒ the guide will not auto-appear again', () async {
      // This is not an 「expected behavior」case; it is a test that
      // **honestly books the fact**. Fixing it would require pre-writing
      // a pending marker early in boot, which is exactly the action the
      // U1 comment block forbids.
      // The cost is accepted because the window is narrow, and the
      // review entry in the settings-page About section is always there.
      // ⚠️ If someone 「fixes」it someday, this test will go red — what
      // to read then is this comment, not a changed assertion.
      final SharedPreferences prefs = await _prefsWith(<String, Object>{});
      final AppSettingsController first = await _boot(prefs);
      addTearDown(first.dispose);
      first.chooseLocale(AppLocale.ja); // language answered, guide not yet walked
      await prefs.setBool(kExistingUserWitness, true);

      final AppSettingsController second = await _boot(prefs);
      addTearDown(second.dispose);
      // Positive control: the language question really is settled
      // (otherwise this case is not measuring the situation it claims).
      expect(second.needsLocaleChoice, isFalse);
      expect(prefs.getString(kLocaleKey), 'ja');
      expect(
        second.needsOnboarding,
        isFalse,
        reason: 'the known-gap shape changed — read this test\'s comment before changing the assertion',
      );
    });
  });

  // ── ④ Finish / skip → the same place; a restart does not show it again ──
  group('④ one-shot: finish and skip have byte-identical consequences', () {
    testWidgets('skip ⇒ marker persisted, enter the app immediately, restart does not show it again',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kPromptKey: AppSettingsController.kPromptSettled,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      expect(c.needsOnboarding, isTrue);
      await tester.pumpWidget(_homeLikeMain(c));
      expect(find.byType(OnboardingView), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.skip')));
      await tester.pumpAndSettle();

      expect(prefs.getBool(kOnboardingKey), isTrue);
      expect(find.byType(OnboardingView), findsNothing);
      expect(find.text(AppStrings.of(c.locale).settingsTitle), findsOneWidget);

      final AppSettingsController next = await _boot(prefs);
      addTearDown(next.dispose);
      expect(next.needsOnboarding, isFalse);
    });

    testWidgets('finish three pages and tap 「开始使用」⇒ lands in the same place as skip',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kPromptKey: AppSettingsController.kPromptSettled,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(_homeLikeMain(c));

      final AppStrings s = AppStrings.of(c.locale);
      expect(find.text(s.onboardingWhatTitle), findsOneWidget);
      // Page 1 has no 「上一步」— it is not a disabled state; it is not
      // rendered at all.
      expect(find.byKey(const ValueKey<String>('onboarding.back')), findsNothing);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingInstallTitle), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('onboarding.back')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingPairTitle), findsOneWidget);
      // The last page's primary button now says 「开始使用」.
      expect(find.text(s.onboardingStart), findsOneWidget);
      expect(find.text(s.onboardingNext), findsNothing);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      expect(prefs.getBool(kOnboardingKey), isTrue);
      expect(find.byType(OnboardingView), findsNothing);
    });

    testWidgets('「上一步」really goes back to the previous page', (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kPromptKey: AppSettingsController.kPromptSettled,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(_homeLikeMain(c));
      final AppStrings s = AppStrings.of(c.locale);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('onboarding.back')));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingWhatTitle), findsOneWidget);
    });
  });

  // ── ⑤ The guide has no fake controls (narration is not a stand-in) ──────
  group('⑤ the guide is narration, not a stand-in', () {
    testWidgets('the only tappable things on the three pages are: skip / back / next',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kPromptKey: AppSettingsController.kPromptSettled,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(_homeLikeMain(c));

      // The **exact** count per page, not an upper bound: page 1 = skip +
      // next, each later page adds one 「上一步」. Written as `<= N`,
      // missing a button (e.g. 「上一步」not rendered) would still be
      // green — that kind of assertion only guards one direction.
      // InkWell is this app's generic 「tappable」shape (TextButton is
      // one internally too); the illustration block is wrapped in
      // IgnorePointer, so it contributes none.
      const List<int> expected = <int>[2, 3, 3];
      for (int page = 0; page < OnboardingStep.values.length; page++) {
        expect(
          tester.widgetList(find.byType(InkWell)).length,
          expected[page],
          reason: 'page ${page + 1} has the wrong number of tappable things — '
              'too many means a fake control grew, too few means a real button was not painted',
        );
        if (page < OnboardingStep.values.length - 1) {
          await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
          await tester.pumpAndSettle();
        }
      }
    });
  });

  // ── ⑥⑦ Review entry: wiring + does not change the first-run fact ────────
  group('⑥⑦ the review entry in the settings-page About section', () {
    testWidgets('🔴 wiring: the real settings page really has that row, and tapping it really pops guide page 1',
        (WidgetTester tester) async {
      // 🔴 The criterion lands on the **production row**:
      // `settings.openGuide` in `settings_preferences.dart`, tapped by
      // `tester.tap` on a real `SettingsPage`.
      //
      // ⚠️ This case was not written this way before, and the old
      // writing was exactly the shape it claimed to prevent: it built
      // its own `TextButton`, copied that row's `Navigator.push` into
      // `onPressed`, then tapped the button it had made. So what it
      // proved was 「this route can be walked」— and **whether that
      // row is on the settings page at all, it never asked**. This
      // window's adversarial audit measured: delete that whole
      // production row, the entire suite stays green, and owner
      // ruling 7-2 silently disappears.
      // Precedent (this window did it right twice):
      // `page_guides_test.dart` taps the two real "?" on a real
      // `ConnectionsPage`.
      //
      // 🔴 Reverse control [measured 2026-08-07]: delete the entire
      // `settingsRow(...)` for `settings.openGuide` in
      // `settings_preferences.dart`, this case goes red on the spot,
      // verbatim:
      //   Expected: exactly one matching candidate
      //     Actual: _KeyWidgetFinder:<Found 0 widgets with key
      //             [<'settings.openGuide'>]: []>
      //      Which: means none were found but one was expected
      //   设置页「关于」区没有 `settings.openGuide` 那一行 —— owner 裁定 7-2 的
      //   重看入口不在产品里了
      // Restored and re-greened (this file exit 0), leftover string
      // `REVERSE-CONTROL-LANEB` grep = 0.
      _tallViewport(tester);
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kExistingUserWitness: true,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);

      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(c.locale);
      final Finder row = find.byKey(const ValueKey<String>('settings.openGuide'));
      // Named up front, so「the row was deleted」reports itself as that instead
      // of as a bare `Bad state: No element` out of `tap` — the same lesson
      // page_guides_test.dart wrote down after its own reverse control.
      expect(row, findsOneWidget,
          reason: 'the settings-page About section has no `settings.openGuide` row — '
              'owner ruling 7-2\'s review entry is gone from the product');
      // The row carries its own copy, not just a tap target.
      expect(find.text(s.onboardingReviewTitle), findsOneWidget);
      expect(find.text(s.onboardingReviewSub), findsOneWidget);
      // Positive control: the guide must not pop itself (otherwise the
      // findsOneWidget below cannot prove it was this tap that brought it).
      expect(find.byType(OnboardingView), findsNothing);

      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.byType(OnboardingView), findsOneWidget);
      expect(find.text(s.onboardingWhatTitle), findsOneWidget);
    });

    testWidgets('🔴 reviewing does not change the fact of 「whether first-run onboarding was seen」',
        (WidgetTester tester) async {
      final SharedPreferences prefs = await _prefsWith(<String, Object>{
        kExistingUserWitness: true,
      });
      final AppSettingsController c = await _boot(prefs);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(home: OnboardingReviewPage(appSettings: c)),
      );
      // The last page of the review path says 「关闭」, not 「开始使用」—
      // saying 「开始使用」to someone already using the product is a
      // sentence that does not hold.
      final AppStrings s = AppStrings.of(c.locale);
      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      expect(find.text(s.onboardingClose), findsOneWidget);
      expect(find.text(s.onboardingStart), findsNothing);

      await tester.tap(find.byKey(const ValueKey<String>('onboarding.next')));
      await tester.pumpAndSettle();
      // Not one byte of the pref moved: this is a fact about the
      // install, not about this tap.
      expect(prefs.getBool(kOnboardingKey), isNull);
    });
  });

  // ── ⑧ Structural guard + four languages + render assertions ─────────────
  group('⑧ all four languages are complete, and long sentences are readable on the narrowest screen', () {
    test('every copy string the guide uses is non-empty in all four languages', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String v in <String>[
          s.onboardingSkip,
          s.onboardingNext,
          s.onboardingBack,
          s.onboardingStart,
          s.onboardingClose,
          s.onboardingWhatTitle,
          s.onboardingWhatBody,
          s.onboardingInstallTitle,
          s.onboardingInstallBody,
          s.onboardingCodeExpiryNote,
          s.onboardingPairTitle,
          s.onboardingPairBody,
          s.onboardingSpeakBody,
          s.onboardingSameNetworkNote,
          s.onboardingReviewTitle,
          s.onboardingReviewSub,
          s.onboardingArtWhat,
          s.onboardingArtInstall,
          s.onboardingArtPair,
          s.onboardingStepOf(1, 3),
        ]) {
          expect(v, isNotEmpty, reason: locale.name);
        }
        // 「开始使用」and 「关闭」must be two different sentences (they
        // answer two situations).
        expect(s.onboardingStart, isNot(s.onboardingClose), reason: locale.name);
      }
    });

    test('§6-1 value layer: both tab names appear in the pairing body of all four languages', () {
      // ⚠️ **This case is not a same-source criterion; do not treat it
      // as one.** It only answers 「does it display correctly today」:
      // swap `$pairTabScan` for a hand-copied `'扫码'` and it stays all
      // green — because a copy is **today** byte-equal to the getter.
      // The real criterion is the next case (source scan).
      // Source: this window's Lane 2 reverse-controlled the same
      // promise; the render assertions stayed green and only the
      // source scan went red ⇒ **the criterion for 「string
      // same-source」can only be a source scan.**
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.onboardingPairBody, contains(s.pairTabScan), reason: locale.name);
        expect(s.onboardingPairBody, contains(s.pairTabManual), reason: locale.name);
      }
    });

    test('🔴 §6-1 same-source (the real criterion = source scan): all four language templates go through the getter; not one is a hand copy',
        () async {
      // The class of error it must stop: **someone swaps `$pairTabScan`
      // for `'扫码'`** (any one of the four languages). That change
      // would not turn any render assertion red today, and on the day
      // the tab is reworded the guide starts telling a lie — and that
      // day nobody is looking at the guide.
      //
      // 🔴 **0.2.67 this scan changed files; the criterion did not
      // change one word.** The four-language templates no longer live
      // in the shard; they are each locale class's
      // `_lfOnboardingPairBody` implementation in
      // `l10n/app_strings_locales.g.dart` (architecture booklet §4.1).
      // **Leaving the scan on the old file would make it always
      // green** — that is 「the test went blind」, not 「there is no
      // defect」, the same shape as the 「value-layer assertion cannot
      // stop a hand copy」case above in this file's §6-1.
      final String src = await File(
        'lib/src/settings/l10n/app_strings_locales.g.dart',
      ).readAsString();
      // Each implementation starts with `  @override` and runs to the
      // next `  @override`; the body may span lines (adjacent literal
      // concatenation), so split by block, not by line.
      final List<String> impls = src
          .split('\n  @override\n')
          .where((String chunk) => chunk.startsWith('  String _lfOnboardingPairBody('))
          .toList();
      // 🔴 The criterion is `AppLocale.values.length`, not a hardcoded
      // 4 (nine-language expansion, 2026-08-14). A hardcoded number
      // goes red the day a language is added, and what it goes red
      // **for is not the thing it is supposed to guard** (someone
      // swapped `$pairTabScan` for a hand-copied 「扫码」) — it is
      // 「someone added a language」. An assertion that goes red on
      // itself, the next person will only bump the number, and that
      // bump is done without anyone checking what it actually guards.
      // After deriving it, adding a language does not touch this
      // line, and **one missing implementation still goes red**.
      expect(
        impls.length,
        AppLocale.values.length,
        reason: '_lfOnboardingPairBody implementation count is ${impls.length}, should be '
            '${AppLocale.values.length} (one per language) — either the leaf was renamed and '
            'this scan went blind, or one language has no translation of its own',
      );
      for (final String anchor in <String>[r'$pairTabScan', r'$pairTabManual']) {
        for (int i = 0; i < impls.length; i += 1) {
          // Once per language. One missing = that language copied it
          // into a literal.
          expect(
            anchor.allMatches(impls[i]).length,
            1,
            reason: '$anchor appeared ${anchor.allMatches(impls[i]).length} times in '
                '_lfOnboardingPairBody implementation ${i + 1}, should be 1'
                ' — one language hand-copied the tab name into a literal',
          );
        }
      }
      // The other half of same-source: these two names only declare a
      // signature in the shard; the implementation comes from
      // PairingStrings. If they were **implemented** in that file,
      // that would be a second definition, not a reference.
      final String shard = await File(
        'lib/src/settings/strings/onboarding_strings.dart',
      ).readAsString();
      expect(shard, contains('String get pairTabScan;'));
      expect(shard, contains('String get pairTabManual;'));
      expect(shard, isNot(contains('String get pairTabScan =>')));
      expect(shard, isNot(contains('String get pairTabManual =>')));
    });

    testWidgets('🔴 not one glyph of the three pages\' body may be clipped at 360dp (assert the rendered result, not Text.data)',
        (WidgetTester tester) async {
      // 0.2.53 law. ⚠️ Ahem is much wider than a real device, so this
      // is the conservative direction (see the file-head ruler).
      tester.view.physicalSize = const Size(360 * 3, 1400 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        // ⚠️ Language **must not** be given by seeding
        // `flowmic.pref.locale`: that key itself is a witness of
        // 「this device already has another FlowMic pref」⇒ the guide
        // gate judges an upgrade install ⇒ the guide does not render
        // at all, and this test goes red on a baffling
        // 「Found 0 widgets」(measured this round). Switch language
        // explicitly after boot instead.
        final SharedPreferences prefs = await _prefsWith(<String, Object>{
          kPromptKey: AppSettingsController.kPromptSettled,
        });
        final AppSettingsController c = await _boot(prefs);
        addTearDown(c.dispose);
        c.setLocale(locale);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_homeLikeMain(c, freshKey: locale));

        final List<List<String>> perPage = <List<String>>[
          <String>[s.onboardingWhatTitle, s.onboardingWhatBody],
          <String>[
            s.onboardingInstallTitle,
            s.onboardingInstallBody,
            s.onboardingCodeExpiryNote,
          ],
          <String>[
            s.onboardingPairTitle,
            s.onboardingPairBody,
            s.onboardingSpeakBody,
            s.onboardingSameNetworkNote,
          ],
        ];
        for (int page = 0; page < perPage.length; page++) {
          for (final String text in perPage[page]) {
            final Finder f = find.text(text);
            expect(f, findsOneWidget, reason: '${locale.name} p${page + 1}: $text');
            expectLegible(
              tester,
              f,
              reason: '${locale.name} p${page + 1}\n$text',
            );
          }
          if (page < perPage.length - 1) {
            await tester.tap(
              find.byKey(const ValueKey<String>('onboarding.next')),
            );
            await tester.pumpAndSettle();
          }
        }
      }
    });
  });
}
