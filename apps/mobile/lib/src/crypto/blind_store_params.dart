// E-B1 — blind-store (e2e:v1:) cryptographic parameters.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (dual-prefix encryption table, row `e2e:v1:`);
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2 (key model),
//   §2.1 (multi-device / sentinel), §7-2 (the negative assertion this layer owes).
//
// 🔴🔴 THE DOUBLE-PREFIX RED LINE, IN ITS EXECUTABLE FORM.
//
// This repo has TWO AES-256-GCM envelopes whose shapes are nearly identical:
//
//   enc:v1:  server-decryptable credential envelope, key = SHA-256(deployment
//            secret). Implementation: apps/server-core/src/auth/crypto.ts
//            (symbols `ENVELOPE_PREFIX`, `encrypt`, `decrypt`, `deriveKey`).
//   e2e:v1:  server-BLIND timeline envelope, key = Argon2id(user passphrase).
//            Implementation: this directory, and nowhere else.
//
// 05 册 §2 states the invariant as 「两前缀永不互换」("the two prefixes are
// never interchangeable"). The failure shape that
// invariant exists to prevent is NOT "somebody types the wrong string" — it is
// "the two implementations get refactored into one generic envelope helper",
// after which a single wrong argument produces server-decryptable bytes that
// STILL CARRY THE `e2e:v1:` PREFIX and therefore still satisfy the server-side
// guard `assertE2ePrefix` (apps/server-core/src/db/repos/timeline.repo.ts) and
// the zod type `E2eCiphertext` (packages/protocol/src/protocol-schemas-timeline.ts).
// Both of those check the literal prefix and nothing else — they are a namespace
// marker, NOT a cryptographic validator (design §1.1).
//
// ⇒ Therefore this implementation is deliberately INDEPENDENT:
//   - it shares no code path with auth/crypto.ts (different language, different
//     library, different key schedule — and that is the point, not an accident);
//   - `kBlindStoreEnvelopePrefix` is a private-by-convention constant that is
//     never accepted as a PARAMETER anywhere in this directory, so there is no
//     call site that can be handed 'enc:v1:' by mistake;
//   - `blind_store_envelope_isolation_test.dart` pins both properties by
//     reading this directory's own source.
//
// ⚠️ auth/crypto.ts's `deriveKey` is a bare SHA-256 of the deployment secret
// (no salt, no HKDF, no domain separation). That is a known defect owned by the
// D2-SECRETS workstream. The Argon2id path below has NOTHING to do with it and
// must never be "unified" with it: they answer different questions (at-rest key
// for a secret the server is ALLOWED to read, vs. a key the server must never
// be able to derive at all).

import 'package:meta/meta.dart';

/// Envelope prefix for server-blind timeline blobs.
///
/// Mirrors `TIMELINE_E2E_PREFIX` in packages/protocol/src/protocol-schemas-timeline.ts.
/// That constant is the server's admission check; this one is what we emit. They
/// must stay equal, and `blind_store_envelope_isolation_test.dart` asserts it by
/// reading the TypeScript source rather than restating the string here — the same
/// mirror technique as inject_verdict_authorship_mirror_test.dart.
const String kBlindStoreEnvelopePrefix = 'e2e:v1:';

/// AES-256-GCM nonce length, in bytes (05 册 §2: `nonce 12B random`).
///
/// 12 is not a preference: it is the only nonce length GCM uses directly as the
/// initial counter block. Any other length is hashed through GHASH first, which
/// is a second, less-reviewed code path for no benefit.
const int kBlindStoreNonceBytes = 12;

/// AES-256-GCM authentication tag length, in bytes (05 册 §2: `tag 128`).
const int kBlindStoreTagBytes = 16;

/// AES-256-GCM tag length in BITS, which is the unit PointyCastle's
/// `AEADParameters` takes. Stated separately so no call site multiplies by 8
/// inline — a silent /8 or *8 error here weakens the tag without failing anything.
const int kBlindStoreTagBits = kBlindStoreTagBytes * 8;

/// MasterKey length, in bytes (05 册 §2: `MasterKey 32B` ⇒ AES-256).
const int kBlindStoreMasterKeyBytes = 32;

/// Argon2id salt length, in bytes (05 册 §2: `salt 16B`).
const int kBlindStoreSaltBytes = 16;

/// The sentinel plaintext, verbatim from 05 册 §2:
/// 「本地验证 blob `AES-GCM(MasterKey,'flowmic-e2ee-v1')`，服务端不参与判定」
/// ("locally verified blob `AES-GCM(MasterKey,'flowmic-e2ee-v1')`; the server
/// takes no part in the verdict").
///
/// 🔴 Changing this string invalidates every already-stored sentinel, which
/// would lock users out of their own cloud records on the second device. It is
/// a wire-format constant, not a label.
const String kBlindStoreSentinelPlaintext = 'flowmic-e2ee-v1';

