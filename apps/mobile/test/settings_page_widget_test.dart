// WP-R3-3 — the settings screen rendered over the real controllers (fake socket
// + fake recorder). Proves the anti-façade wiring: a profession chip and a pack
// checkbox are LIVE — tapping a chip writes settings:update{scenario.card}
// through the real SettingsClient; the structured surfaces (chips / packs /
// terms) all render from the generated protocol data.

import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

class _Rig {
  late final FakeSocketTransport settingsTransport;
  late final SettingsClient settingsClient;
  late final ValueNotifier<int> settingsJoins;
  late final ScenarioCardController scenario;
  late final AppSettingsController appSettings;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;

  static Future<_Rig> create() async {
    final _Rig r = _Rig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: prefs);
    await r.appSettings.load();
    r.settingsTransport = FakeSocketTransport();
    // The settings edge is `PttSession.roomJoins`, not the socket's connected
    // status (settings_client.dart header point 4 — F-1 on the settings path).
    // Bumping this notifier is what "the server admitted us" looks like here.
    r.settingsJoins = ValueNotifier<int>(0);
    r.settingsClient = SettingsClient(
        transport: r.settingsTransport, roomJoins: r.settingsJoins);
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
          // Window C: SettingsPage now requires the export/import controller. A
          // double over empty rows — this test is about the scenario card, and
          // the data section only has to BUILD.
          portable: newTestPortableController(),
          inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
          timeline: newTestStore(),
          version: const FixedAppVersion('0.0.0-test'),
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
  testWidgets('structured scenario surfaces render + a chip tap writes '
      'settings:update', (WidgetTester tester) async {
    // Tall viewport so the whole anchored settings list lays out at once.
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    // Structured (NOT free-text): profession chip, a generated pack label, and
    // the custom-terms hint are all present.
    expect(find.text('软件开发'), findsOneWidget); // profession preset chip
    expect(find.text('编程 / 开发术语'), findsOneWidget); // generated tech-dev pack
    expect(find.text('每条 ≤40 字符'), findsOneWidget); // term ≤40 hint

    // Tap the profession chip → save-as-you-go → settings:update on the wire.
    await tester.tap(find.text('软件开发'));
    await tester.pump();

    expect(rig.scenario.card.hasProfession('software development'), isTrue);
    final envelopes =
        rig.settingsTransport.emittedWhere(FlowMicEvents.settingsUpdate);
    expect(envelopes, isNotEmpty);
    final Map<dynamic, dynamic> payload = envelopes.last.data as Map<dynamic, dynamic>;
    expect(payload['key'], 'scenario.card');
    expect((payload['value'] as Map)['professions'], <String>['software development']);
  });

