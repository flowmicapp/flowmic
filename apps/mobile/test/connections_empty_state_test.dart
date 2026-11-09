// FR-M4 — what a stranger reads on the computer list before anything is paired.
//
// SPEC-REF: docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §2.2 (the
// 2026-11-06 correction block); apps/mobile/lib/src/ui/connections_page.dart
// `_body`; apps/mobile/lib/main.dart `home:` (the ternary the host below mirrors).
//
// THE ROUTE, FROM CODE: a fresh install goes language → quick guide → this list
// (main.dart `needsLocaleChoice` / `needsOnboarding`). The guide's page 2 says the
// computer needs the app and where to get it, and all three pages have a Skip. So
// the list is the first screen that a person who skipped has read at all, and it
// used to tell them to enter a code shown by a computer app they may not own.
//
// CLAUDE.md anti-facade ⑥: the deliverable is this SCREEN, so the real
// `ConnectionsPage` is mounted. Tool traps honoured here: `findsNothing` in a
// ListView proves nothing unless the canvas is tall enough to build every child,
// so the absence case sets a tall canvas and carries a positive control.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/first_run_locale_page.dart';
import 'package:flowmic/src/ui/onboarding/first_run_onboarding_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';

const ValueKey<String> _download = ValueKey<String>('onboarding.download');

Future<HealthReading> _offline(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

/// The production page over the real controllers. Only the socket and the two
/// reachability probes are fake, so nothing in this file reaches the network.
Future<ConnectionsPage> _page(
  AppSettingsController settings, {
  List<MobileSession> seed = const <MobileSession>[],
}) async {
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  for (final MobileSession s in seed) {
    await storage.addOrUpdatePairing(s);
  }
  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  return ConnectionsPage(
    connections: ConnectionsController(
      session: session,
      login: login,
      healthReader: _offline,
      presenceReader: _presenceUnknown,
    ),
    appSettings: settings,
    login: login,
    destination: DestinationController(),
    chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
    settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
    historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
    updateListenable: ValueNotifier<bool>(false),
    hasUpdate: () => false,
  );
}

Future<AppSettingsController> _settings(
  WidgetTester tester, {
  AppLocale? locale,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController c = AppSettingsController(prefs: prefs);
  addTearDown(c.dispose);
  await c.load();
  if (locale != null) c.setLocale(locale);
  return c;
}

void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(360, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('the whole first run, skipping the guide: the list says a computer '
      'app is needed and where to get it', (WidgetTester tester) async {
    _tall(tester);
    final AppSettingsController c = await _settings(tester);
    expect(c.needsLocaleChoice, isTrue);
    expect(c.needsOnboarding, isTrue);
    final ConnectionsPage page = await _page(c);
    // Same ternary as main.dart's `home:`.
    await tester.pumpWidget(MaterialApp(
      home: ListenableBuilder(
        listenable: c,
        builder: (BuildContext context, Widget? child) => c.needsLocaleChoice
            ? FirstRunLocalePage(appSettings: c)
            : c.needsOnboarding
                ? FirstRunOnboardingPage(appSettings: c)
                : child!,
        child: page,
      ),
    ));
    await tester.pumpAndSettle();

    // First screen: language. Second: the guide, which the stranger skips.
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    final AppStrings s = AppStrings.of(AppLocale.en);
    expect(find.text(s.onboardingWhatTitle), findsOneWidget,
        reason: 'a fresh install lands on the quick guide first');
    await tester.tap(find.byKey(const ValueKey<String>('onboarding.skip')));
    await tester.pumpAndSettle();

    // The list, with nothing read so far.
    expect(find.text(s.noInstances), findsOneWidget);
    final Finder hint = find.text(s.noInstancesHint);
    expect(hint, findsOneWidget);
    expect(find.byKey(_download), findsOneWidget,
        reason: 'nothing on the first main screen says how to get the computer app');
    expect(find.text(s.onboardingDownloadOpenOnPc), findsOneWidget);
    expect(find.text('flowmic.app'), findsOneWidget);
    expect(find.text(s.onboardingDownloadInstall), findsOneWidget);

    // The reading order the sentence relies on: heading, hint, then the box it
    // points at, then the Notes card and the button.
    final Finder add = find.text(s.addDevice);
    expect(add, findsOneWidget);
    final double hintTop = tester.getTopLeft(hint).dy;
    final double boxTop = tester.getTopLeft(find.byKey(_download)).dy;
    final double notesTop = tester.getTopLeft(find.text(s.cloudInstance)).dy;
    expect(hintTop, lessThan(boxTop));
    expect(boxTop, lessThan(notesTop));
    expect(notesTop, lessThan(tester.getTopLeft(add).dy));

    // Notes must stay reachable: the app does not require a computer.
    expect(find.text(s.cloudInstanceSub), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('with a paired computer the box is gone (it is not a permanent ad)',
      (WidgetTester tester) async {
    _tall(tester);
    final AppSettingsController c = await _settings(tester, locale: AppLocale.en);
    await tester.pumpWidget(MaterialApp(
      home: await _page(c, seed: <MobileSession>[
        const MobileSession(
          token: 'tok-seeded-00000000000000000000',
          endpoint: 'http://192.0.2.5:41879',
          channel: 'standalone',
          pcName: 'Studio PC',
          pairingId: 'pair-seed',
        ),
      ]),
    ));
    await tester.pumpAndSettle();
    // Positive control: the list really built, and the Add button below is here.
    expect(find.text('Studio PC'), findsOneWidget);
    expect(find.text(AppStrings.of(AppLocale.en).addDevice), findsOneWidget);
    expect(find.byKey(_download), findsNothing);
    expect(find.text(AppStrings.of(AppLocale.en).noInstancesHint), findsNothing);
  });

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('${locale.name}: at 360x640 the hint and the box render whole',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final AppSettingsController c = await _settings(tester, locale: locale);
      final AppStrings s = AppStrings.of(locale);
      await tester.pumpWidget(MaterialApp(home: await _page(c)));
      await tester.pumpAndSettle();

      final Finder hint = find.text(s.noInstancesHint);
      expect(hint, findsOneWidget);
      expectLegible(tester, hint, reason: locale.name);
      expect(find.byKey(_download), findsOneWidget, reason: locale.name);
      expectLegible(tester, find.text(s.onboardingDownloadOpenOnPc),
          reason: locale.name);
      // The page must not open on a wall of explanation: the hint and the box
      // are both on the first screen without scrolling.
      expect(tester.getBottomLeft(find.byKey(_download)).dy,
          lessThanOrEqualTo(640.0),
          reason: '${locale.name}: the box is below the fold');
      // RenderFlex overflow would surface here.
      expect(tester.takeException(), isNull, reason: locale.name);
    });
  }
}
