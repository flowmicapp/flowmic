// E-B1 — the `e2e:v1:` AEAD envelope. Server-blind, per entry.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (`逐条目 AES-256-GCM(nonce12B
//   random, aad=entry.id, tag128)` — "per-entry AES-256-GCM(nonce 12B random,
//   aad=entry.id, tag 128)"; wire form `e2e:v1:` + base64);
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2, §3, §7-2.
//
// Wire format:
//     e2e:v1:<base64( nonce(12) ‖ tag(16) ‖ ciphertext )>
//
// ⚠️ The nonce‖tag‖ct ORDER is the same order apps/server-core/src/auth/crypto.ts
// uses for enc:v1: (iv‖tag‖ct). That is a coincidence of format, and it is worth
// naming precisely because it is the kind of coincidence that invites someone to
// "share the packing code". It must not be shared: identical layout is exactly
// what makes a mixed-up key or prefix invisible. See blind_store_params.dart's
// header for the full argument.
//
// ⚠️ PointyCastle's GCM emits ciphertext‖tag (BouncyCastle convention), i.e. the
// tag TRAILING. We re-order to put the tag in front. The reorder is therefore a
// real transformation, not a no-op, and `blind_store_envelope_test.dart` pins the
// byte offsets so a future refactor cannot quietly emit the library's native
// order — which would still base64-decode, still carry the right prefix, and
// still be exactly the right length.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'blind_store_key.dart';
import 'blind_store_params.dart';

/// Seals one timeline entry for blind storage.
///
/// [entryId] becomes the AEAD associated data. 🔴 This is not decoration
/// (05 册 §2, design §2): it binds the ciphertext to its own row, so a server
/// that moved entry A's bytes onto entry B's row produces a decryption FAILURE
/// rather than a plausible-looking wrong answer. Under blind storage this is the
/// client's ONLY means of self-certifying integrity — the server cannot check
/// anything, because by construction it cannot read anything.
///
/// [randomForNonce] exists solely so a known-answer test can pin a nonce.
/// Production must never pass it; `Random.secure()` is the default.
/// 🔴 A repeated (key, nonce) pair in GCM is catastrophic — it leaks the XOR of
/// two plaintexts AND allows tag forgery for that key. 12 random bytes per entry
/// is safe at our volumes; a counter would be safer still but would need durable
/// state that survives reinstall, which we do not have.
String sealBlindStoreEntry({
  required BlindStoreMasterKey key,
  required String entryId,
  required String plaintext,
  Random? randomForNonce,
}) {
  if (entryId.isEmpty) {
    // 🔴 An empty entry id yields an EMPTY aad, which is a legal GCM input. The
    // seal would succeed, the blob would look normal, and the cross-entry
    // binding above would simply not exist. Nothing downstream could ever detect
    // it. Refuse here — this is the single most consequential guard in the file.
    throw ArgumentError.value(entryId, 'entryId', 'must not be empty (aad binding)');
  }
  if (entryId == kBlindStoreSentinelEntryId) {
    throw const BlindStoreReservedIdException(kBlindStoreSentinelEntryId);
  }
  return _seal(
    key: key,
    aadSource: entryId,
    plaintext: plaintext,
    randomForNonce: randomForNonce,
  );
}

/// Opens one blind-store envelope.
///
/// Throws [BlindStoreCryptoException] on every failure path; never returns null,
/// never returns empty. Design §2.1: a wrong passphrase must fail LOUDLY and must
/// never degrade into 「云端是空的」 ("the cloud is empty").
String openBlindStoreEntry({
  required BlindStoreMasterKey key,
  required String entryId,
  required String envelope,
}) {
  if (entryId.isEmpty) {
    throw ArgumentError.value(entryId, 'entryId', 'must not be empty (aad binding)');
  }
  return _open(key: key, aadSource: entryId, envelope: envelope);
}

// ---------------------------------------------------------------------------
// Internals. Shared ONLY between the entry path and the sentinel path (both
// blind-store, both e2e:v1:). This is not a "generic envelope helper": the
// prefix is a constant, never a parameter, so there is no call site anywhere
// that could be handed 'enc:v1:'.
// ---------------------------------------------------------------------------

/// Seals with [aadSource] as associated data. Package-private on purpose.
String blindStoreSealRaw({
  required BlindStoreMasterKey key,
  required String aadSource,
  required String plaintext,
  Random? randomForNonce,
}) =>
    _seal(
      key: key,
      aadSource: aadSource,
      plaintext: plaintext,
      randomForNonce: randomForNonce,
    );

/// Opens with [aadSource] as associated data. Package-private on purpose.
String blindStoreOpenRaw({
  required BlindStoreMasterKey key,
  required String aadSource,
  required String envelope,
}) =>
    _open(key: key, aadSource: aadSource, envelope: envelope);

