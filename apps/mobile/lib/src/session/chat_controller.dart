// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (utterance-final
//     builds a row; cancel builds none), §4.0 B (session-scoped destination,
//     reset on reconnect), §4.0 C/D (noted withholding; five-state truth)
//   docs/rebuild/08-MOBILE-SPEC.md §2 (mode switch clears buffer, ignored while
//     recording), §5 (target-aware inject:result write-back; source_text
//     immutable) — §5's history:update / history:inject halves were retired in
//     0.2.27, see chat_row_uplink.dart
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 ⑦ (polish:skipped →
//     session-persistent bubble corner mark, in-memory only — the lead's integration
//     ruling refined "transient" to "not persisted", NOT "auto-dismissing"; never
//     touches timeline schema / status five-state)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-3 ② (send policy full chain),
//   docs/rebuild/08-MOBILE-SPEC.md §5 + its 2026-08-13 correction block
//     (direct-send vs hold-then-send; the final-lands-in-buffer append/replace
//     rule; 🔴 「clear wipes the local buffer」 was STRUCK by owner supplement #3
//     — control keys never touch this phone's draft)
//
// ChatController is the presentation orchestration hub — it fuses the PttSession
// data layer with the TimelineStore, DestinationController, TimelineSyncGate and
// ComposeGate. It owns the live in-flight draft, mints utterance ids, snapshots
// the fixed per-utterance delivery/mode/send-policy at PTT-down, builds the
// committed row on the terminal final, decides direct vs manual delivery, and
// routes inject:result / focus:state / connection edges.

import 'dart:async';

import 'package:clock/clock.dart' show clock;
import 'package:flutter/foundation.dart';

import '../audio/audio_capture.dart' show CapturedChunk;
import '../audio/retained_audio_manifest.dart' show AudioJournalFormat;
import 'recovery_identity.dart' show RecoverySampleRange;
import '../audio/retained_audio_spill.dart' show LiveAudioAttempt;
import '../audio/retained_audio_store.dart' show RetainedAudioNotice;
import '../destination/destination_controller.dart';
import '../diag/diag_log.dart';
import '../favorites/favorites_store.dart';
import '../ptt/ptt_session.dart';
import '../settings/app_settings.dart';
import '../settings/local_prefs.dart';
import '../settings/phone_prefs_payload.dart';
import '../signaling/album_away.dart';
import '../signaling/inbound_payloads.dart';
import '../signaling/state_machine.dart';
import 'link_recovery.dart';
import 'live_settle.dart';
import '../signaling/wire_payloads.dart';
import '../stt/segment_buffer.dart';
import '../stt/stt_stream.dart';
import '../stt/utterance_view.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import '../timeline/timeline_sync.dart';
// Window C-5: chat_transient_banner_timers.dart names BannerIds so the auto-hide
// key list stays 1:1 with the queue's own ids instead of a second copy of the
// literals.
import '../ui/banner_queue.dart' show BannerIds;
import '../ui/haptics.dart' show FlowMicHaptics;
import 'ai_compose_controller.dart';
import 'asr_health.dart';
import 'backfill_runner.dart';
import 'compose_gate.dart';
import 'delivery_link_up.dart';
import 'delivery_outbox.dart';
import 'outbox_blob_store.dart';
import 'outbox_destination.dart';
import 'outbox_failure_text.dart';
import 'outbox_frame.dart';
import 'outbox_item.dart';
import 'outbox_notice_gate.dart';
import 'outbox_store.dart';
import 'pending_recovery.dart';
import 'pending_recovery_store.dart';
import 'pairing_success_notice.dart';
import 'pc_presence.dart';
import 'image_send_controller.dart';
import 'manual_delivery.dart';
import 'platform_device_info.dart';
import 'platform_image_picker.dart';
import 'recording_telemetry.dart';
import 'utterance_compose.dart';

// The utterance lifecycle (terminal final → row → transform → delivery) lives
// in a part file so this one stays under the source cap while the logic keeps
// direct access to the per-utterance snapshot state it is about.
part 'chat_utterance.dart';
part 'chat_utterance_settle.dart';
// The link watch: the window, the retry budget, the exit. Its own header says why.
part 'chat_link_watch.dart';
// The remote-key half (⏎⌫↶✕). A part file because this one is at the source
// cap. ⚠️ Its ORIGINAL reason — 「it needs the controller's private buffer
// state」 — stopped being true in T-1: owner supplement #3 removed the only
// line in there that wrote `_buffer`. Kept as a part rather than promoted to a
// plain import because that is a move with no behaviour in it, and this file
// has no room to absorb it either way.
part 'chat_control_keys.dart';
// Edit + delete of an existing row. It used to be the ROW UPLINK half (one
// decision for 「does the server actually have this row or not」, shared by five paths); the uplink was
// retired in 0.2.27 and its header says what became of each piece.
part 'chat_row_uplink.dart';
// The OutboxDrainHost bodies (Window B3-2a) — same reason as the parts above.
part 'chat_outbox_host.dart';
// The mode chip's three writers — moved out VERBATIM (RV-92's tag-along split), see
// that file's header for the two mechanical edits and nothing else.
part 'chat_mode_chip.dart';
// The transient page notices (auto-stop / stt-stall / utterance-transform) and
// the buffer discard they share — moved out VERBATIM in Window B3-2b to make room
// for the queue's user-visible surface. Same reason as the parts above.
part 'chat_notices.dart';
part 'chat_pending_recovery.dart'; // RC-1b the pending-recovery source
// Window C-5 — the banner auto-hide reconciler (new) + the OLD dispose() body
// (moved verbatim, minus its trailing super.dispose() — see that file's
// header for why both live together and what is new vs. moved).
part 'chat_transient_banner_timers.dart';
// ── Lane K (2026-08-05) — the four parts below are a DIFFERENT SHAPE from the
// seven above: each declares an `extension … on ChatController` instead of
// top-level `xxxRouted` functions, so the member's declaration and the prose
// above it travel WITH the body. The seven older parts could only carry bodies,
// and in this file the prose is the bulk. 🔴 The price is written out in
// chat_ptt_lifecycle.dart's header: extension members are resolved STATICALLY
// and do NOT implement interfaces — nothing required by AiComposeHost /
// ManualDeliveryHost / UtteranceComposeHost / OutboxDrainHost, no field, and
// neither `notifyListeners` nor `dispose` may ever move into one of them.
// Zero behaviour change: see each file's own header for the one mechanical
// edit it declares (`notifyListeners()` → `notifyUi()`) and nothing else.
//
// One utterance, from 「can this button be pressed」 to 「the transcript came back」.
part 'chat_ptt_lifecycle.dart';
// The truths this controller must put in front of the user, and the ✕ that
// closes each one (no silent failures / all of R11's exits).
part 'chat_status_surface.dart';
// The six places the USER explicitly asks for something to go on the wire.
part 'chat_explicit_delivery.dart';
// The exact complement of the file above: rewriting an EXISTING row without
// re-delivering it.
part 'chat_row_rewrite.dart';
// The AI/translate row's plain (non-@override) surface — card B2-O, moved out
// to buy room for the retained-audio notice wiring below. See that file's
// header for the one mechanical edit and nothing else.
part 'chat_ai_row_surface.dart';

// The five inbound routers — one family, one file. See its header.
part 'chat_inbound_routes.dart';
// The G-20 scope judgement — 「which screen is this notice news for」. Its header says why.
part 'chat_notice_scope.dart';
// AW-1b — wires AsrHealthTracker onto the real event sources. Its header says
// why every subscription lives here instead of inside an existing router.
part 'chat_asr_health_wire.dart';
part 'chat_controller_wiring.dart';
// Lane S4 (audio-durability plan, 700-line cap) — `part` files cannot reopen a
// class, but a mixin declared in one CAN hold fields (and, unlike an
// extension, correctly implements interfaces). This carries a pure-state
// family — the per-utterance delivery snapshot and its neighbouring
// fail-loud notice fields — moved out VERBATIM (comments included); nothing
// in it was a getter or referenced a sibling member, so the move is textual
// only. See that file's header for the `on` clause it did and did not need.
part 'chat_controller_state.dart';

class ChatController extends ChangeNotifier
    with _ChatControllerState
    implements
        AiComposeHost,
        ManualDeliveryHost,
        UtteranceComposeHost,
        OutboxDrainHost {
  ChatController({
    required this.session,
    required this.store,
    required this.destination,
    required this.syncGate,
    required this.localPrefs,
    // Window B3-2a queue stores. REQUIRED with no default (RV-20 / Book 13 §7 F1 ②):
    // a nullable outbox would mean 「the queue silently does not run」 — the façade this card removes.
    required OutboxStore outboxStore,
    required OutboxBlobStore outboxBlobs,
    this.appSettings,
    this.llmCapability,
    this.phonePrefs,
    ComposeGate? composeGate,
    ImagePickerPort? imagePicker,
    DateTime Function()? clock,
    // owner 2026-07-26 ②: how long a dead link may stay dead before the chat
    // page gives up and returns to the connections list. Injectable so tests
    // run on a collapsed window instead of sleeping through the real one.
    this.sessionLostAfter = kSessionLostAfter,
  }) : favorites = FavoritesStore(prefs: localPrefs),
       composeGate =
           composeGate ??
           ComposeGate(transport: session.transport, phonePrefs: phonePrefs) {
    // Both bodies: chat_controller_wiring.dart (an extension on this class,
    // so the lines there keep reading as implicit-this member access).
    _buildLateFields(
      outboxStore: outboxStore,
      outboxBlobs: outboxBlobs,
      imagePicker: imagePicker,
      clock: clock,
    );
    _wireSubscriptions();
  }

  // Family bodies: chat_notices.dart. NAMES stay here so call sites are untouched.
  void _onAlbumAwayChanged() => onAlbumAwayChangedRouted(this);

  /// D-1c — the capture-ended edge; body in chat_link_watch.dart.
  void _onCaptureStopped() => _stopHeldLadderRouted(this);

  /// The server just put this connection into the room ⇒ now, and only now,
  /// the queue can actually deliver. See F-1. Body: chat_outbox_host.dart.
  void _onRoomJoined() => onRoomJoinedRouted(this);
  void _onDeliveryLinkUp() => onDeliveryLinkUpRouted(this);

  /// AUD-D F6 / P1-6 — a segment was dropped/evicted/expired out of local
  /// retention. Body: chat_notices.dart (same family as the other page-level
  /// transient truths that never touch TimelineEntry).
  void _onRetainedAudioNotice() => onRetainedAudioNoticeRouted(this);

  final PttSession session;
  /// Card PAIR-SUCCESS — raised by main.dart from the connections page's deliberate-entry funnel only.
  late final PairingSuccessNotice pairingSuccess = PairingSuccessNotice(onChanged: notifyUi);
  /// Card LLM-NOTICE — the PC's `capability.llm` (settings/llm_capability.dart):
  /// null = not told · false = no usable model (mode note renders) · true = silent.
  final ValueListenable<bool?>? llmCapability;

  /// 🔴 What this phone holds for `scenario.card` / `stt.polish` / `stt.refine`
  /// / `scenario.inference`, read at every emit. Owner ruled 2026-09-03 that the
  /// carrier is the REQUEST: it rides `audio:start` and `compose:start`, nothing
  /// is stored, and there is no `settings:update` for these keys any more.
  /// THE PRODUCTION WIRE IS ONE LINE — `_settingsRoot.phonePrefs.frame` in
  /// main.dart — and it feeds all three emitters below (the PTT edge, the
  /// backfill runner and the compose gate) from one source, so no two frames
  /// can disagree about this phone. Null (tests) sends no `prefs`.
  final PhonePrefsSource? phonePrefs;
  @override
  final TimelineStore store;

  /// 🔴 CR-5 — the re-transcription channel. Built here because this is the
  /// one place that already holds BOTH halves it needs: the wire (`session`)
  /// and the rows (`store`). Swept on two edges only — the link coming back,
  /// and a recording ending — because those are the only two moments at which
  /// the answer to 「is anything owed」 can have changed.
  late final BackfillRunner backfill =
      BackfillRunner(session: session, store: store, phonePrefs: phonePrefs);

  final DestinationController destination;
  @override
  final TimelineSyncGate syncGate;
  final LocalPrefs localPrefs;
  final AppSettingsController? appSettings; // The speaking language; see app_settings.dart §speaking language for why it is nullable

  /// The sole emitter of inject:request / control:key / compose:start
  /// (see compose_gate.dart).
  final ComposeGate composeGate;

  /// F-5 Favorites. Owned here (not by the page) because it shares [localPrefs] with
  /// the rest of the device-local prefs and because [sendFavorite] is a
  /// controller concern — the page only renders it. Hydrate with
  /// [FavoritesStore.load]; an un-hydrated store is simply empty.
  final FavoritesStore favorites;

  /// The recording panel's numbers (⏱ / 📊 / 📍). See recording_telemetry.dart.
  late final RecordingTelemetry recording;

  /// AW-1b — ASR-leg health telemetry, read-only observation. Wired onto the
  /// real event sources by [wireAsrHealth] (chat_asr_health_wire.dart); that
  /// function names every production call site.
  final AsrHealthTracker asrHealth = AsrHealthTracker();

  /// The AI action row's run state (polish/organize/translate). See ai_compose_controller.dart.
  late final AiComposeController aiCompose;

  /// GA-01: the per-utterance translate/organize run. Distinct from
  /// [aiCompose], which transforms the editable buffer — see utterance_compose.dart.
  late final UtteranceComposeController utteranceCompose;

  /// The EXPLICIT delivery path (➤ / Favorites tap-to-send / the four control keys) and
  /// the manual-send correlation state. See manual_delivery.dart.
  late final ManualDelivery delivery;

  /// R6 T-4 picture pipeline: the 「+」 panel → pick a picture → base64 →
  /// inject:request{source:'image'}.
  /// Built ON TOP of [delivery] — an image send is a manual delivery with a
  /// different payload, not a second delivery mechanism.
  late final ImageSendController imageSend;

  /// Window B3-2a — the persistent delivery queue (delivery_outbox.dart).
  @override
  late final DeliveryOutbox outbox;

  /// 2026-09-04 — the ONE fact the drain subscribes to (delivery_link_up.dart).
  late final DeliveryLinkUp deliveryLink;

  /// RV-93 — the timeline's pictures. Exposed BESIDE [outbox], not through it:
  /// the bytes belong to the row (row_image_lookup.dart). Consumer:
  /// `chat_flow_page` → `rowImageBytes` → opening the full-size image.
  late final OutboxBlobStore rowImages;

  StreamSubscription<SttFinal>? _finalSub;
  StreamSubscription<SttInterim>? _interimSub;
  StreamSubscription<InjectResult>? _injectSub;
  StreamSubscription<FocusState>? _focusSub;
  StreamSubscription<String>? _autoStoppedSub;
  StreamSubscription<SttStall>? _sttStalledSub;
  StreamSubscription<FlowmicStateSnapshot>? _fsmSub;

  // AW-1b — every handle the health wiring opens (seven subscriptions, the
  // ticker, and the tracker listener) on ONE field, because this file is at
  // the 800-line cap. Set by [wireAsrHealth]; released in `disposeRouted`.
  _AsrHealthHooks? _asrHealthHooks;
  StreamSubscription<double>? _amplitudeSub;
  StreamSubscription<AiComposeEvent>? _aiComposeSub;
  StreamSubscription<SttRefined>? _refinedSub;

  // ── mode + buffer ────────────────────────────────────────────────────
  FlowMode _mode = FlowMode.realtime;
  @override
  FlowMode get mode => _mode;

  /// The manual-send / typed buffer text (composer). Kept here so a mode switch
  /// can clear it (the clear-the-buffer red line).
  String _buffer = '';
  String get buffer => _buffer;

  // ── send policy (R6 T-3a) ────────────────────────────────────────────
  // 08 §5: direct-send (⚡, default) injects the whole utterance the moment the
  // terminal final lands; hold-then-send (➤, manual) accumulates finals in the
  // editable buffer and delivers only on an explicit Send. The choice is a
  // DEVICE-LOCAL habit (local_prefs), and — like delivery/mode — it is
  // SNAPSHOTTED at PTT-down so flipping it mid-utterance cannot change how the
  // sentence already being spoken is delivered (§4.0 B fixed per utterance).

  SendPolicy _sendPolicy = SendPolicy.direct;

  /// The policy the NEXT utterance will use (and what the ➤/⚡ button shows).
  SendPolicy get sendPolicy => _sendPolicy;

  SendPolicy _activeSendPolicy = SendPolicy.direct;

  /// The policy fixed for the utterance currently in flight. Exposed for tests
  /// + the acceptance assertion that a mid-utterance flip is inert.
  SendPolicy get activeSendPolicy => _activeSendPolicy;

  /// Hydrate the persisted policy on boot. Never throws — an unreadable pref
  /// leaves the documented default (direct). Body: same 800-line-cap move as
  /// [pttCancel] (chat_transient_banner_timers.dart header (3)).
  Future<void> loadSendPolicy() => loadSendPolicyRouted(this);

  /// Switch the policy (long-press on the send button). Takes effect from the
  /// NEXT PTT-down; the in-flight utterance keeps its snapshot. Body: same
  /// 800-line-cap move as [loadSendPolicy], and it joins its own family there.
  Future<void> setSendPolicy(SendPolicy next) => setSendPolicyRouted(this, next);

  Future<void> toggleSendPolicy() => toggleSendPolicyRouted(this);

  /// Rows whose finals were folded into the CURRENT buffer under manual-send and
  /// whose delivery truth is therefore still open (⏳). Ordered oldest→newest.
  /// §4.0 A: 「manual-send accumulates multiple segments then sends once: each
  /// utterance becomes its own entry」.
  final List<String> _bufferedEntryIds = <String>[];

  // ── live in-flight draft (the active transcription row) ──────────────
  String _liveText = '';

  /// owner 2026-07-26 ②: the default patience before a chat session concedes
  /// the PC is gone. LONGER than the reconnect ladder's early rungs (1s/2s/4s —
  /// a live server is back within ~5s of a blip, and GA-04's 30s audio grace
  /// rides those early rungs) and far SHORTER than forever, which is what the
  /// page effectively waited before. On LAN the sidecar dies WITH the desktop
  /// app, so a closed PC can never come back on its own — the only honest
  /// destination is the connections list.
  static const Duration kSessionLostAfter = Duration(seconds: 10);

  final Duration sessionLostAfter;

  /// The retry budget owner ruled on 2026-08-19 — one object because it is one
  /// fact. Defined, argued and enforced in `chat_link_watch.dart`.
  final LinkRetryBudget linkRetry = LinkRetryBudget();

  /// Set once the retry budget above is spent with the link still down. The
  /// chat page consumes it exactly once (pop back to the connections list + a
  /// toast); never cleared here — this controller dies with the page it flags.
  bool sessionLost = false;
  Timer? _sessionLostTimer;

  ConnectionState _conn = ConnectionState.disconnected;
  SessionState _sess = SessionState.disconnected;
  ConnectionState get connection => _conn;
  SessionState get sessionState => _sess;

  /// The composer's enable gate (T-3a ③). SAME SOURCE as [canPtt]'s connection
  /// half — a disconnected phone has no PC to type at, so the whole input row
  /// goes inert rather than silently accepting keystrokes that go nowhere.
  ///
  /// It deliberately does NOT inherit canPtt's IDLE half: editing the buffer
  /// while an utterance is in flight is the entire point of hold-then-send.
  @override
  bool get canCompose => _conn == ConnectionState.connected;

  /// The explicit commit gate (➤ / the sheet's footer): something to send, no
  /// delivery already inside the RCA-v3 ack gate (no double-send), no AI
  /// compose run streaming into the buffer right now — and a leg that can
  /// actually commit it:
  ///   · paired PC ([noPcTarget] false): needs the live link ([canCompose]);
  ///     the commit is a delivery (`inject:request`).
  ///   · fixed destination (light-record / cloud instance): NO link term —
  ///     the commit is a LOCAL noted row ([commitNotedLocal]), the same split
  ///     [ImageSendController.canSend] made for pictures first.
  ///
  /// P4 (0.3.1, design SSOT §6): this used to carry `!destination.isFixed`
  /// (reading §4.0 E 「a cloud instance has no focus window, so ➤ stays dead
  /// there」), which held the getter false FOREVER on those sessions while
  /// the FIELD stayed enabled (`_composeFieldEnabled` has no isFixed term) —
  /// the user could type but never commit, and nothing on screen said why.
  /// §4.0 E's fact is untouched (nothing is injected there); what changed is
  /// that the commit now lands where a record-only utterance already lands.
  ///
  /// W2.5-1: the AI-compose term lives HERE, not only at the one call site
  /// that reads this getter (chat_flow_composer.dart), because W5b is about
  /// to rebuild the whole input area and a re-layout is exactly the kind of
  /// change that silently drops a line like `&& !isAiComposing` — nothing
  /// would go red, and ➤ would deliver partial, unvalidated LLM output. A
  /// getter named `canSend` must itself answer "may this be sent", not
  /// require every caller to remember one more AND term.
  bool get canSend =>
      _buffer.trim().isNotEmpty && !delivery.sendPending && !isAiComposing &&
      (noPcTarget || canCompose);

  // ── mode chip ────────────────────────────────────────────────────────
  // All three bodies: chat_mode_chip.dart (moved VERBATIM, RV-92's tag-along
  // split —
  // this section is unrelated to RV-92, purely because this file already hit
  // the 800-line cap). Names stay here so every
  // call site (chat_ui / mode chip widget / tests) is untouched.
  void setMode(FlowMode next) => setModeRouted(this, next);

  // `cycleMode()` stood here until FB-3 Plan A (owner D1, 2026-08-06). It is
  // DELETED, not merely unbound: 「mode is a cyclic toggle」 was pain point 2 itself, the
  // three modes are now a one-tap segmented control (`ModeSegmentedControl`),
  // and a public cycler with zero production callers is the repo's #1 historic
  // bug class (a capability defined with nobody calling it) waiting for someone to re-wire it.

  void setBuffer(String text) => setBufferRouted(this, text);

  /// FB-8: the confirm card's [✕] / [discard]. The user throws away THIS PHONE's
  /// draft; the utterances that fed it keep their rows and settle at 📥 noted
  /// (`_discardBufferedRows`), so nothing said is silently lost.
  ///
  /// 🔴 Deliberately NOT `sendControlKey(ControlKeyKind.clear)`. That one is a
  /// REMOTE key: it wipes the PC's focused window and only clears this buffer
  /// as a side effect (chat_control_keys.dart `runControlKey`). Before FB-8 it
  /// was the only ✕ on screen, so 「discard my draft」 had no entry point that
  /// did not also delete what the user had written on their computer.
  ///
  /// The body is the EXISTING `_clearBuffer()` — the same one a mode switch
  /// runs (aborts a streaming AI run, settles the covered rows, drops the STT
  /// segment cache). FB-8 §2: the presentation was redone, the mechanism was
  /// not invented anew. The `notifyUi()` is here
  /// rather than inside `_clearBuffer` because its other caller
  /// (`runControlKey`) reports 「changed」 upward and notifies itself.
  void discardBuffer() {
    _clearBuffer();
    notifyUi();
  }

  // Both bodies: chat_notices.dart. `_discardBufferedRows` keeps its name here
  // because chat_control_keys.dart calls it by that name.
  void _clearBuffer() => clearBufferRouted(this);

  void _discardBufferedRows() => discardBufferedRowsRouted(this);

  // ── GA-01 utterance transform (translate / organize) ───────────────
  // 01 §3.1: in translate/organize the text that gets injected IS the LLM
  // output. The run lives in utterance_compose.dart, the row handling in
  // chat_utterance.dart; what stays here is the state the page reads.
  //
  // [translateTarget] / [setTranslateTarget] / [loadTranslateTarget] moved to
  // chat_ai_row_surface.dart (card B2-O, 800-line cap) — they read/write this
  // field but implement no interface, so only the FIELD had to stay.

  String _translateTarget = kTranslateTargetDefault;

  /// The last utterance-transform failure, held until dismissed. Deliberately
  /// NOT [aiFailure]: that one means 「your buffer is untouched」, this one means
  /// 「what you just said was NOT delivered」. Different consequences, so they
  /// never share a banner slot.
  AiComposeOutcome? _utteranceFailure;

  /// 🔴 G-20 ③ — WHICH INSTANCE'S SCREEN [_utteranceFailure] is news for.
  /// Written only through [_raiseUtteranceFailure]; see [_autoStoppedInstanceId].
  String? _utteranceFailureInstanceId;

  // [_raiseUtteranceFailure] — G-20 ③'s ONE writer — moved VERBATIM to
  // chat_notice_scope.dart, the file about the scope it stamps.

  @override
  void ucNotify() => notifyListeners();

  @override
  void ucDone(String entryId, String processedText) =>
      _ucDone(this, entryId, processedText);

  @override
  void ucFailed(String entryId, AiComposeOutcome outcome) =>
      _ucFailed(this, entryId, outcome);


  // ── ComposeBand: explicit send + remote control keys (T-3a ①②) ───────
  // All three bodies (➤ / Favorites tap-to-send / the four control keys) moved to
  // chat_explicit_delivery.dart together with deferred redelivery and resend —
  // Lane K, see that
  // file's header for the one mechanical edit and nothing else.

  // ── ManualDeliveryHost (manual_delivery.dart) ────────────────────────
  // ➤, Favorites and album pictures all judge 「can I deliver?」 against these gates rather
  // than a second copy, so the answer always matches what the UI greys out.

  /// §6.2-6 / §4.0 E: a cloud instance has no PC focus window → no inject op.
  @override
  bool get noPcTarget => destination.isFixed;

  /// owner 2026-07-27: null on a cloud instance — there is no PC to name.
  @override
  String? get pcDisplayName => noPcTarget ? null : session.pcDisplayName;

  /// Card M / 🔴 no-crosstalk red line: the `pc_id` every inject:request this
  /// controller emits must be addressed to. Null on a cloud instance (mirrors
  /// [pcDisplayName]) and — separately — whenever [PttSession.pcId] itself has
  /// not been learned yet (see its doc).
  @override
  String? get targetPcId => noPcTarget ? null : session.pcId;

  @override // 🔴 RV-97 (b): same scope as [outboxPending] — see the host contract.
  String? get deliveryInstanceId => session.connectedInstanceId;

  @override
  void deliveryNotify() => notifyListeners();

  // RCA-v3 link-recovery + http-ingress seams; bodies in link_recovery.dart.
  // kickLink runs only after an acked probe proved the link dead — the ladder
  // sees the disconnected edge and rebuilds + rejoins on its own.
  @override
  Future<void> kickLink() => session.transport.disconnect();

  @override
  Future<bool> awaitLinkUp(Duration timeout) =>
      transportLinkUp(session.transport, timeout);

  @override
  LanImageIngress? get lanImageIngress => sessionLanIngress(session);

  // Window B3-2a OutboxDrainHost. Bodies in chat_outbox_host.dart (part file).
  @override
  LiveConnection get liveConnection => outboxLiveConnection(this);

  @override
  Future<bool> ensureLink() => delivery.ensureLink();

  @override
  Future<void> reseedDestination() => outboxReseedDestination(this);

  @override
  Future<bool> send(OutboxItem i, String pc, {required InjectOrigin origin, Uint8List? imageBytes}) =>
      outboxSend(this, i, pc, origin: origin, imageBytes: imageBytes);

  @override
  void onOutboxChanged() => notifyListeners();

  /// Repaint, callable from the `part` files — `notifyListeners` is `@protected`
  /// and a top-level function is not an instance member (chat_notices.dart §2).
  void notifyUi() => notifyListeners();

  // Window C-5 — per-EVENT-type-banner auto-hide bookkeeping. Keyed by
  // [BannerIds]; body in chat_transient_banner_timers.dart. Fields (not just
  // logic) live here because a `part of` file cannot reopen a class — the same
  // constraint every other field on this controller is already subject to.
  final Map<String, Object?> _bannerLastSeen = <String, Object?>{};
  final Map<String, Timer> _bannerAutoHideTimers = <String, Timer>{};

  /// Window C-5 — every producer (delivery/imageSend/aiCompose/the notices part
  /// files/…) already funnels through `notifyListeners` (via `notifyUi` /
  /// `deliveryNotify` / `aiNotify` / `ucNotify` / `onOutboxChanged`, all of
  /// which just call it), so overriding the ONE method underneath all of them
  /// is the single hook point that can reconcile the auto-hide timers without
  /// reaching into every producer individually.
  @override
  void notifyListeners() {
    reconcileBannerAutoHideRouted(this);
    super.notifyListeners();
  }

  // ── Window B3-2b: the queue's USER-VISIBLE surface ───────────────────────────
  // Moved to chat_status_surface.dart (Lane K) — it joins the rest of the
  // fail-loud surface it always belonged to. `resendEntry`, which sat at the end
  // of this section, went to chat_explicit_delivery.dart instead: it is the one
  // member here that puts a frame on the wire.

  // ── AI action row: polish / organize / translate (T-3b ④) ─────────────────────────────
  // The run itself lives in AiComposeController (ai_compose_controller.dart);
  // this is the page-facing face of it. ChatController is the AiComposeHost —
  // it owns the buffer the run transforms.

  @override
  String get aiBuffer => _buffer;

  @override
  set aiBuffer(String value) => _buffer = value;

  @override
  bool get aiCanStart => canCompose;

  @override // 🔴 G-20 ④: same scope as [deliveryInstanceId] — one family, one key.
  String? get aiInstanceId => session.connectedInstanceId;

  @override
  void aiNotify() => notifyListeners();

  @override // 🔴 THE SAME FIELD the PTT path reads, not a second copy of it —
  // `chat_utterance.dart` and `chat_utterance_settle.dart` both send
  // `_translateTarget` on their compose frames. Before 0.3.8 this row sent no
  // target at all and the server defaulted to English, which was invisible while
  // the picker had two entries and became a contradiction the moment it had nine.
  String get aiTranslateTarget => _translateTarget;

  // [aiTask] / [isAiComposing] / [canAiCompose] / [startAiCompose] /
  // [restorableOriginal] / [restoreOriginal] moved to chat_ai_row_surface.dart
  // (card B2-O, 800-line cap) — none of them is required by AiComposeHost, so
  // only the members above (which are) had to stay.

  // ── the five inbound routers ─────────────────────────────────────────
  // Bodies: chat_inbound_routes.dart (a `part` of this library). See that
  // file's header for the cut; every call site is byte-for-byte unchanged.

  // ── long-press actions ───────────────────────────────────────────────
  // Split by intent, one file each (Lane K): deferred redelivery went to
  // chat_explicit_delivery.dart (it re-delivers), while edit / rerun / delete went
  // to chat_row_rewrite.dart (they never do). `_onRefined` travelled with the
  // rewrite family for the same reason.

  // Window C-5: body moved to chat_transient_banner_timers.dart VERBATIM (see its
  // header) to buy room for the fields/override above — `super.dispose()`
  // stays here because `super` is only reachable from inside the class's own
  // method (chat_notices.dart §2 documents the identical constraint for
  // `notifyListeners`).
  @override
  Future<void> dispose() async {
    await disposeRouted(this);
    super.dispose();
  }
}
