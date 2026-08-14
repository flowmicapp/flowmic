// E-B1 — the `e2e:v1:` envelope: known-answer vectors, byte layout, and the
// aad binding that is the client's only integrity self-certification.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2; docs/strategy/
//   2026-08-08-design-e-blindstore-client.md §2, §7-2.
//
// The evidence chain here is deliberately three links long, because each link
// alone proves something weaker than it appears:
//   1. NIST GCM Test Case 16 → the LIBRARY really computes AES-256-GCM with aad.
//   2. our envelope vs. the library's native output → OUR nonce‖tag‖ct re-order
//      is correct (PointyCastle emits ct‖tag, so this is a real transformation).
//   3. a pinned literal envelope string → a regression tripwire, so any future
//      change of parameters or layout fails loudly instead of producing blobs
//      that are merely different.
// A round-trip test alone would pass through all three of those being wrong.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flowmic/src/crypto/blind_store_envelope.dart';
import 'package:flowmic/src/crypto/blind_store_key.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';

Uint8List _hex(String s) {
  final String clean = s.replaceAll(RegExp(r'\s'), '');
  final Uint8List out = Uint8List(clean.length ~/ 2);
  for (int i = 0; i < out.length; i++) {
    out[i] = int.parse(clean.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _toHex(List<int> b) =>
    b.map((int x) => x.toRadixString(16).padLeft(2, '0')).join();

/// A fixed 32-byte key. Not derived via Argon2id: these cases test the ENVELOPE,
/// and paying 64 MiB per case to obtain 32 bytes we then fix anyway would only
/// buy a slower suite. `blind_store_kdf_vector_test.dart` owns the KDF.
final BlindStoreMasterKey _key = BlindStoreMasterKey.fromBytes(
  _hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
);

/// Deterministic nonce source, so an envelope becomes a pinnable known answer.
/// 🔴 `Random(seed)` is NOT secure and must never appear in lib/ — the seam
/// exists only for this file. Production defaults to `Random.secure()`.
Random _fixedNonce() => Random(20260808);

void main() {
  group('NIST GCM Test Case 16 — the library computes real AES-256-GCM', () {
    test('AES-256-GCM with associated data matches the published vector', () {
      // Source: pointycastle 3.9.1 test/modes/gcm_test.dart, entry 'Test Case
      // 16' (the classic McGrew–Viega GCM spec vectors, 256-bit key, 96-bit IV,
      // 20-byte aad). Verifying it HERE rather than trusting the package's CI is
      // the repo's "check your ruler first" rule: the ruler ships with the library, so a
      // silent upstream regression would otherwise be invisible to us.
      final GCMBlockCipher c = GCMBlockCipher(AESEngine())
        ..init(
          true,
          AEADParameters(
            KeyParameter(_hex(
              'feffe9928665731c6d6a8f9467308308'
              'feffe9928665731c6d6a8f9467308308',
            )),
            128,
            _hex('cafebabefacedbaddecaf888'),
            _hex('feedfacedeadbeeffeedfacedeadbeefabaddad2'),
          ),
        );
      final Uint8List out = c.process(_hex(
        'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da'
        '2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525'
        'b16aedf5aa0de657ba637b39',
      ));
      // PointyCastle returns ciphertext‖tag, which is precisely why our envelope
      // has to re-order. Both halves are checked.
      expect(
        _toHex(out.sublist(0, out.length - 16)),
        '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c9'
        '7598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838'
        'c5f61e6393ba7a0abcc9f662',
      );
      expect(_toHex(out.sublist(out.length - 16)),
          '76fc6ece0f4e1768cddf8853bb2d551b');
    });
  });

  group('envelope format (05 册 §2)', () {
    test('prefix is e2e:v1: and the payload is base64', () {
      final String env = sealBlindStoreEntry(
        key: _key,
        entryId: 'entry-1',
        plaintext: 'hello',
      );
      expect(env.startsWith('e2e:v1:'), isTrue);
      expect(env.startsWith(kBlindStoreEnvelopePrefix), isTrue);
      // Must decode without throwing — a malformed payload would be caught only
      // on the reading device, i.e. after upload.
      expect(
        () => base64.decode(env.substring(kBlindStoreEnvelopePrefix.length)),
        returnsNormally,
      );
    });

    test('layout is exactly nonce(12) ‖ tag(16) ‖ ciphertext, verified against '
        'the library rather than against ourselves', () {
      const String pt = 'the quick brown fox';
      const String id = 'entry-layout';
      final String env = sealBlindStoreEntry(
        key: _key,
        entryId: id,
        plaintext: pt,
        randomForNonce: _fixedNonce(),
      );
      final Uint8List blob =
          base64.decode(env.substring(kBlindStoreEnvelopePrefix.length));

      expect(blob.length, kBlindStoreNonceBytes + kBlindStoreTagBytes + pt.length,
          reason: 'GCM is a stream mode: |ct| == |pt|, so total length is fixed');

      final Uint8List nonce = blob.sublist(0, kBlindStoreNonceBytes);
      final Uint8List tag = blob.sublist(
          kBlindStoreNonceBytes, kBlindStoreNonceBytes + kBlindStoreTagBytes);
      final Uint8List ct =
          blob.sublist(kBlindStoreNonceBytes + kBlindStoreTagBytes);

      // Recompute with the raw library using the SAME nonce, and compare. If our
      // re-order were a no-op (i.e. we shipped the library's native ct‖tag), the
      // blob would still be the right length, still base64-decode, and still
      // carry the right prefix — and only this assertion would notice.
      final GCMBlockCipher raw = GCMBlockCipher(AESEngine())
        ..init(
          true,
          AEADParameters(
            KeyParameter(_key.bytes),
            kBlindStoreTagBits,
            nonce,
            Uint8List.fromList(utf8.encode(id)),
          ),
        );
      final Uint8List native = raw.process(Uint8List.fromList(utf8.encode(pt)));
      expect(_toHex(ct), _toHex(native.sublist(0, native.length - 16)));
      expect(_toHex(tag), _toHex(native.sublist(native.length - 16)));
    });

    test('pinned known-answer envelope — a tripwire for any silent change of '
        'parameters or layout', () {
      // Produced by this implementation with the fixed key and seeded nonce
      // above. It has no external authority; its whole job is that it CANNOT
      // survive a change to key size, tag size, nonce size, byte order, aad
      // derivation, or the prefix. Regenerate deliberately, never reflexively.
      final String env = sealBlindStoreEntry(
        key: _key,
        entryId: 'pinned-entry',
        plaintext: 'FlowMic blind store v1',
        randomForNonce: _fixedNonce(),
      );
      expect(env, _kPinnedEnvelope);
      // …and it must still open, so the pin is a live vector, not a dead string.
      expect(
        openBlindStoreEntry(
            key: _key, entryId: 'pinned-entry', envelope: _kPinnedEnvelope),
        'FlowMic blind store v1',
      );
    });

    test('a fresh nonce per seal — identical inputs must not give identical '
        'bytes', () {
      // 🔴 A repeated (key, nonce) in GCM leaks the XOR of both plaintexts AND
      // enables tag forgery for that key. This is the cheapest possible check
      // that the production path is not accidentally deterministic.
      final Set<String> seen = <String>{};
      for (int i = 0; i < 32; i++) {
        seen.add(sealBlindStoreEntry(
            key: _key, entryId: 'same-id', plaintext: 'same text'));
      }
      expect(seen.length, 32);
    });

    test('round-trips UTF-8 beyond ASCII, empty text, and long text', () {
      for (final String pt in <String>[
        '',
        '简体中文と日本語 🔐',
        'x' * 5000,
      ]) {
        final String env = sealBlindStoreEntry(
            key: _key, entryId: 'rt', plaintext: pt);
        expect(openBlindStoreEntry(key: _key, entryId: 'rt', envelope: env), pt);
      }
    });
  });

  group('🔴 aad binding: entry.id is glued to its own ciphertext', () {
    test("entry A's blob does NOT open under entry B's id", () {
      // This is the property design §2 calls the client's ONLY means of
      // self-certifying integrity under blind storage. A server that swapped two
      // rows' ciphertexts must produce a failure, not a plausible wrong answer.
      final String envA = sealBlindStoreEntry(
        key: _key,
        entryId: 'entry-A',
        plaintext: 'A private note',
      );

      // Positive control FIRST: the same blob under its OWN id opens. Without
      // this, "it failed" could just mean the harness is broken.
      expect(
        openBlindStoreEntry(key: _key, entryId: 'entry-A', envelope: envA),
        'A private note',
      );

      // Negative: the same bytes, presented as entry B.
      expect(
        () => openBlindStoreEntry(
            key: _key, entryId: 'entry-B', envelope: envA),
        throwsA(isA<BlindStoreCryptoException>().having(
          (BlindStoreCryptoException e) => e.failure,
          'failure',
          BlindStoreFailure.authenticationFailed,
        )),
      );
    });

    test('a one-character difference in the id is enough', () {
      final String env = sealBlindStoreEntry(
          key: _key, entryId: 'abc-123', plaintext: 'x');
      expect(
        () => openBlindStoreEntry(key: _key, entryId: 'abc-124', envelope: env),
        throwsA(isA<BlindStoreCryptoException>()),
      );
    });

    test('an empty entry id is refused at BOTH seal and open', () {
      // 🔴 An empty id yields an empty aad, which GCM accepts. The seal would
      // succeed and the binding would simply not exist, undetectably. This is
      // the single most consequential guard in the layer.
      expect(
        () => sealBlindStoreEntry(key: _key, entryId: '', plaintext: 'x'),
        throwsArgumentError,
      );
      expect(
        () => openBlindStoreEntry(
            key: _key, entryId: '', envelope: _kPinnedEnvelope),
        throwsArgumentError,
      );
    });

    test('the sentinel id is reserved and cannot be used by a real entry', () {
      expect(
        () => sealBlindStoreEntry(
          key: _key,
          entryId: kBlindStoreSentinelEntryId,
          plaintext: 'pretending to be the sentinel',
        ),
        throwsA(isA<BlindStoreReservedIdException>()),
      );
    });
  });

  group('🔴 wrong passphrase fails LOUDLY (design §2.1)', () {
    test('a wrong key throws authenticationFailed — never returns null, never '
        'returns empty, never looks like "the cloud is empty"', () {
      final String env = sealBlindStoreEntry(
          key: _key, entryId: 'e', plaintext: 'private');
      final BlindStoreMasterKey wrong =
          BlindStoreMasterKey.fromBytes(Uint8List(32));

      // Positive control: the right key opens it.
      expect(openBlindStoreEntry(key: _key, entryId: 'e', envelope: env),
          'private');

      // Negative: the wrong key throws. The distinction the design cares about
      // is that this is an EXCEPTION, so no caller can mistake it for "no data".
      Object? caught;
      try {
        openBlindStoreEntry(key: wrong, entryId: 'e', envelope: env);
      } on Object catch (e) {
        caught = e;
      }
      expect(caught, isA<BlindStoreCryptoException>());
      expect((caught! as BlindStoreCryptoException).failure,
          BlindStoreFailure.authenticationFailed);
    });

    test('failure detail carries no plaintext and no key material', () {
      // The detail string is expected to reach diagnostics logs.
      final String env = sealBlindStoreEntry(
          key: _key, entryId: 'e', plaintext: 'TOPSECRETPLAINTEXT');
      try {
        openBlindStoreEntry(
            key: BlindStoreMasterKey.fromBytes(Uint8List(32)),
            entryId: 'e',
            envelope: env);
        fail('should have thrown');
      } on BlindStoreCryptoException catch (e) {
        expect(e.detail, isNot(contains('TOPSECRETPLAINTEXT')));
        expect(e.detail, isNot(contains(_toHex(_key.bytes))));
      }
    });
  });

  group('malformed input is distinguishable from a wrong key', () {
    test('wrong prefix reports wrongPrefix, not authenticationFailed', () {
      // The distinction is load-bearing: `wrongPrefix` is the one that can mean
      // an enc:v1: value reached a blind-store field — the red line itself —
      // whereas authenticationFailed means "try another passphrase".
      for (final String bad in <String>[
        'enc:v1:AAAA',
        'plain text',
        '',
        'E2E:V1:AAAA',
      ]) {
        expect(
          () => openBlindStoreEntry(key: _key, entryId: 'e', envelope: bad),
          throwsA(isA<BlindStoreCryptoException>().having(
            (BlindStoreCryptoException e) => e.failure,
            'failure for "$bad"',
            BlindStoreFailure.wrongPrefix,
          )),
        );
      }
    });

    test('non-base64 and too-short payloads report malformed', () {
      expect(
        () => openBlindStoreEntry(
            key: _key, entryId: 'e', envelope: 'e2e:v1:!!!not-base64!!!'),
        throwsA(isA<BlindStoreCryptoException>().having(
          (BlindStoreCryptoException e) => e.failure,
          'failure',
          BlindStoreFailure.malformed,
        )),
      );
      expect(
        () => openBlindStoreEntry(
            key: _key,
            entryId: 'e',
            envelope: 'e2e:v1:${base64.encode(Uint8List(20))}'),
        throwsA(isA<BlindStoreCryptoException>().having(
          (BlindStoreCryptoException e) => e.failure,
          'failure',
          BlindStoreFailure.malformed,
        )),
      );
    });

    test('flipping any single byte of the blob is detected', () {
      final String env = sealBlindStoreEntry(
          key: _key, entryId: 'tamper', plaintext: 'do not change me');
      final Uint8List blob =
          base64.decode(env.substring(kBlindStoreEnvelopePrefix.length));
      // Sample all three regions: nonce, tag, ciphertext.
      for (final int i in <int>[0, 5, 12, 20, 28, blob.length - 1]) {
        final Uint8List t = Uint8List.fromList(blob);
        t[i] = t[i] ^ 0x01;
        expect(
          () => openBlindStoreEntry(
            key: _key,
            entryId: 'tamper',
            envelope: kBlindStoreEnvelopePrefix + base64.encode(t),
          ),
          throwsA(isA<BlindStoreCryptoException>()),
          reason: 'byte $i was flipped and went unnoticed',
        );
      }
    });
  });
}

/// See the 'pinned known-answer envelope' test for what this is and is not.
const String _kPinnedEnvelope =
    'e2e:v1:kJSYj5mVElPak8XBCKAMAVM2d+CF2CE/OinkLYRxDKPcZPVLmAb2kW6v9VbLkA0uNvo=';
