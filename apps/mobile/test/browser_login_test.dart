// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card
//     NR-2b, 「健壮性清单」 — the state binding against login injection is the
//     item this file mostly is)
//   lib/src/auth/browser_login.dart
//
// The DECISIONS of the browser sign-in round trip, driven directly.
//
// 🔴 THE ONE THAT MATTERS MOST IS A REFUSAL, NOT A SUCCESS. `flowmic://login`
// is a URL: any web page, any chat message, any other app on the phone can make
// this app open one. A callback carrying an ATTACKER's nonce, accepted, signs
// this phone into the ATTACKER's account and every later utterance is delivered
// there. That is login CSRF, and the tests below are what stand between the
// product and it — see the reverse control recorded in the commit message:
// deleting the state comparison turns two of them red.
//
// The registration anchors at the bottom exist for a different failure. The
// scheme is written in THREE places — this Dart constant, the Android manifest
// and the iOS plist — and no compiler compares any two of them. A rename does
// not break a build; it makes the OS drop the callback, and the flow simply
// never finishes, with every gate in the repo green.

import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/auth/browser_login.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';

const String kEndpoint = 'https://flowmic.app';
const int kNow = 1_800_000_000_000;

BrowserLoginRequest _pending({
  String state = 'aabbccdd',
  int? startedAtMs,
  String endpoint = kEndpoint,
}) => BrowserLoginRequest(
  state: state,
  startedAtMs: startedAtMs ?? kNow,
  endpoint: endpoint,
);

Uri _callback({
  String state = 'aabbccdd',
  String nonce = 'deadbeefdeadbeefdeadbeefdeadbeef',
  String? endpoint = kEndpoint,
}) {
  final Map<String, String> q = <String, String>{'t': nonce, 'state': state};
  if (endpoint != null) q['endpoint'] = endpoint;
  return Uri.parse('flowmic://login').replace(queryParameters: q);
}

