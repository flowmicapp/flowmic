// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §2 (PTT FSM: DISCONNECTED → IDLE →
//     RECORDING → PROCESSING → JUST_DONE(1500ms) → IDLE; illegal transitions
//     ignored, never thrown; RECORDING+PROCESSING coexistence forbidden;
//     3 s sessionDropGrace bridges sub-second wire blips, server keeps 30 s;
//     the PROCESSING safety net, 15s — GA-03)
//
// FlowmicStateMachine fuses the connection-level state machine (DISCONNECTED →
// CONNECTING → CONNECTED ↔ RECONNECTING) with the inner per-pairing session
// state machine (IDLE / RECORDING / PROCESSING / JUST_DONE). Forbidden
// transitions are *ignored* (no-op) rather than thrown — the UI may issue racy
// callbacks during gesture overlap; the spec forbids the coexistence but does
// not require a crash.
//
// Ported from legacy signaling/state_machine.dart (behaviour byte-identical).

import 'dart:async';

import 'package:meta/meta.dart';

import 'socket_core.dart';

enum ConnectionState { disconnected, connecting, connected, reconnecting, error }

enum SessionState { disconnected, idle, recording, processing, justDone }

/// 🔴 NR-4-P1 (a) — THE ONE AUTHOR of 「may a fresh PTT-down start from here」.
///
/// Four layers ask this question on every press — [PttBar] (is the bar even
/// enabled), `ChatController.canPtt` (the UI mirror), `PttSession.pttDown`
/// (the data-layer gate) and [FlowmicStateMachine.onPttDown] (the transition
/// itself). They each used to spell `== SessionState.idle` on their own, which
/// is four answers to one question and is exactly how this repo's headline bug
/// shape starts. They read this instead.
///
/// JUST_DONE is admitted because it is a VISUAL FACE and nothing else: a green
/// ✓ held for 1500 ms after a final has already landed. The utterance it
/// confirms is over — the row is minted, the delivery has been handed off — so
/// there is nothing for a new hold to collide with, while the previous
/// behaviour spent that window refusing presses and the ledger measured the
/// cost as 「说完被锁 ~1.5s+」 (NR-4 row a): continuous dictation was chopped up
/// by a face.
///
/// 🔴 THE BOUNDARY THIS CARD DELIBERATELY DOES NOT CROSS: **PROCESSING stays
/// closed.** That window is not cosmetic — capture has ended and the terminal
/// `stt:final` for the previous utterance has not arrived, so a second hold
/// there means two utterances in flight at once, which is the coexistence
/// 08 §2 forbids and which decides ORDERING of what lands in the PC's focus
/// window. Opening it is a state-machine question (who owns the pending
/// final, what the compose watchdog covers, whether the outbox can reorder)
/// and needs its own card plus a real-device measurement, not a widened
/// predicate. See the NR-4 ledger §4 P1 ① for the same boundary in the owner's
/// words.
bool sessionAcceptsPttDown(SessionState s) =>
    s == SessionState.idle || s == SessionState.justDone;

/// Why PROCESSING was closed WITHOUT a terminal stt:final (GA-03). The two
/// causes read differently to the user —「nothing came back」 vs 「the engine
/// said it broke」 — so they travel as distinct reasons rather than one blob.
enum SttStallReason {
  /// The local safety net fired: no terminal stt:final within processingTimeout.
  timeout,

  /// The server said the utterance is dead (stt:error with retryable:false).
  engineError,

  /// owner 2026-07-27: the terminal stt:final ARRIVED and carried no text.
  /// Nothing was wrong with the pipeline — the engine simply heard nothing — but
  /// the utterance still produced no row, and the old code returned silently
  /// (chat_utterance.dart) so the 「转录中」("transcribing") draft just
  /// vanished. To the user that
  /// is indistinguishable from a crash: they held the button, spoke, released,
  /// and the app said nothing at all. No silent failure applies to「什么都没听到」
  /// ("nothing was heard at all") too.
  emptyTranscript,

