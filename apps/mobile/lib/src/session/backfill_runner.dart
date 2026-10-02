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
// stretch once all its transcript rows have passed durable readback.
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
// step. Only existing, unconfirmed results mark a segment unverified; transient
// failures retain main's next-sweep retry behavior without such a marker.
// PendingRecoveryStore lists marked results as settledUnverified for deletion.
// Empty recognition retains main's existing disposal behavior (no rows to lose).

import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data' show BytesBuilder; // NR-137 round 3 (backfill_legacy_kept)

import 'package:flutter/foundation.dart';

import '../audio/article_replay.dart';
import '../audio/retained_audio_spill.dart';
import '../audio/retained_audio_store.dart';
import '../diag/diag_log.dart';
import '../ptt/ptt_session.dart';
import '../settings/phone_prefs_payload.dart';
import '../signaling/state_machine.dart';
import '../signaling/wire_payloads.dart' show FlowMode;
import '../stt/segment_buffer.dart';
import '../timeline/article.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import '../timeline/timeline_verified_reads.dart' show TimelineReleaseClaim;
import '../timeline/timeline_write_gate.dart';
import 'article_replay_target.dart';
import 'backfill_progress.dart';
export 'backfill_progress.dart';
import 'instance_probe.dart' show ServerChannel;
import 'kept_words_retranscribe.dart';
import 'legacy_recovery_identity.dart';
import 'legacy_retry_budget.dart';
import 'pending_recovery.dart'
    show PendingRetryOutcome, PendingRecoveryItem, PendingRecoveryState;
import 'recovery_gate.dart';
import 'recovery_identity.dart' show RecoveryAttemptKind;
import 'recovery_journal_leg.dart';
import 'recovery_retry_timer.dart';

