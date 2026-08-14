// SPEC-REF:
//   docs/strategy/2026-07-28-v0.2-ui-ux-review.md §8 (R-UX-09 ruling)
//   docs/strategy/R7-V2-TASK-CARDS.md V2-05
//   docs/decisions/2026-07-27-owner-0.2.0-request-batch.md requirement ⑤ Why.5
//
// Local-only usage counters — the measuring half of requirement ⑤ "the whole
// UI needs to be reordered by usage frequency" (需求⑤「整个界面都要按使用频率
// 重排」).
//
// ── What this is NOT ────────────────────────────────────────────────────────
//
// It is not analytics and it never leaves the phone. No network surface, no
// upload path, no identifiers: SharedPreferences ints and nothing else. If a
// future change gives this file an outbound call, that change is wrong.
//
// ── Why it is not a gate on ⑤ ──────────────────────────────────────────────
//
// The card's original plan had ⑤ WAIT 1–2 weeks for real frequency data before
// touching the layout. That gate was struck: this product has exactly one user
// and he already stated the frequencies out loud ("⏎⌫↶✕ are high-frequency
// commonly-used keys" 「⏎⌫↶✕ 是高频常用键」, "the speak button being at the
// very bottom isn't actually easy to press" 「说话按钮在最下面其实不太好按」).
// Spending two weeks proving a known answer would push the release's headline
// work back for nothing.
//
// So the counters ship ALONGSIDE the rearrangement, and their job is the AFTER
// half: did the taps actually migrate toward the thumb arc, and how long are the
// PTT holds really? What they must NOT become is a retro-justification — the
// numbers are read whatever they say, including "the rearrangement changed
// nothing about the distribution" (重排没有改变分布).
//
// ── Why the keys are logical, not positional ───────────────────────────────
//
// A counter named after WHERE a button sits would reset its own meaning the
// moment the layout moves, making before/after incomparable — the one thing
// this data exists to do. Every key here names WHAT was pressed.

import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

/// One counted action. The name is the wire format of the stored key, so
/// **renaming an entry orphans its history** — add, never rename.
enum UsageEvent {
  /// PTT accepted and recording began (refused presses are not usage).
  pttHold,
  /// PTT released into a send.
  pttSend,
  /// Swipe-up cancel.
  pttCancel,
  /// A remote control key (⏎⌫↶✕) — owner's "high-frequency commonly-used
  /// key" (高频常用键) claim under test.
  ///
  /// ⚠️ T-1 (0.2.63) deleted its counterpart `punctuationKey`, and with it the
  /// comparison this pair existed to make ("remote keys high-frequency /
  /// punctuation mid-frequency" 「远程键高频 / 标点中频」). The owner
  /// answered that question by ruling instead — the punctuation group is gone —
  /// so the counter is dropped rather than left accumulating for a comparison
  /// that can never be run. What remains is a plain volume count.
  /// 🔴 The enum name IS the stored key, so this is a delete, never a rename:
  /// existing phones keep an orphaned `usage.punctuationKey` int that nothing
  /// reads. That is the cheap direction — reusing the name for another event is
  /// the one that would silently corrupt a history.
  remoteKey,
  /// Mode chip cycled.
  modeSwitch,
  /// Destination toggled (→ window / record-only).
  destinationToggle,
  /// Send-policy toggled by long-press (➤/⚡).
  sendPolicyToggle,
  /// A timeline row's long-press menu was opened.
  entryMenu,
}

/// Accumulated hold time, kept apart from the tap counts because "the speak
/// button isn't easy to press" (说话按钮不好按) is a claim about LONG holds —
/// a mean over 30 s dictations and 1 s ones says
/// nothing. Stored as a total plus its sample count so a mean is derivable and
/// the raw pair stays inspectable.
const String _kHoldTotalMs = 'usage.ptt_hold_total_ms';
const String _kHoldSamples = 'usage.ptt_hold_samples';

String _keyOf(UsageEvent e) => 'usage.${e.name}';

