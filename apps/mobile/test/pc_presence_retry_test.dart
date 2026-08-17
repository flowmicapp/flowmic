// The bounded retry inside ONE presence poll cycle, and the classification that
// makes it possible to bound it correctly.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/pc_presence_probe.dart
//     ([PcPresenceMiss] / [PcPresenceRetryBudget] / [readPcPresenceRetrying])
//
// 🔴 THE DEFECT. Every failure used to collapse into one value, so a retry
// layer could not tell a 3-second timeout (asking again usually works) from a
// 401 (asking again is an authentication hammer). With no way to tell them
// apart there was no retry at all, and on the instance list — which has no
// timer of its own — one transient miss stuck on screen as 「电脑是否在线未知」
// ("PC status unknown") until the user thought to pull to refresh.
//
// 🔴 WHY THE CLASSES ARE ASSERTED AGAINST A REAL `HttpServer` AND NOT A FAKE.
// Same reason pc_presence_probe_test.dart gives, and it is this repo's RV-97
// lesson: when the defect lives in the layer a test double replaces, it is
// invisible to the whole suite. 「什么算 timeout」 ("what counts as a timeout")
// is decided by `dart:io`'s exception types, so asserting it against a
// hand-written fake would only prove that we can write down our own
// assumptions. The loopback server below returns real 404s and real 401s and
// really stops answering, and the classification is read off that.
//
// ⚠️ `TestWidgetsFlutterBinding` installs HttpOverrides, so this file uses bare
// `test` and never pumps a widget — otherwise the dial would fall back onto the
// double layer again.
//
// ── REVERSE CONTROL (executed 2026-08-16, observed — not reasoned) ──────────
// Break: in `readPcPresenceRetrying` (pc_presence_probe.dart), replace the loop
// bound `i < budget.attempts` with `i < 1` — i.e. force a single attempt, which
// is exactly the behaviour that existed before this card.
// Observed: 14 pass / 5 FAIL, and every one of the five failed BY SETTLING ON
// THE DEFECT rather than for an incidental reason:
//   'two timeouts then a good answer reads as online, within one cycle'
//     Expected: <PcPresence.online>   Actual: <PcPresence.unknown>
//   'a retryable miss really opens a NEW attempt (the reader is called again)'
//     Expected: <PcPresence.offline>  Actual: <PcPresence.unknown>
//   'the instance-list budget spends every attempt before settling on unknown'
//     Expected: <3>                   Actual: <1>
//   'the per-attempt timeout really reaches the reader (not just the count)'
//     Expected: [0:00:02.5, 0:00:02.5]  Actual: [0:00:02.5]
//   'the real backoff is actually waited (300 ms + 900 ms), not skipped'
//     Expected: <3>                   Actual: <1>
// 🔴 The control on the control: the four 「never retried」 tests (401, definite
// offline, unclassified miss, throwing reader) stayed GREEN under the break.
// They MUST be unable to detect the loop bound — if breaking the retry had also
// reddened them, they would not be measuring what their names claim.
// Restored, re-run: 19/19 green.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flutter_test/flutter_test.dart';

/// A reader double that hands back a scripted sequence and records every call.
/// It records the TIMEOUT it was handed as well as the count — the per-attempt
/// budget is half of what this card decided, and a test that only counted
/// attempts would be blind to it being wrong.
class _ScriptedReader {
  _ScriptedReader(this._script);

  final List<PcPresenceReading> _script;
  final List<Duration> timeoutsSeen = <Duration>[];
  int calls = 0;

  Future<PcPresenceReading> read(Uri url, String token, Duration timeout) async {
    timeoutsSeen.add(timeout);
    final PcPresenceReading r =
        _script[calls < _script.length ? calls : _script.length - 1];
    calls++;
    return r;
  }
}

Future<({String url, HttpServer server})> _serve(
  void Function(HttpRequest req) reply,
) async {
  final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen(reply);
  return (url: 'http://127.0.0.1:${server.port}', server: server);
}

const PcPresenceReading _timeoutMiss =
    PcPresenceReading.unanswered(PcPresenceMiss.timeout);
const PcPresenceReading _unauthorizedMiss =
    PcPresenceReading.unanswered(PcPresenceMiss.unauthorized);
