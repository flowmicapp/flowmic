// Card B4-15 —— multi-NIC candidates: the QR carries them, the phone picks the one that answers.
//
// The pure half. What the camera/socket/network do is elsewhere; every DECISION
// is here, and the two that matter most are negative:
//   · with ONE candidate nothing is probed at all (a pre-B4-15 QR and a typed
//     address must cost exactly what they cost before);
//   · with NOTHING reachable the primary is still returned — the probe is a
//     chooser, never a gate, so a false-negative cannot invent a refusal.

import 'dart:async';

import 'package:flowmic/src/session/endpoint_candidates.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flutter_test/flutter_test.dart';

/// A reader that answers from a set and COUNTS its calls — the count is what
/// proves the single-candidate path costs nothing.
class _Reader {
  _Reader(this.online);
  final Set<String> online; // hosts that answer /api/health
  final List<Uri> asked = <Uri>[];

  Future<HealthReading> call(Uri url, Duration timeout) async {
    asked.add(url);
    return online.contains(url.host)
        ? const HealthReading(ok: true, channel: ServerChannel.lan)
        : HealthReading.offline;
  }
}

const Duration kFast = Duration(milliseconds: 50);

void main() {
  group('qrDialCandidates — reading the desktop`s alt= (B4-15)', () {
    test('a QR with alt= yields the primary FIRST, then the alternates', () {
      // The literal the desktop writes (apps/desktop/src/lib/pairing.ts).
      const String link =
          'flowmic://pair?endpoint=ws://10.0.0.78:41879&code=1234'
          '&channel=standalone&alt=100.64.7.78,10.0.0.9';
      expect(qrDialCandidates(link), <String>[
        'ws://10.0.0.78:41879',
        'ws://100.64.7.78:41879',
        'ws://10.0.0.9:41879',
      ]);
    });

    test('scheme and port come from the primary — an alternate cannot disagree', () {
      const String link =
          'flowmic://pair?endpoint=wss://pc.example:8443&code=1234&alt=10.1.2.3';
      expect(qrDialCandidates(link), <String>[
        'wss://pc.example:8443',
        'wss://10.1.2.3:8443',
      ]);
    });

    test('a QR with no alt= is exactly one candidate (the pre-B4-15 payload)', () {
      const String link =
          'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone';
      expect(qrDialCandidates(link), <String>['ws://192.168.1.5:41879']);
    });

    test('no endpoint at all ⇒ no candidates (NO_ENDPOINT stays reachable)', () {
      // Inventing one here would swallow the existing 「4 位码要配一个地址」 error.
      expect(qrDialCandidates('flowmic://pair?code=1234'), isEmpty);
    });

    test('blank/duplicate alternates are dropped rather than dialled', () {
      const String link =
          'flowmic://pair?endpoint=ws://10.0.0.1:41879&code=1234'
          '&alt=,10.0.0.1, 10.0.0.2 ,10.0.0.2';
      expect(qrDialCandidates(link), <String>[
        'ws://10.0.0.1:41879',
        'ws://10.0.0.2:41879',
      ]);
    });
  });

  group('rememberedDialCandidates — what a reconnect falls through', () {
    test('the address that last worked leads, then the recorded set', () {
      expect(
        rememberedDialCandidates('http://100.64.7.78:41879', <String>[
          'http://10.0.0.78:41879',
          'http://100.64.7.78:41879',
        ]),
        <String>['http://100.64.7.78:41879', 'http://10.0.0.78:41879'],
      );
    });

    test('no recorded set ⇒ exactly one candidate', () {
      expect(rememberedDialCandidates('http://a:1', const <String>[]), <String>['http://a:1']);
    });
  });

  group('chooseDialEndpoint — the probe is a CHOOSER, never a gate', () {
    test('ONE candidate: nothing is probed at all', () async {
      final _Reader r = _Reader(<String>{});
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://192.168.1.5:41879'],
        read: r.call,
        timeout: kFast,
      );
      expect(c.endpoint, 'ws://192.168.1.5:41879');
      expect(c.probed, isFalse);
      // The load-bearing assertion: every existing pairing path is
      // single-candidate, so this is what says they cost nothing new.
      expect(r.asked, isEmpty);
    });

    test('the reachable one wins even when the desktop ranked it second', () async {
      // owner's machine, exactly: the sidecar resolved the VPN address three
      // rounds running, and the phone can only reach the LAN one.
      final _Reader r = _Reader(<String>{'100.64.7.78'});
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://10.0.0.78:41879', 'ws://100.64.7.78:41879'],
        read: r.call,
        timeout: kFast,
      );
      expect(c.endpoint, 'ws://100.64.7.78:41879');
      expect(c.probed, isTrue);
      // ws→http normalization happens in the probe funnel (RV-89/RV-97), so a
      // ws-url QR really does get probed rather than throwing an ArgumentError.
      expect(r.asked.map((Uri u) => u.scheme).toSet(), <String>{'http'});
      expect(r.asked.map((Uri u) => u.path).toSet(), <String>{'/api/health'});
    });

    test('REVERSE: when the FIRST one answers, it keeps the lead', () async {
      // Without this, an implementation that always returned the last reachable
      // candidate — or the fastest responder — would pass the test above. The
      // order has to be the declared one, or two runs on one network can store
      // two different endpoints.
      final _Reader r = _Reader(<String>{'10.0.0.78', '100.64.7.78'});
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://10.0.0.78:41879', 'ws://100.64.7.78:41879'],
        read: r.call,
        timeout: kFast,
      );
      expect(c.endpoint, 'ws://10.0.0.78:41879');
    });

    test('nothing reachable ⇒ still the primary, plus the full attempt list', () async {
      final _Reader r = _Reader(<String>{});
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://a:1', 'ws://b:1'],
        read: r.call,
        timeout: kFast,
      );
      // The refusal a gate would produce is exactly what this must NOT do.
      expect(c.endpoint, 'ws://a:1');
      expect(c.attempts.map((CandidateAttempt a) => a.endpoint), <String>['ws://a:1', 'ws://b:1']);
      expect(c.attempts.every((CandidateAttempt a) => !a.reachable), isTrue);
    });

    test('a reader that hangs cannot hang a pairing', () async {
      // Belt on top of the reader's own budget: a stub (or a platform stack)
      // that ignores its timeout must not park the user on 配对中… forever.
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://a:1', 'ws://b:1'],
        read: (Uri url, Duration budget) => Completer<HealthReading>().future,
        timeout: const Duration(milliseconds: 10),
      );
      expect(c.endpoint, 'ws://a:1');
    }, timeout: const Timeout(Duration(seconds: 5)));

    test('a reader that THROWS an Error (not an Exception) is still an answer', () async {
      // RV-89 in one line: `on Exception` did not see an ArgumentError, and the
      // escape wrote down 「unknown」 for the life of the session.
      final EndpointChoice c = await chooseDialEndpoint(
        candidates: <String>['ws://a:1', 'ws://b:1'],
        read: (Uri url, Duration budget) async => throw ArgumentError('Unsupported scheme'),
        timeout: kFast,
      );
      expect(c.endpoint, 'ws://a:1');
      expect(c.attempts, hasLength(2));
    });
  });

  group('resolveLadderUrl — 🔴 绝不许串号', () {
    test('refuses when the ladder`s url is not one of THIS pairing`s addresses', () async {
      // The red line. `_dialCandidates` is a field, so a pairing that ended
      // badly could in principle leave one behind; a resolver that trusted it
      // would redirect a LIVE ladder at another machine, and the token would be
      // presented to a PC it was never issued for.
      final _Reader r = _Reader(<String>{'100.64.7.78'});
      final String? next = await resolveLadderUrl(
        current: 'ws://some.other.pc:41879',
        known: <String>['ws://10.0.0.78:41879', 'ws://100.64.7.78:41879'],
        read: r.call,
        timeout: kFast,
      );
      expect(next, isNull);
      // Not one request was made, either — the refusal is structural, not a
      // 「probe them and hope none answers」.
      expect(r.asked, isEmpty);
    });

    test('moves to a reachable sibling address of the same PC', () async {
      // The positive control for the refusal above: without it, a resolver that
      // simply always returned null would pass that test forever.
      final _Reader r = _Reader(<String>{'100.64.7.78'});
      final String? next = await resolveLadderUrl(
        current: 'ws://10.0.0.78:41879',
        known: <String>['ws://10.0.0.78:41879', 'ws://100.64.7.78:41879'],
        read: r.call,
        timeout: kFast,
      );
      expect(next, 'ws://100.64.7.78:41879');
    });

    test('one (or no) recorded address ⇒ null, without probing', () async {
      final _Reader r = _Reader(<String>{'a'});
      expect(
        await resolveLadderUrl(
          current: 'ws://a:1',
          known: <String>['ws://a:1'],
          read: r.call,
          timeout: kFast,
        ),
        isNull,
      );
      expect(r.asked, isEmpty);
    });

    test('nothing reachable ⇒ answers the address it was already using', () async {
      // Never a MOVE off evidence we do not have.
      final _Reader r = _Reader(<String>{});
      expect(
        await resolveLadderUrl(
          current: 'ws://10.0.0.78:41879',
          known: <String>['ws://10.0.0.78:41879', 'ws://100.64.7.78:41879'],
          read: r.call,
          timeout: kFast,
        ),
        'ws://10.0.0.78:41879',
      );
    });
  });

  group('the loud report survives the trip through the error-code channel', () {
    test('encode → decode names every address and what it said', () {
      final String code = encodeCandidateFailure(
        attempts: const <CandidateAttempt>[
          CandidateAttempt('ws://10.0.0.78:41879', reachable: false),
          CandidateAttempt('ws://100.64.7.78:41879', reachable: false),
        ],
        dialed: 'ws://10.0.0.78:41879',
      );
      final List<MapEntry<String, CandidateFailure>> back = decodeCandidateFailure(code)!;
      expect(back.map((MapEntry<String, CandidateFailure> e) => e.key), <String>[
        'ws://10.0.0.78:41879',
        'ws://100.64.7.78:41879',
      ]);
      // The one we really dialled is distinguished from the ones we only probed:
      // 「cannot connect」 and 「cannot reach」 are different facts about different attempts.
      expect(back.first.value, CandidateFailure.dialFailed);
      expect(back.last.value, CandidateFailure.unreachable);
    });

    test('an endpoint with colons and slashes round-trips intact', () {
      final String code = encodeCandidateFailure(
        attempts: const <CandidateAttempt>[CandidateAttempt('wss://pc.example:8443', reachable: false)],
        dialed: 'wss://pc.example:8443',
      );
      expect(decodeCandidateFailure(code)!.single.key, 'wss://pc.example:8443');
    });

    test('every OTHER error code is left alone', () {
      // The decoder sits in front of pairError's switch, so a false positive here
      // would swallow PC_BUSY / PAIR_EXPIRED_CODE and print an address list.
      expect(decodeCandidateFailure(null), isNull);
      expect(decodeCandidateFailure('PC_BUSY'), isNull);
      expect(decodeCandidateFailure('CONNECT_FAILED: SocketException'), isNull);
    });
  });
}
