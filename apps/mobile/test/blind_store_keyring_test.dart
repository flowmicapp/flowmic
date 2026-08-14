// Card E-CL — the key holder, and the negative directions that matter.
//
// The positive cases are the cheap half. What this file is really for is the
// three ways a blind store can lie to its user, all of which must be LOUD:
//   · a wrong passphrase must say so, and must never render as "the cloud is empty"
//     (design §2.1 — that turns a solvable problem into an unsolvable-looking
//     one);
//   · tampered bytes must refuse to open, not open to something;
//   · a blob moved onto ANOTHER entry's row must refuse — the aad binding is the
//     only integrity check available under blind storage, because the server by
//     construction cannot check anything.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/crypto/blind_store_key.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/crypto/blind_store_sentinel.dart';
import 'package:flutter_test/flutter_test.dart';

/// Real Argon2id, small parameters. The KDF's CORRECTNESS is pinned by
/// blind_store_kdf_vector_test.dart against RFC 9106; paying 64 MiB × 3 here
/// would buy nothing but wall-clock.
final Argon2Cost kFast = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);

BlindStoreKeyring _ring(BlindStoreKeyStore store) =>
    BlindStoreKeyring(store: store, cost: kFast);

void main() {
  group('enrolment and re-entry', () {
    test('enrol leaves the ring unlocked and the material persisted', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring ring = _ring(store);

      expect(await ring.hasEnrolled(), isFalse);
      expect(ring.isUnlocked, isFalse);

      await ring.enroll('correct horse battery staple');

      expect(ring.isUnlocked, isTrue);
      expect(await ring.hasEnrolled(), isTrue);
      final BlindStoreKeyMaterial m = (await store.read())!;
      expect(m.salt, hasLength(kBlindStoreSaltBytes));
      expect(m.sentinel, startsWith(kBlindStoreEnvelopePrefix));
      expect(m.masterKeyB64, isNotNull);
    });

    test('restore re-opens across a relaunch without the passphrase', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      await _ring(store).enroll('pass-1');

      // A second keyring over the same store is what the next launch builds.
      final BlindStoreKeyring next = _ring(store);
      expect(next.isUnlocked, isFalse);
      expect(await next.restore(), isTrue);
      expect(next.isUnlocked, isTrue);
    });

    test('restore refuses material whose sentinel does not match', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      await _ring(store).enroll('pass-1');
      final BlindStoreKeyMaterial m = (await store.read())!;

      // A sentinel from a DIFFERENT key — the shape half-written or swapped
      // material really has.
      final BlindStoreMasterKey other = deriveBlindStoreMasterKey(
        passphrase: 'someone else',
        salt: m.salt,
        cost: kFast,
      );
      await store.write(
        BlindStoreKeyMaterial(
          salt: m.salt,
          sentinel: createBlindStoreSentinel(key: other),
          masterKeyB64: m.masterKeyB64,
        ),
      );

      final BlindStoreKeyring next = _ring(store);
      expect(await next.restore(), isFalse);
      // 🔴 And it did NOT quietly adopt the key anyway.
      expect(next.isUnlocked, isFalse);
      expect(next.seal(entryId: 'e1', plaintext: 'x'), isNull);
    });

    test('re-enrolling is refused — it would orphan every pushed blob', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring ring = _ring(store);
      await ring.enroll('pass-1');
      await expectLater(() => ring.enroll('pass-2'), throwsStateError);
    });
  });

  group('🔴 the wrong passphrase fails LOUDLY (design §2.1)', () {
    test('unlock with the wrong passphrase throws, and stays locked', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      await _ring(store).enroll('the real one');

      final BlindStoreKeyring ring = _ring(store);
      await expectLater(
        () => ring.unlock('not the real one'),
        throwsA(isA<BlindStorePassphraseRejected>()),
      );

      // The whole point: it did not degrade into a usable-looking empty state.
      expect(ring.isUnlocked, isFalse);
      expect(ring.seal(entryId: 'e1', plaintext: 'x'), isNull);
      expect(
        () => ring.open(entryId: 'e1', envelope: 'e2e:v1:AAAA'),
        throwsA(isA<BlindStoreCryptoException>()),
      );
    });

    test('unlock before enrolment answers a DIFFERENT exception', () async {
      // "you typed it wrong" and "this device has never set a passphrase" need opposite responses, so one
      // exception answering both would be the one-value-two-questions shape.
      final BlindStoreKeyring ring = _ring(InMemoryBlindStoreKeyStore());
      await expectLater(
        () => ring.unlock('anything'),
        throwsA(isA<BlindStoreNotEnrolled>()),
      );
    });

    test('the right passphrase re-opens after lock()', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring ring = _ring(store);
      await ring.enroll('pass-1');
      final String sealed = ring.seal(entryId: 'e1', plaintext: 'hello')!;

      ring.lock();
      expect(ring.isUnlocked, isFalse);
      await ring.unlock('pass-1');

      expect(ring.open(entryId: 'e1', envelope: sealed), 'hello');
    });
  });

  group('🔴 negative directions on the envelope, through the keyring', () {
    test('tampered ciphertext refuses to open', () async {
      final BlindStoreKeyring ring = _ring(InMemoryBlindStoreKeyStore());
      await ring.enroll('pass-1');
      final String sealed = ring.seal(entryId: 'e1', plaintext: 'secret')!;

      // Flip one bit in the payload — a byte-level change, not a shape change.
      final String body = sealed.substring(kBlindStoreEnvelopePrefix.length);
      final Uint8List raw = base64.decode(body);
      raw[raw.length - 1] = raw[raw.length - 1] ^ 0x01;
      final String tampered =
          kBlindStoreEnvelopePrefix + base64.encode(raw);

      expect(
        () => ring.open(entryId: 'e1', envelope: tampered),
        throwsA(
          isA<BlindStoreCryptoException>().having(
            (BlindStoreCryptoException e) => e.failure,
            'failure',
            BlindStoreFailure.authenticationFailed,
          ),
        ),
      );
    });

    test('a blob moved onto another entry id refuses (the aad binding)', () async {
      final BlindStoreKeyring ring = _ring(InMemoryBlindStoreKeyStore());
      await ring.enroll('pass-1');
      final String sealedForA = ring.seal(entryId: 'entry-A', plaintext: 'A')!;

      // This is exactly what a server that shuffled rows would produce. It must
      // be a decryption FAILURE, not a plausible-looking wrong answer — under
      // blind storage nothing else can catch it.
      expect(
        () => ring.open(entryId: 'entry-B', envelope: sealedForA),
        throwsA(isA<BlindStoreCryptoException>()),
      );
      // Positive control: the same bytes under their OWN id still open, so the
      // refusal above is about the binding and not about broken ciphertext.
      expect(ring.open(entryId: 'entry-A', envelope: sealedForA), 'A');
    });

    test('another account key cannot open this account blob', () async {
      final BlindStoreKeyring a = _ring(InMemoryBlindStoreKeyStore());
      final BlindStoreKeyring b = _ring(InMemoryBlindStoreKeyStore());
      await a.enroll('alice-pass');
      await b.enroll('bob-pass');

      final String sealed = a.seal(entryId: 'e1', plaintext: 'alice only')!;
      expect(
        () => b.open(entryId: 'e1', envelope: sealed),
        throwsA(isA<BlindStoreCryptoException>()),
      );
    });
  });

  group('multi-device (owner E-①) — the mechanism, not a claim it is wired', () {
    // 🔴 READ blind_store_keyring.dart's header first. Nothing in production
    // carries a salt between devices today, and this card did not invent a way.
    // What these tests prove is that the SEAM is real: given the same salt, the
    // same passphrase reproduces the key and opens the other device's blobs. The
    // missing half is transport, and it is reported as an open decision.
    test('same passphrase + same salt reproduces the key and opens A blobs', () async {
      final InMemoryBlindStoreKeyStore aStore = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring a = _ring(aStore);
      await a.enroll('shared secret');
      final String sealed = a.seal(entryId: 'e1', plaintext: 'from phone A')!;
      final ({Uint8List salt, String sentinel}) shared =
          (await a.sharedKeyMaterial())!;

      final BlindStoreKeyring b = _ring(InMemoryBlindStoreKeyStore());
      await b.adoptSharedKeyMaterial(
        salt: shared.salt,
        sentinel: shared.sentinel,
        passphrase: 'shared secret',
      );

      expect(b.isUnlocked, isTrue);
      expect(b.open(entryId: 'e1', envelope: sealed), 'from phone A');
    });

    test('a DIFFERENT salt with the same passphrase does NOT reproduce the key', () async {
      // This is why the gap is a gap: the passphrase alone is not enough, and a
      // second device that mints its own salt silently gets a different key.
      final BlindStoreKeyring a = _ring(InMemoryBlindStoreKeyStore());
      await a.enroll('shared secret');
      final String sealed = a.seal(entryId: 'e1', plaintext: 'from phone A')!;

      final BlindStoreKeyring b = _ring(InMemoryBlindStoreKeyStore());
      await b.enroll('shared secret'); // same words, fresh salt

      expect(
        () => b.open(entryId: 'e1', envelope: sealed),
        throwsA(isA<BlindStoreCryptoException>()),
      );
    });

    test('adopting with the wrong passphrase is rejected, not adopted', () async {
      final BlindStoreKeyring a = _ring(InMemoryBlindStoreKeyStore());
      await a.enroll('right');
      final ({Uint8List salt, String sentinel}) shared =
          (await a.sharedKeyMaterial())!;

      final InMemoryBlindStoreKeyStore bStore = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring b = _ring(bStore);
      await expectLater(
        () => b.adoptSharedKeyMaterial(
          salt: shared.salt,
          sentinel: shared.sentinel,
          passphrase: 'wrong',
        ),
        throwsA(isA<BlindStorePassphraseRejected>()),
      );
      expect(b.isUnlocked, isFalse);
      // Nothing was persisted, so the device is not left half-enrolled.
      expect(await bStore.read(), isNull);
    });
  });

  group('discardKeyMaterial — the 409-race-loser seam (SALT-2)', () {
    test('forgets the store AND the live key; a fresh enrol works after', () async {
      final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
      final BlindStoreKeyring ring = _ring(store);
      await ring.enroll('doomed by the race');
      expect(ring.seal(entryId: 'e1', plaintext: 'x'), isNotNull);

      await ring.discardKeyMaterial();

      // Both halves gone — a discard that dropped only one would leave a ring
      // that still seals under a salt the account has already contradicted.
      expect(ring.isUnlocked, isFalse);
      expect(await ring.hasEnrolled(), isFalse);
      expect(await store.read(), isNull);
      expect(ring.seal(entryId: 'e1', plaintext: 'x'), isNull);

      // And the refuse-double-enroll guard resets WITH the material: the race
      // loser re-enters (enrol or adopt) without a zombie StateError.
      await ring.enroll('fresh start');
      expect(ring.isUnlocked, isTrue);
    });
  });

  test('🔴 the MasterKey never appears in a string representation', () async {
    final BlindStoreKeyring ring = _ring(InMemoryBlindStoreKeyStore());
    await ring.enroll('pass-1');
    expect('${ring.key}', isNot(contains(base64.encode(ring.key!.bytes))));
    expect('${ring.key}', contains('redacted'));
  });
}
