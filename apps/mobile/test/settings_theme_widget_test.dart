// V2-07.4 — the 偏好 card's 语言/主题 rows are LIVE, and 跟随系统 really follows.
//
// Three proofs, all against the REAL controllers (fake socket + fake recorder):
// (1) LANGUAGE: tapping the EN chip re-renders the screen in English — the
//     explicit-choice mechanism, never the OS locale (red line).
// (2) THEME SWITCH: tapping 浅色 re-tints the bespoke widgets (Scaffold
//     background resolves through FlowMicColors, not just Material chrome —
//     the exact façade shape that got an earlier theme selector removed) and
//     persists flowmic.pref.themeMode in the same tap (即改即存).
// (3) FOLLOW-OS IS LIVE: in system mode a LATER OS flip re-resolves the theme
//     (via tester.platformDispatcher.platformBrightnessTestValue), while a
//     pinned 深色 ignores the same flip. A boot-time one-shot read would pass
//     (2) and fail this — this is the test that keeps 跟随系统 honest.
//
// The widget wrapper mirrors main.dart's real wiring (ValueListenableBuilder
// over FlowMicTheme.brightness around the MaterialApp), because that listener
// is what turns a resolved-brightness change into a tree-wide re-tint.

import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';
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

  // The same listener shape main.dart wraps the app in — without it a
  // brightness change would be a state change nobody renders.
  Widget widget() => ValueListenableBuilder<Brightness>(
    valueListenable: FlowMicTheme.brightness,
    builder: (BuildContext context, Brightness brightness, _) => MaterialApp(
      theme: ThemeData(brightness: brightness),
      home: SettingsPage(
        scenario: scenario,
        appSettings: appSettings,
        login: login,
        destination: destination,
        session: session,
        portable: newTestPortableController(),
        inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
        timeline: newTestStore(),
        version: const FixedAppVersion('0.0.0-test'),
        update: newTestUpdateController(),
      ),
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

Color _scaffoldBg(WidgetTester tester) =>
    tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor!;

void main() {
  // Deterministic ambient OS brightness + clean theme state per test. The
  // rig's load() resolves the default system mode against the platform value,
  // so pin it to DARK first — then every expectation below is unambiguous.
  void pinPlatformDark(WidgetTester tester) {
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  }

  void tallViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('language row: EN chip re-renders the screen in English '
      '(explicit choice, never OS locale)', (WidgetTester tester) async {
    tallViewport(tester);
    pinPlatformDark(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget); // pinned zh so the EN tap is a real flip
    expect(find.text('主题'), findsOneWidget); // the new theme row, in zh
    expect(find.text('跟随系统'), findsOneWidget);

    // Nine-locale expansion (2026-08-14): the chip prints the endonym 'English',
    // no longer 'EN'. Full rationale is in the matching comment in
    // `settings_page_widget_test.dart`.
    await tester.ensureVisible(find.text('English'));
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();

    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
    // The theme row flips with the rest of the screen.
    expect(find.text('Theme'), findsOneWidget);
    expect(find.text('System'), findsOneWidget);

    await tester.tap(find.text('中文'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.zh);
    expect(find.text('设置'), findsOneWidget);
  });

  testWidgets('theme row: 浅色 chip re-tints the bespoke UI and persists '
      'in the same tap (即改即存)', (WidgetTester tester) async {
    tallViewport(tester);
    pinPlatformDark(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    // Default 跟随系统 over a dark OS = the frozen dark palette.
    expect(rig.appSettings.themeMode, AppThemeMode.system);
    expect(FlowMicTheme.brightness.value, Brightness.dark);
    expect(_scaffoldBg(tester), FlowMicDarkColors.canvas);

    await tester.tap(find.text('浅色'));
    await tester.pumpAndSettle();

    expect(rig.appSettings.themeMode, AppThemeMode.light);
    expect(FlowMicTheme.brightness.value, Brightness.light);
    expect(_scaffoldBg(tester), FlowMicLightColors.canvas);
    // 即改即存: the pref is on disk from the same tap, no save button.
    expect(rig.prefs.getString('flowmic.pref.themeMode'), 'light');

    await tester.tap(find.text('深色'));
    await tester.pumpAndSettle();

    expect(rig.appSettings.themeMode, AppThemeMode.dark);
    expect(_scaffoldBg(tester), FlowMicDarkColors.canvas);
    expect(rig.prefs.getString('flowmic.pref.themeMode'), 'dark');
  });

  testWidgets('跟随系统 follows a LATER OS brightness flip live, while pinned '
      '深色 ignores it', (WidgetTester tester) async {
    tallViewport(tester);
    pinPlatformDark(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);
    // Arm the platform observer (main.dart does this before runApp).
    FlowMicTheme.init();

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(_scaffoldBg(tester), FlowMicDarkColors.canvas);

    // Pin 深色, then flip the OS: a pinned mode must NOT follow.
    await tester.tap(find.text('深色'));
    await tester.pumpAndSettle();
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    await tester.pump();
    expect(FlowMicTheme.brightness.value, Brightness.dark);
    expect(_scaffoldBg(tester), FlowMicDarkColors.canvas);

    // Back to 跟随系统: it picks up the CURRENT (light) OS value at once…
    await tester.tap(find.text('跟随系统'));
    await tester.pump();
    expect(rig.appSettings.themeMode, AppThemeMode.system);
    expect(FlowMicTheme.brightness.value, Brightness.light);
    expect(_scaffoldBg(tester), FlowMicLightColors.canvas);

    // …and every LATER flip is tracked live, both directions.
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    await tester.pump();
    expect(FlowMicTheme.brightness.value, Brightness.dark);
    expect(_scaffoldBg(tester), FlowMicDarkColors.canvas);

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    await tester.pump();
    expect(FlowMicTheme.brightness.value, Brightness.light);
    expect(_scaffoldBg(tester), FlowMicLightColors.canvas);
  });
}
