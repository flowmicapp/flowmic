// Part of ptt_session.dart — card RC4-S5: a long recording owes the stretch the
// relay says no engine heard.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:error` row (`unheard_from_ms`)
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// CR-12-E re-run 4, S5, measured: the recording stopped with the engine up, a
// row cut's flush still out on the relay. The words said during that flush
// reached no engine; the relay said STT_SEGMENT_NOT_TRANSCRIBED ahead of the
// terminal final. RC-P's owed tail is taken only at the STOP and only when the
// link or the engine is down then (`ptt_capture_pump.dart` `_accountOwedTail`),
// so this phone owed nothing: the live settle kept the file as
// `settled_unverified` (the error had already closed PROCESSING ⇒
// `notEndedNormally`), nothing retried it, and ~20 s of speech was in no row.
//
// The relay's code is the only fact that says so, and it arrives after the
// stop. So it is handled HERE, on its arrival, and handed to the machinery RC-P
// already has: the tail is held for the live terminal final (the draft row is
// placed at the prefix first — `ArticleScribe.holdOwedTail`), the manifest owes
// it from the settled prefix (durable whatever happens to memory, Codex rc3 ①),
// narrowed to the relay's start once the draft row is on disk
// (`resolveOwedTailPlacement`), and the recovery leg transcribes it in place,
// once.
//
// WHERE IT STARTS. `unheard_from_ms` (the relay's own reading of where its
// answered mark stopped) mapped to a capture position. A relay that predates it
// ⇒ max(settled prefix, the last `acked_audio_ms`): the vendor's final can run
// past what the wire last showed as answered, so this can transcribe a few
// seconds a second time — never lose them.

part of 'ptt_session.dart';

/// The relay's code for 「the recording ended with captured voice no engine
/// received」 (server-core `stt/owed-voice-verdict.ts` `SEGMENT_NOT_TRANSCRIBED`).
const String kSttSegmentNotTranscribed = 'STT_SEGMENT_NOT_TRANSCRIBED';

/// RC6 (F2, MAIN ruling) — the safety cap on how long PROCESSING waits for a
/// long recording's terminal final after its stop. The wait is otherwise
/// bounded only by the link: a drop outlasting the state machine's grace ends
/// it (`FlowmicStateMachine.onSocketStatus`). Book 08 §2, RC6 correction.
const Duration kLongStopWaitCap = Duration(minutes: 5);

extension PttSessionUnheardTail on PttSession {
  /// Card RC4-S5 — an `stt:error` [e] arrived. For a long recording whose
  /// relay says a stretch reached no engine, owe that stretch. Synchronous up to
  /// the manifest write: the terminal final follows this frame at once, and the
  /// live settle must already see the recording as owed (`live_settle.dart`
  /// `owesTail`).
  ///
  /// RC4-S5 follow-up (MAIN ruling) — returns whether the stretch is OWED and
  /// will be recovered by itself (by this call, or by RC-P at the stop). The
  /// caller then does not raise the 「say that part again」 banner: saying it
  /// again would put the words in twice, and the article page's pending line is
  /// the sentence that is true (book 15 §2.0-d, RC4-S5 follow-up block).
  bool _oweUnheardTail(SttError e) {
    if (e.code != kSttSegmentNotTranscribed) return false;
    // Codex rc4 ② — only the LIVE recording's closing frame. The article clock,
    // the live attempt and the owed flag all outlive the stop, so a recovery's
    // own 「not transcribed」 used to be taken for the live one and swallowed;
    // its partial final then settled the attempt and released the audio. Who
    // opened the session now on the wire is the one fact that tells them apart
    // (`ptt_backfill.dart` `openSessionIsRecovery`); a recovery's error goes to
    // the state machine, which keeps that attempt incomplete.
    if (openSessionIsRecovery) return false;
    final String? id = articles.liveArticleId;
    final RetainedAudioSpill? spill = audio.retainedAudio;
    final LiveAudioAttempt? attempt = spill?.liveAttempt;
    if (id == null || spill == null || attempt == null || !spill.retainFromFirstFrame) return false;
    // A long recording is filed under its article id (`beginContinuous`); an
    // ordinary press has no article clock to place a recovered tail on.
    if (RetainedAudioSpill.sessionKeyOf(attempt.recordingId) != id) return false;
    // RC-P already owes this recording's tail (the stop saw the link or the
    // engine down): it measured from the same prefix, and one owed tail is one.
    // ⚠️ 更正（Codex rc4 ①，2026-09-25）：原为 `spill.owesTail(…) ||` as well.
    // That answers 「is ANYTHING owed」, and a bounded mid-recording hole (RC-3b /
    // RC-L) sets it too: the tail was then not written, the hole's recovery
    // settled the recording and released the PCM, and the last seconds were on
    // no row. Only RC-P's own held tail means the tail is owed; any other
    // stretch is recorded beside this one (RC-K appends).
    if (articles.owedTailPendingFor(id)) return true;
    final int? prefixMs = articles.accountedMs;
    if (prefixMs == null) return false;
    final int? fromMs = e.unheardFromMs;
    final int? relayStart =
        fromMs == null ? null : engineOutage.positionOf(articleId: id, tsMs: fromMs);
    final int? answered = engineOutage.answeredBytes(id);
    final int readMs = relayStart != null
        ? pcmBytesToMs(relayStart)
        : answered != null
            ? pcmBytesToMs(answered)
            : prefixMs;
    final int startMs = readMs > prefixMs ? readMs : prefixMs;
    final int owedMs = pcmBytesToMs(spill.recordingCapturedBytes) - startMs;
    diag('audio.continuous.unheard_tail', <String, Object?>{
      'article': id,
      'prefix_ms': prefixMs,
      'unheard_from_ms': fromMs,
      'relay_start_ms': relayStart == null ? null : pcmBytesToMs(relayStart),
      'answered_ms': answered == null ? null : pcmBytesToMs(answered),
      'owed_ms': owedMs,
    });
    // Nothing past the last live row: the terminal final carries it all, and
    // nothing is owed, so the relay's sentence stays (there is nothing to recover).
    if (owedMs <= 0) return false;
    articles.holdOwedTail(
      id,
      pcmMsToBytes(owedMs),
      recordingId: attempt.recordingId,
      prefixBytes: pcmMsToBytes(prefixMs),
      startBytes: pcmMsToBytes(startMs),
    );
    unawaited(spill.oweTail(attempt.recordingId, pcmMsToBytes(prefixMs), afterStop: true));
    return true;
  }

