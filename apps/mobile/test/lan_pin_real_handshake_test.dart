// Card C1 (W8-1 follow-up) — does a REAL refused TLS handshake produce the
// pinMismatch fact, on the REAL dial stack?
//
// SPEC-REF:
//   docs/strategy/2026-08-10-w8-real-device-findings.md §2-A (the silent tap)
//   apps/mobile/lib/src/signaling/lan_pinning.dart (the funnel under test)
//   apps/mobile/lib/src/signaling/socket_core.dart `webSocketConnector` wiring
//   test/support/mint_lan_tls_identity.mjs (where the served identity comes from)
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// Every prior test of the mismatch surface drives a transport DOUBLE that
// *says* a mismatch happened (`FakeSocketTransport.lastDialPinMismatch`, or a
// pre-encoded refusal string). lan_pin_enforced_on_every_dial_test.dart's
// header names the trap outright: a test that sets the field itself proves the
// UI repeats the field, not that anybody ever compared a certificate. The
// device line then measured a tap on a rotated-certificate row producing
// NOTHING a user can see, with `CERTIFICATE_VERIFY_FAILED` only in logcat —
// so 「did anyone on a real device ever actually do this comparison」 was an open question.
//
// This file closes the VM half of that question. Nothing here sets a mismatch
// field, fakes a transport, or constructs an exception by hand: a REAL
// `SecureServerSocket` serves a certificate minted by THE PRODUCT'S OWN
// generator (server-core `mintLanTlsIdentity`, spawned at setUpAll — key
// material never enters the repo, which is what the security section and
// lan_pin_trust_funnel_guard_test.dart's ruling require), and the assertions
// read what the PRODUCTION classifier (`PinnedHttpClient._judge`, reached only
// through the TLS stack's own `badCertificateCallback`) recorded about it.
// The last two tests go one layer further and drive `SocketCore` with its
// DEFAULT adapter factory — the real socket_io_client engine, the real
// `webSocketConnector` option plumbing, the real connect_error propagation —
// so suspect (a) from connections_page.dart's `_pinMismatchNotice` doc comment
// (「the real socket.io/TLS dial stack may not classify a refused handshake
// into the pinMismatch fact」) is answered by measurement, not by reading.
//
// 🔴 A MEASURED SIDE-FACT WORTH HANDING TO THE DEVICE LINE: the pinned
// refusal and the system-trust refusal print BYTE-IDENTICAL errors in a given
// run —
//   HandshakeException: Handshake error in client (OS Error:
//   CERTIFICATE_VERIFY_FAILED: <detail>(...handshake.cc:298))
// — because `badCertificateCallback` returning false surfaces the UNDERLYING
// verification error, not a 「user rejected」 one. (The <detail> varies with
// the certificate's shape — 「self signed certificate」 for a plain openssl
// self-sign, 「unable to get local issuer certificate」 for the sidecar's
// minted shape — but never with WHICH arm refused.) So the W8-1 logcat line
// alone cannot tell 「the pin comparison refused it」 from 「the system trust store refused it」; only
// `lastDialPinMismatch` (and the diag trail's `lan.pin outcome=`) can.
//
// ⚠️ What this file CANNOT close: whether the same chain holds on Android
// (dart:io on the VM and on Android share the BoringSSL engine, but the
// platform halves differ), and whether the surface is VISIBLE to a user on a
// real device. The closing proof for W8-1 remains a certificate rotation on a
// real LAN — the device line owns that.
//
// ⚠️ Node is not a new dependency of this suite: `make -C apps/mobile test`
// already requires it for the gen step. Node ≥ 22.6 strips types natively
// behind `--experimental-strip-types`; the pinned dev toolchain (22.22.3,
// CLAUDE.md environment facts) qualifies.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/signaling/lan_pinning.dart';
import 'package:flowmic/src/signaling/lan_tls_fingerprint.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket/web_socket.dart' as ws;