// NR-138 — the legacy segment leg, with its retry budget (that header says why
// it is a part).
part 'backfill_legacy_leg.dart';
part 'backfill_legacy_kept.dart'; // NR-137 round 2

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
    PhonePrefsSource? phonePrefs,
    Duration settleTimeout = const Duration(seconds: 20),
    // Card RC-1a - the journal leg's own seams, passed through so a test can
    // drive a fake filesystem and clock without this class knowing how.
    LegacyServerVerifier legacyVerifier = const DenyAllLegacyServerVerifier(),
    RecoveryTimeouts recoveryTimeouts = const RecoveryTimeouts(),
    int Function()? clock,
    String Function()? newId,
    bool Function()? metered,
    Future<void> Function(Duration)? sleep,
    // Card RC-O — how the due-time retry is scheduled (a test fires it by hand).
    Timer Function(Duration, void Function())? retryTimer,
  })  : _retryTimerFactory = retryTimer,
        _session = session,
        _timeline = store,
        _storeOf = storeOf ?? (() => session.audio.retainedAudio?.store),
        _phonePrefs = phonePrefs,
        _settleTimeout = settleTimeout,
        _legacyVerifier = legacyVerifier,
        _recoveryTimeouts = recoveryTimeouts,
        _clock = clock,
        _newId = newId,
        _metered = metered,
       _sleep = sleep {
    _session.articles.attempts.recoveringArticle.addListener(_recoveryChanged);
  }

  void _recoveryChanged() {
    if (!_disposed) {
      progress.value = progress.value.withRecoveringArticle(
        _session.articles.attempts.recoveringArticle.value,
      );
    }
  }

  final PttSession _session;
  final TimelineStore _timeline;
  final RetainedAudioStore? Function() _storeOf;

  /// The phone-owned preference bundle for the recovery utterances this runner
  /// opens — the SAME source a live press reads (see `beginBackfill`'s
  /// `prefs`). Production wires it through `ChatController`; null sends no
  /// `prefs` and lets the server default, which is what an un-wired test does.
  final PhonePrefsSource? _phonePrefs;
  final Duration _settleTimeout;
  final LegacyServerVerifier _legacyVerifier;
  final RecoveryTimeouts _recoveryTimeouts;
  final int Function()? _clock;
  final String Function()? _newId;
  final bool Function()? _metered;
  final Future<void> Function(Duration)? _sleep;
  final Timer Function(Duration, void Function())? _retryTimerFactory;

  /// Card RC-O — wakes the queue when the earliest backoff runs out
  /// (recovery_retry_timer.dart says why an edge is not enough).
  late final RecoveryRetryTimer _retry = RecoveryRetryTimer(
    onDue: _onRetryDue,
    clock: _clock,
    timer: _retryTimerFactory,
  );
  String? _retrySourceLang;

  /// Card RC-O — only into an idle session on a live link; otherwise the link
  /// and recording-end edges sweep anyway.
  void _onRetryDue() {
    final String? lang = _retrySourceLang;
    final bool go = !_disposed &&
        lang != null &&
        linkConnected &&
        sessionAcceptsPttDown(_session.fsm.session);
    diag('audio.recovery.retry_due', <String, Object?>{'sweep': go});
    if (go) unawaited(sweep(sourceLang: lang));
  }

  /// Card RC-O — arm for the earliest due retry. Called at the end of a pass,
  /// inside the latch: the scan may republish a manifest (it writes).
  ///
  /// ⚠️ 更正（Codex rc3 ⑦，2026-09-24）：原为 due times after the clock read HERE.
  /// A deadline that passed while the pass was scanning was then excluded: the
  /// pass had skipped the recording as not yet due, and no timer was armed for
  /// it. [passStartedMs] is read before the pass checks anything, so every
  /// deadline the pass could not have honoured is still armed (at once, when
  /// it has already passed); one it did see as due was the pass's to try.
  ///
  /// NR-138 ② — and for the legacy leg's earliest due time as well, by the
  /// same rule. ⚠️ 更正: this used to return early when the spill was not on
  /// the journal face, so a legacy-only phone never armed anything; the
  /// legacy half is armed whichever face is on.
  Future<void> _armRetry(RetainedAudioStore store, String sourceLang,
      {required int passStartedMs}) async {
    if (_disposed) return;
    final RetainedAudioSpill? spill = _session.audio.retainedAudio;
    final int? journal = spill == null || !spill.retainFromFirstFrame
        ? null
        : await RecoveryRetryTimer.earliestDueMs(spill, passStartedMs);
    final int? legacy = await _legacyEarliestDueMs(store, passStartedMs);
    if (_disposed) return;
    _retrySourceLang = sourceLang;
    _retry.arm(journal == null || legacy == null
        ? journal ?? legacy
        : math.min(journal, legacy));
  }

  int _nowMs() => (_clock ?? () => DateTime.now().millisecondsSinceEpoch)();

  /// NR-138 ① — who THIS runner is when it reserves a legacy attempt, and
  /// which session its one attempt is out on (single-flight, so at most one).
  /// Only that reservation is in flight; any other one a reader finds is an
  /// attempt whose ending was never written.
  final String _legacyOwner =
      'r-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
      '-${(_ownerSeq++).toRadixString(36)}';
  static int _ownerSeq = 0;
  String? _legacyInFlight;

  /// Legacy sessions whose retry record this runner could not write.
  final Set<String> _legacyUnwritable = <String>{};

  static int _idSeq = 0;

  /// NR-138 ③ — an attempt / operation id for the legacy leg: the injected
  /// seam when a test provides one, otherwise a time-and-counter string (the
  /// journal leg's default shape).
  String _mintId() =>
      (_newId ??
          () => '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
              '-${(_idSeq++).toRadixString(36)}')();

  /// 🔴 A7-3's 「can an account be charged here」, ONE answer for both legs:
  /// the journal leg is built with this same function. NULL (not probed yet)
  /// reads as metered — the fail-closed direction.
  bool Function() get _meteredFn =>
      _metered ?? () => _session.serverChannel.value != ServerChannel.lan;

  /// NR-138 ③ — may the legacy leg send at all right now? Evaluated the way
  /// the journal leg evaluates its tier (same parsed ack, same metered
  /// answer, same verifier), so the capability rules have one author.
  LegacyRecoveryGate get legacyGate =>
      legacyRecoveryGateOf(evaluateRecoveryGate(
        caps: _session.reconnect.serverCapabilities,
        metered: _meteredFn(),
        verifier: _legacyVerifier,
      ));

  /// Card RC-1a - THE JOURNAL LEG, built once and only when the spill is
  /// actually running the journal face.
  ///
  /// 🔴 IT IS A SECOND SOURCE, NOT A SECOND QUEUE (audit A6: 「do not build a
  /// second recovery system」). The single-flight latch, the live-press gate and
  /// the progress value all stay here; the leg answers 「what does the journal
  /// owe and what happens to it」 and is only ever entered from inside [_run].
  ///
  /// Null only when there is no retained-audio layer at all, or when the spill
  /// was built with `retainFromFirstFrame: false`. ⚠️ THAT IS NO LONGER THE
  /// SHIPPING DEFAULT: `retained_audio_boot.dart`'s
  /// `kRetainFromFirstFrameDefault` is `true` (card RC-1, 2026-09-06), so every
  /// build reaches this leg and the legacy segment loop below now only ever
  /// finds audio written by an OLDER build.
  RecoveryJournalLeg? get journalLeg {
    final RetainedAudioSpill? spill = _session.audio.retainedAudio;
    if (spill == null || !spill.retainFromFirstFrame) return null;
    // Card RC-N — a failed attempt's late settle writes the manifest too, so it
    // queues behind whatever this runner is doing (one writer at a time).
    _session.articles.attempts.serialize = _runExclusive;
    return _journalLeg ??= RecoveryJournalLeg(
      session: _session,
      timeline: _timeline,
      spill: spill,
      phonePrefs: _phonePrefs,
      legacyVerifier: _legacyVerifier,
      timeouts: _recoveryTimeouts,
      // 🔴 THE SPILL'S OWN SEAM, not a second one: recovery must read the
      // journal through the filesystem the capture wrote it through.
      fs: spill.journalFs,
      clock: _clock,
      newId: _newId,
      // 🔴 A7-3 asks for `recovery.idempotent_operation` only where an account
      // can be charged. The channel probe answers that; NULL (not yet probed)
      // reads as metered, which is the fail-closed direction - guessing
      // 「standalone」 would drop the requirement on the deployment where getting
      // it wrong costs the user money. NR-138: the legacy leg reads the same
      // function ([_meteredFn]).
      metered: _meteredFn,
      sleep: _sleep,
    );
  }

  RecoveryJournalLeg? _journalLeg;
  RecoveryLegOutcome _lastLegOutcome = RecoveryLegOutcome.none;

  /// NR-137 — the user presses queued or running, by recording (see
  /// [retranscribe]).
  final Map<String, Future<PendingRetryOutcome>> _pressesInFlight =
      <String, Future<PendingRetryOutcome>>{};

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

  /// Card RC-1b - THE SEAMS THE PENDING-RECOVERY SCREEN READS THROUGH.
  ///
  /// They are getters on this object rather than a second reader of the same
  /// disk because this class already holds every one of them, and a screen
  /// that re-derived "which store", "which spill" or "is a press running"
  /// would be a second author of each answer. `pending_recovery_store.dart`
  /// is the only consumer.
  RetainedAudioStore? get retainedStore => _storeOf();

  RetainedAudioSpill? get retainedSpill => _session.audio.retainedAudio;

  /// Which A7-3 class the LAST journal pass put the server in, or null when no
  /// pass has evaluated one. Not re-evaluated here: asking the gate a second
  /// time is how two answers appear (recovery_gate.dart's own rule).
  RecoveryTier? get lastServerTier => _lastLegOutcome.tier;

  /// NR-137 — which of [articleIds] a re-transcription of kept words can
  /// REPLACE, asked of THIS runner's timeline (the one the leg replaces rows
  /// in), so the list and the press read one answer
  /// (`kept_words_retranscribe.dart`).
  Future<Set<String>> replaceableKeptWordArticles(Set<String> articleIds) =>
      replaceableArticles(_timeline, articleIds);

  /// NR-137 round 2 — would a press be metered here? The same A7-3 answer
  /// both legs use ([_meteredFn]; NULL, not yet probed, reads as metered).
  bool get pressIsMetered => _meteredFn();

  /// Whether the microphone is open right now.
  ///
  /// A COURTESY FOR THE SCREEN, NOT A GATE. The authority is
  /// `PttSession.beginBackfill`, which refuses and reports
  /// [PendingRetryOutcome.refusedBusy]; this getter only lets the button be
  /// absent instead of present-and-doomed while a recording is running.
  bool get recordingNow => _session.fsm.session == SessionState.recording;

  /// Card WB-6 — is there a link a recovery could be started on?
  ///
  /// THE SAME FIELD `beginBackfill` REFUSES ON, read through the same object,
  /// so the screen cannot disagree with the gate about what it is looking at.
  /// It is still only a courtesy: the gate is asked again, later, for real.
  bool get linkConnected =>
      _session.fsm.connection == ConnectionState.connected;

  /// Card RC-1b (audit A6 R-2) - the user asked for one recording to be tried
  /// again, now.
  ///
  /// QUEUED THROUGH THE SAME LATCH AS [sweep], and that is the whole reason
  /// this method is here rather than on the leg: one stretch at a time is the
  /// property the runner's header calls load-bearing, and a button that
  /// bypassed it would put two `audio:start` frames on one socket - a
  /// corruption nothing downstream can detect. A press therefore waits behind
  /// whatever sweep is in flight, exactly like a third edge would.
  ///
  /// The returned future is THIS request's, not the queued sweep's: an
  /// awaiting caller (the screen, which then re-reads its list) must not be
  /// told "done" about somebody else's pass - the same mistake `sweep`'s own
  /// header records as measured.
  ///
  /// NR-138 ④ — [legacy]: [recordingId] is a LEGACY session key, and the
  /// press goes to that session's segments only
  /// (`backfill_legacy_leg.dart` `_retranscribeLegacy`), through this same
  /// latch. NR-137's re-transcription of `settled_unverified` audio would
  /// enter here too, for both faces, once its design decides what happens to
  /// the rows already saved.
  /// ⚠️ 更正（NR-137, 2026-10-02）: it enters here for the JOURNAL face only
  /// (`legacy: false` → `RecoveryJournalLeg.runOne`), and only for an article
  /// whose earlier rows can be replaced (`kept_words_retranscribe.dart`).
  /// Legacy unverified segments stay delete-only: nothing records which rows
  /// they produced (design `_dispatch/2026-10-02-nr137-design.md` §1).
  ///
  /// NR-137 — 🔴 A SECOND PRESS ON THE SAME RECORDING JOINS THE FIRST. Each
  /// press is metered (O-4), and a request queued behind one still running
  /// would start a second billed attempt as soon as the first left the card
  /// in place (an unproven or empty answer does). The page hides the buttons
  /// while a press is in flight; this is the lock behind that courtesy.
  Future<PendingRetryOutcome> retranscribe({
    required String recordingId,
    required String sourceLang,
    bool legacy = false,
  }) {
    final String pressKey = '${legacy ? 'l' : 'j'}:$recordingId';
    final Future<PendingRetryOutcome>? joining = _pressesInFlight[pressKey];
    if (joining != null) {
      diag('audio.recovery.user_retry_joined', <String, Object?>{
        'recording_id': recordingId,
      });
      return joining;
    }
    final Completer<PendingRetryOutcome> out =
        Completer<PendingRetryOutcome>();
    _pressesInFlight[pressKey] = out.future;
    unawaited(out.future
        .whenComplete(() => _pressesInFlight.remove(pressKey)));
    final Future<void> queued =
        (_inFlight ?? Future<void>.value()).then((_) async {
      try {
        out.complete(legacy
            ? await _retranscribeLegacy(recordingId, sourceLang)
            : await _retranscribe(recordingId, sourceLang));
      } on Object catch (e) {
        // A throw here would leave the caller awaiting a future nobody ever
        // completes - a screen frozen on a spinner, which is the silent
        // failure the red line forbids in the "said nothing" direction.
        diag('audio.recovery.user_retry_threw', <String, Object?>{
          'recording_id': recordingId,
          'error': '$e',
        });
        out.complete(PendingRetryOutcome.failed);
      }
    });
    _inFlight = queued;
    queued.whenComplete(() {
      if (identical(_inFlight, queued)) _inFlight = null;
    });
    return out.future;
  }

  Future<PendingRetryOutcome> _retranscribe(
      String recordingId, String sourceLang) async {
    final RecoveryJournalLeg? leg = journalLeg;
    // No journal face on this build: there is nothing this entry point can
    // drive. Said as its own answer rather than as a failure, because nothing
    // failed - `pending_recovery_store.dart` only ever offers the button for
    // journal recordings, so this arm is the defensive one.
    // ⚠️ 更正（NR-138）: the store now offers it for legacy sessions too, and
    // routes those with `legacy: true` to `_retranscribeLegacy` instead.
    if (leg == null) return PendingRetryOutcome.unavailable;
    final RetainedAudioStore? store = _storeOf();
    if (store != null) await _publish(store, running: true);
    try {
      return await leg.runOne(
        recordingId: recordingId,
        fallbackSourceLang: sourceLang,
      );
    } finally {
      // The counts on the face are stale the moment an attempt lands, and the
      // screen reads them; republishing here is what takes a settled recording
      // off the banner as well as out of the list.
      if (store != null) await _publish(store, running: false);
    }
  }

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

  /// Card RC-N — any other journal writer, queued through the same latch, then
  /// one ordinary pass so the counts on the face (and the RC-O timer) are
  /// re-read after it: a late settle that left the page saying 「still being
  /// transcribed」 would be the stale-face shape `_retranscribe` guards against.
  Future<void> _runExclusive(Future<void> Function() work) {
    final Future<void> queued =
        (_inFlight ?? Future<void>.value()).then((_) async {
      if (_disposed) return;
      await work();
      final String? lang = _retrySourceLang;
      if (lang != null) await _run(lang);
    });
    _inFlight = queued;
    return queued.whenComplete(() {
      if (identical(_inFlight, queued)) _inFlight = null;
    });
  }

  Future<void> _run(String sourceLang) async {
    if (_disposed) return;
    final RetainedAudioStore? store = _storeOf();
    if (store == null) return;
    await _publish(store, running: true);
    final int passStartedMs = _nowMs(); // Codex rc3 ⑦ — see `_armRetry`
    // 🔴 THE JOURNAL LEG GOES FIRST, AND THE ORDER IS NOT ARBITRARY: when the
    // journal face is on, the segment store is not being written at all (see
    // retained_audio_spill.dart's header - the two faces never store the same
    // audio), so anything the legacy loop below finds is a leftover from an
    // OLDER build. Recovering today's debt before yesterday's is the ordering
    // a user would choose.
    final RecoveryJournalLeg? leg = journalLeg;
    if (leg != null) {
      _lastLegOutcome = await leg.run(
        fallbackSourceLang: sourceLang,
        onScanned: (RecoveryLegOutcome debt) async {
          _lastLegOutcome = debt;
          await _publish(store, running: true);
        },
      );
      if (_lastLegOutcome.stopEarly) {
        await _armRetry(store, sourceLang, passStartedMs: passStartedMs);
        await _publish(store, running: false);
        return;
      }
    }
    // NR-138 — the legacy loop and its budget live in backfill_legacy_leg.dart.
    await _runLegacy(store, sourceLang);
    // RC-O — armed at the END of the pass, after both legs (NR-138 ②: the
    // legacy leg's due times are armed by the same timer).
    await _armRetry(store, sourceLang, passStartedMs: passStartedMs);
    // 🔴 EXPLICITLY `running: false`, not `_inFlight != null` — that field is
    // still set here (it is cleared in the `whenComplete` that wraps this),
    // so deriving it would make the final publish say 「still working」 every
    // single time and the face would never come down.
    await _publish(store, running: false);
  }

  /// NR-138 — the state the pending page and the article give one LEGACY
  /// session. ONE author: [_publish] and `PendingRecoveryStore._addLegacy`
  /// both ask this, so the banner and the list cannot disagree.
  Future<PendingRecoveryState> legacyStateOf(
          RetainedAudioStore store, String key) =>
      _legacyStateIn(store, key);

  /// Where one retained session's rows belong — card RC-3 moved the body,
  /// unchanged, to session/article_replay_target.dart so the journal leg asks
  /// the same question the same way (see that file's header).
  ArticleReplayTarget? _targetFor(String sessionKey) => articleReplayTargetFor(
        articles: _session.articles,
        timeline: _timeline,
        sessionKey: sessionKey,
      );

  Future<void> _publish(RetainedAudioStore store, {required bool running}) async {
    // 🔴 A SWEEP OUTLIVES THE CONTROLLER THAT STARTED IT. Every call site is
    // `unawaited(...)` (chat_outbox_host.dart, CR-5 edges 1 and 2), so
    // `disposeRouted` can run while `_run` is parked on an `await` two frames
    // down. Publishing then writes a disposed `ValueNotifier`, which is an
    // assertion in debug and an error nobody catches in release.
    //
    // MEASURED 2026-09-06 (this box, 32 cores): `test/live_settle_test.dart`
    // failed 1 of 5 standalone runs on exactly that, with
    // 「A ValueNotifier<BackfillProgress> was used after being disposed」 from
    // `_publish` under `sweep` in the tearDown, and the rig's temp directory
    // then refused to delete (errno 32) because the leg still held the
    // journal. Whether the sweep is still in flight when the teardown lands is
    // a race with the machine, which is why this reads as flakiness rather
    // than as the plain defect it is.
    //
    // 🔴 THE CHECK THAT COUNTS IS THE ONE AFTER THE LAST `await`, NOT THE ONE
    // AT THE TOP. Measured while writing case (2) of
    // `test/backfill_channel_test.dart`'s dispose case: an entry guard alone
    // is green for a sweep disposed before it starts and RED for one parked
    // on the directory read below, which is the ordering the flake actually
    // took. The early return stays because it saves the reads; the guard
    // immediately before the write is the one that makes the claim.
    if (_disposed) return;
    int bytes = 0;
    int unverified = 0;
    int legacyManual = 0; // NR-138 ④
    // Card RC-G — per session key: legacy bytes (all outage, see below) and
    // the journal leg's own split.
    final Map<String, (int, int, bool, PendingRecoveryItem?)> perKey =
        <String, (int, int, bool, PendingRecoveryItem?)>{};
    for (final String key in
        await store.pendingSessions(includeUnverified: true)) {
      if (key == store.sessionKey) continue;
      final bool kept = (await store.unverifiedSegments(key)).isNotEmpty;
      if (kept) unverified++;
      final int b = await store.bytesForSession(key, pendingOnly: true);
      bytes += b;
      // NR-138 — the state has one author ([legacyStateOf]); 「waiting」 only
      // while the persisted budget can still redeem it.
      final PendingRecoveryState state = await _legacyStateIn(store, key);
      if (state == PendingRecoveryState.needsManual) legacyManual++;
      final (int, int, bool, PendingRecoveryItem?) was =
          perKey[key] ?? (0, 0, false, null);
      perKey[key] = (
        was.$1 + b,
        was.$2 + b,
        b > 0 && state == PendingRecoveryState.waitingAuto,
        PendingRecoveryItem(
          id: key,
          state: state,
          durationMs: pcmBytesToMs(await store.bytesForSession(key)),
          legacy: true,
        ),
      );
    }
    for (final MapEntry<String, SessionDebtBytes> e
        in _lastLegOutcome.bySession.entries) {
      final (int, int, bool, PendingRecoveryItem?) was =
          perKey[e.key] ?? (0, 0, false, null);
      perKey[e.key] = (
        was.$1 + e.value.pendingBytes,
        was.$2 + e.value.outageBytes,
        was.$3 || e.value.waitingAuto,
        was.$3 ? was.$4 : e.value.recoveryItem,
      );
    }
    if (_disposed) return;
    progress.value = BackfillProgress(
      recoveringArticleId: _session.articles.attempts.recoveringArticle.value,
      byArticle: <String, ArticleBackfill>{
        for (final MapEntry<String, (int, int, bool, PendingRecoveryItem?)> e
            in perKey.entries)
          if (e.value.$1 > 0 || e.value.$4?.legacy == true)
            e.key: ArticleBackfill(
              waitingAuto: e.value.$3,
              recoveryItem: e.value.$4,
              pendingMs: pcmBytesToMs(e.value.$1),
              fromOutage: e.value.$2 > 0,
            ),
      },
      pendingMs: pcmBytesToMs(bytes + _lastLegOutcome.pendingBytes),
      // Card LK-3 — legacy bytes count as an outage because that face only
      // fills during one; the journal face reports its own.
      pendingFromOutage: bytes > 0 || _lastLegOutcome.outagePendingBytes > 0,
      running: running,
      serverTier: _lastLegOutcome.tier,
      needsManual: _lastLegOutcome.needsManual + legacyManual,
      settledUnverified: _lastLegOutcome.settledUnverified + unverified,
    );
  }

  /// Releases the progress notifier and closes this runner to further
  /// publishing. It does NOT cancel an in-flight sweep: the recovery leg's own
  /// writes are the thing that must not be interrupted half-way (a torn
  /// journal is worse than a wasted pass), so the sweep is allowed to finish
  /// and simply stops being able to say so. `_publish` carries the reason.
  void dispose() {
    // ⚠️ IDEMPOTENT. `ValueNotifier.dispose` throws on a second call, and
    // this object has two disposers in practice: `ChatController.dispose` owns
    // the one it built, and a caller that wants the runner silenced earlier
    // (a test rig keeping the recovery leg out of a live-path measurement)
    // reaches the same method. Closing twice must be a no-op, not a crash in
    // somebody's teardown.
    if (_disposed) return;
    _disposed = true;
    _session.articles.attempts.recoveringArticle.removeListener(
      _recoveryChanged,
    );
    _retry.cancel(); // RC-O
    progress.dispose();
  }

  bool _disposed = false;
}
