// Part of ptt_session.dart — THE THREE PTT EDGES.
//
// 800-line cap, the tenth split on this file, and the same discipline as the
// nine before it: what moved is a self-contained SECTION, and NOT ONE
// CHARACTER of it changed in the move. This is a `part` file in the same
// library, so every private member (`fsm` / `segments` / `audio` /
// `_safeEmit` / `_startHeartbeat` …) resolves exactly as it did before, and
// any diff here beyond the extraction itself is a bug.
//
// WHY THESE THREE. They are one story: down opens the server-side utterance,
// up closes it, cancel abandons it. Reading any one of them means asking what
// the other two do with the same session.
//
// AND WHY NOW. `pttCancel` is what pushed the file over, on owner report
// 2026-08-28 (swipe up to cancel, and the words still reached the PC). The fix
// turns on an ORDER — latch before the emit — and an order that is not written
// down is an order the next reader tidies away. There was no room left in
// ptt_session.dart to write it; there is room here.

part of 'ptt_session.dart';

extension PttSessionEdges on PttSession {
  Future<bool> pttDown({
    FlowMode mode = FlowMode.realtime,
    String sourceLang = 'zh',
    String? targetLang,
    Delivery delivery = Delivery.inject,
    SendPolicy sendPolicy = SendPolicy.direct,
    // The phone-owned preference bundle for THIS cycle
    // (settings/phone_prefs_payload.dart). Read at the caller's emit moment —
    // chat_ptt_lifecycle.dart, the same line that snapshots `source_lang` — so
    // a switch flipped between two utterances is already true for the second
    // one with no reconnect. Null ⇒ the frame omits `prefs`, which is what a
    // caller with nothing to say sends.
    Map<String, Object?>? prefs,
  }) async {
    if (fsm.connection != ConnectionState.connected) return false;
    if (!sessionAcceptsPttDown(fsm.session)) return false;
    // card U2 ① — the permission gate runs BEFORE capture, so the FIRST OS dialog
    // is never cold-fired in mid-gesture (the audit's finding): the request is
    // born on the rendered rationale surface, not under the user's thumb. A
    // false return has already written the face the banner renders, so the
    // refusal is on screen — the FSM never left its resting state, so the next hold
    // starts clean (no stuck RECORDING, nothing to unwind).
    if (!await micPermission.gateForPtt()) return false;
    // 🔴 CR-7 — THE PREVIOUS RECORDING'S SCRIBE CLOSES HERE.
    //
    // Not in `endContinuous`: that runs on release, and a recording's last
    // segment settles after release (see that method for the measurement). So
    // it closes at the one edge where leaving it open would actually cost
    // something — a NEW utterance that is not part of any recording is about
    // to mint rows, and a stale scribe would file them inside somebody's
    // finished meeting at an offset from a clock that stopped hours ago.
    // That is the ID-cross-wiring red line in the audio-ownership direction.
    //
    // ⚠️ `continuous.isActive` is already true for a continuous press, because
    // `beginContinuous` runs BEFORE this — so this closes an OLD recording and
    // never the one that is starting.
    //
    // 🔴 THE RETAINED AUDIO ROLLS WITH IT, and for the same reason one level
    // down: two ordinary presses in ONE run shared a session key, so their
    // offline tails appended into one file — measured, 300 + 120 = 420 bytes
    // that nothing downstream could tell apart. A continuous press does NOT
    // roll here, because `beginContinuous` has already filed it under the
    // article id and rolling would throw that away.
    if (!continuous.isActive) {
      articles.end();
      audio.retainedAudio?.endSession();
    }
    segments.clear();
    try {
      await audio.start(permissionPreflighted: micPermission.lastGateSawGranted);
    } on Object {
      // U2 ④ — this branch used to `return false` behind a comment claiming
      // 「fail-loud」 while surfacing nothing (anti-façade ④: the comment was an
      // expired truth). Now it IS loud: the flow re-probes the OS and renders
      // the honest face — denied / permanently-denied / 「recording could not
      // start」 when the permission is actually green. PTT still never entered
      // RECORDING.
      await micPermission.noteCaptureStartRefused();
      return false;
    }
    // 🔴 F1 (2026-09-02 audit) — RE-CHECK THE GATE THIS FUNCTION OPENED WITH.
    // Two `await`s sit between that check and here (the permission dialog,
    // and opening the platform recorder above) — either can outlast the
    // link. Without this, a connection that died mid-gesture still reached
    // `fsm.onPttDown()`, which the FSM correctly REFUSES
    // (`fsm.connection != connected`) — but that refusal only reaches
    // `illegalTransitions`, which has ZERO consumers in production, and this
    // function never read it either: it kept going, emitted `audio:start` on
    // a dead link, started the heartbeat, and returned `true` — claiming a
    // press that the FSM never actually entered.
    //
    // ⚠️ WORSE THAN A WRONG RETURN VALUE: `audio.start()` just above has
    // ALREADY opened the microphone. `pttUp()` refuses to close it
    // (`if (fsm.session != SessionState.recording) return;`) because the FSM
    // never left IDLE — so without stopping it here, the microphone stays
    // open with no user-reachable way to close it short of restarting the
    // app. Stopping it is therefore not optional cleanup, it is the whole
    // point of this check.
    if (fsm.connection != ConnectionState.connected) {
      await audio.stop();
      return false;
    }
    fsm.onPttDown();
    transport.emit(
      FlowMicEvents.audioStart,
      AudioStartPayload(
        mode: mode,
        sourceLang: sourceLang,
        targetLang: targetLang,
        sendPolicy: sendPolicy,
        delivery: delivery,
        prefs: prefs,
      ).toJson(),
    );
    _startHeartbeat();
    return true;
  }

