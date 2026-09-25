// Part of ptt_session.dart — CARD CR-5, THE WIRE HALF OF THE RE-TRANSCRIPTION
// CHANNEL.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.F③ (「留存 PCM 喂回普通转录路」 — retained PCM fed back into the ORDINARY
//     transcription path), §6 C3 (the unit's only real acceptance) / C4
//   apps/mobile/lib/src/audio/retained_audio_store.dart (the bytes, and why
//     they are not transcoded)
//
// ── 🔴 THE ORDINARY PATH, AND THAT IS THE WHOLE DESIGN ──────────────────────
//
// The retained bytes are the SAME bytes the microphone produced: PCM16 / 16 kHz
// / mono, written through untranscoded precisely so that recovery and live are
// one mechanism rather than two that will drift. So recovery does not need a
// second protocol, a second settlement path or a second kind of row — it needs
// to put those bytes on the wire the way the microphone would have.
//
// ⇒ `audio:start` → `audio:chunk` × N → `audio:stop`, and the server segments,
// transcribes and finalises exactly as it always does. The finals come back
// through `ptt_inbound.dart` into `SegmentBuffer` and settle through
// `_settleSpan` — THE single settlement path, which this card was not allowed
// to fork and did not.
//
// ⚠️ `transcribeBatch` was refused, and not on taste: `batchEngineIdFor`
// returns null for a streaming engine, and the production managed leg (Soniox)
// is streaming. A batch route would work in a test and not in production, which
// is the worst of the two ways to be wrong.
//
// ── WHAT IS DIFFERENT FROM A LIVE PRESS, AND WHY EACH DIFFERENCE EXISTS ─────
//
//   · no microphone and no permission gate — there is nothing to record;
//   · `delivery: none` ALWAYS. Recovered audio belongs to a light record by
//     construction (continuous recording only exists where nothing is
//     delivered, ruling ⑨), and a recovered sentence arriving at somebody's PC
//     minutes later, out of order, is the accidental delivery §4.0 C exists to
//     prevent;
//   · no heartbeat. The heartbeat says 「a person is holding the button」; nobody
//     is, and a keepalive claiming otherwise would be a small lie told once a
//     second.
//
// ── 🔴 IT RUNS ONLY WHEN NOTHING IS BEING RECORDED ──────────────────────────
//
// Guarded by the FSM's own `sessionAcceptsPttDown`, the same predicate a real
// press is guarded by. A backfill that started mid-recording would put a second
// `audio:start` on one socket and the server would take it as the user
// re-pressing — the recovered audio and the live audio would then be one
// session, interleaved, which is a corruption no downstream layer could detect.

part of 'ptt_session.dart';

/// How the audio of one offline stretch is fed back.
///
/// 200 ms per frame is what the live path emits (`AUDIO_DEFAULTS` chunk size),
/// and matching it is not cosmetic: the server's silence and segmentation
/// heuristics are tuned against that cadence, so a recovery that shipped one
/// enormous frame would produce different segment boundaries for the same
/// speech.
const int kBackfillChunkBytes = 6400;

/// What [PttSessionBackfill.beginBackfill] answered.
///
/// 🔴 CARD WB-6 — IT USED TO BE A `bool`, AND THE TWO REFUSALS WERE ONE VALUE.
/// They are two facts with two opposite next moves — 「wait until you have
/// finished speaking」 and 「this phone is not connected」 — and the screen that
/// renders them had exactly one sentence, which said the first one. MEASURED
/// 2026-09-12 on TB335ZC with the network off: the card answered 「a recording
/// is running」 while the microphone was closed
/// (docs/archive/strategy/2026-09-12-phone-pending-transcription-retry-rca.md §1-3).
/// A caller that only wants 「did it open」 asks [ok]; a caller that has to say
/// WHY not reads the value.
enum BackfillStart {
  /// The session is open and the `audio:start` has left.
  started,

  /// `fsm.connection != connected`. Nothing was sent, and nothing the user does
  /// on this screen changes it — they have to be connected again first.
  noLink,

