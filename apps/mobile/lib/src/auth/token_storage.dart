// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (MobileSession{token,endpoint,channel,
//     pcInstanceId,pcId,pairingId,pcName} persisted in flutter_secure_storage;
//     legacy single-value → list migration chain; local display_alias)
//
// TokenStorage persists the pairing session across launches. The v2 key holds a
// LIST of MobileSession (one per previously-paired PC), migrating both legacy
// forms (single-string token, single-object) into the list on first read.
// Backed by the Android Keystore via flutter_secure_storage in production; an
// in-memory impl backs unit tests.
//
// Ported from legacy auth/token_storage.dart (mechanics carried over).

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../signaling/lan_tls_fingerprint.dart'
    show isWellFormedLanTlsFingerprint;

/// D2LAN-B3/B4 — where a pinned fingerprint came from. The two are NOT the same
/// promise, and design §4-4 forbids showing them under one badge.
enum LanPinSource {
  /// It rode the pairing QR, which the user read off the PC's own screen. The
  /// identity was established OUT OF BAND — the strong case.
  qr,

  /// Trust on first use: nothing told us what to expect, so we recorded whatever
  /// answered the address the user typed. It detects a LATER substitution and
  /// says nothing at all about the first connection, which is precisely what the
  /// disclosure copy has to say out loud (design §3-4a:「must be disclosed
  /// explicitly, silence is not allowed」).
  tofu,
}

/// The wire/JSON name of a pin source, and back. Explicit rather than `.name`
/// round-tripping: an enum renamed in Dart must not silently orphan every pin
/// already on disk (which would look like 「every pairing suddenly turned
/// unverified」).
String lanPinSourceToJson(LanPinSource s) => switch (s) {
  LanPinSource.qr => 'qr',
  LanPinSource.tofu => 'tofu',
};

LanPinSource? lanPinSourceFromJson(Object? v) => switch (v) {
  'qr' => LanPinSource.qr,
  'tofu' => LanPinSource.tofu,
  // An unrecognised source is NOT downgraded to `tofu`: that would invent a
  // provenance. The row keeps its pin and the badge says nothing.
  _ => null,
};

/// One persisted pairing: enough to bootstrap a mobile:reconnect against the
/// right server on next launch.
class MobileSession {
  const MobileSession({
    required this.token,
    required this.endpoint,
    this.channel = 'standalone',
    this.pcInstanceId,
    this.pcMachineUid,
    this.pcId,
    this.pairingId,
    this.pcName,
    this.displayAlias,
    this.lastConnectedAt,
    this.endpointCandidates = const <String>[],
    this.lanTlsFp,
    this.lanTlsFpSource,
  });

  /// Server-issued mobile_token (≥ 32 chars per spec).
  final String token;

  /// The websocket endpoint used during pair (e.g. ws://192.0.2.5:55889),
  /// stored so reconnect uses the same host:port the user paired against.
  ///
  /// B4-15: this is now 「the address it last actually connected to」 rather than
  /// 「the one written in the QR at pairing time」.
  /// The two are the same address on a single-NIC PC and differ the moment the
  /// phone's route changes — see [endpointCandidates].
  final String endpoint;

  /// B4-15 — EVERY address this PC said it listens on, as the pairing QR
  /// declared them (`alt=`), primary first.
  ///
  /// It exists so a reconnect can heal itself: a PC with a LAN address and a VPN
  /// address is reachable on different ones from different networks, and without
  /// this list the phone can only ever re-dial the one it was given at pairing
  /// time. Empty for a pairing made by a pre-B4-15 build, for a hand-typed
  /// address, and for the cloud-instance row — all of which then behave exactly as they
  /// did before (one candidate ⇒ no probe, no rewrite).
  ///
  /// ⚠️ NOT a second answer to 「which one is it connected to now」 — that is
  /// [endpoint], always.
  /// This is the SET to fall back through, and it never moves on its own.
  final List<String> endpointCandidates;

