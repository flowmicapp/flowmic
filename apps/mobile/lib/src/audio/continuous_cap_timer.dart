// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.B② (the phone enforces, the server supplies the number, and the threat
//     model that makes that an acceptable trade), §5-4 (the warning is
//     EVENT-type, once, never a permanent bar)
//   apps/server-core/src/billing/plans.ts (`continuous_minutes`)
//   apps/mobile/lib/src/audio/local_stop_reasons.dart
//     (kLocalStopReasonContinuousCap — the sentence this ending produces)
//
// ── THE PER-SESSION CEILING, AS A CLOCK ─────────────────────────────────────
//
// owner 2026-08-29 made continuous recording a subscription item: free 10
// minutes per sitting, pro and max 30. This is the object that ends one.
//
// ── 🔴 WHY THE WARNING IS ONE EVENT AND NOT A COUNTDOWN ─────────────────────
//
// owner ruled a single reminder at one minute remaining, EVENT-type — a few
// seconds and gone. The reason is written into §5-4 and it is a product
// judgement worth keeping next to the code: a permanent 「1:00 left」 bar turns
// the last minute of somebody's meeting into an anxiety meter, and the person
// it interrupts is mid-sentence. The running countdown belongs on the
// recording screen where the user chose to look at it (card CR-9), not in a
// notice that arrives at them.
//
// ── ⚠️ WHAT THIS CLASS DELIBERATELY DOES NOT DO ─────────────────────────────
//
// It does not stop anything. It fires two callbacks and the caller decides what
// they mean, because the correct stop is `PttSession.pttUp()` — the ORDINARY
// release, which emits `audio:stop` and collects the terminal final — and NOT
// `fenceAndStop()`, whose meaning is 「this utterance never happened」 and which
// would silently discard the last segment of a thirty-minute recording. Putting
// the stop in here would make that choice invisible to the caller; leaving it
// out makes it a line somebody has to write on purpose.
//
// ── ✅ CORRECTION (2026-08-29, card CR-9 landed) ────────────────────────────
// What stood here read: 「⚠️ NOTHING ARMS THIS IN PRODUCTION YET. The
// continuous-recording entry is card CR-9.」 It was true when written and is
// now false. Its own next sentence is the reason it is corrected rather than
// deleted: a mechanism waiting for its producer is indistinguishable from a
// shipped feature unless somebody says which it is — and that cuts both ways,
// because a stale 「not wired yet」 is authoritative and wrong, which stops the
// question being asked at all.
//
// Today: armed by `PttSession.beginContinuous` (ptt_continuous.dart) from the
// entry's start path, with the ceiling the SERVER issued; disarmed on all five
// exits through `endContinuous`.

import 'dart:async';

/// How long before the ceiling the single reminder fires.
///
/// owner 2026-08-29, §9 item ④: 「剩 1 分钟一次，事件型」.
const Duration kContinuousCapWarningLead = Duration(minutes: 1);

/// Creates a one-shot timer. The seam tests replace; production is [Timer].
typedef CapTimerFactory = Timer Function(Duration d, void Function() fire);

Timer _realTimer(Duration d, void Function() fire) => Timer(d, fire);

/// One continuous recording's clock against its per-session ceiling.
///
/// [arm] at the start of a continuous recording, [disarm] on every path that
/// ends one. Both are idempotent, so a caller that disarms twice — or disarms
/// after the ceiling already fired — costs nothing.
class ContinuousCapTimer {
  ContinuousCapTimer({CapTimerFactory? timerFactory})
      : _newTimer = timerFactory ?? _realTimer;

  final CapTimerFactory _newTimer;
  Timer? _warn;
  Timer? _cap;

  /// Whether a ceiling is currently being counted down.
  bool get isArmed => _cap != null;

  Duration? _armedCap;
  int _warningTicket = 0;