  /// A press holds the session (or it is not at rest). Nothing was sent, and
  /// waiting is all that is required.
  sessionBusy;

  bool get ok => this == BackfillStart.started;
}

extension PttSessionBackfill on PttSession {
  /// Open a recovery session on the wire. See [BackfillStart] for the answers.
  ///
  /// Refuses rather than queues, and the caller retries later: the conditions
  /// that make it refuse (no link, a recording in progress) are exactly the
  /// conditions under which waiting is the right thing to do anyway.
  BackfillStart beginBackfill({
    required FlowMode mode,
    required String sourceLang,
    // 🔴 The SAME bundle a live press carries. Recovered speech is transcribed
    // by the same pipeline, so polish / terms / refine must apply to it exactly
    // as they would have applied when it was spoken — a recovery that silently
    // ran on the server's defaults would put two different sets of words in one
    // article and nothing anywhere would say why.
    Map<String, Object?>? prefs,
    // Card RC-1a - the four identifiers, the sample range and the format
    // version (04 SPEC 3.3-a). Null is the LEGACY leg: the segment-store
    // recovery that predates the journal sends exactly the frame it always
    // sent, byte for byte, which is what keeps `backfill_channel_test.dart`
    // unchanged and green.
    //
    // Whole or absent, never half - see AudioStartPayload.recovery.
    RecoveryIdentity? identity,
  }) {
    if (fsm.connection != ConnectionState.connected) {
      return BackfillStart.noLink;
    }
    if (!sessionAcceptsPttDown(fsm.session)) return BackfillStart.sessionBusy;
    segments.clear();
    // Card RC4 — BEFORE the FSM edge, because the FSM's `changes` stream is
    // synchronous: the ASR health wire reads this inside `onPttDown`.
    _openSessionIsRecovery = true;
    fsm.onPttDown();
    // Card FX-2 — recovered audio owns the wire now, and it is `none` for the
    // whole of it. Set HERE rather than derived at the row layer for the reason
    // this file's own comment gives about `delivery` below: one answer, written
    // where the decision is taken.
    _openSessionDelivery = Delivery.none;
    // Card FX-3 — and this is how much audio it is about to feed.
    _openSessionRange = identity?.range;
    // Card RC-N — a journal attempt registers itself with its cursor right
    // after this returns (`recovery_leg_wire.dart` `_runOnWire`); the legacy
    // leg has no identity, and its frames keep the placement they always had.
    if (identity == null) articles.attempts.openedUntracked();
    // 04 SPEC 3.3-a's eight identifiers are SPREAD OVER the payload rather
    // than added to `AudioStartPayload`: that class sits at 697 lines in a
    // 700-line file (audit A9 discipline), and the merge belongs to the one
    // leg that has an identity anyway.
    //
    // ORDER IS LOAD-BEARING: the payload goes in LAST, so `delivery:none`
    // below is this file's answer and no identity can move it.
    // `toStartFields()` does not emit a `delivery` key either - two locks on
    // the one field the whole delivery red line hangs on.
    transport.emit(
      FlowMicEvents.audioStart,
      <String, Object?>{
        if (identity != null) ...identity.toStartFields(),
        ...AudioStartPayload(
        mode: mode,
        sourceLang: sourceLang,
        // 🔴 Always `none`, never the session's current destination. See the
        // header: recovered audio has nowhere to be delivered to, and a late
        // out-of-order sentence arriving on a PC is the accident §4.0 C bans.
        delivery: Delivery.none,
        // Direct, so each recovered segment settles as it arrives rather than
        // waiting in a buffer nobody is watching.
        sendPolicy: SendPolicy.direct,
        prefs: prefs,
        ).toJson(),
      },
    );
    diag('audio.backfill.begin', <String, Object?>{
      'mode': mode.name,
      if (identity != null) 'recording_id': identity.recordingId,
      if (identity != null) 'job_id': identity.jobId,
      if (identity != null) 'attempt_id': identity.attemptId,
      if (identity != null) 'operation_id': identity.operationId,
      if (identity != null) 'attempt_kind': identity.attemptKind.wire,
      if (identity != null) 'range': identity.range.toString(),
      'leg': identity == null ? 'legacy_segment' : 'journal',
    });
    return BackfillStart.started;
  }

