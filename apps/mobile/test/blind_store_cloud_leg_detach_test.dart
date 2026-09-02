// AUD-D P2-5/F9 — `BlindStoreCloudLeg.detachForAccountChange()`: the piece
// that closes the OTHER half of the cross-account leak AccountScopedBlindStoreKeyStore
// closes on the storage side (see blind_store_key_provisioner_test.dart's
// "the account-scoped store never lets two accounts share one key slot"
// group). Storage partitioning alone is not enough while ONE long-lived
// `BlindStoreKeyring` (main.dart builds exactly one for the app's lifetime)
// keeps a signed-out account's derived MasterKey live in `_key` — this test
// proves `detachForAccountChange()` actually drops it and actually stops the
// leg reacting to further room joins, rather than merely existing unwired
// (13 册 §7 F1: "a capability whose only wiring is a line in main.dart has
// no test that can prove the line exists").

import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_leg.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_key_provisioner.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_keymeta_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flutter/foundation.dart' show ValueNotifier;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

final Argon2Cost kFast = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);

/// Never actually dialled in this test — `detachForAccountChange()` does not
/// touch the provisioner, and `syncNow()`'s push gate short-circuits (the
/// keyring is locked / the room hasn't joined). Throwing on a real call would
/// fail LOUDLY if that assumption ever stops holding, rather than silently
/// answering something that looks plausible.
class _UncalledKeymetaClient implements BlindStoreKeymetaClient {
  @override
  Future<BlindStoreKeymetaRow?> get() =>
      throw StateError('unexpected keymeta GET in a detach-only test');

  @override
  Future<BlindStoreKeymetaPutOutcome> put({
    required Uint8List salt,
    required String sentinel,
  }) => throw StateError('unexpected keymeta PUT in a detach-only test');
}

void main() {
  test('detachForAccountChange() locks the keyring — the persisted material '
      'stays, only the in-memory MasterKey drops', () async {
    final BlindStoreKeyring keyring = BlindStoreKeyring(
      store: InMemoryBlindStoreKeyStore(),
      cost: kFast,
    );
    await keyring.enroll('outgoing-account-words');
    expect(keyring.isUnlocked, isTrue);

    final ValueNotifier<int> roomJoins = ValueNotifier<int>(0);
    final BlindStoreCloudLeg leg = BlindStoreCloudLeg(
      keyring: keyring,
      sync: BlindStoreCloudSync(
        keyring: keyring,
        client: BlindStoreCloudClient(transport: FakeSocketTransport()),
        state: InMemoryBlindStoreCloudStateStore(),
        bridge: BlindStoreTimelineBridge(
          persistence: InMemoryTimelinePersistence(),
          reaper: TimelineReaper(
            persistence: InMemoryTimelinePersistence(),
            images: InMemoryOutboxBlobStore(),
            vault: InMemoryUnknownFieldVault(),
            cutoffs: InMemoryCutoffStore(),
          ),
          reload: () async {},
        ),
        cursor: InMemoryBlindStoreCursorStore(),
        isCloudRelay: () => true,
        accountKey: () => 'outgoing@example.com',
        keymetaConfirmed: () async => false, // gate stays shut either way
      ),
      provisioner: BlindStoreKeyProvisioner(
        keyring: keyring,
        client: _UncalledKeymetaClient(),
        accountKey: () => 'outgoing@example.com',
      ),
      roomJoins: roomJoins,
    );

    leg.detachForAccountChange();

    expect(keyring.isUnlocked, isFalse,
        reason: 'the outgoing account\'s derived MasterKey must not survive '
            'in memory for whoever signs in next');
    // The PERSISTED material is untouched — this is a lock, not a discard.
    // (lock() only clears the in-memory key; lib/src/crypto/blind_store_keyring.dart
    // pins that discardKeyMaterial() is the destructive one and it is not what
    // detachForAccountChange calls.)
    expect(await keyring.sharedKeyMaterial(), isNotNull);
  });

  test('detachForAccountChange() stops the leg reacting to further room '
      'joins — a stray sync must not run under the outgoing account\'s '
      'still-live keyring reference', () async {
    final BlindStoreKeyring keyring = BlindStoreKeyring(
      store: InMemoryBlindStoreKeyStore(),
      cost: kFast,
    );
    await keyring.enroll('outgoing-account-words');
    final FakeSocketTransport transport = FakeSocketTransport();
    final ValueNotifier<int> roomJoins = ValueNotifier<int>(0);
    final BlindStoreCloudLeg leg = BlindStoreCloudLeg(
      keyring: keyring,
      sync: BlindStoreCloudSync(
        keyring: keyring,
        client: BlindStoreCloudClient(transport: transport),
        state: InMemoryBlindStoreCloudStateStore(),
        bridge: BlindStoreTimelineBridge(
          persistence: InMemoryTimelinePersistence(),
          reaper: TimelineReaper(
            persistence: InMemoryTimelinePersistence(),
            images: InMemoryOutboxBlobStore(),
            vault: InMemoryUnknownFieldVault(),
            cutoffs: InMemoryCutoffStore(),
          ),
          reload: () async {},
        ),
        cursor: InMemoryBlindStoreCursorStore(),
        isCloudRelay: () => true,
        accountKey: () => 'outgoing@example.com',
        // Confirmed so a stray syncNow() would actually try to push/pull
        // (and thus show up as an emitted frame) rather than bailing at an
        // earlier, less convincing gate.
        keymetaConfirmed: () async => true,
      ),
      provisioner: BlindStoreKeyProvisioner(
        keyring: keyring,
        client: _UncalledKeymetaClient(),
        accountKey: () => 'outgoing@example.com',
      ),
      roomJoins: roomJoins,
    );
    leg.attach();
    expect(leg.isAttached, isTrue);

    leg.detachForAccountChange();
    expect(leg.isAttached, isFalse);

    // A room join AFTER detaching must not resurrect the subscription.
    roomJoins.value = roomJoins.value + 1;
    await Future<void>.delayed(Duration.zero);
    expect(
      transport.emittedWhere(FlowMicEvents.timelinePush),
      isEmpty,
      reason: 'the outgoing account\'s leg must not push a frame after '
          'detachForAccountChange()',
    );
  });
}
