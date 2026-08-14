// E-CL — the wire leg. `timeline:push` / `timeline:pull` / `timeline:tombstone`.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.8; the server side is
//   apps/server-core/src/socket/handlers/timeline.handler.ts and
//   apps/server-core/src/db/repos/timeline.repo.ts;
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §3.1 / §3.2 / §4.
//
// 🔴 THIS FILE IS THE ONLY PLACE IN THE PHONE THAT PUTS A `ciphertext` ON THE
// WIRE, and verify/lint/timeline-e2e-prefix.mjs enforces that it stays the only
// one. A second write path is how the double-prefix red line actually gets
// crossed: not by someone typing the wrong string, but by a second, less
// carefully reviewed producer appearing next to the careful one.
//
// The values here come from [BlindStoreKeyring.seal] and nowhere else, and this
// file re-checks the prefix before emitting even though the server checks it
// too — because the server's check protects the SERVER's namespace, and this one
// protects the user: an `enc:v1:` value reaching this point would mean the
// phone had encrypted a timeline entry under a key the server can derive, and
// the right response to that is to refuse to send it, not to let the server
// decide.
//
// ⚠️ What this file does NOT do: it never sees a key, a passphrase or a
// plaintext. It moves opaque strings. Keeping it that way is what lets it be
// read as a transport rather than as part of the cryptography.

import '../../../generated/flowmic_events.g.dart';
import '../../crypto/blind_store_params.dart';
import '../../diag/diag_log.dart';
import '../../signaling/socket_core.dart';

/// The server refused, BY NAME. Carries the server's own code so nothing has to
/// invent a reason — 「我们没问到」("we didn't get an answer") and 「服务器说了 X」
/// ("the server said X") are different facts and the
/// caller must be able to tell them apart (the `ReconnectRefusal` precedent).
class BlindStoreCloudRefusal implements Exception {
  const BlindStoreCloudRefusal(this.code, [this.message]);

  /// A whitelisted server error code, e.g. `TIMELINE_BLOB_REJECTED`,
  /// `AUTH_TOKEN_INVALID`.
  final String code;

  final String? message;

  @override
  String toString() =>
      'BlindStoreCloudRefusal($code${message == null ? '' : ': $message'})';
}

/// The link did not produce an answer — timeout, dead socket, or a reply shape
/// we cannot read. Deliberately NOT a [BlindStoreCloudRefusal]: an unanswered
/// request must never be reported as a server verdict.
class BlindStoreCloudUnreachable implements Exception {
  const BlindStoreCloudUnreachable(this.detail);

  final String detail;

  @override
  String toString() => 'BlindStoreCloudUnreachable($detail)';
}

/// One sealed entry on its way up.
class BlindStoreOutgoingBlob {
  const BlindStoreOutgoingBlob({
    required this.id,
    required this.ciphertext,
    required this.createdAtMs,
    required this.schemaVer,
  });

  final String id;

  /// `e2e:v1:`-prefixed. Opaque to the server and to this file.
  final String ciphertext;

  final int createdAtMs;
  final int schemaVer;
}

/// One blob as the server handed it back.
class BlindStoreRemoteBlob {
  const BlindStoreRemoteBlob({
    required this.id,
    required this.seq,
    required this.ciphertext,
    required this.createdAtMs,
    required this.schemaVer,
    required this.deleted,
  });

  final String id;
  final int seq;
  final String ciphertext;
  final int createdAtMs;
  final int schemaVer;

  /// 🔴 The server stamps this on a tombstoned row and REPLACES its ciphertext
  /// with the bare `e2e:v1:` prefix (E-B0, timeline.repo.ts `TOMBSTONE_CIPHERTEXT`)
  /// — the row survives so peers converge, the bytes do not, which is what
  /// 「删除释放空间」("delete frees space") means. A reader MUST branch on this
  /// before attempting to
  /// decrypt: a payload-less envelope cannot open, and counting it as an
  /// undecryptable entry would raise a false alarm on a perfectly correct delete.
  final bool deleted;
}

/// One page of `timeline:pull`.
class BlindStorePullPage {
  const BlindStorePullPage({required this.blobs, required this.nextSeq});

  final List<BlindStoreRemoteBlob> blobs;