  /// Feed one stretch's PCM through as 200 ms frames.
  ///
  /// ⚠️ SEQUENCE NUMBERS START AT 0, exactly as a live press does
  /// (`AudioCapture.start()` resets its own counter). They are per-SESSION, and
  /// the `audio:start` above opened a new one — continuing the live capture's
  /// numbering here would hand the server's `SeqTracker` frames it believes it
  /// has already seen, and it would drop them. Measured against the live path
  /// rather than assumed: that reset is the same line the microphone runs.
  ///
  /// Returns the number of frames emitted; 0 means the wire refused everything,
  /// which the caller must treat as 「not done」 rather than 「nothing to do」.
  int feedBackfill(Uint8List pcm) {
    int sent = 0;
    int seq = 0;
    for (int off = 0; off < pcm.length; off += kBackfillChunkBytes) {
      final int end = (off + kBackfillChunkBytes).clamp(0, pcm.length);
      try {
        AudioEmitter.emitChunk(
          transport,
          seq: seq++,
          // Milliseconds INTO THIS STRETCH, from the byte offset — the same
          // arithmetic the article clock uses, and for the same reason: the
          // bytes are the measurement. A wall-clock stamp here would say when
          // we replayed it, which is a fact about us.
          tsMs: pcmBytesToMs(off),
          payload: Uint8List.sublistView(pcm, off, end),
        );
        sent++;
      } on Object {
        // The link went while we were feeding. Stop — the bytes are still on
        // disk and still unsettled, so the next attempt starts this stretch
        // again from the beginning. Partial credit would be the one thing that
        // could lose them.
        diag('audio.backfill.wire_dropped', <String, Object?>{'sent': sent});
        return sent;
      }
    }
    return sent;
  }

  /// Card RC-1a - feed ONE BOUNDED BLOCK of a stretch, continuing an emission
  /// that another call started.
  ///
  /// 🔴 WHY THIS EXISTS NEXT TO [feedBackfill] RATHER THAN REPLACING IT. The
  /// legacy segment leg reads a whole outage file into memory and hands it over
  /// in one call, and that leg is what ships today; leaving it byte-identical is
  /// what keeps `backfill_channel_test.dart` an unchanged control. The journal
  /// leg cannot do that - a thirty-minute recording is ~57 MiB - so it reads
  /// bounded blocks off disk and calls this once per block.
  ///
  /// [seqStart] continues the per-SESSION sequence (the `audio:start` above
  /// opened it at 0) and [tsMsBase] is milliseconds from the START OF THE
  /// STRETCH, so two consecutive blocks describe one continuous timeline
  /// instead of two that both begin at zero.
  ///
  /// ⚠️ IT RETURNS FRAMES EMITTED, WHICH IS NOT FRAMES DELIVERED (audit P2-3).
  /// `emit` not throwing proves the socket accepted the call, and socket.io
  /// buffers silently while disconnected. The only thing that answers 「did the
  /// server get these」 is the coverage receipt (04 SPEC 3.3-a (b)), which is
  /// why `recovery_settle.dart` compares this count against `fed_frames` rather
  /// than trusting it.
  int feedBackfillBlock(
    Uint8List block, {
    required int seqStart,
    required int tsMsBase,
  }) {
    // Follow-up (MAIN 2026-09-24) — a yielded attempt sends nothing more: the
    // wire belongs to the live press now, and a recovered frame there would be
    // live audio to the relay.
    if (articles.attempts.wireYielded) return 0;
    int sent = 0;
    int seq = seqStart;
    for (int off = 0; off < block.length; off += kBackfillChunkBytes) {
      final int end = (off + kBackfillChunkBytes).clamp(0, block.length);
      try {
        AudioEmitter.emitChunk(
          transport,
          seq: seq++,
          tsMs: tsMsBase + pcmBytesToMs(off),
          payload: Uint8List.sublistView(block, off, end),
        );
        sent++;
      } on Object {
        diag('audio.backfill.wire_dropped', <String, Object?>{
          'sent': sent,
          'seq_start': seqStart,
        });
        return sent;
      }
    }
    return sent;
  }

