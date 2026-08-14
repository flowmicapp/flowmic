// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-2 ① (persist JWT + public user
//     via flutter_secure_storage; the PASSWORD is NEVER stored, only the JWT +
//     public user), frozen wire contract (login SUCCESS = {token:<JWT>, user:{id,email,
//     display_name,plan}})
//   docs/rebuild/08-MOBILE-SPEC.md §4 (cloud_instance auth)
//   CLAUDE.md red line/security: the password never lands in phone storage (only the JWT is stored)
//
// The cloud-account secure store. Holds ONLY the server-issued JWT plus the
// PUBLIC user projection (id / email / display_name / plan) returned by
// mobile:login — never the password (the password is a transient argument to the
// login emit and is never persisted or logged). Backed by the Android Keystore
// via flutter_secure_storage in production; an in-memory impl backs unit tests.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A logged-in cloud account: the JWT bearer plus the public user fields the
/// account UI renders. Deliberately has NO password field — the credential is
/// never retained.
class CloudAccount {
  const CloudAccount({
    required this.jwt,
    required this.email,
    this.id = '',
    this.displayName = '',
    this.plan = '',
  });

  /// Server-issued HS256 JWT (7-day TTL). The ONLY secret persisted.
  final String jwt;

  final String email;
  final String id;
  final String displayName;
  final String plan;

  Map<String, Object?> toJson() => <String, Object?>{
    'jwt': jwt,
    'email': email,
    if (id.isNotEmpty) 'id': id,
    if (displayName.isNotEmpty) 'display_name': displayName,
    if (plan.isNotEmpty) 'plan': plan,
  };

  static CloudAccount? fromJson(Map<String, Object?> j) {
    final Object? jwt = j['jwt'];
    if (jwt is! String || jwt.isEmpty) return null;
    return CloudAccount(
      jwt: jwt,
      email: j['email'] is String ? j['email'] as String : '',
      id: j['id'] is String ? j['id'] as String : '',
      displayName: j['display_name'] is String ? j['display_name'] as String : '',
      plan: j['plan'] is String ? j['plan'] as String : '',
    );
  }

  /// Parse the `user` projection from a mobile:login ack, pairing it with the
  /// ack's top-level JWT. Falls back to [typedEmail] when the server omits it.
  static CloudAccount fromLoginAck({
    required String jwt,
    required String typedEmail,
    Object? user,
  }) {
    if (user is Map) {
      final Object? email = user['email'];
      final Object? id = user['id'];
      final Object? display = user['display_name'];
      final Object? plan = user['plan'];
      return CloudAccount(
        jwt: jwt,
        email: email is String && email.isNotEmpty ? email : typedEmail,
        id: id is String ? id : '',
        displayName: display is String ? display : '',
        plan: plan is String ? plan : '',
      );
    }
    return CloudAccount(jwt: jwt, email: typedEmail);
  }
}

abstract class AccountStore {
  /// The stored account, or null when logged out.
  Future<CloudAccount?> read();

  /// Persist (replacing any prior account).
  Future<void> write(CloudAccount account);

  /// Drop the stored account (logout / JWT expiry).
  ///
  /// Returns TRUE only when the credential is really gone. It used to return
  /// `void` while swallowing the platform failure, which made "logged out" a
  /// claim nobody could check: a refused delete left the JWT on disk and the
  /// next launch hydrated straight back into a signed-in session while the UI
  /// had already said goodbye (CLAUDE.md red line — no silent failures, both directions).
  /// The caller must surface a false.
  Future<bool> clear();
}

/// Production store backed by flutter_secure_storage (Android Keystore /
/// Keychain / Credential Vault).
class SecureAccountStore extends AccountStore {
  SecureAccountStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(encryptedSharedPreferences: true),
          );

  static const String _kAccountKey = 'flowmic.cloud.account.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<CloudAccount?> read() async {
    try {
      final String? raw = await _storage.read(key: _kAccountKey);
      if (raw == null || raw.isEmpty) return null;
      final Object? decoded = jsonDecode(raw);
      if (decoded is Map) {
        return CloudAccount.fromJson(decoded.cast<String, Object?>());
      }
      return null;
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(CloudAccount account) async {
    await _storage.write(
      key: _kAccountKey,
      value: jsonEncode(account.toJson()),
    );
  }

  @override
  Future<bool> clear() async {
    try {
      await _storage.delete(key: _kAccountKey);
      return true;
    } on Object {
      // Still no throw (a logout must never crash the app), but the failure is
      // REPORTED instead of swallowed — the caller says the second half of the
      // truth out loud. A delete that completes without raising is the
      // platform's own «it is gone», which is the only evidence available here.
      return false;
    }
  }
}

/// In-memory store for unit tests.
class InMemoryAccountStore extends AccountStore {
  InMemoryAccountStore([this._account]);
  CloudAccount? _account;

  /// Test seam for the refused-delete branch: with this set, [clear] keeps the
  /// row and answers false — exactly what a Keystore that says no looks like.
  bool clearFails = false;

  @override
  Future<CloudAccount?> read() async => _account;

  @override
  Future<void> write(CloudAccount account) async => _account = account;

  @override
  Future<bool> clear() async {
    if (clearFails) return false;
    _account = null;
    return true;
  }
}
