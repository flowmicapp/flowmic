// The settings card's quota read: what counts as a believable answer, and what
// every kind of non-answer does.
//
// 🔴 THE DEGRADE PATHS ARE THE POINT OF THIS FILE. Owner ruled the gauge is
// allowed to be absent — no banner, no error row — so the ONLY thing standing
// between「we could not read it」and「we read it wrong」is this parser refusing
// to invent a number, and this controller refusing to blank numbers it already
// has. Both are asserted here, in both directions.

import 'dart:async';

import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const CloudAccount _signedIn =
    CloudAccount(jwt: 'jwt-quota', email: 'someone@example.com', plan: 'pro');

Future<LoginController> _login({CloudAccount? account}) async {
  final LoginController login = newTestLogin(
    transport: FakeSocketTransport(),
    accountStore: InMemoryAccountStore(account),
  );
  if (account != null) await login.hydrate();
  return login;
}

Map<String, Object?> _body({
  Object? usedMin = 12,
  Object? limitMin = 900,
  Object? usedTokens = 1200000,
  Object? limitTokens = 5000000,
  // Card CR-6. Top-level in the real body, beside `quota` rather than inside
  // it, because it answers a different question — see CloudSummary's doc.
  Object? continuousMinutes = 30,
}) => <String, Object?>{
  'continuous_minutes': ?continuousMinutes,
  'plan': <String, Object?>{'plan': 'pro'},
  'quota': <String, Object?>{
    'stt': <String, Object?>{'used_min': usedMin, 'limit_min': limitMin},
    'llm': <String, Object?>{'used': usedTokens, 'used_in': 40000, 'limit': limitTokens},
    'month': '2026-08',
  },
  'devices': <String, Object?>{'pc_count': 1, 'mobile_count': 1},
};