  /// RC4-S5 follow-up (MAIN ruling) — how long PROCESSING waits for a LONG
  /// recording's terminal final after its stop, or null for every other stop
  /// (push-to-talk keeps the RC-M idle net). Read BEFORE `endContinuous()`.
  ///
  /// ⚠️ 更正（RC6 F2，2026-09-25，MAIN 裁定）：原为 max(15 s, the audio sent and
  /// not reported answered + 5 s), the relay's derived worst case when no
  /// position was ever reported, and no extension at all when the engine or the
  /// link was down at the stop. CR-12-E re-check 5 measured 37.2 s against a
  /// ≈31 s net (s5b): the relay first waits out the flush in flight, then
  /// dials, replays and flushes the closing leg — the unanswered audio drains
  /// twice, in series. And with the engine down at the stop the relay's closing
  /// dial can still get through (the yield drill: the final came 79.6 s later,
  /// after the phone had given up at 15 s + 45 s and transcribed the tail
  /// itself). So a long recording's stop waits for the relay: its terminal final
  /// or a terminal error, bounded by the link (the state machine's drop grace)
  /// and [kLongStopWaitCap]. While it waits, RC-P's held tail keeps the recovery
  /// off the wire (`RecoveryAttemptLedger.liveHold`).
  Duration? _longStopNet() {
    final String? id = articles.liveArticleId;
    if (!continuous.isActive || id == null) return null;
    diag('audio.continuous.stop_net', <String, Object?>{
      'article': id,
      'net_ms': kLongStopWaitCap.inMilliseconds,
    });
    return kLongStopWaitCap;
  }

  /// RC6 (F2 ②) — a `ready` arrived AFTER the stop of a long recording whose
  /// tail RC-P holds (the engine was down at the stop): the relay's closing
  /// rung got through (server-core `orchestrator-terminal.ts`
  /// `settleOwedVoice`). Its replay starts at [replayFromBytes] of the capture.
  /// Reaching back to where the owed tail starts (within [kMinOwedHoleMs], the
  /// two-clock tolerance), the closing leg heard the whole tail and its final
  /// will carry it: the tail is withdrawn — no trim of the draft, the manifest's
  /// stretch marked done, the live settle unblocked — instead of being
  /// transcribed a second time (re-check 5 yield drill: 92 s twice). A replay
  /// that starts later leaves the tail owed as it is (duplication over loss).
  /// Returns whether a held tail was there to judge (the caller then does not
  /// also account the outage as a mid-recording hole).
  bool _withdrawTailHeardByClosingRung(String id, int replayFromBytes) {
    final ({String recordingId, int prefixBytes, int startBytes})? held =
        articles.heldOwedTailOf(id);
    if (held == null) return false;
    final bool covered =
        replayFromBytes - held.startBytes < pcmMsToBytes(kMinOwedHoleMs);
    diag('audio.continuous.closing_rung_ready', <String, Object?>{
      'article': id,
      'replay_from_ms': pcmBytesToMs(replayFromBytes),
      'tail_from_ms': pcmBytesToMs(held.startBytes),
      'withdrawn': covered,
    });
    if (!covered) return true;
    // ⚠️ 更正（RC7，Codex rc6 ①②，2026-09-25）：原为 withdrawing the tail here,
    // on disk too. Now memory only: the draft keeps its span and the live settle
    // may run again; the manifest keeps owing the tail until the final's row is
    // persisted (`resolveOwedTailPlacement` → `settleTailPieces`), and then only
    // the tail's own pieces are concluded, never a hole beside them.
    articles.markOwedTailCovered(id);
    audio.retainedAudio?.noteTailHeardByClosingLeg(held.recordingId);
    return true;
  }
}