  /// The cursor to pass as `since_seq` next time. The server answers with the
  /// LAST row's seq (not last+1) and selects on `seq > since_seq`, so this value
  /// is carried forward verbatim; on an empty page it equals what was sent.
  final int nextSeq;
}

class BlindStoreCloudClient {
  BlindStoreCloudClient({required SocketTransport transport})
    : _transport = transport;

  final SocketTransport _transport;

  /// Blobs per `timeline:push` frame.
  ///
  /// The protocol sets no array cap, so this is ours: a base64 AEAD envelope of
  /// a transcript is comfortably a few hundred bytes to a few KB, and 50 of them
  /// is a frame the relay forwards without thought. Unbounded would put the
  /// whole timeline in one frame on first enrolment and meet a size limit that
  /// answers with a much less specific error.
  static const int kPushBatch = 50;

  /// Rows per `timeline:pull`. The protocol caps this at 500; 200 keeps a page
  /// small enough that a partial failure loses less work.
  static const int kPullBatch = 200;

  // The 3s default on emitWithAck is tuned for control frames. These carry
  // payload over a relay whose measured VPS→engine leg alone is ~52ms, and a
  // push of 50 entries is a real write on the far end — a timeout here would be
  // reported as 「云端没答」("the cloud didn't answer") and retried, so being
  // impatient manufactures work.
  static const Duration _writeTimeout = Duration(seconds: 10);
  static const Duration _tombstoneTimeout = Duration(seconds: 5);

  /// Push sealed blobs. Returns the server-assigned seq per id.
  ///
  /// Idempotent at the far end by (id, ciphertext): re-pushing the SAME
  /// ciphertext is a no-op echo. That is why a caller may safely retry a push
  /// whose ack was lost — but see [blindStorePayloadHash]'s note on why the
  /// caller must not re-SEAL to do it.
  Future<Map<String, int>> push(List<BlindStoreOutgoingBlob> blobs) async {
    if (blobs.isEmpty) return const <String, int>{};
    final Map<String, int> assigned = <String, int>{};
    for (int i = 0; i < blobs.length; i += kPushBatch) {
      final List<BlindStoreOutgoingBlob> batch = blobs.sublist(
        i,
        i + kPushBatch > blobs.length ? blobs.length : i + kPushBatch,
      );
      assigned.addAll(await _pushBatch(batch));
    }
    return assigned;
  }

  Future<Map<String, int>> _pushBatch(List<BlindStoreOutgoingBlob> batch) async {
    final List<Map<String, Object?>> entries = <Map<String, Object?>>[];
    for (final BlindStoreOutgoingBlob b in batch) {
      if (!b.ciphertext.startsWith(kBlindStoreEnvelopePrefix)) {
        // 🔴 The double-prefix red line, enforced before the bytes leave the
        // device. See the file header for why this is not redundant with the
        // server's identical-looking check.
        throw StateError(
          'blind-store push refused: ciphertext for ${b.id} does not carry the '
          '$kBlindStoreEnvelopePrefix prefix',
        );
      }
      entries.add(<String, Object?>{
        'id': b.id,
        // `seq` is required by the schema and IGNORED by the server, which
        // assigns the real cursor itself (timeline.handler.ts maps the payload
        // to {id, ciphertext, created_at, schema_ver} and drops this). 0 is the
        // honest filler for 「我们不知道」("we don't know") — inventing a
        // plausible number would be
        // a client claiming authority over a server-owned value.
        'seq': 0,
        'ciphertext': b.ciphertext,
        'created_at': b.createdAtMs,
        'schema_ver': b.schemaVer,
      });
    }

    final Object? ack = await _ask(
      FlowMicEvents.timelinePush,
      <String, Object?>{'entries': entries},
      _writeTimeout,
    );
    final Map<Object?, Object?> m = _requireMap(ack, FlowMicEvents.timelinePush);
    _throwIfRefused(m);
    if (m['ok'] != true) {
      throw BlindStoreCloudUnreachable(
        'timeline:push answered without ok:true (${m.keys.toList()})',
      );
    }
    final Map<String, int> out = <String, int>{};
    final Object? rows = m['assigned'];
    if (rows is List) {
      for (final Object? r in rows) {
        if (r is! Map) continue;
        final Object? id = r['id'];
        final Object? seq = r['seq'];
        if (id is String && seq is num) out[id] = seq.toInt();
      }
    }
    diag('blindstore.push', <String, Object?>{
      'entries': entries.length,
      'assigned': out.length,
    });
    return out;
  }

