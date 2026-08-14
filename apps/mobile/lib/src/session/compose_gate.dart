// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request | M→S→PC),
//     §3.7 (flow-message → control:key rename, six-key whitelist)
//   docs/rebuild/08-MOBILE-SPEC.md §5 (direct-send = whole utterance injected at
//     PTT end with source 'stt'; hold-then-send = explicit Send with source
//     'manual'; QuickActions = four control keys, clear also wipes the local
//     buffer; the punctuation row is LOCAL and emits nothing)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-3 ②
//   packages/protocol/src/protocol-schemas-inject.ts (InjectRequestSchema /
//     ControlKeySchema — FROZEN, mirrored not modified)
//
// ComposeGate is the ONLY thing in the mobile that emits inject:request,
// control:key and compose:start — the same single-owner shape TimelineSyncGate
// has for history:*. It is the ComposeBand's wire face: everything the input
// area can put on the wire leaves through exactly one of the methods below.
//
// NAMING TRAP (worth stating, because the repo has both): "compose" means two
// unrelated things here. ComposeGate/ComposeBand/compose_send_policy are the
// LOCAL text composer (buffer box + ➤). `compose:start` is the AI/LLM pipeline
// (§3.4 polish/organize/translate). The AI method below is therefore named
// emitAiCompose, never emitCompose, so a reader is never left guessing which
// one a call site means.
//
// It deliberately does NOT swallow a transport failure. TimelineSyncGate can
// afford best-effort emission because the row is already safe on disk; a
// delivery action cannot: a swallowed inject:request would leave the user
// believing their words reached the PC when nothing did. That is precisely the
// 「没有静默失败」("no silent failure") red line, so every method reports the
// truth and the caller turns a false into a visible failure.

import '../../generated/flowmic_events.g.dart';
import '../diag/diag_log.dart';
import '../signaling/socket_core.dart';
import '../signaling/wire_payloads.dart';

/// Why an explicit ComposeBand ➤ / control key could not be delivered. Lives
/// here (pure Dart, no Flutter) so both the controller and AppStrings can name
/// the failure without either importing the other.
enum ComposeSendFailure {
  /// The transport is not connected — the whole input row is disabled, so this
  /// is only reachable by a race against a link drop.
  notConnected,

  /// The buffer is blank (whitespace only). ➤ is greyed out for this, so it is
  /// likewise a race guard rather than a normal path.
  emptyBuffer,

  /// A cloud instance has no PC focus window — there is structurally nothing to
  /// inject into (master-plan §4.0 E). Never pretend otherwise.
  noPcTarget,

  /// The socket rejected the emit. The row is kept and marked ✗ failed.
  wireFailed,

  /// RCA-v3 (2026-07-30): the pre-send transport probe found the link dead —
  /// the frame was never emitted — and the automatic reconnect-and-retry
  /// inside the delivery gate also failed within its budget. Distinct from
  /// [wireFailed] (the emit itself was refused) and from [noResult] (the frame
  /// went out and the PC never answered): here nothing went out, the text is
  /// kept, and the link is being rebuilt by the ladder.
  linkDown,

  /// v0.2.8 — the frame was handed to the socket and the PC never answered.
  ///
  /// `emit` returning without throwing means 「socket.io accepted the frame」,
  /// NOT 「it reached the PC」 — the only proof of delivery this path has is the
  /// PC's own `inject:result`. When that never comes, the row's honest state is
  /// FAILED. Before the watchdog it stayed at ⏳ forever and nothing anywhere
  /// said a word (owner 2026-07-29, sending a picture: 「手机端能看得到图片，但是
  /// PC 这端没有接收到，也没有相应的消息」 — "the phone side can see the picture
  /// just fine, but the PC side never received it, nor any corresponding
  /// message").
  noResult,

  /// Card F4 — the text is over [kInjectTextMaxChars], so this phone refused its
  /// OWN send before a frame existed.
  ///
  /// 🔴 NOT a protocol error code, and it must never become one. The refusal
  /// happens on the device, before `emitInject`, so nothing ever reaches a
  /// server that could answer with a code. What this replaces is the frame
  /// dying at the protocol's zod boundary — and a boundary rejection is
  /// ANONYMOUS AND SILENT (zod drops the payload; nobody phones the user).
  ///
  /// Appended at the END of the enum on purpose: nothing here is persisted or
  /// wire-encoded by ordinal today, but a value inserted mid-list is how that
  /// stops being true quietly.
  tooLong,
}

