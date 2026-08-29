// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card
//     NR-2b, 「健壮性清单」 — deep link unregistered / no browser / the user
//     cancels half way / the code expires / state binding / a named message and
//     a retry when the hand-back fails; a loading state throughout, no silent
//     failure)
//   lib/src/auth/browser_login_controller.dart
//
// The MOVING half: the controller that opens the browser, waits, receives the
// callback and redeems it. One test per line of the ruling's checklist, and
// where a line cannot be tested the reason is written down instead of skipped.
//
// ⚠️ WHAT NO TEST HERE CAN COVER, STATED RATHER THAN IMPLIED:
//  · 「深链未注册」 (the OS has no handler for `flowmic://`) — this process is
//    told NOTHING in that case. It is, from inside the app, byte-for-byte the
//    same situation as a user who closed the browser tab: no callback arrives.
//    So it lands on the same timeout and the same retry, and the copy for that
//    timeout is written to be true for both. The registration itself is pinned
//    by browser_login_test.dart, which reads the manifest and the plist.
//  · whether iOS delivers at all — see the same file's plist test. Unproven on
//    Windows by construction.

import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/browser_login.dart';
import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/auth/login_controller.dart';

import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

const String kEndpoint = 'https://flowmic.app';

class _Harness {
  _Harness({
    bool openerSucceeds = true,
    Duration waitTimeout = const Duration(milliseconds: 40),
    Uri? initialLink,
  }) : // The redemption really dials: `loginWithQr` connects before it emits,
       // and a fake that refuses to connect would turn every assertion below
       // into NOT_CONNECTED — proving the flow works for the wrong reason.
       transport = FakeSocketTransport()..connectSucceeds = true,
       opener = FakeBrowserOpener(succeeds: openerSucceeds),
       links = FakeBrowserLoginLinks(initial: initialLink),
       store = InMemoryBrowserLoginStateStore() {
    login = newTestLogin(transport: transport, saasEndpoint: kEndpoint);
    controller = BrowserLoginController(
      login: login,
      links: links,
      store: store,
      opener: opener.call,
      endpoint: kEndpoint,
      waitTimeout: waitTimeout,
      now: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
    );
  }

  final FakeSocketTransport transport;
  final FakeBrowserOpener opener;
  final FakeBrowserLoginLinks links;
  final InMemoryBrowserLoginStateStore store;
  late final LoginController login;
  late final BrowserLoginController controller;

  /// A clock the test moves by hand, so 「the binding aged out」 needs no wall
  /// clock and no sleep.
  int nowMs = 1_800_000_000_000;

  /// The `state` the last [BrowserLoginController.start] put on the wire.
  String get lastState => opener.opened.last.queryParameters['state']!;

  Uri callbackFor({String? state, String nonce = 'nonce-abc'}) =>
      Uri.parse('flowmic://login').replace(
        queryParameters: <String, String>{
          't': nonce,
          'state': state ?? lastState,
          'endpoint': kEndpoint,
        },
      );

  Future<void> dispose() async {
    controller.dispose();
    await links.close();
  }
}

