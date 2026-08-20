// Part of ptt_session.dart — THE INBOUND EVENT DISPATCH LOOP.
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// This whole section is **unrelated in itself** to RV-92 / RV-89. It was moved
// out for exactly one reason: ptt_session.dart
// hit the 800-line source-file cap, and both of those cards MUST have their
// rationale text land in this file (the presence-detection criterion, the
// three criteria for channel measurement). The lead's card names the one wrong
// move by name: 「**do not delete comments to shrink the line count**
// — what needs shrinking is **content that does not belong here**, not
// content that is too long」. So what got moved out is one self-contained big
// section.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR, and **there is not a single mechanical
// edit**: this is a `part` file,
// belonging to the same library as ptt_session.dart, so every reference to a
// private member inside the `extension` is **byte-for-byte
// unchanged** (`_injectResultCtl` / `_pcPresence` / `fsm` / `segments` … all
// exactly as before).
// The class keeps `void _onIncoming(EventEnvelope env) =>
// _onIncomingRouted(env);` as a forwarder,
// so the `.listen(_onIncoming)` in the constructor needs not one word changed.
// **Any diff beyond the rename `_onIncoming` → `_onIncomingRouted` is a bug.**

part of 'ptt_session.dart';

extension PttSessionInbound on PttSession {
  // ─────────────────────────────────────────── inbound dispatch

