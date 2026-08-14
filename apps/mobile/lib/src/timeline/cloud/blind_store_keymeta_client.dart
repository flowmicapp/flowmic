// SALT-2 — the keymeta HTTP leg: GET/PUT /api/timeline/keymeta.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-multidevice-salt.md §3.1 (HTTP surface,
//     Bearer account JWT, first-writer-wins PUT), §3.2 (the phone flow);
//   apps/server-core/src/http/timeline-keymeta-routes.ts — THE CONTRACT this
//     file speaks: 200 row / 404 no-row on GET; 201 created / 200 identical /
//     409 KEYMETA_CONFLICT on PUT; 401 when identity cannot be established.
//   CLAUDE.md's four human-reviewed sensitive paths: the cryptography surface
//     (key metadata) — reviewed line-by-line by the first-in-charge
//
// ── WHY HTTP, AND WHY THE ACCOUNT JWT ───────────────────────────────────────
// Key metadata is account-level STATIC data (design §3.1): zero new socket
// event names, the 54-event owner gate does not move. The credential is the
// SAME server-issued account JWT `mobile:login` persists into the secure
// account store (auth/account_store.dart) — the one bearer the account layer
// already holds. This file adds a transport for it, never a second credential.
// The HTTP mechanics follow `pc_presence_probe.dart` (the authenticated-GET
// precedent): URL through the ONE ws→http funnel `httpEndpointUri`, every
// await under a timeout, `catch (Object)` because the thing that actually bit
// on this road was an Error, not an Exception (RV-89).
//
// ── WHAT THIS FILE NEVER DOES ───────────────────────────────────────────────
// It never sees a key, a passphrase, or a plaintext. The sentinel is an OPAQUE
// string ferried verbatim in both directions — this file neither builds nor
// dissects it (the envelope has exactly one builder, and it is not here;
// verify/lint/timeline-e2e-prefix.mjs holds the directory to that). The salt
// is formally non-secret (blind_store_key.dart says so at its generator), and
// still nothing here logs it.
//
// ── REFUSAL vs UNREACHABLE ──────────────────────────────────────────────────
// The same two types the socket leg uses (blind_store_cloud_client.dart):
// [BlindStoreCloudRefusal] carries the server's own verdict by name, and
// [BlindStoreCloudUnreachable] means nobody answered (or answered in a shape
// we cannot read). An unanswered request is never a server verdict. One
// deliberate carve-out: GET 404 is NOT an error at all — 「you have not enrolled yet」 is the
// ordinary answer that sends a first device into enrolment (the route's own
// KEYMETA_NOT_FOUND doc says exactly this), so it returns null. ⚠️ A server
// that does not mount the route (standalone) answers a plain 404 too, and it
// lands on the same null — which is safe, not sloppy: the PUT that would
// follow gets no 201/200/409 there, maps to a refusal, and the provisioner
// never confirms, so the push gate stays closed.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../../crypto/blind_store_params.dart' show kBlindStoreSaltBytes;
import '../../diag/diag_log.dart';
import '../../signaling/http_endpoint.dart' show httpEndpointUri;
import 'blind_store_cloud_client.dart'
    show BlindStoreCloudRefusal, BlindStoreCloudUnreachable;

/// The one path both verbs share — mirrors TIMELINE_KEYMETA_PATH in
/// apps/server-core/src/http/timeline-keymeta-routes.ts (the phone cannot
/// import TypeScript; the server's own tests pin the literal there).
const String kTimelineKeymetaPath = '/api/timeline/keymeta';

/// This account's stored key metadata, as the server serves it.
class BlindStoreKeymetaRow {
  const BlindStoreKeymetaRow({
    required this.salt,
    required this.sentinel,
    required this.schemaVer,
  });

  /// Argon2id salt, decoded from the wire's `salt_b64`. Always
  /// [kBlindStoreSaltBytes] long — a row that is not is an unreadable reply,
  /// not a row.
  final Uint8List salt;