  testWidgets('GA-11: the hydrated server card is what the SCREEN shows '
      '(room-join edge → settings:list → rendered term + counter + note)',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    // A card the user already had locally, so the hydration DISPLACES something
    // visible and must own up to it.
    rig.scenario.togglePack('legal');
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(find.text('服务端术语'), findsNothing);

    // The server snapshot lands when the server ADMITS us, not when the socket
    // connects — the connected edge fires before `mobile:reconnect` is even
    // sent, so a pull there comes back AUTH_TOKEN_INVALID and never retries.
    rig.settingsTransport.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'key': 'scenario.card',
          'value': <String, Object?>{
            'professions': <String>['software development'],
            'domains': <String>[],
            'packs': <String>['tech-dev'],
            'terms': <String>['服务端术语'],
          },
        },
      ],
    });
    rig.settingsJoins.value++;
    await tester.pumpAndSettle();

    // The wire really carried the pull…
    expect(
      rig.settingsTransport.emittedWhere(FlowMicEvents.settingsList),
      hasLength(1),
    );
    // …and the hydrated value is on screen: the custom term row, the term
    // counter that counts it, and the honest "this came from your PC" note.
    expect(find.text('服务端术语'), findsOneWidget);
    expect(find.text('1 / 100'), findsOneWidget);
    expect(find.text('已按电脑端最新值更新'), findsOneWidget);
  });

  testWidgets('VISIBLE language selector: tapping the EN chip re-renders the '
      'screen in EN (explicit locale, never OS — WP-R4-3)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget); // pinned zh so the EN tap is a real flip
    expect(find.text('偏好'), findsOneWidget); // the preferences section exists
    // Save-as-you-go: tapping the visible EN chip flips the whole screen — no
    // save button, and the controller persisted the explicit choice.
    // 🔴 Nine-locale expansion (2026-08-14): the word printed on this chip
    // changed from `s.langEn`＝'EN' to the **endonym**＝'English'. Not a layout
    // preference: `langEn` is a two-letter abbreviation, and the other eight of
    // the nine chips are all self-names ('Français' / 'Русский' / '日本語'), so
    // mixing them would make the English cell look like a different kind of
    // thing. The registry also ruled this verbatim (`packages/protocol/src/locales.ts`
    // `endonym`: language names use the self-name on every UI and are not
    // translated with the UI language). The `langEn` string **was not deleted**
    // — it still serves `spokenLangLabel`, which answers 「which language am I
    // speaking」, a different question and a different set of four values.
    await tester.ensureVisible(find.text('English'));
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget); // flipped, explicitly
    expect(find.text('设置'), findsNothing);
    expect(find.text('PREFERENCES'), findsOneWidget); // settingsSection upcases
    // V2-07.7: the former SHADOW catalogues render through AppStrings now —
    // the profession chip wears the catalogue's English face, and the pack
    // falls back to the protocol's English SSOT label.
    expect(find.text('Software dev'), findsOneWidget); // profession preset chip
    expect(find.text('Tech / Dev terms'), findsOneWidget); // tech-dev pack
    expect(find.text('软件开发'), findsNothing);
    expect(find.text('编程 / 开发术语'), findsNothing);
    // And back via the visible 中文 chip.
    await tester.tap(find.text('中文'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.zh);
    expect(find.text('设置'), findsOneWidget);
  });

  testWidgets('V2-07.5: the 日本語 / 한국어 chips REALLY re-render the screen '
      'in Japanese / Korean (explicit locale, never OS)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);
    rig.appSettings.setLocale(AppLocale.zh);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(find.text('设置'), findsOneWidget); // pinned zh so ja/ko are real flips

    // The chip labels are endonyms (中文 / EN / 日本語 / 한국어) — findable in
    // every UI language, which is exactly why a user lost in a language they
    // cannot read can still find the way back.
    await tester.ensureVisible(find.text('日本語'));
    await tester.tap(find.text('日本語'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.ja);
    expect(find.text('設定'), findsOneWidget); // app bar flipped
    expect(find.text('アカウント'), findsOneWidget); // section header flipped
    expect(find.text('環境設定'), findsOneWidget); // preferences section flipped
    expect(find.text('设置'), findsNothing);
    expect(find.text('Settings'), findsNothing);

    await tester.tap(find.text('한국어'));
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.ko);
    expect(find.text('설정'), findsOneWidget);
    expect(find.text('계정'), findsOneWidget);
    expect(find.text('환경 설정'), findsOneWidget);
    expect(find.text('設定'), findsNothing);
  });

  testWidgets('RED LINE: the OS locale never picks the UI language — a ja/zh '
      'OS with NO stored pref still boots to the English default', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    // ja is a SHIPPED language and is NOT the default. Stubbing to en-US after
    // the default flipped to English would go green even if the code started
    // reading PlatformDispatcher.locale — a weakened guard.
    tester.platformDispatcher.localeTestValue = const Locale('ja', 'JP');
    addTearDown(tester.platformDispatcher.clearLocaleTestValue);

    final _Rig rig = await _Rig.create(); // mock prefs EMPTY — no stored choice
    addTearDown(rig.dispose);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
    expect(find.text('設定'), findsNothing);

    // Mid-session OS flips change nothing either — there is no OS-locale
    // listener anywhere in the language path (the theme may follow the OS;
    // the language may NOT — two deliberately different rulings).
    tester.platformDispatcher.localeTestValue = const Locale('zh', 'CN');
    await tester.pumpAndSettle();
    expect(rig.appSettings.locale, AppLocale.en);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('设置'), findsNothing);
  });
}
