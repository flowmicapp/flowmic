// SALT-2 — the §3.2 provisioner: the ONE flow that turns 「this account's key
// metadata」
// into a confirmed local key, and the confirmation authority the push gate asks.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-multidevice-salt.md §3.2 (the four
//     steps: GET → adopt / enroll+PUT → 409 discard-and-adopt → push gate);
//   apps/server-core/src/http/timeline-keymeta-routes.ts (the wire contract);
//   CLAUDE.md's four human-reviewed sensitive paths: the cryptography surface
//     — reviewed line-by-line by the first-in-charge
//
// ── SINGLE ENTRY, ON PURPOSE ────────────────────────────────────────────────
// E-B2 (the enrolment UI, unbuilt) will call [provision] and nothing else.
// Every path that can mint, adopt or discard key material for the cloud runs
// through this file, so 「where this device's key came from」 has one answer. The keyring
// remains the only holder of keys; this file only ORDERS the steps.
//
// ── WHAT 「CONFIRMED」 MEANS, EXACTLY (design §3.2 step 4) ──────────────────
// The account's stored keymeta row and this device's local material are the
// SAME BYTES, proven by either: a PUT the server answered 201/200 to, or a GET
// whose row matched the local material byte-for-byte. Nothing else counts —
// not being enrolled, not being logged in, not a previous device's success.
// Until then the push gate in blind_store_cloud_sync.dart blocks every frame,
// which is what makes the 409 loser's discard lossless: a never-confirmed key
// has pushed zero blobs, so no ciphertext ever existed under the doomed salt.
//
// ── THE CONFIRMATION CACHE IS A FINGERPRINT, NOT A FLAG ─────────────────────
// 「once confirmed, do not re-GET on every sync」 — but a bare per-account bool
// would keep answering 「confirmed」 after the device's material CHANGED (an
// adopt for another account overwrites the one device-level keyring). So the
// cache stores WHICH material was confirmed (salt+sentinel fingerprint) per
// account key (the cursor-store precedent), and [_cacheSaysConfirmed] compares
// it against the material currently in the keyring. An account switch is a
// different key ⇒ unconfirmed by construction; a material change is a
// fingerprint mismatch ⇒ re-verified. In-memory: re-verification after a
// relaunch costs one GET per account per process, and a persisted claim would
// be one more thing able to go stale.

import 'dart:convert';
import 'dart:typed_data';

import '../../crypto/blind_store_keyring.dart';
import '../../diag/diag_log.dart';
import 'blind_store_cloud_client.dart'
    show BlindStoreCloudRefusal, BlindStoreCloudUnreachable;
import 'blind_store_keymeta_client.dart';

/// How a provisioning attempt settled. Callers branch on the TYPE — every
/// case wants a different next action, and a string would let two of them
/// blur (the repo's headline bug shape).
enum BlindStoreProvisionOutcome {
  /// This device's material IS the account's registered material. Blobs may
  /// be pushed (the sync gate reads exactly this).
  confirmed,

  /// A registered row exists (or is owed) and this call had no passphrase to
  /// act with — or no material exists at all. E-B2 prompts and calls
  /// [BlindStoreKeyProvisioner.provision]. Never rendered as 「the cloud is empty」.
  needsPassphrase,

  /// The 409 race path ran end-to-end: this device enrolled, lost the
  /// first-writer race, DISCARDED its freshly minted material and adopted the
  /// stored row (design §3.2 step 3). Confirmed — with the SERVER's bytes.
  conflictAdopted,

  /// Nobody answered (or answered unreadably). Local material is left intact
  /// and provisioning is NOT confirmed — design §3.2's PUT-unreachable rule.
  unreachable,

  /// The server refused by name (auth family, KEYMETA_INVALID, an unmounted
  /// route's plain status). [BlindStoreProvisionResult.detail] carries the
  /// server's own code — never one this file invented.
  refused,
}

/// One settled provisioning attempt.
class BlindStoreProvisionResult {
  const BlindStoreProvisionResult(this.outcome, {this.detail});

  final BlindStoreProvisionOutcome outcome;

  /// The server's refusal code / the unreachable detail / which passphrase-
  /// less dead end was hit. For a human log line, never for branching.
  final String? detail;

  /// True iff blobs may be pushed under the current material.
  bool get isConfirmed =>
      outcome == BlindStoreProvisionOutcome.confirmed ||
      outcome == BlindStoreProvisionOutcome.conflictAdopted;

  @override
  String toString() =>
      'BlindStoreProvisionResult(${outcome.name}'
      '${detail == null ? '' : ': $detail'})';
}

class BlindStoreKeyProvisioner {
  BlindStoreKeyProvisioner({
    required BlindStoreKeyring keyring,
    required BlindStoreKeymetaClient client,
    required String? Function() accountKey,
  }) : _keyring = keyring,
       _client = client,
       _accountKey = accountKey;

  final BlindStoreKeyring _keyring;
  final BlindStoreKeymetaClient _client;

  /// Same seam the sync's cursor uses (main.dart passes the login email).
  final String? Function() _accountKey;

