// Part of ptt_session.dart — the local dead-recording edge (SEG-2, design
// 2026-08-11 §2-R3/§2-R4).
//
// ── THE HOLE THIS CLOSES (measured, design §1-3) ─────────────────────────────
// FSM 3 s drop grace expires → `_resetSession()` → a later `pttUp()` returns on
// `fsm.session != recording` — so before this file NOTHING stopped the
// microphone: no `audio.stop()`, no retention, no notice. The mic ran on, the
// 30 s ring kept evicting, and the user's words quietly ceased to exist.
//
// ── WHY THE SESSION LAYER, NOT THE FSM ───────────────────────────────────────
// The FSM must not know microphones exist (design §2-R3: 「不是塞进 FSM」
// ("not stuffed into the FSM")).
// `fsm.changes` is already a sync broadcast every layer may subscribe to;
// this file subscribes and judges the edge from two facts the session layer
// owns: the snapshot says the SESSION died, and the capture says a recorder
// was still live. No FSM edit, no new state.
//
// ── WHY NOT WAIT FOR THE SERVER ──────────────────────────────────────────────
// `audio:auto-stopped` is the server's mouth, and the one scenario this file
// exists for is the one in which no frame can arrive (design §2-R4: 「连接死了，
// 唯一能开口的是手机自己」("the connection is dead — the only one who can still
// speak is the phone itself")). The reason value is LOCAL (local_stop_reasons.dart)
// and never rides the wire.
//
// It is a `part`, not a helper class, so `_autoStoppedCtl` / `_stopHeartbeat`
// stay this class's own state — not a callback bundle that could drift.

part of 'ptt_session.dart';

extension PttSessionLinkLoss on PttSession {
  /// Judged on every FSM snapshot; acts exactly once per dead recording.
  ///
  /// THE EDGE: `session == disconnected` while the capture is still live
  /// (`recording`, or `paused` — an app backgrounded mid-utterance reaches the
  /// same grace expiry with the recorder parked, and a terminally-stopped
  /// capture is what makes the later `resumeCapture()` a safe no-op instead of
  /// a zombie microphone). Every other route into `session == disconnected`
  /// has already stopped the capture before the FSM emits, which is what makes
  /// the recorder-state gate sufficient:
  ///   · `AuthExpiredHandler.drain` calls `audio.fenceAndStop()` BEFORE
  ///     `stateMachine.onAuthExpired()` (auth_expired_handler.dart, step 1);
  ///   · a socket drop while IDLE resets the session with no capture running;
  ///   · release/cancel during the grace window leaves RECORDING via
  ///     `pttUp`/`pttCancel`, both of which stop the capture themselves.
  ///
  /// WHAT IT DOES — and, deliberately, does NOT put on the wire: the link is
  /// dead, so no `audio:stop`, no residual chunk, nothing (the verb's own
  /// contract; `stopForLinkLoss` doc). The heartbeat timer is stopped here
  /// because `pttUp` — its normal stopper — will never run for this utterance,
  /// and a surviving timer would resume emitting `heartbeat` frames the moment
  /// the socket reconnects, for a session that no longer exists.
  ///
  /// ⚠️ Everything in the paragraph above describes the ORDINARY path, which is
  /// now one of two: a continuous session takes [_keepOpenForContinuous] and
  /// leaves before any of it runs — no stop, no heartbeat change, no notice.
  /// See that method for why, and for the one condition under which a
  /// continuous session still falls through to here.
  void _onLinkLossEdge(FlowmicStateSnapshot snap) {
    if (snap.session != SessionState.disconnected) return;
    final RecorderState rec = audio.currentState;
    if (rec != RecorderState.recording && rec != RecorderState.paused) return;
    if (_keepOpenForContinuous(rec)) return;
    final bool kept = audio.stopForLinkLoss();
    _stopHeartbeat();
    // The banner chain is the SAME one the wire `audio:auto-stopped` rides
    // (chat_controller → banner_queue); only the reason value is local. The
    // kept/plain split is the honesty bound: the retention sentence is only
    // shown when the tail really went to a live retention layer (see
    // `stopForLinkLoss`'s return-value doc).
    final String reason =
        kept ? kLocalStopReasonLinkLossKept : kLocalStopReasonLinkLoss;
    diag('audio.link_loss.stopped', <String, Object?>{
      'kept': kept,
      'recorder_was': rec.name,
      'has_listener': _autoStoppedCtl.hasListener,
    });
    if (!_autoStoppedCtl.isClosed) _autoStoppedCtl.add(reason);
  }

