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
  /// `'sendinput' | 'clipboard' | 'cached' | 'dom'` when the frame said so,
  /// **null when it did not**. This used to default to `'sendinput'` when the key was
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
  ///
  /// ── S2-03 (2026-09-07) · `'dom'`, and what this line did NOT have to change ──
  ///
  /// `'dom'` is the fourth enum value (owner's 2026-09-06 ruling 2): a web target
  /// wrote the words into the input element it is bound to. `ok:true, mode:'dom'`
  /// is 「已注入」("injected") — the injection segment succeeded, so nothing here
  /// or downstream may render it as 「待投递」("pending delivery"). No new copy was
  /// authored for it: `applyInjectResult(ok: true)` already lands
  /// `EntryStatus.injected`, which is the existing injected face.
  ///
  /// 🔴 THE READER WAS ALREADY OPEN, AND THE PLANNING DOC SAID IT WAS NOT.
  /// `docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md` §1.4 says
  /// this file 「只认三个字面量，未知读成 null『没说』」("only recognises the three
  /// literals; an unknown one reads as null, 'not said'"), and the deploy-order
  /// reasoning of the whole card was built on that. MEASURED, it is false: the
  /// parse below is `j['mode'] is String ? … : null` — ANY string is carried
  /// verbatim, and `'dom'` was already surviving this door before the enum
  /// existed. The one closed set on the phone is `kPcInjectionVerdictCodes`,
  /// and it is keyed on CODES, not on this field.
  ///
  /// ⚠️ So the compatibility break is NOT here — it is at the RELAY, which zod-
  /// validates `inject:result` and drops a frame whose `mode` is outside the enum
  /// (`relay.handler.ts`'s `safeParseEvent` + `logDrop`). What "the phone never
  /// hears about an utterance that did land" looks like is an OLD RELAY, never an
  /// old phone. Pinned by verify/golden/g23-dom-inject-mode.mjs and, on this side,
  /// by test/inject_result_dom_mode_test.dart.
  ///
  /// 🔴 DO NOT "TIGHTEN" THIS INTO A WHITELIST OF THE FOUR. It would buy nothing
  /// (no consumer branches on any value but `'cached'`) and would cost the next
  /// enum value a silent regression on every phone already in the field: an
  /// unrecognised mode would read as 「没说」("not said") on a frame that did say.
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

/// control:key-result — WHAT THE FAR END DID with one remote keypress
/// (card MP-14, 04 §3.5 F-3116, whitelist 56→57).
///
/// 🔴 IT IS NOT A DELIVERY VERDICT AND MUST NEVER BE ROUTED LIKE ONE. An
/// [InjectResult] settles a timeline ROW: it carries `mode`, the two correlation
/// ids, and the codes `kPcInjectionVerdictCodes` keys delivery authorship on.
/// A keypress has no row on this phone that a verdict could settle — the row it
/// mints says 「the frame left this device」 and that stays true whatever comes
/// back (see `buildControlRowOf`). This frame raises a transient NOTICE and
/// nothing else.
///
/// [ok] `true` DRAWS NOTHING, deliberately: a receipt that only ever appeared on
/// failure could not be told apart from one the relay dropped, and 「no news」
/// would again be two facts wearing one face.
class ControlKeyResult {
  /// The press this answers, verbatim off the wire, or null when the press
  /// carried none (a phone older than MP-14, or a relay that zod-stripped the
  /// key). 🔴 Absence is a fact and is never filled in: an invented id would
  /// point at the wrong press, which is worse than the weaker match by kind.
  final String? requestId;

  /// The wire kind (`enter` / `clear` / `tab` / `punct_*` / …), rendered through
  /// the SAME `controlKeyLabel` the history row uses — one key, one name.
  final String kind;
  final bool ok;

  /// One of `unsupported_here` / `no_target` / `failed`, or null.
  ///
  /// 🔴 CARRIED VERBATIM, NEVER DEFAULTED HERE. A far end that grows a fourth
  /// reason must reach this phone as 「a refusal whose cause I do not recognise」
  /// rather than as one of the three we happen to know — the 0.2.53 lesson
  /// (inventing a sentence for a code you do not recognise is worse than
  /// printing the identifier). The coarsening to `failed` happens at the ONE
  /// place that needs a sentence (`chat_notices.dart`), where it is visible.
  final String? reason;

  const ControlKeyResult({
    required this.kind,
    required this.ok,
    this.requestId,
    this.reason,
  });

