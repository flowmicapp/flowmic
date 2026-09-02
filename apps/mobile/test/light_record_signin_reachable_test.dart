// 🔴 P0 (owner, 2026-09-02, iPhone on 0.3.55) — TAPPING THE 轻记录 CARD SHOWED
// 「登录失效，请重新登录」 AT THE BOTTOM OF THE SCREEN AND NOTHING ELSE EVER
// HAPPENED. The sign-in sheet never opened; tapping again produced the same
// sentence. Reported as working on the same build on Android.
//
// ── WHAT THE SENTENCE IS ───────────────────────────────────────────────────
// `AppStrings.cloudError`'s account arms — 「登录已过期，请重新登录」
// (AUTH_TOKEN_EXPIRED) and 「登录状态无效，请重新登录」 (AUTH_TOKEN_INVALID).
// Its ONE renderer on this screen is `connections_page._rowErrorCopy`, toasted
// from `_connect`.
//
// ── WHY IT COULD NOT BE OBEYED ─────────────────────────────────────────────
// `showLoginSheet` is called from exactly one place on this page, `_openCloud`,
// and `_openCloud` is wired to the dashed cloud card — which `_body` STOPS
// RENDERING the moment a `channel == 'saas'` row exists (GA-33). So a phone
// that is signed out while still holding a remembered light-record row has a
// tap that can only fail and a sentence it cannot act on.
//
// ── HOW A PHONE GETS INTO THAT STATE ───────────────────────────────────────
// Not by signing out: `ConnectionsController.signOutCloud` purges every `saas`
// row along with the account. It gets there through
// `LoginController.handleAuthExpired`, which clears the account and
// DELIBERATELY leaves the rows alone (its own note, and `signOutCloud`'s ⚠️).
// One refused ack — `enterCloud`'s AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID
// branch in connections_controller.dart — is the whole entry price, and there
// was no exit.
//
// ⚠️ WHAT THIS FILE DOES NOT CLAIM. It does not explain why the iPhone's ack was
// refused and the Android's was not; that is a question about one device's
// stored credential, and nothing in a widget test can answer it. What it pins is
// the half that is a defect on every platform: once the account is what is
// missing, this screen must lead to the screen that fixes it.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/cloud_readmit.dart' show kHandshakeTokenInvalid;
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketHandshakeException;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

/// Refuses the next [armed] handshakes with [err], then behaves normally.
///
/// Copied in shape (not by import) from cloud_row_readmit_test.dart's fixture,
/// including the reason `armed` is set by the TEST immediately before the tap:
/// `login()` dials this same transport, so arming at construction spends the
/// refusal on the sign-in and leaves the assertions about nothing.
class _RefusesNextConnect extends FakeSocketTransport {
  _RefusesNextConnect(this.err);
  final String err;
  int armed = 0;
  int fired = 0;

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    if (armed > 0) {
      armed--;
      fired++;
      setLastConnectError(err);
      throw SocketHandshakeException(err);
    }
    await super.connect(url: url, token: token, jwt: jwt, pinFingerprint: pinFingerprint);
  }
}

MobileSession _cloudRow() => MobileSession(
  token: 'fm_${'0' * 64}',
  endpoint: 'https://saas.test:443',
  channel: 'saas',
  pcName: 'FlowMic Cloud',
  pairingId: 'p-cloud',
  pcInstanceId: 'flowmic-cloud-instance',
);

const MobileSession _lanRow = MobileSession(
  token: 'tok-lan-000000000000000000000000',
  endpoint: 'http://192.168.1.5:41879',
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-lan',
);

class _Rig {
  _Rig(this.widget, this.login, this.transport);
  final Widget widget;
  final LoginController login;
  final _RefusesNextConnect transport;
}

Future<_Rig> _rig(MobileSession seed, {String handshakeError = kHandshakeTokenInvalid}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final _RefusesNextConnect t = _RefusesNextConnect(handshakeError)..connectSucceeds = true;
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(seed);
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  final LoginController login = LoginController(
    transport: t,
    accountStore: InMemoryAccountStore(),
    saasEndpoint: 'https://saas.test:443',
  );
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    saasEndpoint: 'https://saas.test:443',
    healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    presenceReader: (Uri u, String tok, Duration d) async => PcPresenceReading.unknown,
  );
  return _Rig(
    MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
        updateListenable: ValueNotifier<bool>(false),
        hasUpdate: () => false,
      ),
    ),
    login,
    t,
  );
}

/// Sign the rig's controller in through the real ack path.
Future<void> _signIn(_Rig r) async {
  r.transport.ackQueue.add(<String, Object?>{
    'ok': true,
    'token': 'jwt-abc',
    'user': <String, Object?>{'id': 'u1', 'email': 'fang@example.com', 'plan': 'free'},
    'mode': 'saas',
  });
  await r.login.login(email: 'fang@example.com', password: 'secret12');
}

/// The sheet's own control, not a sentence: `login.browser.start` is the button
/// `_LoginSheet` builds and nothing else in this app does. Asserting a KEY
/// rather than the title text means a copy edit cannot silently make this test
/// stop testing anything.
final Finder _loginSheet = find.byKey(const ValueKey<String>('login.browser.start'));

