// Part of chat_controller.dart — WHOSE FINAL IS THIS, AND WHAT IT STILL OWES.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.3 / §4.2 (RC-N),
//     §2.1 S6 (RC-P), §1.3 + §11 ruling 5 (the head is the recorded length)
//   apps/mobile/lib/src/audio/recovery_attempt_ledger.dart (the sessions)
//
// A new part rather than more lines in chat_utterance.dart / _settle.dart: the
// three questions here are asked of EVERY terminal final before either of those
// files decides anything, and they share one input — which wire session the
// frame belongs to.

part of 'chat_controller.dart';

/// Card RC-N — the wire session a final belongs to.
///
/// [live]: the live press / recording. [attemptId]: a registered recovery
/// attempt. Neither: nothing can say (the legacy leg, an older relay) and the
/// frame keeps the placement it always had. [foreign]: the frame is not the
/// open session's — `ptt_inbound.dart` kept it out of the segment buffer and
/// the FSM, so it is settled on its own ([_settleForeignFinal]).
///
/// Codex rc3 ④ — [priorArticleId]: a foreign frame of a PREVIOUS live press or
/// recording (its receipt names a live attempt that is no longer the current
/// one); it is filed at that recording's end, never on the clock running now.
typedef _FinalOwner = ({
  bool live,
  String? attemptId,
  bool foreign,
  AttemptRoute route,
  String? priorArticleId,
});

_FinalOwner _ownerOfFinal(ChatController c, SttFinal f) {
  final attempts = c.session.articles.attempts;
  final String? liveId = c.session.audio.retainedAudio?.liveAttempt?.attemptId;
  final String? echo = f.isSegment ? null : f.coverage?.attemptId;
  final bool foreign = !f.isSegment &&
      attempts.isForeignEcho(echo, liveAttemptId: liveId);
  // The receipt's echo when it names a session this phone knows; otherwise the
  // session open on the wire (a segment final never carries a receipt).
  final bool echoIsLive = echo != null && echo == liveId;
  final String? echoAttempt =
      echo != null && !echoIsLive && attempts.knows(echo) ? echo : null;
  // ⚠️ 更正（Codex rc3 ④，2026-09-24）：a foreign echo naming no recovery attempt
  // used to fall through to 「the wire is live ⇒ live」 below — so the late final
  // of the PREVIOUS recording was placed on the current one's clock and let go
  // of its wire. It is the previous recording's (or, unknown, nobody's).
  if (foreign && echo != null && !echoIsLive && echoAttempt == null) {
    return (
      live: false,
      attemptId: null,
      foreign: true,
      route: AttemptRoute.current,
      priorArticleId: attempts.articleOfLive(echo),
    );
  }
  if (echoIsLive || (echoAttempt == null && attempts.wireIsLive == true)) {
    return (
      live: true,
      attemptId: null,
      foreign: foreign,
      route: AttemptRoute.current,
      priorArticleId: null,
    );
  }
  final String? id = echoAttempt ??
      (attempts.wireIsLive == false ? attempts.wireAttemptId : null);
  return (
    live: false,
    attemptId: id,
    foreign: foreign,
    route: id == null ? AttemptRoute.current : attempts.routeOf(id),
    priorArticleId: null,
  );
}

/// Card RC-N — a terminal final that is not the open session's: the live
/// stop's, arriving while a recovery holds the wire (S5), or a failed
/// attempt's, after the wire moved on. One row from the frame's own words and
/// span, on its own session's clock; nothing of the open session's is touched.
void _settleForeignFinal(ChatController c, SttFinal f, _FinalOwner o) {
  final bool empty = f.text.trim().isEmpty;
  final int spanMs;
  if (o.live) {
    if (empty) {
      // RC-P — with a tail held for this final, its span is that tail's wall
      // time, not silence: the tail is placed whole instead.
      if (!c.session.articles.hasPendingOwedTail) {
        _recordSilentTail(
            c, c.session.articles.liveRowSpan(f.durationMs, live: true));
      }
      _afterLiveTerminal(c, draftLanded: false);
      c.ucNotify();
      return;
    }
    spanMs = c.session.articles.liveRowSpan(f.durationMs, live: true);
  } else {
    if (empty) {
      if (o.attemptId != null) {
        c.session.articles.attempts
            .lateResultLanded(o.attemptId!, const <String>[], f);
      }
      return;
    }
    spanMs = c.session.articles.attempts.rangeMsOf(o.attemptId ?? '') ??
        f.durationMs;
  }
  final String rowId = _settleSpan(c, f,
      fromIdx: f.segmentIdx, text: f.text, owner: o, foreignSpanMs: spanMs);
  if (o.live) _afterLiveTerminal(c, draftLanded: true, draftRowId: rowId);
}

/// The empty terminal final's three duties, before the whole-utterance stall
/// or the silent-tail settle (`_handleTerminalFinal`'s empty-text arm):
///   · RC-N — a late failed attempt that came back empty is still a result
///     (`_finish` reads it as `emptyResult`);
///   · ruling 5 — the silence the recording ended in is recorded time;
///   · RC-P — unless a tail is held for this final: then its span is that
///     tail's wall time, and the tail is placed whole instead (no draft came).
/// Order matters: the silent tail reads the held trim that the tail's
/// placement then clears.
void _emptyTerminalBookkeeping(
    ChatController c, SttFinal f, _FinalOwner owner, int fromIdx) {
  if (owner.route == AttemptRoute.lateFailed && owner.attemptId != null) {
    c.session.articles.attempts
        .lateResultLanded(owner.attemptId!, const <String>[], f);
  }
  if (owner.live && fromIdx > 0 && !c.session.articles.hasPendingOwedTail) {
    _recordSilentTail(
        c,
        c.session.articles.liveRowSpan(
            c.session.segments.durationBetween(fromIdx, f.segmentIdx),
            live: true));
  }
  if (owner.live) _afterLiveTerminal(c, draftLanded: false);
}

