// E-CL — the orchestrator: drain deletes, push, pull-and-merge.
//
// SPEC-REF: docs/strategy/2026-08-08-design-e-blindstore-client.md §3.1 / §3.2 /
//   §4.1 (「在下一次云端已认证连接时排空」("drain on the next cloud-authenticated
//   connection");「解不开的条目计数并出声」("entries that cannot be decrypted are
//   counted and spoken aloud");
//   「在拿到服务端 ack 之前，不许说"已从云端删除"」("must not say 'deleted from the
//   cloud' before getting the server's ack")).
//
// ── 🔴 THE DESTINATION GUARD IS THE FIRST THING IN THIS FILE, ON PURPOSE ─────
// `timeline:push` authenticates off `getAuth(socket)`, which
// apps/server-core/src/auth/middleware.ts fills from the MOBILE PAIRING TOKEN —
// not from the account JWT. A phone paired to a standalone LAN server therefore
// has a perfectly valid `auth` on that link, and a push would be accepted and
// written into THAT server's `timeline_blobs`. The user's cloud records would
// silently land on someone's desktop sidecar instead of in their account.
//
// That is the 「绝不许串号」("never cross-wire IDs") red line in its blind-store
// shape, so the judge is a
// MEASURED fact, not an inference: [_isCloudRelay] is bound to
// `PttSession.serverChannel`, which is read off the server's own `/api/health`
// `mode`, and whose `null` (「没问到」 — "didn't get an answer") is fail-closed.
// Being paired, being
// connected, and holding a JWT are all true on a LAN link too — none of them can
// answer this question.
//
// ── WHY IT RUNS WHEN IT RUNS ────────────────────────────────────────────────
// Design §4.1 puts the retry edge at 「下一次云端已认证连接」("the next cloud-
// authenticated connection"). The subscribable
// fact closest to that in today's tree is `PttSession.roomJoins` — the counter
// F-1 added precisely because 「进房成功」("successfully joined the room")
// previously had no subscriber, and the
// only two writers are a successful `mobile:pair` and an accepted
// `mobile:reconnect`, i.e. exactly the moments the far end has admitted this
// device's token. main.dart subscribes to it.
//
// ⚠️ NAMED DEVIATION: that is NARROWER than the design's wording. A link that is
// cloud-authenticated but never gets an accepted (re)join — a paired PC that
// stays offline, say — will not tick the counter, and the drain waits. The
// design warns (§4.1-3, citing F-1 and 49-3) against hanging a drain on the
// wrong edge, and the truly right edge would be a new counter written where the
// cloud admission is acknowledged — inside `ptt/`, which this card is scoped out
// of. Nothing is lost when the edge is missed: the pending set is persistent and
// the work is idempotent, so a late edge is a DELAY, never a dropped delete.
// Registered as an open item rather than papered over with a timer, because a
// timer would be a second answer to 「什么时候排空」("when to drain").

import '../../crypto/blind_store_keyring.dart';
import '../../crypto/blind_store_params.dart';
import '../../diag/diag_log.dart';
import '../timeline_entry.dart';
import 'blind_store_cloud_client.dart';
import 'blind_store_cloud_state.dart';
import 'blind_store_payload.dart';
import 'blind_store_timeline_bridge.dart';

/// Why a sync run did nothing. Not an error — these are ordinary resting states.
enum BlindStoreSyncBlock {
  /// No passphrase has ever been enrolled, or the keyring is locked. The
  /// ordinary state on every install today (see blind_store_keyring.dart).
  keyringLocked,

  /// The link is not a cloud relay (or we could not measure it). See the header.
  notCloudRelay,

  /// Nobody is logged in, so there is no account to be a cursor of.
  noAccount,

  /// 🔴 The account's key metadata is not CONFIRMED for the current material
  /// (SALT-2, design 2026-08-11 §3.2 step 4). Until a PUT was acked or a GET
  /// matched the local material byte-for-byte, this device may hold a salt
  /// that LOST the first-writer race — every blob sealed under it would be an
  /// orphan no other device of this account can ever open. Fail-closed, same
  /// layer as [notCloudRelay]: an unanswered confirmation check is not a
  /// confirmation.
  keymetaUnconfirmed,
}

