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

import 'package:flutter/foundation.dart';

import '../destination/destination_controller.dart';
import '../diag/diag_log.dart';
import '../favorites/favorites_store.dart';
import '../ptt/ptt_session.dart';
import '../settings/app_settings.dart';
import '../settings/local_prefs.dart';
import '../signaling/album_away.dart';
import '../signaling/inbound_payloads.dart';
import '../signaling/state_machine.dart';
import 'link_recovery.dart';
import '../signaling/wire_payloads.dart';
import '../stt/segment_buffer.dart';
import '../stt/stt_stream.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import '../timeline/timeline_sync.dart';
// Window C-5: chat_transient_banner_timers.dart names BannerIds so the auto-hide
// key list stays 1:1 with the queue's own ids instead of a second copy of the
// literals.
import '../ui/banner_queue.dart' show BannerIds;
import 'ai_compose_controller.dart';
import 'compose_gate.dart';
import 'delivery_outbox.dart';
import 'outbox_blob_store.dart';
import 'outbox_destination.dart';
import 'outbox_failure_text.dart';
import 'outbox_frame.dart';
import 'outbox_item.dart';
import 'outbox_store.dart';
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

class ChatController extends ChangeNotifier
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
    ComposeGate? composeGate,
    ImagePickerPort? imagePicker,
    DateTime Function()? clock,
    // owner 2026-07-26 ②: how long a dead link may stay dead before the chat
    // page gives up and returns to the connections list. Injectable so tests
    // run on a collapsed window instead of sleeping through the real one.
    this.sessionLostAfter = kSessionLostAfter,
  }) : favorites = FavoritesStore(prefs: localPrefs),
       composeGate =
           composeGate ?? ComposeGate(transport: session.transport) {
    recording = RecordingTelemetry(
      clock: clock ?? DateTime.now,
      onTick: notifyListeners,
    );
    aiCompose = AiComposeController(host: this, gate: this.composeGate);
    utteranceCompose = UtteranceComposeController(
      host: this,
      gate: this.composeGate,
    );
    delivery = ManualDelivery(host: this, gate: this.composeGate);
    // Built here for the same reason `delivery` is: it needs `host: this`.
    outbox = DeliveryOutbox(store: outboxStore, blobs: outboxBlobs, host: this);
    rowImages = outboxBlobs;
    imageSend = ImageSendController(
      host: this,
      gate: this.composeGate,
      delivery: delivery,
      picker: imagePicker ?? const PlatformImagePicker(),
      liveChannel: () => session.serverChannel.value, // owner 2026-08-01 cloud policy
      // REQ-12-09 09-I/09-J. THE SAME OBJECT as `rowImages` above and as the
      // outbox's `blobs` — one picture store, three users (the row, the queue,
      // and now the 「+」 panel's send). Passed rather than reached for, so this
      // line is the whole answer to 「where do these bytes come from」.
      rowImages: outboxBlobs,
    );
    _finalSub = session.stt.finals.listen(_onFinal);
    _interimSub = session.stt.interims.listen(_onInterim);
    _injectSub = session.injectResults.listen(_onInjectResult);
    _focusSub = session.focusStates.listen(_onFocusState);
    session.pcPresence.addListener(_onPcPresenceChanged); // RV-92, chat_notices.dart
    session.pcBusyListenable.addListener(notifyUi); // Card L7, BannerIds.pcBusy
    // 🔴 F-1 — the drain's trigger edge is **joining the room**, not the socket
    // connecting (chat_outbox_host.dart).
    session.roomJoins.addListener(_onRoomJoined);
    // 🔴 W8-3 — the RECEIPT half of the pair `ptt_inbound.dart` writes at the
    // emit. Together they cut the 「the recording stopped on its own and the
    // user was told nothing」 path in two:
    // an `audio.auto_stopped.emitted` with no `.received` after it means the
    // event was dropped on the wire between the two streams; both present with
    // no banner on screen means the fault is above this controller. Neither
    // question could be asked of the 2026-08-10 device round, because the
    // whole path was silent. Instrumentation only — the subscription and the
    // handler are unchanged.
    //
    // 🔴 fix-026 — the stream now carries the WIRE `reason`, so the receipt
    // carries it too. Both W8-3 questions above are answered exactly as before;
    // what is new is that an `.emitted` and a `.received` can now be checked to
    // be about the SAME auto-stop, and a device round can read which ceiling
    // fired without a second instrument.
    _autoStoppedSub = session.autoStopped.listen((String reason) {
      diag('audio.auto_stopped.received', <String, Object?>{'reason': reason});
      // Written BEFORE the flag it belongs to (`_onAutoStopped` sets
      // `_autoStopped`), so no repaint can ever observe 「stopped」 next to the
      // PREVIOUS stop's reason. The pair is only ever read together.
      _autoStopReason = reason;
      _onAutoStopped(null);
    });
    // GA-03: PROCESSING closed with no result (15 s net / terminal stt:error).
    _sttStalledSub = session.sttStalled.listen(_onSttStalled);
    _fsmSub = session.fsm.changes.listen(_onFsmChange);
    // R6 T-5d: the recording panel's amplitude meter reads the DEVICE-side dBFS
    // measured off the captured PCM (08 §3 RMS meter), not the server's stt:level
    // echo — a wire blip must not make the meter claim the mic went silent.
    _amplitudeSub = session.audio.amplitudeDb.listen(_onAmplitude);
    // R6 T-3b ④ buffer runs AND GA-01 utterance runs share the one reply
    // stream. Each run drops any frame whose request_id echo is not its own,
    // so routing to both is exact, not a broadcast guess.
    _aiComposeSub = session.aiComposeEvents.listen(_onAiCompose);
    _refinedSub = session.refinedTexts.listen(_onRefined);
    _conn = session.fsm.connection;
    _sess = session.fsm.session;
    AlbumAway.instance.addListener(_onAlbumAwayChanged); // RV-60
  }

  // Family bodies: chat_notices.dart. NAMES stay here so call sites are untouched.
  void _onAlbumAwayChanged() => onAlbumAwayChangedRouted(this);

  /// The server just put this connection into the room ⇒ now, and only now,
  /// the queue can actually deliver. See F-1.
  void _onRoomJoined() => unawaited(outbox.drain());

  final PttSession session;
  @override
  final TimelineStore store;
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
  late final DeliveryOutbox outbox;

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
  StreamSubscription<double>? _amplitudeSub;
  StreamSubscription<AiComposeEvent>? _aiComposeSub;
  StreamSubscription<String>? _refinedSub;

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

  /// Set once the sustained-disconnect window expires. The chat page consumes
  /// it exactly once (pop back to the connections list + a toast); never
  /// cleared here — this controller dies with the page it flags.
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

  /// ➤ enable gate: connected, something to send, a real PC to send it to
  /// (§4.0 E: a cloud instance has no focus window, so ➤ stays dead there),
  /// no delivery already inside the RCA-v3 ack gate (no double-send), and no
  /// AI compose run streaming into the buffer right now.
  ///
  /// W2.5-1: the AI-compose term lives HERE, not only at the one call site
  /// that reads this getter (chat_flow_composer.dart), because W5b is about
  /// to rebuild the whole input area and a re-layout is exactly the kind of
  /// change that silently drops a line like `&& !isAiComposing` — nothing
  /// would go red, and ➤ would deliver partial, unvalidated LLM output. A
  /// getter named `canSend` must itself answer "may this be sent", not
  /// require every caller to remember one more AND term.
  bool get canSend =>
      canCompose && _buffer.trim().isNotEmpty && !destination.isFixed &&
      !delivery.sendPending && !isAiComposing;

  // Per-utterance snapshot: delivery + mode are FIXED at audio:start and must
  // NOT follow a later destination/mode toggle (§4.0 B).
  String? _activeClientId;
  Delivery _activeDelivery = Delivery.inject;
  FlowMode _activeMode = FlowMode.realtime;
  int _utteranceSeq = 0;

  /// Card D-2 — the row THE MOST RECENT TERMINAL FINAL BUILT, and the only row a
  /// late `stt:refined` is allowed to land on ([_applyRefined]).
  ///
  /// Written at exactly one place (`_handleTerminalFinal`, right after
  /// `store.buildFromUtterance`) because that is the one place in this app that
  /// knows a row was made out of speech. `buildFromUtterance` has FIVE callers
  /// and four of them are not utterances (a picture sent to the PC, a
  /// lightweight-record
  /// picture, a typed ➤ note, a Favorites-phrase tap) — they are indistinguishable from a
  /// spoken row by the fields on `TimelineEntry`, which is precisely why
  /// 「the newest row」 was the wrong answer to 「which row is this refine for」.
  ///
  /// ⚠️ THIS IS NOT A CORRELATION KEY, and it must not grow into one. Nothing on
  /// the wire is being matched: `stt:refined` carries `{text}` and nothing else,
  /// and no utterance id exists on `stt:final` to correlate with (see the
  /// 2026-08-07 correction block on `SttRefinedSchema`). This value answers a
  /// strictly local question — 「did MY last utterance build the row that is
  /// currently on top?」 — so the temporal guess is unchanged and only its blast
  /// radius shrinks. Minting a wire key here would be the same defect one layer
  /// along: a correlation that looks available and is not.
  ///
  /// In-memory only, and deliberately so: a refine can only arrive on the live
  /// socket that carried the utterance, so a value that did not survive a
  /// restart never had a frame to answer.
  String? _lastUtteranceEntryId;

  // WP-R4-6 ⑦: polish-skipped honest signal. Held here (NOT on TimelineEntry)
  // so the five-state status face stays delivery-truth only. The lead's ruling
  // (integration, 2026-07-24): the mark is SESSION-PERSISTENT — it stays on the
  // affected bubble for the whole app session (in-memory only, never persisted),
  // NOT a few-seconds toast; an honest failure signal must not quietly vanish.
  final Set<String> _polishSkippedEntryIds = <String>{};
  /// GA-13: rows whose CURRENT compose run is a reprocess, mapped to the mode
  /// the run was started with. The terminal takes the rewrite fork instead of
  /// the deliver fork — and it must stamp THAT mode, not `_activeMode`, which is
  /// still the last spoken utterance's snapshot (§4.0 B) and can be anything.
  final Map<String, FlowMode> _reprocessingEntryIds = <String, FlowMode>{};
  // `_reprocessWasSynced` lived here: of the in-flight reprocesses, the ones that
  // were already server-synced, because only those got the machine
  // `history:update`. Removed in 0.2.27 with that uplink — a reprocess is now a
  // purely local rewrite of a row this phone owns.

  // R6 P0-R3: fail-loud auto-stop notice. When the server hits the 5-min hard
  // cap (audio:auto-stopped) the recording ends without the user's release —
  // 08 §B-5 forbids this vanishing silently, so we raise a transient page banner.
  // Held here (NOT on TimelineEntry) so the five-state status face stays
  // delivery-truth only; a fresh PTT-down or an explicit dismiss clears it.
  bool _autoStopped = false;

  /// 🔴 G-20 ① — WHICH INSTANCE'S SCREEN [_autoStopped] is news for. Stamped by
  /// the ONE writer (`onAutoStoppedRouted`) at the moment the fact is produced
  /// (§2.5.1 fourth rule), compared through [_noticeOnScreen]. Same scope, same
  /// `null == null` judgement as `ManualDelivery._failureInstanceId` — one scope
  /// for the whole family, not six near-misses (ruling G-20, 2026-08-05).
  String? _autoStoppedInstanceId;

  /// G-20 — 「does this transient notice belong to this screen」. THE one equality judgement for the
  /// six per-instance transient notices this controller family holds; the
  /// stamped value and `session.connectedInstanceId` are the same vocabulary
  /// RV-91/RV-97/B4-18 already compare. ⚠️ `null == null` is a REAL match, not
  /// a wildcard: two cloud instances cannot be told apart, and the honest
  /// disposition is to keep showing the notice rather than swallow it.
  bool _noticeOnScreen(String? stampedInstanceId) =>
      stampedInstanceId == session.connectedInstanceId;

  /// G-20 ① — the gate [ChatStatusSurface.autoStopped] and [autoStopReason]
  /// share, so 「whether the banner is drawn」 and 「whether the reason is
  /// handed out」 can never answer differently.
  bool get _autoStoppedOnScreen =>
      _autoStopped && _noticeOnScreen(_autoStoppedInstanceId);

  // 🔴 fix-026 — WHY it stopped, in the server's own wire vocabulary
  // (`AudioAutoStoppedSchema.reason`). A SECOND value beside [_autoStopped]
  // because it answers a SECOND question: that one says 「the recording stopped
  // on its own」, this one
  // says 「because of what」. Collapsing them (e.g. a nullable reason doubling as the
  // flag) is the repo's #1 bug shape, and the flag has three writers this value
  // must not inherit (`pttDown` / the ✕ / the auto-hide timer).
  //
  // Sole writer: the `session.autoStopped` subscription above, which writes it
  // immediately before raising the flag. `''` = the frame did not say — never a
  // stand-in for a real reason.
  String _autoStopReason = '';

  /// The wire `reason` behind the auto-stop notice **currently on screen**, or
  /// null when there is no such notice.
  ///
  /// 🔴 Gated on [_autoStopped] rather than exposing the raw field: a reason
  /// that outlives the banner it explains is a value describing a fact that is
  /// no longer true, and the three writers that clear the flag would each have
  /// to remember to clear this one too. Gating makes that impossible by
  /// construction instead of by discipline.
  ///
  /// Consumer: `chat_banner_sources.dart` → `buildChatBanners(autoStopReason:)`
  /// → `AppStrings.recordingAutoStoppedMessage`. Declared in the class body
  /// rather than beside `autoStopped` in chat_status_surface.dart only because
  /// that file is outside this card's ownership.
  ///
  /// G-20 ①: gated on [_autoStoppedOnScreen] (not the raw flag) so a reason can
  /// never be handed out for a banner parked on another instance's screen.
  String? get autoStopReason => _autoStoppedOnScreen ? _autoStopReason : null;

  // GA-03: fail-loud "PTT produced nothing" notice. The FSM closed PROCESSING
  // without a terminal stt:final (15 s safety net, or a terminal stt:error).
  // Same shape as [_autoStopped]: transient page state, never a timeline field —
  // the utterance built no row at all (the final never arrived = the utterance
  // never completed), so there
  // is nowhere on the five-state face to put it, and the banner IS the truth.
  // ENG-3: an [SttStall] (reason + wire code/message), not the bare enum, so a
  // NAMED engine refusal reaches the banner instead of dying in this field.
  SttStall? _sttStalled;

  /// 🔴 G-20 ② — WHICH INSTANCE'S SCREEN [_sttStalled] is news for. Stamped by
  /// the ONE writer (`onSttStalledRouted`); see [_autoStoppedInstanceId].
  String? _sttStalledInstanceId;

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

  String _translateTarget = kTranslateTargetDefault;

  /// The translate target language (GA-01 ruling 2). DEVICE-LOCAL like the send
  /// policy — this phone's habit, never a synced settings key. Snapshotted into
  /// compose:start per utterance, so changing it mid-sentence cannot re-aim the
  /// sentence already spoken.
  String get translateTarget => _translateTarget;

  Future<void> setTranslateTarget(String lang) async {
    if (lang.isEmpty || lang == _translateTarget) return;
    _translateTarget = lang;
    notifyListeners();
    await localPrefs.setTranslateTarget(lang);
  }

  /// Hydrate the device-local translate target (called with the other
  /// local-prefs loads at startup).
  Future<void> loadTranslateTarget() async {
    _translateTarget = await localPrefs.translateTarget();
    notifyListeners();
  }

  /// The last utterance-transform failure, held until dismissed. Deliberately
  /// NOT [aiFailure]: that one means 「your buffer is untouched」, this one means
  /// 「what you just said was NOT delivered」. Different consequences, so they
  /// never share a banner slot.
  AiComposeOutcome? _utteranceFailure;

  /// 🔴 G-20 ③ — WHICH INSTANCE'S SCREEN [_utteranceFailure] is news for.
  /// Written only through [_raiseUtteranceFailure]; see [_autoStoppedInstanceId].
  String? _utteranceFailureInstanceId;

  /// G-20 ③ — the ONE writer of [_utteranceFailure], so the value and its
  /// screen stamp are decided in the same statement and can never drift apart
  /// (the `ManualDelivery._raise` precedent). The four raise sites live in
  /// chat_utterance.dart; grep them if this claim ever needs re-checking.
  void _raiseUtteranceFailure(AiComposeOutcome outcome) {
    _utteranceFailure = outcome;
    _utteranceFailureInstanceId = session.connectedInstanceId;
  }

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

  /// The task currently streaming, or null when the row is idle.
  ComposeTask? get aiTask => aiCompose.task;
  bool get isAiComposing => aiCompose.isRunning;

  /// AI-row enable gate. Deliberately NOT gated on [destination] or on a live
  /// PC: compose is a phone↔server round trip that produces TEXT, not a
  /// delivery. Greying it out on a cloud instance would disable something that
  /// demonstrably works there.
  bool get canAiCompose => aiCompose.canStart;

  AiComposeFailure? startAiCompose(ComposeTask task) => aiCompose.start(task);

  /// 🔴 T-6 (owner supplement #5) — the text a successful organize/translate/polish
  /// replaced, or
  /// null. The card draws 「restore original」 iff this is non-null; see
  /// [AiComposeController.restorableOriginal] for the no-stacking rule.
  String? get restorableOriginal => aiCompose.restorableOriginal;

  /// Put that text back into the buffer. The notify rides on the controller's
  /// own `aiNotify`, so the field, the button and the send gate all repaint
  /// from one write.
  bool restoreOriginal() => aiCompose.restoreOriginal();


  void _onAiCompose(AiComposeEvent e) {
    aiCompose.onEvent(e);
    utteranceCompose.onEvent(e);
  }

  // inject:result → ManualDelivery claim + F3 ack→visible + bar retreat.
  void _onInjectResult(InjectResult r) => onInjectResultRouted(this, r);

  // ── focus:state → transient header label ─────────────────────────────
  void _onFocusState(FocusState f) => destination.onFocusApp(f.appLabel);

  // Body: chat_notices.dart (RV-92). Same family as the buffer/notice routes.
  void _onPcPresenceChanged() => onPcPresenceChangedRouted(this);

  // ── connection edges: destination stickiness reset (§4.0 B) ──────────
  void _onFsmChange(FlowmicStateSnapshot s) => onFsmChangeRouted(this, s);

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