  static ControlKeyResult? tryFromJson(Map<String, Object?> j) {
    final Object? ok = j['ok'];
    final Object? kind = j['kind'];
    // Both are REQUIRED by `ControlKeyResultSchema`. A frame missing either is
    // off-contract and is dropped whole rather than half-applied: a receipt we
    // cannot name the key of is one we cannot render, and defaulting `ok` would
    // manufacture a verdict nobody sent.
    if (ok is! bool || kind is! String || kind.isEmpty) return null;
    return ControlKeyResult(
      kind: kind,
      ok: ok,
      requestId: j['request_id'] is String ? j['request_id'] as String : null,
      reason: j['reason'] is String ? j['reason'] as String : null,
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

/// `billing:budget` — how much of this account's transcription allowance is
/// left, and when it starts over (card S2-02; protocol
/// `packages/protocol/src/protocol-schemas-billing.ts`).
///
/// 🔴 IT IS A PROGRESS READING, NOT A VERDICT. The refusals already have
/// owners: `stt:error{QUOTA_EXCEEDED}` turns a press away and
/// `audio:auto-stopped{reason:'quota_exhausted'}` ends a recording that hit the
/// ceiling. Nothing on this class may be used to invent a third refusal —
/// [exhausted] is the same fact the auto-stop is about to state, sent so a
/// meter can reach zero at the moment the recording stops rather than a beat
/// later.
///
/// 🔴 `null` [remainingMs] MEANS 「THIS DEPLOYMENT HAS NO QUOTA CONCEPT」
/// (standalone / self-hosted), never 「we could not read it」 and never
/// 「unlimited as a benefit」. `quota_gauge.dart` already has the rule that
/// follows from it: an end we cannot read is an end we do not draw.
class BillingBudget {
  const BillingBudget({
    required this.remainingMs,
    required this.mode,
    required this.resetsAt,
    this.reason,
    this.exhausted = false,
    this.payer,
  });

  /// Milliseconds of transcription left, or null when the relay does not meter.
  final int? remainingMs;

  /// Whose ceiling produced this (`'plan'` | `'trial'` | `'integrator'`).
  ///
  /// Carried verbatim rather than interpreted. ONE reader branches on it, and
  /// it is not this layer: card G-2c's `ptt_inbound.dart` reads `'trial'` off
  /// the last frame to tell a demo grant's exhaustion from a monthly plan's,
  /// because the refusal frame itself cannot say (see `SttStall.trialCeiling`).
  /// Anything this build has never heard of stays a word we pass on, not a
  /// state we invent.
  final String mode;

  /// The instant the allowance starts over, or null when there is no cycle.
  /// Kept as a UTC [DateTime] for the reason `CloudSummary.resetsAt` states at
  /// length: the boundary is UTC midnight, so the local calendar day differs.
  final DateTime? resetsAt;

  /// Why the relay sent this one. Never load-bearing: every frame carries the
  /// whole reading, so a build that ignores this still renders correctly.
  final String? reason;

  /// True only on the exhaustion frame. Redundant with `remainingMs == 0` on
  /// purpose — the server is the only end that knows whether a zero is spent or
  /// rounded down.
  final bool exhausted;

  /// WHOSE account this recording is being charged to — card MP-3
  /// (`'self' | 'far_end' | 'trial'`; protocol `BudgetViewSchema.payer`).
  ///
  /// 🔴 CARD G-2c GAVE IT TWO READERS, AND THE PARAGRAPH THAT USED TO STAND
  /// HERE IS NOW FALSE — it said 「nothing on this phone reads it yet」 and
  /// 「a phone's own frame can only ever say `'self'`」, both of which were true
  /// when MP-3 wrote them and neither of which survived owner's 2026-09-11
  /// 再追认: 「只要有对端，就扣对端」 — whenever a far end exists it pays, signed in
  /// or not. A paired handset is therefore sent `'far_end'` as a matter of
  /// course, not as an MP-1 edge case.
  ///
  /// THE READER, production: `CloudSummaryController.applyBudget` — it
  /// REFUSES to fold a `'far_end'` or `'trial'` remainder into this account's
  /// own meter. That number is another ledger's.
  ///
  /// 🔴 THERE WERE TWO READERS UNTIL 2026-09-12, and the second one's removal
  /// is owner's (the 09-12 batch ruling, item 5), not an oversight:
  /// `chat_banner_sources.dart` raised `BannerIds.farEndPaysQuota`, a standing
  /// line over the transcript. The fact it stated now lives in the quota-rules
  /// guide on the connections list, which is not keyed on this field at all —
  /// so this word has ONE reader again, and a build that stops sending it costs
  /// the meter's honesty and nothing else.
  ///
  /// ⚠️ UNKNOWN VALUES BECOME `null` RATHER THAN DROPPING THE FRAME, which is
  /// the opposite of [mode]'s rule one field up. The difference is what each one
  /// is load-bearing for: a reading with an invented PROVENANCE is a lie about
  /// the number, so a bad `mode` costs the whole frame; a `payer` this build
  /// does not recognise costs one sentence, and throwing away a valid meter
  /// reading to punish it would be the more expensive mistake. `null` therefore
  /// means 「not told」 and never 「self」 — which since card G-2c is the
  /// difference between 「an old relay, so keep the pre-card behaviour」 and 「we
  /// were told somebody else is paying」.
  final String? payer;

  /// The values [payer] may take, mirrored from the protocol enum. A word off
  /// the wire that is not in here is not carried: an unrecognised string reaching
  /// a screen as itself is what 0.2.53 shipped to a real phone.
  static const List<String> payers = <String>['self', 'far_end', 'trial'];

  /// Never throws, never guesses. A frame whose `mode` is missing is dropped
  /// whole rather than defaulted: a reading with an invented provenance is the
  /// shape this repo keeps paying for.
  static BillingBudget? tryFromJson(Map<String, Object?> j) {
    final Object? mode = j['mode'];
    if (mode is! String || mode.isEmpty) return null;
    final Object? remaining = j['remaining_ms'];
    // A non-null value that is not a number is a BROKEN frame, not an unmetered
    // one — dropped, so a parser bug can never be read as 「no quota here」.
    if (remaining != null && remaining is! num) return null;
    final Object? resets = j['resets_at'];
    if (resets != null && resets is! num) return null;
    final Object? why = j['reason'];
    return BillingBudget(
      remainingMs: remaining == null ? null : (remaining as num).round(),
      mode: mode,
      resetsAt: resets == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch((resets as num).round(), isUtc: true),
      reason: why is String && why.isNotEmpty ? why : null,
      exhausted: j['exhausted'] == true,
      payer: payers.contains(j['payer']) ? j['payer'] as String : null,
    );
  }
}