const PcPresenceReading _online =
    PcPresenceReading(presence: PcPresence.online, pcId: 'pc-1');
const PcPresenceReading _offline =
    PcPresenceReading(presence: PcPresence.offline, pcId: 'pc-1');

/// A budget with the shape of the real ones but no wall-clock cost, for the
/// cases where the numbers under test are the COUNTS rather than the waits.
const PcPresenceRetryBudget _fast = PcPresenceRetryBudget(
  attempts: 3,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[Duration.zero, Duration.zero],
);

void main() {
  final Uri url = Uri.parse('http://127.0.0.1:1/api/pc/presence');

  // ── the classification, measured against a real server ────────────────────

  test('🔴 a real 401 and a real 404 are told apart, and neither is retryable', () async {
    for (final (int code, PcPresenceMiss want) in <(int, PcPresenceMiss)>[
      (401, PcPresenceMiss.unauthorized),
      (403, PcPresenceMiss.unauthorized),
      (404, PcPresenceMiss.notFound),
      (500, PcPresenceMiss.serverError),
      (503, PcPresenceMiss.serverError),
    ]) {
      final s = await _serve((HttpRequest req) {
        req.response.statusCode = code;
        req.response.close();
      });
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      // 🔴 The VALUE is still unknown for every one of them — classifying a
      // miss must not have turned any of them into a claim about the PC.
      expect(r.presence, PcPresence.unknown, reason: 'HTTP $code');
      expect(r.miss, want, reason: 'HTTP $code');
      expect(r.miss!.retryable, isFalse, reason: 'HTTP $code');
      await s.server.close(force: true);
    }
  });

  test('🔴 a real stalled server classes as timeout, and timeout IS retryable', () async {
    // Accepts the connection and then never answers: the only way out is the
    // per-attempt budget elapsing, which is what `timeout` has to mean.
    final s = await _serve((HttpRequest req) {/* deliberately no response */});
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(milliseconds: 300),
    );
    expect(r.presence, PcPresence.unknown);
    expect(r.miss, PcPresenceMiss.timeout);
    expect(r.miss!.retryable, isTrue);
  });

  test('🔴 a connection-level fault is RETRYABLE, whichever of the two arms catches it', () async {
    // ⚠️ THIS TEST DELIBERATELY DOES NOT PIN WHICH CLASS. Written first as
    // `expect(r.miss, PcPresenceMiss.network)`, it went red on this machine
    // with `Actual: <PcPresenceMiss.timeout>`: dialling a closed loopback port
    // here does not come back as a refused `SocketException`, it hangs until
    // our own `.timeout()` fires. Both readings are honest and which one you
    // get is the platform's business, not the product's.
    //
    // 🔴 So the assertion is the property the PRODUCT depends on: an address we
    // could not reach must leave the door open to asking again. Pinning
    // `network` here would have been pinning a Windows-loopback detail as if it
    // were a contract — and it would go red on a machine where the connect is
    // refused instead, for a reason that has nothing to do with a defect.
    final HttpServer tmp = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final int deadPort = tmp.port;
    await tmp.close(force: true);
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('http://127.0.0.1:$deadPort/api/pc/presence'),
      'tok',
      const Duration(milliseconds: 800),
    );
    expect(r.presence, PcPresence.unknown);
    expect(
      r.miss,
      anyOf(PcPresenceMiss.network, PcPresenceMiss.timeout),
      reason: 'a connection-level fault must not land on a non-retryable class',
    );
    expect(r.miss!.retryable, isTrue);
  });

  test('a server that hangs up mid-exchange is retryable too, never malformed', () async {
    // The other connection-level shape: the socket really does break, rather
    // than never opening. It must not be mistaken for 「这个服务器答了一个我们
    // 看不懂的东西」 ("this server answered something we cannot read"), which is
    // a permanent condition and would stop the retry.
    final s = await _serve((HttpRequest req) {
      unawaited(req.response.detachSocket().then((Socket sock) => sock.destroy()));
    });
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 2),
    );
    expect(r.presence, PcPresence.unknown);
    expect(r.miss!.retryable, isTrue, reason: 'observed class: ${r.miss}');
  });

  test('a 200 with an unbelievable body classes as malformed, not retryable', () async {
    for (final Object? body in <Object?>[
      'not json at all',
      <String, Object?>{'ok': false, 'pc_online': true},
      <String, Object?>{'ok': true, 'pc_online': 'yes'},
    ]) {
      final s = await _serve((HttpRequest req) {
        req.response
          ..statusCode = 200
          ..write(body is String ? body : jsonEncode(body));
        req.response.close();
      });
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      expect(r.presence, PcPresence.unknown, reason: '$body');
      expect(r.miss, PcPresenceMiss.malformed, reason: '$body');
      expect(r.miss!.retryable, isFalse, reason: '$body');
      await s.server.close(force: true);
    }
  });

  test('🔴 an ANSWERED reading carries no miss at all (a measurement has no excuse)', () async {
    final s = await _serve((HttpRequest req) {
      req.response
        ..statusCode = 200
        ..write(jsonEncode(<String, Object?>{
          'ok': true,
          'pc_id': 'pc-1',
          'pc_online': false,
        }));
      req.response.close();
    });
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 3),
    );
    expect(r.presence, PcPresence.offline);
    expect(r.miss, isNull);
  });

  // ── the retry loop ────────────────────────────────────────────────────────

  test('🔴 two timeouts then a good answer reads as online, within one cycle', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_timeoutMiss, _timeoutMiss, _online]);
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: reader.read,
    );
    expect(r.presence, PcPresence.online);
    expect(r.pcId, 'pc-1');
    expect(reader.calls, 3);
  });

  test('a retryable miss really opens a NEW attempt (the reader is called again)', () async {
    final _ScriptedReader reader = _ScriptedReader(<PcPresenceReading>[
      const PcPresenceReading.unanswered(PcPresenceMiss.network),
      const PcPresenceReading.unanswered(PcPresenceMiss.network),
      _offline,
    ]);
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: reader.read,
    );
    // 🔴 The recovered answer is `offline` — a MEASURED absence. Retrying must
    // be able to arrive at bad news; a loop that only stopped on `online` would
    // be a machine for manufacturing optimism.
    expect(r.presence, PcPresence.offline);
    expect(reader.calls, 3);
  });

  test('the instance-list budget spends every attempt before settling on unknown', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_timeoutMiss]);
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: reader.read,
    );
    expect(r.presence, PcPresence.unknown);
    expect(reader.calls, 3);
    // 🔴 And after exhaustion the answer is still 「不知道」 — never `offline`.
    // Retry is an attempt to GET an answer, never a licence to invent one.
    expect(r.presence, isNot(PcPresence.offline));
  });

  test('🔴 a 401 is asked exactly once — the server answered, it just said no', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_unauthorizedMiss, _online]);
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: reader.read,
    );
    expect(reader.calls, 1);
    expect(r.presence, PcPresence.unknown);
    // The script's second entry was `online`; a loop that retried a 401 would
    // have reached it and reported a PC that was never actually asked about.
  });

  test('🔴 a definite offline is asked exactly once — a measurement is not a miss', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_offline, _online]);
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: reader.read,
    );
    expect(reader.calls, 1);
    expect(r.presence, PcPresence.offline);
  });

  test('🔴 an UNCLASSIFIED miss is asked exactly once (every pre-existing fake keeps its behaviour)', () async {
    final _ScriptedReader reader = _ScriptedReader(
      <PcPresenceReading>[PcPresenceReading.unknown, _online],
    );
    await readPcPresenceRetrying(url, 'tok', budget: _fast, reader: reader.read);
    expect(reader.calls, 1);
  });

  test('a reader that THROWS is not retried and still settles on unknown', () async {
    int calls = 0;
    final PcPresenceReading r = await readPcPresenceRetrying(
      url,
      'tok',
      budget: _fast,
      reader: (Uri url, String token, Duration timeout) {
        calls++;
        // An Error, not an Exception — RV-89's shape.
        throw ArgumentError('unsupported scheme');
      },
    );
    expect(calls, 1);
    expect(r.presence, PcPresence.unknown);
    expect(r.miss, PcPresenceMiss.unexpected);
  });

  // ── the two budgets are the numbers this card decided ──────────────────────

  test('🔴 the per-attempt timeout really reaches the reader (not just the count)', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_timeoutMiss]);
    await readPcPresenceRetrying(
      url,
      'tok',
      budget: const PcPresenceRetryBudget(
        attempts: 2,
        perAttemptTimeout: Duration(milliseconds: 2500),
        backoff: <Duration>[Duration.zero],
      ),
      reader: reader.read,
    );
    expect(
      reader.timeoutsSeen,
      <Duration>[const Duration(milliseconds: 2500), const Duration(milliseconds: 2500)],
    );
  });

  test('the declared budgets: instance list 3/3s/300+900, in-session 2/3s/500', () {
    expect(kInstanceListPresenceBudget.attempts, 3);
    expect(kInstanceListPresenceBudget.perAttemptTimeout, const Duration(seconds: 3));
    expect(kInstanceListPresenceBudget.backoff, <Duration>[
      const Duration(milliseconds: 300),
      const Duration(milliseconds: 900),
    ]);
    expect(kSessionPollPresenceBudget.attempts, 2);
    // 🔴 3 s, not the 2.5 s this pinned until 2026-08-16. Both budgets now
    // DECLARE the same number their caller injects — the instance list has
    // always matched `ConnectionsController.probeTimeout`, and the session poll
    // now matches `PttSession.presencePollTimeout`. While these two disagreed,
    // the session's field was read by nothing at all.
    expect(
      kSessionPollPresenceBudget.perAttemptTimeout,
      const Duration(seconds: 3),
    );
    expect(kSessionPollPresenceBudget.backoff, <Duration>[
      const Duration(milliseconds: 500),
    ]);
  });

  test('🔴 every budget has exactly attempts-1 gaps (an off-by-one here is a range error at runtime)', () {
    for (final PcPresenceRetryBudget b in <PcPresenceRetryBudget>[
      kInstanceListPresenceBudget,
      kSessionPollPresenceBudget,
    ]) {
      expect(b.backoff.length, b.attempts - 1);
    }
  });

  test('🔴 the in-session cycle fits inside one poll tick, with room to spare', () {
    // The arithmetic. `kIdlePcPresencePollInterval` is an owner ruling (10 s)
    // that must not be tuned to make a cycle fit — so the cycle is what has to
    // give, and this pins that it does: 2 × 3 s + 0.5 s = 6.5 s, 35 % headroom.
    // ⚠️ A THIRD attempt would make it 3 × 3 + 1.0 = 10 s exactly, i.e. none —
    // this assertion is what would catch that, so do not "fix" it by relaxing
    // the bound below.
    expect(kSessionPollPresenceBudget.worstCase, const Duration(milliseconds: 6500));
    expect(
      kSessionPollPresenceBudget.worstCase.inMilliseconds * 2,
      lessThan(kIdlePcPresencePollInterval.inMilliseconds * 2),
    );
    expect(
      kSessionPollPresenceBudget.worstCase,
      lessThan(kIdlePcPresencePollInterval),
    );
  });

  test('the instance-list worst case is the ~10.2 s this card signed up for', () {
    expect(kInstanceListPresenceBudget.worstCase, const Duration(milliseconds: 10200));
  });

  test('🔴 the real backoff is actually waited (300 ms + 900 ms), not skipped', () async {
    final _ScriptedReader reader =
        _ScriptedReader(<PcPresenceReading>[_timeoutMiss]);
    final Stopwatch sw = Stopwatch()..start();
    await readPcPresenceRetrying(
      url,
      'tok',
      // The real declared backoff, with an instant reader so the only elapsed
      // time IS the backoff. A loop that "had" a backoff list but never awaited
      // it would return in ~0 ms and this would be the only test to notice.
      budget: PcPresenceRetryBudget(
        attempts: kInstanceListPresenceBudget.attempts,
        perAttemptTimeout: const Duration(seconds: 3),
        backoff: kInstanceListPresenceBudget.backoff,
      ),
      reader: reader.read,
    );
    sw.stop();
    expect(reader.calls, 3);
    expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(1200));
  });
}
