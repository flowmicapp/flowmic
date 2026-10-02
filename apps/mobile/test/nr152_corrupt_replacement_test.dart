import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/portable/timeline_import_sink.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_corrupt_archive.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'support/di.dart';
import 'support/temp_teardown.dart';

TimelineEntry incoming(String id) => TimelineEntry.fromJson({
  'id': id,
  'client_id': id,
  'mode': 'realtime',
  'delivery': 'none',
  'source_text': 'NEW_PRIVATE_TEXT',
  'output_text': 'NEW_PRIVATE_TEXT',
  'status': 'noted',
  'created_at': '2026-10-01T00:00:00Z',
  'updated_at': '2026-10-01T00:00:00Z',
})!;
const corrupt = '{BROKEN_PRIVATE_BYTES:\u0000\u00ff';

void main() {
  setUpAll(sqfliteFfiInit);
  for (final ingress in ['import', 'cloud', 'single']) {
    test(
      'SQLite $ingress archives corrupt bytes before the new row lands',
      () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final tmp = await Directory.systemTemp.createTemp('nr152-');
        addTearDown(() => removeTempDir(tmp));
        final path = '${tmp.path}/timeline.db';
        final opened = await openTimelinePersistence(
          prefs: prefs,
          factory: databaseFactoryFfi,
          path: path,
        );
        final persistence = opened.persistence as SqfliteTimelinePersistence;
        addTearDown(persistence.close);
        final raw = await databaseFactoryFfi.openDatabase(path);
        final row = incoming('collision');
        await persistence.upsert(row);
        await raw.update(
          kTimelineTable,
          {'payload': corrupt},
          where: 'id = ?',
          whereArgs: [row.id],
        );
        final original = (await raw.query(kTimelineTable)).single;
        final store = newTestStore(persistence: persistence);
        addTearDown(store.dispose);
        DiagLog.instance.clear();
        if (ingress == 'import') {
          await TimelineImportSink(
            persistence: persistence,
            store: store,
          ).insertBatch([row]);
        } else if (ingress == 'cloud') {
          await BlindStoreTimelineBridge(
            persistence: persistence,
            store: store,
            reaper: newTestReaper(persistence: persistence),
            reload: store.load,
          ).upsertBatchFromCloud([row]);
        } else {
          await persistence.upsert(row);
        }
        expect(
          (await persistence.loadById(row.id))!.sourceText,
          row.sourceText,
        );
        expect(
          await raw.rawQuery(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            [kTimelineCorruptArchiveTable],
          ),
          isNotEmpty,
          reason: 'the preserved corrupt bytes have a durable side record',
        );
        final archive = (await raw.query(kTimelineCorruptArchiveTable)).single;
        expect(archive['payload'], orderedEquals(utf8.encode(corrupt)));
        expect(jsonDecode(archive['original_row']! as String), original);
        final diagnostics = DiagLog.instance
            .snapshot()
            .where((line) => line.contains('corrupt_row_replaced'))
            .toList();
        expect(diagnostics, hasLength(1));
        expect(diagnostics.single, endsWith('row_id=collision'));
        expect(diagnostics.join(), isNot(contains('PRIVATE')));
        await persistence.upsert(row);
        expect(await raw.query(kTimelineCorruptArchiveTable), hasLength(1));
        if (ingress == 'single') {
          final refused = incoming('rollback');
          await persistence.upsert(refused);
          await raw.update(
            kTimelineTable,
            {'payload': corrupt},
            where: 'id = ?',
            whereArgs: [refused.id],
          );
          await raw.execute(
            "CREATE TRIGGER refuse_replacement BEFORE INSERT ON $kTimelineTable "
            "WHEN NEW.id = 'rollback' BEGIN SELECT RAISE(ABORT, 'test refusal'); END",
          );
          DiagLog.instance.clear();
          await expectLater(
            persistence.upsert(refused),
            throwsA(isA<DatabaseException>()),
          );
          expect(
            (await raw.query(
              kTimelineTable,
              where: 'id = ?',
              whereArgs: [refused.id],
            )).single['payload'],
            corrupt,
          );
          expect(
            await raw.query(kTimelineCorruptArchiveTable),
            hasLength(1),
            reason: 'the archive and replacement rolled back together',
          );
          expect(
            DiagLog.instance.snapshot().where(
              (line) => line.contains('corrupt_row_replaced'),
            ),
            isEmpty,
          );
          final opaque = Uint8List.fromList([0, 255, 195, 40, 128, 123]);
          final blobRow = incoming('blob');
          await persistence.upsert(blobRow);
          await raw.update(
            kTimelineTable,
            {'payload': opaque},
            where: 'id = ?',
            whereArgs: [blobRow.id],
          );
          await persistence.upsert(blobRow);
          expect(
            (await raw.query(
              kTimelineCorruptArchiveTable,
              where: 'row_id = ?',
              whereArgs: [blobRow.id],
            )).single['payload'],
            orderedEquals(opaque),
            reason: 'opaque bytes are copied inside SQLite',
          );
        }
      },
    );
  }
  test(
    'fallback preserves corrupt bytes across replacement and reopen',
    () async {
      SharedPreferences.setMockInitialValues({
        'flowmic.timeline.pending.v3.collision': corrupt,
      });
      final prefs = await SharedPreferences.getInstance();
      final persistence = SharedPrefsTimelinePersistence(prefs);
      final store = newTestStore(persistence: persistence);
      addTearDown(store.dispose);
      DiagLog.instance.clear();
      await TimelineImportSink(
        persistence: persistence,
        store: store,
      ).insertBatch([incoming('collision')]);
      await prefs.reload();
      final keys = prefs
          .getKeys()
          .where((key) => key.startsWith('flowmic.timeline.corrupt.v1.'))
          .toList();
      expect(keys, hasLength(1));
      expect(jsonDecode(prefs.getString(keys.single)!), corrupt);
      expect(
        (await SharedPrefsTimelinePersistence(
          prefs,
        ).loadById('collision'))!.sourceText,
        'NEW_PRIVATE_TEXT',
      );
      expect(
        DiagLog.instance
            .snapshot()
            .where((line) => line.contains('corrupt_row_replaced'))
            .single,
        endsWith('row_id=collision'),
      );
    },
  );
}
