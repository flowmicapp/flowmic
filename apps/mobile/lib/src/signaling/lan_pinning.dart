// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3 (pin the SPKI),
//     §3-5 + §6-4 (a wrong fingerprint must fail LOUDLY, and must not degrade into
//     「够不着」 — "cannot be reached"), §4-3 (ONE funnel; the socket seam only on a secure URL)
//   apps/server-core/src/lan-tls/dual-listener.ts (one port answers plain AND TLS,
//     so 「服务器开了 TLS」("the server has TLS on") says nothing about any individual connection)
//
// 🔴 THE ONE PLACE THIS APP CONSTRUCTS AN `HttpClient`.
//
// Before this file there were SIX bare `HttpClient()` constructions
// (instance_probe / pc_presence_probe / image_upload / diag_upload /
// update_check / update_download). Six constructions is six independent answers
// to 「这条连接要不要验对方是谁」("should this connection verify who the other
// side is"), and the failure direction of getting one wrong
// is silent: an unpinned TLS connection looks and behaves exactly like a pinned
// one until the day someone is on the wire. So the decision is not left at the
// call sites — it is a REQUIRED argument here, and every call site has to state
// which of the three it is.
//
// 🔴 THE THREE ARE NOT INTERCHANGEABLE:
//
//   · [HttpTrust.publicCa] — the cloud leg and the official update site. Real
//     hostnames, real CA chain, system trust store. 🔴 PINNING HERE WOULD BE
//     WRONG, not merely unnecessary: it would replace a chain that is renewed by
//     its owner with a constant we ship in a binary, and the first legitimate
//     certificate rotation would take the update channel down. This arm is a
//     plain `HttpClient()` — byte-for-byte today's behaviour.
//
//   · [HttpTrust.pinned] — the LAN leg with a fingerprint this phone remembers.
//     Trusted roots are switched OFF, which is what makes the check
//     UNCONDITIONAL: `badCertificateCallback` fires only for a certificate the
//     default validation REJECTED, so a client with the system store still
//     loaded would skip the callback entirely for a certificate some CA vouched
//     for — and the pin would silently not be enforced on the one input it
//     exists to catch.
//
//   · [HttpTrust.unverifiedProbe] — the reachability probe, and ONLY that.
//     `/api/health` is unauthenticated, carries no token, and its verdict is a
//     CHOOSER, never a gate (endpoint_candidates.dart states this rule for the
//     whole file). Refusing an unknown certificate here would turn
//     「这个地址上有人应答」("someone answers at this address") into 「够不着」
//     ("cannot be reached") and quietly delete the multi-NIC selection feature on
//     every pinned pairing. It sends nothing secret, and it can grant nothing:
//     the authentication happens on the DIAL, loudly, a few lines later.
//     ⚠️ This arm therefore accepts any certificate, so nothing that carries a
//     credential may be built on it. 🔴 NO CHECK IN THIS FILE ENFORCES THAT —
//     the assert in [openHttpClient] is about [pin] alone, and no funnel here
//     mentions credentials at all. What holds the line is structural, and both
//     halves are greppable:
//       (1) every LAN request carrying this pairing's bearer token is built by
//           [openPairingHttpClient] (its only callers: diag/diag_upload.dart,
//           session/image_upload.dart, session/pc_presence_probe.dart), and
//           that function can select only [HttpTrust.publicCa] or
//           [HttpTrust.pinned] — this arm is unreachable through it;
//       (2) grep `HttpTrust.unverifiedProbe`: outside this file it has one call
//           site, `httpHealthRead` in session/instance_probe.dart, which sets
//           no Authorization header.
//     ⚠️ Both are code-reads, not measurements, and they cannot be promoted to
//     measurements: `HttpClient.badCertificateCallback` is SETTER-ONLY in
//     dart:io, so no test can observe which arm a client was given. The guards
//     that ARE observable are pinned by lan_pin_trust_funnel_guard_test.dart.
//
//   · [HttpTrust.learnIdentity] — TOFU's first look, and nothing else. It records
//     the certificate and then REFUSES it, so the handshake dies before one
//     application byte is written. It is a separate arm rather than a flag on the
//     probe because the two differ in the only way that matters: the probe
//     CONTINUES over a connection it did not authenticate, this one never does.
//
// 🔴 WHY A MISMATCH CANNOT JUST THROW. `badCertificateCallback` returning false
// produces a `HandshakeException`, and a phone that cannot see the difference
// between that and a `SocketException` reports 「够不着」("cannot be reached")
// — the exact silent degradation design §3-5 named. So the outcome is RECORDED
// on the client object the caller already holds ([PinnedHttpClient.outcome]),
// per instance and with no global state: every funnel here builds a client,
// uses it, and closes it, so 「这一次」("this particular attempt") can never be
// answered with another request's result. On the socket leg that record is
// what `SocketTransport.lastDialPinMismatch` reports, and it is what turns
// 「够不着」("cannot be reached") into 「对面不是那台电脑」("the other side is
// not that computer") in the pairing copy.
//
// 🔴 WHERE THAT RECORD BECOMES SOMETHING A USER READS — two surfaces, and every
// hop is greppable, because a comment asserting behaviour elsewhere is only as
// true as the anchors it hands you (anti-façade ④):
//   (1) `ptt_pair.dart` / `ptt_session.dart` read `lastDialPinMismatch` in their
//       dial `catch` and pass `dialedPinMismatch:` to `encodeCandidateFailure`
//       (session/endpoint_candidates.dart);
//   (2) `pairing_strings.dart` `pairCandidatesFailed` decodes it and swaps the
//       WHOLE message's face — head, per-address tag and tail — when any address
//       came back `pinMismatch`;
//   (3) it reaches a screen in two places: the add-pairing sheet, and — since
//       card fix-024 (ledger W8-1) — the instance list, where
//       `ui/connections_page.dart` `_isPinMismatch` gives it a PERSISTENT notice
//       rather than a 4 s toast, because a mismatch is a standing condition and
//       not a moment. That card exists because the device line measured this
//       whole chain producing NOTHING a user could see on a real certificate
//       rotation; the copy, the code and the fix are the same ones listed above.
// ⚠️ These are code-reads. What the tests pin is (1)–(3) driven by a transport
// DOUBLE that says a mismatch happened (test/lan_tls_pin_test.dart,
// test/pin_mismatch_surface_test.dart) — PLUS, since card C1, the real
// handshake itself: test/lan_pin_real_handshake_test.dart dials a real
// `SecureServerSocket` (identity minted at run time by server-core's own
// generator) through this connector and through `SocketCore`'s default
// factory, and asserts a wrong pin comes out as `mismatched` /
// `lastDialPinMismatch == true`. What stays unobservable is narrower than
// this note used to claim: `badCertificateCallback` being setter-only means a
// test cannot READ BACK which arm a built client carries — it can, and now
// does, drive the callback through a real TLS peer.

