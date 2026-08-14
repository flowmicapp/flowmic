// A2 device-found (2026-08-11, dev-pc-a + TB335ZC):
// After login the remembered saas row retires the dashed cloud entry card
// (GA-33). 「登出」 lived only on that card ⇒ signed-in users with a cloud
// session had NO sign-out control on the connections page (uiautomator: zero
// `text="登出"` nodes; tapping 轻记录 only re-entered chat).
//
// Fix: the same CloudSignOutRow also mounts on the saas pairing row.
// Reverse control: seed saas WITHOUT logging in ⇒ 登出 must stay absent
// (CloudSignOutRow shrinks when !isLoggedIn).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

MobileSession _saasRow() => const MobileSession(
      token: 'tok-cloud-000000000000000000000',
      endpoint: 'https://flowmic.app',
      channel: 'saas',
      pcName: 'FlowMic Cloud',
      pairingId: 'pair-cloud',
    );

Future<Widget> _page({
  required FakeSocketTransport t,
  required LoginController login,
  List<MobileSession> seed = const <MobileSession>[],
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  for (final MobileSession s in seed) {
    await storage.addOrUpdatePairing(s);
  }
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport()..connectSucceeds = false,
  );
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    presenceReader: (Uri url, String token, Duration timeout) async =>
        PcPresenceReading.unknown,
  );
  return MaterialApp(
    home: ConnectionsPage(
      connections: connections,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
    ),
  );
}

void main() {
  testWidgets(
    'A2: signed-in + remembered saas row still shows 登出 (GA-33 host move)',
    (WidgetTester tester) async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      final InMemoryAccountStore store = InMemoryAccountStore();
      final LoginController login = LoginController(
        transport: t,
        accountStore: store,
        saasEndpoint: 'https://saas.test:443',
      );
      t.ackQueue.add(<String, Object?>{
        'ok': true,
        'token': 'jwt-a2',
        'user': <String, Object?>{'email': 'a2@flowmic.test', 'id': 'u-a2'},
        'mode': 'saas',
      });
      await login.login(email: 'a2@flowmic.test', password: 'secret12ab');
      expect(login.isLoggedIn, isTrue);

      await tester.binding.setSurfaceSize(const Size(400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(await _page(t: t, login: login, seed: <MobileSession>[_saasRow()]));
      await tester.pumpAndSettle();

      // Dashed entry retired; row remains. Labels are zh by default in tests
      // that don't override AppSettings language.
      expect(find.text('轻记录'), findsOneWidget);
      expect(find.text('登出'), findsOneWidget);
      expect(find.text('a2@flowmic.test'), findsOneWidget);
    },
  );

  testWidgets(
    'reverse: saas row without login must NOT show 登出',
    (WidgetTester tester) async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      final LoginController login = LoginController(
        transport: t,
        accountStore: InMemoryAccountStore(),
        saasEndpoint: 'https://saas.test:443',
      );
      expect(login.isLoggedIn, isFalse);

      await tester.binding.setSurfaceSize(const Size(400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(await _page(t: t, login: login, seed: <MobileSession>[_saasRow()]));
      await tester.pumpAndSettle();

      expect(find.text('登出'), findsNothing);
    },
  );
}
