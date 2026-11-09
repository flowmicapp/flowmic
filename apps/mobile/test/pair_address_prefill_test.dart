// FR-M2 / D-MKT-3 — what the manual pairing form offers, on the real screen.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §4 「手动配对表单的地址预填」;
// docs/marketing/05b-defects-found.md D-MKT-3.
//
// THE CAUSE, FROM CODE, WHICH IS NOT QUITE WHAT THE DEFECT REPORT READ. The form
// has no https default. It pre-fills `pairings.first.endpoint`, and a row whose key
// is pinned stores `https://…` because `pair()` persists `httpBaseOf(dial)` and the
// dial was upgraded to TLS by the product itself. Handing that back in the box makes
// `_tofuFingerprintFor` read it as a person asking for system-verified TLS by name,
// which a self-signed sidecar certificate can never pass. A fresh install has no
// row, so it opens on the cloud segment with an empty LAN box and never sees this.
//
// The two real TLS facts (the bare address really does end up on pinned TLS; a typed
// https:// really is refused and not downgraded) are measured with the real stack in
// `lan_manual_https_real_handshake_test.dart`. This file is the form.

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
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

Future<HealthReading> _offline(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

/// A LAN row as `pair()` really leaves it after a QR or TOFU pairing.
const String _fp = 'BBBBBBBBBBBBBBBBBBBBBBBB';
const MobileSession _pinnedRow = MobileSession(
  token: 'tok-pinned-00000000000000000000',
  endpoint: 'https://100.64.7.68:41879',
  channel: 'standalone',
  pcName: 'Test PC',
  pairingId: 'pair-pinned',
  lanTlsFp: _fp,
  lanTlsFpSource: LanPinSource.qr,
);

/// A row a person typed `https://` for: no pin, and the https is theirs.
const MobileSession _typedHttpsRow = MobileSession(
  token: 'tok-typed-000000000000000000000',
  endpoint: 'https://relay.example.test:8443',
  channel: 'standalone',
  pcName: 'Self hosted',
  pairingId: 'pair-typed',
);

/// Opens the real sheet from the real page and returns the address box's text.
Future<String> _addressOffered(
  WidgetTester tester,
  List<MobileSession> seed,
) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController settings = AppSettingsController(prefs: prefs);
  addTearDown(settings.dispose);
  await settings.load();
  settings.setLocale(AppLocale.en);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  for (final MobileSession s in seed) {
    await storage.addOrUpdatePairing(s);
  }
  final PttSession session = PttSession(
    transport: FakeSocketTransport()..connectSucceeds = true,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  tester.view.physicalSize = const Size(800, 2000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: ConnectionsPage(
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
    ),
  ));
  await tester.pumpAndSettle();
  final AppStrings s = AppStrings.of(AppLocale.en);
  await tester.tap(find.text(s.addDevice));
  await tester.pumpAndSettle();
  await tester.tap(find.text(s.pairTabManual));
  await tester.pumpAndSettle();
  final TextField box = tester.widget<TextField>(find.byType(TextField).first);
  return box.controller!.text;
}

void main() {
  testWidgets('a pinned row: the box offers host:port, not the https the product '
      'added itself', (WidgetTester tester) async {
    final String offered =
        await _addressOffered(tester, const <MobileSession>[_pinnedRow]);
    // Negative with a positive control: the address itself is still offered, so
    // an empty box cannot pass this.
    expect(offered, contains('100.64.7.68:41879'));
    expect(offered, isNot(startsWith('https://')));
    expect(offered, isNot(startsWith('http://')),
        reason: 'the form must not claim a scheme: the dial decides, on what '
            'the computer actually presents');
  });

  testWidgets('an unpinned https row keeps its https: that one the person asked for',
      (WidgetTester tester) async {
    final String offered =
        await _addressOffered(tester, const <MobileSession>[_typedHttpsRow]);
    expect(offered, 'https://relay.example.test:8443');
  });

  testWidgets('a fresh install: no row, the LAN box starts empty',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    // The sheet opens on the cloud segment, whose first text field is the PCID.
    // What matters is that no https address is offered anywhere on the form.
    final String offered = await _addressOffered(tester, const <MobileSession>[]);
    expect(offered, isNot(contains('://')));
    expect(find.textContaining('https://'), findsNothing);
    expect(find.text(AppStrings.of(AppLocale.en).pairTabManual), findsOneWidget,
        reason: 'positive control: the form is the thing on screen');
  });
}
