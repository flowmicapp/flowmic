// owner 2026-08-30 — 「手机端的连接状态经常会在：电脑已离线／中继可达，电脑不可…／
// 问不到／在线 等状态间切换，事实上无论怎么样，手机我都没断网」.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §2.
//
// ── THE DEFECT, STATED PRECISELY ────────────────────────────────────────────
//
// Those four words are not four states. They are four possible OUTCOMES of one
// round of probing, and `instanceLivenessFaceOf` is a pure projection of the
// round that just finished — no time, no previous answer, no count. So the
// screen changes whenever a probe's outcome changes, which is not the same
// thing as the world changing.
//
// And a probe's outcome changes constantly ON A HEALTHY LINK. The presence poll
// runs every 10 s with a 2 × 3 s budget, and `InstanceReach`'s own doc records
// the measurement that matters: on the path this product's cloud relay actually
// takes, 7.5 % of probes ran past a 3 s budget WHILE THE RELAY WAS SERVING
// EVERY ONE OF THEM. One round in thirteen, on a link that is fine.
//
// ── WHY THE FIX IS NOT 「REMEMBER THE LAST ANSWER」 ──────────────────────────
//
// `ptt_presence_poll.dart` constraint ② says: unable to ask ⇒ `unknown`, NEVER
// carry over the previous answer. That rule is RIGHT and it is not what is
// being relaxed here — it exists to stop a screen saying 「online」 about a
// computer that was switched off an hour ago.
//
// So the two questions are separated instead:
//   · the TRACKER answers 「what did this round find out」 — unchanged;
//   · this class answers 「what should the screen say」 — the last CONCLUSIVE
//     answer, marked as being re-checked, until the hold burns out.
//
// One value answering both was the whole defect.
//
// 🔴 THE HOLD IS BOUNDED, AND THAT BOUND IS THE POINT. Without it this would be
// the stale-「online」 bug moved one layer up, which is worse than the flicker
// because it looks calm.

import 'pc_presence.dart';

/// How many consecutive inconclusive rounds the last answer survives.
///
/// 🔴 THE THIRD ONE BURNS IT, NOT THE FOURTH. The determinism design says so in
/// as many words (§2-1 「连续 3 轮没结论」, and case H-2 「连续 3 轮问不到 → 屏幕
/// 改写「问不到」」). The comparison below read `>` until 2026-09-07, so the hold
/// outlived its own specification by one round.
///
/// ⚠️ THE CADENCE UNDER THIS NUMBER IS 15 s, NOT 10 s — this doc used to say
/// 10 s and drew a conclusion from it that was false. The only production caller
/// is the instance-list row (`connections_row_faces.dart`), and that page
/// re-probes on [kInstanceListPresencePollInterval] (15 s). The 10 s constant
/// (`kIdlePcPresencePollInterval`) belongs to `PttSession`'s own poll, which
/// feeds `PcPresenceTracker` and never reaches this class.
///
/// 🔴 WHAT THAT ERROR HID: at 15 s, three rounds is ≈45 s — which is
/// [kLivenessHoldMaxAge] EXACTLY, not 「comfortably inside」 it. The two bounds
/// land on the same round. With `>` they raced: whether the row burnt on round
/// three (age) or round four (count) was decided by a few hundred milliseconds
/// of probe latency, so the behaviour was a coin flip rather than a count. `>=`
/// makes the count decisive and returns the age bound to the job its own doc
/// describes — covering rounds that stop happening at all.
const int kLivenessHoldMisses = 3;

/// How long the last answer survives when rounds stop happening at all.
///
/// 🔴 IT COVERS THE CASE THE COUNTER CANNOT: a poll that is not ticking
/// produces no misses to count, so a counter alone would freeze the screen on
/// the last conclusive answer FOREVER — the screen becomes calm and wrong,
/// which is precisely the failure the whole design exists to avoid. Real
/// producers: the app in the background, the OS freezing timers, the poll's own
/// two preconditions (idle AND connected) going false.
const Duration kLivenessHoldMaxAge = Duration(seconds: 45);

/// What the screen should draw, and whether we are re-asking behind it.
class HeldLiveness {
  const HeldLiveness({required this.face, required this.rechecking});

  final InstanceLivenessFace face;

  /// True when [face] is the LAST answer rather than this round's.
  ///
  /// ⚠️ It is a MODIFIER, never a seventh word. A new state is a new thing for
  /// the user to learn, and what this means to them is 「go by what it said a
  /// moment ago; we are checking」 — that qualifies the answer, it does not
  /// replace it.
  final bool rechecking;
}

