// Part of ptt_session.dart — `pair()` and the TOFU look-once it depends on.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as ptt_inbound.dart / ptt_presence_poll.dart / ptt_reconnect_ack
// .dart / ptt_wire_keepalive.dart: ptt_session.dart sits at the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX=800), and card D2LAN-B3/B4 grew `pair()`
// by the pin resolution, the TOFU look-once, and the 「指纹不符 ≠ 够不着」
// ("fingerprint mismatch ≠ unreachable") branch.
// Dart has no partial classes, so state stays on the class and only BEHAVIOUR
// moves out — every field these two touch (`transport`, `tokenStorage`,
// `_dialCandidates`, `lanFingerprintLearner`, …) is still declared there.
//
// This family was chosen because it is the largest self-contained one left:
// one public entry point plus its private helper, no new fields, and the only
// caller of `_tofuFingerprintFor` is `pair()` itself.
//
// 🔴 DIFF DISCIPLINE: both bodies are moved **character-for-character**, with the
// one mechanical edit this family always makes — they become extension members,
// so every existing call site (`session.pair(...)`) is untouched.
// **Any other difference in the diff is a bug.**

part of 'ptt_session.dart';

extension PttSessionPair on PttSession {
  /// Connect to [endpoint] and pair with [entry] (short code / QR / cloud
  /// instance). On success the token is persisted and the reconnect ladder
  /// starts. Fail-loud: a rejected/erroring pair returns ok:false with the
  /// server error — never a silent success.
  ///
  /// [jwt] is supplied ONLY for a cloud-instance admission: it rides the socket
  /// handshake (auth.jwt) so the SaaS server can verify identity before minting
  /// the cloud pairing. Standalone pairing leaves it null.
  Future<PairResult> pair(
    PairEntry entry, {
    required String endpoint,
    String? jwt,
  }) async {
    // B4-15 — a QR from a multi-NIC PC carries EVERY address that PC listens on
    // (`alt=`), and the phone picks a reachable one instead of trusting the
    // desktop's ranking. One candidate ⇒ nothing runs (see endpoint_candidates).
    // ── D2LAN-B3/B4 — 「这次配对有没有一把该验的钥匙」
    // ("does this pairing have a key that needs verifying") ─────────────────
    //
    // Two sources, in this order, and NEVER both:
    //   · the QR's `fp=` — established out of band, off the PC's own screen;
    //   · TOFU — nothing told us what to expect, so we look once and remember
    //     (design §3-4a). Only for the paths that CANNOT carry a fingerprint.
    final String? qrPin = entry.fingerprint;
    final String? tofuPin = qrPin != null
        ? null
        : await _tofuFingerprintFor(entry, endpoint);
    final String? pin = qrPin ?? tofuPin;
    final List<String> candidates = pairDialCandidates(
      qrLink: entry.payload.qrPayload,
      endpoint: endpoint,
      pinned: pin != null,
    );
    final EndpointChoice choice = await chooseDialEndpoint(
      candidates: candidates,
      read: healthReader,
      timeout: candidateProbeTimeout,
    );
    final String dial = choice.endpoint.isEmpty ? endpoint : choice.endpoint;
    try {
      await transport.connect(url: dial, jwt: jwt, pinFingerprint: pin);
    } on Object catch (e) {
      // 🔴 D2LAN-B3 — A WRONG KEY IS NOT 「够不着」("unreachable"). Without this branch a
      // mismatch arrives as a `HandshakeException` and takes the same exit as a
      // dead address, so the user is told to check their Wi-Fi about a computer
      // that answered. `dialedPinMismatch` is what makes the two produce
      // different sentences (pairing_strings.dart `pairCandidatesFailed`).
      //
      // ⚠️ It also forces the candidate report on a SINGLE-address pairing,
      // where `attempts` is empty and the old code fell back to
      // 「CONNECT_FAILED: <exception>」 — the raw exception text, which is the one
      // place this distinction would still have been lost.
      final bool mismatch = transport.lastDialPinMismatch;
      // No silent failure: with more than one address in play, 「无法连接到电脑」
      // ("cannot connect to the PC") hides the only thing the user could act
      // on — WHICH addresses were tried and what each one said. The plain code
      // stays for the single-address case, where there is nothing extra to tell.
      return PairResult(
        ok: false,
        error: choice.attempts.isEmpty && !mismatch
            ? 'CONNECT_FAILED: $e'
            : encodeCandidateFailure(
                attempts: choice.attempts,
                dialed: dial,
                dialedPinMismatch: mismatch,
              ),
      );
    }
    dynamic ack;
    try {
      ack = await transport.emitWithAck<dynamic>(
        FlowMicEvents.mobilePair,
        // owner 2026-07-27: pair under 「型号-<4 位设备指纹>」 ("<model>-<4-digit
        // device fingerprint>") so the PC's device
        // list can tell two handsets apart. Read from the warm cache WITHOUT
        // awaiting: naming is cosmetic and must not put a platform round-trip
        // (or a new async ordering) inside pairing. Not yet warmed ⇒ omitted ⇒
        // the server mints its own suffix, exactly as before.
        // v0.2.4: the uid rides the same cache and the same 「never await」
        // rule. It is the field the server keys row reuse on, so sending it is
        // what stops one handset accumulating a row per re-pair.
        entry.payload.toJson(
          mobileName: cachedDeviceLabel(),
          deviceUid: cachedDeviceUid(),
        ),
        timeout: const Duration(seconds: 5),
      );
    } on Object catch (e) {
      return PairResult(ok: false, error: 'PAIR_TIMEOUT: $e');
    }
    if (ack is! Map) {
      return const PairResult(ok: false, error: 'PAIR_BAD_ACK');
    }
    final Object? err = ack['error'];
    if (err is String && err.isNotEmpty) {
      // 🔴 Q2 (2026-08-12) — a restricted account is refused here too, and the
      // ack carries the enumerated reason beside the code. Packed into the code
      // channel because that channel is the only thing that reaches
      // `AppStrings.pairError`; every other code passes through untouched. Same
      // read, same rule, same helper as the reconnect path.
      return PairResult(
        ok: false,
        error: encodeRestrictionReason(err, restrictionReasonOfAck(ack)),
      );
    }
    final Object? token = ack['token'] ?? ack['mobile_token'];
    if (token is! String || token.isEmpty) {
      return const PairResult(ok: false, error: 'PAIR_NO_TOKEN');
    }
    final MobileSession session = MobileSession(
      token: token,
      // 🔴 RV-97 — stored in http(s) form (it also doubles as the base URL for
      // every http request this pairing makes); old rows keep working as-is,
      // the three funnels normalize on the read side (signaling/http_endpoint.dart).
      endpoint: httpBaseOf(dial),
      channel: entry.payload.cloudInstance ? 'saas' : 'standalone',
      // A validated mobile:pair ack is the first successful connection. Unlike
      // resumePairing's pre-ack move-to-front, this is safe to stamp.
      lastConnectedAt: DateTime.now().toUtc(),
      // B4-15 — remembered so a LATER reconnect can fall through to the other
      // NICs. Normalized on the same write side, and for the same reason, as
      // `endpoint` above. Only recorded when there is a real choice to make: a
      // one-element list would just be `endpoint` said twice.
      endpointCandidates: candidates.length > 1
          ? <String>[for (final String c in candidates) httpBaseOf(c)]
          : const <String>[],
      // D2LAN-B3 — a FRESH row, so the constructor is the honest place to set
      // it; `pinLanTls` exists for the rows that already have one and must not
      // have it replaced. Written only after a validated pair ack, i.e. after
      // this key actually carried a successful admission.
      lanTlsFp: pin,
      lanTlsFpSource: pin == null
          ? null
          : (qrPin != null ? LanPinSource.qr : LanPinSource.tofu),
    ).enrichFromAck(ack);
    await tokenStorage.addOrUpdatePairing(session);
    applyPairedIdentity(session);
    final Object? name = ack['pc_name'];
    if (name is String && name.isNotEmpty) connectedDeviceName.value = name;
    _pcPresence.noteAck(ack); // RV-92: `pc_online` has always been on this ack, nobody read it until now
    paired.value = true; _startPresencePoll(); // G-15①: really paired, see ptt_presence_poll.dart
    // F-1: a successful pair and a successful reconnect are the same fact —
    // 「进房了」("joined the room"). Re-pairing the same machine may still have
    // things the queue owes it (the destination is keyed on machine_uid,
    // unaffected by pairing rounds).
    noteRoomJoined();
    unawaited(_refreshServerChannel(dial));
    // The list the LADDER walks is kept in the shape the ladder dials (the QR's
    // ws-urls here, the stored http form in `resumePairing`), because
    // `_resolveReconnectUrl` proves 「current 是这台 PC 的地址之一」 ("current is
    // one of this PC's addresses") by membership.
    // The persisted copy above is normalized instead — two different questions.
    _dialCandidates = candidates.length > 1 ? candidates : const <String>[];
    // D2LAN-B3 — the ladder re-dials this address for the rest of the session,
    // so it needs the same key this one successful dial used. `replacePin: true`
    // for the same reason `replaceToken` is true: pairing a relay instance after
    // a LAN one must CLEAR the previous pin, not inherit it.
    reconnect.configure(
      url: dial,
      token: token,
      replaceToken: true,
      pinFingerprint: pin,
      replacePin: true,
    );
    reconnect.start();
    return PairResult(ok: true, session: session);
  }

