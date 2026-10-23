// Card E-M (docs/rebuild/18 §2.6, design
// docs/strategy/2026-10-10-login-renewal-design.md §3) — the phone checks its
// stored account credential's `exp` at launch, with the same 300 s tolerance
// the desktop uses (`CLOCK_SKEW_SECS`, apps/desktop/src-tauri/src/socket/
// channel.rs). Before this card `hydrate()` restored an expired credential as
// signed in, and the user found out only when a cloud action failed.
//
// The JWTs below are built in the server's own shape (auth/jwt.ts: base64url
// header . base64url {sub, plan, iat, exp} . signature, `exp` in SECONDS). The
// signature is junk on purpose: the phone cannot verify it (it has no secret)
// and must not pretend to — it only reads `exp`.

import 'dart:convert';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

String _seg(Map<String, Object?> m) =>
    base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');

String _jwt({required int expSec}) =>
    '${_seg(<String, Object?>{'alg': 'HS256', 'typ': 'JWT'})}.'
    '${_seg(<String, Object?>{'sub': 'u1', 'plan': 'free', 'iat': expSec - 7776000, 'exp': expSec})}.'
    'c2lnbmF0dXJl';

int _nowSec() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

CloudAccount _acct(String jwt) =>
    CloudAccount(jwt: jwt, email: 'fang@example.com', plan: 'free');

Future<(LoginController, InMemoryAccountStore)> _hydrated(String jwt) async {
  final InMemoryAccountStore store = InMemoryAccountStore(_acct(jwt));
  final LoginController c = LoginController(
    transport: FakeSocketTransport(),
    accountStore: store,
    saasEndpoint: 'https://saas.test:443',
  );
  await c.hydrate();
  // handleAuthExpired clears the store without awaiting; let it land.
  await Future<void>.delayed(Duration.zero);
  return (c, store);
}

void main() {
  test('launch with a credential past exp + 300 s ⇒ signed out, expired code, '
      'store cleared', () async {
    final (LoginController c, InMemoryAccountStore store) =
        await _hydrated(_jwt(expSec: _nowSec() - 301 - 5));
    expect(c.isLoggedIn, isFalse);
    expect(c.jwt, isNull);
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.tokenExpired);
    expect(await store.read(), isNull,
        reason: 'a dead JWT left on disk is resurrected by the next launch');
  });

  test('inside the 300 s tolerance the credential is still trusted (the '
      'server judges)', () async {
    final (LoginController c, InMemoryAccountStore store) =
        await _hydrated(_jwt(expSec: _nowSec() - 100));
    expect(c.isLoggedIn, isTrue);
    expect(c.phase, LoginPhase.success);
    expect(await store.read(), isNotNull);
  });

  test('a credential with time left, and one whose exp cannot be read, both '
      'stay signed in', () async {
    final (LoginController live, _) =
        await _hydrated(_jwt(expSec: _nowSec() + 86400));
    expect(live.isLoggedIn, isTrue);
    // Not a JWT at all: the phone cannot tell, so it does not guess — the
    // first server call that needs the account will answer.
    final (LoginController opaque, _) = await _hydrated('jwt-opaque');
    expect(opaque.isLoggedIn, isTrue);
  });

  // ⑥ — the deliverable is what the user SEES. The resting 「signed out,
  // because it expired」 line lives on the settings screen's Notes/cloud row
  // (`settings_page.dart`, `!loggedIn && phase == error` ⇒
  // `s.loginError(login.errorCode)`); the sign-in sheet clears the error when it
  // opens, so it is not where this sentence is read. Mount the settings screen
  // over the controller the launch check left behind.
  testWidgets('the settings screen shows signed-out with the EXISTING expired '
      'sentence after an expired launch', (WidgetTester tester) async {
    late LoginController login;
    late PttSession session;
    late AppSettingsController appSettings;
    late ScenarioCardController scenario;
    await tester.runAsync(() async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      appSettings =
          AppSettingsController(prefs: await SharedPreferences.getInstance());
      await appSettings.load();
      scenario = ScenarioCardController(cache: InMemoryScenarioCardCache());
      await scenario.load();
      session = newTestSession(
        transport: FakeSocketTransport(),
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      login = newTestLogin(
        transport: session.transport,
        accountStore: InMemoryAccountStore(
          _acct(_jwt(expSec: _nowSec() - 3600)),
        ),
      );
      await login.hydrate();
      await Future<void>.delayed(Duration.zero);
    });
    final DestinationController destination = DestinationController();
    await tester.pumpWidget(
      MaterialApp(
        home: SettingsPage(
          notesAction: SettingsNotesAction.enter,
          scenario: scenario,
          appSettings: appSettings,
          login: login,
          destination: destination,
          session: session,
          portable: newTestPortableController(),
          prefs: newTestPrefsController(),
          backup: newTestSettingsBackup(),
          inventory: newTestInventory(
            rows: const <TimelineEntry>[],
            images: InMemoryOutboxBlobStore(),
          ),
          timeline: newTestStore(),
          version: const FixedAppVersion('0.0.0-test'),
          update: newTestUpdateController(),
          cloudSummary: newTestCloudSummary(login: login),
        ),
      ),
    );
    await tester.pump();
    final AppStrings s = AppStrings.of(appSettings.locale);
    // Positive control: the cloud row is on screen.
    expect(find.byKey(const ValueKey<String>('settings.notes.sub')),
        findsOneWidget);
    expect(find.text(s.loginError(LoginErrorCodes.tokenExpired)),
        findsOneWidget);
    expect(login.isLoggedIn, isFalse);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(() async {
      login.dispose();
      scenario.dispose();
      appSettings.dispose();
      destination.dispose();
      await session.dispose();
    });
  });

  // ── 「sign out only if the refused credential is the one stored」 ──────────
  test('a refusal of a credential that is NOT the stored one signs nobody out',
      () async {
    final String stored = _jwt(expSec: _nowSec() + 86400);
    final (LoginController c, InMemoryAccountStore store) =
        await _hydrated(stored);
    c.handleAuthExpired(refusedJwt: _jwt(expSec: _nowSec() - 10));
    await Future<void>.delayed(Duration.zero);
    expect(c.isLoggedIn, isTrue);
    expect(c.errorCode, isNull);
    expect(await store.read(), isNotNull);
    // Positive control: the SAME refusal about the stored one does sign out.
    c.handleAuthExpired(refusedJwt: stored);
    await Future<void>.delayed(Duration.zero);
    expect(c.isLoggedIn, isFalse);
    expect(c.errorCode, LoginErrorCodes.tokenExpired);
  });
}