  /// D2LAN-B3 — the LAN TLS public key this pairing is PINNED to (the SPKI
  /// fingerprint the QR carried as `fp=`, or the one TOFU learned on first
  /// contact). `null` = this pairing is not pinned and talks in the clear, which
  /// is every pre-D2-LAN row and every relay row.
  ///
  /// 🔴 CREDENTIAL-GRADE, AND THEREFORE NOT LIKE ANY OTHER FIELD ON THIS CLASS.
  /// Everything else here is a fact the server may restate at will (`pcName`,
  /// `pcId`, the candidate list): a later value simply wins. A pin is the
  /// opposite — silently replacing it is not an update, it is the exact event
  /// this whole card exists to DETECT. So there is deliberately no
  /// `lanTlsFp` parameter on [copyWith]: every existing update path carries the
  /// pin forward untouched and none of them can overwrite it, and the only way
  /// to set one is [pinLanTls], which refuses to change an existing value.
  ///
  /// ⚠️ Contrast `machine_map`'s last-write-wins, which is correct THERE and
  /// would be a vulnerability here.
  final String? lanTlsFp;

  /// How [lanTlsFp] came to be believed — the difference between 「when we scanned
  /// the QR, the peer's identity rode along with the code」 and 「the first time
  /// we connected, we recorded what we saw」.
  ///
  /// 🔴 A SECOND QUESTION, SO A SECOND VALUE. The pin answers 「which key should
  /// it be」;
  /// this answers 「what grounds do we have to believe it is correct」, and design
  /// §4-4 requires the two
  /// paths never to share one badge. Deriving it from anything else — e.g. 「was
  /// there a QR」 — would be re-computing a fact we already had.
  final LanPinSource? lanTlsFpSource;

  final String channel;
  final String? pcInstanceId;

  /// v0.2.4 — the PHYSICAL machine behind this pairing (protocol
  /// `pc_machine_uid`), which is the SAME value on the LAN pairing and the
  /// relay pairing to one computer. [pcInstanceId] is deliberately not that: it
  /// is per connection slot, and it MUST stay per slot because
  /// [connectionIdentity] is keyed on it — two pairings that collapsed to one
  /// identity would be deduped by `_upsertPairing` and one token thrown away.
  ///
  /// So: instance id keeps the rows apart, machine uid tells the user they are
  /// the same computer. Null for a pairing made before 0.2.4, and for the
  /// virtual cloud-instance row, which is not a machine.
  final String? pcMachineUid;
  final String? pcId;
  final String? pairingId;

  /// Optional PC display name from the pair ack; surfaced in the header while
  /// waiting for pc:mobile-joined.
  final String? pcName;

  /// User-chosen local alias for THIS remembered PC. Phone-local only (no
  /// protocol event), it wins over [pcName] wherever a paired PC is labelled.
  final String? displayAlias;

  /// Local wall-clock instant of the last ACCEPTED pair/reconnect ack. Null for
  /// rows written before this field existed; legacy rows must never be guessed.
  final DateTime? lastConnectedAt;

  String displayLabel({String fallback = 'PC'}) {
    if (displayAlias != null && displayAlias!.isNotEmpty) return displayAlias!;
    if (pcName != null && pcName!.isNotEmpty) return pcName!;
    return fallback;
  }

  String get connectionIdentity {
    final String? instance = pcInstanceId;
    if (instance != null && instance.isNotEmpty) {
      return '$channel|instance:$instance';
    }
    if (token.isNotEmpty) return 'legacy-token:$token';
    final String? pc = pcId;
    if (pc != null && pc.isNotEmpty) return 'legacy-pc:$pc';
    throw StateError('MobileSession has no stable connection identity');
  }