  /// D2LAN-B4 — TOFU's first look, for the pairing paths that cannot carry a
  /// fingerprint. `null` = 「这条腿没有身份可记」("this leg has no identity worth
  /// recording"), and the pairing then proceeds in the clear exactly as it did
  /// before — with the diagnostics badge saying so.
  ///
  /// 🔴 THE GATE IS 「有没有二维码」("whether there is a QR code"), NOT 「是不是
  /// 局域网」("whether it is a LAN"), and the difference matters:
  ///   · a QR from a TLS sidecar always carries `fp=` (`buildQrPayload`), so a
  ///     standalone QR WITHOUT one means that sidecar is serving plain and there
  ///     is nothing to learn;
  ///   · a QR with `channel=saas` reaches the relay, which has a REAL CA chain —
  ///     recording its key here would pin a certificate its owner rotates, and
  ///     the next legitimate rotation would lock this phone out of the relay.
  /// Hand-typed addresses and bare 4-digit codes are what is left, and those are
  /// exactly the paths design §3-4 says cannot carry a fingerprint.
  ///
  /// ⚠️ An endpoint the user typed as `https://` is also skipped: they asked for
  /// real TLS by name, and that is the relay case again in manual clothing.
  Future<String?> _tofuFingerprintFor(PairEntry entry, String endpoint) async {
    if (entry.payload.cloudInstance) return null;
    if (entry.payload.qrPayload != null) return null;
    if (endpoint.trim().isEmpty) return null;
    if (isSecureEndpoint(endpoint)) return null;
    final Uri url;
    try {
      url = httpEndpointUri(secureDialUrl(endpoint), '/api/health');
    } on Object {
      return null; // an endpoint we cannot even form a URL from
    }
    return lanFingerprintLearner(url, candidateProbeTimeout);
  }
}
