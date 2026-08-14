// E-B1 — MasterKey derivation for the server-blind timeline store.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (`口令→Argon2id(m=64MiB,t=3,p=4,
//   salt16B)→MasterKey32B（仅存客户端 keystore/DPAPI/Android Keystore，永不上行）`
//   — "passphrase → Argon2id(m=64MiB,t=3,p=4, salt16B) → MasterKey32B (kept
//   ONLY in the client keystore/DPAPI/Android Keystore, never sent upstream)");
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2, §2.1.
//
// 🔴 The MasterKey NEVER leaves the device. Nothing in this file writes it
// anywhere; persistence into the platform keystore is card E-B2's job, and the
// only reason this file exposes a type rather than a bare Uint8List is so that
// "a 32-byte list" and "the key" cannot be confused at that call site.
//
// 🔴 Forgetting the passphrase means the cloud ciphertext is unrecoverable
// (05 册 §2: 「忘记口令 = 云端密文不可恢复」 — "forgetting the passphrase = the
// cloud ciphertext is unrecoverable"). That is the DEFINITION of blind
// storage, not a defect — and the product must say so once, explicitly, up
// front (design §2.1). There is no recovery hook here on purpose: a recovery
// path that the server could drive would mean the server can derive the key.

import 'dart:convert';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'blind_store_params.dart';

/// A derived 32-byte AES-256 key for the blind store.
///
/// Deliberately not a plain `Uint8List`: [BlindStoreEnvelope] and the sentinel
/// take this type, so a caller cannot accidentally hand them a salt, a nonce, a
/// JWT, or the server's SHA-256 deployment key — all of which are also byte
/// lists of plausible length.
class BlindStoreMasterKey {
  /// Wraps raw key bytes. Used by E-B2 when re-loading a key from the keystore.
  ///
  /// Copies the input so a caller that zeroes its buffer afterwards (which it
  /// should) does not silently blank a live key.
  BlindStoreMasterKey.fromBytes(Uint8List bytes)
      : _bytes = Uint8List.fromList(bytes) {
    if (bytes.length != kBlindStoreMasterKeyBytes) {
      throw ArgumentError.value(
        bytes.length,
        'bytes.length',
        'MasterKey must be exactly $kBlindStoreMasterKeyBytes bytes (AES-256)',
      );
    }
  }

  final Uint8List _bytes;

  /// Raw key material. Only [BlindStoreEnvelope] and E-B2's keystore writer have
  /// any business calling this.
  Uint8List get bytes => _bytes;

  /// 🔴 Redacted on purpose. A key that renders itself in a log line, a
  /// diagnostics upload or a crash report is a key that has left the device —
  /// which is the one thing the whole scheme forbids. Dart's default
  /// `Object.toString()` would print only the type, but a future `@override`
  /// elsewhere, an interpolation of `bytes`, or a `jsonEncode` of a holding
  /// object would not; this makes the intent explicit and greppable.
  @override
  String toString() => 'BlindStoreMasterKey(<redacted, 32 bytes>)';
}

/// Generates a fresh 16-byte Argon2id salt (05 册 §2: `salt 16B`).
///
/// Uses `Random.secure()`, which Dart backs with the platform CSPRNG
/// (`/dev/urandom` on Android, BCryptGenRandom on Windows). PointyCastle's own
/// `FortunaRandom` was the alternative and was rejected: it must itself be
/// seeded from `Random.secure()`, so it adds a userspace generator whose only
/// possible effect on entropy is to lose some.
///
/// The salt is NOT secret and must be stored next to the ciphertext-bearing
/// account (E-B2), because it is required to re-derive the same MasterKey on a
/// second device from the same passphrase (design §2.1).
Uint8List generateBlindStoreSalt({Random? random}) {
  final Random rng = random ?? Random.secure();
  final Uint8List salt = Uint8List(kBlindStoreSaltBytes);
  for (int i = 0; i < salt.length; i++) {
    salt[i] = rng.nextInt(256);
  }
  return salt;
}

