import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_leg.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_key_provisioner.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_keymeta_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'blind_store_cloud_sync_test.dart' show Harness, kFast;
import 'support/di.dart';

class _Keymeta implements BlindStoreKeymetaClient {
  @override
  Future<BlindStoreKeymetaRow?> get() async => throw StateError('unused');
  @override
  Future<BlindStoreKeymetaPutOutcome> put({required Uint8List salt, required String sentinel}) async => throw StateError('unused');
}
class _ThrowRead extends InMemoryBlindStoreKeyStore {
  @override
  Future<BlindStoreKeyMaterial?> read() async => throw StateError('PRIVATE_RESTORE_SENTINEL');
}
class _ThrowSync extends BlindStoreCloudSync {
  _ThrowSync(Harness h) : super(keyring: h.keyring,
    client: BlindStoreCloudClient(transport: h.transport), state: h.state,
    bridge: BlindStoreTimelineBridge(persistence: h.persistence, store: h.store,
      reaper: newTestReaper(persistence: h.persistence), reload: () async {}),
    cursor: h.cursor, isCloudRelay: () => true, accountKey: () => 'account', keymetaConfirmed: () async => true);
  @override
  Future<BlindStoreSyncReport> syncNow() async => throw StateError('PRIVATE_SYNC_SENTINEL');
}
void main() {
  test('keymeta gate diagnostics contain exception type only', () async {
    final h = Harness(); await h.boot(); addTearDown(h.store.dispose);
    h.keymetaGateThrows = true;
    DiagLog.instance.clear(); await h.sync.syncNow();
    final trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('keymeta_gate_threw'));
    expect(trail, contains('StateError'));
    expect(trail, isNot(contains('keymeta confirmation check exploded')));
  });
  for (final bool restore in [true, false]) {
    test('cloud leg ${restore ? "restore" : "sync"} diagnostics contain exception type only', () async {
      final h = Harness(); await h.boot(); addTearDown(h.store.dispose);
      final ring = restore ? BlindStoreKeyring(store: _ThrowRead(), cost: kFast) : h.keyring;
      final joins = ValueNotifier<int>(0); addTearDown(joins.dispose);
      final leg = BlindStoreCloudLeg(keyring: ring, sync: _ThrowSync(h), roomJoins: joins,
        provisioner: BlindStoreKeyProvisioner(keyring: ring, client: _Keymeta(), accountKey: () => 'account'));
      addTearDown(leg.dispose);
      DiagLog.instance.clear(); leg.attach(); await pumpEventQueue();
      final trail = DiagLog.instance.snapshot().join('\n');
      expect(trail, contains(restore ? 'restore_failed' : 'sync_threw'));
      expect(trail, contains('StateError'));
      expect(trail, isNot(contains('PRIVATE_')));
    });
  }
}