/// A well-formed fingerprint that is NOT the minted one — the rotated-PC shape.
const String kWrongPin = 'AAAAAAAAAAAAAAAAAAAAAAAA';

/// The identity minted for this run, filled by [setUpAll].
late String _certPem;
late String _keyPem;

/// The minted certificate's fingerprint, computed by the PRODUCTION walk over
/// the certificate bytes ([lanTlsFingerprintOfCertificate]) and cross-checked
/// in [setUpAll] against the server generator's own SPKI hash — the same
/// two-implementation agreement lan_tls_pin_test.dart pins on a static sample.
late String _rightPin;

Uint8List _pemToDer(String pem) => base64.decode(
      pem
          .replaceAll(RegExp(r'-----(BEGIN|END) [A-Z ]+-----'), '')
          .replaceAll(RegExp(r'\s'), ''),
    );

/// A real TLS listener presenting the minted identity. It never speaks a byte
/// of application protocol: an accepted connection is destroyed at once, which
/// is enough — every assertion in this file is about the HANDSHAKE.
Future<SecureServerSocket> _startTlsServer() async {
  final SecurityContext ctx = SecurityContext()
    ..useCertificateChainBytes(utf8.encode(_certPem))
    ..usePrivateKeyBytes(utf8.encode(_keyPem));
  final SecureServerSocket server =
      await SecureServerSocket.bind(InternetAddress.loopbackIPv4, 0, ctx);
  server.listen(
    (SecureSocket s) => s.destroy(),
    // A client refusing our certificate surfaces here as a handshake error on
    // the server stream. That is the EXPECTED shape of half these tests.
    onError: (Object _) {},
    cancelOnError: false,
  );
  return server;
}

