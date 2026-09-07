// Part of ptt_session.dart — the stored-pairing resume / reconnect-dial family.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_wire_keepalive.dart / ptt_reconnect_ack.dart / ptt_edges
// .dart: ptt_session.dart sits at the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX=800) and Dart has no partial classes, so the fields these methods
// read and write (`lastReconnectRefusal`, `_reconnectAckAudioSeq`,
// `_dialCandidates`, `candidateProbeTimeout`) stay declared on the class in
// ptt_session.dart — only BEHAVIOUR moves out.
//
// This family was chosen because it is self-contained end to end: the whole
// "reconnect from a stored pairing" path — `_adoptPcName` (a name pushed by
// the PC), `resumeFromStorage` / `resumePairing` (the dial + admission), the
// ladder's own resolver `_resolveReconnectUrl`, and its rising-edge hook
// `_onReconnected` — with no caller anywhere else that this move needed to
// touch. `applyPairedIdentity` / `clearConnectedInstance` came along too:
// they are the identity write/clear pair `resumePairing` (and `pair()`) and
// `connections_controller.leaveRoom()` drive.
//
// 🔴 DIFF DISCIPLINE: every body is moved **character-for-character**. Five
// of the seven become extension members (`_adoptPcName`, `resumeFromStorage`,
// `resumePairing`, `_resolveReconnectUrl`, `_onReconnected`) — every existing
// call site (`resumePairing()` from `connections_controller.dart`,
// `_adoptPcName(...)` from ptt_inbound.dart, and the `onReconnected:
// _onReconnected` / `dialUrlResolver: _resolveReconnectUrl` tear-offs in this
// class's own constructor) is untouched either way.
//
// `applyPairedIdentity` / `clearConnectedInstance` are the exception: they
// stay REAL instance methods on `PttSession` (thin wrappers, exactly
// `_emitMobileReconnect`'s own pattern from ptt_reconnect_ack.dart — a routed
// top-level function, not an extension). `test/g20_instance_bucket_test.dart`
// calls both under `import '…/ptt_session.dart' show PttSession;`, and a
// `show` combinator hides every OTHER top-level declaration in the library —
// including an extension's name — so an extension member is invisible there
// while a real instance method is not. **Any other difference in the diff is
// a bug.**

part of 'ptt_session.dart';

/// See the file header: `applyPairedIdentity` must stay visible under a bare
/// `show PttSession` import, so its body lives here as a routed top-level
/// function (not an extension member) and `PttSession.applyPairedIdentity` is
/// a thin wrapper that calls it.
void applyPairedIdentityRouted(PttSession s, MobileSession session) {
  s._authValid = true;
  s._lanPin = session.lanTlsFp;
  s._lanPinSource = session.lanTlsFpSource;
  s._connectedInstanceId = session.connectionIdentity;
  s._pcId = session.pcId;
  s._pcMachineUid = session.pcMachineUid; // gate 2: the SAME ack as `_pcId`.
  s._channel = session.channel; // G-15①: same ack, see the field's doc.
  // card F2: same ack again — the read scope is learned where the identity is.
  s.scope.note(session: session, storage: s.tokenStorage);
}

/// See [applyPairedIdentityRouted]'s doc — same reason, same shape.
void clearConnectedInstanceRouted(PttSession s) {
  // card L7 — the user left this instance on purpose; 「另一台手机占着**这台**
  // 电脑」("another phone is occupying **this** PC") is a statement about a
  // session that no longer exists. Cleared BEFORE the id it is bucketed by,
  // so the two can never disagree.
  s._notePcBusy(false); // extension member: Dart requires an explicit this
  s.scope.clear(); // card F2: exact inverse of applyPairedIdentity's note().
  s._connectedInstanceId = null;
  s._pcId = null;
  // Stale machine identity would let a delivery frozen for A pass the queue's
  // check on B. Clearing fails CLOSED.
  s._pcMachineUid = null;
  // D2LAN-B3: a pin belongs to ONE pairing. Left behind, it would be handed to
  // the next pairing's http funnels, which refuse it against a plain URL and —
  // worse — would check the previous PC's key against this one. Fails closed:
  // null means 「treat as unpinned」, i.e. today's behaviour.
  s._lanPin = null;
  s._lanPinSource = null;
  s._channel = null; // G-15①: fails toward a no-op poll tick, not a wrong answer.
  s.connectedDeviceName.value = '';
  // The channel label describes a LIVE connection. Keeping it past the end of
  // that connection is how a stale chip outlives the thing it was about.
  s.serverChannel.value = null;
  // RV-89 ③: drop 「which endpoint this measurement is about」 together with
  // it, otherwise reconnecting to the same address next time would be
  // judged 「the endpoint didn't change」 and skip the clear — treating an
  // already-void answer as still valid.
  s._serverChannelEndpoint = null;
  // B4-15, same reasoning one layer over: a list of 「this PC's other
  // addresses」 is a fact about the pairing that just ended.
  // `_resolveReconnectUrl` already refuses to act on a list the current
  // url is not in, so this is belt on top of braces — but a stale address
  // set near the id-cross-wiring red line earns both.
  s._dialCandidates = const <String>[];
  s._pcPresence.noteLinkNotLive(); // RV-92/R3: by the same reasoning, presence
  // too is a statement 「said by this connection」
  s._stopPresencePoll(); // G-15①: a deliberate departure doesn't wait for a
  // socket-disconnect event to turn it off.
}

extension PttSessionResume on PttSession {
  /// GA-10 — adopt a rename pushed by the PC we are actually talking to.
  /// Ignores a frame whose `pc_id` names a different machine; persists so the
  /// list shows the new name after a restart too.
  Future<void> _adoptPcName(String? pcId, String name) async {
    final MobileSession? current = await tokenStorage.readSession();
    if (current == null) return;
    if (pcId != null && current.pcId != null && current.pcId != pcId) return;
    connectedDeviceName.value = name;
    await tokenStorage.addOrUpdatePairing(current.copyWith(pcName: name));
  }

