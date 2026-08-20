// Part of ptt_session.dart — the `mobile:reconnect` round-trip's two callbacks.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (mobile:reconnect on the connected rising
//     edge; AUTH_TOKEN_INVALID → stop + delete the local session)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d
//     (the PC is occupied by another phone — a state-type banner;
//     `PC_BUSY` is its ONLY criterion)
//   session/pc_busy.dart ([PcBusyTracker], the sole writer and its bucketing rules)
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart / ptt_presence_poll.dart: ptt_session.dart sat
// at **exactly 800/800** lines (`verify/lint/file-size.mjs` SRC_MAX=800) before
// card L7, so one more field was a red lint. Doc 15 G-20 records the identical
// situation for `chat_controller.dart` and the identical remedy.
//
// 🔴 DIFF DISCIPLINE: [emitMobileReconnectRouted] is `PttSession
// ._emitMobileReconnect`'s body moved **character-for-character**, with exactly
// two card-L7 edits, both marked "card L7" inline below:
//   ① `onAccepted` clears the PC-busy latch (we are back in the room);
//   ② `onRejected` takes the ack's `error` and is the ONE production writer of
//      that latch.
// **Any other difference in the diff is a bug.**
//
// ⚠️ fix-013 (2026-08-10) added the third and (so far) last such edit, marked
// the same way: `onRejected` hands `_noteHoldOut` the ack's CODE as well as its
// budget, so "answered, no budget" and "never answered at all" stop being the same null. Stated
// here because the sentence above is an absolute one — an edit that leaves it
// unamended turns a true rule into a false one, which is worse than no rule.
//
// ⚠️ Card SEG-2 (2026-08-11) added the fourth, marked the same way: `onAccepted`
// parses the ack's `audio_last_contiguous_seq` into the session's replay
// watermark (`_reconnectAckAudioSeq`). The clause above 「(so far) last」 is
// hereby amended for the same reason fix-013 amended its predecessor.
//
// It is a `part`, not a helper class, so every private member it touches
// (`_pcPresence` / `_pcId` / `_pcMachineUid` / `_authValid` / `_notePcBusy` /
// `_startPresencePoll`) is still this class's own state — not a second,
// disconnected copy of it.

part of 'ptt_session.dart';

/// The two codes for "shut out at the door" (49-2 and 49-3, owner + machine,
/// real device, 2026-08-03) — after the occupying phone exits / after the
/// window from pressing "disconnect" on the PC has passed, **this phone does
/// not recover on its own**.
///
/// This is the action [HoldOutRetry]'s timer calls when it fires: **ask once
/// more whether it can get into the room**. It has to live here rather than in
/// the timer class, because the timer's job is "when to ask again", and "how
/// to ask" is the session's business — the timer should not need to know what
/// transport, token and `mobile:reconnect` look like.
extension PttSessionHoldOutRecheck on PttSession {
  /// The banner: the only criterion is the `PC_BUSY` code. **Do not stuff a
  /// budget in here**, see [_noteHoldOut].
  ///
  /// Card F2 (2026-08-05): the bucket is [SessionScope.key], i.e. the machine when
  /// there is one — the SAME key `pcBusyOnScreen` reads back and the SAME key
  /// `OutboxPendingView.countFor` buckets by. Occupancy was always a property of
  /// the computer (pc_busy.dart's header: desktop `Admission` is process-wide
  /// across both channels), so this is the key finally matching the fact.
  void _notePcBusy(bool busy) =>
      _pcBusy.note(busy: busy, instanceId: scope.key);

  /// The timer: its criterion is "did the server give a budget", unrelated to
  /// whether the banner is drawn.
  ///
  /// 🔴 The split was forced by a real device. The two used to be crammed into
  /// `PcBusyTracker.note`, sharing `busy` as the criterion, so
  /// `PAIR_RELEASED` (which has a 60-second budget but should **NOT** draw the
  /// occupied banner) went down the clear-banner branch and took the timer
  /// down with it ⇒ the phone's socket stays connected but never re-enters the
  /// room, and six minutes later a sent frame still bounces back with
  /// `INJECT_NOT_IN_ROOM`. **One value answering two questions.**
  ///
  /// 🔴 fix-013 (2026-08-10) — and the FIRST thing it has to decide is which
  /// question was asked, because one null used to mean two opposite things.
  /// [code] is the ack's OWN `error`, and null there means 「there was no ack」
  /// — timeout, throw, or a non-Map reply (`mobile_reconnect_flow.dart`, which
  /// states the same rule on [ReconnectRefusal.code] and produces exactly this
  /// shape at its empty-token early return: `onRejected(surfaceTransientFailure,
  /// false, null, null)`).
  ///
  ///   · "the server answered, but gave no budget" ⇒ not one dial. Nothing we
  ///     do gets us in, and `AUTH_TOKEN_INVALID` wants a human, not a timer.
  ///     Unchanged.
  ///   · "we never got an answer at all" ⇒ a bounded re-ask ([HoldOutRetry.noteLostAck]),
  ///     because on this path the socket is still up ⇒ nothing dropped ⇒ the
  ///     reconnect ladder never fires ⇒ without this, NOTHING asks a second
  ///     time and the hold-out loop ends on the first lost ack.
  ///
  /// ⚠️ This decides WHICH QUESTION was asked, not whether it is worth asking
  /// now: [_recheckHoldOut] below still owns "can we ask right now" (link down ⇒ the
  /// ladder's job; no token ⇒ nothing to ask with), and it re-checks both at
  /// fire time, which is the only moment those answers are current.
  void _noteHoldOut(String? code, int? retryAfterMs) {
    if (code == null) {
      _holdOut.noteLostAck(retry: _recheckHoldOut);
      return;
    }
    _holdOut.note(retryAfterMs: retryAfterMs, retry: _recheckHoldOut);
  }

