// Part of chat_controller.dart — ONE UTTERANCE, from 「can this button be
// pressed」 through 「the transcript came back」 (Lane K, 2026-08-05).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat at 799 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800. Book 15 §6 G-20 names that cap, verbatim, as its own reason
// for staying unfixed: 「chat_controller.dart is right at 800/800 this very
// moment; adding one more field turns lint red」. This card ONLY unlocks the
// cap. It fixes nothing, adds nothing, renames nothing.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every member below is what it was in
// chat_controller.dart — declaration, doc comment and body — with exactly ONE
// mechanical edit, listed here so the claim stays checkable:
//   (1) inside a moved body, `notifyListeners()` became `notifyUi()`, because
//       `notifyListeners` is `@protected` and an extension is not a subclass.
//       `notifyUi`'s entire body is `=> notifyListeners()`. This is the same
//       edit chat_notices.dart and chat_mode_chip.dart declare in their own
//       headers, for the same reason.
// **Any diff beyond that one is a bug.**
//
// WHY AN `extension` AND NOT AN EIGHTH `xxxRouted` TOP-LEVEL FUNCTION: a
// `part of` file cannot reopen a class, so the seven older parts could carry
// only BODIES — the declaration and the doc comment above it had to stay
// behind. In this file the comments ARE the bulk, so that shape could not buy
// enough room; it would have turned 「exactly 799」 into 「exactly 749」.
// An extension carries declaration + comment + body in one move.
// ⚠️ THE PRICE, written down so nobody has to rediscover it: extension members
// are resolved STATICALLY and do NOT implement interfaces. Nothing required by
// AiComposeHost / ManualDeliveryHost / UtteranceComposeHost / OutboxDrainHost,
// no field, and neither the `notifyListeners` override nor `dispose` may ever
// move into a file like this one.
//
// WHY THIS SET AND NOT SOME OTHER SET: every member below reads or writes the
// one span of state that means 「an utterance is happening right now」 — `_sess`,
// the four per-utterance snapshots (master-plan §4.0 B fixed for each
// utterance), `recording`, and `_liveText`. Add one more per-utterance snapshot and all of
// them move together: `pttDown` writes it, `_mintClientId` numbers it, `canPtt`
// judges on it, the recording panel's three readouts show it, and the two
// 「this utterance will never produce a final」 terminals clear it.
//
// ⚠️ `pttCancel` keeps only its declaration here; its BODY is still in
// chat_transient_banner_timers.dart (Window C-5 moved it). That declaration/body
// split is INHERITED, not introduced by this card — this card does not touch
// any pre-existing part file.

part of 'chat_controller.dart';

extension ChatPttLifecycle on ChatController {
  /// The active row's text. While an utterance is being transformed this is
  /// the REAL partial LLM output (GA-01), not a spinner and not the source
  /// text — showing the source during a translate run would look exactly like
  /// the bug this card fixes.
  String get liveText =>
      utteranceCompose.isRunning && utteranceCompose.liveText.isNotEmpty
      ? utteranceCompose.liveText
      : _liveText;

  /// How many characters at the head of [liveText] the SERVER has already
  /// finalised — the black run; the rest is grey ("still being transcribed").
  ///
  /// 🔴 THE COLOUR MEANS THE SAME THING ON THE PC CAPSULE (2026-09-04). The
  /// model, the frame semantics it is derived from, and the shared fixture that
  /// pins the two ends together are documented in
  /// apps/desktop/src/capsule/utterance-view.ts; the phone half is
  /// [UtteranceView], a pure view over the SegmentBuffer that already assembles
  /// this text.
  ///
  /// ⚠️ FAIL-SAFE TO ALL GREY, never to all black. A compose run replaces
  /// [liveText] with partial LLM output, which is not a finalised transcript
  /// and must not be painted as one; and if the two strings ever stop lining up
  /// the honest answer is 「we do not know yet」. Grey claims nothing.
  int get liveCommittedChars {
    if (utteranceCompose.isRunning) return 0;
    final UtteranceView v = UtteranceView.of(session.segments);
    if (v.committed.isEmpty) return 0;
    final String t = _liveText;
    if (!t.startsWith(v.committed)) return 0;
    final int n = v.committedChars;
    return n <= t.length ? n : 0;
  }

  /// True while the LLM leg of a translate/organize utterance is in flight —
  /// the 「翻译中…」("translating…")/「整理中…」("organizing…") face and the held PTT button.
  bool get isProcessingUtterance => utteranceCompose.isRunning;

