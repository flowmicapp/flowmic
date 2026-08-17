// The other half of pc_signed_out_wire_test.dart: that the word actually
// reaches the SCREEN, and that the sentence it replaces is not still sitting
// next to it.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/connections_row_faces.dart (`_statusLabelRouted`)
//   apps/mobile/lib/src/ui/guide/instance_guide_sheet.dart (`kGuideStatusOrder`)
//   apps/mobile/lib/src/settings/strings/connection_strings.dart
//     ([ConnectionStrings.pcSignedOutChip])
//
// 🔴 WHY THE RENDER HALF IS ITS OWN MEASUREMENT. 0.2.53: 1,259 tests were green
// while the screen showed three letters, because the assertions read
// `Text.data` — a value the suite had computed for itself — instead of what a
// person reads. So this file asks the widget tree, in English, for the string
// the user is looking at, and separately asserts that the OLD sentence is not
// on screen: a half-finished branch produces a row saying both things at once,
// and a test that only looked for the new word would call that a pass.
//
// ⚠️ This file is `testWidgets` ONLY. It cannot also host the wire tests:
// `TestWidgetsFlutterBinding` installs HttpOverrides suite-wide, so a real
// `HttpClient` in the same file silently dials a double (measured — see the
// wire file's header).
//
// ── REVERSE CONTROL (executed 2026-08-16, observed — not reasoned) ──────────
// Break: in `_statusLabelRouted` (connections_row_faces.dart), point the
// `pcSignedOut` arm at `s.pcOfflineChip` instead of `s.pcSignedOutChip` — the
// face exists, the user is told the old sentence anyway. This is the more
// dangerous half of the defect, because every enum-level test stays green.
// Observed:
//   'an auth_expired absence renders "PC signed out", not "PC is offline"'
//     Expected: exactly one matching candidate
//       Actual: _TextWidgetFinder:<Found 0 widgets with text "PC signed out": []>
//       Which: means none were found but one was expected
//   — i.e. the row is back to telling this user their computer is offline while
//   it sits there powered on and running.
// ⚠️ Control on the control: pc_signed_out_wire_test.dart stayed GREEN under
// this break (6/6). The wire, the parse and the face were all still correct —
// only the sentence a person reads was wrong, which is exactly the class of
// defect an enum-level suite cannot see, and exactly why this file exists.
// Restored, re-run: all green.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/guide/instance_guide_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

Future<HealthReading> _relayReachable(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.cloudRelay);

MobileSession _seeded() => const MobileSession(
  token: 'tok-seeded-00000000000000000000',
  endpoint: 'http://192.168.1.5:41879',
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-seed',
  pcId: 'pc-1',
);

/// Mounts the real instance list over the real controller, with the presence
/// answer supplied as [reading] — i.e. the state the wire test proved the
/// production probe produces for that JSON.
Future<void> _mount(WidgetTester tester, PcPresenceReading reading) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.en);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_seeded());
  final PttSession session = PttSession(
    transport: FakeSocketTransport(),
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final ConnectionsController c = ConnectionsController(
    session: session,
    login: newTestLogin(transport: session.transport),
    healthReader: _relayReachable,
    presenceReader: (Uri u, String t, Duration d) async => reading,
  );
  await tester.pumpWidget(
    MaterialApp(
      home: ConnectionsPage(
        connections: c,
        appSettings: appSettings,
        login: c.login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Unmount, so the page's periodic re-probe timer is cancelled before teardown.
Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('GONE'))));
  await tester.pumpAndSettle();
}