  MobileSession copyWith({
    /// B4-15 — the ONLY writer is a reconnect that succeeded on a different
    /// candidate. `connectionIdentity` is keyed on the instance id, not on the
    /// address, so rewriting this updates the row in place instead of forking a
    /// second pairing to the same PC.
    String? endpoint,
    String? channel,
    String? pcInstanceId,
    String? pcMachineUid,
    String? pcId,
    String? pairingId,
    String? pcName,
    String? displayAlias,
    DateTime? lastConnectedAt,
    List<String>? endpointCandidates,
    // 🔴 D2LAN-B3: there is NO `lanTlsFp` parameter here, and its absence is the
    // mechanism. See the field's doc — this is the one value on the class that a
    // later write must not be able to replace, and the cheapest way to guarantee
    // that is to give the callers no way to say it.
  }) => MobileSession(
    token: token,
    lanTlsFp: lanTlsFp,
    lanTlsFpSource: lanTlsFpSource,
    endpoint: endpoint ?? this.endpoint,
    channel: channel ?? this.channel,
    pcInstanceId: pcInstanceId ?? this.pcInstanceId,
    pcMachineUid: pcMachineUid ?? this.pcMachineUid,
    pcId: pcId ?? this.pcId,
    pairingId: pairingId ?? this.pairingId,
    pcName: pcName ?? this.pcName,
    displayAlias: displayAlias ?? this.displayAlias,
    lastConnectedAt: lastConnectedAt ?? this.lastConnectedAt,
    endpointCandidates: endpointCandidates ?? this.endpointCandidates,
  );

  /// D2LAN-B3 — record the public key this pairing will accept from now on.
  ///
  /// 🔴 IT REFUSES TO CHANGE AN ESTABLISHED PIN. Re-pinning the same value is a
  /// no-op (a re-scan of the same QR, a TOFU re-confirmation) and re-pinning a
  /// DIFFERENT one throws, because「swapping in a different key」 is not something any caller in
  /// this app is entitled to do quietly — it is the event the pin exists to
  /// catch. The legitimate way out is the one the user already has: delete this
  /// pairing and pair again, which is an act they perform knowing what it means.
  ///
  /// ⚠️ Not `assert`: an assert is compiled out of a release APK, and this must
  /// hold on the owner's phone, not only in a test.
  MobileSession pinLanTls({
    required String fingerprint,
    required LanPinSource source,
  }) {
    final String? existing = lanTlsFp;
    if (existing != null && existing != fingerprint) {
      throw StateError(
        'MobileSession: refusing to replace a pinned LAN TLS key '
        '($existing → $fingerprint) — delete the pairing and pair again',
      );
    }
    return MobileSession(
      token: token,
      endpoint: endpoint,
      channel: channel,
      pcInstanceId: pcInstanceId,
      pcMachineUid: pcMachineUid,
      pcId: pcId,
      pairingId: pairingId,
      pcName: pcName,
      displayAlias: displayAlias,
      lastConnectedAt: lastConnectedAt,
      endpointCandidates: endpointCandidates,
      lanTlsFp: fingerprint,
      // An already-pinned row keeps the provenance it was pinned WITH: a later
      // TOFU sighting of the same key does not turn 「verified by scanning the
      // QR」 into 「recorded the first time it was seen」, and it must not weaken
      // the badge either.
      lanTlsFpSource: existing == null ? source : lanTlsFpSource,
    );
  }

  MobileSession enrichFromAck(Map<dynamic, dynamic> ack) => copyWith(
    pcInstanceId: ack['pc_instance_id'] as String?,
    pcMachineUid: ack['pc_machine_uid'] as String?,
    pcId: ack['pc_id'] as String?,
    pairingId: ack['pairing_id'] as String?,
    pcName: ack['pc_name'] as String?,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'token': token,
    'endpoint': endpoint,
    'channel': channel,
    if (pcInstanceId != null) 'pc_instance_id': pcInstanceId,
    if (pcMachineUid != null) 'pc_machine_uid': pcMachineUid,
    if (pcId != null) 'pc_id': pcId,
    if (pairingId != null) 'pairing_id': pairingId,
    if (pcName != null) 'pc_name': pcName,
    if (displayAlias != null) 'display_alias': displayAlias,
    if (lastConnectedAt != null)
      'last_connected_at': lastConnectedAt!.toUtc().toIso8601String(),
    if (endpointCandidates.isNotEmpty) 'endpoint_candidates': endpointCandidates,
    if (lanTlsFp != null) 'lan_tls_fp': lanTlsFp,
    if (lanTlsFpSource != null)
      'lan_tls_fp_source': lanPinSourceToJson(lanTlsFpSource!),
  };