void main() {
  final AppStrings zh = AppStrings(AppLocale.zh);
  final Finder cloudCard = find.text(zh.cloudInstance);

  group('the light-record row leads to the sign-in it asks for', () {
    testWidgets('signed out ⇒ the tap opens the sign-in sheet', (WidgetTester tester) async {
      final _Rig r = await _rig(_cloudRow());
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      expect(r.login.isLoggedIn, isFalse, reason: 'positive control: this is the signed-out state');

      await tester.tap(cloudCard.first);
      await tester.pumpAndSettle();

      // 🔴 THE DEFECT, as the owner read it off the screen: a sentence telling
      // them to sign in, on a screen with no way to sign in.
      expect(_loginSheet, findsOneWidget,
          reason: 'the row whose only credential is the account must reach the account screen');
      expect(find.text(zh.cloudError('AUTH_TOKEN_INVALID')), findsNothing);
      expect(find.text(zh.cloudError('AUTH_TOKEN_EXPIRED')), findsNothing);
      // The dial is not merely redundant here — with no account there is nothing
      // to resume WITH, so a frame that could only be refused never leaves.
      expect(r.transport.fired, 0);
    });

    testWidgets('the account ending MID-TAP still lands on the sheet', (WidgetTester tester) async {
      final _Rig r = await _rig(_cloudRow());
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      await _signIn(r);
      expect(r.login.isLoggedIn, isTrue);

      // The handshake refuses the DEVICE credential, so `shouldReadmitCloudRow`
      // re-admits from the account — and the relay refuses the account. That ack
      // is what drives `handleAuthExpired`, i.e. the phone is signed out by the
      // very tap that is being handled.
      r.transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_EXPIRED'});
      r.transport.armed = 1;

      await tester.tap(cloudCard.first);
      await tester.pumpAndSettle();

      expect(r.transport.fired, 1, reason: 'positive control: the refusal this test is about happened');
      expect(r.login.isLoggedIn, isFalse, reason: 'positive control: the tap really did clear the account');
      expect(_loginSheet, findsOneWidget);
    });

    testWidgets('cancelling the sheet leaves the list, not a dead end',
        (WidgetTester tester) async {
      // 🔴 THE LOOP, as the owner met it: the defect was never one bad sentence,
      // it was that no sequence of taps could leave this screen. Tap → sheet.
      // Back out (`login.close` pops false, `_openCloud`'s 「the user backed
      // out」 arm) → the list, SILENTLY: a cancelled tap is not a failure and
      // must not earn a sentence. Tap again → the sheet again, every time.
      final _Rig r = await _rig(_cloudRow());
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();

      for (int attempt = 0; attempt < 2; attempt++) {
        await tester.tap(cloudCard.first);
        await tester.pumpAndSettle();
        expect(_loginSheet, findsOneWidget, reason: 'attempt $attempt');
        await tester.tap(find.byKey(const ValueKey<String>('login.close')));
        await tester.pumpAndSettle();
        expect(_loginSheet, findsNothing, reason: 'attempt $attempt');
        expect(find.byType(SnackBar), findsNothing, reason: 'attempt $attempt');
        expect(cloudCard, findsWidgets, reason: 'attempt $attempt');
      }
      expect(r.transport.fired, 0);
    });
  });

  // ── 🔴 REVERSE CONTROLS ────────────────────────────────────────────────────

  group('reverse control — the sheet is only for the row the account owns', () {
    testWidgets('a LAN row refused at the handshake toasts, and opens nothing',
        (WidgetTester tester) async {
      final _Rig r = await _rig(_lanRow);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      r.transport.armed = 1;

      await tester.tap(find.text('Studio PC').first);
      await tester.pumpAndSettle();

      expect(r.transport.fired, 1, reason: 'positive control: the refusal this test is about happened');
      // A PC pairing answers to that PC's own table. Sending its owner to a
      // sign-in screen would answer a pairing question with an account screen.
      expect(_loginSheet, findsNothing);
      expect(find.text(zh.pairError(kHandshakeTokenInvalid)), findsOneWidget);
    });

    testWidgets('「this node could not verify you」 is never told as 「your sign-in expired」',
        (WidgetTester tester) async {
      // AUTH_TOKEN_UNVERIFIABLE exists precisely because a replica's local miss
      // is a MAYBE (apps/server-core/src/auth/middleware.ts, `resolveDetailed`).
      // The account is untouched, so neither the sign-in sheet nor either
      // sign-in sentence may appear.
      final _Rig r = await _rig(_cloudRow(), handshakeError: 'AUTH_TOKEN_UNVERIFIABLE');
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      await _signIn(r);
      r.transport.armed = 1;

      await tester.tap(cloudCard.first);
      await tester.pumpAndSettle();

      expect(r.transport.fired, 1, reason: 'positive control: the refusal this test is about happened');
      expect(r.login.isLoggedIn, isTrue, reason: 'a node that says it cannot tell must not end a session');
      expect(_loginSheet, findsNothing);
      expect(find.text(zh.cloudError('AUTH_TOKEN_EXPIRED')), findsNothing);
      expect(find.text(zh.cloudError('AUTH_TOKEN_INVALID')), findsNothing);
      // POSITIVE CONTROL — a sentence WAS shown; the three assertions above are
      // about which one, not about a screen that stayed silent.
      expect(find.text(zh.cloudError('AUTH_TOKEN_UNVERIFIABLE')), findsOneWidget);
    });
  });
}
