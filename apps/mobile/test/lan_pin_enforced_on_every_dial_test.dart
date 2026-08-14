// Card D2LAN-B3 (W5F follow-up wiring) — **the pin must take effect on every
// dial, not only on the pairing dial.**
//
// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3 / §3-5
//   apps/mobile/lib/src/signaling/reconnect.dart  `ReconnectCoordinator._pin`
//   apps/mobile/lib/src/ptt/pair_retire.dart      `retirePairingOn`
//
// ── 🔴 Why this file exists: a defect invisible to the entire test suite ────
//
// When B3 shipped it wired 2 of the 4 production dial sites (`pair()` /
// `resumePairing()`); the two it missed are not edge cases:
//
//   ① the auto-reconnect ladder `ReconnectCoordinator._dial` — it dials this
//      session **every time except the first**;
//   ② the independent probe of `retirePairingOn` — the one and only dial of
//      `mobile:unpair`.
//
// The failure direction is **cannot connect**, not **connects weakly**: no pin
// ⇒ `SocketCore.connect` does not install `webSocketConnector` ⇒
// socket_io_client falls through to `io.WebSocket.connect` (no `customClient`)
// ⇒ uses the system trust store ⇒ the self-signed cert is rejected ⇒
// `HandshakeException`, on every rung, forever. So a pinned pairing **never
// auto-reconnects after a single drop**, and `mobile:unpair` **fails silently**
// on every pinned pairing (reopening the v0.2.3 bug it was originally written
// to fix).
//
// 🔴 **It is invisible to the entire suite because no test ever measured
// whether the pin actually took effect on the execution surface.**
// Whole-repo `grep bindSecure|pinnedWebSocketConnector|LanPinOutcome apps/mobile/test/`
// hits 0. The existing case that claims "two-direction measured" drives
// `FakeSocketTransport.lastDialPinMismatch` — **a field the test itself sets**:
// it proves "the UI will call a mismatch a mismatch", not "anyone actually
// compared".
//
// ⇒ **This file sets not a single field.** Every assertion reads
// `lastConnectPin`, and the only writer of that value is the parameter of
// `FakeSocketTransport.connect(...)` — i.e. **what the product itself handed
// over on that dial**. The test asks "what did you hand over", not "what do
// you think you handed over".

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/pair_retire.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/signaling/http_endpoint.dart' show isSecureEndpoint;
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Same-origin server reading as lan_tls_pin_test.dart (that file's header
/// records where it came from).
const String kPin = 'lyKv42hVFCt5iXthGDWFe4Tm';
const String kHost = '100.64.7.68:41879';

/// The ladder's first rung is shrunk to milliseconds so a test does not have
/// to wait a real 1 second. **Speed only, shape unchanged**: the criterion is
/// "what that dial carried", which has nothing to do with how long it waited.
ReconnectCoordinator _fastLadder(FakeSocketTransport t) => ReconnectCoordinator(
  transport: t,
  bufferedChunksProvider: () => const <Map<String, Object?>>[],
  initialBackoff: const Duration(milliseconds: 5),
);

MobileSession _stored({String? pin}) => MobileSession(
  token: 'tok-1',
  endpoint: pin == null ? 'http://$kHost' : 'https://$kHost',
  lanTlsFp: pin,
  lanTlsFpSource: pin == null ? null : LanPinSource.qr,
);

/// Spin up a session, resume to [stored], then **really drop the link once**
/// and let the ladder dial its one rung.
/// Returns the reading that ladder dial wrote down.
Future<({String? pin, String? url})> _ladderRedialAfterDrop(
  MobileSession stored,
) async {
  final FakeSocketTransport t = FakeSocketTransport()
    ..connectSucceeds = true
    ..defaultAck = <String, Object?>{'ok': true};
  final PttSession session = newTestSession(
    transport: t,
    reconnect: _fastLadder(t),
    tokenStorage: InMemoryTokenStorage(),
  )..candidateProbeTimeout = const Duration(milliseconds: 20);
  addTearDown(session.dispose);
  session.healthReader = (Uri url, Duration timeout) async =>
      const HealthReading(ok: true, channel: ServerChannel.lan);

  expect(await session.resumePairing(stored), isTrue);

  // 🔴 Wipe the first-dial reading. Without the wipe, "the ladder carried a
  // pin" and "the pairing dial carried a pin" look identical — and the latter
  // was already green, which is exactly what hid this defect.
  t.lastConnectPin = null;
  t.lastConnectUrl = null;

  t.pushStatus(SocketStatus.disconnected);
  await Future<void>.delayed(const Duration(milliseconds: 40));
  return (pin: t.lastConnectPin, url: t.lastConnectUrl);
}

void main() {
  group('① reconnect ladder — every dial of this session except the first', () {
    test('🔴 after a pinned pairing drops, that one ladder rung dials with the same key', () async {
      final ({String? pin, String? url}) redial =
          await _ladderRedialAfterDrop(_stored(pin: kPin));
      // Before the fix this was null — and null in production is not "a bit
      // weaker", it is "cannot connect".
      expect(redial.pin, kPin);
      // Carrying a pin means it must be the TLS end (`SocketCore.connect`
      // rejects the opposite pairing).
      //
      // 🔴 The criterion uses **the product's own predicate**, not a scheme
      // literal I guessed. The first version here wrote `startsWith('wss://')`
      // and immediately went red: a remembered pairing stores `https://`
      // (RV-97 — endpoints persist in http(s) form), and that is also what it
      // dials, and `isSecureEndpoint` accepts both writings. **Hard-coding a
      // scheme in the assertion measures "what it looks like" rather than
      // "whether this connection can be verified"** — this repo's "check your
      // ruler first" law.
      expect(isSecureEndpoint(redial.url!), isTrue);
    });

    test('reverse control: an unpinned pairing, the ladder dial is byte-identical to before (no pin, no scheme upgrade)', () async {
      final ({String? pin, String? url}) redial =
          await _ladderRedialAfterDrop(_stored());
      // This case is the ruler calibration for the one above: if the ladder
      // just "always hangs something on", the case above would still be green,
      // and this one would go red.
      expect(redial.pin, isNull);
      expect(isSecureEndpoint(redial.url!), isFalse);
    });

    test('🔴 switch to an unpinned pairing ⇒ the previous PC\'s key must be dropped', () async {
      // The `replacePin` half. Without it, after pinning LAN and then
      // connecting to the relay, the ladder would take **the previous PC's**
      // public key to the relay — the same thing `clearConnectedInstance`
      // clearing `_lanPin` is there to prevent.
      final FakeSocketTransport t = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = <String, Object?>{'ok': true};
      final ReconnectCoordinator ladder = _fastLadder(t);
      final PttSession session = newTestSession(
        transport: t,
        reconnect: ladder,
        tokenStorage: InMemoryTokenStorage(),
      )..candidateProbeTimeout = const Duration(milliseconds: 20);
      addTearDown(session.dispose);
      session.healthReader = (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.lan);

      expect(await session.resumePairing(_stored(pin: kPin)), isTrue);
      expect(t.lastConnectPin, kPin); // positive control: this round really did pin
      expect(await session.resumePairing(_stored()), isTrue);

      t.lastConnectPin = null;
      t.pushStatus(SocketStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(t.lastConnectPin, isNull);
    });
  });

  group('② the independent probe of mobile:unpair', () {
    test('🔴 when retiring a pinned pairing, the probe dials with that pairing\'s own key', () async {
      final FakeSocketTransport probe = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = <String, Object?>{'ok': true};
      expect(await retirePairingOn(probe, _stored(pin: kPin)), isTrue);
      // Before the fix this was null ⇒ the handshake never finishes ⇒ the
      // server row is never deleted, while the user sees 「已删除」.
      expect(probe.lastConnectPin, kPin);
      expect(probe.lastConnectUrl, startsWith('https://'));
    });

    test('reverse control: an unpinned pairing, the retire dial is byte-identical to before', () async {
      final FakeSocketTransport probe = FakeSocketTransport()
        ..connectSucceeds = true
        ..defaultAck = <String, Object?>{'ok': true};
      expect(await retirePairingOn(probe, _stored()), isTrue);
      expect(probe.lastConnectPin, isNull);
      expect(probe.lastConnectUrl, 'http://$kHost');
    });
  });
}
