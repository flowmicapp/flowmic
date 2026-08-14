// E-CL — the composition of the blind-store leg, as one object.
//
// SPEC-REF: docs/strategy/2026-08-08-design-e-blindstore-client.md §4.1
//   (drains on "the next authenticated cloud connection").
//
// main.dart builds this and calls [attach]. Everything the leg needs to decide
// WHEN to run lives here rather than in the composition root, for the reason
// this repo keeps re-learning: a capability whose only wiring is a line in
// main.dart has no test that can prove the line exists. This object can be
// constructed in a test and asked whether it subscribed.
//
// 🔴 The trigger edge is `PttSession.roomJoins` — the counter F-1 added because
// "successfully entered the room" (进房成功) had no subscriber, whose only writers are a successful
// `mobile:pair` and an accepted `mobile:reconnect`. It is a COUNTER, not a
// bool, so a second join fires again; that property is what makes it usable as
// an edge at all, and `outbox_drains_on_room_join_test.dart` already pins it.
//
// ⚠️ Deliberately NOT the `connected` edge. That is precisely the F-1 defect:
// a socket being connected does not mean the far end has admitted it, and a
// drain hung there fires ~170ms too early, gets refused, and never retries.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../crypto/blind_store_keyring.dart';
import '../../diag/diag_log.dart';
import 'blind_store_cloud_sync.dart';
import 'blind_store_key_provisioner.dart';

class BlindStoreCloudLeg {
  BlindStoreCloudLeg({
    required BlindStoreKeyring keyring,
    required BlindStoreCloudSync sync,
    required this.provisioner,
    required ValueListenable<int> roomJoins,
  }) : _keyring = keyring,
       _sync = sync,
       _roomJoins = roomJoins;

  final BlindStoreKeyring _keyring;
  final BlindStoreCloudSync _sync;

  /// SALT-2 — the ONE §3.2 entry E-B2's enrolment UI will call
  /// ([BlindStoreKeyProvisioner.provision]). Held here, public, so the future
  /// UI reaches the same instance whose confirmation cache the sync's push
  /// gate reads — a second provisioner would be a second answer to
  /// "has this account been confirmed" (这个账号确认过了吗). Nothing in the leg
  /// calls it with a passphrase; the
  /// sync's gate uses its passphrase-less half (ensureConfirmed) through the
  /// keymetaConfirmed seam wired in main.dart.
  final BlindStoreKeyProvisioner provisioner;

  final ValueListenable<int> _roomJoins;

  bool _attached = false;

  /// The last run's measurements, or null if none has completed.
  ///
  /// Exposed for diagnostics and for whatever E-B2/E-B7 renders. 🔴 Nothing here
  /// renders it, and nothing here authors a sentence about it — reporting a sync
  /// to the user is copy, and copy is another lane's this wave.
  BlindStoreSyncReport? lastReport;

  bool get isAttached => _attached;

  /// Subscribe to the admission edge and try once for the current link.
  ///
  /// The immediate attempt is not a duplicate of the edge: on a cold start the
  /// join may already have happened before this object existed, and without it
  /// the first sync of the session would wait for a reconnect that may never
  /// come. It is idempotent — [BlindStoreCloudSync.syncNow] is re-entrant-safe
  /// and every gate is re-checked inside it.
  void attach() {
    if (_attached) return;
    _attached = true;
    _roomJoins.addListener(_onRoomJoined);
    unawaited(_restoreThenSync());
  }

  Future<void> _restoreThenSync() async {
    // Re-open the keyring from the platform keystore. False is the ordinary
    // answer on every install today (nothing has ever enrolled a passphrase —
    // see blind_store_keyring.dart), and it means the leg stays inert rather
    // than pushing anything unencrypted or half-keyed.
    bool unlocked = false;
    try {
      unlocked = await _keyring.restore();
    } on Object catch (e) {
      // A keystore that will not answer is a reason to do nothing, never a
      // reason to take the app down on a background future.
      diag('blindstore.restore_failed', <String, Object?>{'error': '$e'});
      return;
    }
    diag('blindstore.attach', <String, Object?>{'keyring_unlocked': unlocked});
    if (!unlocked) return;
    await _runOnce();
  }

  void _onRoomJoined() => unawaited(_runOnce());

  Future<void> _runOnce() async {
    // 🔴 Never throws into the caller. This runs off a ValueNotifier callback
    // and off an unawaited future; an escaping error there is an unhandled async
    // error that can take the zone down, and a failed cloud sync must not be
    // able to affect anything the user is doing.
    try {
      lastReport = await _sync.syncNow();
    } on Object catch (e) {
      diag('blindstore.sync_threw', <String, Object?>{'error': '$e'});
    }
  }

  void dispose() {
    if (!_attached) return;
    _roomJoins.removeListener(_onRoomJoined);
    _attached = false;
  }
}