/// 🔴 MIRROR of `INJECT_TEXT_MAX_CHARS`
/// (`packages/protocol/src/protocol-schemas-inject.ts`) — the ceiling
/// `InjectRequestSchema.text` is validated against at every server boundary.
///
/// It is a HAND-WRITTEN copy because Dart cannot import a TypeScript symbol.
/// The two copies are pinned by `test/inject_text_cap_refusal_test.dart`, which
/// reads that .ts file off disk and compares — the same technique
/// `inject_verdict_authorship_mirror_test.dart` uses for the verdict table and
/// `error_codes.rs` uses for the code registry. A bare number with no guard is
/// exactly the drift this repo already pays a lint family for
/// (`admin-limit-mirror`, `password-policy-mirror`).
const int kInjectTextMaxChars = 100000;

/// Whether [text] is over the cap the wire will refuse.
///
/// 🔴 THE UNIT IS NOT COSMETIC. `String.length` counts UTF-16 code units, which
/// is exactly what zod's `.max()` counts (JS `String.length`). The desktop's own
/// guard counts `text.chars()` — Unicode scalar values — which for any astral
/// character (emoji) is SMALLER. So zod is the binding constraint of the two,
/// and matching zod means everything this gate lets through is accepted by both.
/// Counting scalars here instead would let a 100k-emoji send past a gate whose
/// whole purpose is to be the thing that says no.
///
/// ONE function, two callers (`ManualDelivery.deliverText` and the multiselect
/// pre-flight in `chat_explicit_delivery.dart`) — deliberately not two copies of
/// the comparison: 「这条超没超」("is this one over the limit or not") must
/// have exactly one answer.
bool exceedsInjectTextCap(String text) => text.length > kInjectTextMaxChars;

/// How long a manual/image delivery waits for the PC's `inject:result` before
/// it is settled as failed. Generous on purpose: the PC pipeline does a
/// foreground switch, an 80 ms clipboard settle and up to 700 ms of read-back
/// verification, so this catches a result that will NEVER come rather than a
/// slow one.
const Duration kInjectResultTimeout = Duration(seconds: 20);

/// Why an AI-row run (polish/organize/translate) could not be started or did not finish.
/// Separate from [ComposeSendFailure] because these two failures have opposite
/// consequences: a failed send means text the user believes was delivered was
/// NOT, while a failed AI run means the buffer is unchanged and still theirs.
/// Merging them into one enum would blur exactly the distinction the user needs.
enum AiComposeFailure {
  /// The transport is not connected. The row is disabled for this, so it is a
  /// race guard.
  notConnected,

  /// The buffer is blank — there is nothing to process.
  emptyBuffer,

  /// The socket rejected the compose:start emit; the run never began.
  wireFailed,

  /// The server answered `compose:error` (quota, LLM auth, rate limit, timeout,
  /// unconfigured model…). The raw code + message ride along so the user sees
  /// WHICH wall was hit — the red line forbids collapsing this into a generic
  /// failure, and forbids silently keeping a half-streamed result.
  serverError,

  /// No terminal event arrived within the local watchdog window. The remote
  /// latch never closed, so the local one does (CLAUDE.md red line: 远端事件闭合的
  /// latch 必须有本地看门狗 — "a latch that closes on a remote event must have a
  /// local watchdog") rather than leaving the row spinning forever.
  timeout,

  /// The buffer the run was operating on was discarded mid-flight (✕ / mode
  /// switch), or the link dropped, so the run is void. The USER caused the
  /// first of these, so it is a notice rather than a fault — but it is still
  /// said out loud, because a run that quietly evaporates is a silent failure.
  aborted,

  /// Card F3 defect ① — a run for THIS controller is already in flight, so this
  /// request was refused before it touched anything.
  ///
  /// It is a REFUSAL TO START, never a terminal: nothing is settled, no row
  /// changes, and the run already in flight keeps its own outcome. It exists as
  /// its own value rather than reusing [emptyBuffer] because the two send the
  /// user to opposite actions — 「这条没有可加工的原文」("this one has no
  /// original text to process") is permanent for that row, 「上一次还在跑」
  /// ("the previous run is still going") is over in a few seconds.
  busy,
}

/// One failed AI run, as the banner needs to describe it. The server's raw
/// [code] (and [message]) ride along for [AiComposeFailure.serverError] so the
/// user is told which wall was hit — an unrecognised code is shown verbatim
/// rather than collapsed into a generic message.
class AiComposeOutcome {
  const AiComposeOutcome({required this.reason, this.code, this.message});

  final AiComposeFailure reason;