void main() {
  const AppStrings s = AppStringsEn();

  testWidgets('🔴 an auth_expired absence renders "PC signed out", not "PC is offline"', (
    WidgetTester tester,
  ) async {
    await _mount(
      tester,
      const PcPresenceReading(
        presence: PcPresence.offline,
        pcId: 'pc-1',
        absentReason: PcAbsentReason.authExpired,
      ),
    );
    expect(find.text(s.pcSignedOutChip), findsOneWidget);
    // 🔴 And the sentence it REPLACES is nowhere on screen. Without this line
    // the test would pass on a row that said both things at once, which is what
    // a half-finished branch actually produces.
    expect(find.text(s.pcOfflineChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('an absence with no reason still renders "PC is offline"', (
    WidgetTester tester,
  ) async {
    // The negative control. Without it, the test above could be passing because
    // EVERY absence now says 「signed out」.
    await _mount(
      tester,
      const PcPresenceReading(presence: PcPresence.offline, pcId: 'pc-1'),
    );
    expect(find.text(s.pcOfflineChip), findsOneWidget);
    expect(find.text(s.pcSignedOutChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('an ONLINE row is untouched by the new face', (
    WidgetTester tester,
  ) async {
    await _mount(
      tester,
      const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-1'),
    );
    // ⚠️ `findsWidgets`, not `findsOneWidget`: measured — there are TWO online
    // rows on this page, the seeded PC and the cloud light-record entry, whose
    // whole meaning is 「中继可达」 ("the relay can be reached") and which owner
    // ruled must not be asked about a PC at all. Pinning "exactly one" would be
    // pinning the number of rows in this fixture, not a product fact.
    expect(find.text(s.online), findsWidgets);
    expect(find.text(s.pcSignedOutChip), findsNothing);
    expect(find.text(s.pcOfflineChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('the guide sheet teaches the new word, next to the one it splits from', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: InstanceGuideBody(strings: s))),
    );
    await tester.pumpAndSettle();
    expect(find.text(s.pcSignedOutChip), findsOneWidget);
    expect(find.text(s.guideStatusPcSignedOut), findsOneWidget);
    // Both absences are explained, and they are explained differently.
    expect(find.text(s.pcOfflineChip), findsOneWidget);
    expect(find.text(s.guideStatusPcOffline), findsOneWidget);
  });

  test('the guide sheet lists the new face — a seventh word cannot go unrendered', () {
    expect(kGuideStatusOrder, contains(InstanceLivenessFace.pcSignedOut));
    expect(kGuideStatusOrder.toSet(), InstanceLivenessFace.values.toSet());
    // The guide prints the SAME word the row prints, never a second copy.
    expect(
      guideStatusLabel(s, InstanceLivenessFace.pcSignedOut),
      s.pcSignedOutChip,
    );
  });

  test('🔴 the copy exists in every locale, and is nowhere an English placeholder', () {
    for (final AppLocale loc in AppLocale.values) {
      final AppStrings t = AppStrings.of(loc);
      expect(t.pcSignedOutChip, isNotEmpty, reason: '$loc');
      expect(t.guideStatusPcSignedOut, isNotEmpty, reason: '$loc');
      // 🔴 It must not be the SAME sentence as the absence it was split from —
      // that would be two words with one meaning, the defect wearing a second
      // name.
      expect(t.pcSignedOutChip, isNot(t.pcOfflineChip), reason: '$loc');
      expect(t.guideStatusPcSignedOut, isNot(t.guideStatusPcOffline), reason: '$loc');
      if (loc != AppLocale.en) {
        // A locale that silently inherits English reads as finished work and is
        // not. The generator's own coverage report is the other half of this.
        expect(t.pcSignedOutChip, isNot(s.pcSignedOutChip), reason: '$loc');
        expect(
          t.guideStatusPcSignedOut,
          isNot(s.guideStatusPcSignedOut),
          reason: '$loc',
        );
      }
    }
  });

  test('🔴 the guide line names the fix AND where it has to be done', () {
    // The whole reason this face exists: the action is on the other machine. A
    // sentence that only said 「登录失效了」 ("the sign-in lapsed") would be true
    // and useless.
    expect(s.guideStatusPcSignedOut.toLowerCase(), contains('cloud key'));
    expect(s.guideStatusPcSignedOut.toLowerCase(), contains('computer'));
  });
}