  /// PTT up: flush the < 200 ms residual tail AHEAD of audio:stop (F-2223), then
  /// PROCESSING **before** `audio.stop()` — 0.3.43 Q5-②: that await is where a
  /// fast terminal stt:final lands, and `onSttFinal` refuses anything that is
  /// not PROCESSING. Whole argument: test/ptt_up_final_race_test.dart.
  Future<void> pttUp() async {
    // 🔴 CR-9 — ORDER, AND IT IS NOT A STYLE CHOICE. The offline branch below
    // reads `continuous.isActive` to decide whether this is a continuous
    // recording at all, and `endContinuous()` clears exactly that flag. The
    // first cut put the teardown here, ABOVE this line: `stopContinuousOffline`
    // then answered false, the guard on the next line returned on a
    // `disconnected` session, and the recorder was never stopped — the ZOMBIE
    // MICROPHONE §11-c already paid for once, rebuilt in the act of tidying the
    // teardown into one place.
    //
    // ⚠️ Caught by `ptt_continuous_link_loss_test.dart` ②b, the same assertion
    // that found the original. ⇒ A TEARDOWN MUST NEVER RUN BEFORE A PREDICATE
    // THAT READS WHAT IT TEARS DOWN.
    //
    // `stopContinuousOffline()` runs `endContinuous()` on its own way out, so
    // every path still lets go exactly once (C8).
    if (stopContinuousOffline()) return;
    // Every ordinary release, and every continuous one that still had a link.
    // All three verbs are no-ops on a plain push-to-talk press, so this needs no
    // 「was it continuous」 test — one would be a second author for a fact the
    // session already holds.
    endContinuous();
    if (fsm.session != SessionState.recording) return;
    final CapturedChunk? residual = audio.takeResidualChunk();
    if (residual != null) _emitChunk(residual); // braces collapsed: line budget
    _stopHeartbeat();
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    fsm.onPttUp();
    await audio.stop();
  }

  /// PTT swipe-up cancel: abort mid-utterance. The utterance never completed, so
  /// NO timeline entry is built (§4.0 A). Fences audio immediately, tells the
  /// server to discard (audio:stop), and returns the FSM to IDLE.
  Future<void> pttCancel() async {
    if (fsm.session != SessionState.recording) return;
    // CR-9 (C8, exit 4 of 5). Continuous recording ships WITHOUT a cancel
    // gesture (CR-D ③), so this should be unreachable for one — belt and
    // braces, because 「unreachable」 is a claim about call sites and those move.
    endContinuous();
    // FIRST, before anything can come back: this latches
    // `fsm.utteranceCancelled`, and ptt_inbound.dart drops every transcript
    // frame this utterance still owes (whole argument there).
    fsm.onPttCancel();
    audio.fenceAndStop();
    _stopHeartbeat();
    segments.clear();
    // `discard` tells the server to bin these seconds instead of finalising and
    // billing them. NOT relied on — an older relay strips it, see the guard.
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{'discard': true});
  }
}