  /// account key → the fingerprint of the material that was confirmed for it.
  /// See the file header for why this is a fingerprint and not a bool.
  final Map<String, String> _confirmedFingerprint = <String, String>{};

  /// Serialises [provision] / [ensureConfirmed]: two interleaved walks could
  /// enroll twice or discard what the other just adopted. A chain, not a
  /// dedupe — each caller gets its own settled result.
  Future<void> _chain = Future<void>.value();

  Future<T> _synchronized<T>(Future<T> Function() body) {
    final Future<T> run = _chain.then((_) => body());
    _chain = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  /// The passive half: confirm WITHOUT a passphrase when that is possible —
  /// cache hit, byte-for-byte GET match, or completing a PUT the last attempt
  /// could not deliver (design §3.2 step d leaves material intact precisely so
  /// this can finish the registration later without re-prompting).
  ///
  /// This is what the sync's push gate calls on every edge; the cache makes
  /// the steady state free of network.
  Future<BlindStoreProvisionResult> ensureConfirmed() =>
      _synchronized(_ensureConfirmed);

  /// The full §3.2 flow, idempotent — THE entry E-B2 will call.
  ///
  /// 🔴 A wrong passphrase THROWS the keyring's own [BlindStorePassphraseRejected]
  /// rather than folding into a result: 「you typed it wrong」 must stay a distinct, loud
  /// type all the way up (design §2.1 — it must never degrade into an
  /// empty-looking cloud), and a caller that wants to say so has to catch
  /// exactly it.
  Future<BlindStoreProvisionResult> provision({required String passphrase}) =>
      _synchronized(() => _provision(passphrase, reGetBudget: 1));

  // ── the walks ─────────────────────────────────────────────────────────────

  Future<BlindStoreProvisionResult> _ensureConfirmed() async {
    if (await _cacheSaysConfirmed()) {
      return const BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.confirmed,
      );
    }
    final ({Uint8List salt, String sentinel})? local =
        await _keyring.sharedKeyMaterial();
    if (local == null) {
      // Nothing to confirm and nothing to register — enrolment needs a
      // passphrase, and inventing one is not on the table.
      return const BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.needsPassphrase,
        detail: 'not-enrolled',
      );
    }

    final BlindStoreKeymetaRow? row;
    try {
      row = await _client.get();
    } on BlindStoreCloudRefusal catch (e) {
      return _refused(e);
    } on BlindStoreCloudUnreachable catch (e) {
      return _unreachable(e);
    }

