// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.F③ (the re-transcription channel), ruling ⑮ (「允许后台慢慢补，界面说清
//     还要多久」 — it may catch up slowly, provided the screen says how much is
//     left), §6 C3 / C4
//   apps/mobile/lib/src/ptt/ptt_backfill.dart (the wire half)
//   apps/mobile/lib/src/audio/article_replay.dart (where a recovered row goes)
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────────
//
// Finds audio that was captured while the link was down, feeds it back through
// the ordinary transcription path one stretch at a time, and deletes each
// stretch the moment its words have become rows.
//
// It is the piece that makes 「断网期间说的话也在这一篇里」 (「what you said while
// the link was down is in this piece too」) true — C3, which the task unit calls
// the unit's only real acceptance. Everything before this card made the AUDIO
// survive; this one makes the TRANSCRIPT survive.
//
// ── 🔴 ONE AT A TIME, AND ONLY WHEN NOTHING IS BEING RECORDED ───────────────
//
// Two stretches at once would put two `audio:start` frames on one socket and
// the server would read the second as the user pressing again — the two
// recordings would become one interleaved session, which is a corruption
// nothing downstream could detect. The single-flight latch below is therefore
// load-bearing rather than defensive, and the same is true of the FSM gate in
// `beginBackfill`: a live press always wins, and the recovery waits.
//
// ⇒ the failure direction is 「later」, never 「both」.
//
// ── 🔴 SETTLE ⇒ DELETE, AND ONLY AFTER THE ROWS EXIST ───────────────────────
//
// The retained bytes are deleted when the stretch has been transcribed, which
// is the boundary FB-2 depends on (a store that kept them 「just in case」 would
// BE the voice archive this product is forbidden to build). But deleting them
// before the rows exist would lose the words outright, so the delete is the LAST
// step and a failed attempt deletes nothing: the bytes stay, the stretch is
// retried, and the worst case is that the same audio is transcribed twice —
// which costs quota and loses nothing.
//
// ⚠️ Duplicate rows from a double transcription are possible in that worst case
// and are NOT deduplicated here. Stated rather than hidden: the idempotency key
// family is `(session, segment_idx)` and a retry produces the SAME pair, so the
// place to close it is the settle path's existing watermark — not a second
// dedupe invented here, which is how a mechanism ends up with two owners.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../audio/article_replay.dart';
import '../audio/retained_audio_store.dart';
import '../diag/diag_log.dart';
import '../ptt/ptt_session.dart';
import '../signaling/state_machine.dart';
import '../signaling/wire_payloads.dart' show FlowMode;
import '../timeline/article.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';

/// How much recovery is still owed, for the face ruling ⑮ requires.
@immutable
class BackfillProgress {
  const BackfillProgress({
    required this.pendingMs,
    required this.running,
  });

  static const BackfillProgress idle =
      BackfillProgress(pendingMs: 0, running: false);

  /// Milliseconds of audio still waiting to become words. Derived from the
  /// BYTES on disk, so it is a measurement of the remaining work rather than an
  /// estimate of how long the work will take — which is the honest thing to put
  /// on screen, and the reason ruling ⑮ could be satisfied without first knowing
  /// whether recovery is faster than real time.
  final int pendingMs;

  /// Whether a stretch is being fed back right now.
  final bool running;

  bool get hasWork => pendingMs > 0 || running;
}

/// Feeds retained audio back through the ordinary transcription path.
///
/// Construct one per session layer. Nothing happens until [sweep] is called;
/// production calls it on the edges where the answer can have changed — the
/// link coming back, and a recording ending.
class BackfillRunner {
  BackfillRunner({
    required PttSession session,
    required TimelineStore store,
    RetainedAudioStore? Function()? storeOf,
    Duration settleTimeout = const Duration(seconds: 20),
  })  : _session = session,
        _timeline = store,
        _storeOf = storeOf ?? (() => session.audio.retainedAudio?.store),
        _settleTimeout = settleTimeout;

  final PttSession _session;
  final TimelineStore _timeline;
  final RetainedAudioStore? Function() _storeOf;
  final Duration _settleTimeout;

  /// 🔴 THE SINGLE-FLIGHT LATCH. See the header: two stretches at once is a
  /// corruption, not a performance problem.
  Future<void>? _inFlight;