  static MobileSession? fromJson(Map<String, Object?> j) {
    final Object? t = j['token'];
    final Object? e = j['endpoint'];
    if (t is! String || t.isEmpty) return null;
    if (e is! String || e.isEmpty) return null;
    return MobileSession(
      token: t,
      endpoint: e,
      channel: j['channel'] == 'saas'
          ? 'saas'
          : j['channel'] == 'standalone'
          ? 'standalone'
          : _inferChannel(e),
      pcInstanceId: j['pc_instance_id'] is String
          ? j['pc_instance_id'] as String
          : null,
      pcMachineUid: j['pc_machine_uid'] is String
          ? j['pc_machine_uid'] as String
          : null,
      pcId: j['pc_id'] is String ? j['pc_id'] as String : null,
      pairingId: j['pairing_id'] is String ? j['pairing_id'] as String : null,
      pcName: j['pc_name'] is String ? j['pc_name'] as String : null,
      displayAlias: j['display_alias'] is String
          ? j['display_alias'] as String
          : null,
      lastConnectedAt: j['last_connected_at'] is String
          ? DateTime.tryParse(j['last_connected_at'] as String)?.toUtc()
          : null,
      // B4-15. Element-by-element, NOT `List<String>.from` / a cast: JSON gives
      // `List<dynamic>`, and a hand-written narrowing that asserts what it did
      // not test is the RV-newA shape (CLAUDE.md anti-façade ⑤) — there it produced
      // an array that was empty on every machine and nobody noticed for weeks.
      endpointCandidates: j['endpoint_candidates'] is List
          ? <String>[
              for (final Object? e in j['endpoint_candidates']! as List<Object?>)
                if (e is String && e.isNotEmpty) e,
            ]
          : const <String>[],
      // D2LAN-B3. Shape-checked on the way IN: a stored value that could never
      // match would refuse every connection to a PC that is working fine, and
      // 「a broken fingerprint」 must be caught where it is read, not where it fails. A row
      // whose pin does not parse is loaded UNPINNED (= today's plain behaviour,
      // and the badge then says so) rather than dropped.
      lanTlsFp:
          j['lan_tls_fp'] is String &&
              isWellFormedLanTlsFingerprint(j['lan_tls_fp']! as String)
          ? j['lan_tls_fp']! as String
          : null,
      lanTlsFpSource: lanPinSourceFromJson(j['lan_tls_fp_source']),
    );
  }

  static String _inferChannel(String endpoint) =>
      endpoint.toLowerCase().contains('flowmic.app') ? 'saas' : 'standalone';
}

/// Single read-path for a remembered PC's list label: alias wins, then device
/// name, then [fallback]. Prefer this over ad-hoc `pcName` reads.
String pairingDisplayName(MobileSession session, {String fallback = 'PC'}) =>
    session.displayLabel(fallback: fallback);

/// GA-10 (owner 2026-07-26 iron rule ③) — the PC's OWN name, to be shown in small type
/// beside a local alias. `null` when there is no alias (the label already IS the
/// device name) or when the server never told us one.
///
/// Why it exists: a phone-local rename is invisible to the PC and to everyone
/// else by design, so the phone is the only place the two names can diverge. A
/// user who renamed 「the desktop in the study」(书房台式机) to 「the one at home」
/// (家里那台) must still be able to tell which
/// machine they are about to speak into.
String? pairingOriginalName(MobileSession session) {
  final String? alias = session.displayAlias;
  if (alias == null || alias.trim().isEmpty) return null;
  final String? real = session.pcName;
  if (real == null || real.trim().isEmpty) return null;
  if (real.trim() == alias.trim()) return null;
  return real.trim();
}

abstract class TokenStorage {
  /// All remembered pairings, most-recent first. Empty when none stored.
  Future<List<MobileSession>> readPairings();

  /// Upsert [session] into the list: dedupe by identity, move-to-front.
  Future<void> addOrUpdatePairing(MobileSession session);

  /// Remove the pairing matching [session]'s identity. No-op if absent.
  Future<void> removePairing(MobileSession session);

