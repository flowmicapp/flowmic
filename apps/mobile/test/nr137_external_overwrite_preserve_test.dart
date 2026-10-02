// NR-137 round 7 (final review, open item a) — AN EXTERNAL OVERWRITE KEEPS
// THE UNREADABLE BYTES FIRST, ON BOTH BACKENDS.
//
// SPEC-REF:
//   lib/src/timeline/timeline_corrupt_archive.dart (`archiveCorruptTimelineRow`)
//   lib/src/timeline/timeline_persistence.dart (`_writeRowPreserving`)
//
// Final review of `c1dc426e` (`_dispatch/2026-10-02-nr137-r6-review.md.out`):
// cloud and import writes treated an undecodable same-id row as absent and
// replaced its bytes — measured on both backends and all four routes. `main`
// had meanwhile landed the preservation (`4db84e70`, "preserve corrupt
// timeline bytes before replacement"); this file pins it for exactly the
// reviewer's routes: the valid record lands, the replaced bytes are kept
// verbatim and once (a replay of the same write adds nothing), nothing shows
// them, and the one diagnostic line carries no text.
//
// REVERSE CONTROL (2026-10-02): preservation disabled in both backends
// (the archive call and the fallback's side copy skipped) ⇒ all eight red on
// the kept-bytes assertion; restored ⇒ green. See the round-7 report.

import 'dart:convert';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/portable/timeline_import_sink.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_corrupt_archive.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/di.dart';

/// The fallback's side copy (`_writeRowPreserving`): the JSON encoding of
/// the replaced value, under the row id plus a digest.
const String _keptPrefix = 'flowmic.timeline.corrupt.v1.';
String _rowKey(String id) =>
    'flowmic.timeline.pending.v3.${Uri.encodeComponent(id)}';

Future<SharedPreferences> _prefs() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return SharedPreferences.getInstance();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  group('external overwrite keeps the undecodable bytes', () {
    for (final bool sql in <bool>[true, false]) {
      for (final String route in <String>[
        'cloud-single',
        'cloud-batch',
        'import-single',
        'import-batch',
      ]) {
        test('${sql ? 'SQLite' : 'SharedPrefs'} $route', () async {
          final SharedPreferences prefs = await _prefs();
          Database? db;
          final TimelinePersistence p;
          if (sql) {
            await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
            final TimelineStorageOpen opened = await openTimelinePersistence(
                prefs: prefs,
                factory: databaseFactoryFfi,
                path: inMemoryDatabasePath);
            expect(opened.kind, TimelineStorageKind.sqlite);
            p = opened.persistence;
            db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
            addTearDown((p as SqfliteTimelinePersistence).close);
          } else {
            p = SharedPrefsTimelinePersistence(prefs);
          }
          final TimelineStore store = newTestStore(persistence: p);
          addTearDown(store.dispose);
          final TimelineEntry old = TimelineEntry(
              id: 'same-id',
              clientId: 'same-client',
              mode: FlowMode.realtime,
              delivery: Delivery.none,
              sourceText: 'Original text unique to this row',
              outputText: 'Latest local edit',
              edited: true,
              status: EntryStatus.noted,
              origin: 'cloud',
              createdAt: DateTime.utc(2026, 10, 1),
              updatedAt: DateTime.utc(2026, 10, 2));
          await p.upsert(old);
          final String bad = jsonEncode(Map<String, Object?>.from(old.toJson())
            ..['duration_ms'] = 'undecodable-duration');
          expect(decodeTimelineRow(bad), isNull);
          Future<void> corrupt() async {
            if (sql) {
              await db!.update(kTimelineTable, <String, Object?>{'payload': bad},
                  where: 'id = ?', whereArgs: <Object?>[old.id]);
            } else {
              await prefs.setString(_rowKey(old.id), bad);
            }
          }

          /// The replaced bytes as each backend keeps them, decoded back to
          /// the stored text so both can be compared with [bad].
          Future<List<Object?>> kept() async {
            if (sql) {
              final List<Map<String, Object?>> t = await db!.query(
                  'sqlite_master',
                  where: 'name = ?',
                  whereArgs: <Object?>[kTimelineCorruptArchiveTable]);
              if (t.isEmpty) return <Object?>[];
              return <Object?>[
                for (final Map<String, Object?> r
                    in await db.query(kTimelineCorruptArchiveTable))
                  utf8.decode(r['payload']! as List<int>),
              ];
            }
            return <Object?>[
              for (final String k in prefs.getKeys())
                if (k.startsWith('$_keptPrefix${Uri.encodeComponent(old.id)}.'))
                  jsonDecode(prefs.getString(k)!),
            ];
          }

          final TimelineEntry incoming = TimelineEntry.fromJson(
              Map<String, Object?>.from(old.toJson())
                ..['source_text'] = 'Different incoming original'
                ..['output_text'] = 'Incoming text'
                ..['edited'] = false
                ..['updated_at'] = '2026-10-01T00:00:00.000Z')!;
          final TimelineImportSink sink =
              TimelineImportSink(persistence: p, store: store);
          final BlindStoreTimelineBridge bridge = BlindStoreTimelineBridge(
              persistence: p,
              reaper: newTestReaper(persistence: p),
              store: store,
              reload: store.load);
          Future<void> write() async {
            switch (route) {
              case 'cloud-single':
                await bridge.upsertFromCloud(incoming);
              case 'cloud-batch':
                await bridge.upsertBatchFromCloud(<TimelineEntry>[incoming]);
              case 'import-single':
                await sink.insert(incoming);
              case 'import-batch':
                await sink.insertBatch(<TimelineEntry>[incoming]);
            }
          }

          DiagLog.instance.clear();
          await corrupt();
          await write();
          // The valid record lands (the repair is allowed) …
          expect((await p.loadById(old.id))?.sourceText, incoming.sourceText);
          // … and the bytes it replaced are kept, verbatim, once.
          expect(await kept(), <Object?>[bad]);
          // Replay of the same write: nothing more is kept.
          await write();
          expect(await kept(), <Object?>[bad]);
          // Never shown: the readers list only the record that landed.
          expect((await p.loadAll()).map((TimelineEntry e) => e.id),
              <String>[old.id]);
          // One diagnostic line, naming the row and carrying no text.
          final List<String> lines = <String>[
            for (final String l in DiagLog.instance.snapshot())
              if (l.contains('timeline.corrupt_row_replaced')) l,
          ];
          expect(lines, hasLength(1));
          expect(lines.single, contains(old.id));
          for (final String text in <String>[
            'Original text',
            'Latest local edit',
            'Different incoming',
            'Incoming text',
          ]) {
            expect(lines.single, isNot(contains(text)));
          }
        });
      }
    }
  });
}
