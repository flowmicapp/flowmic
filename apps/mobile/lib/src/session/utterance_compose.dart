// SPEC-REF:
//   docs/rebuild/01-PRODUCT-SPEC.md §3.1 (three-mode table: translate/organize's
//     injected text = LLM output, NOT the raw transcript)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (terminal final → compose → inject
//     source:'llm'; local watchdog; failure fallback)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.4 (compose:start/chunk/done/error)
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01 (rulings 1-7)
//   CLAUDE.md red line: no silent failure / an LLM failure must not silently
//     fall back to injecting the raw STT text / a latch closed by a remote
//     event must have a local watchdog
//
// The UTTERANCE-level compose run: what makes translate/organize actually be
// translate/organize. Until GA-01 the mode was carried on the wire as metadata
// and then ignored — every mode injected the raw STT text, which is the "silently
// inject the original" red line by another route (it never even tried the LLM).
//
// This is deliberately NOT AiComposeController (ai_compose_controller.dart).
// The two runs look alike and mean opposite things:
//   - AiComposeController transforms the user's editable BUFFER on an explicit
//     tap; a failure restores the buffer and nothing was ever meant to leave.
//   - This one processes a SPOKEN utterance that already has a timeline row of
//     its own; a failure must settle that row as ✗ failed and inject NOTHING.
// Merging them would force one of the two semantics onto the other.

import 'dart:async';

import '../signaling/inbound_payloads.dart';
import '../signaling/wire_payloads.dart' show ComposeStartPayload, ComposeTask;
import 'compose_gate.dart';

/// What one utterance run needs from its host (ChatController implements it).
/// An interface, not a back-reference, so the whole contract below is testable
/// without a socket, a store or a widget.
abstract class UtteranceComposeHost {
  /// Terminal success: [processedText] is the LLM product for [entryId]. The
  /// host writes it onto the row, then delivers/syncs per the send policy.
  void ucDone(String entryId, String processedText);

  /// Terminal failure. The host settles the row as ✗ failed and raises the
  /// banner. It MUST NOT deliver the source text as a consolation prize.
  void ucFailed(String entryId, AiComposeOutcome outcome);

  /// Request a repaint (the live 「加工中」 ("processing") face changed).
  void ucNotify();
}

/// One in-flight utterance transform. Single-slot by construction: the PTT gate
/// is closed while a run is live (ChatController.canPtt), so a second utterance
/// cannot start until this one reaches a terminal state. That gate is also what
/// keeps two runs from injecting out of order.
///
/// ⚠️⚠️ CORRECTION (card F3, 2026-08-05) — **THE PARAGRAPH ABOVE WAS A FAÇADE AND IS KEPT
/// VERBATIM** (anti-façade ④: a comment asserting behaviour that lives in another
/// file is a greppable claim, and this one went false the day GA-13 added a
/// second caller). `canPtt` gates the MICROPHONE. The reprocess entry point
/// (`chat_utterance.dart` `_reprocessEntry`, reached from the row's long-press
/// menu) never passes through it, so 「single-slot by construction」 stopped being
/// true and nothing here noticed: [start] overwrote `_entryId`/`_requestId` and
/// re-assigned `_timer` WITHOUT cancelling the old one. Two presses cost:
///   · the first run's `entryId` was orphaned — its `compose:done` no longer
///     matched `_requestId` and was dropped by [onEvent], so that row never
///     settled and the user got NO result for the press they made;
///   · the first run's 45 s watchdog stayed armed and, when it fired, aborted
///     the SECOND run — a timer belonging to a run nobody is waiting for
///     settling a row it never started.
/// ⇒ the invariant is now enforced HERE, where the state is (guard in [start]),
/// which is the only place that cannot be bypassed by a new caller.
class UtteranceComposeController {
  UtteranceComposeController({
    required UtteranceComposeHost host,
    required ComposeGate gate,
    this.watchdog = kWatchdog,
  }) : _host = host,
       _gate = gate;

  /// GA-01 ruling 5. The SERVER's own per-turn budget is COMPOSE_BUDGET_MS = 30 s
  /// (server-core compose/mode.ts). A local 30 s net would race that budget and
  /// report a false local timeout for a run the server is still legitimately
  /// working on, so this sits BEYOND it — the local net exists only for the case
  /// where the terminal frame NEVER comes (dropped frame, server death
  /// mid-stream). Same constant and same reasoning as AiComposeController.
  static const Duration kWatchdog = Duration(seconds: 45);