/// The reserved entry id the sentinel is sealed under.
///
/// 05 册 specifies the sentinel only as `AES-GCM(MasterKey, 'flowmic-e2ee-v1')`
/// and says nothing about an aad. We seal it under a reserved pseudo-entry id
/// instead of adding a second, aad-less code path, because a second code path is
/// precisely the thing §2's red line warns about: an AEAD call that takes an
/// EMPTY aad, sitting one argument away from the real entry path.
///
/// The reservation is enforced, not documented: [BlindStoreReservedIdException]
/// is thrown if a real entry ever tries to use this id.
const String kBlindStoreSentinelEntryId = 'flowmic-e2ee-sentinel-v1';

/// Argon2id cost parameters.
///
/// The production values come from 05 册 §2 and are NOT tunable at runtime: the
/// envelope format has no field carrying them, so a device that derived with
/// different costs would produce a MasterKey that silently fails to open its own
/// blobs. The only reason this is a type rather than three bare constants is that
/// tests which exercise WIRING (not the KDF) cannot afford 64 MiB × 3 passes on
/// every case — see [Argon2Cost.reducedForTestsOnly].
@immutable
class Argon2Cost {
  const Argon2Cost._({
    required this.memoryKiB,
    required this.iterations,
    required this.lanes,
    required this.label,
  });

  /// Memory cost in KiB. Production = 65536 KiB = 64 MiB.
  final int memoryKiB;

  /// Time cost (passes). Production = 3.
  final int iterations;

  /// Parallelism (lanes). Production = 4.
  final int lanes;

  /// Human-readable name, so a failure message can say WHICH cost was used.
  final String label;

  /// The one and only set of parameters production may use (05 册 §2:
  /// `Argon2id(m=64MiB, t=3, p=4, salt 16B)`).
  static const Argon2Cost production = Argon2Cost._(
    memoryKiB: 64 * 1024,
    iterations: 3,
    lanes: 4,
    label: 'production',
  );

  /// TEST-ONLY reduced parameters.
  ///
  /// 🔴 Naming is the guard here. Production code calling anything named
  /// `reducedForTestsOnly` would be visible in review, and
  /// `blind_store_envelope_isolation_test.dart` greps lib/ to prove the call
  /// count is zero — the repo's standard anti-façade grep, run in reverse.
  ///
  /// ⚠️ A reduced-cost MasterKey is a REAL key that produces REAL ciphertext
  /// indistinguishable from production ciphertext. It is weak, not broken, so
  /// nothing downstream would ever complain. That is why the check is a grep and
  /// not a runtime assert: by the time it ran, the weak blob would already exist.
  factory Argon2Cost.reducedForTestsOnly({
    required int memoryKiB,
    required int iterations,
    required int lanes,
  }) {
    return Argon2Cost._(
      memoryKiB: memoryKiB,
      iterations: iterations,
      lanes: lanes,
      label: 'reduced-for-tests(m=${memoryKiB}KiB,t=$iterations,p=$lanes)',
    );
  }

  @override
  String toString() => 'Argon2Cost($label)';
}

/// Why a blind-store envelope could not be opened.
///
/// 🔴 Design §2.1: a wrong passphrase must fail LOUDLY and must never degrade
/// into 「云端是空的」("the cloud is empty") — that would turn a solvable
/// problem (re-enter the passphrase) into an apparently unsolvable one (the
/// data is gone). Every
/// failure below is therefore an exception, never a null and never an empty
/// result. The variants exist so E-B4 can COUNT and SPEAK about partial failure
/// rather than swallowing it.
enum BlindStoreFailure {
  /// The string does not start with `e2e:v1:`. Distinct from [malformed]
  /// because it is the one case that might mean "this came from the wrong
  /// namespace entirely" — including the enc:v1: red line being crossed.
  wrongPrefix,

  /// Prefix is right, but the payload is not valid base64 or is shorter than
  /// nonce+tag. The blob is damaged; a different passphrase will not help.
  malformed,

  /// AEAD authentication failed. Either the passphrase/MasterKey is wrong, or
  /// the ciphertext was tampered with, or it was moved onto a DIFFERENT entry
  /// id (the aad binding — 05 册 §2, design §2).
  ///
  /// ⚠️ These three genuinely cannot be told apart from the ciphertext alone;
  /// GCM answers one bit. Do not invent a message that claims to know which.
  authenticationFailed,
}

/// Raised whenever a blind-store envelope cannot be produced or opened.
class BlindStoreCryptoException implements Exception {
  const BlindStoreCryptoException(this.failure, this.detail);

  final BlindStoreFailure failure;

  /// Operator-facing detail. 🔴 Must never contain plaintext, passphrase or key
  /// material — this string is expected to reach diagnostics logs.
  final String detail;

  @override
  String toString() => 'BlindStoreCryptoException(${failure.name}: $detail)';
}

/// Raised when a caller tries to seal a real entry under the reserved sentinel
/// id, which would make a normal record indistinguishable from the key check.
class BlindStoreReservedIdException implements Exception {
  const BlindStoreReservedIdException(this.entryId);

  final String entryId;

  @override
  String toString() =>
      "BlindStoreReservedIdException: '$entryId' is reserved for the sentinel";
}