void main() {
  group('the URL handed to the browser', () {
    test('is <endpoint>/signin?flow=mobile&state=…', () {
      final Uri u = buildBrowserSignInUrl(endpoint: kEndpoint, state: 'abc123');
      expect(u.origin, kEndpoint);
      expect(u.path, '/signin');
      expect(u.queryParameters['flow'], 'mobile');
      expect(u.queryParameters['state'], 'abc123');
    });

    test('a trailing slash on the endpoint does not become a double slash', () {
      final Uri u = buildBrowserSignInUrl(endpoint: '$kEndpoint///', state: 'x');
      expect(u.toString().startsWith('$kEndpoint/signin?'), isTrue);
    });
  });

  group('the binding value', () {
    test('is 32 hex characters, and two mints differ', () {
      final String a = mintBrowserLoginState();
      final String b = mintBrowserLoginState();
      expect(a, matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(a == b, isFalse);
    });

    test('is drawn from the injected source, so the mint itself is testable', () {
      // A seeded Random proves the plumbing; production passes nothing and gets
      // Random.secure — a predictable state would make the whole refusal below
      // decoration, which is why the default is not a plain Random().
      expect(mintBrowserLoginState(Random(1)).length, 32);
    });
  });

  group('which links are even ours', () {
    test('flowmic://login is', () {
      expect(isBrowserLoginLink(Uri.parse('flowmic://login?t=1')), isTrue);
      expect(isBrowserLoginLink(Uri.parse('FLOWMIC://LOGIN')), isTrue);
    });

    test('another scheme or another host is not — and that is not an error', () {
      expect(isBrowserLoginLink(Uri.parse('https://flowmic.app/login')), isFalse);
      expect(isBrowserLoginLink(Uri.parse('flowmic://pair?code=1234')), isFalse);
      expect(isBrowserLoginLink(Uri.parse('otherapp://login?t=1')), isFalse);
    });
  });

  group('verifying a callback', () {
    test('the happy path yields the nonce and OUR endpoint', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(),
        pending: _pending(),
        nowMs: kNow + 5_000,
      );
      expect(v.ok, isTrue);
      expect(v.nonce, 'deadbeefdeadbeefdeadbeefdeadbeef');
      expect(v.endpoint, kEndpoint);
      expect(v.refusal, isNull);
    });

    test('🔴 an UNSOLICITED link is refused — nothing was ever requested here', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(),
        pending: null,
        nowMs: kNow,
      );
      expect(v.ok, isFalse);
      expect(v.refusal, BrowserLoginCodes.noRequest);
      expect(v.nonce, isNull, reason: 'the nonce must not be carried onward');
    });

    test('🔴 a link echoing a DIFFERENT state is refused (login CSRF)', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(state: 'attackers-own-state'),
        pending: _pending(state: 'ours'),
        nowMs: kNow,
      );
      expect(v.ok, isFalse);
      expect(v.refusal, BrowserLoginCodes.stateMismatch);
    });

    test('🔴 a link with NO state at all is refused too', () {
      // The empty-string case is separate on purpose: `'' == ''` would let a
      // stripped parameter match a corrupted request and pass.
      final Uri u = Uri.parse('flowmic://login?t=abc');
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: u,
        pending: _pending(state: ''),
        nowMs: kNow,
      );
      expect(v.refusal, BrowserLoginCodes.stateMismatch);
    });

    test('a binding older than the TTL is refused, by its own name', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(),
        pending: _pending(startedAtMs: kNow),
        nowMs: kNow + kBrowserLoginStateTtl.inMilliseconds + 1,
      );
      expect(v.refusal, BrowserLoginCodes.expired);
    });

    test('exactly at the TTL it is still good (the boundary is inclusive)', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(),
        pending: _pending(startedAtMs: kNow),
        nowMs: kNow + kBrowserLoginStateTtl.inMilliseconds,
      );
      expect(v.ok, isTrue);
    });

    test('a callback naming a DIFFERENT server is refused, not followed', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(endpoint: 'https://relay.evil.example'),
        pending: _pending(),
        nowMs: kNow,
      );
      expect(v.refusal, BrowserLoginCodes.endpointMismatch);
    });

    test('a cosmetic difference in the origin is NOT a different server', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(endpoint: 'HTTPS://FlowMic.app/'),
        pending: _pending(),
        nowMs: kNow,
      );
      expect(v.ok, isTrue);
    });

    test('a link with no endpoint parameter redeems at the one we opened', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: _callback(endpoint: null),
        pending: _pending(endpoint: 'https://relay.example.test'),
        nowMs: kNow,
      );
      expect(v.ok, isTrue);
      expect(v.endpoint, 'https://relay.example.test');
    });

    test('a callback with no code is a malformed redirect, named as such', () {
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: Uri.parse('flowmic://login?state=aabbccdd'),
        pending: _pending(),
        nowMs: kNow,
      );
      expect(v.refusal, BrowserLoginCodes.noCode);
    });

    test('🔴 identity is checked BEFORE contents — an unsolicited link with no '
        'code still reads as unsolicited', () {
      // Order is a security property: answering 「your link has no code」 to a
      // forgery would tell the forger which half to fix.
      final BrowserLoginVerdict v = verifyBrowserLoginCallback(
        link: Uri.parse('flowmic://login'),
        pending: null,
        nowMs: kNow,
      );
      expect(v.refusal, BrowserLoginCodes.noRequest);
    });
  });

  group('the persisted request', () {
    test('survives an encode/decode round trip', () {
      final BrowserLoginRequest r = _pending(state: 'abc', endpoint: kEndpoint);
      final BrowserLoginRequest? back = BrowserLoginRequest.decode(r.encode());
      expect(back!.state, 'abc');
      expect(back.startedAtMs, kNow);
      expect(back.endpoint, kEndpoint);
    });

    test('a corrupt or empty preference decodes to "nothing pending", never a throw', () {
      // Which then refuses the callback loudly. A crash on the sign-in screen
      // would be the worse of the two by a distance.
      for (final String? raw in <String?>[null, '', 'not json', '[]', '{"s":1}', '{"s":"a"}']) {
        expect(BrowserLoginRequest.decode(raw), isNull, reason: 'raw=$raw');
      }
    });
  });

  group('the copy', () {
    test('🔴 every refusal code has a real sentence in every language', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in BrowserLoginCodes.all) {
          final String sentence = s.browserLoginError(code);
          expect(sentence.trim(), isNotEmpty, reason: '$locale / $code');
          // The default branch returns the bare identifier (the 0.2.53 rule).
          // Getting it back here means the code was added without its copy.
          expect(sentence, isNot(code), reason: '$locale / $code has no copy');
        }
      }
    });

    test('an unknown code degrades to the bare identifier, not an invented cause', () {
      expect(
        AppStrings.of(AppLocale.en).browserLoginError('BROWSER_LOGIN_NOT_A_CODE'),
        'BROWSER_LOGIN_NOT_A_CODE',
      );
    });

    test('the seven sentences are pairwise distinct in English', () {
      final AppStrings s = AppStrings.of(AppLocale.en);
      final Set<String> seen = <String>{};
      for (final String code in BrowserLoginCodes.all) {
        expect(seen.add(s.browserLoginError(code)), isTrue,
            reason: '$code reuses another refusal\'s sentence');
      }
    });
  });

  group('the OS registrations (three copies of one fact)', () {
    test('🔴 the Android manifest declares exactly this scheme and host', () {
      final String xml = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();
      // Positive control: prove we are reading the manifest we think we are.
      expect(xml.contains('android.intent.action.MAIN'), isTrue);
      expect(
        xml.contains(
          'android:scheme="$kBrowserLoginScheme" android:host="$kBrowserLoginHost"',
        ),
        isTrue,
        reason: 'the callback filter must name the Dart constants verbatim',
      );
      // BROWSABLE is what allows a redirect started by a web page to reach us.
      expect(xml.contains('android.intent.category.BROWSABLE'), isTrue);
    });

    test('🔴 the filter is in `main`, so every flavour ships it', () {
      // The flavour split exists for ONE permission (REQUEST_INSTALL_PACKAGES,
      // direct-only). Browser sign-in is not channel-specific: a store build
      // without this filter would offer a button whose browser can never come
      // back. Asserted as an absence in the two channel manifests.
      for (final String flavour in <String>['direct', 'store']) {
        final String xml = File(
          'android/app/src/$flavour/AndroidManifest.xml',
        ).readAsStringSync();
        expect(xml.contains('<manifest'), isTrue, reason: 'positive control');
        expect(xml.contains('android:scheme="$kBrowserLoginScheme"'), isFalse,
            reason: '$flavour must not carry its own copy of the filter');
      }
    });

    test('🔴 the iOS plist declares the same scheme', () {
      // ⚠️ REAL-DEVICE UNPROVEN. This asserts the FILE says the right thing.
      // Whether iOS then routes the URL into app_links through this target's
      // SceneDelegate is a question only a device on the mac line can answer —
      // a Windows gate has zero proving power over a non-Windows surface.
      final String plist = File('ios/Runner/Info.plist').readAsStringSync();
      expect(plist.contains('CFBundleIdentifier'), isTrue, reason: 'positive control');
      expect(plist.contains('<key>CFBundleURLSchemes</key>'), isTrue);
      expect(plist.contains('<string>$kBrowserLoginScheme</string>'), isTrue);
    });
  });
}