  /// Card CR-3 — a CONTINUOUS session keeps its microphone through a link
  /// death. Returns whether this edge was handled by keeping it open, i.e.
  /// whether the caller must not run the ordinary stop below.
  ///
  /// ── 🔴 THE SECOND CONDITION IS NOT DEFENSIVE, IT IS THE WHOLE RULE ────────
  ///
  /// Keeping the microphone open is only an improvement if something is
  /// catching what it produces. With no retention layer the ring buffer simply
  /// goes on evicting, and this file's own header describes what that looks
  /// like: 「the mic ran on, the 30 s ring kept evicting, and the user's words
  /// quietly ceased to exist」. That is the hole SEG-2 was written to close, so
  /// a continuous session on a build whose spill failed to open
  /// (`retained_audio_boot.dart` degrades to null, loudly) must fall through to
  /// the ordinary stop — which at least tells the user the recording ended.
  ///
  /// ⇒ the flag alone is never enough. Fail toward the old, honest product.
  ///
  /// ── WHY [AudioCapture.noteUplinkDown] IS CALLED HERE TOO ─────────────────
  ///
  /// It is NOT a second writer of the uplink fact — the transport-status edge
  /// in `ptt_capture_pump.dart` stays the live one. This restates a
  /// precondition this edge has already proven (the session is `disconnected`
  /// with a capture still live), for the same reason `stopForLinkLoss` restates
  /// it: retention that is armed twice costs disk, retention that is never
  /// armed costs the user's words. Fail toward duplication, never toward loss.
  ///
  /// ── WHAT IS DELIBERATELY NOT DONE HERE ──────────────────────────────────
  ///
  /// · The heartbeat is NOT stopped. The reason the ordinary path stops it is
  ///   that `pttUp` — its only other stopper — will never run for a recording
  ///   that just died. This recording did not die: it is still running and the
  ///   user will still end it, so `pttUp` still comes. Stopping the timer here
  ///   would leave a live recording with no keepalive.
  /// · Nothing is emitted. There is no link to emit onto, and this edge fires
  ///   precisely because there is not.
  /// · No user-visible sentence is produced here. The offline state is a STATE
  ///   -type fact ("what is true right now"), so it is rendered from live state
  ///   by `banner_queue.dart` and self-clears when the link returns — not
  ///   pushed as an event that would then need its own dismissal rules.
  ///
  /// ⚠️ OPEN, AND IT BELONGS TO CR-5, NOT HERE: what happens to this audio when
  /// the link comes back. The server's session survives a 30 s drop grace and
  /// is adopted by `(roomUuid, pairingId)`; past that it is gone, and the
  /// retained segments need the re-transcription channel that does not exist
  /// yet. Until it does, 15 册 §2.0-b keeps 「待转录」 and every synonym banned
  /// from the copy — this card makes the audio survive, not the transcript.
  /// Card CR-3 — is a continuous recording running right now with its audio
  /// actually being kept on this phone?
  ///
  /// 🔴 THIS GETTER IS A LICENCE TO SAY A SENTENCE, and every conjunct pays for
  /// one clause of it. The banner it feeds tells the user 「录音仍在继续，音频
  /// 保留在这台手机上」 ("the recording is still going, the audio is kept on
  /// this phone"), which is two claims about their device:
  ///
  ///   · [ContinuousRecording.isActive] — an ordinary press would have STOPPED
  ///     here, so without this the first clause is false;
  ///   · the recorder is live — 「still going」 in the most literal sense;
  ///   · a spill exists AND `uplinkUp` is false — this is the one that is easy
  ///     to get wrong. The honest fact is not 「the connection is down」 but
  ///     「ring evictions are being written to disk right now」, and that is a
  ///     property of the retention layer, not of the socket. Reading the socket
  ///     instead would let the sentence appear on a build whose spill never
  ///     opened — an unbacked promise about the user's own recording, which is
  ///     exactly what 15 册 §2.0-b bans.
  ///
  /// ⇒ when this is false the ordinary link banner is shown instead. That one
  /// says only 「link down · content buffered」, which stays true either way.
  /// ⚠️ 🔴 `paused` IS ACCEPTED BY [_keepOpenForContinuous] AND REFUSED HERE,
  /// and that is not an inconsistency — the two predicates answer different
  /// questions, which is this repo's oldest rule applied to a recorder state.
  ///   · 「should the microphone be torn down?」 — no, a parked recorder resumes
  ///     when the app comes back, so `paused` keeps it open;
  ///   · 「may we tell the user the recording is still going?」 — a parked
  ///     recorder is producing no audio, so `paused` may NOT say that. The app
  ///     is backgrounded or the picker is up; when the user can next read this
  ///     banner the recorder has already resumed.
  /// Accepting `paused` in both would put a true-looking sentence on screen
  /// during the one window in which it is false.
  bool get continuousCapturingOffline {
    if (!continuous.isActive) return false;
    if (audio.currentState != RecorderState.recording) return false;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    return spill != null && !spill.uplinkUp;
  }