  /// Protocol error code (QUOTA_EXCEEDED / LLM_AUTH_FAIL / LLM_INVALID_MODEL /
  /// LLM_RATE_LIMITED / LLM_TIMEOUT …). Null for the client-side reasons.
  final String? code;

  /// The server's human message. May be empty.
  final String? message;

  @override
  bool operator ==(Object other) =>
      other is AiComposeOutcome &&
      other.reason == reason &&
      other.code == code &&
      other.message == message;

  @override
  int get hashCode => Object.hash(reason, code, message);
}

class ComposeGate {
  ComposeGate({required SocketTransport transport}) : _transport = transport;

  final SocketTransport _transport;

  /// inject:request. Returns whether the frame actually left the device — false
  /// means the caller MUST surface a failure (never a silent drop).
  ///
  /// Every attempt is written to the diagnostic trail (uploadable to the PC,
  /// diag/diag_log.dart). 「电脑没有回应」("the computer never responded") has
  /// cost this window a full day twice,
  /// and the one thing nobody could establish from the phone side was whether
  /// the frame was ever handed to the socket at all. Sizes and ids only — never
  /// the text, never the picture.
  bool emitInject(InjectRequestPayload payload) {
    final Map<String, Object?> frame = payload.toJson();
    final bool ok = _emit(FlowMicEvents.injectRequest, frame);
    diag('emit.inject', <String, Object?>{
      'source': payload.source.name,
      'request_id': payload.requestId,
      'entry_id': payload.entryId,
      // RV-74: the ROW's mode (realtime/translate/organize), never
      // `inject:result.mode`. It is here because the desktop's own forensic
      // already names it (`row minted … gaps=[mode→realtime(guess)]`,
      // socket/row_transit.rs) and until now only ONE end of that sentence could
      // be read: the PC could say 「这一帧没带 mode」("this frame did not carry a
      // mode"), the phone could not say what
      // it stamped. Null here ⇒ the field was omitted from the frame, which after
      // this card means a call site regressed. A name, not user content.
      'mode': payload.mode?.name,
      'text_chars': payload.text.length,
      'image_b64_chars': payload.imageB64?.length ?? 0,
      // Card M / 🔴 no-crosstalk red line: an id, not user content — same class of
      // value every other line here already logs. Null is itself diagnostic
      // (see PttSession.pcId's doc for when that is expected).
      'target_pc_id': payload.targetPcId,
      'handed_to_socket': ok,
    });
    return ok;
  }

  /// control:key — one of the six whitelisted remote keys, applied to the PC's
  /// focused window. The local punctuation row never comes through here.
  ///
  /// REQ-12-13: [deviceLabel] is WHICH PHONE pressed it (04 册 F-3115, additive
  /// optional). The desktop mints a timeline row per press now, and a PC is a
  /// shared destination — a row that cannot name its sender is what makes a
  /// crosstalk (串号)
  /// invisible. Null is a real state (an older phone, a relay that strips the key),
  /// and the payload OMITS the field rather than sending an empty string.
  bool emitControlKey(ControlKeyKind kind, {String? deviceLabel}) => _emit(
    FlowMicEvents.controlKey,
    ControlKeyPayload(kind, deviceLabel: deviceLabel).toJson(),
  );

  /// compose:start — the AI buffer operations (§3.4). Returns whether the frame
  /// left the device; false MUST become a visible failure, same as ➤.
  ///
  /// Verified against the frozen server contract before wiring (see the T-3b
  /// report): compose.handler.ts takes ONLY `getAuth(socket)` — no auth.kind
  /// check, no resolveActingUser, no room membership, no getPc — and answers
  /// the originating socket with compose:chunk*/done/error. A paired phone can
  /// therefore run this with the PC asleep and with zero server change; the
  /// room's focus process_name is used purely as an optional scenario hint and
  /// is simply absent when there is no PC.
  bool emitAiCompose(ComposeStartPayload payload) =>
      _emit(FlowMicEvents.composeStart, payload.toJson());

  bool _emit(String event, Object? payload) {
    // RCA-v3: a socket the CLIENT already knows is down must not be handed a
    // frame — socket_io_client buffers it in the doomed adapter's sendBuffer
    // (reconnection:false means it never flushes; the ladder builds a NEW
    // adapter), so returning true here was a lie twice over. This check cannot
    // see a dead-but-undetected link (only an acked round-trip can — see
    // ManualDelivery's create-ack gate); it makes the KNOWN case honest.
    if (_transport.currentStatus != SocketStatus.connected) return false;
    try {
      _transport.emit(event, payload);
      return true;
    } on Object {
      return false;
    }
  }
}
