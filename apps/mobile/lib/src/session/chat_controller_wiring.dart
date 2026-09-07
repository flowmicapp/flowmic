// Part of chat_controller.dart — the constructor's SUBSCRIPTION WIRING,
// moved out VERBATIM on 2026-09-06 to make room under the file-size cap
// (verify/lint/file-size.mjs SRC_MAX) after today's recovery/durability work
// grew the mother file's imports and fields. Same practice as
// chat_asr_health_wire.dart's own header: take the whole coherent unit out,
// comments and all, rather than compress the reasoning to make room.
//
// An `extension … on ChatController` rather than a top-level function taking
// a receiver (the other shape this tree uses, e.g. recovery_leg_wire.dart) —
// chosen here because every line below already reads as an implicit-`this`
// method body (bare `_finalSub = …`, bare `session.…`), and an extension is
// the only one of the two shapes that keeps that verbatim. `part of` shares
// the library either way, so both shapes can reach `ChatController`'s
// private fields; only the receiver syntax differs.
//
// WHY THIS IS THE RIGHT CUT: the fields these lines populate
// (`_finalSub`/`_interimSub`/`_injectSub`/`_focusSub`/`_autoStoppedSub`/
// `_sttStalledSub`/`_fsmSub`/`_amplitudeSub`/`_aiComposeSub`/`_refinedSub`/
// `_conn`/`_sess`/`deliveryLink`) are declared in the mother file and read
// all over it; this file only ever WRITES them, once, from one call site —
// the last statement of the constructor, `_wireSubscriptions();`.

part of 'chat_controller.dart';

extension ChatControllerWiring on ChatController {
  /// Constructor step 1 — the objects built with `host: this` (moved out of
  /// the literal constructor body for the same file-size-cap reason as
  /// [_wireSubscriptions], and kept as a second method rather than folded
  /// into that one because it needs constructor-local parameters
  /// (`outboxStore`/`outboxBlobs`/`imagePicker`/`clock`) that
  /// [_wireSubscriptions] does not).
  void _buildLateFields({
    required OutboxStore outboxStore,
    required OutboxBlobStore outboxBlobs,
    ImagePickerPort? imagePicker,
    DateTime Function()? clock,
  }) {
    recording = RecordingTelemetry(clock: clock ?? DateTime.now, onTick: notifyListeners);
    aiCompose = AiComposeController(host: this, gate: composeGate);
    utteranceCompose = UtteranceComposeController(host: this, gate: composeGate);
    delivery = ManualDelivery(host: this, gate: composeGate);
    // Built here for the same reason `delivery` is: it needs `host: this`.
    outbox = DeliveryOutbox(store: outboxStore, blobs: outboxBlobs, host: this);
    rowImages = outboxBlobs;
    imageSend = ImageSendController(
      host: this,
      gate: composeGate,
      delivery: delivery,
      picker: imagePicker ?? const PlatformImagePicker(),
      liveChannel: () => session.serverChannel.value, // owner 2026-08-01 cloud policy
      // REQ-12-09 09-I/09-J. THE SAME OBJECT as `rowImages` above and as the
      // outbox's `blobs` — one picture store, three users (the row, the queue,
      // and now the 「+」 panel's send). Passed rather than reached for, so this
      // line is the whole answer to 「where do these bytes come from」.
      rowImages: outboxBlobs,
    );
  }

  void _wireSubscriptions() {
    _finalSub = session.stt.finals.listen(_onFinal);
    _interimSub = session.stt.interims.listen(_onInterim);
    _injectSub = session.injectResults.listen(_onInjectResult);
    _focusSub = session.focusStates.listen(_onFocusState);
    session.pcPresence.addListener(_onPcPresenceChanged); // RV-92, chat_notices.dart
    session.pcBusyListenable.addListener(notifyUi); // Card L7, BannerIds.pcBusy
    // 🔴 F-1 — never the socket edge. Since 2026-09-04 「joined the room」 is one
    // of TWO edges of one fact and the drain subscribes to the FACT
    // ([deliveryLink]); this listener keeps only the pairing confirmation.
    session.roomJoins.addListener(_onRoomJoined);
    deliveryLink = DeliveryLinkUp(roomJoins: session.roomJoins, pcPresence: session.pcPresence);
    deliveryLink.addListener(_onDeliveryLinkUp);
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
    // 🔴 AUD-D F6 / P1-6 (2026-09-02) — the retained-audio store's own header
    // says "callers MUST surface these"; before this line the only listener
    // anywhere was the boot-time diag line (retained_audio_boot.dart), which
    // that file's own comment names as "not yet a screen". Null-safe: a phone
    // whose retention layer failed to open (openRetainedAudioSpill's degrade
    // path) has no store to listen to, and that is an existing, separately
    // surfaced degradation — not this listener's problem.
    session.audio.retainedAudio?.store.lastNotice
        .addListener(_onRetainedAudioNotice);
    // D-1c — the capture-ended edge pays the give-up's postponed ladder stop
    // (chat_link_watch.dart `_stopHeldLadderRouted`). One producer for that
    // edge, two consumers: this and the PC-release exit's re-pull.
    session.captureStopped.addListener(_onCaptureStopped);
    // AW-1b — see chat_asr_health_wire.dart for every call site this wires.
    wireAsrHealth(this);
  }
}