/// What a run ACTUALLY did. Every field is a measurement, never an intention —
/// same discipline as [ReapResult].
class BlindStoreSyncReport {
  const BlindStoreSyncReport({
    this.blocked,
    this.pushed = 0,
    this.deletesConfirmed = 0,
    this.deletesStillPending = 0,
    this.merged = 0,
    this.tombstonesApplied = 0,
    this.undecryptable = 0,
    this.failure,
  });

  const BlindStoreSyncReport.blockedBy(BlindStoreSyncBlock reason)
    : this(blocked: reason);

  /// Non-null ⇒ nothing ran, and this is why.
  final BlindStoreSyncBlock? blocked;

  /// Entries the server acknowledged.
  final int pushed;

  /// Tombstones the server acknowledged in this run.
  ///
  /// 🔴 This — and only this — is what may ever be reported as 「已从云端删除」
  /// ("deleted from the cloud").
  /// Design §4.1 forbids saying it before the ack, and [deletesStillPending] is
  /// the honest other half.
  final int deletesConfirmed;

  /// Tombstones still owed AFTER this run.
  final int deletesStillPending;

  /// Rows written locally from the cloud.
  final int merged;

  /// Remote deletes applied locally.
  final int tombstonesApplied;

  /// 🔴 Blobs that would not open. Counted and reported, never skipped in
  /// silence (design §3.2) — a wrong key must not read as 「云端是空的」("the
  /// cloud is empty").
  final int undecryptable;

  /// The transport or server refusal that stopped a stage, if any.
  final String? failure;

  bool get ranSomething =>
      pushed > 0 || deletesConfirmed > 0 || merged > 0 || tombstonesApplied > 0;

  Map<String, Object?> toDiag() => <String, Object?>{
    if (blocked != null) 'blocked': blocked!.name,
    'pushed': pushed,
    'deletes_confirmed': deletesConfirmed,
    'deletes_pending': deletesStillPending,
    'merged': merged,
    'tombstones_applied': tombstonesApplied,
    'undecryptable': undecryptable,
    if (failure != null) 'failure': failure,
  };
}

class BlindStoreCloudSync {
  BlindStoreCloudSync({
    required BlindStoreKeyring keyring,
    required BlindStoreCloudClient client,
    required BlindStoreCloudStateStore state,
    required BlindStoreTimelineBridge bridge,
    required BlindStoreCursorStore cursor,
    required bool Function() isCloudRelay,
    required String? Function() accountKey,
    required Future<bool> Function() keymetaConfirmed,
  }) : _keyring = keyring,
       _client = client,
       _state = state,
       _bridge = bridge,
       _cursor = cursor,
       _isCloudRelay = isCloudRelay,
       _accountKey = accountKey,
       _keymetaConfirmed = keymetaConfirmed;

  final BlindStoreKeyring _keyring;
  final BlindStoreCloudClient _client;
  final BlindStoreCloudStateStore _state;
  final BlindStoreTimelineBridge _bridge;
  final BlindStoreCursorStore _cursor;
  final bool Function() _isCloudRelay;
  final String? Function() _accountKey;

  /// SALT-2 push gate — 「keymeta 已确认吗」("has keymeta been confirmed"),
  /// answered by the provisioner
  /// (main.dart wires this to BlindStoreKeyProvisioner.ensureConfirmed, whose
  /// per-account cache makes the steady state free of network). REQUIRED, no
  /// friendly default (Book 13 §7 F1 ②): a default `true` would be the façade
  /// that lets a race loser push orphan ciphertext, and a default `false`
  /// would silently kill the whole leg the day someone forgets the wiring.
  final Future<bool> Function() _keymetaConfirmed;