  /// owner 2026-07-27: the platform recorder accepted start(), reported no
  /// error, drove the whole recording UI — and delivered ZERO bytes. Measured on
  /// the tablet: red PTT bar, running timer, and `audio intake {"chunks":0}` on
  /// the server. This is NOT [emptyTranscript]: the engine never got the chance
  /// to hear anything, so telling the user to「靠近麦克风再说一次」("move closer
  /// to the mic and say it again") sends them to
  /// repeat themselves into a microphone that never opened.
  captureDead,
}

/// ENG-3 (fix-030) — the stall EVENT: the reason plus, for [SttStallReason
/// .engineError], the wire `code`/`message` the server's `stt:error` frame
/// carried.
///
/// WHY THIS EXISTS. On the P0 「LAN empty transcript」 runs the server sent an
/// honest, NAMED terminal `stt:error` (`STT_CONFIG_MISSING` — the sherpa addon
/// is not shipped in the 0.2.61 payload), and the phone rendered 「没有听到语音」
/// ("no speech was heard").
/// One of the two breaks was here: the stall stream carried a bare enum, so by
/// the time the banner layer asked 「which engine error?」 the answer had been
/// thrown away in `ptt_inbound.dart` (ENG cards, load-bearing fact #6). The
/// judging layer must HOLD the facts it judges on (R11) — so the event now
/// carries them.
///
/// `code`/`message` are non-null only when the stall came from a terminal
/// `stt:error`; a timeout / empty transcript / dead capture has no wire frame
/// to quote and inventing one would be the exact defect the other direction.
@immutable
class SttStall {
  /// Which wall was hit — same enum, same four values as before.
  final SttStallReason reason;

  /// The `stt:error` frame's `code`, verbatim off the wire (a protocol
  /// registry identifier such as `STT_CONFIG_MISSING`). Null when this stall
  /// was not produced by an `stt:error` frame.
  final String? code;

  /// The frame's `message` — the ENGINE'S own sentence (e.g. "sherpa-local
  /// open failed: Cannot find module 'sherpa-onnx-node'"). Kept verbatim for
  /// diagnostics; the banner renders the phone's own string table, never this.
  final String? message;

  /// WP-9 (2026-09-02) — the `stt:error` frame's additive `judged_account`
  /// field, verbatim off the wire (`'self'` | `'pc_owner'`). Only meaningful
  /// for `code == 'QUOTA_EXCEEDED'` (card QTA-2 checks two ledgers); null on
  /// every other code, and null on a server that predates this field — which
  /// [recording_strings.dart]'s `sttStallBannerMessage` reads as `'self'` (the
  /// pre-existing sentence), never as a third, unlabelled state.
  final String? judgedAccount;

  const SttStall(this.reason, {this.code, this.message, this.judgedAccount});

  @override
  bool operator ==(Object other) =>
      other is SttStall &&
      other.reason == reason &&
      other.code == code &&
      other.message == message &&
      other.judgedAccount == judgedAccount;

  @override
  int get hashCode => Object.hash(reason, code, message, judgedAccount);

  @override
  String toString() =>
      'SttStall(${reason.name}${code == null ? '' : ', code=$code'})';
}

@immutable
class FlowmicStateSnapshot {
  final ConnectionState connection;
  final SessionState session;
  const FlowmicStateSnapshot({
    required this.connection,
    required this.session,
  });

  @override
  bool operator ==(Object other) =>
      other is FlowmicStateSnapshot &&
      other.connection == connection &&
      other.session == session;

  @override
  int get hashCode => Object.hash(connection, session);

  @override
  String toString() => 'FlowmicState(conn=$connection, sess=$session)';
}