  /// Close the recovery session and let the terminal final come back.
  ///
  /// Card RC-M (MAIN ruling 1) — WITHOUT the GA-03 net. The relay flushes a
  /// backlog before it answers (root cause §3.2: 26.7 s after `audio:stop`),
  /// and the fixed 15 s net cut every such attempt as `stall_timeout` while
  /// the words were on their way. The wait is the recovery leg's
  /// (`RecoveryTimeouts`), and it ends it through [abortBackfill].
  void endBackfill() {
    // A yielded attempt's stop already went out, with `discard`; the session
    // on the wire now is the live press's, and this would end it.
    if (articles.attempts.wireYielded) return;
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    fsm.onPttUp(armNet: false);
    diag('audio.backfill.end', const <String, Object?>{});
  }

  /// Card RC4 — the session open on the wire was opened by a recovery pass
  /// ([beginBackfill], either leg), not by a person pressing the button.
  ///
  /// 🔴 THE PHANTOM PRESS (device rerun 4, `r4-YL-list-during-attempt1.png`).
  /// A recovery drives the SAME FSM a press does (`fsm.onPttDown` above), and
  /// every surface that asked the FSM 「is somebody recording」 answered yes:
  /// the list drew a live 「转录中」 bubble with the engine's
  /// `STT_NETWORK_DROP` sentence ending in 「请再说一遍」, and the button read
  /// 「松开 结束」 with the swipe-up strip, while nobody held anything. The FSM
  /// state answers 「what is the wire doing」; this answers 「whose session is
  /// it」, and the user-facing surfaces need both (chat_ptt_lifecycle.dart
  /// `pressSessionState`, chat_notices.dart, chat_asr_health_wire.dart).
  ///
  /// Written by the two openers before their FSM edge (here and
  /// ptt_edges.dart `pttDown`), never cleared at the end of a session: like
  /// [openSessionDelivery], it describes the session last opened, and only
  /// the next opener changes the answer. Pinned by
  /// `test/recovery_no_phantom_press_test.dart`.
  bool get openSessionIsRecovery => _openSessionIsRecovery;

  /// Card RC4 — a recovery pass owns the FSM right now (it is in a session
  /// state that only an opener can reach). False at rest, whoever opened last.
  bool get recoveryOwnsSession =>
      _openSessionIsRecovery &&
      (fsm.session == SessionState.recording ||
          fsm.session == SessionState.processing ||
          fsm.session == SessionState.justDone);

  /// Follow-up (MAIN 2026-09-24) — a registered recovery attempt holds the
  /// wire right now: the session is RECORDING (feeding) or PROCESSING
  /// (waiting) on its behalf. A live press may take the wire from it
  /// ([yieldRecoveryForLive]); the legacy segment leg is not registered and
  /// keeps refusing the press as before.
  bool get recoveryHoldsWire =>
      articles.attempts.wireAttemptInFlight &&
      (fsm.session == SessionState.recording ||
          fsm.session == SessionState.processing);

  /// Follow-up (MAIN 2026-09-24) — THE RECOVERY YIELDS TO LIVE SPEECH.
  ///
  /// Measured before this (phone A report, open items 3 and 4): while an
  /// attempt held the wire the press button was shut for as long as the relay
  /// took (RC-M lets that be minutes), and when a live stop's final and a
  /// recovery did share the wire, the recovery's late segment finals could be
  /// filed under the live press and the live settle declined.
  ///
  /// The attempt's session is thrown away on the relay (`discard`, the swipe-up
  /// cancel's frame: server-core `audio.handler.ts` disposes it without a
  /// flush and emits nothing further); its late frames are dropped here
  /// (`RecoveryAttemptLedger.yieldWire`); the FSM comes back to rest for the
  /// press. The recovery leg sees the yield and returns it as a refusal —
  /// no failure, no backoff, the range still owed — and the pass runs again
  /// once the live session has settled.
  ///
  /// ⚠️ Billing: the relay settles what was already fed on dispose, under the
  /// attempt's operation id. An automatic attempt's id is derived from its job
  /// (card RC-R, `deriveOperationId`), so the resumed attempt is the same
  /// operation and the relay's `meterOnce` does not charge it again.
  void yieldRecoveryForLive() => unawaited(_yieldRecovery('live'));

