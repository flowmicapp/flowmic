// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.4 (compose:start / chunk / done / error)
//   docs/ui-design/REDESIGN-PLAN.md §6.2 ④ (the AI action row), §2 F-3 (the three
//     operations act on the buffer, replace it, never inject; a failure keeps
//     the pre-op buffer)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md Wave 2 T-3 (the AI row)
//   CLAUDE.md red line: no silent failure / an LLM failure must not silently
//     fall back to injecting the raw original text / a latch closed by a
//     remote event must have a local watchdog
//
// The AI action row's state machine (polish / organize / translate), split out of ChatController so
// the file-size cap holds and so this contract is testable on its own.
//
// The three tasks transform the BUFFER and inject NOTHING. The result lands
// back in the editable box so the user reads it, edits it if they like, and
// then decides to send — the AI never delivers on the user's behalf.
//
// Wire: compose:start{task, source_text, draft:true, request_id} → the server
// answers THIS socket with compose:chunk* then compose:done | compose:error.
// Verified against apps/server-core before wiring (see compose_gate.dart): the
// handler has no PC-role / room / paired-PC requirement, so this works on a
// phone whose PC is asleep, with zero server change.

import 'dart:async';

import '../signaling/inbound_payloads.dart';
import '../signaling/wire_payloads.dart' show ComposeStartPayload, ComposeTask;
import 'compose_gate.dart';

/// What a run needs from its host. ChatController implements it in three lines;
/// keeping it an interface is what lets this class be exercised without a
/// session, a socket or a timeline.
abstract class AiComposeHost {
  /// The compose buffer the run reads and writes.
  String get aiBuffer;
  set aiBuffer(String value);

  /// Whether a run may start at all (link up).
  bool get aiCanStart;

  /// 🔴 G-20 ④ — 「现在这块转录屏幕是哪个实例的」("which instance this transcription
  /// screen currently belongs to") (`PttSession
  /// .connectedInstanceId`). The SAME scope `ManualDeliveryHost
  /// .deliveryInstanceId` carries — the failure banner this controller raises
  /// must answer 「这是谁的消息」("whose message is this") the same way every
  /// other banner on the screen does, or two banners on one screen disagree
  /// about whose screen it is.
  /// Null is a real value (cloud instance / not yet joined) and is never a
  /// wildcard — see [AiComposeController.failure].
  String? get aiInstanceId;

  /// Request a repaint.
  void aiNotify();
}

class AiComposeController {
  AiComposeController({required AiComposeHost host, required ComposeGate gate})
    : _host = host,
      _gate = gate;

  final AiComposeHost _host;
  final ComposeGate _gate;

  /// Local watchdog. The server's own per-turn budget is COMPOSE_BUDGET_MS =
  /// 30 s (server-core compose/mode.ts); this sits BEYOND it so a legitimately
  /// slow run is never cut short, while a reply that NEVER comes (dropped
  /// terminal frame, server death mid-stream) still closes the latch locally.
  static const Duration kWatchdog = Duration(seconds: 45);

  /// The task currently being processed, or null when the row is idle. Non-null
  /// is the UI's disabled/progress state — the buttons and ➤ go inert so a
  /// second run cannot race the first into the same buffer.
  ComposeTask? _task;
  ComposeTask? get task => _task;
  bool get isRunning => _task != null;

  /// The live request_id. Any chunk/done/error carrying a different echo is a
  /// superseded run and is DROPPED — otherwise a slow reply from an abandoned
  /// run would overwrite a buffer the user has since moved on from.
  String? _requestId;

  /// The buffer as it was before the run started. F-3 「失败保留操作前缓冲」
  /// ("failure keeps the pre-op buffer") — this
  /// is what a failure restores, byte for byte.
  String _originalBuffer = '';

