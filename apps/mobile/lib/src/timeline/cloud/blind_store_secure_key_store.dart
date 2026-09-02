// Card E-CL — the platform-backed home for blind-store key material.
//
// 🔴 WHY THIS IS NOT NEXT TO THE KEYRING. `blind_store_keyring.dart` lives in
// lib/src/crypto/, and blind_store_prefix_isolation_test.dart pins that
// directory closed: `dart:*`, pointycastle, meta and its own files, nothing
// else. `flutter_secure_storage` is none of those.
//
// The rule is right and this file is the shape of respecting it. A cryptography
// face is reviewable exactly to the extent that it is small and dependency-free;
// the moment a plugin gets in, a reviewer has to reason about platform channels
// to satisfy themselves about a key schedule. Persisting bytes is a STORAGE
// concern that happens to involve secret bytes — so it lives out here, with the
// leg that composes it, and the crypto layer sees only the interface.
//
// ⚠️ Consequence worth stating: this file is the one place blind-store key
// material touches a platform API, which makes it the whole audit surface for
// 「MasterKey 仅存客户端 keystore」("the MasterKey is kept only in the client
// keystore") (05 册 §2). It writes to the same backing store
// (Android Keystore / iOS Keychain) the pairing tokens already use.
//
// 🔴🔴 AUD-D P1-1 (2026-09-02): THE ORIGINAL [SecureBlindStoreKeyStore] WAS ONE
// FIXED SLOT FOR THE WHOLE DEVICE, SHARED BY EVERY ACCOUNT THAT EVER SIGNED IN.
// If account A enrolled a passphrase on this phone and then signed out, account
// B signing in later would find "local material" sitting in that same slot —
// and blind_store_key_provisioner.dart's passive `_ensureConfirmed` walk
// registers whatever local material it finds as THIS account's key the moment
// the server has no row for it (design §3.2 step d's honest recovery path,
// weaponised by account-sharing). That is a cross-account leak: account B's
// blobs would end up sealed under account A's key, and if account A's key ever
// also PUTs to the server (a race), the two accounts' key metadata could
// collide.
//
// [AccountScopedBlindStoreKeyStore] is the fix: one slot PER ACCOUNT, keyed off
// the SAME `accountKey` seam blind_store_key_provisioner.dart and
// blind_store_cloud_sync.dart already read from `main.dart`'s login email — one
// fact, three readers, so "whose key is this" cannot disagree between them.
// [SecureBlindStoreKeyStore] (the original class) stays in the file, unchanged,
// as the MIGRATION SOURCE ONLY: whatever a build before this fix already wrote
// into the shared slot must not be silently orphaned OR silently trusted — see
// blind_store_key_provisioner.dart's `_migrateLegacyIfProven`, which will only
// move it into an account's own slot once that account's server-side keymeta
// row proves the bytes are really theirs.

import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../crypto/blind_store_keyring.dart';

/// The SALT-2-era single slot every account on this device once shared.
///
/// 🔴 DEPRECATED AS A WRITE TARGET IN PRODUCTION — see the file header. Kept
/// only so [AccountScopedBlindStoreKeyStore]'s migration walk has something to
/// read (and, once an account proves ownership, clear). `main.dart` keeps
/// exactly one instance of this class alive for that purpose; nothing else
/// constructs it.
class SecureBlindStoreKeyStore implements BlindStoreKeyStore {
  const SecureBlindStoreKeyStore([
    this._storage = const FlutterSecureStorage(),
  ]);

  final FlutterSecureStorage _storage;

  static const String kKey = 'flowmic.blindstore.key.v1';

  @override
  Future<BlindStoreKeyMaterial?> read() async {
    final String? raw = await _storage.read(key: kKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return BlindStoreKeyMaterial.fromJson(decoded.cast<String, Object?>());
    } on FormatException {
      // Corrupt material is reported as ABSENT, never as a usable key. The cost
      // of the honest answer is a re-enrolment prompt; the cost of the other one
      // is deriving a key that opens nothing and then calling the cloud empty —
      // design §2.1's forbidden failure, arrived at from the storage side.
      return null;
    }
  }

  @override
  Future<void> write(BlindStoreKeyMaterial material) =>
      _storage.write(key: kKey, value: jsonEncode(material.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: kKey);
}

/// Production [BlindStoreKeyStore], used for real: one platform-keystore slot
/// PER SIGNED-IN ACCOUNT, so a device that has ever hosted two accounts keeps
/// their key material apart. See the file header (AUD-D P1-1) for why the
/// single-slot predecessor was a cross-account leak.
///
/// [accountKey] is read FRESH on every [read] / [write] / [clear] — never
/// cached at construction — because `main.dart` builds exactly one instance of
/// this store for the app's whole lifetime and the signed-in account changes
/// underneath it (login, logout, a different account logging in later). A
/// value captured once at construction would keep answering for whichever
/// account happened to be signed in when the app started.
class AccountScopedBlindStoreKeyStore implements BlindStoreKeyStore {
  AccountScopedBlindStoreKeyStore({
    required String? Function() accountKey,
    FlutterSecureStorage storage = const FlutterSecureStorage(),
  }) : _accountKey = accountKey,
       _storage = storage;

  final String? Function() _accountKey;
  final FlutterSecureStorage _storage;

  static const String _kPrefix = 'flowmic.blindstore.key.v2.';

  /// The slot for "no account currently signed in". Deliberately a fixed,
  /// clearly-named value rather than null/empty-string handling scattered
  /// across [read]/[write]/[clear] — and deliberately NOT the same slot any
  /// real account could ever resolve to (a real account always hashes to 64
  /// hex chars, which this literal is not).
  static const String _kNoAccountSlot = '${_kPrefix}signed-out';

  /// 🔴 The account identifier is HASHED (SHA-256) rather than stored as the
  /// literal email in the keystore's key NAME. `flutter_secure_storage` key
  /// NAMES are not secret-grade the way the VALUES already are (05 册 §2 is
  /// about the MasterKey, not the slot label), and there is no reason a
  /// device's keystore listing should spell out which email addresses have
  /// signed into this app. Case/whitespace are normalised first so the SAME
  /// email typed differently still resolves to the SAME slot.
  static String _slotFor(String account) {
    final String normalized = account.trim().toLowerCase();
    return '$_kPrefix${sha256.convert(utf8.encode(normalized))}';
  }

  String get _storageKey {
    final String? account = _accountKey();
    if (account == null || account.isEmpty) return _kNoAccountSlot;
    return _slotFor(account);
  }

  @override
  Future<BlindStoreKeyMaterial?> read() async {
    final String? raw = await _storage.read(key: _storageKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return BlindStoreKeyMaterial.fromJson(decoded.cast<String, Object?>());
    } on FormatException {
      return null;
    }
  }

  @override
  Future<void> write(BlindStoreKeyMaterial material) =>
      _storage.write(key: _storageKey, value: jsonEncode(material.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _storageKey);
}
