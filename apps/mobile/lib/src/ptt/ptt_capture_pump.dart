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
    // Card LS-4: a fault is NOT a cancel. The user did not throw these words
    // away, so this names itself and gets NO tombstone — the recording stays
    // recoverable.
    audio.fenceAndStop(reason: JournalInterrupt.captureFault);
    _stopHeartbeat();
    segments.clear();
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    articles.attempts.liveSettled(); // follow-up: a dead capture owes no final
    fsm.onCaptureDead();
  }

  void _onCapturedChunk(CapturedChunk chunk) {
    if (fsm.session != SessionState.recording) return;
    // Card RC-L — pair the chunk clock with the capture position, so the
    // relay's `acked_audio_ms` can be read as 「answered up to here」.
    final String? id = articles.liveArticleId;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    if (id != null && spill != null && spill.sessionKey == id) {
      engineOutage.noteChunk(
        articleId: id,
        tsMs: chunk.tsMs,
        bytes: chunk.payload.length,
        capturedBytes: spill.recordingCapturedBytes,
      );
    }
    _emitChunk(chunk);
  }

  /// Card RC-L — an interim's `acked_audio_ms`, for the open long recording.
  void _noteAnsweredForArticle(int? ackedMs) {
    final String? id = articles.liveArticleId;
    if (ackedMs == null || id == null || !continuous.isActive) return;
    engineOutage.noteAnswered(articleId: id, ackedMs: ackedMs);
  }

  /// Card RC-P — place an owed tail that waited for the live terminal final
  /// (see [_accountOwedTail]); a no-op when none is waiting.
  ///
  /// 🔴 [draftLanded] false — the final brought no words, or never came: the
  /// seconds between the settled prefix and where the relay had answered are
  /// then on no row, and the manifest already owes them (it was written from
  /// the prefix at the stop). [draftDurable] — the draft row is on disk: only
  /// then is the owed range narrowed to the answered position, before the tail
  /// is placed and before the recovery, held until then, may read it.
  /// ⚠️ 更正（Codex rc3 ①，2026-09-24）：原为 widening the range back to the
  /// prefix here when no draft came — a duty that lived only in memory.
  Future<void> resolveOwedTailPlacement({
    required String reason,
    required bool draftLanded,
    bool draftDurable = false,
  }) async {
    // RC7 — the tail's pieces are concluded only here, with the draft on disk:
    // narrowed to the answer, or done whole when the closing leg heard them.
    final ({String recordingId, int startBytes, bool covered})? settle =
        draftLanded && draftDurable ? articles.pendingOwedTailSettle : null;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    if (settle != null && spill != null) {
      await spill.settleTailPieces(settle.recordingId,
          answeredBytes: settle.startBytes, closingLegHeard: settle.covered);
    }
    final int? at = articles.resolveOwedTail(draftLanded: draftLanded);
    diag('audio.continuous.owed_tail_placed', <String, Object?>{
      'starts_at_ms': at,
      'reason': reason,
      'draft_landed': draftLanded,
      'narrowed_to_bytes': settle?.startBytes,
      'closing_leg_heard': settle?.covered,
    });
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
  ///
  /// ── Card RC-3 — [recordingEnding]: THE STRETCH NOTHING WILL EVER ANSWER ────
  ///
  /// The link-up edge above is the legacy face's moment. On the journal face
  /// `sessionRetainedBytes` is always 0 (the segment store is not written), and
  /// an ENGINE outage has no link edge at all — so neither one was ever
  /// accounted, and a recording stopped while the engine was down left the
  /// article clock at the last live row. The recovery then had nowhere honest
  /// to put the tail (root-cause §1.7: it went out on the live clock with the
  /// whole recording's length, 1:57 + 6:38 = 8:36).
  ///
  /// ⇒ when the recording ENDS with the link or the engine down, the audio
  /// after the last live row is owed: nothing on the wire will ever transcribe
  /// it, and only this phone has it. Measured here, while the journal is still
  /// open (the callers run this before the stop that closes it):
  ///   · the transcribed PREFIX — the article clock, Σ of the live rows'
  ///     `duration_ms` (the source the root-cause card names) — goes onto the
  ///     manifest, and the recovery range starts after it;
  ///   · the rest — captured audio minus that prefix — is accounted on the
  ///     clock as one offline stretch starting at the prefix, which is exactly
  ///     where the recovered rows belong.
  ///
  /// ⚠️ NOT ON THE ENGINE-BACK EDGE, ON PURPOSE. When the engine returns
  /// mid-recording the relay replays what its ring still holds and those rows
  /// claim their own time on arrival; accounting the stretch as well would
  /// count the replayed part twice, and the phone has no fact that says how
  /// much the relay replayed. That half stays open (card report, RC-3).
  ///
  /// ⚠️ 更正（RC-3b，2026-09-24）：the paragraph above is two claims, and only the
  /// second was ever true. The relay now says how much it replayed
  /// (`stt:engine-status{ready}.replayed_ms`, book 04), and the engine-back
  /// edge is accounted — in [_noteEngineStatusForArticle], not here. And the
  /// rows do NOT claim only their own time: the row that spans the outage
  /// reports the relay's wall time for the whole segment (server-core
  /// `orchestrator-rollover.ts` `boundaryMs = host.now()`), outage included,
  /// which is why that method trims it (`ArticleScribe.liveRowSpan`).
  void _accountOutageForArticle({bool recordingEnding = false}) {
    final String? id = articles.articleId;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    if (id == null || spill == null) return;
    if (spill.sessionKey != id) return;
    if (recordingEnding) {
      _accountOwedTail(id, spill);
      return;
    }
    final int bytes = spill.sessionRetainedBytes;
    if (bytes <= 0) return;
    final int? at = articles.accountOfflineBytes(bytes);
    diag('audio.continuous.outage_accounted', <String, Object?>{
      'article': id,
      'bytes': bytes,
      'starts_at_ms': at,
    });
  }

  /// Card RC-3 — see [_accountOutageForArticle]'s `recordingEnding` half.
  void _accountOwedTail(String id, RetainedAudioSpill spill) {
    if (!continuous.isActive || !spill.retainFromFirstFrame) return;
    final bool linkDown = !spill.uplinkUp;
    final bool engineDown = engineReconnect.engineDown;
    if (!linkDown && !engineDown) return;
    final int? prefixMs = articles.accountedMs;
    if (prefixMs == null) return;
    // 🔴 CARD RC-P — FROM WHERE THE RELAY ANSWERED, NOT FROM THE LAST ROW.
    // ⚠️ 更正（RC-P，2026-09-24）：原为 the owed tail starting at the settled
    // prefix and the clock pushed to the recording's end right here. S6
    // measured what that costs: the relay HAD heard and answered 36.7–45.2 s
    // (the dead leg's draft came back as the live terminal final), so those
    // 8.5 s were transcribed twice, billed twice and printed twice, the draft
    // filed at the recording's end (102,400) — root cause §2.1. Now the tail
    // starts at max(prefix, answered) and only the MANIFEST is written here
    // (the journal is still open, and the live settle must see `owesTail`); the
    // clock waits for the live terminal final (`ArticleScribe.holdOwedTail`,
    // placed by `resolveOwedTailPlacement`), so the draft row lands at the
    // prefix and the recovered tail right after it.
    final int? answered = engineOutage.answeredBytes(id);
    final int answeredMs = answered == null ? prefixMs : pcmBytesToMs(answered);
    final int startMs = answeredMs > prefixMs ? answeredMs : prefixMs;
    final int owedMs = pcmBytesToMs(spill.recordingCapturedBytes) - startMs;
    // Nothing past the last live row (or the rows' reported lengths ran past
    // the bytes): there is no tail, and a prefix at or beyond the end would
    // leave the recording with an empty range that nothing ever settles.
    if (owedMs <= 0) return;
    articles.holdOwedTail(
      id,
      pcmMsToBytes(owedMs),
      recordingId: spill.liveAttempt?.recordingId,
      prefixBytes: pcmMsToBytes(prefixMs),
      startBytes: pcmMsToBytes(startMs),
    );
    // RC-K — no placement on the manifest: it is known only once the draft row
    // is placed. Until then the recovery falls back to the range's own start
    // (`_attempt`'s `persistedStartMs`), and after a relaunch it stays there.
    // ⚠️ 更正（Codex rc3 ①，2026-09-24）：原为 `noteOwedTail(startMs)` — from the
    // ANSWERED position, with the duty to widen back to the prefix held only in
    // memory: a restart or a new recording before the draft landed lost
    // 36.8–45.2 s for good. The manifest now owes from the PREFIX, and is
    // narrowed to the answer once the draft row is on disk
    // (`resolveOwedTailPlacement`, retained_audio_owed_widen.dart).
    // RC7 — in pieces around any stretch already owed (`oweTail`, Codex rc6 ②).
    final String? recording = spill.liveAttempt?.recordingId;
    if (recording != null) unawaited(spill.oweTail(recording, pcmMsToBytes(prefixMs)));
    diag('audio.continuous.owed_tail_accounted', <String, Object?>{
      'article': id,
      'prefix_ms': prefixMs,
      'answered_ms': answered == null ? null : answeredMs,
      'owed_ms': owedMs,
      'link_down': linkDown,
      'engine_down': engineDown,
    });
  }

  /// Card RC-3b — THE ENGINE CAME BACK MID-RECORDING: HOW MUCH DID NOBODY HEAR?
  ///
  /// `reconnecting` marks where the outage began (the capture position of the
  /// FIRST such frame). The `ready` that ends it carries `replayed_ms`: what the
  /// relay re-fed its new leg from its ring. The ring keeps the NEWEST audio, so
  /// that covers the END of the outage; the rest — from the outage's start, for
  /// (outage − replayed) — was evicted before any engine heard it, and only
  /// this phone still has it. That stretch is
  ///   · recorded on the manifest as the owed range (`noteOwedTail` with an
  ///     end), which also takes the recording away from the live settle — its
  ///     receipt counts the evicted frames as taken, and would otherwise
  ///     license deleting the only copy (`engine/stt-session-intake.ts`
  ///     `FrameTally.note`: 「did we take your audio」, never 「did a vendor hear
  ///     it」);
  ///   · accounted on the article clock where it sits, and taken back off the
  ///     live row that spans it (`ArticleScribe.accountHoleInsideNextLiveRow`,
  ///     which says why), so the recovered row fills it and the head adds up.
  ///
  /// A relay that sends no `replayed_ms` (older than RC-3b) ⇒ nothing is
  /// accounted, and said: that is today's behaviour — the live row keeps the
  /// wall time, the evicted words are missing, and the live settle deletes the
  /// audio on a complete receipt. Only the journal face keeps the audio; on the
  /// legacy face there is nothing to recover and nothing is accounted.
  void _noteEngineStatusForArticle(Map<String, Object?> data) {
    final Object? status = data['status'];
    final String? id = articles.liveArticleId;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    if (status == 'reconnecting') {
      if (id != null &&
          spill != null &&
          continuous.isActive &&
          spill.retainFromFirstFrame &&
          spill.sessionKey == id) {
        engineOutage.noteDown(
            articleId: id, capturedBytes: spill.recordingCapturedBytes);
      }
      return;
    }
    if (status != 'ready' || id == null || spill == null) return;
    // RC-L — read before `takeStart` forgets the outage.
    final int? answeredAtDown = engineOutage.answeredAtDown(id);
    final int? downBytes = engineOutage.takeStart(id);
    if (downBytes == null) return;
    final int readyBytes = spill.recordingCapturedBytes;
    final int outageBytes = readyBytes - downBytes;
    final Object? replayed = data['replayed_ms'];
    if (replayed is! int || replayed < 0) {
      diag('audio.continuous.engine_back_unaccounted', <String, Object?>{
        'article': id,
        'outage_ms': pcmBytesToMs(outageBytes),
        'reason': 'no replayed_ms on ready (relay older than RC-3b)',
      });
      return;
    }
    // 🔴 CARD RC-L (phone half) — THE DEAD LEG HEARD MORE THAN IT ANSWERED.
    // ⚠️ 更正（RC-L，2026-09-24）：原为 owed = [outage start, + (outage −
    // replayed)]. The relay counts audio handed to a leg as heard, and a leg
    // that dies answers only up to where its words had come back — 1–2 s
    // behind, up to 20 s in a backlog (root cause §1.2: 「都记下」 lost between
    // the last interim and the drop). So the owed stretch starts at the last
    // ANSWERED position (or the drop, whichever is earlier) and ends where the
    // replay began, each widened by [kOwedEdgeMs] because a range cut mid-word
    // loses the word on both sides (server-core `orchestrator-replay.ts`:
    // 「owner already chose duplication over dropped content」).
    // The end formula holds for today's relay and the RC-L one alike: the
    // replay always runs to 「now」.
    // ⚠️ The edges widen a REAL hole only: when the replay already reaches back
    // to where the dead leg had answered (the relay's own RC-L half does
    // exactly that), nothing is owed — widening a zero gap by 2 s would open a
    // two-second recovery, and a duplicate row, on every engine outage.
    int fromBytes = downBytes;
    if (answeredAtDown != null && answeredAtDown < fromBytes) {
      fromBytes = answeredAtDown;
    }
    final int replayFromBytes = readyBytes - pcmMsToBytes(replayed);
    // RC6 (F2 ②) — after the stop, with RC-P's tail held: the closing rung's `ready`.
    if (!continuous.isActive && _withdrawTailHeardByClosingRung(id, replayFromBytes)) return;
    // ⚠️ 更正（RC6 F3，2026-09-25）：原为 `replayFromBytes > fromBytes` — any
    // positive gap. A replay from exactly the answered point reads as a hole of
    // up to 1.4 s here (the two clocks, `kMinOwedHoleMs`'s doc), and the edges
    // made it 3.4 s of silence owed for good. A raw hole under that is not owed.
    final bool hole = replayFromBytes - fromBytes >= pcmMsToBytes(kMinOwedHoleMs);
    fromBytes -= pcmMsToBytes(kOwedEdgeMs);
    if (fromBytes < 0) fromBytes = 0;
    int toBytes = replayFromBytes + pcmMsToBytes(kOwedEdgeMs);
    if (toBytes > readyBytes) toBytes = readyBytes;
    final int startBytes = fromBytes;
    final int owedBytes = hole ? toBytes - fromBytes : 0;
    if (owedBytes <= 0) {
      diag('audio.continuous.engine_back_covered', <String, Object?>{
        'article': id,
        'outage_ms': pcmBytesToMs(outageBytes),
        'replayed_ms': replayed,
      });
      return;
    }
    final int? at = articles.accountHoleInsideNextLiveRow(owedBytes);
    // RC-K — each outage is its own stretch, placed where this one was spoken.
    spill.noteOwedTail(startBytes,
        endBytes: startBytes + owedBytes, atMs: at);
    diag('audio.continuous.engine_hole_accounted', <String, Object?>{
      'article': id,
      'outage_ms': pcmBytesToMs(outageBytes),
      'replayed_ms': replayed,
      'owed_ms': pcmBytesToMs(owedBytes),
      'range_start_bytes': startBytes,
      'answered_at_down_bytes': answeredAtDown,
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