  /// Reconnect from the most-recent stored pairing on boot. Returns false when
  /// no session is stored.
  Future<bool> resumeFromStorage() async {
    final MobileSession? session = await tokenStorage.readSession();
    if (session == null) return false;
    return resumePairing(session);
  }

  /// Connect to [session]'s endpoint and rejoin by token (mobile:reconnect) — the
  /// path the connections list drives when the user taps a remembered PC (Option
  /// B: startup does NOT auto-connect; a tap does). Fail-loud: a bad endpoint or a
  /// rejected token returns false, and [lastReconnectRefusal] says WHY in the
  /// server's own words. ⚠️ Only an `AUTH_TOKEN_INVALID` reject purges the local
  /// session inside the reconnect flow — a hold-out (`PAIR_RELEASED` / `PC_BUSY`)
  /// deliberately keeps the token, so the caller must not treat the two alike.
  Future<bool> resumePairing(MobileSession session) async {
    lastReconnectRefusal = null; // never answer this attempt with the last one's
    if (session.endpoint.isEmpty) return false;
    // B4-15 — after a network change, if the original address is unreachable,
    // fall back to this PC's other address. The stored endpoint leads
    // (it is where a connection last really succeeded), so an unchanged network
    // picks the same address again and nothing is rewritten.
    final List<String> candidates =
        rememberedDialCandidates(session.endpoint, session.endpointCandidates);
    final EndpointChoice choice = await chooseDialEndpoint(
      candidates: candidates,
      read: healthReader,
      timeout: candidateProbeTimeout,
    );
    final String dial = choice.endpoint.isEmpty ? session.endpoint : choice.endpoint;
    try {
      await transport.connect(
        url: dial,
        token: session.token,
        // D2LAN-B3 — a remembered pairing dials under the key it remembers. Null
        // for an unpinned row, which is every pre-D2-LAN pairing and every relay
        // one, and then this call is byte-for-byte the old one.
        pinFingerprint: session.lanTlsFp,
      );
    } on Object {
      // 🔴 D2LAN-B3 — 「the other side rotated its key」 must not arrive as
      // 「unknown error」 either.
      // Reported through the SAME loud-candidate channel `pair` uses, so there is
      // one sentence for one fact rather than a second wording that can drift.
      if (transport.lastDialPinMismatch) {
        lastReconnectRefusal = ReconnectRefusal(
          code: encodeCandidateFailure(
            attempts: choice.attempts,
            dialed: dial,
            dialedPinMismatch: true,
          ),
        );
        return false;
      }
      // PC unpaired ⇒ the handshake itself is refused, there is no ack to read,
      // and the answer is on lastConnectError (see [handshakeRefusal]).
      // Previously this just returned false, so the UI said 「unknown error」.
      lastReconnectRefusal = handshakeRefusal(transport);
      return false;
    }
    // The row is keyed on the PC's instance id, not on its address, so this
    // UPDATES the remembered pairing rather than forking a second one.
    final MobileSession live =
        dial == session.endpoint ? session : session.copyWith(endpoint: dial);
    applyPairedIdentity(live);
    // Tapped PC → most-recent resume target (move-to-front, same identity).
    await tokenStorage.addOrUpdatePairing(live);
    final String? name = live.pcName;
    if (name != null && name.isNotEmpty) connectedDeviceName.value = name;
    unawaited(_refreshServerChannel(dial));
    _dialCandidates = candidates.length > 1 ? candidates : const <String>[];
    reconnect.configure(
      url: dial,
      token: live.token,
      replaceToken: true,
      // D2LAN-B3 — the SAME key this dial just succeeded under. Without it the
      // ladder re-dialled unpinned, which on a pinned pairing cannot connect at
      // all (see ReconnectCoordinator._pin) — so one drop ended the session
      // until the user tapped this PC again by hand.
      pinFingerprint: live.lanTlsFp,
      replacePin: true,
    );
    reconnect.start();
    return _emitMobileReconnect(live.token);
  }

  Future<String?> _resolveReconnectUrl(String current) => resolveLadderUrl(
    current: current,
    known: _dialCandidates,
    read: healthReader,
    timeout: candidateProbeTimeout,
  );

  Future<void> _onReconnected() async {
    // SEG-2 — every ring replay is chained on THIS future (`_fireRejoin`), so
    // start from 「no watermark」 and let this attempt's ack supply one. This
    // one line covers the empty-token early return below, every rejected /
    // timed-out attempt, and staleness across recordings, in the safe
    // direction (null = full replay).
    _reconnectAckAudioSeq = null;
    final String? token = reconnect.token;
    if (token == null || token.isEmpty) return;
    // RV-89 ①: re-ask on every reconnect, so a probe that failed once (a dead
    // moment, a `ws://` endpoint on a pre-fix build) is not a life sentence of
    // 「channel unknown」 for the whole session. Fire-and-forget for the same reason the
    // pair/resume calls are: the label is not a precondition for talking.
    final String? url = reconnect.url;
    if (url != null && url.isNotEmpty) unawaited(_refreshServerChannel(url));
    final bool ok = await _emitMobileReconnect(token);
    // B4-15 — the ladder may have healed onto a different NIC of the same PC.
    // Persisted only after the token was ACCEPTED there: a dial that connects
    // proves nothing about admission, and writing the address down earlier is
    // the same mistake `resumePairing`'s own comment warns about.
    if (ok && url != null && url.isNotEmpty) {
      await persistDialedEndpoint(storage: tokenStorage, token: token, url: url);
    }
  }
}