  /// Card CR-3 — end a continuous recording that has outlived its link.
  /// Returns whether it did anything, so [pttUp] can fall through to its
  /// ordinary path when it did not.
  ///
  /// ── 🔴 WHY THIS EXISTS: KEEPING THE MICROPHONE KILLED THE STOP BUTTON ─────
  ///
  /// [pttUp] and [pttCancel] both open with
  /// `if (fsm.session != SessionState.recording) return;`, and once the drop
  /// grace expires the session is `disconnected`. Before this method, a
  /// continuous recording that survived a link death could not be stopped by
  /// the user AT ALL — the recorder would run until the app was killed.
  ///
  /// That is the same zombie microphone [_keepOpenForContinuous] is written to
  /// avoid, arriving through a different door: not a stale flag, but the stop
  /// path quietly becoming unreachable. It was found by a test asserting that
  /// the FACE went away after a stop, which it did not.
  /// ⇒ 「what else stops the recorder?」 and 「what is SUPPOSED to stop it, and
  /// can it still?」 are two questions, and only the first one had been asked.
  ///
  /// ── WHAT IT DOES, AND WHY IT IS THE LINK-LOSS STOP AND NOT [pttUp]'S ──────
  ///
  /// At this point there is no server session to finalise (the grace has
  /// expired) and no link to say anything on, so every step of the ordinary
  /// release would be a lie: the `audio:stop` frame goes nowhere, and
  /// `fsm.onPttUp()` is a RECORDING→PROCESSING transition out of a state that
  /// is not RECORDING, waiting for a transcript that is not coming. The honest
  /// ending is the one the edge itself uses — retain the tail, tell the user
  /// locally — which is exactly [AudioCapture.stopForLinkLoss].
  ///
  /// ⚠️ NO CANCEL COUNTERPART, ON PURPOSE. Continuous recording ships without
  /// a cancel gesture (CR-D decision ③, owner-approved 2026-08-29; written into
  /// 17 册), so [pttCancel] staying inert in this state is the contract rather
  /// than a gap. If cancel is ever added it needs its own answer for the audio
  /// already on disk, which is card CR-4's subject, not this one's.
  bool stopContinuousOffline() {
    if (!continuousCapturingOffline) return false;
    final bool kept = audio.stopForLinkLoss();
    _stopHeartbeat();
    // CR-9 (C8, exit 1 of 5 — this is the offline half of the user's stop).
    // Widened from `continuous.end()`: the flag was never the only thing this
    // recording turned on. The screen hold and the ceiling's clock came with
    // it, and a recording that ends here used to leave both running.
    endContinuous();
    diag('audio.continuous.stopped_offline', <String, Object?>{'kept': kept});
    final String reason =
        kept ? kLocalStopReasonLinkLossKept : kLocalStopReasonLinkLoss;
    if (!_autoStoppedCtl.isClosed) _autoStoppedCtl.add(reason);
    return true;
  }

  bool _keepOpenForContinuous(RecorderState rec) {
    if (!continuous.isActive) return false;
    if (audio.retainedAudio == null) {
      diag('audio.link_loss.continuous_no_retention', <String, Object?>{
        'recorder_was': rec.name,
      });
      return false;
    }
    audio.noteUplinkDown();
    diag('audio.link_loss.continuous_kept_open', <String, Object?>{
      'recorder_was': rec.name,
    });
    return true;
  }
}
