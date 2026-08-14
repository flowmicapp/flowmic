// card G-9 (2026-08-07) — the REAL-SQL group for outbox_test.dart.
//
// 🔴 MOVED VERBATIM, same discipline and same reason as outbox_test_harness.dart
// (read that file's header first): a `part`, not a shared support library, so
// every private symbol the block uses stays private and NOTHING was renamed.
// The only edits are this header, the `part of`, and the one wrapper function —
// `group()` has to be called from inside `main()`, so a moved group becomes a
// function that `main()` calls. Byte-for-byte otherwise.
//
// The cut is the 1200-line test cap (verify/lint/file-size.mjs); outbox_test.dart
// stood at 1194 and card G-9 needed six more lines. 🔴 IT WAS SPLIT RATHER THAN
// SQUEEZED ON PURPOSE: trimming a comment to land on 1199 buys one card and hands
// the next person the same wall, which is how a cap turns into pressure to write
// less of the reasoning that makes these tests worth having.
//
// The BOUNDARY is a real seam, not a line-count convenience: everything here asks
// "is this table's SQL correct" (DDL, migration, round-trip through sqflite_common_ffi on
// the host VM), while everything left behind asks "what did the queue promise the user". They are
// read at different times and they fail for different reasons.

part of 'outbox_test.dart';