  final UtteranceComposeHost _host;
  final ComposeGate _gate;
  final Duration watchdog;

  String? _entryId;
  String? _requestId;
  ComposeTask? _task;
  String _live = '';
  Timer? _timer;

  bool get isRunning => _entryId != null;

  /// The task in flight (drives the 「翻译中…」 ("translating…") / 「整理中…」
  /// ("organizing…") face), or null.
  ComposeTask? get task => _task;

  /// The partial LLM output streamed so far. Shown as the live processing segment under the
  /// frozen STT segment — real partial text, never an invented progress bar.
  String get liveText => _live;

  /// Fire the run for [entryId]. Returns null once the frame is away, or the
  /// fail-loud reason (the caller settles the row and raises the banner).
  ///
  /// [requestId] is the utterance client id, so chunk/done/error echoes
  /// correlate exactly like the inject path does (A-58, no FIFO guessing).
  AiComposeFailure? start({
    required String entryId,
    required String requestId,
    required ComposeTask task,
    required String sourceText,
    String? sourceLang,
    String? targetLang,
  }) {
    // 🔴 Card F3 defect ① — THE SINGLE-SLOT GUARD, and it returns BEFORE any field is
    // written. Refusing is the only honest answer this class can give: it has
    // ONE `_entryId`/`_requestId`/`_timer`, so admitting a second run means
    // abandoning the first one's row without settling it (silent failure) while
    // its watchdog keeps running to abort a run it never started.
    //
    // The caller is told rather than silently no-op'd: a long-press on ANOTHER
    // row is a different request, and 「按了没反应」 ("pressed it and nothing
    // happened") is exactly the shape the
    // "no silent failure" red line forbids.
    if (isRunning) return AiComposeFailure.busy;
    _entryId = entryId;
    _requestId = requestId;
    _task = task;
    _live = '';
    final bool ok = _gate.emitAiCompose(
      ComposeStartPayload(
        task: task,
        sourceText: sourceText,
        sourceLang: sourceLang,
        targetLang: targetLang,
        requestId: requestId,
        entryId: entryId,
      ),
    );
    if (!ok) {
      _end();
      return AiComposeFailure.wireFailed;
    }
    _timer = Timer(watchdog, _onWatchdog);
    _host.ucNotify();
    return null;
  }

  /// Route one inbound compose event. Frames whose echo does not match the live
  /// run are DROPPED: a reply from a superseded run must never be written onto
  /// the utterance now in flight.
  void onEvent(AiComposeEvent e) {
    final String? entryId = _entryId;
    if (entryId == null || e.requestId == null || e.requestId != _requestId) {
      return;
    }
    switch (e) {
      case AiComposeChunk(:final String delta):
        if (delta.isEmpty) return;
        _live = '$_live$delta';
        _host.ucNotify();
      case AiComposeDone(:final String outputText):
        _end();
        // done carries the WHOLE result — take it verbatim rather than trusting
        // the accumulated chunks, so a dropped chunk cannot leave torn text.
        // An EMPTY output is a failure, not a silent pass-through of the source:
        // injecting the raw transcript here is precisely the banned fallback.
        if (outputText.trim().isEmpty) {
          _host.ucFailed(
            entryId,
            const AiComposeOutcome(
              reason: AiComposeFailure.serverError,
              code: 'COMPOSE_EMPTY_OUTPUT',
            ),
          );
          return;
        }
        _host.ucDone(entryId, outputText);
      case AiComposeError(:final String code, :final String message):
        // Red line: the LLM failed, so the row fails. It does NOT quietly become a
        // realtime injection of the original words — the user asked for a
        // translation and would have no way to know they sent the source text.
        _end();
        _host.ucFailed(
          entryId,
          AiComposeOutcome(
            reason: AiComposeFailure.serverError,
            code: code,
            message: message,
          ),
        );
    }
  }

  /// Abandon a run whose premise is gone (link dropped — the reply can only come
  /// back over that socket). Always tells the user: a run that evaporates in
  /// silence is a silent failure, and the row would otherwise sit at ⏳ forever.
  void abort(AiComposeFailure reason) {
    final String? entryId = _entryId;
    if (entryId == null) return;
    _end();
    _host.ucFailed(entryId, AiComposeOutcome(reason: reason));
  }

  void _onWatchdog() => abort(AiComposeFailure.timeout);

  void _end() {
    _timer?.cancel();
    _timer = null;
    _entryId = null;
    _requestId = null;
    _task = null;
    _live = '';
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}
