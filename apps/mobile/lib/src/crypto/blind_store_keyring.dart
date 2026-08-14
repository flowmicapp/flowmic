// E-CL — the key HOLDER. Turns「用户的口令」("the user's passphrase") into a live MasterKey and keeps it
// available across launches, so the write/read paths in
// lib/src/timeline/cloud/ have a real key rather than a parameter nobody fills.
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §2 (Argon2id → MasterKey 32B, kept
//   ONLY in the client keystore, never sent upstream; sentinel =
//   AES-GCM(MasterKey,'flowmic-e2ee-v1'));
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §2 / §2.1.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It is NOT card E-B2. E-B2 owns the key LIFECYCLE the user can see: the
// passphrase prompt, the 「口令丢失 = 数据不可恢复」("losing the passphrase = the
// data cannot be recovered") disclosure that design §2.1 requires to land on
// the rendered result, and the second-device flow. Nothing here renders
// anything and nothing here authors a user-visible string — E-CL was scoped to
// the wiring, and copy is another lane this wave.
//
// The consequence is worth stating plainly rather than leaving for someone to
// discover: **with no enrolment UI in the tree, [hasEnrolled] is false on every
// real install, so the cloud write path is INERT in production today.** That is
// the honest reading of 「云端轻记录默认开还是默认关」("should the cloud light
// records default to on or off") (design §8 待裁 ②, still unruled): nothing
// goes to the cloud until a user deliberately sets a passphrase. This is a fact
// about today's tree, not a setting — there is no key to flip, and none was
// invented here.
//
// ── 🔴 THE OPEN GAP: A SECOND DEVICE CANNOT DERIVE THE SAME KEY TODAY ────────
// owner ruling E-① (2026-08-02 batch, item 5) says the devices of one account
// SHARE the cloud light records, hence share one key, and「设计必须含设备间传钥
// 机制」("the design must include a cross-device key-transfer mechanism").
// Design §2.1 answers 「同口令重输」("re-enter the same passphrase") and
// specifies the verification half
// (derive → pull sentinel → it opens ⇒ right key). It does NOT say where the
// SALT comes from, and Argon2id(passphrase, saltA) ≠ Argon2id(passphrase,
// saltB): the same passphrase on a second device derives a DIFFERENT key unless
// that device gets the FIRST device's salt. blind_store_key.dart's own doc
// already assigns that to E-B2 (「must be stored next to the ciphertext-bearing
// account (E-B2)」).
//
// ⇒ This card does not invent the distribution mechanism. Every candidate is a
// real decision someone with authority has to make, not a detail:
//   · put the salt in a cloud row → the salt must be readable BEFORE any key
//     exists, so it cannot live inside an `e2e:v1:` ciphertext, and every field
//     that could carry it in the clear is a protocol change (forbidden here);
//   · derive the salt from the account id → deterministic and per-user-unique,
//     which is all a salt owes, but it is a NEW cryptographic design decision
//     and this file is not the place a reviewer expects to find one.
//
// So: [enroll] mints a device-local random salt (correct, and the only truthful
// thing available for one device), and [adoptSharedKeyMaterial] is the seam that
// takes another device's salt when E-B2 has a way to carry it. Multi-device is
// therefore CODE-READY and MECHANISM-BLOCKED, and this card claims exactly that
// — not that it works.
//
// ── ✅ IN-PLACE UPDATE (SALT-2, 2026-08-11): THE GAP ABOVE IS CLOSED ─────────
// The section above was true when E-CL wrote it and stays as its record. The
// distribution mechanism now exists, decided WITH authority (owner delegated
// the design: docs/strategy/2026-08-11-design-e-multidevice-salt.md — it chose
// the first candidate): salt + sentinel are per-account key metadata stored
// server-side in the clear, fetched over authenticated HTTP; zero protocol
// events moved. [adoptSharedKeyMaterial] has its production caller now —
// lib/src/timeline/cloud/blind_store_key_provisioner.dart (grep it). What is
// STILL missing is the enrolment UI that asks for the passphrase (E-B2), so
// multi-device remains unreachable by a USER until that lands — the mechanism
// is wired, the doorway is not.

import 'dart:convert';
import 'dart:typed_data';

import 'blind_store_envelope.dart';
import 'blind_store_key.dart';
import 'blind_store_params.dart';
import 'blind_store_sentinel.dart';

/// Raised when a passphrase does not open this account's blind store.
///
/// 🔴 A distinct type, not a bool and not a null. Design §2.1: a wrong
/// passphrase must fail LOUDLY and must never degrade into 「云端是空的」("the
/// cloud is empty"), because that turns a solvable problem (type it again)
/// into an apparently unsolvable one (the data is gone). A caller that wants
/// to say something to the user has to catch something, and catching
/// `Exception` would also swallow storage faults — which need a different
/// sentence.
class BlindStorePassphraseRejected implements Exception {
  const BlindStorePassphraseRejected();

  @override
  String toString() =>
      'BlindStorePassphraseRejected: the derived key does not open this '
      "device's sentinel";
}

/// Raised when [unlock] is asked to open a store that was never enrolled.
///
/// Separate from [BlindStorePassphraseRejected] because the two need opposite
/// responses: 「你输错了」("you typed it wrong") vs 「这台设备还没设过口令」("this
/// device has never set a passphrase"). One exception answering both would be
/// this repo's headline bug shape.
class BlindStoreNotEnrolled implements Exception {
  const BlindStoreNotEnrolled();

  @override
  String toString() => 'BlindStoreNotEnrolled: no key material on this device';
}

/// What a device persists so it can re-derive and self-check its own key.
///
/// The salt is NOT secret (blind_store_key.dart says so at its generator) and
/// the sentinel is ciphertext. [masterKeyB64] IS secret — it is the MasterKey
/// itself, cached so the user is not asked for the passphrase on every launch.
/// All three live in the platform keystore together because the weakest of them
/// decides the storage class, and that is the MasterKey.
class BlindStoreKeyMaterial {
  const BlindStoreKeyMaterial({
    required this.salt,
    required this.sentinel,
    this.masterKeyB64,
  });

  /// Argon2id salt, 16 bytes.
  final Uint8List salt;

  /// `e2e:v1:` sentinel envelope — the local key check (05 册 §2). Server never
  /// participates in the verdict.
  final String sentinel;

  /// The derived MasterKey, base64. Null ⇒ enrolled but currently locked (the
  /// passphrase is needed to get back in).
  final String? masterKeyB64;

  Map<String, Object?> toJson() => <String, Object?>{
    'salt': base64.encode(salt),
    'sentinel': sentinel,
    if (masterKeyB64 != null) 'master_key': masterKeyB64,
  };

  static BlindStoreKeyMaterial? fromJson(Map<String, Object?> j) {
    final Object? salt = j['salt'];
    final Object? sentinel = j['sentinel'];
    if (salt is! String || sentinel is! String || sentinel.isEmpty) return null;
    final Uint8List decoded;
    try {
      decoded = base64.decode(salt);
    } on FormatException {
      return null;
    }
    if (decoded.length != kBlindStoreSaltBytes) return null;
    final Object? key = j['master_key'];
    return BlindStoreKeyMaterial(
      salt: decoded,
      sentinel: sentinel,
      masterKeyB64: key is String && key.isNotEmpty ? key : null,
    );
  }
}

/// Where [BlindStoreKeyMaterial] lives. An interface for the same reason every
/// other seam in this repo is one: unit tests must not need a platform plugin,
/// and 「读不回来」("could not be read back") needs somewhere to be said out
/// loud.
///
/// 🔴 THE PRODUCTION IMPLEMENTATION IS DELIBERATELY NOT IN THIS DIRECTORY. It
/// needs `flutter_secure_storage`, and `blind_store_prefix_isolation_test.dart`
/// 「lib/src/crypto/ does not reach into any other subsystem」 allows this layer
/// to import only `dart:*`, pointycastle, meta and its own files.
///
/// That rule caught a real layering mistake in this card's first draft, so it is
/// worth restating rather than working around: keeping a plugin out of the
/// cryptography face is what makes the face reviewable in one sitting, and
/// persisting bytes is a STORAGE concern that merely happens to involve secret
/// bytes. The platform-backed store therefore lives with the leg that composes
/// it — `lib/src/timeline/cloud/blind_store_secure_key_store.dart`.
abstract interface class BlindStoreKeyStore {
  Future<BlindStoreKeyMaterial?> read();

  Future<void> write(BlindStoreKeyMaterial material);

  Future<void> clear();
}

/// In-memory store — tests and nothing else.
///
/// ⚠️ A legitimate double, not the 「友好的空实现」("friendly empty
/// implementation") 13 册 §7 F1 ② bans: it stores what it was given and hands
/// it back. The banned shape is the one that pretends a write succeeded and
/// then answers null.
class InMemoryBlindStoreKeyStore implements BlindStoreKeyStore {
  BlindStoreKeyMaterial? _material;

  @override
  Future<BlindStoreKeyMaterial?> read() async => _material;

  @override
  Future<void> write(BlindStoreKeyMaterial material) async {
    _material = material;
  }

  @override
  Future<void> clear() async {
    _material = null;
  }
}

/// Holds the live MasterKey for the blind-store write/read paths.
///
/// The key never leaves this object except through [key], and it is never
/// serialised anywhere but [BlindStoreKeyStore] (the platform keystore in
/// production). 05 册 §2: 永不上行 ("never sent upstream") — there is no code
/// path here that puts key material on a wire, and the cloud client takes
/// ciphertext, never a key.
class BlindStoreKeyring {
  BlindStoreKeyring({
    required BlindStoreKeyStore store,
    Argon2Cost cost = Argon2Cost.production,
  }) : _store = store,
       _cost = cost;

  final BlindStoreKeyStore _store;

  /// 🔴 Production ALWAYS uses [Argon2Cost.production] — this parameter exists
  /// so wiring tests do not pay 738 ms per derive, and there is no production
  /// call site that passes anything else (main.dart constructs this with the
  /// default). `blind_store_prefix_isolation_test.dart` proves lib/ never
  /// constructs a reduced cost at all.
  final Argon2Cost _cost;

  BlindStoreMasterKey? _key;

  /// True once a passphrase has opened this device's store in this process.
  bool get isUnlocked => _key != null;

  /// The live key, or null while locked. Callers must treat null as 「不能上行，
  /// 也不能读回」("cannot upload, and cannot read back either") — never as
  /// 「云端是空的」("the cloud is empty").
  BlindStoreMasterKey? get key => _key;

  /// Has this device ever enrolled a passphrase?
  ///
  /// False on every install today (there is no enrolment UI — see the file
  /// header), which is exactly why the cloud path stays inert.
  Future<bool> hasEnrolled() async => (await _store.read()) != null;

  /// Re-open the store from persisted material WITHOUT a passphrase.
  ///
  /// Returns true iff the cached MasterKey was present AND still opens the
  /// sentinel. The sentinel check is not ceremony: it is the one cheap way to
  /// catch material that was truncated or half-written, and it costs a single
  /// AES-GCM open rather than a 64 MiB derive.
  Future<bool> restore() async {
    final BlindStoreKeyMaterial? m = await _store.read();
    final String? b64 = m?.masterKeyB64;
    if (m == null || b64 == null) return false;
    final Uint8List bytes;
    try {
      bytes = base64.decode(b64);
    } on FormatException {
      return false;
    }
    if (bytes.length != kBlindStoreMasterKeyBytes) return false;
    final BlindStoreMasterKey candidate = BlindStoreMasterKey.fromBytes(bytes);
    if (!blindStoreSentinelAccepts(key: candidate, sentinel: m.sentinel)) {
      return false;
    }
    _key = candidate;
    return true;
  }

  /// First enrolment on this device: mint a salt, derive, seal a sentinel,
  /// persist, and leave the keyring unlocked.
  ///
  /// 🔴 Refuses to overwrite existing material. Re-enrolling would mint a NEW
  /// salt, hence a NEW key, and every blob already in the cloud would stop
  /// opening — silently, because the only symptom is 「解不开的条目」("entries
  /// that cannot be decrypted"). Replacing a
  /// passphrase is a real feature with a real migration (re-seal every entry)
  /// and it is E-B2's, not a side effect of calling this twice.
  Future<void> enroll(String passphrase) async {
    if (await hasEnrolled()) {
      throw StateError(
        'blind store already enrolled on this device — re-enrolling would '
        'orphan every blob already pushed (E-B2 owns passphrase change)',
      );
    }
    final Uint8List salt = generateBlindStoreSalt();
    final BlindStoreMasterKey k = await deriveBlindStoreMasterKeyOffThread(
      passphrase: passphrase,
      salt: salt,
      cost: _cost,
    );
    await _store.write(
      BlindStoreKeyMaterial(
        salt: salt,
        sentinel: createBlindStoreSentinel(key: k),
        masterKeyB64: base64.encode(k.bytes),
      ),
    );
    _key = k;
  }

  /// Re-open with the passphrase, against the salt and sentinel already stored.
  ///
  /// Throws [BlindStoreNotEnrolled] if there is nothing to open, and
  /// [BlindStorePassphraseRejected] if the derived key does not open the
  /// sentinel. Neither is ever answered with an empty result.
  Future<void> unlock(String passphrase) async {
    final BlindStoreKeyMaterial? m = await _store.read();
    if (m == null) throw const BlindStoreNotEnrolled();
    final BlindStoreMasterKey k = await deriveBlindStoreMasterKeyOffThread(
      passphrase: passphrase,
      salt: m.salt,
      cost: _cost,
    );
    if (!blindStoreSentinelAccepts(key: k, sentinel: m.sentinel)) {
      throw const BlindStorePassphraseRejected();
    }
    _key = k;
    await _store.write(
      BlindStoreKeyMaterial(
        salt: m.salt,
        sentinel: m.sentinel,
        masterKeyB64: base64.encode(k.bytes),
      ),
    );
  }

  /// Second device: adopt ANOTHER device's salt + sentinel and verify the
  /// passphrase against them (design §2.1's 「同口令重输」 — "re-enter the same
  /// passphrase").
  ///
  /// 🔴 E-CL left this seam deliberately caller-less (inventing the salt
  /// transport here would have been a cryptographic design decision made in
  /// the wrong place). SALT-2 gave it its ONE production caller: the keymeta
  /// provisioner (lib/src/timeline/cloud/blind_store_key_provisioner.dart),
  /// which hands it the account's stored salt + sentinel fetched over
  /// authenticated HTTP (design 2026-08-11 §3.2). It must STAY the only
  /// caller — a second one would be a second answer to 「这台设备的钥匙怎么来的」
  /// ("where did this device's key come from").
  Future<void> adoptSharedKeyMaterial({
    required Uint8List salt,
    required String sentinel,
    required String passphrase,
  }) async {
    final BlindStoreMasterKey k = await deriveBlindStoreMasterKeyOffThread(
      passphrase: passphrase,
      salt: salt,
      cost: _cost,
    );
    if (!blindStoreSentinelAccepts(key: k, sentinel: sentinel)) {
      throw const BlindStorePassphraseRejected();
    }
    await _store.write(
      BlindStoreKeyMaterial(
        salt: salt,
        sentinel: sentinel,
        masterKeyB64: base64.encode(k.bytes),
      ),
    );
    _key = k;
  }

  /// The salt + sentinel this device enrolled, for whatever E-B2 builds to move
  /// them to a second device. Returns null when not enrolled. Deliberately does
  /// NOT expose the MasterKey.
  Future<({Uint8List salt, String sentinel})?> sharedKeyMaterial() async {
    final BlindStoreKeyMaterial? m = await _store.read();
    if (m == null) return null;
    return (salt: m.salt, sentinel: m.sentinel);
  }

  /// Drop the in-memory key. The persisted material stays, so [restore] can
  /// re-open without a passphrase — this is a process-lifetime lock, not a
  /// forget. (Forgetting is [BlindStoreKeyStore.clear], and it destroys access
  /// to every blob in the cloud, so it belongs to a flow that can say so.)
  void lock() {
    _key = null;
  }

  /// Forget this device's key material entirely — the store AND the live key.
  ///
  /// 🔴 THE ONE LEGITIMATE PRODUCTION CALLER IS THE KEYMETA PROVISIONER'S
  /// 409-RACE-LOSER PATH (design 2026-08-11 §3.2 step 3: 「本机作废刚铸的材料，
  /// 回到第 2 步」 — "this device discards the material it just minted, and goes
  /// back to step 2"). Two devices enrolled the same account at once; the other
  /// device's PUT landed first, so the salt THIS device just minted can never
  /// be the account's salt — every blob it would ever seal is an orphan no
  /// other device of this account can open. Discarding is lossless THERE, and
  /// only there, because the provisioner's push gate
  /// (blind_store_cloud_sync.dart, `keymetaUnconfirmed`) guarantees a
  /// never-confirmed key has pushed zero blobs.
  ///
  /// Anywhere else this is [lock]'s warning made real: it destroys access to
  /// every blob already sealed under the material, so it belongs to a flow
  /// that can say so out loud. It exists on the keyring (rather than callers
  /// reaching for [BlindStoreKeyStore.clear] themselves) because forgetting is
  /// TWO writes — the store row and [_key] — and a caller that does one
  /// without the other leaves a half-forgotten ring that still seals.
  Future<void> discardKeyMaterial() async {
    await _store.clear();
    _key = null;
  }

  /// Seal one entry's payload for the wire. Returns null while locked, and that
  /// null is the write path's gate — a locked keyring produces no blob at all
  /// rather than an unencrypted one.
  String? seal({required String entryId, required String plaintext}) {
    final BlindStoreMasterKey? k = _key;
    if (k == null) return null;
    return sealBlindStoreEntry(key: k, entryId: entryId, plaintext: plaintext);
  }

  /// Open one entry's envelope. Throws [BlindStoreCryptoException] on every
  /// failure (never null-for-failure), so the read path can COUNT and speak
  /// about partial failure instead of silently dropping rows.
  String open({required String entryId, required String envelope}) {
    final BlindStoreMasterKey? k = _key;
    if (k == null) {
      throw const BlindStoreCryptoException(
        BlindStoreFailure.authenticationFailed,
        'keyring is locked — no key to open with',
      );
    }
    return openBlindStoreEntry(key: k, entryId: entryId, envelope: envelope);
  }
}