  /// The active row is visible while an utterance is live.
  ///
  /// Card RC4 — the user's own utterance: a recovery pass drives the same FSM
  /// states and is not one (ptt_backfill.dart `openSessionIsRecovery`). This
  /// also keeps its interims out of [liveText] and the segment readout
  /// (`onInterimRouted` opens with this check).
  bool get hasLiveDraft =>
      (_sess == SessionState.recording || _sess == SessionState.processing) &&
      !session.recoveryOwnsSession;

  /// Card RC4 — the session state as the USER's press sees it: a recovery
  /// pass on the wire reads as rest, because nobody is holding anything.
  /// [sessionState] keeps answering what the wire is doing; every surface
  /// that draws a press reads this one (chat_flow_composer.dart
  /// `_pttVisualRouted`, chat_flow_selection.dart, chat_flow_edit_sheet_sync.dart).
  SessionState get pressSessionState =>
      session.recoveryOwnsSession ? SessionState.idle : _sess;

  /// Card RC4 — a recovery pass holds the session and a press would be
  /// refused (the legacy segment leg cannot yield; ptt_backfill.dart
  /// `recoveryHoldsWire`). The button shows its busy face rather than a
  /// resting face that silently refuses the finger.
  bool get recoveryRefusesPress =>
      session.recoveryOwnsSession &&
      !sessionAcceptsPttDown(_sess) &&
      !session.recoveryHoldsWire;

  /// PTT down gate mirror for the UI (08 §2): active role + connected, and
  /// — GA-01 ruling 6 — no utterance still being transformed. Holding the button
  /// closed until the LLM settles is what keeps two utterances from injecting
  /// out of order, and it is the same thing 08 §5's 「FSM waits for
  /// compose:done」 asks for, expressed at the gate instead of as a second FSM
  /// latch (the FSM's 15 s net covers PTT-up→final; the compose watchdog covers
  /// start→terminal; they never overlap, so neither can double-fire).
  ///
  /// 🔴 NR-4-P1 (a): the session term is [sessionAcceptsPttDown], not a local
  /// `== idle` — this is a MIRROR of the FSM's own gate and a mirror that
  /// spells its own rule is a second author. The JUST_DONE window is now
  /// pressable; PROCESSING is not, and the reason it stays shut lives on that
  /// predicate.
  ///
  /// Follow-up (MAIN 2026-09-24): a recovery attempt holding the session does
  /// not close the button — it yields to the press (ptt_backfill.dart
  /// `yieldRecoveryForLive`).
  bool get canPtt =>
      _conn == ConnectionState.connected &&
      (sessionAcceptsPttDown(_sess) || session.recoveryHoldsWire) &&
      !utteranceCompose.isRunning;

  // ── recording panel truth (R6 T-5d) ──────────────────────────────────
  // Owned by RecordingTelemetry (recording_telemetry.dart); re-exposed here so
  // the page keeps reading one object. Every value is fed by a REAL source.

  /// Elapsed capture time for the ⏱ readout. Frozen once recording ends.
  Duration get recordingElapsed => recording.elapsed;

  /// Real dBFS history for the 📊 meter. Empty ⇒ no samples ⇒ the panel draws
  /// inert bars instead of faking motion.
  List<double> get amplitudeWindow => recording.amplitudeWindow;

  /// Soft segments observed on the wire this utterance (0 = none yet).
  int get observedSegments => recording.observedSegments;

  /// True while the recording panel should be up (§6.3: it opens on PTT-down
  /// and collapses on release).
  ///
  /// Card RC4 — a PRESS, not a recovery pass in RECORDING: Back must not
  /// stop it as the user's recording, and no panel opens for it.
  bool get isRecording =>
      _sess == SessionState.recording && !session.recoveryOwnsSession;

  /// Card CR-9 — the ceiling's one-minute reminder just fired.
  ///
  /// 🔴 IT ONLY REPAINTS, AND THAT IS THE WHOLE JOB. The fact itself is already
  /// recorded, by the clock that produced it (`ContinuousCapTimer.warningTicket`
  /// — its doc says why it lives there and not on this controller). What was
  /// missing is a nudge: the reminder is born inside a `Timer`, outside every
  /// notification this page listens to, so without this call the ticket goes up
  /// and no frame is ever built to read it.
  ///
  /// ⚠️ Deliberately NOT a second copy of the flag here. Two owners for 「is the
  /// reminder standing」 is this repo's oldest defect shape, and the auto-hide
  /// reconciler and the banner source both read the clock's.
  void noteContinuousCapWarning() => notifyUi();

  void _onAmplitude(double db) => onAmplitudeRouted(this, db);

  void _onAutoStopped(void _) => onAutoStoppedRouted(this);

  void _onSttStalled(SttStall stall) => onSttStalledRouted(this, stall);

