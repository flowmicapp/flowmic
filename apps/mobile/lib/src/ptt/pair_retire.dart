// 800-line cap: `retirePairing`'s body moved VERBATIM out of ptt_session.dart
// (the same move `PairResult` made). It was already 「deliberately isolated from
// the live session」 — it dials its own socket, asks, and hangs up — so it was
// the one method that owed the class nothing. PttSession keeps a two-line
// delegate; the argument below is untouched.

import '../auth/token_storage.dart';
import '../../generated/flowmic_events.g.dart';
import '../signaling/http_endpoint.dart' show secureDialUrl;
import '../signaling/socket_core.dart';
import '../signaling/wire_payloads.dart';

/// v0.2.3 — RETIRE this pairing on its own server (`mobile:unpair`).
///
/// owner 2026-07-29: deleting an entry used to drop the local token only, so
/// the server's row lived forever and the PC kept listing a phone the user had
/// removed. This is the other half.
///
/// Connects with [pairing]'s OWN token, because the server authorises by the
/// socket's identity — the row it deletes is exactly this one, and no id needs
/// to cross the wire. Returns whether the server acknowledged; the caller
/// removes the local entry either way and SAYS so when this was false.
///
/// Deliberately isolated from the live session: it dials, asks, and hangs up.
/// Retiring a pairing the user is not currently on must not disturb the one
/// they ARE on.

Future<bool> retirePairingOn(
SocketTransport probe,
MobileSession pairing,
) async {
  if (pairing.endpoint.isEmpty || pairing.token.isEmpty) return false;
  // 🔴 D2LAN-B3 — THE FOURTH DIAL, and the one that had no pin.
  //
  // This socket is isolated from the live session, so it is also isolated from
  // everything the live session learned — including this pairing's key. Dialling
  // a pinned sidecar without it cannot complete the TLS handshake at all (no
  // `webSocketConnector` ⇒ system trust store ⇒ self-signed cert rejected), so
  // `mobile:unpair` failed for EVERY pinned pairing: the local row went away, the
  // server's row lived on, and the PC kept listing a phone the user had removed
  // — which is the exact bug v0.2.3 added this function to fix, re-opened for
  // pinned pairings only.
  //
  // The stored endpoint of a pinned row is already `https://` (`httpBaseOf` of
  // the `wss://` it paired on), so `secureDialUrl` is a pass-through here; it is
  // applied for the reason ReconnectCoordinator._dial states — a pin on a plain
  // url is REFUSED by `SocketCore.connect`, and this function's `on Object`
  // would turn that refusal into an indistinguishable 「the server didn't answer」.
  final String? pin = pairing.lanTlsFp;
  final String dial = pin == null
      ? pairing.endpoint
      : secureDialUrl(pairing.endpoint);
  try {
    await probe.connect(url: dial, token: pairing.token, pinFingerprint: pin);
    final Object? ack = await probe.emitWithAck<dynamic>(
      FlowMicEvents.mobileReconnect,
      MobileReconnectPayload(pairing.token).toJson(),
      timeout: const Duration(seconds: 5),
    );
    // The unpair is authorised by the socket's AUTH, which only exists after a
    // successful reconnect — an unauthenticated socket must not be able to
    // delete a row by guessing.
    if (ack is! Map || ack['error'] != null) return false;
    final Object? done = await probe.emitWithAck<dynamic>(
      FlowMicEvents.mobileUnpair,
      const <String, Object?>{},
      timeout: const Duration(seconds: 5),
    );
    return done is Map && done['ok'] == true;
  } on Object {
    return false; // unreachable / refused IS the answer, never a swallow
  } finally {
    await probe.disconnect();
  }
}

