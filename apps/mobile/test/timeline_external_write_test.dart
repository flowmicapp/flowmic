// NR-146: reverse control bypasses store.saveExternalRecord in both adapters.
import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/portable/timeline_import_sink.dart';
import 'support/di.dart';

class _Fails extends InMemoryTimelinePersistence {
  bool fail = false;
  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (fail) throw StateError('external write refused');
    await super.upsert(entry);
  }
}

class _HeldBirth extends InMemoryTimelinePersistence {
  final Completer<void> gate = Completer<void>();
  @override
  Future<void> upsert(TimelineEntry entry) async {
    await gate.future;
    await super.upsert(entry);
  }
}

class _HeldEdit extends InMemoryTimelinePersistence {
  bool hold = false;
  final gate = Completer<void>();
  final entered = Completer<void>();
  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (hold) { if (!entered.isCompleted) entered.complete(); await gate.future; }
    await super.upsert(entry);
  }
}

void main() {
  test('cloud delete with a local edit in flight cannot resurrect the row', () async {
    final p = _HeldEdit(); final store = newTestStore(persistence: p);
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'cloud-delete',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'private sentinel');
    await store.awaitPersisted(row.id);
    final bridge = BlindStoreTimelineBridge(persistence: p,
      reaper: newTestReaper(persistence: p), store: store, reload: store.load);
    p.hold = true;
    store.applyEdit(row.id, 'private edited sentinel');
    await p.entered.future;
    final deletion = bridge.applyRemoteTombstone(row);
    store.applyEdit(row.id, 'private later sentinel');
    p.gate.complete();
    await deletion; await pumpEventQueue();
    expect(await p.loadById(row.id), isNull);
    expect(store.findById(row.id), isNull);
  });

  test('a page reload cannot cancel queued persistence of an undeleted row', () async {
    final persistence = _HeldBirth();
    final store = newTestStore(persistence: persistence);
    addTearDown(store.dispose);
    store.buildFromUtterance(clientId: 'first', mode: FlowMode.realtime,
      delivery: Delivery.none, text: 'first sentence');
    final second = store.buildFromUtterance(clientId: 'second',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'second sentence');
    await store.load();
    persistence.gate.complete();
    await store.awaitPersisted(second.id);
    expect(await persistence.loadById(second.id), isNotNull);
    await store.load();
    expect(store.findById(second.id)?.sourceText, 'second sentence');
  });
  test('a pending birth and queued edit cannot resurrect a deleted row', () async {
    final persistence = _HeldBirth();
    final store = newTestStore(persistence: persistence);
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'pending',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'original');
    store.delete(row.id);
    store.applyEdit(row.id, 'edited while deletion is pending');
    persistence.gate.complete();
    await pumpEventQueue();
    expect(store.findById(row.id), isNull);
    expect(await persistence.loadAll(), isEmpty);
  });
  for (final bool cloud in <bool>[false, true]) {
    test('${cloud ? 'cloud' : 'import'} failed write raises local notice', () async {
      final persistence = _Fails();
      final store = newTestStore(persistence: persistence);
      addTearDown(store.dispose);
      final row = TimelineEntry.fromJson(<String, Object?>{
        'id': 'external', 'client_id': 'external', 'mode': 'realtime',
        'delivery': 'none', 'source_text': 'original sentence',
        'output_text': 'original sentence', 'status': 'noted',
        'created_at': '2026-10-01T00:00:00Z', 'updated_at': '2026-10-01T00:00:00Z',
      })!;
      final bridge = BlindStoreTimelineBridge(persistence: persistence,
        reaper: newTestReaper(persistence: persistence), store: store,
        reload: store.load);
      final sink = TimelineImportSink(persistence: persistence, store: store);
      final write = cloud ? bridge.upsertFromCloud : sink.insert;
      persistence.fail = true;
      await expectLater(write(row), throwsStateError);
      expect((cloud ? store.recoveryFailures : store.writeFailures).noticeTicket, isNotNull);
      expect(await persistence.loadAll(), isEmpty);
      persistence.fail = false;
      await write(row);
      expect((cloud ? store.recoveryFailures : store.writeFailures).entryIds, isEmpty);
      expect((await persistence.loadAll()).single.sourceText, row.sourceText);
      final changed = Map<String, Object?>.from(row.toJson())
        ..['source_text'] = 'replacement sentence';
      await expectLater(write(TimelineEntry.fromJson(changed)!), throwsStateError);
      expect((await persistence.loadAll()).single.sourceText, 'original sentence');
      if (cloud) {
        final newer = row.copyWith(outputText: 'newer local edit', updatedAt: DateTime.utc(2027));
        await persistence.upsert(newer);
        await write(row);
        expect((await persistence.loadAll()).single.outputText, 'newer local edit',
          reason: 'a delayed cloud retry cannot overwrite a newer local edit');
      }
    });
  }
}