/// Derives the MasterKey from a passphrase with Argon2id.
///
/// 🔴 This is CPU- and memory-bound by design: at [Argon2Cost.production] it
/// allocates 64 MiB and makes 3 passes over it. Calling it on the UI isolate
/// will jank or ANR the app — use [deriveBlindStoreMasterKeyOffThread] from
/// anything with a widget tree. The synchronous form is kept because it is what
/// makes the KDF unit-testable against a fixed known-answer vector.
///
/// ⚠️ Argon2id specifically, not Argon2i or Argon2d (05 册 §2). PointyCastle's
/// OWN test suite covers only Argon2i (`test/key_derivators/argon2_vm_test.dart`
/// passes `Argon2Parameters.ARGON2_i` for every case), so the mode we depend on
/// is not exercised upstream. That is why `blind_store_kdf_vector_test.dart`
/// carries the RFC 9106 §5.3 Argon2id known-answer vector: without it, nothing
/// anywhere proves this call is producing Argon2id at all.
BlindStoreMasterKey deriveBlindStoreMasterKey({
  required String passphrase,
  required Uint8List salt,
  Argon2Cost cost = Argon2Cost.production,
}) {
  if (passphrase.isEmpty) {
    // An empty passphrase derives a perfectly valid key, and every blob sealed
    // under it would look normal forever. Refuse at the only moment the mistake
    // is still cheap. (Strength policy beyond "non-empty" is E-B2's, not ours.)
    throw ArgumentError.value(passphrase, 'passphrase', 'must not be empty');
  }
  if (salt.length != kBlindStoreSaltBytes) {
    throw ArgumentError.value(
      salt.length,
      'salt.length',
      'salt must be exactly $kBlindStoreSaltBytes bytes',
    );
  }

  final Argon2Parameters params = Argon2Parameters(
    Argon2Parameters.ARGON2_id,
    salt,
    desiredKeyLength: kBlindStoreMasterKeyBytes,
    // 0x13 is Argon2 v1.3, the version RFC 9106 standardises. PointyCastle's
    // default happens to be the same value, but it is stated explicitly because
    // v1.0 produces DIFFERENT output for identical inputs — a silent default
    // change upstream would lock every existing user out of their own blobs.
    version: Argon2Parameters.ARGON2_VERSION_13,
    iterations: cost.iterations,
    memory: cost.memoryKiB,
    lanes: cost.lanes,
  );

  final Argon2BytesGenerator generator = Argon2BytesGenerator()..init(params);
  final Uint8List derived = generator.process(
    Uint8List.fromList(utf8.encode(passphrase)),
  );
  return BlindStoreMasterKey.fromBytes(derived);
}

/// [deriveBlindStoreMasterKey] on a background isolate.
///
/// This exists so E-B2 cannot get it wrong by default. The passphrase is copied
/// into the isolate (Dart isolates do not share mutable memory), which is the
/// same exposure as holding it in a `String` on the main isolate — Dart gives us
/// no way to wipe either, so this is not a new weakness, just not an improvement.
///
/// 🔴 The [Argon2Cost] is captured and sent WHOLE, deliberately. An earlier
/// version of this function decomposed it into three ints and rebuilt it inside
/// the isolate, which meant the rebuild had to call
/// `Argon2Cost.reducedForTestsOnly` — putting a real production call site on the
/// test-only factory, i.e. a supported path by which production could derive a
/// weak key. `blind_store_prefix_isolation_test.dart`'s zero-call-sites
/// assertion is what caught it. Capturing the object removes the branch
/// entirely: there is now no code anywhere that can CONSTRUCT a reduced cost
/// except a test.
Future<BlindStoreMasterKey> deriveBlindStoreMasterKeyOffThread({
  required String passphrase,
  required Uint8List salt,
  Argon2Cost cost = Argon2Cost.production,
}) async {
  final Uint8List bytes = await Isolate.run(
    () => deriveBlindStoreMasterKey(
      passphrase: passphrase,
      salt: salt,
      cost: cost,
    ).bytes,
  );
  return BlindStoreMasterKey.fromBytes(bytes);
}