  /// Read one page back.
  Future<BlindStorePullPage> pull({
    required int sinceSeq,
    int limit = kPullBatch,
  }) async {
    final Object? ack = await _ask(
      FlowMicEvents.timelinePull,
      <String, Object?>{'since_seq': sinceSeq, 'limit': limit},
      _writeTimeout,
    );
    final Map<Object?, Object?> m = _requireMap(ack, FlowMicEvents.timelinePull);
    _throwIfRefused(m);
    final Object? raw = m['blobs'];
    final Object? next = m['next_seq'];
    if (raw is! List || next is! num) {
      throw BlindStoreCloudUnreachable(
        'timeline:pull answered without blobs/next_seq (${m.keys.toList()})',
      );
    }
    final List<BlindStoreRemoteBlob> blobs = <BlindStoreRemoteBlob>[];
    for (final Object? r in raw) {
      if (r is! Map) continue;
      final Object? id = r['id'];
      final Object? seq = r['seq'];
      final Object? ct = r['ciphertext'];
      if (id is! String || seq is! num || ct is! String) continue;
      blobs.add(
        BlindStoreRemoteBlob(
          id: id,
          seq: seq.toInt(),
          ciphertext: ct,
          createdAtMs: (r['created_at'] as num?)?.toInt() ?? 0,
          schemaVer: (r['schema_ver'] as num?)?.toInt() ?? 0,
          deleted: r['deleted'] == true,
        ),
      );
    }
    diag('blindstore.pull', <String, Object?>{
      'since_seq': sinceSeq,
      'blobs': blobs.length,
      'next_seq': next.toInt(),
    });
    return BlindStorePullPage(blobs: blobs, nextSeq: next.toInt());
  }

  /// Ask the server to tombstone these ids. Returns how many rows it says it
  /// actually changed.
  ///
  /// ⚠️ That number can be LOWER than `ids.length` and it is still success: an
  /// id the server never held changes no rows. Deleting something that is not
  /// there is the desired end state, so the caller settles the whole batch on
  /// `ok:true` and does not treat a shortfall as a failure. (The opposite
  /// reading would strand those ids in the pending set forever, retrying a
  /// delete that can never report more than 0.)
  Future<int> tombstone(List<String> ids) async {
    if (ids.isEmpty) return 0;
    final Object? ack = await _ask(
      FlowMicEvents.timelineTombstone,
      <String, Object?>{'ids': ids},
      _tombstoneTimeout,
    );
    final Map<Object?, Object?> m = _requireMap(
      ack,
      FlowMicEvents.timelineTombstone,
    );
    _throwIfRefused(m);
    if (m['ok'] != true) {
      throw BlindStoreCloudUnreachable(
        'timeline:tombstone answered without ok:true (${m.keys.toList()})',
      );
    }
    final int n = (m['tombstoned'] as num?)?.toInt() ?? 0;
    diag('blindstore.tombstone', <String, Object?>{
      'asked': ids.length,
      'tombstoned': n,
    });
    return n;
  }

  Future<Object?> _ask(String event, Object? payload, Duration timeout) async {
    try {
      return await _transport.emitWithAck<Object?>(
        event,
        payload,
        timeout: timeout,
      );
    } on BlindStoreCloudRefusal {
      rethrow;
    } on Object catch (e) {
      // Timeout, dead socket, adapter throw. NOT a refusal — nobody answered.
      throw BlindStoreCloudUnreachable('$event: ${e.runtimeType}');
    }
  }

  Map<Object?, Object?> _requireMap(Object? ack, String event) {
    if (ack is Map) return ack;
    throw BlindStoreCloudUnreachable('$event: ack was ${ack.runtimeType}');
  }

  void _throwIfRefused(Map<Object?, Object?> m) {
    final Object? err = m['error'];
    if (err is String && err.isNotEmpty) {
      final Object? msg = m['message'];
      throw BlindStoreCloudRefusal(err, msg is String ? msg : null);
    }
  }
}