  /// Set (or clear, when [alias] is null/blank) the local display alias.
  Future<void> setPairingAlias(MobileSession session, String? alias);

  Future<void> removeByToken(String token) async {
    for (final MobileSession session in await readPairings()) {
      if (session.token == token) {
        await removePairing(session);
        return;
      }
    }
  }

  Future<void> enrichByToken(
    String token,
    Map<dynamic, dynamic> ack, {
    DateTime? connectedAt,
  }) async {
    for (final MobileSession session in await readPairings()) {
      if (session.token == token) {
        // runMobileReconnect calls this only after it has validated a successful
        // mobile:reconnect ack. The earlier move-to-front write must preserve the
        // old value: transport.connect alone does not prove token admission.
        await addOrUpdatePairing(
          session
              .enrichFromAck(ack)
              .copyWith(lastConnectedAt: (connectedAt ?? DateTime.now()).toUtc()),
        );
        return;
      }
    }
  }

  /// Drop every remembered pairing.
  Future<void> clearAll();

  // ── Single-session compatibility surface ─────────────────────────
  Future<MobileSession?> readSession() async {
    final List<MobileSession> all = await readPairings();
    return all.isEmpty ? null : all.first;
  }

  Future<void> writeSession(MobileSession session) =>
      addOrUpdatePairing(session);

  Future<void> clear() => clearAll();

  Future<String?> readToken() async => (await readSession())?.token;

  Future<void> writeToken(String token) async {
    await writeSession(MobileSession(token: token, endpoint: ''));
  }
}

/// Shared list mutators so the secure + in-memory stores agree on the
/// dedupe-by-identity, move-to-front semantics (single source of truth).
List<MobileSession> _upsertPairing(
  List<MobileSession> current,
  MobileSession session,
) {
  return <MobileSession>[
    session,
    ...current.where(
      (MobileSession s) =>
          s.connectionIdentity != session.connectionIdentity &&
          s.token != session.token,
    ),
  ];
}

List<MobileSession> _removePairing(
  List<MobileSession> current,
  MobileSession session,
) {
  return current
      .where(
        (MobileSession s) => s.connectionIdentity != session.connectionIdentity,
      )
      .toList(growable: false);
}

List<MobileSession> _setAliasIn(
  List<MobileSession> current,
  MobileSession session,
  String? alias,
) {
  final String? norm = (alias != null && alias.trim().isNotEmpty)
      ? alias.trim()
      : null;
  return current
      .map(
        // ⚠️ A LITERAL, not copyWith — clearing the alias needs an explicit null,
        // which `?? this.x` cannot express. The cost is that EVERY field has to
        // be listed here, and a field missing from this literal silently vanishes
        // the first time anyone renames a PC (CLAUDE.md anti-façade ⑤:「a field
        // that is not in the literal is never visible to the caller」). Adding a field to MobileSession means adding
        // it here — the guard that fails when it is forgotten is the test named
        // `alias_keeps_candidates` (apps/mobile/test/pair_multi_nic_test.dart).
        (MobileSession s) => s.connectionIdentity == session.connectionIdentity
            ? MobileSession(
                token: s.token,
                endpoint: s.endpoint,
                channel: s.channel,
                pcInstanceId: s.pcInstanceId,
                pcMachineUid: s.pcMachineUid,
                pcId: s.pcId,
                pairingId: s.pairingId,
                pcName: s.pcName,
                displayAlias: norm,
                lastConnectedAt: s.lastConnectedAt,
                endpointCandidates: s.endpointCandidates,
                lanTlsFp: s.lanTlsFp,
                lanTlsFpSource: s.lanTlsFpSource,
                // 🔴 D2LAN-B3: forgetting these two here would UNPIN a pairing
                // the first time someone renames the PC — a downgrade performed
                // by a cosmetic action, with nothing anywhere saying so. The
                // guard is `alias_keeps_pin` in lan_tls_pin_test.dart.
              )
            : s,
      )
      .toList(growable: false);
}

