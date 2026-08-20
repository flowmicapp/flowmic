// The other half of pc_other_account_wire_test.dart and of
// presence_failure_attribution_wire_test.dart: that the two new words actually
// reach the SCREEN, and that the sentences they replace are not still sitting
// next to them.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/connections_row_faces.dart (`_statusLabelRouted`)
//   apps/mobile/lib/src/ui/guide/instance_guide_sheet.dart (`kGuideStatusOrder`)
//   apps/mobile/lib/src/settings/strings/connection_strings.dart
//     ([ConnectionStrings.pcOtherAccountChip] / [pairingRevokedChip])
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
// `HttpClient` in the same file silently dials a double (measured — see
// pc_signed_out_wire_test.dart's header, where this repo recorded paying for it
// the second time).
//
// ── REVERSE CONTROL (executed 2026-08-17, observed — not reasoned) ──────────
// Break ①: in `_statusLabelRouted` (connections_row_faces.dart), point the
// `pcOtherAccount` arm at `s.pcOfflineChip` — the reason is parsed, the face is
// chosen, and the user is told the old sentence anyway. This is the more
// dangerous half of the defect, because every enum-level test stays green.
// Observed:
//   '🔴 a reassigned machine renders "PC on another account", not "PC is offline"'
//     Expected: exactly one matching candidate
//       Actual: _TextWidgetFinder:<Found 0 widgets with text "PC on another
//               account": []>
//   — i.e. the row is back to telling this user their computer is offline while
//   it sits there powered on, in a room, working for somebody else.
// ⚠️ Control on the control: pc_other_account_wire_test.dart stayed GREEN under
// this break (5/5). The wire, the parse and the face were all still correct —
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
/// answer supplied as [reading] — i.e. the state the wire tests proved the
/// production probe produces for that response.
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
        updateListenable: ValueNotifier<bool>(false),
        hasUpdate: () => false,
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

  testWidgets('🔴 a reassigned machine renders "PC on another account", not "PC is offline"', (
    WidgetTester tester,
  ) async {
    await _mount(
      tester,
      const PcPresenceReading(
        presence: PcPresence.offline,
        pcId: 'pc-1',
        absentReason: PcAbsentReason.machineReassigned,
      ),
    );
    expect(find.text(s.pcOtherAccountChip), findsOneWidget);
    // 🔴 And the two sentences it must not be confused with are nowhere on
    // screen. Without these lines the test would pass on a row that said both
    // things at once, which is what a half-finished branch actually produces.
    expect(find.text(s.pcOfflineChip), findsNothing);
    expect(find.text(s.pcSignedOutChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('🔴 THE DISTINCTION: an absence with no reason still renders "PC is offline"', (
    WidgetTester tester,
  ) async {
    // The negative control. Without it, the test above could be passing because
    // EVERY absence now says 「another account」 — and that implementation would
    // tell every person whose computer is switched off to go and re-pair.
    await _mount(
      tester,
      const PcPresenceReading(presence: PcPresence.offline, pcId: 'pc-1'),
    );
    expect(find.text(s.pcOfflineChip), findsOneWidget);
    expect(find.text(s.pcOtherAccountChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('an auth_expired absence is untouched by the new face', (
    WidgetTester tester,
  ) async {
    // The second negative control: the face that was already there still gets
    // its own sentence. Three absences, three sentences.
    await _mount(
      tester,
      const PcPresenceReading(
        presence: PcPresence.offline,
        pcId: 'pc-1',
        absentReason: PcAbsentReason.authExpired,
      ),
    );
    expect(find.text(s.pcSignedOutChip), findsOneWidget);
    expect(find.text(s.pcOtherAccountChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('🔴 a revoked pairing renders "Pairing removed", not "PC status unknown"', (
    WidgetTester tester,
  ) async {
    await _mount(tester, const PcPresenceReading.pairingGone());
    expect(find.text(s.pairingRevokedChip), findsOneWidget);
    // 🔴 The sentence this replaces, and the one the owner actually saw. It must
    // be gone: 「未知」 asks the user to wait for something that has already
    // happened.
    expect(find.text(s.relayUpPcUnknown), findsNothing);
    await _unmount(tester);
  });

  testWidgets('🔴 THE DISTINCTION: an ordinary unanswered question still says "unknown"', (
    WidgetTester tester,
  ) async {
    // The negative control for the case above. A question that went unanswered
    // is still 「we did not get an answer」 — and if THIS started saying 「pairing
    // removed」, every user on a flaky train would be told to re-pair a pairing
    // that is perfectly fine.
    //
    // ⚠️ `notFound` rather than `timeout`, and the reason is mechanical rather
    // than semantic: a RETRYABLE miss makes `readPcPresenceRetrying` schedule
    // its backoff timer, which `pumpAndSettle` does not drain (it is a Timer in
    // an async gap, not a scheduled frame) — measured here, as
    // 「A Timer is still pending even after the widget tree was disposed」. The
    // failure classes are covered on the wire side; what this case is about is
    // the SENTENCE, and any unanswered question produces the same one.
    await _mount(
      tester,
      const PcPresenceReading.unanswered(PcPresenceMiss.notFound),
    );
    expect(find.text(s.relayUpPcUnknown), findsOneWidget);
    expect(find.text(s.pairingRevokedChip), findsNothing);
    await _unmount(tester);
  });

  testWidgets('the guide sheet teaches both new words, next to the ones they split from', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: InstanceGuideBody(strings: s))),
    );
    await tester.pumpAndSettle();
    expect(find.text(s.pcOtherAccountChip), findsOneWidget);
    expect(find.text(s.guideStatusPcOtherAccount), findsOneWidget);
    expect(find.text(s.pairingRevokedChip), findsOneWidget);
    // 🔴 The revoked-pairing line is the sentence the reconnect path already
    // uses for this fact — one translation of one fact, not a second copy.
    expect(find.text(s.pairError('AUTH_TOKEN_INVALID')), findsOneWidget);
    // …and every absence it sits beside is still explained, differently.
    expect(find.text(s.guideStatusPcOffline), findsOneWidget);
    expect(find.text(s.guideStatusPcSignedOut), findsOneWidget);
    expect(find.text(s.guideStatusRelayOnly), findsOneWidget);
  });

  test('the guide lists both new faces — a ninth word cannot go unrendered', () {
    expect(kGuideStatusOrder, contains(InstanceLivenessFace.pcOtherAccount));
    expect(kGuideStatusOrder, contains(InstanceLivenessFace.pairingRevoked));
    expect(kGuideStatusOrder.toSet(), InstanceLivenessFace.values.toSet());
    // The guide prints the SAME word the row prints, never a second copy.
    expect(
      guideStatusLabel(s, InstanceLivenessFace.pcOtherAccount),
      s.pcOtherAccountChip,
    );
    expect(
      guideStatusLabel(s, InstanceLivenessFace.pairingRevoked),
      s.pairingRevokedChip,
    );
  });

  test('🔴 the copy exists in every locale, and is nowhere an English placeholder', () {
    for (final AppLocale loc in AppLocale.values) {
      final AppStrings t = AppStrings.of(loc);
      expect(t.pcOtherAccountChip, isNotEmpty, reason: '$loc');
      expect(t.guideStatusPcOtherAccount, isNotEmpty, reason: '$loc');
      expect(t.pairingRevokedChip, isNotEmpty, reason: '$loc');
      // 🔴 None of the three may be the SAME sentence as anything it was split
      // from — that would be several words with one meaning, the defect wearing
      // another name.
      expect(t.pcOtherAccountChip, isNot(t.pcOfflineChip), reason: '$loc');
      expect(t.pcOtherAccountChip, isNot(t.pcSignedOutChip), reason: '$loc');
      expect(t.pairingRevokedChip, isNot(t.relayUpPcUnknown), reason: '$loc');
      expect(
        t.guideStatusPcOtherAccount,
        isNot(t.guideStatusPcSignedOut),
        reason: '$loc',
      );
      if (loc != AppLocale.en) {
        // A locale that silently inherits English reads as finished work and is
        // not. The generator's own coverage report is the other half of this.
        expect(t.pcOtherAccountChip, isNot(s.pcOtherAccountChip), reason: '$loc');
        expect(
          t.guideStatusPcOtherAccount,
          isNot(s.guideStatusPcOtherAccount),
          reason: '$loc',
        );
        expect(t.pairingRevokedChip, isNot(s.pairingRevokedChip), reason: '$loc');
      }
    }
  });

  test('🔴 the guide line is a SENTENCE in every locale, not a second label', () {
    // The chip has room for a label; the GUIDE line is where the fix is named. A
    // translation that shipped the diagnosis without the instruction would leave
    // the user correctly informed and with nothing to do — which is the exact
    // failure 「电脑已离线」 was.
    //
    // ⚠️ WHAT THIS DELIBERATELY DOES NOT DO, and it was written the other way
    // first: a table of `AppLocale -> expected substring` (「请重新配对」,
    // 'Pair again', 'Appairez'…) is the most direct assertion available, and it
    // is exactly what `verify/lint/i18n-add-locale-cost.mjs` refuses — a
    // hand-rolled locale list makes adding language ten mean editing a test
    // table, which is the cost the locale architecture (2026-08-14 §2) exists to
    // remove. The gate caught it here on the first run. What replaces it is
    // language-neutral and still catches the failure that matters: a locale that
    // shipped only the diagnosis, or that copied the chip into the guide slot.
    for (final AppLocale loc in AppLocale.values) {
      final AppStrings t = AppStrings.of(loc);
      final String line = t.guideStatusPcOtherAccount;
      expect(line, isNot(t.pcOtherAccountChip), reason: '$loc');
      // A label is a noun phrase; this line has to carry a cause, an
      // instruction and a reassurance. Three times the chip is a low bar that a
      // one-clause translation still fails — measured across the nine authored
      // strings, the tightest is comfortably above it.
      expect(
        line.length,
        greaterThan(t.pcOtherAccountChip.length * 3),
        reason: '$loc: $line',
      );
      // …and it ends as a sentence does. Every script in the registry is
      // covered: the Latin/Cyrillic full stop and the CJK 。 are the two
      // terminators this catalogue uses.
      expect(
        line.endsWith('.') || line.endsWith('。'),
        isTrue,
        reason: '$loc: $line',
      );
    }
  });
}