  void _onIncomingRouted(EventEnvelope env) {
    final Object? raw = env.data;
    final Map<String, Object?> data = raw is Map
        ? Map<String, Object?>.from(raw.cast<String, dynamic>())
        : const <String, Object?>{};
    switch (env.name) {
      case FlowMicEvents.sttInterim:
        stt.onInterim(data);
        final SttInterim? p = SttInterim.tryFromJson(data);
        if (p != null) {
          segments.put(idx: p.segmentIdx, text: p.text);
          // N1-B3: retained audio is keyed by the segment the SERVER delimited,
          // and inbound stt frames are the only place this device learns it.
          // Unwired, `RetainedAudioSpill._segmentIdx` stays 0 for the life of
          // the process and every outage in every utterance appends into one
          // file — see that class's header for why the index freezes during an
          // outage (correctly) rather than being invented locally.
          audio.noteSegmentObserved(p.segmentIdx);
        }
        break;
      case FlowMicEvents.sttFinal:
        stt.onFinal(data);
        final SttFinal? p = SttFinal.tryFromJson(data);
        if (p != null) {
          // 🔴 REG-D1 — the duration rides in on the SAME frame that closes the
          // span, and this is the only place it can be banked. `24b75cc` made
          // every final's `duration_ms` mean 「how long this segment is」, so the row's number
          // is now a SUM the buffer keeps (SegmentBuffer._durations); a
          // settlement that copied the terminal final would report the last
          // segment only.
          segments.put(
            idx: p.segmentIdx,
            text: p.text,
            finalized: true,
            durationMs: p.durationMs,
          );
          audio.noteSegmentObserved(p.segmentIdx); // N1-B3, see the interim arm
          // Only the TERMINAL final (is_segment=false) closes the utterance and
          // drives PROCESSING → JUST_DONE; soft-segment finals keep recording.
          if (!p.isSegment) fsm.onSttFinal();
        }
        break;
      case FlowMicEvents.sttError:
        // GA-03 ②: a TERMINAL engine fault (retryable:false) while we are
        // waiting on the final closes PROCESSING immediately — the server has
        // already said no final is coming, so idling out the FSM's 15 s net
        // would just be 15 s of a dead PTT button. A retryable error (engine
        // reconnecting) is left alone: capture continues and the buffered audio
        // is still replayed, exactly the pre-existing behaviour.
        //
        // ── ENG-3 (fix-030) — TWO BREAKS LIVED ON THIS ARM ───────────────────
        // ① `code`/`message` were parsed and thrown away: only `retryable` ever
        //   left this switch, so the banner could say 「the transcription engine reported an error」 at best and
        //   never WHICH refusal (`STT_CONFIG_MISSING` — the named packaging
        //   truth of the P0 LAN empty-transcript account — rendered as nothing).
        //   They now ride into the FSM verbatim and come out on the stall event.
        // ② the `fsm.session == SessionState.processing` clause swallowed every
        //   terminal error that arrived while RECORDING — which is exactly when
        //   a cold-open failure on `audio:start` arrives (moments into the
        //   press). The state decision belongs to the FSM and now lives there:
        //   RECORDING latches the error until the press ends, PROCESSING stalls
        //   immediately, everything else is refused (see onSttTerminalError).
        final SttError? e = SttError.tryFromJson(data);
        if (e != null && !e.retryable) {
          fsm.onSttTerminalError(code: e.code, message: e.message);
        }
        break;
      case FlowMicEvents.sttLevel:
        stt.onLevel(data);
        break;
      // P-8 — this frame was **previously dropped by the default arm the moment
      // it arrived** (it has been in the 54-event whitelist the whole time, the
      // phone side just never had anyone catch it). It is the only real place in
      // this repo where 「the most recently used result + when」 is
      // produced; the criteria, the identity triple, and the off-contract
      // frame-drop rule all live in [LocalEngineStatusStore].
      // Channel / endpoint / PC are all taken **at the instant this frame is
      // received**, not backfilled when the sheet opens — the backfilled
      // version answers 「who is connected right now」, not 「who did that
      // observation belong to」.
      case FlowMicEvents.sttEngineStatus:
        engineStatus.observeFrame(
          data,
          channelIsLan: serverChannel.value == ServerChannel.lan,
          endpoint: reconnect.url ?? '',
          pcId: pcId,
        );
        break;
      case FlowMicEvents.sysPing:
        handleSysPing(transport: transport, data: data);
        break;
      case FlowMicEvents.authExpired:
        unawaited(_authHandler.drain());
        break;
      // owner 2026-08-20 — 「PC 主动断开是终局」. The server says this BEFORE it
      // closes the socket (pc.handler.ts), precisely so this phone can tell
      // 「a person disconnected me」 apart from 「my own network died」 — on the
      // wire the disconnect that follows is byte-identical to a Wi-Fi drop.
      //
      // THE ORDER OF THE THREE MOVES IS THE FIX:
      //   1. record the fact (cooldown deadline + the latch the chat page rides);
      //   2. STOP THE LADDER — before the socket drop arrives, so the drop finds
      //      no ladder to arm. This is the line that ends 49-3's 「comes back at
      //      release + 60.04 s on the dot」: no dial, no PAIR_RELEASED refusal,
      //      no HoldOutRetry re-ask, because nothing ever asks.
      //   3. the page leaves via its own exit (chat_flow_exits.dart), with the
      //      owner's sentence — not via the 10 s session-lost window, which
      //      would say the WRONG sentence 10 seconds too late.
      //
      // ⚠️ An OLD relay never sends this. That phone keeps today's exact
      // behaviour (drop → dial → PAIR_RELEASED → hold-out) — the documented
      // fallback, and the reason the relay deploys before the APK.
      case FlowMicEvents.mobileReleased:
        final Object? budget = data['retry_after_ms'];
        releaseCooldown.note(
          scopeKey: scope.key,
          retryAfterMs: budget is int ? budget : null,
          revoked: data['revoked'] == true,
        );
        unawaited(reconnect.stop());
        diag('pc.released', <String, Object?>{
          'retry_after_ms': budget is int ? budget : null,
          'revoked': data['revoked'] == true,
        });
        break;
      // `audio:resend-request` was dispatched here until 2026-07-31. Deleted
      // with the event: no server has ever emitted one, so this arm — and the
      // seq-range replay behind it — was reachable only in tests. Chunk
      // recovery is unchanged and real: ReconnectCoordinator replays the whole
      // 30 s ring on every reconnect and the server dedupes by seq.
      case FlowMicEvents.audioAutoStopped:
        // Server hit the 5-min hard limit / disconnect: fence local capture so
        // the FSM is not stranded in RECORDING (no silent failure) AND raise a
        // user-visible signal — a recording that stops on its own must be told
        // to the user, never silently vanish (R6 P0-R3 / 08 §B-5 never silent).
        audio.fenceAndStop();
        _stopHeartbeat();
        // R6 T-5d fix: the FSM must LEAVE recording here. The server's hard-limit
        // path (stt-session.ts onAutoStopped → orchestrator handleHardLimit)
        // emits audio:auto-stopped and then flushes a TERMINAL stt:final, but
        // onSttFinal() only accepts PROCESSING — with the FSM left in RECORDING
        // the final was refused, the session stuck in RECORDING forever and PTT
        // stayed dead (canPtt requires IDLE). Capture has genuinely ended and a
        // final is inbound, so this is exactly a release: RECORDING → PROCESSING,
        // and the terminal final then drives PROCESSING → JUST_DONE → IDLE with
        // the transcribed content preserved. No-op if we were not recording (the
        // cap can also fire on a disconnect edge).
        fsm.onPttUp();
        // 🔴 W8-3 — THE EMIT IS RECORDED, AND `has_listener` IS WHY.
        //
        // The 2026-08-10 real-device round measured a 5-minute cap that ended
        // the recording with NO banner, and could not name the broken hop: not
        // one step between here and `buildChatBanners` writes a line, so the
        // only instrument left was a 65-frame screen capture — which can say
        // 「it did not appear」 and nothing about WHY.
        //
        // `isClosed` below is NOT the failure mode this guards. A broadcast
        // controller with no listener at emit time DISCARDS the event and
        // leaves no trace anywhere, which is indistinguishable — from every
        // log, test and screenshot we have — from an arm that never ran. So
        // the fact that decides between those two is written down at the one
        // instant it is knowable.
        //
        // ⚠️ THIS IS INSTRUMENTATION, NOT A FIX: behaviour is byte-for-byte
        // unchanged. It exists so the NEXT device round answers in one read
        // what the last one could not answer at all.
        //
        // 🔴 fix-026 added `reason` to this line and nothing else. Both W8-3
        // facts (`has_listener` / `closed`) are untouched and still decide
        // between the two surviving hypotheses; the new field only says WHICH
        // auto-stop the pair belongs to, which the next device round needs
        // anyway to tell a quota stop from a time ceiling in the same trail.
        //
        // 🔴 fix-026 — THE REASON STOPS BEING THROWN AWAY HERE. `data` is raw
        // JSON (the phone never re-validates inbound frames against the zod
        // schema), so the value is taken as it came and passed on VERBATIM: no
        // enum, no normalisation, no default. A non-String or absent `reason` is
        // an off-contract frame — `AudioAutoStoppedSchema` makes the field
        // required — and it becomes the empty string, which
        // `AppStrings.recordingAutoStoppedMessage` routes to its unknown branch.
        // 🔴 It must NOT become `'hard_limit'`: substituting a plausible cause
        // for an unknown one is the exact defect this card closes, and it would
        // be invisible because the resulting sentence looks perfectly normal.
        final Object? rawReason = data['reason'];
        final String reason = rawReason is String ? rawReason : '';
        diag('audio.auto_stopped.emitted', <String, Object?>{
          'has_listener': _autoStoppedCtl.hasListener,
          'closed': _autoStoppedCtl.isClosed,
          'session': fsm.session.name,
          'reason': reason,
        });
        if (!_autoStoppedCtl.isClosed) _autoStoppedCtl.add(reason);
        break;
      case FlowMicEvents.pcMobileJoined:
        // owner 2026-07-27: this used to set the in-memory notifier ONLY, so a
        // name learned here died with the session. Every other learn point (pair
        // ack, reconnect ack, settings:updated) persists, and the connections
        // list renders from the PERSISTED MobileSession.pcName — so a rename the
        // phone only ever saw through this event left the list showing the name
        // captured when the pairing was first made, forever. Persist it here too;
        // _adoptPcName is idempotent and keeps the pc_id attribution guard.
        final Object? name = data['pc_name'] ?? data['device_name'];
        if (name is String && name.isNotEmpty) {
          // Header updates synchronously (unchanged); persistence rides after the
          // storage read so the LIST agrees with the header on the next visit.
          connectedDeviceName.value = name;
          unawaited(_adoptPcName(data['pc_id'] is String ? data['pc_id'] as String : null, name));
        }
        break;
      // GA-10 (04 §3.7 F-3101): the PC renamed itself. The reconnect ack already
      // carries the latest name as a fallback, but without this the header keeps the
      // old label for as long as the session lives — a rename the user made on
      // the PC and cannot see on the phone reads as「it didn't take effect」.
      // The value is verified against THIS session's pc_id: a phone may be paired
      // to several PCs, and adopting an unattributed name would relabel the wrong
      // machine. Purely a DISPLAY update — the phone never writes this key back
      // (owner's iron rule: only the PC can change the PC's own name), and a local alias still wins on the
      // list because that read-path is alias-first.
      case FlowMicEvents.settingsUpdated:
        if (data['key'] != 'device.pc_name') break;
        final Object? v = data['value'];
        if (v is! Map) break;
        final Object? pcId = v['pc_id'];
        final Object? renamed = v['pc_name'];
        if (renamed is! String || renamed.isEmpty) break;
        unawaited(_adoptPcName(pcId is String ? pcId : null, renamed));
        break;
      // GA-14: a better transcript arriving after the fact. No FSM transition,
      // no status change — just text the chat layer may adopt if the row it
      // belongs to has not been touched since.
      case FlowMicEvents.sttRefined:
        final Object? refined = data['text'];
        if (refined is String && refined.trim().isNotEmpty && !_refinedCtl.isClosed) {
          _refinedCtl.add(refined);
        }
        break;
      case FlowMicEvents.injectResult:
        final InjectResult? r = InjectResult.tryFromJson(data);
        if (r != null) {
          // 🔴 RV-92 — the ONLY path mid-session that actively says 「the PC is
          // gone」 (see that method for the criterion).
          _pcPresence.noteInjectResult(ok: r.ok, error: r.error);
          if (!_injectResultCtl.isClosed) _injectResultCtl.add(r);
        }
        break;
      case FlowMicEvents.focusState:
        final FocusState? f = FocusState.tryFromJson(data);
        if (f != null) {
          _pcPresence.noteFocusState(); // RV-92: only the PC ever produces this frame
          if (!_focusStateCtl.isClosed) _focusStateCtl.add(f);
        }
        break;
      // §3.4 AI buffer operations. These come straight back to THIS socket
      // (compose.handler.ts emits on the sender, never into the room), so there
      // is no PC hop to wait for and no room state to consult here.
      case FlowMicEvents.composeChunk:
        _emitAiCompose(AiComposeChunk.tryFromJson(data));
        break;
      case FlowMicEvents.composeDone:
        _emitAiCompose(AiComposeDone.tryFromJson(data));
        break;
      case FlowMicEvents.composeError:
        _emitAiCompose(AiComposeError.tryFromJson(data));
        break;
      default:
        break;
    }
  }

  /// Publish a parsed AI-compose event. A null parse (off-contract frame) is
  /// dropped here rather than forwarded — the consumer's watchdog is what keeps
  /// a dropped terminal frame from stranding the row.
  void _emitAiCompose(AiComposeEvent? e) {
    if (e == null || _aiComposeCtl.isClosed) return;
    _aiComposeCtl.add(e);
  }

}
