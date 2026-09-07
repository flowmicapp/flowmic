// The settings card's quota read: what counts as a believable answer, and what
// every kind of non-answer does.
//
// 🔴 THE DEGRADE PATHS ARE THE POINT OF THIS FILE. Owner ruled the gauge is
// allowed to be absent — no banner, no error row — so the ONLY thing standing
// between「we could not read it」and「we read it wrong」is this parser refusing
// to invent a number, and this controller refusing to blank numbers it already
// has. Both are asserted here, in both directions.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

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
  // owner 2026-09-05 — the account-anchored cycle. `null` here is an OLDER
  // RELAY, which is the shape that matters most: it must still produce a gauge.
  Object? period = const <String, Object?>{'start': '2026-08-24', 'end': '2026-09-24'},
}) => <String, Object?>{
  'continuous_minutes': ?continuousMinutes,
  'plan': <String, Object?>{'plan': 'pro'},
  'quota': <String, Object?>{
    'stt': <String, Object?>{'used_min': usedMin, 'limit_min': limitMin},
    'llm': <String, Object?>{'used': usedTokens, 'used_in': 40000, 'limit': limitTokens},
    'month': '2026-08',
    'period': ?period,
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

  // ── when the allowance starts over (owner 2026-09-07) ─────────────────────
  //
  // 🔴 THE ABSENT CASE IS THE ONE THAT COSTS SOMETHING. `quota.period` is
  // additive on the wire, so every relay older than 2026-09-05 answers without
  // it — and the gauge those users see must be unchanged, not decorated with a
  // dash or a guessed 「first of next month」.
  group('parseCloudSummary — quota.period.end', () {
    test('present: read as UTC midnight, never as local midnight', () {
      final CloudSummary s = parseCloudSummary(_body())!;
      // 🔴 Asserted as an INSTANT, not as y/m/d. `DateTime.parse('2026-09-24')`
      // would satisfy a y/m/d assertion on every machine and still be eight
      // hours wrong in Shanghai — which is the whole defect this field can have.
      expect(s.resetsAt, DateTime.utc(2026, 9, 24));
      expect(s.resetsAt!.isUtc, isTrue);
      expect(s.resetsAt!.millisecondsSinceEpoch,
          DateTime.utc(2026, 9, 24).millisecondsSinceEpoch);
    });

    test('absent: no reset instant, and the gauge is untouched', () {
      final CloudSummary s = parseCloudSummary(_body(period: null))!;
      expect(s.resetsAt, isNull);
      // The point of the case: an old relay still draws both meters.
      expect(s.minutes!.used, 12);
      expect(s.tokens!.limit, 5000000);
    });

    test('an unbelievable shape is 「absent」, never a corrected date', () {
      for (final Object? bad in <Object?>[
        <String, Object?>{'start': '2026-08-24'}, // no `end` at all
        <String, Object?>{'end': '2026-9-24'}, // not zero-padded
        <String, Object?>{'end': '2026-09-24T00:00:00Z'}, // not a bare day
        <String, Object?>{'end': '2026-02-31'}, // a day that does not exist
        <String, Object?>{'end': 1790000000}, // not a string
        <String, Object?>{'end': ''},
        'next month', // `period` is not an object
        42,
      ]) {
        expect(parseCloudSummary(_body(period: bad))!.resetsAt, isNull,
            reason: 'period=$bad must produce no line');
      }
    });

    test('a real month end that Dart would roll is kept exactly', () {
      // `DateTime.utc(2026, 2, 29)` silently becomes 1 March. Refusing it is
      // what keeps a rolled day from being printed as the named one; a day that
      // really exists must survive.
      expect(parseCloudSummary(_body(period: <String, Object?>{'end': '2028-02-29'}))!.resetsAt,
          DateTime.utc(2028, 2, 29));
      expect(parseCloudSummary(_body(period: <String, Object?>{'end': '2026-02-29'}))!.resetsAt,
          isNull);
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
          return CloudSummaryRead.unreadable;
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
          return CloudSummaryRead(summary: parseCloudSummary(_body()));
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
      final Completer<CloudSummaryRead> gate = Completer<CloudSummaryRead>();
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
      gate.complete(CloudSummaryRead(summary: parseCloudSummary(_body())));
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
        fetcher: (Uri url, String bearer, Duration budget) async => ok
            ? CloudSummaryRead(summary: parseCloudSummary(_body()))
            : CloudSummaryRead.unreadable,
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
          return CloudSummaryRead(summary: parseCloudSummary(_body()));
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
          return CloudSummaryRead(summary: parseCloudSummary(_body()));
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

  // ── R3F-2: THE NAMED 4xx ───────────────────────────────────────────────────
  //
  // Device round three (2026-09-06): an unverified account past the 3-day grace
  // gets `403 {"error":"EMAIL_NOT_VERIFIED"}` on every read. The body used to be
  // DRAINED, so every 4xx arrived as the same null and the one control that
  // needs the ceiling said 「try again」 — a retry that could never work.
  //
  // These run against a real loopback HttpServer rather than a fake fetcher, on
  // purpose: the thing under test is `httpCloudSummaryFetch`'s own handling of a
  // response body, and a double that returned a `CloudSummaryRead` would be
  // asserting the value this file itself wrote.
  group('httpCloudSummaryFetch names the refusals it can name', () {
    late HttpServer server;
    late int status;
    late String body;

    setUp(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      unawaited(() async {
        await for (final HttpRequest req in server) {
          req.response.statusCode = status;
          req.response.headers.contentType = ContentType.json;
          req.response.write(body);
          await req.response.close();
        }
      }());
    });
    tearDown(() async => server.close(force: true));

    Future<CloudSummaryRead> read() => httpCloudSummaryFetch(
      Uri.parse('http://127.0.0.1:${server.port}/api/cloud/summary'),
      'jwt-quota',
      const Duration(seconds: 5),
    );

    test('403 EMAIL_NOT_VERIFIED arrives as a NAME, not as a null', () async {
      status = 403;
      body = jsonEncode(<String, Object?>{'error': 'EMAIL_NOT_VERIFIED'});
      final CloudSummaryRead got = await read();
      expect(got.summary, isNull);
      expect(got.refusal, CloudSummaryRefusal.emailNotVerified);
    });

    test('403 ACCOUNT_RESTRICTED is its own name', () async {
      status = 403;
      body = jsonEncode(<String, Object?>{'error': 'ACCOUNT_RESTRICTED'});
      expect((await read()).refusal, CloudSummaryRefusal.accountRestricted);
    });

    test('401 is authExpired without reading the body', () async {
      status = 401;
      body = jsonEncode(<String, Object?>{'error': 'AUTH_TOKEN_EXPIRED'});
      expect((await read()).refusal, CloudSummaryRefusal.authExpired);
    });

    test('🔴 an UNNAMED 4xx and a 5xx stay nameless', () async {
      // The negative control, and it is the half that keeps the generic
      // 「try again」 honest: if every failure came back named, the row would
      // start explaining outages it knows nothing about.
      status = 403;
      body = jsonEncode(<String, Object?>{'error': 'SOMETHING_NEW'});
      expect((await read()).refusal, isNull);

      status = 500;
      body = 'upstream is unwell';
      final CloudSummaryRead five = await read();
      expect(five.refusal, isNull);
      expect(five.summary, isNull);
    });

    test('a 200 clears nothing and names nothing', () async {
      status = 200;
      body = jsonEncode(_body());
      final CloudSummaryRead got = await read();
      expect(got.summary, isNotNull);
      expect(got.refusal, isNull);
    });
  });

  test('🔴 the controller drops a refusal when the account signs out', () async {
    // A reason outliving its account would explain a block the next account is
    // not under. `summary` already had this rule; the reason needs its own,
    // because it does NOT follow summary's 「a miss changes nothing」.
    final LoginController login = await _login(account: _signedIn);
    final CloudSummaryController c = CloudSummaryController(
      login: login,
      saasEndpoint: 'http://127.0.0.1:1',
      fetcher: (Uri url, String bearer, Duration budget) async =>
          const CloudSummaryRead(refusal: CloudSummaryRefusal.emailNotVerified),
    );
    c.refresh();
    await Future<void>.delayed(Duration.zero);
    expect(c.refusal, CloudSummaryRefusal.emailNotVerified);

    await login.logout();
    await Future<void>.delayed(Duration.zero);
    expect(c.refusal, isNull);
    c.dispose();
    login.dispose();
  });
}