import 'dart:async';
import 'dart:io';

import 'package:web_socket/io_web_socket.dart' show IOWebSocket;
import 'package:web_socket/web_socket.dart' as ws;

import 'lan_tls_fingerprint.dart';

/// Which authentication this connection gets. No default — see the file header.
enum HttpTrust { publicCa, pinned, unverifiedProbe, learnIdentity }

/// What a pinned handshake actually did. Written only from inside a TLS
/// callback, i.e. from the connection itself — never from configuration
/// (design §6-3).
enum LanPinOutcome {
  /// No TLS handshake happened on this connection at all.
  none,

  /// A certificate was presented and its SPKI matched the pin.
  verified,

  /// A certificate was presented and its SPKI did NOT match the pin (or could
  /// not be read, which is refused the same way).
  mismatched,
}

/// An `HttpClient` plus what its handshake turned out to be.
class PinnedHttpClient {
  PinnedHttpClient._(this.client, this._pin);

  final HttpClient client;
  final String? _pin;

  LanPinOutcome _outcome = LanPinOutcome.none;

  /// The fingerprint the peer actually presented. Non-null only once a
  /// certificate has been seen; kept so a mismatch can be DIAGNOSED (「它变成了
  /// 另一把钥匙」 — "it turned into a different key") rather than merely
  /// announced.
  String? observedFingerprint;