  /// Card RC6 — the same yield, for an account change
  /// (chat_ptt_lifecycle.dart `stopRecordingForAccountChange`), returning the
  /// discard stop's acknowledgement so sign-out can wait for it
  /// (login_controller.dart `_beforeAccountChange`, bounded there).
  ///
  /// 🔴 ALSO WHEN THE SOCKET IS ALREADY GONE. Measured on the device (rerun 5,
  /// criterion 3): 登出 is reached from the home screen, leaving the chat page
  /// disconnects the socket (main_page_builders.dart `onBack`), and once the
  /// FSM's drop grace is over the session is `disconnected` — the attempt is
  /// still waiting on its own clocks but [recoveryHoldsWire] is false. Nothing
  /// yielded it, and it was written `failed / engine_progress` with a backoff.
  /// Here any registered attempt still in flight
  /// (`RecoveryAttemptLedger.wireAttemptInFlight`) yields; the stop is sent
  /// only on a live link — on a dead one there is no session left to discard,
  /// and a stop queued for the next socket would reach whichever account that
  /// socket belongs to.
  Future<void> yieldRecoveryForAccountChange() => _yieldRecovery('account_change');

  /// The one yield. The leg sees it (`wasYielded`) and returns a refusal: no
  /// failure, no backoff, the range still owed.
  Future<void> _yieldRecovery(String reason) {
    final String? id = articles.attempts.wireAttemptId;
    articles.attempts.yieldWire();
    final bool linked = fsm.connection == ConnectionState.connected;
    diag(
        reason == 'live'
            ? 'audio.backfill.yielded_to_live'
            : 'audio.backfill.yielded_for_account_change',
        <String, Object?>{'attempt_id': id, 'stop_sent': linked});
    final Future<void> acked;
    if (linked) {
      acked = () async {
        try {
          await transport.emitWithAck<Object?>(
            FlowMicEvents.audioStop,
            const <String, Object?>{'discard': true},
            timeout: const Duration(seconds: 10),
          );
        } on Object {
          // No acknowledgement (the link went): nothing more will come from
          // that session over this socket either.
        } finally {
          articles.attempts.yieldedStopAcknowledged();
        }
      }();
    } else {
      // No socket, no session on it, no frames still to come from it.
      articles.attempts.yieldedStopAcknowledged();
      acked = Future<void>.value();
    }
    if (fsm.session == SessionState.recording) fsm.onPttUp(armNet: false);
    fsm.releaseProcessing();
    return acked;
  }

  /// Abandon a recovery session that cannot finish (the link died mid-feed).
  ///
  /// 🔴 NOT `pttCancel`. That one latches `utteranceCancelled`, which drops
  /// every transcript frame this session still owes — correct for a user who
  /// swiped up, wrong here: the server may already have finalised some of this
  /// stretch, and those rows are recovered words we asked for. This just returns
  /// the FSM to rest so the next attempt can begin.
  ///
  /// Card RC-M — also the recovery leg's way out of a wait its own clocks
  /// ended: PROCESSING has no net for a recovery ([endBackfill]), so it is
  /// released here, without a stall banner (the journal records the failure).
  void abortBackfill() {
    if (articles.attempts.wireYielded) return; // see [endBackfill]
    if (fsm.session == SessionState.recording) {
      fsm.onPttUp();
    } else if (fsm.session == SessionState.processing) {
      fsm.releaseProcessing();
    }
    diag('audio.backfill.aborted', const <String, Object?>{});
  }
}
