// SPEC-REF:
//   packages/protocol/src/protocol-schemas-inject.ts (InjectResultSchema:
//     ok / mode / error / inject_target / entry_id / request_id — the A-58
//     correlation echo)
//   packages/protocol/src/protocol-schemas-focus.ts (FocusStateSchema:
//     window_title / process_name — transient, never persisted, §3.5)
//   packages/protocol/src/protocol-schemas-compose.ts (ComposeChunk/Done/Error
//     — §3.4, the AI buffer operations' reply stream)
//   packages/protocol/src/protocol-schemas-audio.ts (SttErrorSchema:
//     code / message / retryable — GA-03, the terminal-error FSM edge)
//
// Typed inbound presentation payloads (server → mobile) the chat-flow layer
// binds to. Kept separate from wire_payloads.dart (outbound) so the direction
// of each DTO is unambiguous.

import '../timeline/timeline_entry.dart' show InjectTarget;

/// inject:result — the delivery truth for one utterance / re-inject. A-58:
/// [entryId] / [requestId] are verbatim echoes of the triggering request's
/// correlation keys (present whenever the PC received them).
class InjectResult {
  final bool ok;

  /// 🔴 Card F11 ③ — **NULLABLE, AND THE NULL IS THE POINT.**
  ///
  /// `'sendinput' | 'clipboard' | 'cached'` when the frame said so, **null when
  /// it did not**. This used to default to `'sendinput'` when the key was
  /// missing or not a string, which is a FABRICATED JUDGEMENT BASIS: the one
  /// consumer asks `wireMode == 'cached'`, so an absent mode was silently
  /// answered as "the far end spoke, and what it said was not cached" —
  /// a definite negative made up
  /// on this device out of nothing.
  ///
  /// The desktop documents the same sin from the other side and refuses to
  /// commit it: `apps/desktop/src-tauri/src/socket/client.rs` — the
  /// `build_inject_result(false, "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)`
  /// admission refusal — stamps a placeholder mode and says in so many words that
  /// none of the three modes describes "nothing was even attempted" — which
  /// is why authorship is
  /// decided by the error CODE (`packages/protocol/src/inject-verdict-authorship
  /// .ts`, mirrored in `session/outbox_inject_authorship.dart`) and never by
  /// this field.
  ///
  /// ⚠️ `mode` is REQUIRED by `InjectResultSchema`, so null here means the frame
  /// was off-contract (or came from an ingress whose body is not that schema —
  /// the LAN HTTP upload's response). Absence is not an error to be repaired
  /// with a guess; it is a fact to be carried, and consumers must read it as
  /// "not stated" (没说) rather than as any particular mode.
  final String? mode;
  final String? error;
  final InjectTarget? target;
  final String? entryId;
  final String? requestId;

  /// 🔴 Card F12/F1-d (2026-09-02) — how long the SERVER measured before this
  /// same refusal is worth trying again, when it bothered to say. Not in
  /// `InjectResultSchema` today (no producer sets it on this frame yet — see
  /// this field's own doc for the gap), read defensively so the day a
  /// producer does add it, this reader does not need to change. Absence
  /// (`null`) is a fact, never defaulted to 0: a hold-out of 0ms would mean
  /// "retry immediately," which is a claim nobody measured.
  final int? retryAfterMs;

  /// 🔴 Card B3 (2026-09-02, WP-6) — carried ONLY on a server-authored
  /// `INJECT_PC_OFFLINE` (relay.handler.ts `answerReject`). [node] is which
  /// process answered; [homeNode] is that same process's own, possibly stale,
  /// reading of where the PC currently lives (`pc_devices.home_node`). See
  /// `pcPresenceFromInjectResult` for what this phone does with the pair —
  /// ADVISORY only, never treated as proof either way.
  final String? node;
  final String? homeNode;
  const InjectResult({
    required this.ok,
    required this.mode,
    this.error,
    this.target,
    this.entryId,
    this.requestId,
    this.retryAfterMs,
    this.node,
    this.homeNode,
  });

  /// The correlation key the mobile keys write-back on: entry_id first (exact,
  /// Re-inject), else request_id (the utterance idempotency key).
  String? get correlationId =>
      (entryId != null && entryId!.isNotEmpty) ? entryId : requestId;

  static InjectResult? tryFromJson(Map<String, Object?> j) {
    final Object? ok = j['ok'];
    if (ok is! bool) return null;
    return InjectResult(
      ok: ok,
      // 🔴 Card F11 ③ — absence stays absence. See [mode].
      mode: j['mode'] is String ? j['mode'] as String : null,
      error: j['error'] is String ? j['error'] as String : null,
      target: InjectTarget.tryParse(j['inject_target']),
      entryId: j['entry_id'] is String ? j['entry_id'] as String : null,
      requestId: j['request_id'] is String ? j['request_id'] as String : null,
      retryAfterMs: j['retry_after_ms'] is num
          ? (j['retry_after_ms'] as num).round()
          : null,
      node: j['node'] is String ? j['node'] as String : null,
      homeNode: j['home_node'] is String ? j['home_node'] as String : null,
    );
  }
}