/// The moved group. Called from `main()` in outbox_test.dart — that call IS the
/// wiring; delete it and 10 real-SQL cases stop running while every remaining
/// test stays green, so it is named after the group it carries.
void _sqliteRealSqlGroup() {
  // ══════════════════════════════════════════════════════════════════════════
  // These run the REAL SQL on the host VM (sqflite_common_ffi), not a fake that
  // would agree with whatever DDL I wrote — including invalid DDL (13 册 §7 F1 ③).
  group('sqlite — real SQL on a real database; v1→v2 is a purely additive migration', () {
    setUpAll(sqfliteFfiInit);
    setUp(() async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
    });

    test('fresh install: both tables are created, an outbox row round-trips', () async {
      final TimelineStorageOpen open = await openTimelinePersistence(
        prefs: await SharedPreferences.getInstance(),
        factory: databaseFactoryFfi,
        path: inMemoryDatabasePath,
      );
      expect(open.kind, TimelineStorageKind.sqlite);

      final Database db = await databaseFactoryFfi.openDatabase(
        inMemoryDatabasePath,
        options: OpenDatabaseOptions(version: kTimelineDbVersion),
      );
      final SqfliteOutboxStore store = SqfliteOutboxStore(db);
      final OutboxItem item = OutboxItem(
        requestId: 'sql-1',
        entryId: 'loc_sql-1',
        // A buffered multi-row send: this delivery did NOT build the rows it
        // covers, so nothing may be stamped on the wire. Null is the VALUE here,
        // not an omission — see the assertion below.
        wireEntryId: null,
        coveredEntryIds: const <String>['loc_sql-1', 'loc_sql-2'],
        kind: OutboxPayloadKind.image,
        source: 'image',
        text: '',
        mode: 'organize',
        createdAt: kSpokenAt,
        enqueuedAt: kSpokenAt,
        destinationMachineUid: kMachineA,
        destinationPairingIdentity: kPairALan,
        enqueuedPcId: kPcALan,
        entryType: 'image',
        thumbB64: 'dGh1bWI=',
        imagePath: '/tmp/x.png',
        imageMime: 'image/png',
        deviceLabel: 'Pixel',
      );
      await store.upsert(item);

      final OutboxItem back = (await store.findByRequestId('sql-1'))!;
      // Every field the drain depends on has to survive the round trip — a
      // column that silently drops is how a queued delivery loses its address.
      expect(back.destinationMachineUid, kMachineA);
      expect(back.destinationPairingIdentity, kPairALan);
      expect(back.enqueuedPcId, kPcALan);
      expect(back.createdAt, kSpokenAt);
      expect(back.kind, OutboxPayloadKind.image);
      expect(back.imagePath, '/tmp/x.png');
      // The N-row list survives the comma-joined round trip (RV-15: one ➤ can
      // settle several rows, and dropping the rest is the bug that field exists
      // to prevent).
      expect(back.coveredEntryIds, <String>['loc_sql-1', 'loc_sql-2']);
      // 🔴 wire_entry_id is a REAL column (this insert would throw if it were
      // missing from the DDL) and a null survives as a null — "this frame
      // does not stamp entry_id" must not come back from disk as "stamp loc_sql-1".
      expect(back.wireEntryId, isNull);
      expect(back.entryId, 'loc_sql-1', reason: 'the settle anchor is untouched');
      expect(back.state, OutboxDeliveryState.queued);
      expect((await store.loadPending()).length, 1);

      // And the non-null case round-trips as ITSELF, not as the anchor.
      await store.upsert(
        OutboxItem(
          requestId: 'sql-2',
          entryId: 'loc_sql-9',
          wireEntryId: 'loc_sql-9',
          coveredEntryIds: const <String>['loc_sql-9'],
          kind: OutboxPayloadKind.text,
          source: 'manual',
          text: 'typed',
          mode: 'realtime',
          createdAt: kSpokenAt,
          enqueuedAt: kSpokenAt,
          destinationMachineUid: kMachineA,
          destinationPairingIdentity: kPairALan,
          enqueuedPcId: kPcALan,
        ),
      );
      expect((await store.findByRequestId('sql-2'))!.wireEntryId, 'loc_sql-9');
      await db.close();
    });

    test('🔴 a v1 legacy database upgraded to v2: the outbox table is added, not one timeline row is lost', () async {
      // A REAL FILE, not inMemoryDatabasePath: in-memory dies at close(), so
      // there would be no v1 database left to upgrade — a test of nothing.
      final Directory tmp = await Directory.systemTemp.createTemp('fm_outbox');
      final String path = '${tmp.path}/migrate.db';
      // Build a genuine v1 database: the timeline table ONLY, at version 1.
      final Database v1 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(version: 1,
          onCreate: (Database d, int _) async {
            await d.execute('''
              CREATE TABLE $kTimelineTable (
                id                    TEXT    PRIMARY KEY,
                created_at            INTEGER NOT NULL,
                updated_at            INTEGER NOT NULL,
                client_id             TEXT    NOT NULL,
                mode                  TEXT    NOT NULL,
                status                TEXT    NOT NULL,
                entry_type            TEXT    NOT NULL,
                spoken_to_instance_id TEXT,
                deleted               INTEGER NOT NULL DEFAULT 0,
                search_text           TEXT    NOT NULL DEFAULT '',
                payload               TEXT    NOT NULL
              )
            ''');
          },
        ),
      );
      await v1.insert(kTimelineTable, <String, Object?>{
        'id': 'loc_old_1',
        'created_at': kSpokenAt.millisecondsSinceEpoch,
        'updated_at': kSpokenAt.millisecondsSinceEpoch,
        'client_id': 'old-1',
        'mode': 'realtime',
        'status': 'noted',
        'entry_type': 'transcript',
        'deleted': 0,
        'search_text': 'legacy row',
        'payload': '{"id":"loc_old_1"}',
      });
      await v1.close();

      // Now open it the way production does — this runs the real onUpgrade.
      final Database v2 = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: kTimelineDbVersion,
          onCreate: (Database d, int _) async =>
              fail('the v1 database already existed; onCreate must not run'),
          onUpgrade: (Database d, int from, int to) async {
            expect((from, to), (1, kTimelineDbVersion), reason: 'the upgrade must walk all the way to the current version');
            // Mirrors production's range loop — v2 table, v3 duration_ms.
            for (int v = from + 1; v <= to; v++) {
              if (v == 2) {
                await d.execute('''
                  CREATE TABLE IF NOT EXISTS $kOutboxTable (
                    request_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL,
                    covered_entry_ids TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
                    source TEXT NOT NULL, text TEXT NOT NULL, mode TEXT NOT NULL,
                    created_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
                    dest_machine_uid TEXT, dest_pairing_identity TEXT, enqueued_pc_id TEXT,
                    source_text TEXT, entry_type TEXT, thumb_b64 TEXT, image_path TEXT,
                    image_mime TEXT, device_label TEXT, delivery_state TEXT NOT NULL,
                    refused_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
                    last_attempt_at INTEGER, last_refusal_note TEXT
                  )
                ''');
              }
              if (v == 3) await d.execute('ALTER TABLE $kOutboxTable ADD COLUMN duration_ms INTEGER');
            }
          },
        ),
      );
      // 🔴 ADDITIVE: legacy row untouched; new table usable incl. v3 duration_ms.
      final List<Map<String, Object?>> rows = await v2.query(kTimelineTable);
      expect(rows.length, 1);
      expect(rows.single['client_id'], 'old-1');
      final SqfliteOutboxStore store = SqfliteOutboxStore(v2);
      expect((await store.loadPending()).length, 0);
      final List<Map<String, Object?>> cols = await v2.rawQuery('PRAGMA table_info($kOutboxTable)');
      expect(cols.any((Map<String, Object?> c) => c['name'] == 'duration_ms'), isTrue);
      await v2.close();
      await tmp.delete(recursive: true);
    });
  });
}
