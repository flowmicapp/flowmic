// V2-05 / R-UX-09 — the counters, and the seam that proves they are wired.
//
// The interesting case here is the LAST one. `countUsage` asserts rather than
// no-opping when nothing is installed, and an assert nobody ever exercises is
// itself a façade — so this file fires it on purpose.

import 'package:flowmic/src/session/usage_counters.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<UsageCounters> _fresh() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return UsageCounters(await SharedPreferences.getInstance());
}

void main() {
  test('counts accumulate per event and survive a new reader', () async {
    final UsageCounters c = await _fresh();
    await c.bump(UsageEvent.remoteKey);
    await c.bump(UsageEvent.remoteKey);
    // ⚠️ The second event used to be `punctuationKey`, deleted by T-1 with the
    // punctuation group. `modeSwitch` replaces it purely as a SECOND key — what
    // this case measures is that two different counters do not collide, which
    // needs any two of them, not those two.
    await c.bump(UsageEvent.modeSwitch);

    // A second instance over the same store reads the persisted values — this is
    // what makes a 1–2 week measurement window possible across app restarts.
    final UsageCounters reader = UsageCounters(await SharedPreferences.getInstance());
    expect(reader.snapshot()['remoteKey'], 2);
    expect(reader.snapshot()['modeSwitch'], 1);
  });

  test('a never-pressed control reads 0, not null', () async {
    final UsageCounters c = await _fresh();
    // The one place in this repo where a missing value legitimately means zero:
    // a button that was never pressed genuinely was pressed zero times.
    expect(c.snapshot()['modeSwitch'], 0);
  });

  test('hold durations accumulate as total + sample count', () async {
    final UsageCounters c = await _fresh();
    await c.recordHold(const Duration(seconds: 30));
    await c.recordHold(const Duration(seconds: 2));
    final Map<String, int> s = c.snapshot();
    // Kept as a PAIR on purpose: a lone mean would hide that "the talk button is hard to press"
    // is a claim about the long holds, not the short ones.
    expect(s['ptt_hold_total_ms'], 32000);
    expect(s['ptt_hold_samples'], 2);
  });

  test('a backwards clock does not corrupt the hold total', () async {
    final UsageCounters c = await _fresh();
    await c.recordHold(const Duration(seconds: -5));
    expect(c.snapshot()['ptt_hold_samples'], 0);
    expect(c.snapshot()['ptt_hold_total_ms'], 0);
  });

  test('reset starts a clean measurement window', () async {
    final UsageCounters c = await _fresh();
    await c.bump(UsageEvent.pttSend);
    await c.recordHold(const Duration(seconds: 3));
    await c.reset();
    expect(c.snapshot()['pttSend'], 0);
    expect(c.snapshot()['ptt_hold_total_ms'], 0);
  });

  test('dump is stable and sorted so before/after tables line up', () async {
    final UsageCounters c = await _fresh();
    await c.bump(UsageEvent.modeSwitch);
    final String d = c.dump();
    expect(d, contains('modeSwitch=1'));
    final List<String> keys = d.split(' ').map((String kv) => kv.split('=').first).toList();
    expect(keys, orderedEquals(<String>[...keys]..sort()));
  });

  test('countUsage ASSERTS when nothing is installed — it never silently no-ops', () {
    // The anti-façade seam itself. If this ever stops throwing, the counters can
    // be left unwired and read zero forever with nobody the wiser — which is the
    // exact shape of the bug that left the microphone unopened for a whole
    // rewrite (13 册 §7 F1).
    resetUsageCountersForTest();
    expect(() => countUsage(UsageEvent.pttSend), throwsA(isA<AssertionError>()));
    expect(() => countHold(const Duration(seconds: 1)), throwsA(isA<AssertionError>()));

    // Put the harness's instance back so file-ordering cannot poison siblings.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    addTearDown(() async {
      installUsageCounters(UsageCounters(await SharedPreferences.getInstance()));
    });
  });
}