  /// The verification sentinel, verbatim off the wire. OPAQUE — see the file
  /// header. Only [BlindStoreKeyring.adoptSharedKeyMaterial] may interpret it.
  final String sentinel;

  final int schemaVer;
}

/// What a PUT settled to. `conflict` is a NORMAL flow outcome (design §3.2
/// step 3: the two-devices-raced case), not an exception — the provisioner
/// branches on it the way the design's step list does.
enum BlindStoreKeymetaPutOutcome {
  /// 201 — first write; this device's material is now the account's row.
  created,

  /// 200 — the stored row already equals these bytes (idempotent replay). The
  /// route's own comment: the caller may treat both as 「confirmed」.
  identical,

  /// 409 KEYMETA_CONFLICT — a DIFFERING row exists. The loser discards and
  /// adopts; overwriting would orphan the first writer's ciphertexts.
  conflict,
}

/// The seam. Tests drive the provisioner with a fake; production is
/// [HttpBlindStoreKeymetaClient].
abstract interface class BlindStoreKeymetaClient {
  /// The account's row, or null when none is registered yet (HTTP 404 — not
  /// an error, see the file header). Throws [BlindStoreCloudRefusal] /
  /// [BlindStoreCloudUnreachable].
  Future<BlindStoreKeymetaRow?> get();

  /// First-writer-wins registration. Throws the same two types; `conflict`
  /// comes back as a value, not a throw.
  Future<BlindStoreKeymetaPutOutcome> put({
    required Uint8List salt,
    required String sentinel,
  });
}

/// Production client against the SaaS relay.
class HttpBlindStoreKeymetaClient implements BlindStoreKeymetaClient {
  HttpBlindStoreKeymetaClient({
    required String endpoint,
    required String? Function() bearer,
    Duration timeout = const Duration(seconds: 10),
  }) : _endpoint = endpoint,
       _bearer = bearer,
       _timeout = timeout;

  /// The SaaS endpoint ([resolveSaasEndpoint] at the composition root) — the
  /// same authority that issued the JWT. Deliberately NOT the pairing
  /// endpoint: keymeta is account data and lives where the account lives,
  /// regardless of which server the session socket currently dials.
  final String _endpoint;

  /// The account JWT, read at call time (LoginController.jwt — null when
  /// logged out). ⚠️ A null bearer sends the request WITHOUT an Authorization
  /// header rather than short-circuiting locally: the 401 that comes back is
  /// the server's own verdict, and this file authors none of its own.
  final String? Function() _bearer;

  final Duration _timeout;

  Uri get _url => httpEndpointUri(_endpoint, kTimelineKeymetaPath);

  @override
  Future<BlindStoreKeymetaRow?> get() async {
    final ({int status, String body}) res = await _request('GET');
    if (res.status == HttpStatus.notFound) {
      diag('blindstore.keymeta', <String, Object?>{'op': 'get', 'row': false});
      return null;
    }
    if (res.status == HttpStatus.ok) {
      final BlindStoreKeymetaRow? row = _parseRow(res.body);
      if (row == null) {
        // 200 with a body we cannot read is 「could not tell」, never a verdict — the
        // same contract BlindStoreCloudUnreachable states for the socket leg.
        throw const BlindStoreCloudUnreachable('keymeta GET: unreadable 200 body');
      }
      diag('blindstore.keymeta', <String, Object?>{'op': 'get', 'row': true});
      return row;
    }
    throw _refusal(res.status, res.body, 'GET');
  }