/// Production implementation backed by flutter_secure_storage (Keychain /
/// EncryptedSharedPreferences / Credential Vault).
class SecureTokenStorage extends TokenStorage {
  SecureTokenStorage({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(encryptedSharedPreferences: true),
          );

  static const String _kLegacyTokenKey = 'flowmic.mobile.token';
  static const String _kSessionKey = 'flowmic.mobile.session.v2';
  final FlutterSecureStorage _storage;

  /// Decode the v2 value into a list, accepting the three on-disk shapes:
  /// a JSON array (current) / a single JSON object (legacy v2) / the legacy
  /// token-only key. Returns the list plus whether a rewrite is needed.
  Future<(List<MobileSession>, bool)> _decodeWithMigration() async {
    final String? raw = await _storage.read(key: _kSessionKey);
    if (raw != null && raw.isNotEmpty) {
      final Object? decoded = jsonDecode(raw);
      if (decoded is List) {
        final List<MobileSession> out = <MobileSession>[];
        for (final Object? e in decoded) {
          if (e is Map<String, Object?>) {
            final MobileSession? s = MobileSession.fromJson(e);
            if (s != null) out.add(s);
          } else if (e is Map) {
            final MobileSession? s =
                MobileSession.fromJson(e.cast<String, Object?>());
            if (s != null) out.add(s);
          }
        }
        return (out, false);
      }
      if (decoded is Map) {
        final MobileSession? s =
            MobileSession.fromJson(decoded.cast<String, Object?>());
        return (s != null ? <MobileSession>[s] : <MobileSession>[], true);
      }
    }
    final String? legacy = await _storage.read(key: _kLegacyTokenKey);
    if (legacy != null && legacy.isNotEmpty) {
      return (<MobileSession>[MobileSession(token: legacy, endpoint: '')], true);
    }
    return (<MobileSession>[], false);
  }

  Future<void> _persist(List<MobileSession> list) async {
    await _storage.write(
      key: _kSessionKey,
      value: jsonEncode(
        list.map((MobileSession s) => s.toJson()).toList(growable: false),
      ),
    );
    try {
      await _storage.delete(key: _kLegacyTokenKey);
    } on Object {
      /* no-op */
    }
  }

  @override
  Future<List<MobileSession>> readPairings() async {
    try {
      final (List<MobileSession> list, bool migrated) =
          await _decodeWithMigration();
      if (migrated) await _persist(list);
      return list;
    } on Object {
      return <MobileSession>[];
    }
  }

  @override
  Future<void> addOrUpdatePairing(MobileSession session) async {
    final List<MobileSession> current = await readPairings();
    await _persist(_upsertPairing(current, session));
  }

  @override
  Future<void> removePairing(MobileSession session) async {
    final List<MobileSession> current = await readPairings();
    await _persist(_removePairing(current, session));
  }

  @override
  Future<void> setPairingAlias(MobileSession session, String? alias) async {
    final List<MobileSession> current = await readPairings();
    await _persist(_setAliasIn(current, session, alias));
  }

  @override
  Future<void> clearAll() async {
    try {
      await _storage.delete(key: _kSessionKey);
    } on Object {
      /* no-op */
    }
    try {
      await _storage.delete(key: _kLegacyTokenKey);
    } on Object {
      /* no-op */
    }
  }
}

/// In-memory implementation for unit tests. Backs the same list semantics as
/// the secure store so tests exercise the production dedupe/order behaviour.
class InMemoryTokenStorage extends TokenStorage {
  List<MobileSession> _pairings = <MobileSession>[];

  @override
  Future<List<MobileSession>> readPairings() async =>
      List<MobileSession>.unmodifiable(_pairings);

  @override
  Future<void> addOrUpdatePairing(MobileSession session) async {
    _pairings = _upsertPairing(_pairings, session);
  }

  @override
  Future<void> removePairing(MobileSession session) async {
    _pairings = _removePairing(_pairings, session);
  }

  @override
  Future<void> setPairingAlias(MobileSession session, String? alias) async {
    _pairings = _setAliasIn(_pairings, session, alias);
  }

  @override
  Future<void> clearAll() async {
    _pairings = <MobileSession>[];
  }
}
