// Card W4A-2 (docs/strategy/2026-08-08-030-unified-plan-and-ledger.md §4).
//
// `lib/src/signaling/lan_pinning.dart` is the ONE funnel every trust verdict in
// this app flows through, and until this card nothing tested it directly: the
// pinning tests that exist (lan_tls_pin_test.dart,
// lan_pin_enforced_on_every_dial_test.dart) all enter at the socket or the
// pairing layer ABOVE it. This file pins the funnel's own guards, because two
// sentences describing them were false while the code was right — a comment
// that describes this file wrongly is worse than no comment, since the next
// reader takes it as a measurement already made.
//
// 🔴 WHAT THIS FILE CANNOT DO, SAID OUT LOUD SO NOBODY ASSUMES IT DID.
// `PinnedHttpClient._judge` — the comparison that decides every pinned
// handshake — is not reachable from THIS file:
//   · `HttpClient.badCertificateCallback` is SETTER-ONLY in dart:io (SDK
//     lib/_http/http.dart: `void set badCertificateCallback(...)`, no getter),
//     so the callback this funnel installs cannot be read back and invoked; and
//   · driving it for real needs a TLS peer, i.e. a certificate AND ITS PRIVATE
//     KEY, and committing that pair as a fixture is forbidden by CLAUDE.md's
//     security section (「keystore/证书/主机指纹类不入库」).
// ⚠️ In-place correction (card C1): the second bullet blocks a COMMITTED
// fixture, not a real handshake as such — lan_pin_real_handshake_test.dart now
// drives `_judge` through a real `SecureServerSocket` whose identity is minted
// AT RUN TIME by server-core's own generator, so no key material enters the
// repo and the rule the bullet cites still holds. This file's own scope is
// unchanged: what it measures is that the states which would need `_judge` to
// save them cannot be constructed in the first place.

import 'package:flowmic/src/signaling/lan_pinning.dart';
import 'package:flutter_test/flutter_test.dart';

/// A well-formed fingerprint (24 base64url characters). The VALUE is irrelevant
/// here: no handshake happens anywhere in this file, so nothing compares it.
const String kSomePin = 'lyKv42hVFCt5iXthGDWFe4Tm';

final Uri kSecureUrl = Uri.parse('https://100.64.7.68:41879/api/pc/presence');
final Uri kPlainUrl = Uri.parse('http://100.64.7.68:41879/api/pc/presence');

void main() {
  // ── ① The pin guard, in both of its directions ────────────────────────────
  group('① openHttpClient: a pin belongs to exactly one arm', () {
    test('🔴 HttpTrust.pinned WITHOUT a pin cannot be constructed', () {
      // The state this refuses is NOT a permissive one — see the assert's own
      // message. A pinned client holding a null pin would refuse every
      // certificate (`_judge`'s first conjunct), i.e. it would report "that is
      // not the computer on the other end" about a PC that is fine. Either way it is a wiring bug, and
      // this is where a debug build stops it.
      expect(
        () => openHttpClient(trust: HttpTrust.pinned),
        throwsA(isA<AssertionError>()),
      );
    });

    test('a pin handed to an arm that cannot check it is refused', () {
      for (final HttpTrust trust in <HttpTrust>[
        HttpTrust.publicCa,
        HttpTrust.unverifiedProbe,
        HttpTrust.learnIdentity,
      ]) {
        expect(
          () => openHttpClient(trust: trust, pin: kSomePin),
          throwsA(isA<AssertionError>()),
          reason: '$trust never compares a pin, so carrying one would be a '
              'badge with nothing behind it',
        );
      }
    });

    test('positive control: each arm builds with its own legal argument', () {
      // Without this, ① above is green for a funnel that throws at everything.
      final Map<HttpTrust, String?> legal = <HttpTrust, String?>{
        HttpTrust.publicCa: null,
        HttpTrust.pinned: kSomePin,
        HttpTrust.unverifiedProbe: null,
        HttpTrust.learnIdentity: null,
      };
      legal.forEach((HttpTrust trust, String? pin) {
        final PinnedHttpClient c = openHttpClient(trust: trust, pin: pin);
        addTearDown(c.close);
        // A client that has not handshaked says NOTHING rather than guessing —
        // the property `pinnedWebSocketConnector`'s doc depends on when it
        // reports a dial that threw before any certificate was seen.
        expect(c.outcome, LanPinOutcome.none, reason: '$trust');
        expect(c.observedFingerprint, isNull, reason: '$trust');
      });
    });
  });

  // ── ② The funnel that carries this pairing's bearer token ─────────────────
  //
  // ⚠️ Scope, stated because the gap is invisible otherwise: these assert what
  // openPairingHttpClient REFUSES and RETURNS. They cannot assert WHICH arm the
  // returned client got (setter-only callback, file header) — that
  // openPairingHttpClient can only ever select publicCa or pinned is a
  // code-read of its own body, not a measurement made here.
  group('② openPairingHttpClient', () {
    test('🔴 a pin on a plain URL is refused outright, never downgraded', () {
      // The alternative is a request that believes it is authenticated
      // travelling in the clear. SocketCore enforces the same rule on the dial
      // (lan_tls_pin_test.dart ④); this is the HTTP half of it.
      expect(
        () => openPairingHttpClient(url: kPlainUrl, pin: kSomePin),
        throwsA(isA<StateError>()),
      );
    });

    test('a pinned pairing on a secure URL builds', () {
      final PinnedHttpClient c =
          openPairingHttpClient(url: kSecureUrl, pin: kSomePin);
      addTearDown(c.close);
      expect(c.outcome, LanPinOutcome.none);
    });

    test('reverse control: an unpinned pairing is untouched, plain URL and all',
        () {
      // This is the pre-card behaviour and it has to stay reachable: an
      // unpinned pairing is plain `http://`, and refusing it here would delete
      // every pairing made before this feature existed.
      final PinnedHttpClient c = openPairingHttpClient(url: kPlainUrl, pin: null);
      addTearDown(c.close);
      expect(c.outcome, LanPinOutcome.none);
      expect(c.observedFingerprint, isNull);
    });
  });
}
