// Part of ptt_session.dart — the capture pause/resume + fault/chunk pump.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart / ptt_presence_poll.dart / ptt_reconnect_ack
// .dart / ptt_wire_keepalive.dart: ptt_session.dart sits at the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX=800), and a card pushed it to 834 lines.
//
// This family was chosen because it is coherent and fully self-contained: the
// lifecycle pause/resume pair (08 §3) plus the three callbacks the capture
// stream drives (fault abort, per-chunk dispatch, wire emit). Nothing outside
// this library calls any of the five members below.
//
// 🔴 DIFF DISCIPLINE: all five bodies are moved **character-for-character**,
// with the one mechanical edit this family always makes — they become
// extension members so every existing call site (`pauseCapture(...)`,
// `resumeCapture()`, `_onCaptureFault`, `_onCapturedChunk`, `_emitChunk(...)`)
// is untouched. **Any other difference in the diff is a bug.**

part of 'ptt_session.dart';

extension PttSessionCapturePump on PttSession {
  /// Background/lifecycle pause (08 §3, F-2356 seam): stop capturing and tell
  /// the server to pause the session so the PC capsule collapses, WITHOUT
  /// tearing the utterance down. The lifecycle observer (app_lifecycle_bridge
  /// .dart) calls this on app-background; here it is the data-layer entry point.
  ///
  /// 🔴 card F1 / owner ruling ①:「电脑应该认为手机是『暂停』（还在配对，只是胶囊
  /// 收起）」("the PC should regard the phone as 'paused' — still paired, the
  /// capsule has just collapsed"). The whole method used to sit behind
  /// `if (currentState != recording) return`, so backgrounding while IDLE —
  /// the common case, the user switched windows without saying anything — put
  /// NOTHING on the wire and the PC could not tell it from「手机还在说话」("the
  /// phone is still talking"). The RECORDER work is still guarded (there is no
  /// capture to pause); the WIRE frame no longer is. Idempotence moved to the
  /// caller, which is the only place that knows an edge from a state
  /// (AppLifecycleBridge pairs background/foreground 1:1).
  ///
  /// The claim「so the PC capsule collapses」above is an assertion about another
  /// end (anti-façade ④) — its anchors are `AUDIO_PAUSE` in
  /// apps/desktop/src-tauri/src/socket/fanout.rs (`on_capsule_audio_edges`) and
  /// `onAudioPause` in apps/desktop/src/capsule/controller.ts. Until card F1
  /// neither existed.
  Future<void> pauseCapture({String reason = 'background'}) async {
    if (audio.currentState == RecorderState.recording) {
      await audio.pause(reason: reason);
      _stopHeartbeat();
    }
    _safeEmit(FlowMicEvents.audioPause, AudioPausePayload(reason).toJson());
  }

  /// Resume after [pauseCapture]. seq continues monotonic (08 §3). Same card F1
  /// split as above: the recorder half stays guarded, the wire frame does not —
  /// a pause the PC acted on must always get its matching resume, including when
  /// there was never a capture to restore.
  Future<void> resumeCapture() async {
    final bool hadPausedCapture = audio.currentState == RecorderState.paused;
    if (hadPausedCapture) await audio.resume();
    _safeEmit(FlowMicEvents.audioResume, const <String, Object?>{});
    if (hadPausedCapture) _startHeartbeat();
  }

  /// The capture watchdog says the microphone produced nothing (owner
  /// 2026-07-27). Abort the utterance NOW rather than let the user keep holding
  /// a dead mic for ten seconds and then be told 「没有听到语音」("no speech was
  /// heard"). Same teardown
  /// as a swipe-up cancel — no timeline row, the utterance never happened — plus
  /// a NAMED reason, because this one is a fault, not a choice.
  void _onCaptureFault(String code) {
    if (fsm.session != SessionState.recording) return;
    debugPrint('[flowmic.audio] capture fault: $code — aborting the utterance');
    // CR-9 (C8, exit 3 of 5): the recorder died under a continuous recording.
    // Without this the screen stays lit and the ceiling still fires later, for
    // a capture that is already gone.
    endContinuous();
    audio.fenceAndStop();
    _stopHeartbeat();
    segments.clear();
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    fsm.onCaptureDead();
  }

  void _onCapturedChunk(CapturedChunk chunk) {
    if (fsm.session != SessionState.recording) return;
    _emitChunk(chunk);
  }