void main() {
  test('the happy path: open → callback → the nonce is redeemed', () async {
    final _Harness h = _Harness();
    addTearDown(h.dispose);
    h.transport.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'eyJh.eyJz.sig',
      'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
    });

    await h.controller.start();
    expect(h.controller.phase, BrowserLoginPhase.waiting);
    expect(h.opener.opened, hasLength(1));

    h.links.push(h.callbackFor());
    await pumpEventQueue();

    // Redeemed over the EXISTING QR arm — this card adds no second way in.
    expect(h.transport.emitted, hasLength(1));
    expect(h.transport.emitted.single.name, FlowMicEvents.mobileLogin);
    final Map<Object?, Object?> payload =
        h.transport.emitted.single.data! as Map<Object?, Object?>;
    expect(payload['qr_nonce'], 'nonce-abc');
    expect(payload.containsKey('password'), isFalse,
        reason: 'this flow has no password to send, and must never grow one');
    expect(h.login.isLoggedIn, isTrue);
    expect(h.controller.phase, BrowserLoginPhase.idle);
    expect(h.controller.errorCode, isNull);
  });

  test('LOADING STATE: the phase is never idle while something is in flight', () async {
    final _Harness h = _Harness();
    addTearDown(h.dispose);
    expect(h.controller.phase, BrowserLoginPhase.idle);
    expect(h.controller.isBusy, isFalse);
    await h.controller.start();
    expect(h.controller.isBusy, isTrue, reason: 'the button must not look tappable');
    expect(h.controller.phase, BrowserLoginPhase.waiting);
  });

  test('NO BROWSER: a refused launch fails by name and clears the binding', () async {
    final _Harness h = _Harness(openerSucceeds: false);
    addTearDown(h.dispose);
    await h.controller.start();
    expect(h.controller.phase, BrowserLoginPhase.failed);
    expect(h.controller.errorCode, BrowserLoginCodes.openFailed);
    // Nothing left pending: a callback that somehow arrived later would be
    // refused as unsolicited rather than redeemed against a dead attempt.
    expect(await h.store.read(), isNull);
    expect(h.controller.isBusy, isFalse, reason: 'and the button is tappable again');
  });

  test('🔴 THE USER CANCELS: the wait ends by itself and offers a retry', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(milliseconds: 20));
    addTearDown(h.dispose);
    await h.controller.start();
    expect(h.controller.phase, BrowserLoginPhase.waiting);

    // Nothing on either OS emits 「the user gave up」. The deadline IS the
    // mechanism; without it this phase never ends and the sheet spins for the
    // rest of the session.
    await Future<void>.delayed(const Duration(milliseconds: 60));
    await pumpEventQueue();

    expect(h.controller.phase, BrowserLoginPhase.failed);
    expect(h.controller.errorCode, BrowserLoginCodes.timedOut);
    expect(h.controller.isBusy, isFalse);

    // RECOVERY: a second attempt starts cleanly from the failed state.
    h.controller.clearError();
    expect(h.controller.phase, BrowserLoginPhase.idle);
    expect(h.controller.errorCode, isNull);
    await h.controller.start();
    expect(h.opener.opened, hasLength(2));
    expect(h.controller.phase, BrowserLoginPhase.waiting);
  });

  test('the explicit Cancel is not a failure — it says nothing at all', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    await h.controller.start();
    await h.controller.cancel();
    expect(h.controller.phase, BrowserLoginPhase.idle);
    expect(h.controller.errorCode, isNull, reason: 'the user is where they were');
    expect(await h.store.read(), isNull);
  });

  test('a callback arriving AFTER the timeout is refused as unsolicited', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(milliseconds: 20));
    addTearDown(h.dispose);
    await h.controller.start();
    final Uri late = h.callbackFor();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    await pumpEventQueue();

    h.links.push(late);
    await pumpEventQueue();
    expect(h.controller.errorCode, BrowserLoginCodes.noRequest);
    expect(h.transport.emitted, isEmpty, reason: 'the nonce never left the device');
  });

  test('🔴 STATE MISMATCH: a forged callback is refused and nothing is emitted', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    await h.controller.start();

    h.links.push(h.callbackFor(state: 'attackers-own-state', nonce: 'attacker-nonce'));
    await pumpEventQueue();

    expect(h.controller.phase, BrowserLoginPhase.failed);
    expect(h.controller.errorCode, BrowserLoginCodes.stateMismatch);
    // The assertion that matters: the attacker's nonce was not sent anywhere,
    // so this phone did not join their account.
    expect(h.transport.emitted, isEmpty);
    expect(h.login.isLoggedIn, isFalse);
  });

  test('🔴 the binding is ONE-TIME: replaying the same callback is refused', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    h.transport.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'eyJh.eyJz.sig',
      'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
    });
    await h.controller.start();
    final Uri cb = h.callbackFor();
    h.links.push(cb);
    await pumpEventQueue();
    expect(h.login.isLoggedIn, isTrue);

    h.links.push(cb);
    await pumpEventQueue();
    expect(h.controller.errorCode, BrowserLoginCodes.noRequest);
  });

  test('an EXPIRED binding is named as expired, not as a mismatch', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    await h.controller.start();
    final Uri cb = h.callbackFor();

    h.nowMs += kBrowserLoginStateTtl.inMilliseconds + 1;
    h.links.push(cb);
    await pumpEventQueue();

    expect(h.controller.errorCode, BrowserLoginCodes.expired);
    expect(h.transport.emitted, isEmpty);
  });

  test('a SERVER refusal is left to LoginController — this one stays quiet', () async {
    // The nonce expiring on the server (its own 60 s window) reads here exactly
    // as it reads for a scanned QR: `AUTH_LOGIN_FAILED` from the account
    // server. This controller must not paraphrase it into a second opinion.
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    h.transport.ackQueue.add(<String, Object?>{'error': 'AUTH_LOGIN_FAILED'});
    await h.controller.start();
    h.links.push(h.callbackFor());
    await pumpEventQueue();

    expect(h.controller.errorCode, isNull, reason: 'no second opinion');
    expect(h.controller.phase, BrowserLoginPhase.idle);
    expect(h.login.errorCode, 'AUTH_LOGIN_FAILED');
    expect(h.login.isLoggedIn, isFalse);
  });

  test('a foreign deep link is ignored in silence, not reported as a failure', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    addTearDown(h.dispose);
    await h.controller.start();
    h.links.push(Uri.parse('flowmic://pair?code=1234'));
    await pumpEventQueue();
    expect(h.controller.phase, BrowserLoginPhase.waiting, reason: 'still waiting');
    expect(h.controller.errorCode, isNull);
  });

  group('COLD START — the app was relaunched by the callback', () {
    test('the persisted binding still verifies, and the sign-in completes', () async {
      // Leg 1: an app that started the flow and was then killed. The store is
      // what carries the binding across; nothing else could.
      final _Harness first = _Harness(waitTimeout: const Duration(seconds: 30));
      await first.controller.start();
      final String state = first.lastState;
      final String persisted = (await first.store.read())!;
      await first.dispose();

      // Leg 2: a fresh process, launched WITH the URL, with the same store.
      final Uri launch = Uri.parse('flowmic://login').replace(
        queryParameters: <String, String>{
          't': 'cold-nonce',
          'state': state,
          'endpoint': kEndpoint,
        },
      );
      final _Harness second = _Harness(initialLink: launch);
      addTearDown(second.dispose);
      await second.store.write(persisted);
      second.transport.ackQueue.add(<String, Object?>{
        'ok': true,
        'token': 'eyJh.eyJz.sig',
        'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
      });

      await second.controller.drainInitialLink();
      await pumpEventQueue();
      expect(second.login.isLoggedIn, isTrue);
    });

    test('the launch URL is answered ONCE, however often the sheet is reopened', () async {
      final _Harness h = _Harness(
        initialLink: Uri.parse('flowmic://login?t=x&state=y'),
      );
      addTearDown(h.dispose);
      await h.controller.drainInitialLink();
      expect(h.controller.errorCode, BrowserLoginCodes.noRequest);
      h.controller.clearError();

      await h.controller.drainInitialLink();
      expect(h.controller.errorCode, isNull,
          reason: 'a consumed launch URL must not refuse a second time');
      expect(h.links.initialReads, 2, reason: 'positive control: it was asked twice');
    });

    test('no launch URL is not an event', () async {
      final _Harness h = _Harness();
      addTearDown(h.dispose);
      await h.controller.drainInitialLink();
      expect(h.controller.phase, BrowserLoginPhase.idle);
      expect(h.controller.errorCode, isNull);
    });
  });

  test('dispose is safe mid-flight: a late callback touches nothing', () async {
    final _Harness h = _Harness(waitTimeout: const Duration(seconds: 30));
    await h.controller.start();
    h.controller.dispose();
    h.links.push(h.callbackFor());
    await pumpEventQueue();
    expect(h.transport.emitted, isEmpty);
    await h.links.close();
  });
}