  /// 🔴 REQUESTS ARE SERIALISED, NOT DROPPED, AND NOT COALESCED EITHER.
  ///
  /// Two earlier versions of this were wrong in ways that only a real timing
  /// test found:
  ///   ① `if (busy) return` — production fires edge 1 (the link returning) and
  ///     edge 2 (a recording ending) close together, so the second request was
  ///     thrown away and the debt waited for an edge that might not come for
  ///     hours: audio on disk, nothing catching it up, nothing saying so;
  ///   ② `if (busy) { again = true; return theRunningOne; }` — better, and
  ///     still wrong, because the run in flight was started under OLDER
  ///     conditions. The link-edge sweep begins while the recording is still
  ///     going, is correctly refused by the FSM gate, and finishes; a caller
  ///     that awaited THAT future was told 「done」 about a run that had
  ///     refused before their request existed. Measured on C3: the recovery
  ///     never ran and the acceptance failed with no rows at all.
  ///
  /// ⇒ each request gets its OWN pass, queued behind whatever is running. One
  /// stretch at a time is preserved — which was the only property that ever
  /// mattered — and an awaiting caller waits for its own work, not somebody
  /// else's.


  /// Whether a pass is queued or running. Exposed because both the face and
  /// a test need to know 「is this settled yet」, and asking the progress value
  /// answers a different question (it is published at points, not continuously).
  bool get isBusy => _inFlight != null;

  final ValueNotifier<BackfillProgress> progress =
      ValueNotifier<BackfillProgress>(BackfillProgress.idle);

  /// What the recovery of one stretch needs to know, and where it goes.
  ///
  /// [FlowMode.realtime] always: translate/organize settle once per utterance
  /// (their compose controller is single-flight), so recovering a half-hour
  /// stretch through one of them would produce ONE row and one LLM call over
  /// the whole thing. Recovery is about getting the words back, not about
  /// re-running a transform the user asked for once, live.
  static const FlowMode kRecoveryMode = FlowMode.realtime;

  /// Look for retained audio and feed back whatever is owed.
  ///
  /// Safe to call at any time and from any edge: it returns immediately when a
  /// recovery is already running, when the link is down, or when there is
  /// nothing on disk.
  /// ⚠️ RETURNS THE IN-FLIGHT SWEEP when one is running, rather than a
  /// completed future. An awaiting caller therefore waits for the work to be
  /// done rather than for its own request to be discarded — which is what a
  /// test asserting 「after sweeping, the debt is gone」 needs to be true, and
  /// what a caller reading progress afterwards needs too.
  Future<void> sweep({required String sourceLang}) {
    final Future<void> queued =
        (_inFlight ?? Future<void>.value()).then((_) => _run(sourceLang));
    _inFlight = queued;
    return queued.whenComplete(() {
      // Only the LAST request clears the field; an earlier one finishing must
      // not un-queue the ones behind it.
      if (identical(_inFlight, queued)) _inFlight = null;
    });
  }

  Future<void> _run(String sourceLang) async {
    final RetainedAudioStore? store = _storeOf();
    if (store == null) return;
    await _publish(store, running: true);
    for (final String key in await store.pendingSessions()) {
      // The session currently being written to is LIVE audio, not a debt: a
      // recording in progress with the link down is still filling that file.
      if (key == store.sessionKey) continue;
      // Refused (no link, or a press is holding the session) ⇒ stop this pass.
      // The debt stays on disk and the next edge asks again.
      if (!await _replaySession(store, key, sourceLang)) break;
    }
    // 🔴 EXPLICITLY `running: false`, not `_inFlight != null` — that field is
    // still set here (it is cleared in the `whenComplete` that wraps this),
    // so deriving it would make the final publish say 「still working」 every
    // single time and the face would never come down.
    await _publish(store, running: false);
  }

  /// Recover one session's retained stretches. Returns false when the caller
  /// should stop trying for now (no link, a press in progress).
  Future<bool> _replaySession(
    RetainedAudioStore store,
    String key,
    String sourceLang,
  ) async {
    for (final int idx in await store.pendingSegments(session: key)) {
      // Per SEGMENT, not per session: each retained file is one outage (the
      // server's segment index freezes for the length of a gap and advances
      // when the link returns), so each one has its own start.
      final ArticleReplayTarget? target = _targetFor(key);
      final Uint8List? pcm = await store.read(idx, session: key);
      if (pcm == null || pcm.isEmpty) {
        // Nothing to recover, and nothing to keep. An empty retained file is
        // not audio anyone said.
        await store.settle(idx, session: key);
        continue;
      }
      final bool ok = await _replayOne(
        pcm: pcm,
        target: target,
        sourceLang: sourceLang,
      );
      if (!ok) return false;
      // 🔴 LAST, and only now: the words are rows. See the header. The
      // recorded gap start is dropped in the same breath and for the same
      // reason — it describes a stretch that no longer needs recovering.
      await store.settle(idx, session: key);
      _session.articles.dropStretchStart(key);
      await _publish(store, running: true);
    }
    return true;
  }

