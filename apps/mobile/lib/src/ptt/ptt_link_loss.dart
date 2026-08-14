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
  void _onLinkLossEdge(FlowmicStateSnapshot snap) {
    if (snap.session != SessionState.disconnected) return;
    final RecorderState rec = audio.currentState;
    if (rec != RecorderState.recording && rec != RecorderState.paused) return;
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
}
