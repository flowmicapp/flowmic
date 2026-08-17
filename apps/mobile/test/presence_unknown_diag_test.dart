// The one diagnostic line a presence miss leaves behind.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/pc_presence_probe.dart
//     (`readPcPresenceRetrying`'s final settle, `presenceEndpointFingerprint`)
//   apps/mobile/lib/src/diag/diag_log.dart (what may and may not be written)
//
// 🔴 THE DEFECT. A field report of 「它显示『电脑是否在线未知』」 ("it showed 'PC
// status unknown'") was completely unattributable. A rejected token, a stalled
// relay, an old server with no such route and a body we could not parse all
// produced the identical screen and left identical evidence — which is to say
// none. Every one of those has a different fix, so the next occurrence was
// guaranteed to cost the same investigation as the last one.
//
// 🔴 WHY THE MISS CLASS IS THE FIELD THAT MATTERS. The line without it still
// says 「这一轮没问到」 ("this round got no answer") — which is exactly what the
// user already told us. It would be a line that exists, looks tended, and
// answers nothing. That is this repo's façade shape rendered in a log file, and
// the reverse control below is aimed straight at it.
//
// ── REVERSE CONTROL (executed 2026-08-16, observed — not reasoned) ──────────
// Break: in `readPcPresenceRetrying`, delete the `'miss':` entry from the
// `diag('presence.unknown', …)` map — the line is still emitted, still carries
// attempts / elapsed_ms / endpoint_h, and still looks like a diagnostic.
// Observed — 5 pass / 2 FAIL:
//   'a timeout and a 401 are distinguishable in the log'
//     Expected: contains 'miss=timeout'
//       Actual: '2026-08-16T21:03:01.038555Z presence.unknown attempts=2
//                elapsed_ms=0 endpoint_h=a569ff7bda2f'
//       Which: does not contain 'miss=timeout'
//   'the line names the class for every miss it can settle on'
//     the same shape, failing on the first member (`timeout`)
// 🔴 That failure is the point of the whole card: the line is PRESENT and can
// no longer answer the question it exists for. A test that only asserted
// `contains('presence.unknown')` would have stayed green through it.
// Restored, re-run: 7/7 green.

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flutter_test/flutter_test.dart';

const PcPresenceRetryBudget _twoFast = PcPresenceRetryBudget(
  attempts: 2,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[Duration.zero],
);

PcPresenceReader _always(PcPresenceReading r) =>
    (Uri url, String token, Duration timeout) async => r;

Future<List<String>> _linesFor(
  PcPresenceReading reading, {
  PcPresenceRetryBudget budget = _twoFast,
  String endpoint = 'http://192.168.1.5:41879',
}) async {
  DiagLog.instance.clear();
  await readPcPresenceRetrying(
    Uri.parse('$endpoint/api/pc/presence'),
    'fm_token_super_secret_value',
    budget: budget,
    reader: _always(reading),
  );
  return DiagLog.instance
      .snapshot()
      .where((String l) => l.contains('presence.unknown'))
      .toList();
}

void main() {
  setUp(DiagLog.instance.clear);

  test('🔴 a timeout and a 401 are distinguishable in the log', () async {
    final List<String> timedOut = await _linesFor(
      const PcPresenceReading.unanswered(PcPresenceMiss.timeout),
    );
    final List<String> refused = await _linesFor(
      const PcPresenceReading.unanswered(PcPresenceMiss.unauthorized),
    );
    expect(timedOut.single, contains('miss=timeout'));
    expect(refused.single, contains('miss=unauthorized'));
    // 🔴 And not merely 「different somewhere」: the two must not be readable as
    // the same event. Before this line existed they were byte-identical, which
    // is what made the field report unactionable.
    expect(timedOut.single, isNot(refused.single));
  });

  test('the line names the class for every miss it can settle on', () async {
    for (final PcPresenceMiss m in PcPresenceMiss.values) {
      final List<String> lines = await _linesFor(
        PcPresenceReading.unanswered(m),
        // A retryable class needs a budget it can exhaust; a non-retryable one
        // settles on the first attempt. One budget covers both.
        budget: _twoFast,
      );
      expect(lines.single, contains('miss=${m.name}'), reason: m.name);
    }
  });

  test('🔴 exactly ONE line per cycle, never one per attempt', () async {
    final List<String> lines = await _linesFor(
      const PcPresenceReading.unanswered(PcPresenceMiss.timeout),
      budget: kInstanceListPresenceBudget,
    );
    // Three attempts were made (the retry test pins that separately); the trail
    // gets one entry. A 400-line ring buffer shared with the delivery edges
    // cannot afford three per pairing per tick — and it would fill fastest on
    // exactly the flaky network where someone is about to ask for it.
    expect(lines, hasLength(1));
    expect(lines.single, contains('attempts=3'));
  });

  test('🔴 an ANSWERED cycle writes nothing at all', () async {
    for (final PcPresence p in <PcPresence>[PcPresence.online, PcPresence.offline]) {
      final List<String> lines = await _linesFor(
        PcPresenceReading(presence: p, pcId: 'pc-1'),
      );
      // A measured absence is not a miss. Logging it would drown the real
      // misses in the common case — every offline PC, every tick.
      expect(lines, isEmpty, reason: '$p');
    }
  });

  test('🔴 the raw endpoint and the token never reach the trail', () async {
    final List<String> lines = await _linesFor(
      const PcPresenceReading.unanswered(PcPresenceMiss.network),
      endpoint: 'http://192.168.1.5:41879',
    );
    final String line = lines.single;
    // Addresses are user content in this repo (`verify/lint/no-lan-ip.mjs`),
    // and the trail is uploaded to the PC on request — so everything written
    // here leaves the phone.
    expect(line, isNot(contains('192.168.1.5')));
    expect(line, isNot(contains('41879')));
    expect(line, isNot(contains('fm_token')));
    expect(line, isNot(contains('/api/pc/presence')));
    expect(line, contains('endpoint_h='));
  });

  test('the fingerprint is stable per origin and different across origins', () {
    // Stable, or two lines about one computer cannot be recognised as such —
    // which is the only thing the field is for.
    expect(
      presenceEndpointFingerprint(Uri.parse('http://192.168.1.5:41879/api/pc/presence')),
      presenceEndpointFingerprint(Uri.parse('http://192.168.1.5:41879/api/health')),
    );
    expect(
      presenceEndpointFingerprint(Uri.parse('http://192.168.1.5:41879/x')),
      isNot(presenceEndpointFingerprint(Uri.parse('http://192.168.1.6:41879/x'))),
    );
    expect(
      presenceEndpointFingerprint(Uri.parse('http://h:1/x')),
      hasLength(12),
    );
  });

  test('the line carries how long the user actually waited', () async {
    // `elapsed_ms` is the wall-clock cost of the whole cycle, backoff included.
    // Without it a report cannot tell 「答得飞快的 401」 ("a 401 that came back
    // instantly") from 「等满了预算」 ("a budget spent to the last millisecond"),
    // and those feel like two different products to the person holding it.
    final List<String> lines = await _linesFor(
      const PcPresenceReading.unanswered(PcPresenceMiss.network),
      budget: const PcPresenceRetryBudget(
        attempts: 2,
        perAttemptTimeout: Duration(seconds: 3),
        backoff: <Duration>[Duration(milliseconds: 120)],
      ),
    );
    final RegExpMatch? m =
        RegExp(r'elapsed_ms=(\d+)').firstMatch(lines.single);
    expect(m, isNotNull);
    expect(int.parse(m!.group(1)!), greaterThanOrEqualTo(120));
  });
}
