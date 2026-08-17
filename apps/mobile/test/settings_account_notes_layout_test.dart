// The Settings ACCOUNT → Notes row used to put the subtitle and the
// 「Enter Notes (Record only)」 CTA on ONE Row. At 360dp in English the CTA
// ate the width and the subtitle wrapped one/two letters per line (owner
// screenshot 2026-08-13). Existing settings_page_widget_test.dart pumps at
// 1200px, so that overflow was invisible to the suite.
//
// 0.2.53 law: a "can the user read this" assertion lands on the RENDERED box
// (width / height), not on Text.data. Reverse control: put the CTA back on
// the same Row as the subtitle → EN @ 360dp makes the subtitle width collapse
// below 100 and this file goes red.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
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
  late final AppSettingsController appSettings;
  late final ScenarioCardController scenario;
  late final PttSession session;
  late final LoginController login;
  late final DestinationController destination;
  late final SettingsClient settingsClient;

  static Future<_Rig> create({CloudAccount? account}) async {
    final _Rig r = _Rig();
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    r.appSettings = AppSettingsController(prefs: prefs);
    await r.appSettings.load();
    final FakeSocketTransport transport = FakeSocketTransport();
    r.settingsClient =
        SettingsClient(transport: transport, roomJoins: ValueNotifier<int>(0));
    r.scenario = ScenarioCardController(
      settingsClient: r.settingsClient,
      cache: InMemoryScenarioCardCache(),
    );
    await r.scenario.load();
    r.session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.login = newTestLogin(
      transport: r.session.transport,
      accountStore: InMemoryAccountStore(account),
    );
    if (account != null) await r.login.hydrate();
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
    appSettings.dispose();
    destination.dispose();
    await session.dispose();
  }
}

void _phoneViewport(WidgetTester tester, {double width = 360}) {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  testWidgets('Notes subtitle keeps readable width at 360dp in all four locales',
      (WidgetTester tester) async {
    _phoneViewport(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    for (final AppLocale locale in AppLocale.values) {
      rig.appSettings.setLocale(locale);
      await tester.pumpAndSettle();

      final RenderBox sub = tester.renderObject(
        find.byKey(const ValueKey<String>('settings.notes.sub')),
      );
      // Inner card after 14+14 list padding, 14+14 row padding, 20+12 icon.
      // 360 − 28 − 28 − 32 = 272. Floor 200 so a regression that puts the
      // CTA back beside the copy (≈50dp leftover) is red, not a near miss.
      expect(sub.size.width, greaterThanOrEqualTo(200),
          reason: 'locale=${locale.name} subtitle width=${sub.size.width}');
      expect(sub.size.height, lessThan(80),
          reason: 'locale=${locale.name} subtitle height=${sub.size.height} '
              '— a 50dp-wide column wraps into a tower');

      final RenderBox manage = tester.renderObject(
        find.byKey(const ValueKey<String>('settings.notes.manage')),
      );
      expect(manage.size.width, greaterThanOrEqualTo(200),
          reason: 'locale=${locale.name} manage-link width=${manage.size.width}');
    }
  });

  testWidgets('Notes row at 320dp with a long signed-in email does not overflow',
      (WidgetTester tester) async {
    _phoneViewport(tester, width: 320);
    final _Rig rig = await _Rig.create(
      account: const CloudAccount(
        jwt: 'jwt-layout-test',
        email: 'a.very.long.subscriber.address@example.com',
        plan: 'free',
      ),
    );
    addTearDown(rig.dispose);

    rig.appSettings.setLocale(AppLocale.en);
    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('a.very.long.subscriber.address@example.com'), findsOneWidget);
    expect(find.text('Free'), findsOneWidget);

    final RenderBox sub = tester.renderObject(
      find.byKey(const ValueKey<String>('settings.notes.sub')),
    );
    // 320 − 28 − 28 − 32 = 232.
    expect(sub.size.width, greaterThanOrEqualTo(180));
    expect(find.byKey(const ValueKey<String>('settings.notes.cta')), findsOneWidget);
  });

  testWidgets('settings app bar does not cover the first section in any locale',
      (WidgetTester tester) async {
    _phoneViewport(tester);
    final _Rig rig = await _Rig.create();
    addTearDown(rig.dispose);

    await tester.pumpWidget(rig.widget());
    await tester.pumpAndSettle();

    for (final AppLocale locale in AppLocale.values) {
      rig.appSettings.setLocale(locale);
      await tester.pumpAndSettle();
      expect(
        tester.takeException(),
        isNull,
        reason: 'locale=${locale.name} overflowed',
      );

      final Rect bar = tester.getRect(
        find.byKey(const ValueKey<String>('settings.appBar')),
      );
      final AppStrings s = AppStrings.of(locale);
      final Rect account = tester.getRect(
        find.text(s.secAccount.toUpperCase()).first,
      );
      expect(
        bar.bottom,
        lessThanOrEqualTo(account.top + 0.5),
        reason: 'locale=${locale.name}: app bar bottom ${bar.bottom} covers '
            '「${s.secAccount}」 at ${account.top}',
      );

      final Size back = tester.getSize(
        find.byKey(const ValueKey<String>('settings.back')),
      );
      expect(back.width, greaterThanOrEqualTo(40));
      expect(back.height, greaterThanOrEqualTo(40));
      expect(back.height, lessThanOrEqualTo(bar.height));
    }
  });
}
