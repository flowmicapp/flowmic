import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'blind_store_cloud_sync_test.dart' show Harness, kAccount;

void main() {
  test('corrupt retry stays untouched while sync advances and raises a notice', () async {
    final key = 'flowmic.timeline.cloud.cursor.v1.retry.${Uri.encodeComponent(kAccount)}.broken';
    SharedPreferences.setMockInitialValues({key: '{broken'});
    final prefs = await SharedPreferences.getInstance();
    final cursor = SharedPrefsBlindStoreCursorStore(prefs);
    const blob = BlindStoreRemoteBlob(id: 'healthy', seq: 1, ciphertext: 'cipher',
      createdAtMs: 1, schemaVer: 1, deleted: false);
    await cursor.saveRetry(kAccount, blob);
    final h = Harness(cursorStore: cursor); await h.boot(); addTearDown(h.store.dispose);
    DiagLog.instance.clear();
    h.transport.ackQueue.add(Harness.emptyPull(nextSeq: 2));
    await h.sync.syncNow();
    expect(cursor.read(kAccount), 2);
    expect(prefs.getString(key), '{broken');
    expect(h.store.recoveryFailures.noticeTicket, isNotNull);
    expect(DiagLog.instance.snapshot().join('\n'), contains('unreadable_retries'));
    expect(DiagLog.instance.snapshot().join('\n'), isNot(contains('{broken')));
  });
  test('locally owed deletion removes stale retry without resurrecting a row', () async {
    final h = Harness(); await h.boot(); addTearDown(h.store.dispose);
    const blob = BlindStoreRemoteBlob(id: 'deleted', seq: 1, ciphertext: 'cipher',
      createdAtMs: 1, schemaVer: 1, deleted: false);
    await h.cursor.saveRetry(kAccount, blob);
    h.state.seedPendingDelete('deleted');
    h.transport.ackQueue.addAll([{'error': 'DISK_FULL'}, Harness.emptyPull(nextSeq: 1)]);
    await h.sync.syncNow();
    expect(await h.cursor.loadRetries(kAccount), isEmpty);
    expect(await h.persistence.loadById('deleted'), isNull);
    expect(await h.state.pendingDeletes(), ['deleted']);
  });
}