/// focus:state — the transient foreground-window mirror. Never persisted.
class FocusState {
  final String windowTitle;
  final String processName;
  const FocusState({required this.windowTitle, required this.processName});

  /// Header label preference: the app identity (process_name basename), falling
  /// back to the window title. The §4.1 process_name→friendly-name category
  /// mapping is a later concern; the raw app name is a truthful label meanwhile.
  String get appLabel {
    if (processName.isNotEmpty) return processName;
    return windowTitle;
  }

  static FocusState? tryFromJson(Map<String, Object?> j) {
    final Object? proc = j['process_name'];
    final Object? win = j['window_title'];
    if (proc is! String && win is! String) return null;
    return FocusState(
      windowTitle: win is String ? win : '',
      processName: proc is String ? proc : '',
    );
  }
}

/// stt:error — the STT engine reporting a fault for the live utterance
/// (SttErrorSchema: code / message / retryable). [retryable] is the whole
/// decision: true = the engine is reconnecting and the utterance may still
/// produce a final, false = this utterance is dead.
///
/// A MISSING/non-bool `retryable` is read as false (terminal). The schema makes
/// it required, so absence is an off-contract frame; resolving it toward
/// "terminal" makes the FSM self-heal out of PROCESSING rather than sit there
/// waiting on a final that a broken sender is unlikely to send — never wedge on
/// a malformed frame.
class SttError {
  final String code;
  final String message;
  final bool retryable;
  /// WP-9 — the additive `judged_account` field (`'self'` | `'pc_owner'`),
  /// verbatim off the wire. Null on any server build that predates it, or on
  /// any code other than `QUOTA_EXCEEDED` (the only refusal card QTA-2 can
  /// attribute to a second account). See `SttStall.judgedAccount`.
  final String? judgedAccount;
  const SttError({
    required this.code,
    required this.message,
    required this.retryable,
    this.judgedAccount,
  });

  static SttError? tryFromJson(Map<String, Object?> j) {
    final Object? code = j['code'];
    if (code is! String || code.isEmpty) return null;
    final Object? judged = j['judged_account'];
    return SttError(
      code: code,
      message: j['message'] is String ? j['message'] as String : '',
      retryable: j['retryable'] == true,
      judgedAccount: judged is String ? judged : null,
    );
  }
}

/// compose:chunk | compose:done | compose:error — the reply stream for one
/// AI-row run (§3.4). The server answers the ORIGINATING socket directly (no
/// room broadcast, no PC hop), so this family is phone-local end to end.
///
/// Every variant carries the [requestId] echo. It is the only way to tell a
/// live run from a superseded one, so a null/mismatched echo is dropped by the
/// consumer rather than applied to whatever buffer happens to be current.
sealed class AiComposeEvent {
  const AiComposeEvent(this.requestId);
  final String? requestId;
}

/// A streamed delta. `delta` is a FRAGMENT — the consumer accumulates.
class AiComposeChunk extends AiComposeEvent {
  const AiComposeChunk({required this.delta, String? requestId})
    : super(requestId);
  final String delta;

  static AiComposeChunk? tryFromJson(Map<String, Object?> j) {
    final Object? delta = j['delta'];
    if (delta is! String) return null;
    return AiComposeChunk(delta: delta, requestId: _echo(j));
  }
}

/// Terminal success. [outputText] is the WHOLE result — it replaces whatever
/// the accumulated chunks built, so a dropped chunk cannot leave a torn buffer.
class AiComposeDone extends AiComposeEvent {
  const AiComposeDone({required this.outputText, this.task, String? requestId})
    : super(requestId);
  final String outputText;

  /// The echoed task literal ('draft_polish' | 'organize' | 'translate').
  final String? task;

  static AiComposeDone? tryFromJson(Map<String, Object?> j) {
    final Object? out = j['output_text'];
    if (out is! String) return null;
    return AiComposeDone(
      outputText: out,
      task: j['task'] is String ? j['task'] as String : null,
      requestId: _echo(j),
    );
  }
}

/// Terminal failure. Both fields are NonEmpty on the wire. CLAUDE.md red line:
/// an LLM failure is reported, never papered over with the original text — the
/// consumer restores the pre-operation buffer AND says the run failed.
class AiComposeError extends AiComposeEvent {
  const AiComposeError({
    required this.code,
    required this.message,
    String? requestId,
  }) : super(requestId);
  final String code;
  final String message;

  static AiComposeError? tryFromJson(Map<String, Object?> j) {
    final Object? code = j['code'];
    if (code is! String || code.isEmpty) return null;
    final Object? msg = j['message'];
    return AiComposeError(
      code: code,
      message: msg is String ? msg : '',
      requestId: _echo(j),
    );
  }
}

String? _echo(Map<String, Object?> j) {
  final Object? id = j['request_id'];
  return (id is String && id.isNotEmpty) ? id : null;
}
