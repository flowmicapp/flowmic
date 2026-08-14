// E-B1 — the sentinel self-check (owner ruling E-①, second-device path).
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (「同口令重输（主路径，本地验证 blob
//   `AES-GCM(MasterKey,'flowmic-e2ee-v1')`，服务端不参与判定）」);
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2.1.
//
// The property under test is not "AES works" — the envelope suite owns that. It
// is that a second device can tell "this passphrase is wrong" apart from "the cloud is empty"
// BEFORE it fetches a single entry. Design §2.1 forbids the second reading of
// the first situation in as many words, because it converts a solvable problem
// into an apparently unsolvable one.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flowmic/src/crypto/blind_store_envelope.dart';
import 'package:flowmic/src/crypto/blind_store_key.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/crypto/blind_store_sentinel.dart';
import 'package:flutter_test/flutter_test.dart';

/// Reduced cost — these cases test the SENTINEL, not the KDF.
/// `blind_store_kdf_vector_test.dart` is where the real 64 MiB cost is paid and
/// measured, and where the RFC 9106 vector proves the function's identity.
final Argon2Cost _cheap = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);

BlindStoreMasterKey _keyFor(String passphrase, Uint8List salt) =>
    deriveBlindStoreMasterKey(
        passphrase: passphrase, salt: salt, cost: _cheap);

void main() {
  final Uint8List salt = Uint8List.fromList(List<int>.filled(16, 0x2a));

  group('second device, same passphrase (owner E-①)', () {
    test('the same passphrase + salt on another device accepts the sentinel', () {
      // Device 1 sets the passphrase and publishes a sentinel.
      final String sentinel =
          createBlindStoreSentinel(key: _keyFor('correct horse', salt));

      // Device 2: the user re-enters the same passphrase. Salt travels with the
      // account (it is not secret); the passphrase does not.
      expect(
        blindStoreSentinelAccepts(
            key: _keyFor('correct horse', salt), sentinel: sentinel),
        isTrue,
      );
    });

    test('a wrong passphrase is REJECTED — the whole point of the check', () {
      final String sentinel =
          createBlindStoreSentinel(key: _keyFor('correct horse', salt));
      for (final String wrong in <String>[
        'correct hors',
        'Correct horse',
        'correct horse ',
        'entirely different',
      ]) {
        expect(
          blindStoreSentinelAccepts(
              key: _keyFor(wrong, salt), sentinel: sentinel),
          isFalse,
          reason: '"$wrong" was accepted',
        );
      }
    });

    test('the same passphrase under a DIFFERENT salt is rejected', () {
      // Catches "the salt did not travel with the account", which would
      // otherwise present to the user as a wrong passphrase they are certain
      // they typed correctly.
      final String sentinel =
          createBlindStoreSentinel(key: _keyFor('correct horse', salt));
      final Uint8List otherSalt =
          Uint8List.fromList(List<int>.filled(16, 0x2b));
      expect(
        blindStoreSentinelAccepts(
            key: _keyFor('correct horse', otherSalt), sentinel: sentinel),
        isFalse,
      );
    });
  });

  group('the sentinel is an ordinary blind-store blob', () {
    test('it carries the e2e:v1: prefix like everything else we upload', () {
      // It is uploaded through the same timeline_blobs path, so it must satisfy
      // the same server-side admission check (assertE2ePrefix / E2eCiphertext).
      final String s = createBlindStoreSentinel(key: _keyFor('p', salt));
      expect(s.startsWith(kBlindStoreEnvelopePrefix), isTrue);
    });

    test('it is fresh on every call — no fixed nonce', () {
      final BlindStoreMasterKey k = _keyFor('p', salt);
      final Set<String> seen = <String>{};
      for (int i = 0; i < 16; i++) {
        seen.add(createBlindStoreSentinel(key: k));
      }
      expect(seen.length, 16);
    });

    test('it encrypts exactly the string 05 册 §2 names', () {
      // 🔴 A wire-format constant. If it changes, every stored sentinel becomes
      // unverifiable and users are locked out of their own cloud records.
      expect(kBlindStoreSentinelPlaintext, 'flowmic-e2ee-v1');
      final BlindStoreMasterKey k = _keyFor('p', salt);
      final String s = createBlindStoreSentinel(key: k);
      // Read it back through the raw path with the reserved id, proving the
      // plaintext really is that string and not a look-alike.
      expect(
        blindStoreOpenRaw(
            key: k, aadSource: kBlindStoreSentinelEntryId, envelope: s),
        'flowmic-e2ee-v1',
      );
    });
  });

  group('the check is local — the server never participates', () {
    test('a valid-looking blob made under the same key but a different aad is '
        'not accepted as a sentinel', () {
      // Models a server (or anyone holding the DB) trying to pass an arbitrary
      // stored blob off as the sentinel. It cannot: the reserved aad binds it.
      final BlindStoreMasterKey k = _keyFor('p', salt);
      final String notASentinel = sealBlindStoreEntry(
        key: k,
        entryId: 'some-real-entry',
        plaintext: kBlindStoreSentinelPlaintext,
      );
      expect(
        blindStoreSentinelAccepts(key: k, sentinel: notASentinel),
        isFalse,
      );
    });

    test('garbage and enc:v1: values are rejected without throwing', () {
      // blindStoreSentinelAccepts answers a question ("is this the right
      // passphrase?") whose "no" is expected and recoverable, so it returns
      // false rather than throwing — unlike every other path in this layer.
      final BlindStoreMasterKey k = _keyFor('p', salt);
      for (final String junk in <String>[
        '',
        'enc:v1:AAAA',
        'e2e:v1:not-base64!!',
        'e2e:v1:${base64.encode(Uint8List(40))}',
      ]) {
        expect(blindStoreSentinelAccepts(key: k, sentinel: junk), isFalse,
            reason: 'input: "$junk"');
      }
    });

    test('no network, no clock, no randomness is needed to VERIFY', () {
      // Verification is a pure function of (key, blob). Passing a seeded,
      // insecure Random to creation and still verifying proves nothing external
      // is consulted at check time.
      final BlindStoreMasterKey k = _keyFor('p', salt);
      final String s = createBlindStoreSentinel(
        key: k,
        randomForNonce: Random(1),
      );
      expect(blindStoreSentinelAccepts(key: k, sentinel: s), isTrue);
    });
  });
}