  /// What this connection's handshake DID. Read by the socket connector below,
  /// which is the only place a verdict changes behaviour.
  ///
  /// ⚠️ THE THREE HTTP FUNNELS DELIBERATELY DO NOT READ IT, and that is a
  /// judgement, not an omission. A `sawPinMismatch` getter existed here for one
  /// revision of this card with ZERO production callers — the repo's #1 façade
  /// shape — so it was deleted rather than left as a hook someone might mistake
  /// for a working feature. The reason none of them needs it: all three
  /// (presence / image / diagnostics) run only on a LIVE session, i.e. one whose
  /// SOCKET already dialled the same host with the same pin and either verified
  /// it or failed loudly first. A mismatch that reached an http funnel first is
  /// a state we have not observed a path to, and 「不为一个没观测到的状态发明一条
  /// 恢复路」("do not invent a recovery path for a state that has never been
  /// observed") is the rule (0.2.52 ④). If one ever is observed, the evidence is a
  /// `HandshakeException` in the funnel's `detail` with no preceding
  /// `lan.pin outcome=mismatched` in the trail.
  LanPinOutcome get outcome => _outcome;

  bool _judge(X509Certificate cert) {
    observedFingerprint = lanTlsFingerprintOfCertificate(cert.der);
    final bool ok = _pin != null && observedFingerprint == _pin;
    _outcome = ok ? LanPinOutcome.verified : LanPinOutcome.mismatched;
    return ok;
  }

  void close() => client.close(force: true);
}

/// Build the one client for one request.
///
/// [pin] is required exactly when [trust] is [HttpTrust.pinned] and forbidden
/// otherwise — a pin passed to an arm that does not enforce it would be a badge
/// with nothing behind it.
PinnedHttpClient openHttpClient({
  required HttpTrust trust,
  String? pin,
  Duration? connectionTimeout,
}) {
  assert(
    (trust == HttpTrust.pinned) == (pin != null),
    'openHttpClient: a pin is meaningful only on HttpTrust.pinned — on any '
    'other arm it is a badge with nothing behind it. The other direction is '
    'NOT the permissive one: HttpTrust.pinned with a null pin is FAIL-CLOSED. '
    '`PinnedHttpClient._judge` requires `_pin != null` before it can return '
    'true, so that client would refuse EVERY certificate and report a mismatch '
    'about a PC that is fine. This assert is what stops that state from being '
    'built in a debug build; in a release build the assert is gone and _judge '
    'is the only thing left holding it. '
    '(Guards pinned by test/lan_pin_trust_funnel_guard_test.dart; _judge '
    'itself is driven through a real TLS handshake by '
    'test/lan_pin_real_handshake_test.dart.)',
  );
  final HttpClient raw = switch (trust) {
    // System trust store, default validation, no callback: today's behaviour.
    HttpTrust.publicCa => HttpClient(),
    // Trusted roots OFF so the callback is unconditional (file header).
    HttpTrust.pinned ||
    HttpTrust.unverifiedProbe ||
    HttpTrust.learnIdentity =>
      HttpClient(context: SecurityContext(withTrustedRoots: false)),
  };
  if (connectionTimeout != null) raw.connectionTimeout = connectionTimeout;
  final PinnedHttpClient wrapped = PinnedHttpClient._(raw, pin);
  switch (trust) {
    case HttpTrust.publicCa:
      break;
    case HttpTrust.pinned:
      raw.badCertificateCallback = (X509Certificate c, String host, int port) =>
          wrapped._judge(c);
    case HttpTrust.unverifiedProbe:
      // Accepts anything, on purpose and only here. Recorded anyway, so a caller
      // that ever grows a credential shows up as a client whose outcome nobody
      // checked rather than as nothing at all.
      raw.badCertificateCallback = (X509Certificate c, String host, int port) {
        wrapped.observedFingerprint = lanTlsFingerprintOfCertificate(c.der);
        return true;
      };
    case HttpTrust.learnIdentity:
      // Look, then refuse. The `false` is the load-bearing half.
      raw.badCertificateCallback = (X509Certificate c, String host, int port) {
        wrapped.observedFingerprint = lanTlsFingerprintOfCertificate(c.der);
        return false;
      };
  }
  return wrapped;
}