    if (row != null) {
      if (_matches(local, row)) return _confirm(local.salt, local.sentinel);
      // The account's registered material is NOT ours. Adopting needs the
      // passphrase (the sentinel is the only judge of it) — E-B2's turn.
      return const BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.needsPassphrase,
        detail: 'account-row-differs-from-local-material',
      );
    }

    // No row, and we hold material: finish the registration (the step-d
    // recovery — the mint survived an unreachable PUT on a previous walk).
    try {
      final BlindStoreKeymetaPutOutcome put =
          await _client.put(salt: local.salt, sentinel: local.sentinel);
      if (put == BlindStoreKeymetaPutOutcome.conflict) {
        // A differing row landed between the GET and the PUT. Passphrase-less,
        // we can neither adopt it nor honestly discard ours here — report and
        // let provision() resolve it. The gate stays closed meanwhile.
        return const BlindStoreProvisionResult(
          BlindStoreProvisionOutcome.needsPassphrase,
          detail: 'lost-first-writer-race',
        );
      }
      return _confirm(local.salt, local.sentinel);
    } on BlindStoreCloudRefusal catch (e) {
      return _refused(e);
    } on BlindStoreCloudUnreachable catch (e) {
      return _unreachable(e);
    }
  }

  Future<BlindStoreProvisionResult> _provision(
    String passphrase, {
    required int reGetBudget,
  }) async {
    if (await _cacheSaysConfirmed()) {
      return const BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.confirmed,
      );
    }

    // ── step 1: GET ─────────────────────────────────────────────────────────
    final BlindStoreKeymetaRow? row;
    try {
      row = await _client.get();
    } on BlindStoreCloudRefusal catch (e) {
      return _refused(e);
    } on BlindStoreCloudUnreachable catch (e) {
      return _unreachable(e);
    }

    // ── step 2: a row exists ⇒ the stored material governs ─────────────────
    if (row != null) {
      return _adoptRow(
        row,
        passphrase,
        onAdopted: BlindStoreProvisionOutcome.confirmed,
      );
    }

    // ── step 3: no row ⇒ register ours (minting only if we hold none) ──────
    final bool minted = await _keyring.sharedKeyMaterial() == null;
    if (minted) await _keyring.enroll(passphrase);
    final ({Uint8List salt, String sentinel}) mat =
        (await _keyring.sharedKeyMaterial())!;

    final BlindStoreKeymetaPutOutcome put;
    try {
      put = await _client.put(salt: mat.salt, sentinel: mat.sentinel);
    } on BlindStoreCloudRefusal catch (e) {
      // Material stays: a refusal says nothing about the material, and a
      // later walk can still register it.
      return _refused(e);
    } on BlindStoreCloudUnreachable catch (e) {
      // 🔴 Design §3.2 step d, verbatim: report unreachable, leave the local
      // material INTACT, provisioning NOT confirmed. The mint is not wasted —
      // ensureConfirmed() completes the PUT next time without re-prompting.
      return _unreachable(e);
    }

    if (put != BlindStoreKeymetaPutOutcome.conflict) {
      return _confirm(mat.salt, mat.sentinel);
    }

    // ── step 3a: PUT 409 — we lost the first-writer race ───────────────────
    // 🔴 Discard ONLY what this very walk minted. The push gate has held the
    // whole time, so zero blobs exist under the doomed salt — the discard is
    // lossless (the keyring method's doc carries the full argument). Material
    // that predates this walk is not ours to destroy here: adoption below
    // overwrites it on success, and on a rejected passphrase it must survive
    // untouched.
    if (minted) await _keyring.discardKeyMaterial();
    diag('blindstore.keymeta_race_lost', <String, Object?>{
      'minted_discarded': minted,
    });

    final BlindStoreKeymetaRow? stored;
    try {
      stored = await _client.get();
    } on BlindStoreCloudRefusal catch (e) {
      return _refused(e);
    } on BlindStoreCloudUnreachable catch (e) {
      return _unreachable(e);
    }
    if (stored == null) {
      // The server said 「a differing row exists」 and then served none. Walk
      // once more from the top (a fresh enrol+PUT is correct against a row
      // that truly vanished); a second inconsistency is reported as the
      // refusal we actually received, not papered over.
      if (reGetBudget > 0) {
        return _provision(passphrase, reGetBudget: reGetBudget - 1);
      }
      return const BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.refused,
        detail: 'KEYMETA_CONFLICT: PUT refused as differing, then GET served '
            'no row — the server is answering inconsistently',
      );
    }
    return _adoptRow(
      stored,
      passphrase,
      onAdopted: BlindStoreProvisionOutcome.conflictAdopted,
    );
  }

  /// Step 2's body: the stored row governs. Byte-match short-circuits to
  /// confirmed; otherwise adopt — and a rejected passphrase PROPAGATES as
  /// [BlindStorePassphraseRejected] (see [provision]).
  Future<BlindStoreProvisionResult> _adoptRow(
    BlindStoreKeymetaRow row,
    String passphrase, {
    required BlindStoreProvisionOutcome onAdopted,
  }) async {
    final ({Uint8List salt, String sentinel})? local =
        await _keyring.sharedKeyMaterial();
    if (local != null && _matches(local, row)) {
      return _confirm(local.salt, local.sentinel);
    }
    await _keyring.adoptSharedKeyMaterial(
      salt: row.salt,
      sentinel: row.sentinel,
      passphrase: passphrase,
    );
    return _confirm(row.salt, row.sentinel, outcome: onAdopted);
  }

  // ── confirmation bookkeeping ──────────────────────────────────────────────

  Future<bool> _cacheSaysConfirmed() async {
    final String? account = _accountKey();
    if (account == null || account.isEmpty) return false;
    final String? confirmed = _confirmedFingerprint[account];
    if (confirmed == null) return false;
    final ({Uint8List salt, String sentinel})? m =
        await _keyring.sharedKeyMaterial();
    if (m == null) return false;
    return confirmed == _fingerprint(m.salt, m.sentinel);
  }

  BlindStoreProvisionResult _confirm(
    Uint8List salt,
    String sentinel, {
    BlindStoreProvisionOutcome outcome = BlindStoreProvisionOutcome.confirmed,
  }) {
    final String? account = _accountKey();
    if (account != null && account.isNotEmpty) {
      _confirmedFingerprint[account] = _fingerprint(salt, sentinel);
    }
    diag('blindstore.keymeta_confirmed', <String, Object?>{
      'outcome': outcome.name,
    });
    return BlindStoreProvisionResult(outcome);
  }

  static BlindStoreProvisionResult _refused(BlindStoreCloudRefusal e) =>
      BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.refused,
        detail: e.code,
      );

  static BlindStoreProvisionResult _unreachable(BlindStoreCloudUnreachable e) =>
      BlindStoreProvisionResult(
        BlindStoreProvisionOutcome.unreachable,
        detail: e.detail,
      );

  static bool _matches(
    ({Uint8List salt, String sentinel}) local,
    BlindStoreKeymetaRow row,
  ) {
    if (local.sentinel != row.sentinel) return false;
    if (local.salt.length != row.salt.length) return false;
    for (int i = 0; i < local.salt.length; i++) {
      if (local.salt[i] != row.salt[i]) return false;
    }
    return true;
  }

  /// The cache key for 「which material was confirmed」. Not compared against
  /// anything cryptographic — two equal fingerprints mean equal bytes, which
  /// is all the cache needs.
  static String _fingerprint(Uint8List salt, String sentinel) =>
      '${base64.encode(salt)}\n$sentinel';
}
