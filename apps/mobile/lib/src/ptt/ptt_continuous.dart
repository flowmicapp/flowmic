// Part of ptt_session.dart — THE CONTINUOUS-RECORDING LIFECYCLE.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.B② (the phone enforces, the server issues the number), §4.G (screen),
//     §6 C1 / C1b / C8
//   apps/mobile/lib/src/audio/continuous_cap_timer.dart (the clock)
//   apps/mobile/lib/src/audio/screen_wake.dart (the hold)
//   apps/mobile/lib/src/audio/local_stop_reasons.dart
//     (`kLocalStopReasonContinuousCap`, and the W8-4 account for why it is
//      neither `hard_limit` nor `quota_exhausted`)
//
// ── 🔴 ONE BEGIN, ONE END, BECAUSE C8 IS A CLAIM ABOUT *EVERY* EXIT ─────────
//
// Three things turn on together when a continuous recording starts — the flag
// (CR-3's link-loss behaviour), the screen hold (CR-2) and the ceiling's clock
// (CR-6) — and criterion C8 asks that all three be off again on every path that
// ends one, INCLUDING the abnormal ones. Three separate call sites at each of
// five exits is fifteen chances to forget one, and the one that gets forgotten
// is the wake lock, whose symptom is a battery reading somebody notices a week
// later.
//
// ⇒ [beginContinuous] and [endContinuous]. `endContinuous` is idempotent and
// deliberately CHEAP, so the exits can call it without first asking whether
// this was a continuous recording at all: `pttUp` runs it on every ordinary
// release too, where all three verbs are no-ops.
//
// The five exits, each wired and each named in a test:
//   · the user's stop            → `pttUp` (ptt_edges.dart), first line
//   · the ceiling                → [stopForContinuousCap], below
//   · the recorder dying         → `_onCaptureFault` (ptt_capture_pump.dart)
//   · cancel                     → `pttCancel`, contractually inert for
//                                  continuous (CR-D ③), belt-and-braces anyway
//   · the session going away     → `_disposeRouted` (ptt_session_dispose.dart)
//
// ⚠️ THE LINK DYING IS NOT ON THAT LIST, AND THAT IS CR-3's WHOLE POINT: a
// continuous recording SURVIVES a link death (the microphone stays open and the
// retention layer catches the audio). It ends later, through the user's stop —
// which is what `stopContinuousOffline` exists to serve.
//
// ── 🔴 THE CEILING IS ENFORCED HERE AND ISSUED ELSEWHERE ────────────────────
//
// The number is `/api/cloud/summary`'s `continuous_minutes` —
// `PLAN_LIMITS.continuous_minutes` resolved through the SAME solver the server
// enforces quota with, never a tier name looked up on this phone. That is C1b:
// `permanent_free` (the owner's own account) reports its plan as 'free' and its
// NUMBERS as the max tier's, so a phone deciding 「free ⇒ 10」 would give the one
// person who has to record for thirty minutes exactly ten.
//
// ⚠️ IT IS A CLIENT-SIDE CEILING, WHICH IS A CALCULATED TRADE (§4.B②). A
// modified client can ignore it; what it then spends is its own monthly quota,
// which the server enforces. Hard server enforcement would cost a new
// `audio:start` field and a new closed-enum stop reason — a protocol gate, and
// a relay-before-APK deployment.

part of 'ptt_session.dart';

extension PttSessionContinuous on PttSession {
  /// Mark this capture continuous, hold the screen, and start the ceiling's
  /// clock for [cap].
  ///
  /// [onWarning] fires once, [kContinuousCapWarningLead] before the end. It is
  /// the CALLER's: this layer has no idea what a banner is, and a session
  /// reaching into the UI would be the wrong dependency in the direction that
  /// is hardest to undo.
  ///
  /// ⚠️ ORDER IS THE CALLER'S PROBLEM AND IT HAS TWO HALVES. The flag must be
  /// set BEFORE capture starts — a link that dies in between would otherwise
  /// tear the microphone down — and the clock must not outlive a capture that
  /// never began, so a refused `pttDown` has to call [endContinuous]. Both are
  /// pinned by the entry's own wiring test.
  void beginContinuous({
    required Duration cap,
    required void Function() onWarning,
  }) {
    diag('audio.continuous.begin', <String, Object?>{'cap_ms': cap.inMilliseconds});
    continuous.begin();
    unawaited(screenWake.hold());
    capTimer.arm(
      cap: cap,
      onWarning: onWarning,
      onCap: () => unawaited(stopForContinuousCap()),
    );
  }

  /// Turn all three back off. Idempotent, cheap, and safe on a capture that was
  /// never continuous — see the header for why that matters more than it looks.
  void endContinuous() {
    capTimer.disarm();
    continuous.end();
    unawaited(screenWake.release());
  }

  /// End a continuous recording because it reached this account's ceiling.
  ///
  /// 🔴 THE ORDINARY RELEASE, NOT A FENCE. `pttUp()` flushes the residual tail,
  /// sends `audio:stop`, and waits for the terminal final — so the last thing
  /// said lands as the last segment. `fenceAndStop()` means 「this utterance
  /// never happened」 and would throw that segment away, while the copy this
  /// edge raises says the recording was saved: a sentence like that sitting on
  /// top of a fence is precisely the unbacked promise 15 册 §2.0-b bans.
  ///
  /// 🔴 AND IT REPORTS ITS OWN REASON RATHER THAN BORROWING ONE. `hard_limit`
  /// and `quota_exhausted` are both already on this stream and both would read
  /// plausibly here — and both would be wrong in the way W8-4 records: after
  /// THIS stop, pressing again works; after `quota_exhausted` it does not. Two
  /// opposite next steps must never share a sentence.
  Future<void> stopForContinuousCap() async {
    // The FSM check first: by the time a timer fires the user may have stopped
    // the recording themselves. Announcing a ceiling nobody reached would be a
    // fabricated state, and this is the one place it could be invented.
    if (fsm.session != SessionState.recording) {
      diag('audio.continuous.cap_stale', <String, Object?>{'session': fsm.session.name});
      return;
    }
    diag('audio.continuous.cap_reached', const <String, Object?>{});
    // `pttUp` runs `endContinuous()` on its first line, so the flag, the hold
    // and this very timer are all released by the call below. Nothing to undo
    // here afterwards.
    await pttUp();
    if (!_autoStoppedCtl.isClosed) {
      _autoStoppedCtl.add(kLocalStopReasonContinuousCap);
    }
  }
}
