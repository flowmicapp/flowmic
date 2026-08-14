// Card E-CL — the local ledger on a REAL database, and the atomic delete.
//
// 🔴 The assertion this file exists for is design §4.1's
// "write in the same transaction that deletes the local row (must not 'delete then mark' — a crash in between is a permanent missed delete)".
// Both orderings without a transaction are broken and in opposite directions:
// delete-then-mark orphans the cloud copy forever with nothing remembering it;
// mark-then-delete tombstones a row the user can still see, and the uploader
// would put it back. The proof below is a transaction that FAILS half way: if
// the two writes were independent, the marker would survive the failed row
// delete. It must not.

import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

TimelineEntry _entry({String id = 'loc_dev_e1', String origin = 'cloud'}) =>
    TimelineEntry.fromJson(<String, Object?>{
      'id': id,
      'client_id': id,
      'origin': origin,
      'output_text': 'a light record',
      'status': 'noted',
      'created_at': '2026-08-08T01:02:03.000Z',
      'updated_at': '2026-08-08T01:02:03.000Z',
    })!;

Future<TimelineStorageOpen> _open() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
  return openTimelinePersistence(
    prefs: prefs,
    factory: databaseFactoryFfi,
    path: inMemoryDatabasePath,
  );
}

void main() {
  setUpAll(sqfliteFfiInit);

  test('v6 gives the blind store a table, and the open hands it back', () async {
    final TimelineStorageOpen s = await _open();
    expect(s.kind, TimelineStorageKind.sqlite);
    expect(s.cloudState, isNotNull);
    // Empty, not absent — a fresh install owes nothing and holds nothing.
    expect(await s.cloudState!.pushedHashes(), isEmpty);
    expect(await s.cloudState!.pendingDeletes(), isEmpty);
  });

  test('a pushed fingerprint survives and can be forgotten', () async {
    final TimelineStorageOpen s = await _open();
    final SqfliteBlindStoreCloudStateStore state = s.cloudState!;

    await state.markPushed(entryId: 'e1', payloadHash: 'hash-1');
    expect(await state.pushedHashes(), <String, String>{'e1': 'hash-1'});

    // An edit overwrites rather than accumulating.
    await state.markPushed(entryId: 'e1', payloadHash: 'hash-2');
    expect(await state.pushedHashes(), <String, String>{'e1': 'hash-2'});

    await state.forget(<String>['e1']);
    expect(await state.pushedHashes(), isEmpty);
  });

  group('the atomic delete', () {
    test('a pushed row: the timeline row goes AND the debt is recorded', () async {
      final TimelineStorageOpen s = await _open();
      final SqfliteBlindStoreCloudStateStore state = s.cloudState!;
      await s.persistence.upsert(_entry());
      await state.markPushed(entryId: 'loc_dev_e1', payloadHash: 'h');

      final bool queued = await state.deleteRowAndQueueTombstone(
        'loc_dev_e1',
        nowMs: 1000,
      );

      expect(queued, isTrue);
      expect(await s.persistence.loadAll(), isEmpty);
      expect(await state.pendingDeletes(), <String>['loc_dev_e1']);
      // 🔴 It is no longer 「pushed」 — one row, one state. A row that was both
      // would let the uploader re-push what the user just deleted.
      expect(await state.pushedHashes(), isEmpty);
    });

    test('a row the cloud never had queues NOTHING but still deletes', () async {
      final TimelineStorageOpen s = await _open();
      final SqfliteBlindStoreCloudStateStore state = s.cloudState!;
      await s.persistence.upsert(_entry());

      final bool queued = await state.deleteRowAndQueueTombstone(
        'loc_dev_e1',
        nowMs: 1000,
      );

      // A tombstone for an id the server never held can only ever answer
      // 「0 rows affected」 — a round trip bought for nothing.
      expect(queued, isFalse);
      expect(await state.pendingDeletes(), isEmpty);
      expect(await s.persistence.loadAll(), isEmpty);
    });

    test('🔴 when the row delete fails, the debt marker is rolled back', () async {
      // The half-way crash, made reproducible: point the deleter at a table that
      // does not exist, so the SECOND statement in the transaction throws after
      // the marker was written. If these were two independent writes, the marker
      // would be left behind and the cloud copy would be deleted while the row
      // is still on screen.
      final TimelineStorageOpen s = await _open();
      await s.persistence.upsert(_entry());
      await s.cloudState!.markPushed(entryId: 'loc_dev_e1', payloadHash: 'h');

      final SqfliteBlindStoreCloudStateStore broken =
          SqfliteBlindStoreCloudStateStore(
            s.cloudState!.rawDatabaseForTest,
            timelineTable: 'no_such_table',
          );

      await expectLater(
        () => broken.deleteRowAndQueueTombstone('loc_dev_e1', nowMs: 1000),
        throwsA(anything),
      );

      // Neither half landed.
      expect(await s.cloudState!.pendingDeletes(), isEmpty);
      expect(await s.persistence.loadAll(), hasLength(1));
      expect(await s.cloudState!.pushedHashes(), <String, String>{
        'loc_dev_e1': 'h',
      });
    });
  });

  group('the one deleter carries the cloud debt', () {
    TimelineReaper reaper(TimelineStorageOpen s, {bool wired = true}) =>
        TimelineReaper(
          persistence: s.persistence,
          images: InMemoryOutboxBlobStore(),
          vault: InMemoryUnknownFieldVault(),
          cutoffs: InMemoryCutoffStore(),
          cloudDeleter: wired ? s.cloudState : null,
        );

    test('a user delete of a pushed row leaves a pending tombstone', () async {
      final TimelineStorageOpen s = await _open();
      final TimelineEntry e = _entry();
      await s.persistence.upsert(e);
      await s.cloudState!.markPushed(entryId: e.id, payloadHash: 'h');

      final ReapResult r = await reaper(s).reap(<TimelineEntry>[e]);

      expect(r.rows, 1);
      expect(await s.persistence.loadAll(), isEmpty);
      expect(await s.cloudState!.pendingDeletes(), <String>[e.id]);
    });

    test('🔴 applying a REMOTE tombstone does not queue one back', () async {
      // Otherwise a delete bounces between two devices forever.
      final TimelineStorageOpen s = await _open();
      final TimelineEntry e = _entry();
      await s.persistence.upsert(e);
      await s.cloudState!.markPushed(entryId: e.id, payloadHash: 'h');

      await reaper(s).reap(<TimelineEntry>[e], queueCloudTombstones: false);

      expect(await s.persistence.loadAll(), isEmpty);
      expect(await s.cloudState!.pendingDeletes(), isEmpty);
    });

    test('without a cloud deleter, deletion is exactly what it always was', () async {
      // The fallback store's state: no ledger, so no debt is recorded — and the
      // row still disappears. This is the pre-E-CL behaviour, unchanged.
      final TimelineStorageOpen s = await _open();
      final TimelineEntry e = _entry();
      await s.persistence.upsert(e);
      await s.cloudState!.markPushed(entryId: e.id, payloadHash: 'h');

      await reaper(s, wired: false).reap(<TimelineEntry>[e]);

      expect(await s.persistence.loadAll(), isEmpty);
      expect(await s.cloudState!.pendingDeletes(), isEmpty);
    });
  });

  test('the pending set is ordered oldest-first', () async {
    // A bounded drain must make progress on the oldest debt rather than starving
    // it behind whatever was deleted most recently.
    final TimelineStorageOpen s = await _open();
    final SqfliteBlindStoreCloudStateStore state = s.cloudState!;
    for (final (String id, int at) in <(String, int)>[
      ('c', 3000),
      ('a', 1000),
      ('b', 2000),
    ]) {
      await s.persistence.upsert(_entry(id: id));
      await state.markPushed(entryId: id, payloadHash: 'h');
      await state.deleteRowAndQueueTombstone(id, nowMs: at);
    }
    expect(await state.pendingDeletes(), <String>['a', 'b', 'c']);
  });
}
