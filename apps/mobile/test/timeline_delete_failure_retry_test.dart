// Permanent reviewer repro for NR-146 B2.
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'support/di.dart';

class _FailOnce extends InMemoryTimelinePersistence {
  int fails = 1;
  @override
  Future<void> delete(String id) async {
    if (fails > 0) { fails--; throw StateError('refused once'); }
    await super.delete(id);
  }
}
void main() {
  test('retry success clears the delete-failure notice', () async {
    final p = _FailOnce(); final store = newTestStore(persistence: p);
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'a', mode: FlowMode.realtime,
      delivery: Delivery.none, text: 'hello');
    await store.awaitPersisted(row.id);
    store.delete(row.id); await pumpEventQueue();
    expect(store.findById(row.id), isNotNull);
    expect(store.deleteFailures.noticeTicket, isNotNull);
    store.delete(row.id); await pumpEventQueue();
    expect(store.findById(row.id), isNull);
    expect(await p.loadById(row.id), isNull);
    expect(store.deleteFailures.noticeTicket, isNull,
      reason: 'banner still claims some records are still here');
    final next = store.buildFromUtterance(clientId: 'b', mode: FlowMode.realtime,
      delivery: Delivery.none, text: 'next record');
    await store.awaitPersisted(next.id);
    p.fails = 1;
    store.delete(next.id); await pumpEventQueue();
    expect(store.findById(next.id), isNotNull);
    expect(await p.loadById(next.id), isNotNull);
    expect(store.deleteFailures.noticeTicket, isNotNull,
      reason: 'a new failed deletion after success must be surfaced immediately');
  });
}