void main() {
  group('parseCloudSummary', () {
    test('reads the two meters the gauge draws', () {
      final CloudSummary? s = parseCloudSummary(_body());
      expect(s, isNotNull);
      expect(s!.minutes!.used, 12);
      expect(s.minutes!.limit, 900);
      expect(s.tokens!.used, 1200000);
      expect(s.tokens!.limit, 5000000);
    });

    test('a null limit is a FAILED READ, never 「unlimited」', () {
      // 🔴 The 2026-08-07 narrowing (billing-service.ts QuotaView, verbatim:
      // 「nothing here reaches the wire as null any more, and a null that does
      // show up means we failed to compute it」). An exempt account gets the MAX
      // tier's finite ceiling, so there is no ∞ left for an empty field to be —
      // and printing 「unlimited」 under a live gate is the R11 red line.
      expect(parseCloudSummary(_body(limitMin: null, limitTokens: null)), isNull);

      // One side only ⇒ a ONE-ENDED gauge, not a dead one.
      final CloudSummary half = parseCloudSummary(_body(limitMin: null))!;
      expect(half.minutes, isNull);
      expect(half.tokens, isNotNull);
    });

    test('the ENFORCED token meter is `used`, never `used_in`', () {
      // If this ever starts reading `used_in`, the number would be 40000 and
      // the gauge would be measuring something the server does not enforce.
      expect(parseCloudSummary(_body())!.tokens!.used, 1200000);
    });

    test('integers on the wire are accepted as numbers', () {
      final CloudSummary s = parseCloudSummary(_body(usedMin: 0, usedTokens: 0))!;
      expect(s.minutes!.used, 0);
      expect(s.tokens!.used, 0);
    });

    for (final MapEntry<String, Object?> bad in <String, Object?>{
      'not a map': 'nope',
      'null': null,
      'no quota at all': <String, Object?>{'plan': <String, Object?>{}},
      'quota is not a map': <String, Object?>{'quota': 7},
    }.entries) {
      test('unbelievable body ⇒ null (${bad.key})', () {
        expect(parseCloudSummary(bad.value), isNull);
      });
    }

    test('a non-numeric USED kills THAT side — never a gauge reading 0', () {
      final CloudSummary noMinutes = parseCloudSummary(_body(usedMin: 'twelve'))!;
      expect(noMinutes.minutes, isNull);
      expect(noMinutes.tokens, isNotNull);

      final CloudSummary noTokens = parseCloudSummary(_body(usedTokens: <String>[]))!;
      expect(noTokens.tokens, isNull);
      expect(noTokens.minutes, isNotNull);
    });

    test('a non-numeric LIMIT drops that side, exactly like a bad USED', () {
      // SYMMETRIC on purpose since 2026-08-07: a ceiling we could not read
      // leaves nothing truthful to draw, the same as a spend we could not read.
      // Two absences, one honest answer — no bar on that end.
      final CloudSummary s = parseCloudSummary(_body(limitMin: 'lots'))!;
      expect(s.minutes, isNull);
      expect(s.tokens, isNotNull, reason: 'the other end was readable');
    });

    test('BOTH sides unreadable ⇒ no summary at all', () {
      // An empty rail under two empty labels is a control that answers nothing.
      expect(parseCloudSummary(_body(usedMin: 'x', usedTokens: 'y')), isNull);
    });
  });

  group('parseCloudSummary — the per-session ceiling (card CR-6)', () {
    test('reads it', () {
      expect(parseCloudSummary(_body())!.continuousMinutes, 30);
      expect(parseCloudSummary(_body(continuousMinutes: 10))!.continuousMinutes, 10);
    });

    test('🔴 absent reads as null, and null may NEVER mean unlimited', () {
      // A server that predates the field, or one that failed to compute it.
      // The consumer's rule (CloudSummary.continuousMinutes) is that a
      // continuous recording may not START without this number: the feature is
      // a bounded sitting by definition and the retained-audio budget was sized
      // against the 30-minute worst case. Reading absence as "no ceiling" would
      // begin an unbounded recording against a budget nobody checked.
      expect(parseCloudSummary(_body(continuousMinutes: null))!.continuousMinutes, isNull);
    });

    test('🔴 an unreadable ceiling does not destroy the gauge, and vice versa',
        () {
      // Two questions, two consumers, two independent failures. An old server
      // that answers the meters but not this field must still draw a gauge —
      // and a phone that CAN draw a gauge must not conclude it may record
      // without a ceiling.
      final CloudSummary noCeiling = parseCloudSummary(_body(continuousMinutes: null))!;
      expect(noCeiling.minutes, isNotNull);
      expect(noCeiling.tokens, isNotNull);

      final CloudSummary? noMeters =
          parseCloudSummary(_body(usedMin: 'x', usedTokens: 'y'));
      expect(noMeters, isNull,
          reason: 'the ceiling alone is not a summary — the gauge is what this '
              'body is fetched for');
    });

    test('values that cannot describe a usable ceiling read as null', () {
      // 0 and negatives would describe a feature that cannot be used. If that
      // is ever a real product state it needs its own signal rather than
      // arriving as arithmetic nobody chose.
      for (final Object bad in <Object>[0, -5, 'thirty', <String>[], 1 / 0]) {
        expect(parseCloudSummary(_body(continuousMinutes: bad))!.continuousMinutes,
            isNull,
            reason: 'ceiling: $bad');
      }
    });

    test('a fractional ceiling is rounded rather than refused', () {
      // The server sends whole minutes; this only decides what to do if that
      // ever changes, and dropping a believable number would be worse than
      // rounding it.
      expect(parseCloudSummary(_body(continuousMinutes: 29.6))!.continuousMinutes, 30);
    });
  });

  group('cloudSummaryUri', () {
    test('a ws:// endpoint becomes http:// — the one canonical funnel', () {
      expect(
        cloudSummaryUri('ws://192.0.2.5:41879').toString(),
        'http://192.0.2.5:41879/api/cloud/summary',
      );
      expect(
        cloudSummaryUri('https://flowmic.example').toString(),
        'https://flowmic.example/api/cloud/summary',
      );
    });
  });

  group('CloudSummaryController', () {
    test('signed out ⇒ never asks, and says nothing', () async {
      final LoginController login = await _login();
      int calls = 0;
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) async {
          calls += 1;
          return null;
        },
      );
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 0);
      expect(c.summary, isNull);
      c.dispose();
      login.dispose();
    });

    test('a good answer lands and notifies exactly once', () async {
      final LoginController login = await _login(account: _signedIn);
      int notifies = 0;
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) async {
          // The bearer really is the account's JWT — the one thing a caller
          // could get wrong without any test noticing.
          expect(bearer, 'jwt-quota');
          expect(url.path, '/api/cloud/summary');
          return parseCloudSummary(_body());
        },
      )..addListener(() => notifies += 1);
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(c.summary, isNotNull);
      expect(c.summary!.minutes!.used, 12);
      expect(notifies, 1);
      c.dispose();
      login.dispose();
    });

    test('SINGLE IN FLIGHT — a second ask while one is out is dropped, not queued', () async {
      final LoginController login = await _login(account: _signedIn);
      int calls = 0;
      final Completer<CloudSummary?> gate = Completer<CloudSummary?>();
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) {
          calls += 1;
          return gate.future;
        },
      );
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(c.inFlight, isTrue);
      c.refresh();
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1);
      gate.complete(parseCloudSummary(_body()));
      await Future<void>.delayed(Duration.zero);
      expect(c.inFlight, isFalse);
      // ...and the next one, after it settled, DOES go out.
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 2);
      c.dispose();
      login.dispose();
    });

    test('a miss KEEPS the last good numbers — no blank, no flicker', () async {
      final LoginController login = await _login(account: _signedIn);
      bool ok = true;
      int notifies = 0;
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) async =>
            ok ? parseCloudSummary(_body()) : null,
      )..addListener(() => notifies += 1);
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(c.summary!.minutes!.used, 12);
      expect(notifies, 1);

      ok = false; // 401 / 404 / timeout / garbage — all one answer here
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(c.summary, isNotNull, reason: 'a failed refresh must not blank the gauge');
      expect(c.summary!.minutes!.used, 12);
      expect(notifies, 1, reason: 'nothing changed, so nothing repaints');
      c.dispose();
      login.dispose();
    });

    test('a THROWING fetcher degrades exactly like a miss (Error, not just Exception)', () async {
      final LoginController login = await _login(account: _signedIn);
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        // RV-89's shape: `HttpClient.getUrl` on a ws:// URL throws an
        // ArgumentError, which an `on Exception` catch does not see.
        fetcher: (Uri url, String bearer, Duration budget) async =>
            throw ArgumentError('Unsupported scheme'),
      );
      c.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(c.summary, isNull);
      expect(c.inFlight, isFalse);
      c.dispose();
      login.dispose();
    });

    test('already signed in at construction ⇒ NO automatic ask', () async {
      // The card's initState is what asks in that case, and this is why the
      // two triggers are two things: a controller that also asked on
      // construction would ask twice on every launch of a signed-in app.
      final LoginController login = await _login(account: _signedIn);
      int calls = 0;
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) async {
          calls += 1;
          return parseCloudSummary(_body());
        },
      );
      await Future<void>.delayed(Duration.zero);
      expect(calls, 0);
      c.dispose();
      login.dispose();
    });

    test('signing in AFTER construction asks, and signing out clears', () async {
      // Sign-in through a PRODUCTION entrance, not a test-only setter (RV-63):
      // the credential is in the store and `hydrate()` is the rehydrate every
      // launch and every completed sign-in ends in.
      final LoginController login = newTestLogin(
        transport: FakeSocketTransport(),
        accountStore: InMemoryAccountStore(_signedIn),
      );
      int calls = 0;
      int notifies = 0;
      final CloudSummaryController c = CloudSummaryController(
        login: login,
        saasEndpoint: 'http://127.0.0.1:1',
        fetcher: (Uri url, String bearer, Duration budget) async {
          calls += 1;
          return parseCloudSummary(_body());
        },
      )..addListener(() => notifies += 1);
      expect(login.isLoggedIn, isFalse);
      expect(calls, 0);

      await login.hydrate(); // ← the transition
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1, reason: 'the sign-in transition is a trigger of its own');
      expect(c.summary, isNotNull);
      final int afterLoad = notifies;

      await login.logout();
      await Future<void>.delayed(Duration.zero);
      expect(
        c.summary,
        isNull,
        reason: 'those numbers belong to the account that just left',
      );
      expect(notifies, greaterThan(afterLoad));
      expect(calls, 1, reason: 'a sign-OUT must not go asking');
      c.dispose();
      login.dispose();
    });
  });
}