  /// One stretch: open, feed, close, wait for the words.
  Future<bool> _replayOne({
    required Uint8List pcm,
    required ArticleReplayTarget? target,
    required String sourceLang,
  }) async {
    if (target != null) _session.articles.beginReplay(target);
    if (!_session.beginBackfill(mode: kRecoveryMode, sourceLang: sourceLang)) {
      _session.articles.endReplay();
      return false;
    }
    final int frames = _session.feedBackfill(pcm);
    if (frames == 0) {
      // The wire refused everything — nothing was transcribed, so nothing may
      // be deleted. Put the FSM back and let the next sweep try again.
      _session.abortBackfill();
      _session.articles.endReplay();
      return false;
    }
    _session.endBackfill();
    // 🔴 THE CURSOR IS **NOT** CLOSED HERE ON SUCCESS, and that is not an
    // omission — see ArticleScribe.endReplay for what closing it cost. The
    // rows this recovery is for settle a microtask after the FSM comes to
    // rest, so a `finally` around this closes the cursor first and the
    // recovered sentences get filed at the end of the recording. It is closed
    // by the next press or the next recording, and nothing between those two
    // points can mint a row.
    return _awaitSettled();
  }

  /// Wait for the recovery utterance to finish producing rows.
  ///
  /// ⚠️ THE TIMEOUT IS NOT A GUESS ABOUT THE ENGINE, it is a bound on how long
  /// this object holds the single-flight latch. Expiring does NOT mean the
  /// stretch failed — the finals may still be arriving and still settling — so
  /// it returns false and leaves the bytes alone. A later sweep will find them
  /// again, which costs a second transcription and loses nothing; deleting on a
  /// timeout is the one choice here that could lose words.
  Future<bool> _awaitSettled() async {
    if (sessionAcceptsPttDown(_session.fsm.session)) return true;
    final Completer<bool> done = Completer<bool>();
    late final StreamSubscription<FlowmicStateSnapshot> sub;
    final Timer timer = Timer(_settleTimeout, () {
      if (!done.isCompleted) {
        diag('audio.backfill.settle_timeout', const <String, Object?>{});
        done.complete(false);
      }
    });
    sub = _session.fsm.changes.listen((FlowmicStateSnapshot s) {
      if (!done.isCompleted && sessionAcceptsPttDown(s.session)) {
        done.complete(true);
      }
    });
    try {
      return await done.future;
    } finally {
      timer.cancel();
      await sub.cancel();
    }
  }

  /// Where one retained session's rows belong, or null when nothing can say.
  ///
  /// 🔴 TWO SOURCES, AND NEITHER IS A DEFAULT OF ZERO.
  ///   · the recording is still running ⇒ the live clock already accounted for
  ///     the outage when the link returned, and knows where it started;
  ///   · the app was killed and this is an orphan ⇒ derive it from the rows
  ///     already filed under that article: the stretch begins where the last
  ///     row before it ended.
  /// When the key is not an article at all (an ordinary press's retained tail),
  /// there is no article and the recovered rows are ordinary rows — which is
  /// correct, and the reason this returns null rather than inventing one.
  ArticleReplayTarget? _targetFor(String sessionKey) {
    // 🔴 THE RECORDED ANSWER FIRST. The clock measured this gap at the one
    // instant it was measurable; the derivation below is a fallback for the
    // case where no clock was there to measure it, and using it when a
    // recorded answer exists puts the recovered sentences after the live
    // ones that followed them.
    final int? recorded = _session.articles.peekStretchStart(sessionKey);
    if (recorded != null) {
      return ArticleReplayTarget(
        articleId: sessionKey,
        stretchStartMs: recorded,
      );
    }
    final List<TimelineEntry> members =
        articleMembersOf(_timeline, sessionKey);
    if (members.isEmpty) {
      // No rows under this id: either it is not an article, or the outage
      // swallowed the whole recording. The second case starts at zero and IS
      // measurable — the article has no audio before this stretch.
      final int? accounted = _session.articles.articleId == sessionKey
          ? _session.articles.accountedMs
          : null;
      if (accounted == null) return null;
      return ArticleReplayTarget(
        articleId: sessionKey,
        stretchStartMs: accounted,
      );
    }
    int end = 0;
    for (final TimelineEntry m in members) {
      final int e = (m.articleOffsetMs ?? 0) + (m.durationMs ?? 0);
      if (e > end) end = e;
    }
    return ArticleReplayTarget(articleId: sessionKey, stretchStartMs: end);
  }

  Future<void> _publish(RetainedAudioStore store, {required bool running}) async {
    int bytes = 0;
    for (final String key in await store.pendingSessions()) {
      if (key == store.sessionKey) continue;
      bytes += await store.bytesForSession(key);
    }
    progress.value =
        BackfillProgress(pendingMs: pcmBytesToMs(bytes), running: running);
  }

  void dispose() => progress.dispose();
}
