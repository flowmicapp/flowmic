// owner 2026-08-30 — the connection status must change when the WORLD changes,
// not when a probe times out.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md
//   §2-4 (this table, case for case).
//
// ⚠️ These cases pin the RULES. That the rules are actually applied to the row
// the user is looking at is `liveness_hold_wire_test.dart`'s job — the 0.3.47
// lesson, one week old: a correct rule with nothing calling it is green for as
// long as nobody looks.

import 'package:flowmic/src/session/liveness_hold.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flutter_test/flutter_test.dart';

const InstanceLivenessFace on = InstanceLivenessFace.pcOnline;
const InstanceLivenessFace off = InstanceLivenessFace.pcOffline;
const InstanceLivenessFace miss = InstanceLivenessFace.reachUnanswered;
const InstanceLivenessFace relayOnly = InstanceLivenessFace.relayOnlyPcUnknown;

void main() {
  test('H-1: one round that got no answer does NOT change the word', () {
    final LivenessHold h = LivenessHold();
    expect(h.observe(on, nowMs: 0).face, on);

    final HeldLiveness after = h.observe(miss, nowMs: 10_000);
    // The whole defect, in one assertion.
    expect(after.face, on, reason: 'the world did not change; a probe did');
    expect(after.rechecking, isTrue,
        reason: 'and the screen says so, beside the answer — not instead of it');
  });

  test('H-2: the hold BURNS OUT after three consecutive misses', () {
    final LivenessHold h = LivenessHold();
    h.observe(on, nowMs: 0);
    expect(h.observe(miss, nowMs: 10_000).face, on);
    expect(h.observe(miss, nowMs: 20_000).face, on);
    expect(h.observe(relayOnly, nowMs: 30_000).face, on,
        reason: 'a mixture of inconclusive outcomes is still just misses');
    // 🔴 The fourth. Without this the fix is the stale-「online」 bug moved one
    // layer up, which is worse than the flicker because it looks calm.
    final HeldLiveness burnt = h.observe(miss, nowMs: 40_000);
    expect(burnt.face, miss);
    expect(burnt.rechecking, isFalse);
  });

  test('H-3: a CONCLUSIVE answer lands immediately — the hold never delays it',
      () {
    final LivenessHold h = LivenessHold();
    h.observe(on, nowMs: 0);
    final HeldLiveness said = h.observe(off, nowMs: 10_000);
    expect(said.face, off);
    expect(said.rechecking, isFalse);
  });

  test('🔴 H-4: rounds stopping ENTIRELY expires the answer by age', () {
    // The case the counter structurally cannot see: no rounds, no misses to
    // count. Real producers are the app in the background, the OS freezing
    // timers, and the poll's own preconditions going false.
    final LivenessHold h = LivenessHold();
    h.observe(on, nowMs: 0);
    final HeldLiveness late =
        h.observe(miss, nowMs: kLivenessHoldMaxAge.inMilliseconds + 1);
    expect(late.face, miss,
        reason: 'one miss, but 45 s later — the answer is too old to stand');
  });

  test('🔴 unreachable is CONCLUSIVE — the easy one to get backwards', () {
    // 「Cannot reach that address」 is a measurement, not a missing answer.
    // Treating it as inconclusive would hold 「online」 on screen through a real
    // outage, which is the exact lie the bound exists to prevent.
    expect(isConclusiveLiveness(InstanceLivenessFace.unreachable), isTrue);
    final LivenessHold h = LivenessHold();
    h.observe(on, nowMs: 0);
    expect(h.observe(InstanceLivenessFace.unreachable, nowMs: 10_000).face,
        InstanceLivenessFace.unreachable);
  });

  test('with nothing ever established there is nothing to hold', () {
    final LivenessHold h = LivenessHold();
    final HeldLiveness first =
        h.observe(InstanceLivenessFace.checking, nowMs: 0);
    expect(first.face, InstanceLivenessFace.checking);
    expect(first.rechecking, isFalse,
        reason: 'nothing is being re-checked; nothing was ever checked');
  });

  test('a burnt hold does not come back when the counter resets', () {
    final LivenessHold h = LivenessHold();
    h.observe(on, nowMs: 0);
    for (int i = 1; i <= 4; i++) {
      h.observe(miss, nowMs: i * 10_000);
    }
    // Still burnt, and the old answer is gone rather than merely unshown: a
    // state that reappears without being re-measured is the same lie delayed.
    expect(h.observe(miss, nowMs: 50_000).face, miss);
  });

  test('the keyed holder keeps rows apart and prunes what left the list', () {
    final LivenessHolds holds = LivenessHolds();
    holds.observe('a', on, nowMs: 0);
    holds.observe('b', off, nowMs: 0);
    expect(holds.observe('a', miss, nowMs: 10_000).face, on);
    expect(holds.observe('b', miss, nowMs: 10_000).face, off);

    holds.retain(<String>{'a'});
    expect(holds.observe('b', miss, nowMs: 20_000).face, miss,
        reason: "b's hold went with b");
  });
}