  /// Non-zero while the one reminder is standing. A TICKET rather than a bool
  /// so the banner reconciler can tell a NEW raise from a still-standing one:
  /// its whole contract is 「the value changed ⇒ this is a fresh occurrence ⇒
  /// restart the window」, and a bool that is already true cannot say that.
  ///
  /// ⚠️ Owned here rather than on ChatController for a reason that is half
  /// structural and half accidental: the reminder is a property of THIS clock
  /// and dies with it — and chat_controller.dart is at its 800-line cap, so a
  /// field there would have forced an unrelated refactor into card CR-9.
  int get warningTicket => _warningTicket;

  /// The reminder has been seen (auto-hide window elapsed, or the user tapped
  /// the banner away). Idempotent.
  void dismissWarning() {
    _warningTicket = 0;
  }

  /// The ceiling this sitting is counting down, or null when nothing is armed.
  ///
  /// 🔴 CARD CR-9 READS IT FOR THE COUNTDOWN, AND IT IS PINNED HERE RATHER THAN
  /// RE-READ FROM THE ACCOUNT EACH FRAME. `/api/cloud/summary` refreshes on its
  /// own schedule, so a face that recomputed 「remaining」 from the live account
  /// value would jump the moment a plan change landed — mid-recording, with no
  /// explanation, and disagreeing with the timer that is actually going to stop
  /// it. The number that armed the clock is the number the user was shown and
  /// the number that will end the sitting: one value, one question.
  Duration? get armedCap => _cap == null ? null : _armedCap;

  /// Start counting down [cap].
  ///
  /// [onWarning] fires [kContinuousCapWarningLead] before the ceiling;
  /// [onCap] fires at it. Re-arming replaces any previous countdown rather than
  /// stacking a second one — two live ceilings would be two answers to 「when
  /// does this end」.
  ///
  /// 🔴 A [cap] that is not a positive duration ARMS NOTHING and is not an
  /// error either. The number comes off the wire
  /// (`CloudSummary.continuousMinutes`), and the honest response to a ceiling we
  /// could not believe is to refuse to start the recording — a decision that
  /// belongs to the caller, at the entry, where there is a user to tell. What
  /// this class must not do is invent a default: a fallback ceiling here would
  /// be a number nobody chose, enforced silently, on somebody's meeting.
  void arm({
    required Duration cap,
    required void Function() onWarning,
    required void Function() onCap,
  }) {
    disarm();
    if (cap <= Duration.zero) return;
    _armedCap = cap;
    // A sitting shorter than the lead gets NO reminder rather than one at t=0.
    // 「one minute left」 delivered the instant recording starts is technically
    // true and useless — it tells the user something they just chose, and it
    // spends the one interruption this feature is allowed.
    if (cap > kContinuousCapWarningLead) {
      _warn = _newTimer(cap - kContinuousCapWarningLead, () {
        _warn = null;
        // Raised BEFORE the callback: the callback is what repaints, so a
        // ticket written after it would be a frame late — the repaint would
        // read a zero and draw nothing.
        _warningTicket++;
        onWarning();
      });
    }
    _cap = _newTimer(cap, () {
      // Cleared BEFORE the callback: the caller's handler ends the recording,
      // which calls back into [disarm], and a disarm that cancelled a timer
      // currently running its own callback would be relying on Timer's
      // re-entrancy rather than on this object's state being true.
      _cap = null;
      _warn?.cancel();
      _warn = null;
      onCap();
    });
  }

  /// Stop counting. Safe when not armed, and safe to call twice.
  ///
  /// 🔴 Every path that ends a continuous recording must reach this — the stop
  /// button, a link death that outlives the retention layer, quota exhaustion,
  /// the page being disposed. A surviving timer would end a LATER recording at
  /// the wrong moment, and the user would have no way to understand why.
  void disarm() {
    // The reminder says 「one minute left of a recording」. Once there is no
    // recording the sentence has nothing to be about, and a notice must not
    // outlive the fact it states.
    _warningTicket = 0;
    _warn?.cancel();
    _warn = null;
    _cap?.cancel();
    _cap = null;
  }
}