  @override
  Future<BlindStoreKeymetaPutOutcome> put({
    required Uint8List salt,
    required String sentinel,
  }) async {
    final ({int status, String body}) res = await _request(
      'PUT',
      body: jsonEncode(<String, Object?>{
        'salt_b64': base64.encode(salt),
        'sentinel': sentinel,
      }),
    );
    final BlindStoreKeymetaPutOutcome? outcome = switch (res.status) {
      HttpStatus.created => BlindStoreKeymetaPutOutcome.created,
      HttpStatus.ok => BlindStoreKeymetaPutOutcome.identical,
      HttpStatus.conflict => BlindStoreKeymetaPutOutcome.conflict,
      _ => null,
    };
    if (outcome == null) throw _refusal(res.status, res.body, 'PUT');
    diag('blindstore.keymeta', <String, Object?>{
      'op': 'put',
      'outcome': outcome.name,
    });
    return outcome;
  }

  /// One bounded round trip. Network faults, timeouts and Errors (RV-89: the
  /// thing that bites here is an `ArgumentError`, which `on Exception` cannot
  /// see) all land in [BlindStoreCloudUnreachable]; a status code lands with
  /// its body for the caller to judge.
  Future<({int status, String body})> _request(
    String method, {
    String? body,
  }) async {
    final HttpClient client = HttpClient()..connectionTimeout = _timeout;
    try {
      final HttpClientRequest req = method == 'PUT'
          ? await client.putUrl(_url).timeout(_timeout)
          : await client.getUrl(_url).timeout(_timeout);
      final String? jwt = _bearer();
      // Only a non-empty token may set Authorization — a blank Bearer would
      // conflate 「no token」 with 「empty token」 (the diag_upload.dart rule).
      if (jwt != null && jwt.isNotEmpty) {
        req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $jwt');
      }
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(body);
      }
      final HttpClientResponse res = await req.close().timeout(_timeout);
      final String text =
          await res.transform(utf8.decoder).join().timeout(_timeout);
      return (status: res.statusCode, body: text);
    } on Object catch (e) {
      throw BlindStoreCloudUnreachable('keymeta $method: ${e.runtimeType}');
    } finally {
      client.close(force: true);
    }
  }

  /// A status this client does not speak → the server's named refusal when
  /// the body carries one (`KEYMETA_INVALID`, the auth family), else the bare
  /// status. Never invented, never softened.
  BlindStoreCloudRefusal _refusal(int status, String body, String op) {
    String code = 'HTTP_$status';
    String? message;
    try {
      final Object? decoded = jsonDecode(body);
      if (decoded is Map) {
        final Object? err = decoded['error'];
        if (err is String && err.isNotEmpty) code = err;
        final Object? msg = decoded['message'];
        if (msg is String && msg.isNotEmpty) message = msg;
      }
    } on Object {
      // Body was not JSON — the status alone is still an honest verdict.
    }
    diag('blindstore.keymeta', <String, Object?>{
      'op': op.toLowerCase(),
      'refused': code,
      'status': status,
    });
    return BlindStoreCloudRefusal(code, message);
  }

  /// {salt_b64, sentinel, schema_ver} → a row, or null when the shape is not
  /// readable. A salt of the wrong length is unreadable, not tolerable: the
  /// keyring's KDF is defined over [kBlindStoreSaltBytes]-byte salts, and a
  /// guessed-at pad or truncation would derive a key that opens nothing while
  /// looking enrolled.
  static BlindStoreKeymetaRow? _parseRow(String body) {
    final Object? decoded;
    try {
      decoded = jsonDecode(body);
    } on FormatException {
      return null;
    }
    if (decoded is! Map) return null;
    final Object? saltB64 = decoded['salt_b64'];
    final Object? sentinel = decoded['sentinel'];
    if (saltB64 is! String || sentinel is! String || sentinel.isEmpty) {
      return null;
    }
    final Uint8List salt;
    try {
      salt = base64.decode(saltB64);
    } on FormatException {
      return null;
    }
    if (salt.length != kBlindStoreSaltBytes) return null;
    final Object? ver = decoded['schema_ver'];
    return BlindStoreKeymetaRow(
      salt: salt,
      sentinel: sentinel,
      schemaVer: ver is num ? ver.toInt() : 0,
    );
  }
}