  /// Feed the N1-B3 retained-audio layer the one fact it needs: is the uplink
  /// up right now. Called from `PttSession`'s `_statusSub` (ptt_session.dart)
  /// — it lives HERE because it belongs to the capture/audio family, and
  /// because `_emitChunk` below is the site it is deliberately NOT wired to.
  void _noteUplinkStatus(SocketStatus s) {
    // ── 🔴 N1-B3 WIRING — THIS EDGE, NOT [_emitChunk]'S CATCH BLOCK ─────────
    //
    // `RetainedAudioSpill` needs one fact: 「the uplink was down while this
    // chunk was live」. Its own header points at [_emitChunk]'s catch block as
    // the place that already holds it. IT DOES NOT, and the difference is the
    // whole outage:
    //   `AudioEmitter.emitChunk`'s doc says 「Throws if the transport is
    //   closed」, but the throw it refers to is `SocketCore.emit`'s
    //   `StateError('SocketCore.emit(...) before connect()')`, raised on
    //   `_adapter == null` ALONE. A network outage does not null the adapter —
    //   the socket stays constructed and `a.emit(...)` returns normally with
    //   the frame going nowhere. So the catch arm fires for 「never connected /
    //   already torn down」 and is SILENT for exactly the case the layer
    //   exists for.  【read 2026-08-08, card N1-B2】
    // Measured, not inferred, and measured against a REAL `SocketCore` rather
    // than a fake — `test/retained_audio_wiring_test.dart`, which failed when
    // it was first written against `FakeSocketTransport` (that fake DOES throw
    // when disconnected, i.e. the opposite of production).
    // The status stream is the fact: it is the same edge
    // `_pcPresence.noteLinkNotLive()` is judged on at the caller.
    if (s == SocketStatus.connected) {
      // 🔴 CR-8 — ACCOUNT FOR THE OUTAGE **HERE**, BEFORE THE RETENTION
      // STOPS. This is the one instant at which the length of the gap is
      // knowable: the bytes are all on disk and none of them has been
      // settled away yet. A moment later the recovery starts deleting them
      // as it transcribes, and the gap becomes unmeasurable forever.
      //
      // If it is not accounted for now, every live row spoken after the link
      // returns sits at an offset that pretends the outage had no duration —
      // and nothing on any of those rows could ever show it.
      _accountOutageForArticle();
      audio.noteUplinkUp();
    } else {
      audio.noteUplinkDown();
    }
  }

  /// The offline stretch just ended: add its length to the article clock.
  ///
  /// Only for a continuous recording, and only for the audio THIS recording
  /// retained — an orphan from a previous run belongs to a different article
  /// (or to none) and its length is not part of this one.
  /// 🔴 SYNCHRONOUS, AND THE BYTE COUNT COMES FROM MEMORY. Both halves were
  /// learned the hard way in one measurement: the first version read the
  /// count back off the disk inside an `unawaited` future, and the recovery
  /// channel — which fires on this same edge — had already begun deleting
  /// the stretch it had transcribed. The 45-second gap was accounted as 0,
  /// and every row after it sat 45 seconds early with nothing able to show
  /// it. See RetainedAudioStore.sessionRetainedBytes.
  void _accountOutageForArticle() {
    final String? id = articles.articleId;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    if (id == null || spill == null) return;
    if (spill.sessionKey != id) return;
    final int bytes = spill.sessionRetainedBytes;
    if (bytes <= 0) return;
    final int? at = articles.accountOfflineBytes(bytes);
    diag('audio.continuous.outage_accounted', <String, Object?>{
      'article': id,
      'bytes': bytes,
      'starts_at_ms': at,
    });
  }

  void _emitChunk(CapturedChunk chunk) {
    try {
      AudioEmitter.emitChunk(
        transport,
        seq: chunk.seq,
        tsMs: chunk.tsMs,
        payload: chunk.payload,
      );
    } on Object {
      // Wire dropped: the ring buffer replays it on the next reconnect edge.
      //
      // ⚠️ N1-B2: this is NOT where the retained-audio layer learns 「the uplink
      // is down」, and it cannot be. `SocketCore.emit` throws on `_adapter ==
      // null` only — 「before connect()」 / after teardown — and a network outage
      // leaves the adapter in place, so this arm never runs for the case
      // `RetainedAudioSpill` exists to survive. The signal is wired on the
      // transport STATUS edge instead (`ptt_session.dart`, `_statusSub`), which
      // is the same fact `_pcPresence.noteLinkNotLive()` is judged on. Nothing
      // is added here: one fact, one writer.
    }
  }
}