/// Records every refused transition so tests can assert that a forbidden path
/// was attempted (and refused) without poking at private fields.
@immutable
class IllegalTransition {
  final String trigger;
  final ConnectionState connection;
  final SessionState session;
  final String reason;
  const IllegalTransition({
    required this.trigger,
    required this.connection,
    required this.session,
    required this.reason,
  });

  @override
  String toString() =>
      'IllegalTransition($trigger from conn=$connection sess=$session: $reason)';
}

class FlowmicStateMachine {
  FlowmicStateMachine({
    Duration justDoneDuration = const Duration(milliseconds: 1500),
    // Grace before a transient transport drop tears down an active session. The
    // server keeps the audio session alive for 30 s; a sub-second LAN blip must
    // NOT visibly tear down a mid-speech session. During this grace the session
    // is PRESERVED; only if the drop outlasts it is the session reset.
    Duration sessionDropGrace = const Duration(seconds: 3),
    // 08 §2「the PROCESSING safety net, 15s」/ CLAUDE.md red line「a latch
    // closed by a remote event must have a local watchdog」. PROCESSING is
    // closed ONLY by a remote stt:final — if the
    // server dies, the engine dies, or the final is simply lost, the FSM would
    // sit in PROCESSING forever and canPtt stays false (phone wedged until an
    // app restart). Same shape as the auto-stop deadlock R6 T-5 removed.
    Duration processingTimeout = const Duration(seconds: 15),
  }) : _justDoneDuration = justDoneDuration,
       _sessionDropGrace = sessionDropGrace,
       _processingTimeout = processingTimeout;

  final Duration _justDoneDuration;
  final Duration _sessionDropGrace;
  final Duration _processingTimeout;
  ConnectionState _conn = ConnectionState.disconnected;
  SessionState _sess = SessionState.disconnected;
  Timer? _justDoneTimer;
  Timer? _dropGraceTimer;
  Timer? _processingTimer;
  SessionState? _heldSession;

  // sync:true makes test assertions deterministic without futures — the spec
  // contract is "transition → snapshot observable immediately".
  final _changesCtl = StreamController<FlowmicStateSnapshot>.broadcast(sync: true);
  final _illegalCtl = StreamController<IllegalTransition>.broadcast(sync: true);
  final _sttStalledCtl = StreamController<SttStall>.broadcast(sync: true);

  // ENG-3 (fix-030) — a TERMINAL stt:error observed while RECORDING, held until
  // the press ends. See [onSttTerminalError] for why it is latched rather than
  // refused (the old behaviour) or surfaced mid-press.
  SttStall? _pendingTerminalError;

  ConnectionState get connection => _conn;
  SessionState get session => _sess;
  FlowmicStateSnapshot get snapshot =>
      FlowmicStateSnapshot(connection: _conn, session: _sess);

  Stream<FlowmicStateSnapshot> get changes => _changesCtl.stream;
  Stream<IllegalTransition> get illegalTransitions => _illegalCtl.stream;

  /// PROCESSING was closed without a terminal stt:final — the utterance
  /// produced nothing. Fires exactly once per stall, carrying WHY (and, for a
  /// terminal `stt:error`, the wire code+message — ENG-3). The UI raises a
  /// fail-loud banner off this (never silent): the user pressed PTT and got no
  /// result, which must never look like nothing happened.
  Stream<SttStall> get sttStalled => _sttStalledCtl.stream;

  void _emit() => _changesCtl.add(snapshot);

  void _refuse(String trigger, String reason) {
    _illegalCtl.add(IllegalTransition(
      trigger: trigger,
      connection: _conn,
      session: _sess,
      reason: reason,
    ));
  }

