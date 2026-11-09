// FR-M2 / D-MKT-3 — the two facts the manual pairing fix rests on, measured on the
// REAL dial stack against a REAL certificate minted by the product's own generator.
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §3.2
// 「配对表单里的 https:// 地址，证书验证不过」; lan_pin_real_handshake_test.dart (the
// sister file; same rig, and its header explains why no transport double appears).
//
// 🔴 THE SECURITY PROPERTY THIS FILE PINS. The fix must not make a typed `https://`
// succeed by any route: not by falling back to plain, not by learning the certificate
// on first use. It may only change WHAT THE USER IS TOLD. The other test measures that
// the address WITHOUT a scheme gets to pinned TLS, which is why the sentence can send
// them there without sending them to the clear.
//
// ⚠️ These listeners speak no socket.io: every accepted connection is destroyed. So a
// successful TLS dial still ends in a connection error here, which is expected; the
// assertions are on what the TLS layer decided, never on a completed pairing.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

late String _certPem;
late String _keyPem;

Future<SecureServerSocket> _startTlsServer() async {
  final SecurityContext ctx = SecurityContext()
    ..useCertificateChainBytes(utf8.encode(_certPem))
    ..usePrivateKeyBytes(utf8.encode(_keyPem));
  final SecureServerSocket server =
      await SecureServerSocket.bind(InternetAddress.loopbackIPv4, 0, ctx);
  server.listen(
    (SecureSocket s) => s.destroy(),
    onError: (Object _) {},
    cancelOnError: false,
  );
  return server;
}

/// A production session: real `SocketCore`, real TOFU learner, real candidate
/// picker. Only the microphone and the token store are in-memory.
PttSession _realSession(SocketCore core, TokenStorage storage) => PttSession(
      transport: core,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      tokenStorage: storage,
      retireTransport: () => FakeSocketTransport(),
    );

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
    expect(r.exitCode, 0, reason: 'minting the test identity failed: ${r.stderr}');
    final Map<String, Object?> minted =
        jsonDecode(r.stdout as String) as Map<String, Object?>;
    _certPem = minted['certPem']! as String;
    _keyPem = minted['keyPem']! as String;
  });

  test('a typed https:// to a sidecar certificate is refused, says so by name, and '
      'nothing downgrades or learns it', () async {
    final SecureServerSocket server = await _startTlsServer();
    addTearDown(server.close);
    final SocketCore core = SocketCore();
    final InMemoryTokenStorage storage = InMemoryTokenStorage();
    final PttSession session = _realSession(core, storage);
    final LoginController login = newTestLogin(transport: session.transport);
    final ConnectionsController c = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: 'https://relay.example.test',
    );

    final ConnectOutcome out = await c.addByCode(
      rawEndpoint: 'https://127.0.0.1:${server.port}',
      code: '1234',
    );

    expect(out.success, isFalse);
    expect(c.lastError, 'CONNECT_FAILED_CERT_UNVERIFIED',
        reason: 'a computer that answered was reported as unreachable');
    // The user reads a different sentence from a dead address, in every language.
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final String read = s.pairError(c.lastError);
      expect(read, isNot(s.pairError('CONNECT_FAILED: anything')),
          reason: locale.name);
      expect(read, contains('https://'), reason: locale.name);
    }
    // Refused, and nothing was remembered on the way.
    expect(core.lastDialPinMismatch, isFalse);
    expect(await storage.readPairings(), isEmpty);
  });

  test('a dead address keeps the plain sentence: the new one must not leak to a '
      'failure it was not written for', () async {
    // A port nothing is listening on: bind, read the port, close.
    final ServerSocket probe =
        await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final int port = probe.port;
    await probe.close();
    final SocketCore core = SocketCore();
    final PttSession session =
        _realSession(core, InMemoryTokenStorage());
    final ConnectionsController c = ConnectionsController(
      session: session,
      login: newTestLogin(transport: session.transport),
      saasEndpoint: 'https://relay.example.test',
    );
    await c.addByCode(rawEndpoint: 'https://127.0.0.1:$port', code: '1234');
    expect(c.lastError, startsWith('CONNECT_FAILED'));
    expect(c.lastError, isNot('CONNECT_FAILED_CERT_UNVERIFIED'));
  });

  test('the cloud arm (a pcid on the frame) keeps the plain sentence: there is no '
      'address box to fix', () async {
    final SecureServerSocket server = await _startTlsServer();
    addTearDown(server.close);
    final SocketCore core = SocketCore();
    final PttSession session = _realSession(core, InMemoryTokenStorage());
    final ConnectionsController c = ConnectionsController(
      session: session,
      login: newTestLogin(transport: session.transport),
      saasEndpoint: 'https://relay.example.test',
    );
    await c.addByCode(
      rawEndpoint: 'https://127.0.0.1:${server.port}',
      code: '1234',
      pcid: '123456789',
    );
    expect(c.lastError, startsWith('CONNECT_FAILED'));
    expect(c.lastError, isNot('CONNECT_FAILED_CERT_UNVERIFIED'));
  });

  test('the same computer with no scheme: TOFU learns the key and the dial is real '
      'pinned TLS, not plain', () async {
    final SecureServerSocket server = await _startTlsServer();
    addTearDown(server.close);
    final SocketCore core = SocketCore();
    final PttSession session =
        _realSession(core, InMemoryTokenStorage());

    // What `normalizePairEndpoint` turns a bare address into, then the real pair().
    final PairResult r = await session.pair(
      PairEntry.parse('1234'),
      endpoint: normalizePairEndpoint('127.0.0.1:${server.port}'),
    );

    // The listener speaks no socket.io, so the pairing itself cannot finish.
    expect(r.ok, isFalse);
    expect(core.lastDialPinMismatch, isFalse);
    expect(core.lastLinkEncryption, LinkEncryption.pinnedTls,
        reason: 'the address the form now suggests did not reach pinned TLS');
  });
}
