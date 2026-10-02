// Reverse control: disable the batch and keyed read, restoring per-row loadAll.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/portable/fpr_archive.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/portable/portable_import.dart';
import 'package:flowmic/src/portable/timeline_import_sink.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'support/di.dart';
import 'support/portable_fakes.dart';
import 'support/temp_teardown.dart';

TimelineEntry row(String id) => TimelineEntry.fromJson({
  'id': id,
  'client_id': id,
  'mode': 'realtime',
  'delivery': 'none',
  'source_text': 'performance fixture',
  'output_text': 'performance fixture',
  'status': 'noted',
  'created_at': '2026-10-01T00:00:00Z',
  'updated_at': '2026-10-01T00:00:00Z',
})!;

class _MeasuredPersistence extends SqfliteTimelinePersistence {
  _MeasuredPersistence(super.db);
  int batchSnapshots = 0;
  int fullReads = 0;
  int keyedReads = 0;
  @override
  Future<List<TimelineEntry>> loadAll() {
    fullReads++;
    return super.loadAll();
  }

  @override
  Future<TimelineEntry?> readRecord(String id) {
    keyedReads++;
    return super.readRecord(id);
  }

  @override
  Future<void> writeRecordBatch(TimelineBatchAction action) {
    batchSnapshots++;
    return super.writeRecordBatch(action);
  }
}

void main() {
  setUpAll(sqfliteFfiInit);
  test(
    '500-row FPR import into 5000 notes stays close to the direct-write baseline',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final tmp = await Directory.systemTemp.createTemp('nr146-perf-');
      addTearDown(() => removeTempDir(tmp));
      final path = '${tmp.path}/timeline.db';
      final opened = await openTimelinePersistence(
        prefs: prefs,
        factory: databaseFactoryFfi,
        path: path,
      );
      await (opened.persistence as SqfliteTimelinePersistence).close();
      final db = await databaseFactoryFfi.openDatabase(path);
      final p = _MeasuredPersistence(db);
      addTearDown(p.close);
      final history = List.generate(5000, (i) => row('history-$i'));
      await p.saveAll(history);
      final incoming = List.generate(500, (i) => row('import-$i'));
      final baseline = Stopwatch()..start();
      for (final entry in incoming) {
        await p.upsert(entry);
      }
      baseline.stop();
      await p.saveAll(history);
      final records = File('${tmp.path}/records.jsonl');
      await records.writeAsString(
        [
          jsonEncode({
            'fpr': 1,
            'kind': 'header',
            'source': {'end': 'mobile'},
            'count': 500,
            'has_attachments': false,
          }),
          ...incoming.map(
            (entry) => jsonEncode(fprRecordOfRow(entry).toJson()),
          ),
        ].join('\n'),
      );
      final zip = '${tmp.path}/import.zip';
      final writer = FprArchiveWriter(zip)..open();
      await writer.addRecords(records.path);
      await writer.close();
      final store = newTestStore(persistence: p);
      addTearDown(store.dispose);
      final timer = Stopwatch()..start();
      final report = await PortableImporter(
        source: FixedImportSource(zip),
        sink: TimelineImportSink(persistence: p, store: store),
        images: newTestOutboxBlobs(),
        vault: InMemoryUnknownFieldVault(),
        workDir: tmp.path,
      ).run();
      timer.stop();
      final perRowMs = timer.elapsedMicroseconds / 500000;
      // Includes archive preflight, id inventory, transaction, and UI refresh.
      // 27 ms/row is a generous 3x the review's 9 ms direct-write baseline.
      debugPrint(
        'NR146 PERF baseline_ms=${baseline.elapsedMilliseconds} '
        'baseline_per_row_ms=${baseline.elapsedMicroseconds / 500000} '
        'import_ms=${timer.elapsedMilliseconds} import_per_row_ms=$perRowMs bound_ms=27',
      );
      expect(report.fileRefusal, isNull);
      expect(report.added, 500);
      expect(
        perRowMs,
        lessThan(27),
        reason: '500 rows must stay within 3x the 9 ms baseline',
      );
      expect(p.batchSnapshots, 1);
      expect(
        p.fullReads,
        1,
        reason: 'inventory once; transaction owns the other snapshot',
      );
      expect(p.keyedReads, 0, reason: 'the batch index replaces per-row reads');
      expect(await p.loadAll(), hasLength(5500));
      final again = await PortableImporter(
        source: FixedImportSource(zip),
        sink: TimelineImportSink(persistence: p, store: store),
        images: newTestOutboxBlobs(),
        vault: InMemoryUnknownFieldVault(),
        workDir: tmp.path,
      ).run();
      expect(again.added, 0);
      expect(again.skippedExisting, 500);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'batch preserves source_text, newer edits, tombstones and rolls back refused writes',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final tmp = await Directory.systemTemp.createTemp('nr146-batch-');
      addTearDown(() => removeTempDir(tmp));
      final path = '${tmp.path}/timeline.db';
      final opened = await openTimelinePersistence(
        prefs: prefs,
        factory: databaseFactoryFfi,
        path: path,
      );
      final p = opened.persistence as SqfliteTimelinePersistence;
      addTearDown(p.close);
      final store = newTestStore(persistence: p);
      addTearDown(store.dispose);
      final original = row('existing');
      await p.upsert(
        original.copyWith(
          outputText: 'newer edit',
          updatedAt: DateTime.utc(2027),
        ),
      );
      await store.saveExternalRecords([original], recovery: true);
      expect((await p.loadById(original.id))!.outputText, 'newer edit');
      final conflict = TimelineEntry.fromJson({
        ...original.toJson(),
        'source_text': 'changed',
      })!;
      await expectLater(
        store.saveExternalRecords([
          row('rolled-back'),
          conflict,
        ], recovery: true),
        throwsA(isA<TimelineRecordRejected>()),
      );
      expect(await p.loadById('rolled-back'), isNull);
      await p.upsert(original.copyWith(deleted: true));
      await store.saveExternalRecords([original]);
      expect((await p.loadById(original.id))!.deleted, isTrue);
      final db = await databaseFactoryFfi.openDatabase(path);
      await db.execute(
        "CREATE TRIGGER refuse_batch BEFORE INSERT ON $kTimelineTable "
        "WHEN NEW.id = 'refused' BEGIN SELECT RAISE(ABORT, 'forced refusal'); END",
      );
      await expectLater(
        store.saveExternalRecords([
          row('also-rolled-back'),
          row('refused'),
        ], recovery: true),
        throwsA(isA<TimelineLocalStorageError>()),
      );
      expect(await p.loadById('also-rolled-back'), isNull);
      expect(store.recoveryFailures.entryIds, contains('refused'));
    },
  );
}