  /// Connection-level transitions driven by SocketTransport status events.
  void onSocketStatus(SocketStatus s) {
    final next = switch (s) {
      SocketStatus.disconnected => ConnectionState.disconnected,
      SocketStatus.connecting => ConnectionState.connecting,
      SocketStatus.connected => ConnectionState.connected,
      SocketStatus.reconnecting => ConnectionState.reconnecting,
      SocketStatus.error => ConnectionState.error,
    };
    if (_conn == next) return;
    _conn = next;
    if (_conn != ConnectionState.connected &&
        _conn != ConnectionState.reconnecting) {
      // Grace a transient transport drop instead of tearing the session down
      // instantly. Hold the active session; reset only if the drop outlasts
      // [_sessionDropGrace].
      if (_sess != SessionState.disconnected && _sess != SessionState.idle) {
        // 🔴 Card P2-2 (2026-09-02) — [_heldSession] is the ONLY signal this
        // branch has for "is a hold already in progress", because [_sess]
        // itself is never cleared while held (it is what gets RESTORED). A
        // socket bouncing disconnected → connecting → error before it ever
        // reaches `connected` fires [onSocketStatus] once per hop, and every
        // hop used to re-arm [_dropGraceTimer] from zero — so the promised
        // 3 s grace measured from the FIRST drop instead stretched to
        // 3 s-since-the-LAST hop, observed as ~7 s+ in practice. The timer
        // must be armed once, on the transition INTO the hold, and left alone
        // for every subsequent "still not connected" flip until it fires or
        // the link recovers.
        final bool alreadyHeld = _heldSession != null;
        _heldSession = _sess;
        _justDoneTimer?.cancel();
        _justDoneTimer = null;
        // The PROCESSING net is stopped for the duration of the hold and
        // RE-ARMED on restore below: a 30 s outage must not let a net armed
        // before the drop expire mid-hold (the session is held, not stalled),
        // nor leave the restored PROCESSING with no net at all.
        _cancelProcessingWatchdog();
        if (!alreadyHeld) {
          _dropGraceTimer = Timer(_sessionDropGrace, _onDropGraceFired);
        }
      } else {
        _resetSession();
      }
    } else if (_conn == ConnectionState.connected) {
      // Link recovered: cancel any pending drop-grace reset and restore the
      // held session (if the drop was within the grace, the session survived).
      _dropGraceTimer?.cancel();
      _dropGraceTimer = null;
      if (_heldSession != null) {
        _sess = _heldSession!;
        _heldSession = null;
        // Every held state whose exit is TIMER-driven must get its timer back —
        // the hold cancelled them all, and a restored state with no timer is a
        // state with no exit (GA-03 / GA-27).
        //   PROCESSING: still waiting on a stt:final that may never come now.
        //   JUST_DONE : its 1500 ms window is the ONLY way out; without this the
        //     session sat in JUST_DONE forever and canPtt (requires IDLE) stayed
        //     false — the phone wedged exactly like the PROCESSING case, just via
        //     a different state. The window restarts from the restore edge, which
        //     is also the first moment the user could see the 「done」 face again.
        if (_sess == SessionState.processing) {
          _startProcessingWatchdog();
        } else if (_sess == SessionState.justDone) {
          _justDoneTimer?.cancel();
          _justDoneTimer = Timer(_justDoneDuration, _onJustDoneTimerFired);
        }
      } else if (_sess == SessionState.disconnected) {
        _sess = SessionState.idle;
      }
    }
    _emit();
  }

  /// PTT down — valid at CONNECTED + [sessionAcceptsPttDown] (IDLE, or the
  /// cosmetic JUST_DONE window; NR-4-P1 (a) — that predicate carries the whole
  /// rationale and the PROCESSING boundary).
  /// 🔴 「the utterance in flight was ABANDONED」 — owner report 2026-08-28.
  ///
  /// Set by [onPttCancel], cleared by the next accepted [onPttDown], so it can
  /// never outlive the utterance it describes. Read by the inbound dispatch,
  /// which drops the transcript frames the server still owes a cancelled
  /// recording (ptt_inbound.dart carries the full argument, including why the
  /// server keeps sending a terminal final after a cancel at all).
  ///
  /// 🔴 IT LIVES HERE BECAUSE THIS IS THE OBJECT THAT KNOWS. The defect was that
  /// a cancelled utterance still reached the PC, and this machine was never
  /// fooled for a moment: it goes IDLE on cancel and correctly refuses the late
  /// `onSttFinal`. The refusal simply had no reader — the row is built on a
  /// layer that never asked. Putting the fact on a second object would have been
  /// a second answer to a question this one already answers.
  bool _utteranceCancelled = false;
  bool get utteranceCancelled => _utteranceCancelled;