  /// Pages one run will walk. 20 × 200 = 4,000 rows, which is a first sync of a
  /// large history; past that the run stops and the next edge continues from the
  /// stored cursor. A bound rather than a `while (true)`: a server that kept
  /// answering full pages would otherwise spin this forever.
  static const int kMaxPullPages = 20;

  bool _running = false;

  /// Run one full cycle. Safe to call on every edge — re-entrant calls return a
  /// blocked-free empty report rather than stacking two drains on one link.
  Future<BlindStoreSyncReport> syncNow() async {
    if (_running) return const BlindStoreSyncReport();
    if (!_keyring.isUnlocked) {
      return const BlindStoreSyncReport.blockedBy(
        BlindStoreSyncBlock.keyringLocked,
      );
    }
    // 🔴 See the file header. Measured, and fail-closed.
    if (!_isCloudRelay()) {
      return const BlindStoreSyncReport.blockedBy(
        BlindStoreSyncBlock.notCloudRelay,
      );
    }
    final String? account = _accountKey();
    if (account == null || account.isEmpty) {
      return const BlindStoreSyncReport.blockedBy(
        BlindStoreSyncBlock.noAccount,
      );
    }

    // _running is taken BEFORE the first await: the gate below yields, and two
    // edges arriving together would otherwise both pass the re-entrancy check
    // at the top and stack two drains on one link.
    _running = true;
    try {
      // 🔴 THE PUSH GATE (SALT-2, design 2026-08-11 §3.2 step 4). Not one
      // frame — not even a pull — until this account's key metadata is
      // confirmed for the material currently in the keyring. A first-writer-
      // race loser holds a salt that is already doomed; a blob sealed under
      // it would be an orphan ciphertext this account's other devices can
      // never open, and the loser's discard (keyring.discardKeyMaterial) is
      // only lossless BECAUSE this gate held. Fail-closed like the
      // notCloudRelay judge above: a check that throws has not confirmed
      // anything.
      bool keymetaOk = false;
      try {
        keymetaOk = await _keymetaConfirmed();
      } on Object catch (e) {
        diag('blindstore.keymeta_gate_threw', <String, Object?>{'error': '$e'});
      }
      if (!keymetaOk) {
        return const BlindStoreSyncReport.blockedBy(
          BlindStoreSyncBlock.keymetaUnconfirmed,
        );
      }

      final BlindStoreSyncReport report = await _run(account);
      diag('blindstore.sync', report.toDiag());
      return report;
    } finally {
      _running = false;
    }
  }

  Future<BlindStoreSyncReport> _run(String account) async {
    int confirmed = 0;
    int pushed = 0;
    int merged = 0;
    int tombstoned = 0;
    int undecryptable = 0;
    String? failure;

    // 🔴 A REFUSAL DOES NOT STOP THE OTHER STAGES; AN UNREACHABLE LINK DOES.
    //
    // The two failures mean opposite things. 「服务器拒绝了这一笔」("the server
    // refused this one") says the link
    // works and this particular operation was answered — the other stages are
    // about different rows and deserve their own attempt. 「没人应答」("nobody
    // answered") says there
    // is no link, and every later stage could only fail the same way, so
    // carrying on would just manufacture two more misleading failure strings.
    //
    // ⚠️ This ordering was WRONG in this card's first draft: every stage was
    // gated on `failure == null`, which made stage 2's pending-delete guard
    // unreachable — and the reverse control aimed at that guard came back GREEN,
    // which is how the mistake was found. A guard no path reaches is a façade,
    // and a test that passes because the code never ran is worse than no test.
    bool linkAlive = true;
    Future<void> stage(Future<void> Function() body) async {
      if (!linkAlive) return;
      try {
        await body();
      } on BlindStoreCloudUnreachable catch (e) {
        linkAlive = false;
        failure ??= _describe(e);
      } on Object catch (e) {
        // Keep the FIRST failure: it is the proximate cause, and a later stage
        // failing for a downstream reason must not overwrite it.
        failure ??= _describe(e);
      }
    }

    // ── 1. Deletes first ────────────────────────────────────────────────────
    // 🔴 Before the push and before the pull. Draining first means the later
    // stages see a settled world; the reverse order would let a pull hand back a
    // row we are about to tombstone and merge it straight back in.
    await stage(() async {
      confirmed = await _drainDeletes();
    });

    // ── 2. Push what the cloud does not have ────────────────────────────────
    await stage(() async {
      pushed = await _pushPending();
    });

    // ── 3. Pull and merge ───────────────────────────────────────────────────
    await stage(() async {
      final _MergeTally tally = await _pullAndMerge(account);
      merged = tally.merged;
      tombstoned = tally.tombstoned;
      undecryptable = tally.undecryptable;
    });

    if (merged > 0 || tombstoned > 0) await _bridge.reload();

    return BlindStoreSyncReport(
      pushed: pushed,
      deletesConfirmed: confirmed,
      deletesStillPending: (await _state.pendingDeletes()).length,
      merged: merged,
      tombstonesApplied: tombstoned,
      undecryptable: undecryptable,
      failure: failure,
    );
  }

