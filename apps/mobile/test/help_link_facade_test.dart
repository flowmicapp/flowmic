// Card U7 (mobile half) —— FAÇADE GUARD, mirrors the desktop agent's
// `pairing-modal.test.ts`「does NOT render a download link while PAIR_APP_URL
// is empty」test exactly, for the same reason on the phone side.
//
// The repo-wide finding (docs/strategy/2026-08-04-0.3.0-task-book-cn.md §U7):
// zero help/FAQ/support/contact entry, zero external links, and copy that
// promised "把截图发给维护者" (send a screenshot to the maintainer) with no
// address to send it to. The mobile app currently has no such dangling
// promise (grepped: no user-facing string in lib/src/settings/strings/*.dart
// mentions sending anything to a maintainer/support address), so this file's
// job is narrower and forward-looking: prove the ONE place a future real
// help URL would be wired in (`kHelpUrl`, lib/src/support/help_link.dart)
// stays silent — not a broken link, not a hardcoded guess — for as long as
// that constant is empty.
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/support/help_link.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/update_fakes.dart';

void main() {
  test('🔴 kHelpUrl is empty — no help/FAQ page has ever been verified to '
      'exist (see help_link.dart for the evidentiary bar a fill-in would '
      'have to clear)', () {
    expect(kHelpUrl, isEmpty);
  });

  testWidgets(
    'FAÇADE GUARD: the Settings screen renders no help/support row while '
    'kHelpUrl is empty — a visible row with nowhere to go would be worse '
    'than no row at all',
    (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 4200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
      addTearDown(appSettings.dispose);
      await appSettings.load();
      final FakeSocketTransport transport = FakeSocketTransport();
      addTearDown(transport.close);
      final SettingsClient settingsClient = SettingsClient(transport: transport);
      addTearDown(settingsClient.dispose);
      final ScenarioCardController scenario = ScenarioCardController(
        settingsClient: settingsClient,
        cache: InMemoryScenarioCardCache(),
      );
      addTearDown(scenario.dispose);
      await scenario.load();
      final PttSession session = newTestSession(
        transport: FakeSocketTransport(),
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      addTearDown(session.dispose);
      final LoginController login = newTestLogin(transport: session.transport);
      addTearDown(login.dispose);
      final DestinationController destination = DestinationController();
      addTearDown(destination.dispose);

      final AppStrings s = AppStrings(appSettings.locale);

      await tester.pumpWidget(
        MaterialApp(
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
      await tester.pumpAndSettle();

      // No label, no URL text, anywhere on the page — not just in the About
      // card, in case a future edit moves it.
      expect(find.text(s.helpLabel), findsNothing);
      expect(find.textContaining('flowmic.app'), findsNothing);
      // The About card is still there with just the version row (U9) —
      // this guard must not be mistaken for the whole card going missing.
      expect(find.text(s.secAbout.toUpperCase()), findsOneWidget);
      expect(find.text(s.appVersionLabel), findsOneWidget);
    },
  );
}