  void onPttDown() {
    if (_conn != ConnectionState.connected) {
      _refuse('pttDown', 'requires connection=connected');
      return;
    }
    if (!sessionAcceptsPttDown(_sess)) {
      _refuse('pttDown',
          'requires session=idle|justDone (RECORDING + PROCESSING coexistence forbidden)');
      return;
    }
    // A fresh utterance is never born abandoned. Cleared on the ACCEPTED edge
    // only, past both guards above: a refused press must not un-silence the
    // frames still owed to the cancelled utterance before it.
    _utteranceCancelled = false;
    // 🔴 NR-4-P1 (a) — leaving JUST_DONE by this edge disarms its window.
    //
    // ⚠️ STATED HONESTLY, because the first draft of the test for this said
    // otherwise and the reverse control caught it: WITHOUT this cancel the
    // session is still correct. `_onJustDoneTimerFired` re-checks
    // `if (_sess == justDone)`, so an orphan fires into a live RECORDING and
    // does nothing. What the cancel buys is that the orphan does not EXIST —
    // no armed Timer holding this FSM, counting down on behalf of an utterance
    // that is over, inside a state it has no business in. That is the
    // difference a test can see (`fakeAsync.nonPeriodicTimerCount`), and it is
    // the difference this line is here for. Every other edge out of JUST_DONE
    // in this file already does the same thing, for the same reason.
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    _sess = SessionState.recording;
    // Belt: a fresh utterance must never inherit a previous one's latched
    // terminal error (every exit from RECORDING already clears it).
    _pendingTerminalError = null;
    _emit();
  }

  /// PTT up — only valid while RECORDING. Also the entry the server-side
  /// auto-stop path takes (ptt_session audio:auto-stopped → onPttUp), so the
  /// watchdog covers that route too.
  void onPttUp() {
    if (_sess != SessionState.recording) {
      _refuse('pttUp', 'requires session=recording');
      return;
    }
    _sess = SessionState.processing;
    _emit();
    // ENG-3: the server already told us — mid-press — that this run is dead
    // (terminal stt:error latched in [onSttTerminalError]). No final is coming,
    // so waiting out the 15 s net would be 15 s of silence followed by the
    // WRONG banner (timeout blames the link; the engine named itself). Close
    // PROCESSING now, carrying the named refusal.
    final SttStall? pending = _pendingTerminalError;
    if (pending != null) {
      _pendingTerminalError = null;
      _stallProcessing(pending);
      return;
    }
    _startProcessingWatchdog();
  }

  /// 08 §2 cancelPtt (swipe-up): abort the utterance from RECORDING WITHOUT
  /// entering PROCESSING — the utterance never completed, so no timeline entry
  /// is built (master-plan §4.0 A: 取消=不建行 — "cancel = no row is built").
  /// Returns straight to IDLE.
  /// Ignored outside RECORDING (a cancel gesture after PTT-up is a no-op).
  void onPttCancel() {
    if (_sess != SessionState.recording) {
      _refuse('pttCancel', 'requires session=recording');
      return;
    }
    // owner report 2026-08-28 — see [utteranceCancelled]. Set INSIDE the guard,
    // so a refused cancel never latches: only a cancel that really happened may
    // silence the transcript frames that follow it.
    _utteranceCancelled = true;
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    // Insurance only: cancel never runs from PROCESSING, but an edge that
    // leaves PROCESSING must never leave the net armed behind it.
    _cancelProcessingWatchdog();
    // ENG-3: the user aborted the utterance — the latched engine refusal has
    // nothing left to report on (cancel = no row, no banner).
    _pendingTerminalError = null;
    _sess = SessionState.idle;
    _emit();
  }