/// Ruling 5 (MAIN, 2026-09-24) — a recording that ended in silence: the empty
/// terminal final's span is audio the user recorded, and the head must read the
/// recorded length (S4 read 18 s short, the clean S1 run 17.4 s short; Codex:
/// 393,497 + 18,084 = 411,581 ms against 411,520 captured).
///
/// No row holds silence, so it goes onto the recording's LAST row — the time
/// after its words, up to the stop — and the live clock moves past it. Only
/// inside a recording; an ordinary press has no head.
void _recordSilentTail(ChatController c, int spanMs) {
  final String? article = c.session.articles.liveArticleId;
  if (article == null || spanMs <= 0) return;
  TimelineEntry? last;
  for (final TimelineEntry m in articleMembersOf(c.store, article)) {
    if (last == null || (m.articleOffsetMs ?? 0) >= (last.articleOffsetMs ?? 0)) {
      last = m;
    }
  }
  final TimelineEntry? l = last;
  if (l == null || l.articleOffsetMs == null) return;
  c.session.articles.advanceLiveClock(spanMs);
  c.store.applyArticleSpan(l.id,
      offsetMs: l.articleOffsetMs!, durationMs: (l.durationMs ?? 0) + spanMs);
  diag('audio.continuous.silent_tail_accounted', <String, Object?>{
    'article': article,
    'silent_ms': spanMs,
    'row': l.id,
  });
}

/// Card RC-P — how long after the session came to rest an owed tail waits for
/// the live terminal final before it is placed without it. The relay sends
/// `STT_SEGMENT_NOT_TRANSCRIBED` AHEAD of that final (server-core
/// `stt/owed-voice-verdict.ts`: 「not in the transcript you are about to
/// receive」), so an `stt:error` is not the sign it will not come; this clock
/// is. As long as the recovery leg's engine gap (`RecoveryTimeouts
/// .engineProgress`).
const Duration kOwedTailFinalGrace = Duration(seconds: 45);

/// Card RC-P — the live terminal final has landed: an owed tail held for it
/// is placed now, after the draft row, and its recovery may start
/// (`chat_outbox_host.dart` `maybeSweepOwedTailRouted`).
///
/// [draftLanded] — the final carried words ([draftRowId] is their row). The
/// owed range, written from the prefix at the stop, is narrowed to where the
/// relay had answered only once that row is read back from storage (Codex
/// rc3 ①, `PttSession.resolveOwedTailPlacement`).
///
/// Follow-up (MAIN 2026-09-24) — it is also where the live press lets go of
/// the wire (`RecoveryAttemptLedger.liveHold`), and a recovery pass that was
/// held or yielded for it runs.
void _afterLiveTerminal(ChatController c,
    {required bool draftLanded, String? draftRowId}) {
  c.session.articles.attempts.liveSettled();
  if (!c.session.articles.hasPendingOwedTail) {
    c._owedTailGrace?.cancel();
    c._owedTailGrace = null;
    _resumeHeldRecovery(c);
    return;
  }
  unawaited(() async {
    bool durable = false;
    final String? id = draftRowId;
    if (draftLanded && id != null) {
      await c.store.awaitPersisted(id);
      durable = await c.store.isPersisted(id);
    }
    await c.session.resolveOwedTailPlacement(
        reason: 'live_final', draftLanded: draftLanded, draftDurable: durable);
    maybeSweepOwedTailRouted(c);
    _resumeHeldRecovery(c);
  }());
}

/// Follow-up — the recovery pass held (or yielded) for live speech runs once
/// the live session has let go of the wire and the session is at rest.
void _resumeHeldRecovery(ChatController c) {
  final attempts = c.session.articles.attempts;
  if (attempts.liveHold || !sessionAcceptsPttDown(c.session.fsm.session)) return;
  if (!attempts.takeHeldSweep()) return;
  diag('audio.recovery.resumed_after_live', const <String, Object?>{});
  unawaited(c.backfill.sweep(sourceLang: c._recoverySourceLang));
}

/// Follow-up — a recovery pass was just held for live speech. If the live
/// session is already at rest (its final is late), start the wait for it now;
/// while it is still recording or waiting, its final or its rest edge does.
void _onSweepHeldForLive(ChatController c) {
  final SessionState s = c.session.fsm.session;
  final bool atRest =
      sessionAcceptsPttDown(s) || s == SessionState.disconnected;
  if (c.session.articles.attempts.liveHold && atRest) _armLiveGrace(c);
}

/// Follow-up / RC-P — the live session came to rest without its terminal final
/// (a stall, a dropped link) or an owed tail is waiting for it: give the final
/// [kOwedTailFinalGrace], then let go of the wire, place the tail without a
/// draft, and run whatever recovery was held.
void _armLiveGrace(ChatController c) {
  c._owedTailGrace ??= Timer(kOwedTailFinalGrace, () async {
    c._owedTailGrace = null;
    if (c.session.articles.hasPendingOwedTail) {
      // RC6 (F2 ③) — from here the tail's words are the recovery's: a late
      // final of this live attempt is dropped (`_handleTerminalFinal`).
      final String? live = c.session.audio.retainedAudio?.liveAttempt?.attemptId;
      if (live != null) c.session.articles.attempts.supersedeLive(live);
      // No final ⇒ no draft: the gap to the prefix is owed too.
      await c.session
          .resolveOwedTailPlacement(reason: 'grace', draftLanded: false);
    }
    c.session.articles.attempts.liveSettled();
    maybeSweepOwedTailRouted(c);
    _resumeHeldRecovery(c);
  });
}