/// The one instance, installed by `main()` right after SharedPreferences is
/// ready. Widgets deep in the tree count through [countUsage] rather than
/// having a counter threaded through every constructor.
UsageCounters? _installed;

/// Wire the real thing. Called from main(); tests call it with a fake prefs.
void installUsageCounters(UsageCounters counters) {
  _installed = counters;
}

/// Count an event from anywhere in the UI.
///
/// The uninstalled case is an `assert`, not a friendly no-op. Doc 13 §7 F1 bans
/// silent empty defaults for exactly this shape of seam — the microphone in this
/// app went unopened for an entire rewrite because a missing dependency fell
/// back to a polite stub instead of complaining. An assert fires in debug and in
/// every widget test, so a missing `installUsageCounters` is caught by the suite;
/// release degrades to counting nothing rather than crashing a live dictation,
/// because a telemetry gap must never cost the user an utterance.
void countUsage(UsageEvent e) {
  assert(_installed != null, 'installUsageCounters() was never called — usage counting is dead');
  unawaited(_installed?.bump(e));
}

/// As [countUsage], for a completed PTT hold.
void countHold(Duration held) {
  assert(_installed != null, 'installUsageCounters() was never called — usage counting is dead');
  unawaited(_installed?.recordHold(held));
}

/// Test seam: drop the installed instance so an uninstalled case is testable.
void resetUsageCountersForTest() {
  _installed = null;
}

/// Fire-and-forget counters. Every method is non-throwing and non-blocking on
/// the UI: an observation layer must never be able to break the thing it
/// observes (doc 13 §7 — the logger that killed the server).
class UsageCounters {
  UsageCounters(this._prefs);

  final SharedPreferences _prefs;

  /// Count one occurrence. Errors are swallowed **here and only here** — this is
  /// the one place in this codebase where swallowing is correct, because the
  /// alternative is a dropped counter taking down a live dictation.
  Future<void> bump(UsageEvent e) async {
    try {
      final String k = _keyOf(e);
      await _prefs.setInt(k, (_prefs.getInt(k) ?? 0) + 1);
    } catch (_) {
      // See above. Deliberately silent; the data is best-effort by design.
    }
  }

  /// Record one completed PTT hold.
  Future<void> recordHold(Duration held) async {
    if (held.isNegative) return; // a clock that ran backwards is not a hold
    try {
      await _prefs.setInt(_kHoldTotalMs, (_prefs.getInt(_kHoldTotalMs) ?? 0) + held.inMilliseconds);
      await _prefs.setInt(_kHoldSamples, (_prefs.getInt(_kHoldSamples) ?? 0) + 1);
    } catch (_) {
      // ditto
    }
  }

  /// Everything counted so far, for the diagnostics dump. Absent keys read as 0
  /// **because a never-pressed button genuinely was pressed zero times** — this
  /// is the one place a missing value legitimately means zero rather than
  /// "unknown" (不知道), and it is worth saying so out loud given how often
  /// the opposite holds in this repo.
  Map<String, int> snapshot() {
    final Map<String, int> out = <String, int>{};
    for (final UsageEvent e in UsageEvent.values) {
      out[e.name] = _prefs.getInt(_keyOf(e)) ?? 0;
    }
    out['ptt_hold_total_ms'] = _prefs.getInt(_kHoldTotalMs) ?? 0;
    out['ptt_hold_samples'] = _prefs.getInt(_kHoldSamples) ?? 0;
    return out;
  }

  /// One line, sorted, for pasting into a card's before/after table.
  String dump() {
    final Map<String, int> s = snapshot();
    final List<String> keys = s.keys.toList()..sort();
    return keys.map((String k) => '$k=${s[k]}').join(' ');
  }

  /// Start a fresh measurement window (e.g. right before a layout change ships).
  Future<void> reset() async {
    try {
      for (final UsageEvent e in UsageEvent.values) {
        await _prefs.remove(_keyOf(e));
      }
      await _prefs.remove(_kHoldTotalMs);
      await _prefs.remove(_kHoldSamples);
    } catch (_) {
      // ditto
    }
  }
}
