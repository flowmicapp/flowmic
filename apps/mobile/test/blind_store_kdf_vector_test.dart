// E-B1 — Argon2id known-answer vectors and production-parameter pinning.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2; docs/strategy/
//   2026-08-08-design-e-blindstore-client.md §2.
//
// 🔴 WHY A KNOWN-ANSWER VECTOR IS MANDATORY HERE, not ceremony.
// pointycastle's own suite (test/key_derivators/argon2_vm_test.dart) passes
// `Argon2Parameters.ARGON2_i` for EVERY case — the Argon2**id** mode 05 册 §2
// specifies is not exercised upstream at all. A round-trip test would happily
// pass while we computed Argon2i, Argon2d, or v1.0 instead of v1.3, because a
// KDF's output is only ever compared against itself. The RFC vector below is the
// only assertion in this repo that says WHICH function we are running.
//
// Vector source: RFC 9106 §5.3 (Argon2id). Cross-checked against a SECOND,
// independent implementation's suite — package `cryptography` 2.9.0,
// test/algorithms/argon2_test.dart, test named 'RFC 9106: Argon2id test vector'
// — so the expected bytes are not this author's recollection of the RFC.

import 'dart:typed_data';

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

void main() {
  group('Argon2id known-answer vector (RFC 9106 §5.3)', () {
    test('the library computes Argon2id v1.3, not Argon2i/Argon2d/v1.0', () {
      // RFC 9106 §5.3 inputs: password = 32×0x01, salt = 16×0x02,
      // secret = 8×0x03, associated data = 12×0x04, p=4, t=3, m=32 KiB, len=32.
      //
      // ⚠️ This calls PointyCastle directly rather than
      // deriveBlindStoreMasterKey(), for two reasons that both matter:
      //   (1) the RFC vector uses the optional `secret` and `additional` inputs,
      //       which our production API deliberately does not expose (05 册 §2
      //       specifies neither), so it cannot be expressed through it;
      //   (2) m=32 KiB is not our production cost, and the production API must
      //       not accept arbitrary costs from production callers.
      // Its job is to certify the PRIMITIVE. That the primitive is then driven
      // with OUR parameters is what the next group pins.
      final Argon2Parameters params = Argon2Parameters(
        Argon2Parameters.ARGON2_id,
        Uint8List.fromList(List<int>.filled(16, 0x02)),
        desiredKeyLength: 32,
        secret: Uint8List.fromList(List<int>.filled(8, 0x03)),
        additional: Uint8List.fromList(List<int>.filled(12, 0x04)),
        iterations: 3,
        memory: 32,
        lanes: 4,
        version: Argon2Parameters.ARGON2_VERSION_13,
      );
      final Argon2BytesGenerator gen = Argon2BytesGenerator()..init(params);
      final Uint8List actual =
          gen.process(Uint8List.fromList(List<int>.filled(32, 0x01)));

      expect(
        _toHex(actual),
        _toHex(_hex(
          '0d640df58d78766c08c037a34a8b53c9'
          'd01ef0452d75b65eb52520e96b01e659',
        )),
        reason: 'RFC 9106 §5.3 Argon2id tag mismatch — the KDF is not the '
            'function 05 册 §2 specifies',
      );
    });
  });

  group('production parameters are exactly 05 册 §2', () {
    test('m=64MiB, t=3, p=4 — pinned as numbers, not as a reference', () {
      // 🔴 Stated as literals on purpose. Asserting
      // `Argon2Cost.production.memoryKiB == Argon2Cost.production.memoryKiB`
      // is the classic test that agrees with itself. These four literals are the
      // contract; if someone lowers the cost, this line is what says no.
      expect(Argon2Cost.production.memoryKiB, 65536, reason: '64 MiB in KiB');
      expect(Argon2Cost.production.iterations, 3);
      expect(Argon2Cost.production.lanes, 4);
      expect(kBlindStoreSaltBytes, 16);
      expect(kBlindStoreMasterKeyBytes, 32, reason: 'AES-256');
    });

    test('salt length is enforced, not merely documented', () {
      expect(
        () => deriveBlindStoreMasterKey(
          passphrase: 'x',
          salt: Uint8List(15),
          cost: _cheap,
        ),
        throwsArgumentError,
      );
      expect(generateBlindStoreSalt().length, kBlindStoreSaltBytes);
    });

    test('an empty passphrase is refused rather than silently derived', () {
      // Without this guard an empty passphrase produces a real, valid, weak key
      // and every blob sealed under it looks entirely normal — forever.
      expect(
        () => deriveBlindStoreMasterKey(
          passphrase: '',
          salt: Uint8List(16),
          cost: _cheap,
        ),
        throwsArgumentError,
      );
    });

    test('two salts give two different keys for the same passphrase', () {
      final Uint8List a = deriveBlindStoreMasterKey(
        passphrase: 'same-passphrase',
        salt: Uint8List.fromList(List<int>.filled(16, 1)),
        cost: _cheap,
      ).bytes;
      final Uint8List b = deriveBlindStoreMasterKey(
        passphrase: 'same-passphrase',
        salt: Uint8List.fromList(List<int>.filled(16, 2)),
        cost: _cheap,
      ).bytes;
      expect(_toHex(a), isNot(_toHex(b)));
    });

    test('the same passphrase + salt is reproducible — this is what makes the '
        'second device work at all (design §2.1)', () {
      final Uint8List salt = Uint8List.fromList(List<int>.filled(16, 7));
      final Uint8List first = deriveBlindStoreMasterKey(
        passphrase: '口令 with 中文 and emoji 🔐',
        salt: salt,
        cost: _cheap,
      ).bytes;
      final Uint8List second = deriveBlindStoreMasterKey(
        passphrase: '口令 with 中文 and emoji 🔐',
        salt: salt,
        cost: _cheap,
      ).bytes;
      expect(_toHex(first), _toHex(second));
    });

    test('the key redacts itself in toString()', () {
      final BlindStoreMasterKey k = deriveBlindStoreMasterKey(
        passphrase: 'secret',
        salt: Uint8List(16),
        cost: _cheap,
      );
      expect(k.toString(), isNot(contains(_toHex(k.bytes).substring(0, 8))));
      expect(k.toString(), contains('redacted'));
    });
  });

  group('real production cost', () {
    test('m=64MiB/t=3/p=4 actually runs, and we measure what it costs', () {
      // 🔴 The ONE test at real production parameters. Everything else above
      // uses `_cheap` and says so, per the card's instruction: reduced params
      // are legitimate when testing WIRING, but then nothing would ever measure
      // the real cost, and "it is deliberately slow" would be an unverified
      // claim about our own product.
      final Stopwatch sw = Stopwatch()..start();
      final BlindStoreMasterKey key = deriveBlindStoreMasterKey(
        passphrase: 'a-real-user-passphrase',
        salt: generateBlindStoreSalt(),
      );
      sw.stop();
      expect(key.bytes.length, kBlindStoreMasterKeyBytes);
      // Reported, not asserted as a bound: a wall-clock threshold in a test is a
      // flake generator, and the number differs on every machine. E-B2 owns the
      // UX consequence (this must never run on the UI isolate — see
      // deriveBlindStoreMasterKeyOffThread).
      // ignore: avoid_print
      print('MEASURED Argon2id(m=64MiB,t=3,p=4) on this host: '
          '${sw.elapsedMilliseconds} ms');
    }, timeout: const Timeout(Duration(seconds: 120)));

    test('the off-thread form derives the identical key', () async {
      final Uint8List salt = generateBlindStoreSalt();
      final BlindStoreMasterKey sync = deriveBlindStoreMasterKey(
        passphrase: 'off-thread-check',
        salt: salt,
        cost: _cheap,
      );
      final BlindStoreMasterKey async_ = await deriveBlindStoreMasterKeyOffThread(
        passphrase: 'off-thread-check',
        salt: salt,
        cost: _cheap,
      );
      expect(_toHex(async_.bytes), _toHex(sync.bytes));
    });
  });
}

/// Reduced cost for WIRING tests only — 64 KiB / 1 pass / 1 lane.
/// Declared once, named at every use site, so it is obvious in review which
/// assertions did NOT pay the real KDF price.
final Argon2Cost _cheap = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);