  /// Ask the server to tombstone everything owed. Returns the ACKED count.
  ///
  /// The pending markers are cleared ONLY after `ok:true`. A refusal or a
  /// timeout leaves every id in the set, so the next edge tries again — which is
  /// the whole reason the set is persistent.
  Future<int> _drainDeletes() async {
    final List<String> owed = await _state.pendingDeletes();
    if (owed.isEmpty) return 0;
    // The server's count can be lower than what we asked (an id it never held
    // changes no rows) and that is still success — see
    // BlindStoreCloudClient.tombstone. We settle the batch we ASKED about,
    // because 「那边没有这一条」("that side doesn't have this entry") and
    // 「那边删掉了这一条」("that side deleted this entry") want the same local outcome.
    await _client.tombstone(owed);
    await _state.forget(owed);
    return owed.length;
  }

  Future<int> _pushPending() async {
    final List<TimelineEntry> light = await _bridge.lightRecords();
    if (light.isEmpty) return 0;
    final Map<String, String> known = await _state.pushedHashes();
    final Set<String> owedDeletes = (await _state.pendingDeletes()).toSet();

    final List<BlindStoreOutgoingBlob> outgoing = <BlindStoreOutgoingBlob>[];
    final Map<String, String> hashes = <String, String>{};
    for (final TimelineEntry e in light) {
      // Defensive: a row that is owed a tombstone must never be re-uploaded.
      // Stage 1 normally empties this set; if its drain failed, this is what
      // stops a failed delete from turning into a resurrection.
      if (owedDeletes.contains(e.id)) continue;
      final String payload = encodeBlindStorePayload(e);
      final String hash = blindStorePayloadHash(payload);
      if (known[e.id] == hash) continue; // the cloud already has this exact content
      final String? sealed = _keyring.seal(entryId: e.id, plaintext: payload);
      if (sealed == null) continue; // keyring locked mid-run; nothing goes up unsealed
      outgoing.add(
        BlindStoreOutgoingBlob(
          id: e.id,
          ciphertext: sealed,
          createdAtMs: e.createdAt.toUtc().millisecondsSinceEpoch,
          schemaVer: kBlindStoreBlobSchemaVer,
        ),
      );
      hashes[e.id] = hash;
    }
    if (outgoing.isEmpty) return 0;

    final Map<String, int> assigned = await _client.push(outgoing);
    int n = 0;
    for (final BlindStoreOutgoingBlob b in outgoing) {
      // Only ids the server actually answered for are recorded. An id missing
      // from the ack is left unmarked and re-pushes next time — the alternative
      // (marking everything we sent) would record an intention as a fact and the
      // entry would never be retried.
      if (!assigned.containsKey(b.id)) continue;
      await _state.markPushed(entryId: b.id, payloadHash: hashes[b.id]!);
      n++;
    }
    return n;
  }

