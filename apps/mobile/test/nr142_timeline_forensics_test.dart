import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'support/di.dart';
class _PrivateError extends InMemoryTimelinePersistence {
  @override
  Future<void> upsert(TimelineEntry entry) async => throw StateError('PRIVATE_ERROR_SENTINEL');
  @override
  Future<void> delete(String id) async => throw StateError('PRIVATE_ERROR_SENTINEL');
}
void main() {
  test('reload and bulk deletion diagnostics stay bounded', () async {
    final p = InMemoryTimelinePersistence(); final store = newTestStore(persistence: p);
    addTearDown(store.dispose);
    for (int i = 0; i < 200; i++) {
      final row = store.buildFromUtterance(clientId: 'bulk-$i',
        mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_BULK_SENTINEL');
      await store.awaitPersisted(row.id);
    }
    await store.load();
    DiagLog.instance.clear();
    for (int i = 0; i < 3; i++) { await store.load(); }
    final reloads = DiagLog.instance.snapshot();
    expect(reloads, hasLength(3), reason: 'one count line per reload');
    expect(reloads.join('\n'), isNot(contains('loc_')));
    DiagLog.instance.clear();
    await newTestReaper(persistence: p).reap(await p.loadAll());
    final deletes = DiagLog.instance.snapshot();
    expect(deletes.length, lessThanOrEqualTo(2));
    expect(deletes.join('\n').length, lessThan(2500));
    expect(deletes.join('\n'), contains('rows=200'));
    expect(deletes.join('\n'), isNot(contains('PRIVATE_BULK_SENTINEL')));
  });

  test('persistence and deletion diagnostics do not serialize payload-bearing exceptions', () async {
    DiagLog.instance.clear();
    final p = _PrivateError(); final store = newTestStore(persistence: p);
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'private-error',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_SOURCE_SENTINEL');
    await store.awaitPersisted(row.id);
    store.delete(row.id); await pumpEventQueue();
    final trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('timeline.persist_failed'));
    expect(trail, contains('timeline.reap_failed'));
    expect(trail, isNot(contains('PRIVATE_ERROR_SENTINEL')));
    expect(trail, isNot(contains('PRIVATE_SOURCE_SENTINEL')));
  });

  test('delete, storage replacement and cloud tombstones log IDs without text', () async {
    DiagLog.instance.clear();
    final p = InMemoryTimelinePersistence(); final store = newTestStore(persistence: p);
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'forensic-row',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_SOURCE_SENTINEL');
    await store.awaitPersisted(row.id);
    store.applyEdit(row.id, 'PRIVATE_EDIT_SENTINEL'); await store.awaitPersisted(row.id);
    await store.load();
    final bridge = BlindStoreTimelineBridge(persistence: p,
      reaper: newTestReaper(persistence: p), store: store, reload: store.load);
    await bridge.applyRemoteTombstone(row);
    final trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('timeline.replace_from_storage'));
    expect(trail, contains('timeline.delete'));
    expect(trail, contains('timeline.tombstone_apply'));
    expect(trail, contains(row.id));
    expect(trail, isNot(contains('PRIVATE_SOURCE_SENTINEL')));
    expect(trail, isNot(contains('PRIVATE_EDIT_SENTINEL')));
  });
}