  // ── PTT gestures ─────────────────────────────────────────────────────
  /// PTT down: snapshot the fixed delivery/mode/send-policy, mint the utterance
  /// id, and enter the data-layer chain. Returns false if the FSM refused.
  ///
  /// 🔴 PA-5 — [foldIntoBuffer]: the edit sheet's 「按住 追加」("hold to append")
  /// presses the SAME gate, the same FSM edge, the same chain — the ONLY
  /// difference is that the per-utterance policy snapshot is pinned to
  /// manual, because 「fold the
  /// finished text into the buffer」 IS what the manual snapshot already means
  /// (chat_utterance.dart's fold fork keys on `_activeSendPolicy`). Without
  /// the pin, an append started under DIRECT policy would deliver the new
  /// sentence straight to the PC instead of appending it to the draft being
  /// edited. Zero protocol change: `sendPolicy` is an existing frame field and
  /// `manual` a legal value; delivery remains client-driven either way.
  Future<bool> pttDown({bool foldIntoBuffer = false}) async {
    if (!canPtt) return false;
    // A fresh recording supersedes any stale auto-stop / stall notice —
    // 🔴 G-20: but only THIS screen's (§2.5.1: an action on this screen may
    // only retire this screen's conclusions). A notice parked on another
    // instance was never seen there; sweeping it from here would silently
    // swallow a failure (red-line F2's second direction).
    if (_autoStoppedOnScreen) {
      _autoStopped = false;
      _autoStoppedInstanceId = null;
    }
    if (_sttStalled != null && _noticeOnScreen(_sttStalledInstanceId)) {
      _sttStalled = null;
      _sttStalledInstanceId = null;
    }
    final String clientId = _mintClientId();
    _activeClientId = clientId;
    _activeDelivery = destination.delivery;
    _activeMode = _mode;
    // §4.0 B rhythm: the send policy is fixed for THIS utterance at audio:start,
    // exactly like delivery and mode. Flipping ➤/⚡ mid-sentence must not change
    // how the sentence already being spoken is delivered.
    _activeSendPolicy = foldIntoBuffer ? SendPolicy.manual : _sendPolicy;
    _liveText = '';
    recording.reset();
    // Follow-up — a grace still running for the previous live final must not
    // fire into this press's hold (it would let go of the wire for it).
    _owedTailGrace?.cancel();
    _owedTailGrace = null;
    final bool ok = await session.pttDown(
      mode: _activeMode,
      // Reading the value in place IS the snapshot (the one read point);
      // without this line, what ships is the parameter's default 'zh'.
      sourceLang: appSettings?.spokenLang ?? kSpokenLangDefault,
      delivery: _activeDelivery,
      sendPolicy: _activeSendPolicy,
      // Read in place, on the same line-for-line rule as `source_lang` above:
      // the bundle this utterance is transcribed under is the one this phone
      // holds NOW, so a switch flipped a second ago is already true here and no
      // reconnect is involved (owner ruling 2026-09-03 — the request is the
      // carrier). Null ⇒ `prefs` is omitted and the server defaults.
      prefs: phonePrefs?.call(),
    );
    if (!ok) {
      _activeClientId = null;
      // Follow-up — no press: whatever waited for the wire (a yielded
      // recovery, an owed tail's placement) gets it back.
      if (session.articles.hasPendingOwedTail) {
        _armLiveGrace(this);
      } else {
        _resumeHeldRecovery(this);
      }
    } else {
      // ⏱ starts at audio:start — the same edge the server times the 5-min cap
      // from (R6 T-5d).
      recording.start();
    }
    notifyUi();
    return ok;
  }

