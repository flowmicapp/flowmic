// 🔴 卡 U9 —— the phone never had a place that showed which version it was
// running: package_info was read once, only in export metadata
// (portable_export.dart's "App version at export"), the settings page never
// read it, the user themselves cannot answer "which version are you", and
// word-of-mouth support cannot be done.
//
// This file proves three things; missing any one can still be a façade:
//   ① the About section really renders the title + version;
//   ② the version number really comes from [AppVersionPort] (reverse control:
//      swap the port's return value and the number on screen follows — it is
//      not some string hardcoded in the settings page);
//   ③ when the port honestly cannot answer (null), the screen never shows
//      Dart's literal "null", and never fabricates a version to stand in
//      (13 册 D5: a version number that no longer corresponds to any build
//      after install is more dangerous than "unknown").

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
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

class _Rig {
  late final SharedPreferences prefs;
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ScenarioCardController scenario;
  late final AppSettingsController appSettings;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;

  static Future<_Rig> create() async {
    final _Rig r = _Rig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    r.prefs = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: r.prefs);
    await r.appSettings.load();
    r.settingsTransport = FakeSocketTransport();
    r.settingsClient = SettingsClient(transport: r.settingsTransport);
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

  Widget widget({required FixedAppVersion version}) => MaterialApp(
    home: SettingsPage(
      scenario: scenario,
      appSettings: appSettings,
      login: login,
      destination: destination,
      session: session,
      portable: newTestPortableController(),
      inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
      timeline: newTestStore(),
      version: version,
      update: newTestUpdateController(),
    ),
  );

  Future<void> dispose() async {
    await settingsClient.dispose();
    login.dispose();
    scenario.dispose();
    appSettings.dispose();
    destination.dispose();
    await session.dispose();
    await settingsTransport.close();
  }
}

void main() {
  // A viewport tall enough that every settings section is on screen without
  // scrolling — sidesteps the lazily-built-offscreen-child problem entirely
  // (see the comment added to portable_ui_widget_test.dart on the same
  // ListView, where the fixed-step scroll-and-check approach turned out to be
  // sensitive to exactly how much content is on the page).
  void tallViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('U9: the About section renders the version the PORT returned', (WidgetTester tester) async {
    tallViewport(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);

    await tester.pumpWidget(rig.widget(version: const FixedAppVersion('1.2.3')));
    await tester.pumpAndSettle();

    final AppStrings s = AppStrings(rig.appSettings.locale);
    expect(find.text(s.secAbout.toUpperCase()), findsOneWidget, reason: 'the About section header must render');
    expect(find.text(s.appVersionLabel), findsOneWidget);
    expect(
      find.text(s.appVersionValue('1.2.3')),
      findsOneWidget,
      reason: 'must show exactly what AppVersionPort answered',
    );
  });

  testWidgets(
    'U9 reverse control: a DIFFERENT installed version renders a DIFFERENT string — '
    'proof this is not a hardcoded number in the widget',
    (WidgetTester tester) async {
      tallViewport(tester);
      final _Rig rig = await _Rig.create();
      addTearDown(rig.dispose);

      await tester.pumpWidget(rig.widget(version: const FixedAppVersion('9.9.9-rc1')));
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings(rig.appSettings.locale);
      expect(find.text(s.appVersionValue('1.2.3')), findsNothing);
      expect(find.text(s.appVersionValue('9.9.9-rc1')), findsOneWidget);
    },
  );

  testWidgets(
    'U9 honest boundary: AppVersionPort answering null never fabricates a version, '
    'and never leaks the literal Dart "null" onto the screen',
    (WidgetTester tester) async {
      tallViewport(tester);
      final _Rig rig = await _Rig.create();
      addTearDown(rig.dispose);

      await tester.pumpWidget(rig.widget(version: const FixedAppVersion(null)));
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings(rig.appSettings.locale);
      expect(find.text(s.appVersionUnknown), findsOneWidget);
      expect(
        find.textContaining('null', findRichText: true),
        findsNothing,
        reason: 'Dart\'s null must never reach the screen literally',
      );
    },
  );

  group('U9 four locales: appVersionLabel / appVersionValue / appVersionUnknown', () {
    for (final AppLocale locale in AppLocale.values) {
      test(locale.name, () {
        final AppStrings s = AppStrings(locale);
        expect(s.appVersionLabel, isNotEmpty);
        expect(s.appVersionUnknown, isNotEmpty);
        expect(s.appVersionUnknown, isNot(contains('null')));
        expect(s.appVersionValue('1.2.3'), contains('1.2.3'));
      });
    }

    test('each of the four locales has its own sentence, not the same sentence copied four times (appVersionUnknown)', () {
      final Set<String> seen = <String>{};
      for (final AppLocale locale in AppLocale.values) {
        expect(seen.add(AppStrings(locale).appVersionUnknown), isTrue, reason: '$locale reused the previous locale\'s sentence');
      }
    });
  });
}
