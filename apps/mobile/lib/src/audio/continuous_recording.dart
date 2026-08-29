// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §8-bis card CR-3 (掉线不停麦，仅常录会话)
//   docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md (RECORDING's second
//     non-hold entry, and the exits table)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b (the three
//     release conditions for the banned word 「待转录」)
//   apps/mobile/lib/src/ptt/ptt_link_loss.dart (the one reader that changes
//     behaviour on this flag)
//
// ── WHAT THIS ANSWERS, AND THE ONE QUESTION IT MUST NOT BE ASKED ────────────
//
// 「Is the capture that is running right now a CONTINUOUS one?」 — nothing else.
//
// It deliberately does NOT answer 「is the screen being held awake?」, even
// though `ScreenWakeHold` has the identical lifetime and the two are created
// and released together. Merging them is the tempting simplification and it is
// wrong in a way that would be very hard to see: the wake hold reports what the
// PLATFORM agreed to, so on a host that refuses the hold the merged flag would
// read false — and the link-loss edge would then quietly stop the microphone
// mid-meeting because a display flag did not take. Two facts, two holders.
//
// ── 🔴 WHY THE FLAG CANNOT BE A PLAIN `bool` ON THE SESSION ─────────────────
//
// The failure directions are not symmetric:
//
//   · stuck FALSE  ⇒ a continuous recording stops on link loss. That is the
//     product we shipped before this card. Degraded, honest, safe.
//   · stuck TRUE   ⇒ the NEXT ordinary push-to-talk press keeps its microphone
//     open after the link dies. Nobody is watching that recorder, nothing will
//     stop it, and the user pressed a button that has always meant 「record
//     while I hold this」. That is a zombie microphone, and it is the exact
//     hole `ptt_link_loss.dart` was written to close.
//
// A flag that has to be REMEMBERED to be cleared fails in the second direction
// — the same shape as a wake lock nobody releases. So it is not remembered: it
// is bound to the recorder's own state stream and clears itself the moment the
// recorder reaches `stopped`, which every ending path already goes through
// (release, cancel, tier cap, quota, server auto-stop, link death, dispose).
// [end] stays available for the caller that ends a session without the recorder
// having started at all.

import 'dart:async';

import 'audio_capture.dart' show RecorderState;

/// The 「this capture is continuous」 fact, for exactly one capture.
///
/// Construct it once per session layer and keep it: [begin] marks the capture
/// that is starting, and the flag clears itself when that capture stops.
///
/// ── ✅ CORRECTION (2026-08-29, card CR-9 landed) ────────────────────────────
///
/// What stood here read: 「⚠️ NOTHING CALLS [begin] IN PRODUCTION YET, AND THAT
/// IS THE STATE OF THE WHOLE FEATURE … until CR-9 lands, this flag is false for
/// every capture, so card CR-3's keep-the-microphone-open branch never runs」.
/// Every clause of that was true when written and is false today.
///
/// Today: [begin] is called by `PttSession.beginContinuous`
/// (ptt_continuous.dart), from the entry in the light-record dock; [end] runs
/// on all five exits through `endContinuous`. CR-3's branch is live.
///
/// 🔴 THE PARAGRAPH IS CORRECTED RATHER THAN DELETED BECAUSE OF WHAT IT SAID
/// NEXT, WHICH STILL STANDS. CR-3's commit message read 「a continuous recording
/// no longer stops when the link dies」, present tense, as though it were live —
/// and it was not. A capability with no producer looks exactly like a shipped
/// feature from the inside, and the commit log is where somebody looks to find
/// out which it was. The mirror of that rule is why this block exists at all: a
/// stale 「not wired yet」 is authoritative and wrong, and it stops the question
/// being asked.
///
/// ⚠️ `RetainedAudioSpill.settleSegment` is still a WAITING mechanism (CR-5).
/// That one has not changed.
class ContinuousRecording {
  /// [recorderState] is `AudioCapture.state` in production — a broadcast stream
  /// of TRANSITIONS, which is what makes the auto-clear safe to arm before the
  /// recorder has started. Subscribing to a stream of transitions cannot
  /// observe the `stopped` the recorder is already sitting in, so a [begin]
  /// that precedes `start()` is not cancelled by its own starting position.
  ContinuousRecording({required Stream<RecorderState> recorderState}) {
    _sub = recorderState.listen((RecorderState s) {
      if (s == RecorderState.stopped) _active = false;
    });
  }

  StreamSubscription<RecorderState>? _sub;
  bool _active = false;

  /// Whether the capture running right now was started as a continuous one.
  ///
  /// 🔴 Read this ONLY to decide behaviour that a continuous session changes.
  /// It is not a 「the user is on the continuous screen」 flag and must not be
  /// used to draw one: it goes false when the recorder stops, while the screen
  /// is still very much on display.
  ///
  /// ⚠️ THE CLEAR LANDS ONE MICROTASK AFTER THE RECORDER STOPS, because it
  /// rides a broadcast stream. Stated rather than hidden, because a reader who
  /// assumes it is synchronous would be wrong — and because the reason that lag
  /// is harmless is a real argument and not a shrug:
  ///
  ///   both readers require a LIVE recorder before this flag can change
  ///   anything (`_keepOpenForContinuous` gates on recording/paused,
  ///   `continuousCapturingOffline` on recording), and no recorder goes from
  ///   `stopped` back to `recording` without an `await`ed `start()` driven by a
  ///   user gesture. So the window in which the flag is stale is a window in
  ///   which nothing can read it and get a different answer.
  ///
  /// If a future caller ever needs the flag DURING that window, the fix is to
  /// derive it from the recorder rather than to add a second clearing site: two
  /// mechanisms clearing one flag is how it ends up cleared in neither.
  bool get isActive => _active;

  /// Mark the capture that is starting (or already running) as continuous.
  ///
  /// Idempotent. The single writer is the continuous-recording entry; ordinary
  /// push-to-talk never calls this, which is what keeps its behaviour byte-for
  /// -byte what it was.
  void begin() {
    _active = true;
  }

  /// Clear the flag by hand.
  ///
  /// The auto-clear covers every path where a recorder actually ran. This
  /// covers the one where it did not: `start()` threw (permission refused, the
  /// platform recorder failed to attach), so no `stopped` transition is ever
  /// emitted and the flag would otherwise sit true waiting for an ordinary
  /// press to inherit it.
  void end() {
    _active = false;
  }

  /// Releases the subscription. After this the auto-clear is gone, so the flag
  /// is also forced false rather than frozen at whatever it last was.
  Future<void> dispose() async {
    await _sub?.cancel();
    _sub = null;
    _active = false;
  }
}