  /// 🔴 T-6 (0.2.63, owner addendum #5:「整理/翻译/润色点击后要能恢复，不然就找不到
  /// 原文了」("after clicking organize/translate/polish it must be possible to
  /// recover, otherwise the original text can't be found")) — WHAT A
  /// **SUCCESSFUL** RUN LEAVES BEHIND.
  ///
  /// [_originalBuffer] served exactly one path: FAILURE (F-3). After a success
  /// there was no way back at all — the transcript the user spoke had been
  /// overwritten in the only place it lived, and 「找不到原文」("the original text
  /// can't be found") was literally true. This holds it until the draft it
  /// belongs to is gone.
  ///
  /// 🔴 IT IS THE PRE-**FIRST**-TRANSFORM TEXT, AND THAT IS THE WHOLE RULE.
  /// Chained runs do NOT stack (organize then translate ⇒ restore still gives
  /// the spoken words, not the organize product): `??=` below is the one line
  /// that decides it. Stacking would make 「恢复原文」("restore the original")
  /// mean 「undo one step」, which is a different
  /// product and a worse one here — the user pressed a second pill BECAUSE the
  /// first result was not what they wanted, so the intermediate is the last
  /// thing they want back.
  ///
  /// ⚠️ A FAILED run deliberately does NOT clear it. F-3 puts the pre-op buffer
  /// back (which after a chain is itself an AI product), so the original is
  /// still the only text nothing can otherwise recover.
  String? _restorable;

  /// The pre-first-transform text, or null when there is nothing to go back to.
  /// Non-null is exactly the affordance's visibility predicate — one fact, one
  /// author, no second boolean to drift from it.
  String? get restorableOriginal => _restorable;

  /// Put the pre-first-transform text back. Returns false when there is nothing
  /// to restore (the button is not drawn then, so this is a race, not a state).
  ///
  /// It CONSUMES the affordance: once the buffer IS the original, a button
  /// offering to restore it would be answering a question whose answer is
  /// already on screen. Running a transform again arms it again — with the
  /// buffer's new pre-run content, which by then is the original.
  bool restoreOriginal() {
    final String? original = _restorable;
    if (original == null) return false;
    _restorable = null;
    _host.aiBuffer = original;
    _host.aiNotify();
    return true;
  }

  /// The draft this original belonged to is gone (delivered / discarded / the
  /// box emptied), so the original is no longer the original OF anything.
  ///
  /// Deliberately NOT called on an ordinary edit: the user tweaking a word of
  /// an AI result is the case the affordance exists for, and taking it away
  /// mid-edit would punish exactly the person it was built for.
  void forgetRestorable() {
    if (_restorable == null) return;
    _restorable = null;
    _host.aiNotify();
  }

  int _seq = 0;
  Timer? _watchdog;

  /// The last failure, held until dismissed. Carries the raw server code so the
  /// user is told WHICH wall was hit (quota / auth / model unset / timeout),
  /// never a generic 「失败了」("it failed").
  AiComposeOutcome? _failure;

  /// 🔴 G-20 ④ — WHICH INSTANCE'S SCREEN [_failure] is news for, stamped by the
  /// one writer ([_raise]). The disconnect-edge `abort` (chat_outbox_host.dart)
  /// writes a failure too, so 「切实例」("switching instance") itself can produce
  /// one — the stamp is what keeps that failure from following the user onto
  /// the next screen.
  String? _failureInstanceId;

  /// The last failure **for the instance whose screen is asking**. A parked
  /// failure is hidden, not discarded — switching back shows it again
  /// (§2.5.1 是「藏」不是「丢」("this is 'hiding', not 'losing'")). ⚠️ `null == null` is a REAL match, not a
  /// wildcard: same equality judgement as `ImageSendController.failure`.
  AiComposeOutcome? get failure =>
      _failure == null || _failureInstanceId == _host.aiInstanceId
      ? _failure
      : null;

  void dismissFailure() {
    if (_failure == null) return;
    _failure = null;
    _failureInstanceId = null;
    _host.aiNotify();
  }

  /// Enable gate: link up, something in the buffer, nothing already in flight.
  bool get canStart =>
      _host.aiCanStart && !isRunning && _host.aiBuffer.trim().isNotEmpty;