/// True when the server actually answered — the six faces that establish
/// something about the world.
///
/// ⚠️ [InstanceLivenessFace.unreachable] IS CONCLUSIVE, and this is the easy one
/// to get backwards. 「Cannot reach that address」 is a measurement (a refused
/// connection, a failed lookup), not a missing answer. Treating it as
/// inconclusive would hold 「online」 on screen through a real outage, which is
/// the exact lie the hold is bounded to prevent.
bool isConclusiveLiveness(InstanceLivenessFace f) => switch (f) {
      InstanceLivenessFace.pcOnline => true,
      InstanceLivenessFace.pcOffline => true,
      InstanceLivenessFace.pcSignedOut => true,
      InstanceLivenessFace.pcOtherAccount => true,
      InstanceLivenessFace.pairingRevoked => true,
      InstanceLivenessFace.unreachable => true,
      // Nothing was established this round.
      InstanceLivenessFace.checking => false,
      InstanceLivenessFace.reachUnanswered => false,
      InstanceLivenessFace.relayOnlyPcUnknown => false,
      InstanceLivenessFace.unmeasured => false,
    };

/// One row's held state. Cheap; the caller keeps one per instance key.
class LivenessHold {
  InstanceLivenessFace? _last;
  int? _lastAtMs;
  int _misses = 0;

  /// Feed this round's projection; get what to draw.
  ///
  /// [nowMs] is passed in rather than read here so the bound is testable
  /// without a real clock — the same DI rule the rest of this package follows.
  ///
  /// 🔴 KNOWN AND NOT FIXED HERE — [kLivenessHoldMisses] counts CALLS, and the
  /// caller is a widget build, so a miss is 「a build that projected no answer」
  /// rather than 「a round that got no answer」. The two are not the same number:
  /// MEASURED 2026-09-07 (widget test on the real page) — two `load()`
  /// notifications, a genuine production trigger (returning to this page), with
  /// ZERO poll rounds elapsed, drove the count from 1 to 4 and burnt a hold that
  /// by the specification still had two rounds to live. Counting rounds instead
  /// needs a round identity threaded from `ConnectionsController`, which is a
  /// design change and not this card's; it is reported rather than invented
  /// here. ⚠️ Do not read the numbers in the tests as device behaviour: a widget
  /// test coalesces a round's notifications into one frame, so there a miss and
  /// a round happen to coincide.
  HeldLiveness observe(InstanceLivenessFace face, {required int nowMs}) {
    if (isConclusiveLiveness(face)) {
      _last = face;
      _lastAtMs = nowMs;
      _misses = 0;
      return HeldLiveness(face: face, rechecking: false);
    }
    _misses++;
    final InstanceLivenessFace? last = _last;
    final int? at = _lastAtMs;
    if (last == null || at == null) {
      // Nothing has ever been established, so there is nothing to hold. The
      // honest word for that is this round's own — 「checking」 / 「never asked」.
      return HeldLiveness(face: face, rechecking: false);
    }
    // `>=`, not `>`: [kLivenessHoldMisses] is the miss that burns it, not the
    // last one it survives. See that constant's doc for what `>` cost.
    final bool burnt = _misses >= kLivenessHoldMisses
        || nowMs - at >= kLivenessHoldMaxAge.inMilliseconds;
    if (burnt) {
      // 🔴 The last answer is DROPPED, not merely stopped being shown. Keeping
      // it would let a single conclusive round from ten minutes ago come back
      // the moment the counter reset — a state that reappears without being
      // re-measured is the same lie with a delay on it.
      _last = null;
      _lastAtMs = null;
      return HeldLiveness(face: face, rechecking: false);
    }
    return HeldLiveness(face: last, rechecking: true);
  }

  /// Forget everything — for a row whose identity changed under it (re-pair,
  /// account switch). NOT called on an ordinary miss: that is what the hold is.
  void reset() {
    _last = null;
    _lastAtMs = null;
    _misses = 0;
  }
}

/// The holds for a whole list, keyed the way the instance list keys its rows.
class LivenessHolds {
  final Map<String, LivenessHold> _byKey = <String, LivenessHold>{};

  HeldLiveness observe(String key, InstanceLivenessFace face,
          {required int nowMs}) =>
      (_byKey[key] ??= LivenessHold()).observe(face, nowMs: nowMs);

  /// Drop rows that are no longer on screen, so a list the user has pruned
  /// does not keep their holds alive forever.
  void retain(Set<String> keys) =>
      _byKey.removeWhere((String k, LivenessHold _) => !keys.contains(k));

  void forget(String key) => _byKey.remove(key);
}
