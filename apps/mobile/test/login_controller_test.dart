// WP-R4-2 ① — SaaS login is now a REAL admission (WP-R4-1 server is live, its
// wire frozen). login() dials the SaaS endpoint, emits mobile:login and enters
// success ONLY on an explicit ok ack; the JWT + PUBLIC user are persisted, the
// PASSWORD never is. A wrong credential, a per-IP throttle, and an expired token
// each surface a DISTINCT fail-loud code. SPEC-REF: R4-PRIVATE-TASK-CARDS
// WP-R4-2 ① + frozen wire contract; CLAUDE.md no silent failure / password never lands in storage.

import 'dart:convert';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

LoginController _make(FakeSocketTransport t, InMemoryAccountStore store) =>
    LoginController(
      transport: t,
      accountStore: store,
      saasEndpoint: 'https://saas.test:443',
    );

void main() {
  test('a bad email fails loud locally — nothing leaves the device', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final LoginController c = _make(t, InMemoryAccountStore());
    await c.login(email: 'not-an-email', password: 'x');
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.invalidEmail);
    expect(c.isLoggedIn, isFalse);
    expect(t.emittedNames, isNot(contains(FlowMicEvents.mobileLogin)));
    expect(t.connectCalls, 0); // never even dialled
    await t.close();
  });

  test('an empty password fails loud locally', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final LoginController c = _make(t, InMemoryAccountStore());
    await c.login(email: 'fang@example.com', password: '');
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.emptyPassword);
    expect(t.emittedNames, isNot(contains(FlowMicEvents.mobileLogin)));
    await t.close();
  });

  test('saas success stores the JWT + public user — but NEVER the password',
      () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = _make(t, store);
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'jwt-xyz',
      'user': <String, Object?>{
        'id': 'u1',
        'email': 'fang@example.com',
        'display_name': 'Fang',
        'plan': 'pro',
      },
      'mode': 'saas',
    });
    await c.login(email: 'fang@example.com', password: 'secret12');

    // Success + public projection surfaced.
    expect(c.phase, LoginPhase.success);
    expect(c.isLoggedIn, isTrue);
    expect(c.email, 'fang@example.com');
    expect(c.plan, 'pro');
    expect(c.jwt, 'jwt-xyz');

    // The password DID ride the wire (proves a real login)…
    final Map<dynamic, dynamic> payload =
        t.emittedWhere(FlowMicEvents.mobileLogin).single.data as Map<dynamic, dynamic>;
    expect(payload['password'], 'secret12');

    // …but the persisted account holds ONLY the JWT + public user — no password.
    final CloudAccount? saved = await store.read();
    expect(saved, isNotNull);
    expect(saved!.jwt, 'jwt-xyz');
    final String serialized = jsonEncode(saved.toJson());
    expect(serialized.contains('secret12'), isFalse);
    expect(serialized.contains('password'), isFalse);
    await t.close();
  });

  test('AUTH_LOGIN_FAILED → distinct fail-loud, no success', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final LoginController c = _make(t, InMemoryAccountStore());
    t.ackQueue.add(<String, Object?>{'error': 'AUTH_LOGIN_FAILED'});
    await c.login(email: 'fang@example.com', password: 'wrongpass');
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.authLoginFailed);
    expect(c.isLoggedIn, isFalse);
    await t.close();
  });

  test('REGISTER_RATE_LIMITED → its own distinct fail-loud code', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final LoginController c = _make(t, InMemoryAccountStore());
    t.ackQueue.add(<String, Object?>{'error': 'REGISTER_RATE_LIMITED', 'retryable': true});
    await c.login(email: 'fang@example.com', password: 'secret12');
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.rateLimited);
    await t.close();
  });

  test('a shapeless ack ({}) is a failure, never success', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final LoginController c = _make(t, InMemoryAccountStore());
    t.defaultAck = <String, Object?>{};
    await c.login(email: 'fang@example.com', password: 'secret12');
    expect(c.isLoggedIn, isFalse);
    expect(c.phase, LoginPhase.error);
    await t.close();
  });

  test('standalone ack ({ok, mode:standalone}) — success, no JWT persisted', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = _make(t, store);
    t.ackQueue.add(<String, Object?>{'ok': true, 'mode': 'standalone'});
    await c.login(email: 'fang@example.com', password: 'secret12');
    expect(c.phase, LoginPhase.success);
    expect(c.email, 'fang@example.com');
    expect(c.jwt, isNull); // no bearer to persist
    expect(await store.read(), isNull);
    await t.close();
  });

  test('auth:expired (handleAuthExpired) clears the JWT + returns to login',
      () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = _make(t, store);
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'jwt-live',
      'user': <String, Object?>{'email': 'fang@example.com', 'plan': 'free'},
    });
    await c.login(email: 'fang@example.com', password: 'secret12');
    expect(c.isLoggedIn, isTrue);

    c.handleAuthExpired();
    await Future<void>.microtask(() {}); // let the async store.clear settle
    expect(c.isLoggedIn, isFalse);
    expect(c.jwt, isNull);
    expect(c.phase, LoginPhase.error);
    expect(c.errorCode, LoginErrorCodes.tokenExpired);
    expect(await store.read(), isNull);
    await t.close();
  });

  // ── Card W-a: logout honesty ────────────────────────────────────────────────
  // logout() now says TWO things and keeps them apart: (1) this device is
  // signed out — always; (2) whether a cloud server confirmed it — asked for
  // with an ack, and reported when it does not come. Neither ever claims the
  // JWT was revoked (nothing revokes it before its exp; that is W4-4).
  Future<LoginController> loggedIn(FakeSocketTransport t, InMemoryAccountStore store) async {
    final LoginController c = _make(t, store);
    t.ackQueue.add(<String, Object?>{'ok': true, 'token': 'jwt-1', 'user': <String, Object?>{'email': 'a@b.co'}});
    await c.login(email: 'a@b.co', password: 'secret12');
    expect(c.isLoggedIn, isTrue);
    // login() drops its socket in its finally (RCA-v3 fake honesty exposed that
    // real shape), so a test about the LIVE-session branch has to redial.
    await t.connect(url: 'https://flowmic.app');
    return c;
  }

  test('logout: a saas ack confirms → cleared, idle, no notice', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = await loggedIn(t, store);
    t.ackQueue.add(<String, Object?>{'ok': true, 'mode': 'saas'});
    await c.logout();
    expect(c.phase, LoginPhase.idle);
    expect(c.email, isNull);
    expect(await store.read(), isNull);
    expect(t.emittedNames, contains(FlowMicEvents.mobileLogout));
    expect(c.logoutNotice, isNull);
    await t.close();
  });

  test('logout: the server never answers → LOCAL state is still cleared, and '
      'the unconfirmed half is surfaced (never "已登出服务器")', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = await loggedIn(t, store);
    // The link is down: the real transport throws / times out on emitWithAck.
    t.failEmits = true;
    await c.logout();
    expect(c.isLoggedIn, isFalse);
    expect(c.phase, LoginPhase.idle);
    expect(await store.read(), isNull, reason: 'a dead server must never keep the JWT on this phone');
    expect(c.logoutNotice, LogoutNoticeCodes.serverUnconfirmed);
    await t.close();
  });

  test('logout: a STANDALONE ack is not a cloud confirmation', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = await loggedIn(t, store);
    // A LAN box acks the event but holds no account identity — counting its ok
    // would be one value answering two questions.
    t.ackQueue.add(<String, Object?>{'ok': true, 'mode': 'standalone'});
    await c.logout();
    expect(await store.read(), isNull);
    expect(c.logoutNotice, LogoutNoticeCodes.serverUnconfirmed);
    await t.close();
  });

  test('logout: a REFUSED secure-store delete is said out loud, not swallowed',
      () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore()..clearFails = true;
    final LoginController c = await loggedIn(t, store);
    t.ackQueue.add(<String, Object?>{'ok': true, 'mode': 'saas'});
    await c.logout();
    expect(c.isLoggedIn, isFalse, reason: 'the session is over in-memory either way');
    expect(await store.read(), isNotNull, reason: 'the refused delete really did keep the row');
    // The actionable branch wins over the server one.
    expect(c.logoutNotice, LogoutNoticeCodes.localClearFailed);
    await t.close();
  });

  test('a new sign-in retires the previous logout notice', () async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    final InMemoryAccountStore store = InMemoryAccountStore();
    final LoginController c = await loggedIn(t, store);
    t.failEmits = true;
    await c.logout();
    expect(c.logoutNotice, LogoutNoticeCodes.serverUnconfirmed);
    t.failEmits = false;
    t.ackQueue.add(<String, Object?>{'ok': true, 'token': 'jwt-2', 'user': <String, Object?>{'email': 'a@b.co'}});
    await c.login(email: 'a@b.co', password: 'secret12');
    expect(c.isLoggedIn, isTrue);
    expect(c.logoutNotice, isNull);
    await t.close();
  });

  test('hydrate rehydrates email/plan/JWT from secure storage on boot', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final InMemoryAccountStore store = InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-stored', email: 'fang@example.com', plan: 'pro'),
    );
    final LoginController c = _make(t, store);
    await c.hydrate();
    expect(c.isLoggedIn, isTrue);
    expect(c.email, 'fang@example.com');
    expect(c.plan, 'pro');
    expect(c.jwt, 'jwt-stored');
    await t.close();
  });

  test('the three failure codes map to DISTINCT bilingual copy', () {
    const AppStrings zh = AppStringsZh();
    final Set<String> zhCopy = <String>{
      zh.loginError(LoginErrorCodes.authLoginFailed),
      zh.loginError(LoginErrorCodes.rateLimited),
      zh.loginError(LoginErrorCodes.tokenExpired),
    };
    expect(zhCopy.length, 3); // all distinct
    const AppStrings en = AppStringsEn();
    final Set<String> enCopy = <String>{
      en.loginError(LoginErrorCodes.authLoginFailed),
      en.loginError(LoginErrorCodes.rateLimited),
      en.loginError(LoginErrorCodes.tokenExpired),
    };
    expect(enCopy.length, 3);
  });

  test('logout copy is four-language, distinct, and claims no revocation', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      final String unconfirmed = s.logoutNotice(LogoutNoticeCodes.serverUnconfirmed);
      final String localFailed = s.logoutNotice(LogoutNoticeCodes.localClearFailed);
      expect(unconfirmed.trim(), isNotEmpty);
      expect(localFailed.trim(), isNotEmpty);
      expect(unconfirmed, isNot(localFailed));
      // An unknown code must degrade to the WEAKEST true claim, never to '' —
      // an empty notice is a silent failure wearing a default branch.
      expect(s.logoutNotice('SOMETHING_NOBODY_DEFINED'), unconfirmed);
      // red line (owner ruling A5-4): the copy may not say the cloud session was
      // ended/revoked/invalidated — no such thing happens before the JWT's exp.
      for (final String claim in <String>['撤销', '已注销', '作废', '已失效', 'revoke', 'invalidat']) {
        expect(
          '$unconfirmed $localFailed'.toLowerCase().contains(claim.toLowerCase()),
          isFalse,
          reason: '$locale logout copy claims "$claim", which the server does not do',
        );
      }
    }
  });
}
