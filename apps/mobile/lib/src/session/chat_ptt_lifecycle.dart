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

  /// True while the LLM leg of a translate/organize utterance is in flight —
  /// the 「翻译中…」("translating…")/「整理中…」("organizing…") face and the held PTT button.
  bool get isProcessingUtterance => utteranceCompose.isRunning;

  /// The active row is visible while an utterance is live.
  bool get hasLiveDraft =>
      _sess == SessionState.recording || _sess == SessionState.processing;

  /// PTT down gate mirror for the UI (08 §2): active role + connected, and
  /// — GA-01 ruling 6 — no utterance still being transformed. Holding the button
  /// closed until the LLM settles is what keeps two utterances from injecting
  /// out of order, and it is the same thing 08 §5's 「FSM waits for
  /// compose:done」 asks for, expressed at the gate instead of as a second FSM
  /// latch (the FSM's 15 s net covers PTT-up→final; the compose watchdog covers
  /// start→terminal; they never overlap, so neither can double-fire).
  bool get canPtt =>
      _conn == ConnectionState.connected &&
      _sess == SessionState.idle &&
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
  bool get isRecording => _sess == SessionState.recording;

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
    final bool ok = await session.pttDown(
      mode: _activeMode,
      // Reading the value in place IS the snapshot (the one read point);
      // without this line, what ships is the parameter's default 'zh'.
      sourceLang: appSettings?.spokenLang ?? kSpokenLangDefault,
      delivery: _activeDelivery,
      sendPolicy: _activeSendPolicy,
    );
    if (!ok) {
      _activeClientId = null;
    } else {
      // ⏱ starts at audio:start — the same edge the server times the 5-min cap
      // from (R6 T-5d).
      recording.start();
    }
    notifyUi();
    return ok;
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