  /// stt:final received — only valid while PROCESSING. Starts the 1500 ms
  /// JUST_DONE window.
  void onSttFinal() {
    if (_sess != SessionState.processing) {
      _refuse('sttFinal', 'requires session=processing');
      return;
    }
    // The awaited terminal event arrived → disarm the safety net.
    _cancelProcessingWatchdog();
    _sess = SessionState.justDone;
    _emit();
    _justDoneTimer?.cancel();
    _justDoneTimer = Timer(_justDoneDuration, _onJustDoneTimerFired);
  }

  void _onJustDoneTimerFired() {
    _justDoneTimer = null;
    if (_sess == SessionState.justDone) {
      _sess = SessionState.idle;
      _emit();
    }
  }

  /// The transport stayed down past the grace — a real disconnect, not a blip —
  /// so tear the held session down now.
  void _onDropGraceFired() {
    _dropGraceTimer = null;
    _heldSession = null;
    _resetSession();
    _emit();
  }

  // ─────────────────────────────────────── PROCESSING safety net (GA-03)
  //
  // OWNERSHIP BOUNDARY — read before adding a second watchdog here.
  // This net covers exactly ONE latch: the realtime straight-through leg
  // «PTT-up → terminal stt:final». It is armed on entry to PROCESSING and
  // disarmed by EVERY edge that leaves PROCESSING.
  //
  // It deliberately does NOT cover the translate/organize LLM leg. GA-01 adds a
  // 30 s compose-layer watchdog for «compose:start → compose:done|error»; when
  // that lands, GA-01 owns the handoff — at compose start-up it either feeds or
  // shifts this net so the two latches never both fire on one utterance
  // (双杀 — "double kill").
  // No handoff API is pre-declared here on purpose: an uncalled seam is exactly
  // the façade this repo bans. GA-01 introduces it together with its caller.

  void _startProcessingWatchdog() {
    _processingTimer?.cancel();
    _processingTimer = Timer(_processingTimeout, _onProcessingTimeout);
  }

  void _cancelProcessingWatchdog() {
    _processingTimer?.cancel();
    _processingTimer = null;
  }

  void _onProcessingTimeout() {
    _processingTimer = null;
    _stallProcessing(const SttStall(SttStallReason.timeout));
  }

  /// stt:error with retryable:false — the server has already told us the
  /// utterance is dead. While PROCESSING it closes the state NOW instead of
  /// idling out the full [processingTimeout]. [code]/[message] ride the stall
  /// event verbatim off the wire frame (ENG-3): the banner layer is the one
  /// that judges 「which engine error」, so it must be handed the fact.
  ///
  /// ── ENG-3 (fix-030) — WHY RECORDING NOW LATCHES INSTEAD OF REFUSING ──────
  /// This method used to be refused outside PROCESSING, with a comment arguing
  /// 「a RECORDING-time stt:error means the engine is reconnecting and capture
  /// continues」. That sentence is true for `retryable:true` — which never
  /// reaches this method (ptt_inbound filters it) — and FALSE for the terminal
  /// error that does: the measured P0 shape is a cold-open failure on
  /// `audio:start` (`STT_CONFIG_MISSING`, sherpa addon not shipped), which
  /// arrives moments into the press, while the FSM is still RECORDING. The
  /// refusal swallowed the one honest frame of the whole run; the user's press
  /// then ended in 「没有听到语音」("no speech was heard") (the server's empty
  /// terminal final) or the
  /// 15 s timeout — both blaming the room for a module that was never shipped
  /// (owner-observed banner sequence, 2026-08-11 reply doc).
  ///
  /// The latch deliberately does NOT abort the press: capture genuinely
  /// continues (unchanged behaviour, and the audio may still be retained), and
  /// tearing the recording UI down mid-sentence is a product change this card
  /// was not asked for. The utterance is judged at its natural end — [onPttUp]
  /// consumes the latch and stalls PROCESSING immediately with the named code.
  /// Every other exit from RECORDING (cancel / reset / a fresh press) clears
  /// the latch, so it can never leak across utterances.
  void onSttTerminalError({String? code, String? message, String? judgedAccount}) {
    final SttStall stall = SttStall(
      SttStallReason.engineError,
      code: code,
      message: message,
      judgedAccount: judgedAccount,
    );
    if (_sess == SessionState.recording) {
      _pendingTerminalError = stall;
      return;
    }
    if (_sess != SessionState.processing) {
      _refuse('sttTerminalError', 'requires session=recording|processing');
      return;
    }
    _stallProcessing(stall);
  }