  Future<_MergeTally> _pullAndMerge(String account) async {
    int merged = 0;
    int tombstoned = 0;
    int undecryptable = 0;
    int since = _cursor.read(account);

    // Index the local light records once; a tombstone needs the whole entry
    // (the reaper deletes a row's bytes, not just its id).
    final Map<String, TimelineEntry> local = <String, TimelineEntry>{
      for (final TimelineEntry e in await _bridge.lightRecords()) e.id: e,
    };

    // 🔴 THE REACHABLE RESURRECTION PATH. The user deleted these rows locally and
    // the server has not been told yet (the drain above was refused). The server
    // therefore still serves them as live rows — and merging one would put a
    // deleted record back on the user's screen, which is the worst outcome this
    // whole leg can produce. They are skipped until the tombstone lands; once it
    // does, the row comes back as a tombstone with a fresh seq and converges.
    final Set<String> owedDeletes = (await _state.pendingDeletes()).toSet();

    for (int page = 0; page < kMaxPullPages; page++) {
      final BlindStorePullPage p = await _client.pull(sinceSeq: since);
      if (p.blobs.isEmpty) {
        since = p.nextSeq;
        break;
      }
      for (final BlindStoreRemoteBlob b in p.blobs) {
        if (b.deleted) {
          // 🔴 A tombstone carries no payload — the server replaced the bytes
          // with the bare `e2e:v1:` prefix (E-B0). Attempting to decrypt it
          // would fail and be counted as an undecryptable entry, i.e. a false
          // alarm raised by a correct delete. Branch before decrypting.
          final TimelineEntry? victim = local.remove(b.id);
          if (victim != null) {
            await _bridge.applyRemoteTombstone(victim);
            tombstoned++;
          }
          await _state.forget(<String>[b.id]);
          continue;
        }
        if (owedDeletes.contains(b.id)) continue; // see owedDeletes above
        final String plaintext;
        try {
          plaintext = _keyring.open(entryId: b.id, envelope: b.ciphertext);
        } on BlindStoreCryptoException catch (e) {
          // Wrong key, tampered bytes, or a blob moved onto another row's id —
          // GCM cannot tell them apart and neither will we. Counted and named.
          undecryptable++;
          diag('blindstore.undecryptable', <String, Object?>{
            'id': b.id,
            'seq': b.seq,
            'failure': e.failure.name,
          });
          continue;
        }
        final TimelineEntry? entry = decodeBlindStorePayload(plaintext);
        if (entry == null || entry.id != b.id) {
          // The bytes authenticated, so this is not a key problem: it is a
          // payload this build cannot read (a newer schema), or one whose inner
          // id disagrees with the row it arrived on. Both are counted rather
          // than guessed at.
          undecryptable++;
          diag('blindstore.unreadable_payload', <String, Object?>{
            'id': b.id,
            'seq': b.seq,
            'id_matches': entry?.id == b.id,
          });
          continue;
        }
        await _bridge.upsertFromCloud(entry);
        local[entry.id] = entry;
        // Now that the local copy IS the cloud copy, record the fingerprint so
        // stage 2 does not immediately push it back up as an edit and burn a
        // fresh seq on every device in a loop.
        await _state.markPushed(
          entryId: entry.id,
          payloadHash: blindStorePayloadHash(encodeBlindStorePayload(entry)),
        );
        merged++;
      }
      since = p.nextSeq;
      await _cursor.write(account, since);
      if (p.blobs.length < BlindStoreCloudClient.kPullBatch) break;
    }

    await _cursor.write(account, since);
    return _MergeTally(
      merged: merged,
      tombstoned: tombstoned,
      undecryptable: undecryptable,
    );
  }

  String _describe(Object e) => switch (e) {
    BlindStoreCloudRefusal(:final String code) => 'refused:$code',
    BlindStoreCloudUnreachable(:final String detail) => 'unreachable:$detail',
    _ => 'error:${e.runtimeType}',
  };
}

class _MergeTally {
  const _MergeTally({
    required this.merged,
    required this.tombstoned,
    required this.undecryptable,
  });

  final int merged;
  final int tombstoned;
  final int undecryptable;
}