  /// Card RC-S follow-up (MAIN, 2026-09-24) — the signed-in account is about to
  /// change (`LoginController.onBeforeAccountChange`; its one production
  /// caller is main.dart).
  ///
  /// 🔴 THE USER'S OWN STOP, NOT A CANCEL: [pttUp] keeps what was said and
  /// settles it like any release. It is started, not awaited, because sign-out
  /// must never wait on anything (login_controller.dart `logout`, step 1) — and
  /// it does not need to: everything that makes the recording END happens in
  /// `PttSessionEdges.pttUp` before its first await (the residual chunk and
  /// `audio:stop` leave, the FSM leaves RECORDING), i.e. before this call
  /// returns and before the caller clears the account. The terminal final then
  /// arrives on the same socket, whose authentication a sign-out does not
  /// change (only a reconnect does), and with the recorder no longer running
  /// the ring replay refuses to send without a server session
  /// (`replayRefusalFor`).
  ///
  /// ⚠️ Codex r3 #3 — NOT ONLY `isRecording`. A continuous recording that has
  /// outlived its link keeps the microphone open with the FSM `disconnected`
  /// ([PttSession.continuousCapturingOffline]); [pttUp] is still the user's
  /// stop for it (its offline branch, `stopContinuousOffline`), so it is asked
  /// here too, or the microphone would outlive the account.
  ///
  /// 🔴 Card RC4 follow-up (MAIN 2026-09-25) — A RECOVERY PASS ON THE WIRE IS
  /// THROWN AWAY, NOT STOPPED. [isRecording] no longer answers yes for one
  /// (RC4), and a recovery left running across the change would keep feeding
  /// the outgoing account's audio into whatever session comes next — the RC-S
  /// cross-account hole. It leaves through the live-speech yield, the one
  /// existing way off the wire for an attempt (ptt_backfill.dart
  /// `yieldRecoveryForLive`): `audio:stop {discard}` goes out synchronously,
  /// before this returns and so before the caller clears the account; frames
  /// until its ack are dropped (`discardingYieldedFrames`); the leg returns
  /// the yield as a refusal, so no failure and no backoff are written and the
  /// range stays owed. Whether it runs again, and under whom, is the RC-S gate's
  /// answer (recovery_journal_leg.dart `_heldForAnotherAccount`), read when the
  /// next pass opens. The legacy segment leg cannot yield and carries no
  /// account, so ruling 4 already lets it run under whoever is signed in.
  ///
  /// 🔴 Card RC5 (Codex rc4 item 3) — AND ONE STILL PREPARING. An attempt that
  /// passed its account check and is awaiting its journal commit does not hold
  /// the wire yet, so there is nothing to yield; it is cancelled instead, by
  /// moving the ledger's account-change count it read when it began
  /// (`RecoveryAttemptLedger.accountChanges`). `_runOnWire` compares it, and
  /// asks the RC-S gate again, right before `audio:start`
  /// (recovery_leg_wire.dart).
  ///
  /// 🔴 Card RC6 (device rerun 5, criterion 3) — ANY ATTEMPT STILL IN FLIGHT,
  /// NOT ONLY ONE HOLDING THE WIRE, and the returned future is the discard
  /// stop's acknowledgement, which `LoginController` waits for (bounded)
  /// before it clears the account; null when nothing needs acknowledging.
  /// See `yieldRecoveryForAccountChange`.
  Future<void>? stopRecordingForAccountChange() {
    session.articles.attempts.accountChanging();
    final RecoveryAttemptLedger attempts = session.articles.attempts;
    if (attempts.wireAttemptInFlight) {
      diag('audio.backfill.yield_for_account_change', <String, Object?>{
        'attempt_id': attempts.wireAttemptId,
        'holds_wire': session.recoveryHoldsWire,
      });
      // While the caller waits for the acknowledgement the outgoing account is
      // still signed in: no attempt opens (RecoveryAttemptLedger
      // .accountChangeOpen). Lifted on the NEXT event-loop turn after the
      // acknowledgement, i.e. after the caller's continuation has cleared or
      // replaced the account; a timed-out wait leaves it up until the stop's
      // own timeout, which only delays a pass the RC-S gate decides anyway.
      attempts.accountChangeOpened();
      final Future<void> acked = session.yieldRecoveryForAccountChange();
      unawaited(acked.whenComplete(() => Timer.run(attempts.accountChangeSettled)));
      return acked;
    }
    if (!isRecording && !session.continuousCapturingOffline) return null;
    diag('ptt.stop_for_account_change', const <String, Object?>{});
    unawaited(pttUp());
    return null;
  }

  Future<void> pttUp() async {
    final int t0 = DateTime.now().millisecondsSinceEpoch;
    await session.pttUp();
    // F3: release → uplink (residual chunk + audio:stop leave inside pttUp).
    diag('latency.release_to_uplink_ms', <String, Object?>{
      'ms': DateTime.now().millisecondsSinceEpoch - t0,
    });
  }

  /// Swipe-up cancel: the utterance never completed → NO row is built (§4.0 A).
  /// Body: chat_transient_banner_timers.dart (Window C-5 800-line-cap move,
  /// VERBATIM — see that file's header).
  Future<void> pttCancel() => pttCancelRouted(this);

  String _mintClientId() =>
      'u${_utteranceSeq++}-${DateTime.now().microsecondsSinceEpoch}';

  // ── inbound STT ──────────────────────────────────────────────────────
  // Body: chat_transient_banner_timers.dart (same move as pttCancel above).
  void _onInterim(SttInterim p) => onInterimRouted(this, p);

  /// Terminal / soft-segment final → the utterance lifecycle (chat_utterance.dart).
  void _onFinal(SttFinal f) => _handleTerminalFinal(this, f);
}