  /// The microphone never opened (owner 2026-07-27). Abort RECORDING straight to
  /// IDLE — the same shape as a cancel, because the utterance is equally dead —
  /// but unlike a cancel this one is NOT the user's choice, so it must be named.
  /// Waiting for the empty final instead would spend the user's whole press on a
  /// dead mic and then blame the room.
  void onCaptureDead() {
    if (_sess != SessionState.recording) return;
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    _cancelProcessingWatchdog();
    // The mic never opened, so the utterance never had an engine run to be
    // refused by — the dead capture is the whole story and it wins.
    _pendingTerminalError = null;
    _sess = SessionState.idle;
    _emit();
    if (!_sttStalledCtl.isClosed) {
      _sttStalledCtl.add(const SttStall(SttStallReason.captureDead));
    }
  }

  /// The single exit both stall causes take: PROCESSING → IDLE (PTT usable
  /// again) and then a NAMED signal so the UI can say which wall was hit.
  /// No timeline row is built — a missing terminal final means the utterance
  /// never completed (08 §2 / master-plan §4.0 A, same as swipe-up cancel);
  /// chat_controller only builds on stt:final, so silence here is correct.
  void _stallProcessing(SttStall stall) {
    _cancelProcessingWatchdog();
    if (_sess != SessionState.processing) return;
    _sess = SessionState.idle;
    _emit();
    if (!_sttStalledCtl.isClosed) _sttStalledCtl.add(stall);
  }

  /// Reset session timers + state to disconnected WITHOUT emitting (the caller
  /// decides whether to emit).
  void _resetSession() {
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    _cancelProcessingWatchdog();
    _pendingTerminalError = null;
    _sess = SessionState.disconnected;
  }

  /// 08 §4 auth:expired drain (coupling edge): force the SESSION side down —
  /// cancel every session timer, drop any held session, and revert to
  /// DISCONNECTED. Separate from connection status because auth expiry drains
  /// PAIRING + SESSION together (see AuthExpiredHandler), not just the wire.
  void onAuthExpired() {
    _dropGraceTimer?.cancel();
    _dropGraceTimer = null;
    _heldSession = null;
    _resetSession();
    _emit();
  }

  /// Test hook + manual trigger if the timer is fast-forwarded. Calling outside
  /// JUST_DONE is a no-op (refused).
  void onJustDoneTimeout() {
    if (_sess != SessionState.justDone) {
      _refuse('justDoneTimeout', 'requires session=justDone');
      return;
    }
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    _sess = SessionState.idle;
    _emit();
  }

  Future<void> dispose() async {
    _justDoneTimer?.cancel();
    _justDoneTimer = null;
    _dropGraceTimer?.cancel();
    _dropGraceTimer = null;
    _cancelProcessingWatchdog();
    await _changesCtl.close();
    await _illegalCtl.close();
    await _sttStalledCtl.close();
  }
}