String _seal({
  required BlindStoreMasterKey key,
  required String aadSource,
  required String plaintext,
  Random? randomForNonce,
}) {
  final Random rng = randomForNonce ?? Random.secure();
  final Uint8List nonce = Uint8List(kBlindStoreNonceBytes);
  for (int i = 0; i < nonce.length; i++) {
    nonce[i] = rng.nextInt(256);
  }

  final GCMBlockCipher cipher = GCMBlockCipher(AESEngine())
    ..init(
      true,
      AEADParameters(
        KeyParameter(key.bytes),
        kBlindStoreTagBits,
        nonce,
        Uint8List.fromList(utf8.encode(aadSource)),
      ),
    );

  // PointyCastle returns ciphertext‖tag.
  final Uint8List ctThenTag = cipher.process(
    Uint8List.fromList(utf8.encode(plaintext)),
  );
  if (ctThenTag.length < kBlindStoreTagBytes) {
    throw const BlindStoreCryptoException(
      BlindStoreFailure.malformed,
      'AEAD output shorter than the tag; library contract violated',
    );
  }
  final int ctLength = ctThenTag.length - kBlindStoreTagBytes;
  final Uint8List ct = ctThenTag.sublist(0, ctLength);
  final Uint8List tag = ctThenTag.sublist(ctLength);

  // Re-order to nonce‖tag‖ct (05 册 §2 wire form).
  final Uint8List blob = Uint8List(nonce.length + tag.length + ct.length)
    ..setRange(0, nonce.length, nonce)
    ..setRange(nonce.length, nonce.length + tag.length, tag)
    ..setRange(nonce.length + tag.length, nonce.length + tag.length + ct.length, ct);

  return kBlindStoreEnvelopePrefix + base64.encode(blob);
}

String _open({
  required BlindStoreMasterKey key,
  required String aadSource,
  required String envelope,
}) {
  if (!envelope.startsWith(kBlindStoreEnvelopePrefix)) {
    // Reported distinctly from `malformed`: this is the case that can mean the
    // value came from the WRONG NAMESPACE — including an enc:v1: value having
    // reached a blind-store field, which is the red line itself.
    throw const BlindStoreCryptoException(
      BlindStoreFailure.wrongPrefix,
      "expected '$kBlindStoreEnvelopePrefix' prefix",
    );
  }

  final Uint8List blob;
  try {
    blob = base64.decode(envelope.substring(kBlindStoreEnvelopePrefix.length));
  } on FormatException catch (e) {
    throw BlindStoreCryptoException(
      BlindStoreFailure.malformed,
      'payload is not valid base64: ${e.message}',
    );
  }

  const int headerBytes = kBlindStoreNonceBytes + kBlindStoreTagBytes;
  if (blob.length < headerBytes) {
    throw BlindStoreCryptoException(
      BlindStoreFailure.malformed,
      'payload is ${blob.length} bytes, need at least $headerBytes',
    );
  }

  final Uint8List nonce = blob.sublist(0, kBlindStoreNonceBytes);
  final Uint8List tag = blob.sublist(kBlindStoreNonceBytes, headerBytes);
  final Uint8List ct = blob.sublist(headerBytes);

  final GCMBlockCipher cipher = GCMBlockCipher(AESEngine())
    ..init(
      false,
      AEADParameters(
        KeyParameter(key.bytes),
        kBlindStoreTagBits,
        nonce,
        Uint8List.fromList(utf8.encode(aadSource)),
      ),
    );

  // Back to the library's native ciphertext‖tag order.
  final Uint8List ctThenTag = Uint8List(ct.length + tag.length)
    ..setRange(0, ct.length, ct)
    ..setRange(ct.length, ct.length + tag.length, tag);

  final Uint8List plain;
  try {
    plain = cipher.process(ctThenTag);
  } on Object catch (e) {
    // PointyCastle raises InvalidCipherTextException on tag mismatch. We catch
    // broadly and report ONE verdict, because GCM genuinely answers one bit:
    // wrong key, tampered bytes, and wrong entry id are indistinguishable here.
    // 🔴 Do not "improve" this into a message that claims to know which.
    throw BlindStoreCryptoException(
      BlindStoreFailure.authenticationFailed,
      'AEAD authentication failed (wrong key, wrong entry id, or tampered): '
      '${e.runtimeType}',
    );
  }

  try {
    return utf8.decode(plain);
  } on FormatException catch (e) {
    throw BlindStoreCryptoException(
      BlindStoreFailure.malformed,
      'authenticated plaintext is not valid UTF-8: ${e.message}',
    );
  }
}
