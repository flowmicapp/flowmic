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
/// 🔴 CALCULATED, NOT CHOSEN. The poll ticks every 10 s
/// (`kIdlePcPresencePollInterval`), so three rounds is ≈30 s — comfortably
/// inside [kLivenessHoldMaxAge], which means that on the normal path it is
/// ALWAYS this counter that expires first and the age bound never fires. The
/// age bound is not a second opinion about the same thing; see its doc.
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
    final bool burnt = _misses > kLivenessHoldMisses
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