void main() {
  setUpAll(() async {
    final ProcessResult r = await Process.run(
      'node',
      <String>[
        '--experimental-strip-types',
        'test/support/mint_lan_tls_identity.mjs',
      ],
      runInShell: true,
    );
    expect(r.exitCode, 0,
        reason: 'minting the test identity failed (node is a prerequisite of '
            'this suite — the gen step already needs it): ${r.stderr}');
    final Map<String, Object?> minted =
        jsonDecode(r.stdout as String) as Map<String, Object?>;
    _certPem = minted['certPem']! as String;
    _keyPem = minted['keyPem']! as String;
    _rightPin = lanTlsFingerprintOfCertificate(_pemToDer(_certPem))!;
    // Two implementations, one string — over THIS run's certificate.
    expect(
      _rightPin,
      lanTlsFingerprintOfSpki(base64.decode(minted['spkiDerB64']! as String)),
    );
  });

  group('① the production classifier, driven by a REAL refused handshake', () {
    test(
        'wrong pin ⇒ the dial throws AND the outcome is mismatched — recorded '
        'by _judge inside the TLS callback, not by anything in this test',
        () async {
      final SecureServerSocket server = await _startTlsServer();
      addTearDown(server.close);
      final List<(LanPinOutcome, String?)> outcomes =
          <(LanPinOutcome, String?)>[];
      final Future<ws.WebSocket> Function(Uri,
              {Iterable<String>? protocols, Map<String, String>? headers})
          connector = pinnedWebSocketConnector(
        pin: kWrongPin,
        onOutcome: (LanPinOutcome o, String? observed) =>
            outcomes.add((o, observed)),
      );
      await expectLater(
        connector(Uri.parse('wss://127.0.0.1:${server.port}/')),
        throwsA(anything),
      );
      // ONE handshake, ONE verdict, and it is the verdict of the certificate
      // the server really presented.
      expect(outcomes, hasLength(1));
      expect(outcomes.single.$1, LanPinOutcome.mismatched);
      // The observed fingerprint is the served identity's real one — proof the
      // callback saw the actual certificate rather than failing before it.
      expect(outcomes.single.$2, _rightPin);
    });

    test(
        'calibration: the RIGHT pin on the same server ⇒ outcome verified, '
        'even though the connection then dies at the upgrade', () async {
      // Without this test, ① would also pass for a classifier that answers
      // `mismatched` to every certificate. The server is not a WebSocket
      // server, so the dial still throws — and the outcome must say what the
      // HANDSHAKE did, not what the connection amounted to.
      final SecureServerSocket server = await _startTlsServer();
      addTearDown(server.close);
      final List<LanPinOutcome> outcomes = <LanPinOutcome>[];
      final Future<ws.WebSocket> Function(Uri,
              {Iterable<String>? protocols, Map<String, String>? headers})
          connector = pinnedWebSocketConnector(
        pin: _rightPin,
        onOutcome: (LanPinOutcome o, String? _) => outcomes.add(o),
      );
      await expectLater(
        connector(Uri.parse('wss://127.0.0.1:${server.port}/')),
        throwsA(anything),
      );
      expect(outcomes, hasLength(1));
      expect(outcomes.single, LanPinOutcome.verified);
    });
  });

  group('② the WHOLE real dial stack — SocketCore with its default factory', () {
    test(
        'pinned dial against a rotated certificate ⇒ connect() throws and '
        'lastDialPinMismatch is TRUE on the real socket_io_client engine',
        () async {
      final SecureServerSocket server = await _startTlsServer();
      addTearDown(server.close);
      // 🔴 No adapterFactory: this is the production `sio.io(...)` engine, the
      // `webSocketConnector` option key, and the real connect_error path. If
      // any hop of that plumbing dropped the connector or the flag, this test
      // is the one that goes red.
      final SocketCore core = SocketCore();
      addTearDown(core.close);
      Object? thrown;
      try {
        await core.connect(
          url: 'https://127.0.0.1:${server.port}',
          pinFingerprint: kWrongPin,
        );
      } on Object catch (e) {
        thrown = e;
      }
      expect(thrown, isA<SocketHandshakeException>());
      // Propagation, not expiry: a stack that swallowed connect_error would
      // ALSO end here via the 12 s timeout with the flag correctly set — but
      // then the phone would sit silent for 12 s per tap, which is its own
      // defect. Refusal must arrive as a refusal.
      expect(
        (thrown! as SocketHandshakeException).message,
        isNot(contains('timed out')),
      );
      expect(core.lastDialPinMismatch, isTrue,
          reason: 'the real dial stack must classify a refused pinned '
              'handshake into the pinMismatch fact — this is the exact hop '
              'the W8-1 device reading put in question');
    });

    test(
        'R11 boundary: an UNPINNED https dial refused by the system trust '
        'store throws too, but lastDialPinMismatch stays FALSE', () async {
      // Suspect (b) from connections_page.dart, measured at the transport:
      // with no pin there is no remembered identity, so a certificate refusal
      // is NOT 「the other side changed identity」 and must not produce the pin-mismatch fact.
      // (Which rows can even get here: NOT legacy pairings — those store
      // `http://` and never do TLS (measured on the P30, rdreg 2026-08-10
      // §2-2) — but a hand-typed `https://` endpoint, which
      // `_tofuFingerprintFor` deliberately does not TOFU. Its refusal
      // surfaces as a dial failure, i.e. 「cannot reach」.)
      final SecureServerSocket server = await _startTlsServer();
      addTearDown(server.close);
      final SocketCore core = SocketCore();
      addTearDown(core.close);
      Object? thrown;
      try {
        await core.connect(url: 'https://127.0.0.1:${server.port}');
      } on Object catch (e) {
        thrown = e;
      }
      expect(thrown, isA<SocketHandshakeException>(),
          reason: 'the system trust store must refuse the self-signed cert');
      expect(core.lastDialPinMismatch, isFalse,
          reason: 'no pin ⇒ no identity was ever recorded ⇒ claiming 「that is not '
              'the same PC」 would be a status word with no fact behind it');
    });
  });
}