/// The client for a request made AGAINST A PAIRED PC — the three LAN funnels
/// that carry this pairing's bearer token (presence / image upload / diagnostics
/// upload).
///
/// [pin] is the pairing's `MobileSession.lanTlsFp`: non-null ⇒ pinned, null ⇒
/// an unpinned pairing, which is plain `http://` and behaves exactly as it did
/// before this card.
///
/// 🔴 A PIN ON A NON-TLS URL THROWS, for the same reason `SocketCore.connect`
/// refuses it: the alternative is a request that believes it is authenticated
/// travelling in the clear. It is a wiring bug — the endpoint of a pinned
/// pairing is stored as `https://` — and it must not be able to degrade quietly
/// into the behaviour the pin exists to prevent.
PinnedHttpClient openPairingHttpClient({
  required Uri url,
  required String? pin,
  Duration? connectionTimeout,
}) {
  if (pin != null && url.scheme != 'https') {
    throw StateError(
      'lan pinning: refusing to send a pinned request to $url — a pin on a '
      'plain URL can never be checked',
    );
  }
  return openHttpClient(
    trust: pin == null ? HttpTrust.publicCa : HttpTrust.pinned,
    pin: pin,
    connectionTimeout: connectionTimeout,
  );
}

/// TOFU (design §3-4a): what public key does this address present RIGHT NOW?
///
/// 🔴 IT DELIBERATELY FAILS THE HANDSHAKE. The callback records the certificate
/// and returns **false**, so the connection is torn down before a single
/// application byte — including any header we might later be tempted to add — is
/// written. This function learns an identity; it must never be a way to talk to
/// one.
///
/// `null` = no TLS was reachable here (a plain-only sidecar, a dead address, a
/// certificate we cannot parse). Every one of those means 「这条腿没有身份可记」
/// ("this leg has no identity to record"),
/// and the caller then pairs in the clear AND SAYS SO — never silently.
/// The seam for [learnLanTlsFingerprint], so a pairing test can state whether
/// the address had a key to learn without opening a socket.
typedef LanFingerprintLearner = Future<String?> Function(Uri url, Duration timeout);

Future<String?> learnLanTlsFingerprint(Uri httpsUrl, Duration timeout) async {
  final PinnedHttpClient probe = openHttpClient(
    trust: HttpTrust.learnIdentity,
    connectionTimeout: timeout,
  );
  try {
    // Expected to THROW: the callback refuses every certificate. Reaching the
    // next line would mean no TLS happened at all, and there is then nothing to
    // learn — which is exactly what a null return says.
    final HttpClientRequest req = await probe.client
        .getUrl(httpsUrl)
        .timeout(timeout);
    unawaited(
      req
          .close()
          .then<void>(
            (HttpClientResponse r) => r.drain<void>(),
            onError: (Object _) {},
          ),
    );
    return probe.observedFingerprint;
  } on Object {
    // The expected path. `Object`, not `Exception`: RV-89's lesson is that an
    // `ArgumentError` on a bad scheme is an Error and escapes `on Exception`.
    return probe.observedFingerprint;
  } finally {
    probe.close();
  }
}

/// The socket.io `webSocketConnector` for a PINNED dial.
///
/// 🔴 INSTALLED ONLY ON A SECURE URL, and only with a pin (`SocketCore.connect`
/// enforces both). Two reasons, and the second is the one that bites: a
/// connector installed unconditionally would replace the adapter seam the whole
/// test suite drives, and a connector installed on a `ws://` URL would carry a
/// pin that cannot possibly be checked — a badge with nothing behind it.
///
/// [onOutcome] is called with what the handshake DID (the connection's own
/// property), which is what the diagnostics badge reads. A dial that throws
/// before any certificate is seen leaves it at [LanPinOutcome.none], and the
/// badge then says nothing rather than guessing.
Future<ws.WebSocket> Function(
  Uri uri, {
  Iterable<String>? protocols,
  Map<String, String>? headers,
})
pinnedWebSocketConnector({
  required String pin,
  required void Function(LanPinOutcome outcome, String? observed) onOutcome,
}) {
  return (
    Uri uri, {
    Iterable<String>? protocols,
    Map<String, String>? headers,
  }) async {
    final PinnedHttpClient pinned = openHttpClient(
      trust: HttpTrust.pinned,
      pin: pin,
    );
    try {
      final WebSocket socket = await WebSocket.connect(
        uri.toString(),
        protocols: protocols,
        headers: headers,
        customClient: pinned.client,
      );
      onOutcome(pinned.outcome, pinned.observedFingerprint);
      return IOWebSocket.fromWebSocket(socket);
    } on Object {
      onOutcome(pinned.outcome, pinned.observedFingerprint);
      rethrow;
    }
    // NOT closed here: `WebSocket.connect(customClient:)` keeps using this
    // client for the life of the socket, and closing it would drop the
    // connection we just made. The client is collected with the socket.
  };
}