  /// Start one operation on the current buffer. Returns null once the frame is
  /// away, or the fail-loud reason.
  AiComposeFailure? start(ComposeTask task) {
    if (!_host.aiCanStart) return _raise(AiComposeFailure.notConnected);
    if (isRunning) return null; // already running; the row is disabled.
    final String source = _host.aiBuffer.trim();
    if (source.isEmpty) return _raise(AiComposeFailure.emptyBuffer);
    final String requestId =
        'c${_seq++}-${DateTime.now().microsecondsSinceEpoch}';
    _task = task;
    _requestId = requestId;
    _originalBuffer = _host.aiBuffer;
    final bool ok = _gate.emitAiCompose(
      ComposeStartPayload(
        task: task,
        sourceText: source,
        requestId: requestId,
        // target_lang omitted on purpose: the server prompt defaults translate
        // to `en` (compose/prompt.ts), so the phone hardcodes no pair.
      ),
    );
    if (!ok) {
      _end();
      return _raise(AiComposeFailure.wireFailed);
    }
    // G-20 ④: a new run retires the previous conclusion — but only THIS
    // screen's (§2.5.1). A failure parked on another instance was never seen
    // there; sweeping it from here would swallow it silently.
    if (_failure != null && _failureInstanceId == _host.aiInstanceId) {
      _failure = null;
      _failureInstanceId = null;
    }
    _watchdog = Timer(kWatchdog, _onWatchdog);
    _host.aiNotify();
    return null;
  }

  /// Route one inbound compose event.
  void onEvent(AiComposeEvent e) {
    // Stale / unattributable reply → drop. Never applied to the current buffer.
    if (_task == null || e.requestId == null || e.requestId != _requestId) {
      return;
    }
    switch (e) {
      case AiComposeChunk(:final String delta):
        // Stream into the buffer so the progress is the REAL partial text
        // rather than an invented spinner percentage. A failure below restores
        // the pre-run buffer, so streaming here never costs the user anything.
        if (delta.isEmpty) return;
        final String current = _host.aiBuffer;
        _host.aiBuffer = current == _originalBuffer ? delta : '$current$delta';
        _host.aiNotify();
      case AiComposeDone(:final String outputText):
        _end();
        // done carries the WHOLE result — take it verbatim rather than trusting
        // the accumulated chunks, so a dropped chunk cannot leave torn text.
        // An empty output is a failure, not a silent buffer wipe.
        if (outputText.trim().isEmpty) {
          _host.aiBuffer = _originalBuffer;
          _raise(
            AiComposeFailure.serverError,
            code: 'COMPOSE_EMPTY_OUTPUT',
            message: '',
          );
          return;
        }
        // 🔴 T-6: the ONE place a success arms 「恢复原文」("restore the original
        // text"), and `??=` is the no-stacking rule (see [_restorable]). It runs
        // BEFORE the buffer moves so the two facts are decided in the same
        // statement pair — the buffer and 「回得去哪儿」("where it can go back to")
        // can never be written by different branches.
        _restorable ??= _originalBuffer;
        _host.aiBuffer = outputText;
        _host.aiNotify();
      case AiComposeError(:final String code, :final String message):
        // Red line: an LLM failure NEVER silently degrades to the original text
        // pretending it worked. The buffer goes back to exactly what the user
        // had, AND the banner says the operation failed and why.
        _end();
        _host.aiBuffer = _originalBuffer;
        _raise(AiComposeFailure.serverError, code: code, message: message);
    }
  }

  /// Abandon a run whose premise is gone: the link dropped (the reply can only
  /// come back over that socket), or the buffer it was handed was discarded by
  /// a mode switch / ✕. Always tells the user — a run that quietly evaporates
  /// is a silent failure.
  ///
  /// [restoreBuffer] is false when the caller is about to blank the buffer
  /// anyway; restoring it first would resurrect text the user just cleared.
  void abort(AiComposeFailure reason, {bool restoreBuffer = true}) {
    if (_task == null) return;
    _end();
    if (restoreBuffer) _host.aiBuffer = _originalBuffer;
    _raise(reason);
  }

  void _onWatchdog() => abort(AiComposeFailure.timeout);

  void _end() {
    _watchdog?.cancel();
    _watchdog = null;
    _task = null;
    _requestId = null;
  }

  AiComposeFailure? _raise(
    AiComposeFailure reason, {
    String? code,
    String? message,
  }) {
    _failure = AiComposeOutcome(reason: reason, code: code, message: message);
    // G-20 ④: scope read at the moment the fact is produced (§2.5.1), so the
    // one writer decides the value and its screen in the same statement.
    _failureInstanceId = _host.aiInstanceId;
    _host.aiNotify();
    return reason;
  }

  void dispose() {
    _watchdog?.cancel();
    _watchdog = null;
  }
}
