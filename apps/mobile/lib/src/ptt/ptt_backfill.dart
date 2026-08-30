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

extension PttSessionBackfill on PttSession {
  /// Open a recovery session on the wire. Returns false if now is not the time.
  ///
  /// Refuses rather than queues, and the caller retries later: the conditions
  /// that make it refuse (no link, a recording in progress) are exactly the
  /// conditions under which waiting is the right thing to do anyway.
  bool beginBackfill({
    required FlowMode mode,
    required String sourceLang,
  }) {
    if (fsm.connection != ConnectionState.connected) return false;
    if (!sessionAcceptsPttDown(fsm.session)) return false;
    segments.clear();
    fsm.onPttDown();
    transport.emit(
      FlowMicEvents.audioStart,
      AudioStartPayload(
        mode: mode,
        sourceLang: sourceLang,
        // 🔴 Always `none`, never the session's current destination. See the
        // header: recovered audio has nowhere to be delivered to, and a late
        // out-of-order sentence arriving on a PC is the accident §4.0 C bans.
        delivery: Delivery.none,
        // Direct, so each recovered segment settles as it arrives rather than
        // waiting in a buffer nobody is watching.
        sendPolicy: SendPolicy.direct,
      ).toJson(),
    );
    diag('audio.backfill.begin', <String, Object?>{'mode': mode.name});
    return true;
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

  /// Close the recovery session and let the terminal final come back.
  void endBackfill() {
    _safeEmit(FlowMicEvents.audioStop, const <String, Object?>{});
    fsm.onPttUp();
    diag('audio.backfill.end', const <String, Object?>{});
  }

  /// Abandon a recovery session that cannot finish (the link died mid-feed).
  ///
  /// 🔴 NOT `pttCancel`. That one latches `utteranceCancelled`, which drops
  /// every transcript frame this session still owes — correct for a user who
  /// swiped up, wrong here: the server may already have finalised some of this
  /// stretch, and those rows are recovered words we asked for. This just returns
  /// the FSM to rest so the next attempt can begin.
  void abortBackfill() {
    if (fsm.session == SessionState.recording) fsm.onPttUp();
    diag('audio.backfill.aborted', const <String, Object?>{});
  }
}
