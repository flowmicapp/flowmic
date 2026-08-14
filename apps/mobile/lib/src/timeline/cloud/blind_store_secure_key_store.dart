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

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../crypto/blind_store_keyring.dart';

/// Production [BlindStoreKeyStore]: the platform keystore.
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