  Future<void> _recheckHoldOut() async {
    // If the socket is down it is not our job: the reconnect ladder owns that
    // path and will re-enter the room itself once it connects (`_fireRejoin`).
    // Dialling again here too would be two things fighting over the same task.
    if (transport.currentStatus != SocketStatus.connected) return;
    final String? token = reconnect.token;
    if (token == null || token.isEmpty) return;
    diag('holdout.recheck', const <String, Object?>{});
    // The result will flow through onAccepted / onRejected again: getting in
    // cancels the timer, still being blocked re-arms it with the server's new
    // budget. **The loop is driven by facts, not by a counter.**
    await _emitMobileReconnect(token);
  }
}

/// The `mobile:reconnect` emit + its two verdict callbacks. Called only from
/// `PttSession._emitMobileReconnect`, which keeps the name (and therefore every
/// call site) exactly where it was.
Future<bool> emitMobileReconnectRouted(PttSession s, String token) =>
    runMobileReconnect(
      transport: s.transport,
      tokenStorage: s.tokenStorage,
      token: token,
      timeout: const Duration(seconds: 5),
      surfaceTransientFailure: false,
      onAccepted: (ack) {
        // 🔴 Card L7 ① — we are back in the room, so whatever was holding it has
        // let go. This is the PRIMARY release path (doc 15 §2.5d, release
        // detection ③) and it
        // costs nothing: the reconnect ladder is already running, so no new
        // poll, no new event and **no protocol change** is needed to notice.
        s._notePcBusy(false);
        s._holdOut.cancel();
        // owner 2026-08-20 — same fact, third holder: being back in the room
        // means the release MOMENT has passed (the deadline half is untouched;
        // getting in early — PC restarted, capsule freed — must not leave a
        // stale eject latched for the page we are about to open).
        s.releaseCooldown.clearLatch();
        // 🔴 F-1 (2026-08-03, real device) — one of [PttSession.roomJoins]'s
        // **two** production writers.
        //
        // ⚠️ fix-013 (2026-08-10) — this line used to say "the ONE writer" and
        // that is measurably false: `grep -n 'noteRoomJoined()' apps/mobile/lib`
        // returns this call site AND `ptt_pair.dart`'s, plus the one-line
        // definition in ptt_session.dart. Two writers is the DESIGN, not a leak
        // — F-1 defines the edge as "entered the room", and a freshly validated
        // `mobile:pair` ack enters the room exactly as a reconnect does; both
        // are already named together in `inject_note_strings.dart`
        // ("`roomJoins`'s two writers (`pair()` success / `onAccepted`)").
        // The cost of the wrong word is specific: someone chasing a
        // double-drain would read "the ONE", stop looking, and never open
        // ptt_pair.dart. (The twin claim in ptt_session.dart is another card's
        // file and is deliberately untouched here.)
        //
        // THIS moment is "can send something now", not the moment the socket
        // connects. The send queue used to drain off the
        // `ConnectionState.connected` rising edge (chat_outbox_host.dart's
        // `onFsmChangeRouted`), an edge about 170ms EARLIER than this one:
        //
        //   04:57:23.187 socket connected
        //   04:57:23.190 emit.inject        handed_to_socket=true   ← that edge drained
        //   04:57:23.352 recv.inject_result ok=false INJECT_NOT_IN_ROOM
        //   04:57:23.356 outbox.settled     state=requeued          ← nobody ever drains it again
        //
        // The server's refusal is **legitimate** (at that instant we truly
        // were not in any room), and after `requeued` nothing ever drains
        // again ⇒ the phone's banner keeps saying "N items still undelivered"
        // forever, and it never fulfils itself. A literal violation of the red
        // line "'undelivered' may only be used when a durable queue actually
        // makes good on it".
        //
        // ⚠️ The exact same defect was already fixed on the audio path
        // (GA-04M: wait for `mobile:reconnect`'s ack before sending chunks).
        // **The lesson from that fix never propagated to the second path** —
        // that fix was made locally at its call site, and never turned
        // "entered the room" into a fact anything could subscribe to.
        // ⇒ Rule: **when fixing a defect that fired "one beat too early", ask
        // "who else needs that same 'slightly later' fact".**
        //
        // A counter, not a bool: subscribers want the **edge** ("entered the
        // room again"), and a bool that stays true forever notifies nobody on
        // the second room entry.
        s.noteRoomJoined();
        s.paired.value = true;
        s._startPresencePoll(); // G-15①: resumePairing()+ladder
        if (ack is Map) {
          final Object? name = ack['pc_name'];
          if (name is String && name.isNotEmpty) {
            s.connectedDeviceName.value = name;
          }
          // RV-92: the reconnect ack answers "is there a PC in the room right now" too — the ladder
          // re-asks it on every rung, so this is the one moment presence RECOVERS
          // without the user having to speak first.
          s._pcPresence.noteAck(ack);
          // Card M: refresh [_pcId] to the ack's OWN value on every reconnect (not
          // just the first), the same freshness [enrichByToken] already gives the
          // persisted copy — a stale in-memory id would silently outlive a pairing
          // that server-side got re-keyed.
          final Object? pcId = ack['pc_id'];
          if (pcId is String && pcId.isNotEmpty) s._pcId = pcId;
          final Object? machineUid = ack['pc_machine_uid']; // gate 2, cf. `_pcId`.
          if (machineUid is String && machineUid.isNotEmpty) {
            s._pcMachineUid = machineUid;
          }
          // 🔴 Card SEG-2 (edit ④) — the ring-replay watermark, parsed with the
          // schema's own bounds (int ≥ -1, protocol-schemas-auth.ts
          // MobileReconnectAckAudioFieldsSchema). Anything else — absent,
          // non-int, out of range — is null = FULL replay: the trim may only
          // remove chunks the server has STATED it observed (design §2-R5,
          // fail toward duplication, never loss). `_onReconnected` already
          // reset the field for this span, so a rejected or timed-out attempt
          // never inherits a previous span's watermark.
          final Object? audioSeq = ack['audio_last_contiguous_seq'];
          s._reconnectAckAudioSeq =
              (audioSeq is int && audioSeq >= -1) ? audioSeq : null;
        }
      },
      onRejected: (surface, invalid, error, retryAfterMs) {
        if (invalid) {
          s._authValid = false;
          s.paired.value = false;
        }
        // 🔴 L-② (2026-08-02) — keep the server's ANSWER, verbatim, budget and
        // all. `resumePairing` returns a bare `bool`, so without this the code
        // the server took the trouble to name dies right here — and the caller
        // used to invent 'AUTH_TOKEN_INVALID' in its place, telling the user to
        // re-pair a pairing that `mobile_reconnect_flow.dart:75` had just proven
        // valid and deliberately kept. The server's own comment
        // (`mobile.handler.ts:214-215`) predicted that exact consequence by name.
        s.lastReconnectRefusal =
            ReconnectRefusal(code: error, retryAfterMs: retryAfterMs);
        // 🔴 Card L7 ② — THE ONE PRODUCTION WRITER of the PC-busy latch.
        //
        // Keyed on the server's OWN named code (`PC_BUSY`, mobile.handler.ts),
        // never inferred from a delivery failure: `INJECT_NOT_IN_ROOM` and
        // friends have half a dozen other causes, and inferring from them would
        // pop "another phone is occupying it" on a plain outage — one value
        // answering two questions.
        //
        // ⚠️ ANYTHING ELSE CLEARS IT, a null `error` (timeout / no ack) included.
        // The banner claims "another phone IS CURRENTLY connected to this
        // computer", a statement about NOW; once we can no longer see that,
        // keeping it up is exactly the "carry over the previous answer when
        // unable to ask" mistake doc 15 §1.4.1 bans for `PcPresence`. The
        // queue's own "N items still undelivered" still covers the honest half.
        //
        s._notePcBusy(error == 'PC_BUSY');
        // 🔴 49-2 / 49-3 — the budget is handed over too, **unrelated to
        // whether the banner is drawn**. Previously it was only stored into
        // `lastReconnectRefusal` for the UI to look at, and **nothing
        // consumed it**: the server said "retryable, come back in 8 (or 60)
        // seconds", and the phone read that sentence and then dropped it.
        // While shut out at the door the socket is usually still connected ⇒
        // the reconnect ladder (pure connection layer) will never ask again
        // for us, and the other side leaving produces no TCP event either ⇒
        // the user's only recourse is to back out to the instance list and
        // tap back in. A fact was passed down, then dropped — the third
        // instance of that L-② shape.
        //
        // 🔴 fix-013 — the CODE goes with it now. Passing the budget alone left
        // one null standing for both "answered, no budget" and "never answered at all", and the
        // second of those is the case in which nobody else will ever ask again.
        // See [PttSessionHoldOutRecheck._noteHoldOut] for the split.
        s._noteHoldOut(error, retryAfterMs);
        diag('reconnect.refused', <String, Object?>{
          'code': error, 'retry_after_ms': retryAfterMs, 'invalid': invalid,
        });
      },
    );
