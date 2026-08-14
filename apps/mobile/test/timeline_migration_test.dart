// D13 (0.3.0) — the MIGRATION contract of flowmic_timeline.db, on real files.
//
// Why this file exists at all: timeline_sqlite.dart's header states two rules
// ("a shipped version step is frozen" / "the create path and the upgrade path
// must converge") and names THIS FILE as what enforces the second one. Until
// now that sentence was a claim about a test that did not exist — the shape of
// façade this repo pays for most often. Everything below is the enforcement.
//
// THE DEFECT D13 ② IS ABOUT. `_createOutboxSchema` used to be `CREATE TABLE IF
// NOT EXISTS` AND double as the v1→v2 upgrade step. window B3-2b then added
// `covered_entry_ids` / `wire_entry_id` by EDITING that statement, with no
// version bump — which is a no-op for every install whose table already
// existed. Those installs are two columns short forever, and since every
// enqueue INSERT names all columns, the whole delivery queue dies with
// "table outbox_items has no column named covered_entry_ids". v4 heals them.
//
// ⚠️ IN-MEMORY IS NOT A RESTART. Every other suite here opens
// `inMemoryDatabasePath`, which cannot answer 「is it still there after a restart」 — the file is the
// process. These tests run on REAL FILES in a temp dir and reopen them, which
// is the only way the persistence claim gets gated (D13 ③).

import 'dart:io';

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/instance_machine_map.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

late Directory _tmp;
int _seq = 0;

String _freshPath() => '${_tmp.path}/db_${_seq++}.db';

Future<TimelineStorageOpen> _open(String path) async =>
    openTimelinePersistence(
      prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi,
      path: path,
    );

/// `PRAGMA table_info` reduced to the five things that decide whether two
/// tables are the same table: name, declared type, NOT NULL, default, pk.
/// Compared as a map so a column ORDER difference (which SQLite does not care
/// about, and which `ALTER TABLE ADD COLUMN` guarantees) is not reported as a
/// schema difference.
Future<Map<String, String>> _shape(Database db, String table) async {
  final List<Map<String, Object?>> cols =
      await db.rawQuery('PRAGMA table_info($table)');
  return <String, String>{
    for (final Map<String, Object?> c in cols)
      c['name']! as String:
          '${c['type']}|notnull=${c['notnull']}|dflt=${c['dflt_value']}|pk=${c['pk']}',
  };
}

Future<Map<String, String>> _indexes(Database db, String table) async {
  final List<Map<String, Object?>> rows = await db.rawQuery(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? "
    'AND sql IS NOT NULL',
    <Object?>[table],
  );
  return <String, String>{
    for (final Map<String, Object?> r in rows)
      r['name']! as String: (r['sql']! as String).replaceAll(RegExp(r'\s+'), ' '),
  };
}

TimelineEntry _entry(String id, {DateTime? at}) {
  final DateTime t = at ?? DateTime.utc(2026, 8, 4, 10);
  return TimelineEntry(
    id: id,
    clientId: id,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: 'said $id',
    outputText: 'said $id',
    status: EntryStatus.noted,
    createdAt: t,
    updatedAt: t,
  );
}

/// An item with EVERY column populated — the point is to exercise the INSERT
/// that a two-columns-short table rejects.
OutboxItem _item(String requestId) => OutboxItem(
  requestId: requestId,
  entryId: 'loc_$requestId',
  coveredEntryIds: <String>['loc_$requestId', 'loc_${requestId}_b'],
  wireEntryId: 'loc_$requestId',
  kind: OutboxPayloadKind.text,
  source: 'manual',
  text: 'hello pc',
  mode: 'realtime',
  createdAt: DateTime.utc(2026, 8, 4, 9),
  enqueuedAt: DateTime.utc(2026, 8, 4, 9, 0, 1),
  destinationMachineUid: 'machine-uid-AAAA',
  destinationPairingIdentity: 'standalone|instance:inst-A',
  enqueuedPcId: 'pc-A-lan',
  durationMs: 1234,
);

/// Card F2 — the two pairings ruling ④ is about: ONE computer, two channels, so the
/// same `pc_machine_uid` and two different `pc_instance_id`s (they must stay
/// different — `connectionIdentity` is keyed on the instance id, and two
/// pairings that collapsed to one identity would be deduped by the storage and
/// one token thrown away; `token_storage.dart:63-73`).
///
/// 🔴 BOTH are `channel: 'standalone'`. Measured at `ptt_session.dart:526`
/// (`entry.payload.cloudInstance ? 'saas' : 'standalone'`): `'saas'` names the
/// virtual cloud-instance solo entry only, never 「reached the PC through the relay」.
const MobileSession _lan = MobileSession(
  token: 'tok-lan',
  endpoint: 'http://100.64.7.179:55889',
  channel: 'standalone',
  pcInstanceId: 'inst-lan',
  pcMachineUid: 'machine-AAAA',
  pcId: 'pc-A-lan',
);
const MobileSession _relay = MobileSession(
  token: 'tok-relay',
  endpoint: 'https://relay.example/ws',
  channel: 'standalone',
  pcInstanceId: 'inst-relay',
  pcMachineUid: 'machine-AAAA',
  pcId: 'pc-A-relay',
);

/// The virtual cloud instance, carrying a uid it has no business carrying. Normally
/// null (`token_storage.dart:72`), so a fixture that left it null would make
/// the seed's `channel == 'saas'` guard untestable — it would be excluded by
/// the blank-uid branch and the guard could be deleted with every test still
/// green.
const MobileSession _cloud = MobileSession(
  token: 'tok-cloud',
  endpoint: 'https://flowmic.app',
  channel: 'saas',
  pcInstanceId: 'inst-cloud',
  pcMachineUid: 'machine-AAAA',
  pcId: 'pc-cloud',
);

/// A second handle on the same file, for PRAGMA-level assertions. Deliberately
/// optionless: adding a version here would make this reader a writer.
Future<Database> _rawOf(String path) => databaseFactoryFfi.openDatabase(path);

void main() {
  setUpAll(sqfliteFfiInit);

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    DiagLog.instance.clear();
    _tmp = await Directory.systemTemp.createTemp('flowmic_migration_');
  });

  tearDown(() async {
    try {
      await _tmp.delete(recursive: true);
    } on FileSystemException {
      // Windows can hold a just-closed db file for a moment; a leftover temp
      // dir is not worth failing a migration assertion over.
    }
  });

  group('D13 ② — the create path and the upgrade path must converge', () {
    test('🔴 fresh CREATE == v1 → latest stepwise UPGRADE, column for column, '
        'both tables', () async {
      // ① The database a NEW install gets.
      final String fresh = _freshPath();
      final TimelineStorageOpen created = await _open(fresh);
      expect(created.kind, TimelineStorageKind.sqlite);
      final Database freshDb = await databaseFactoryFfi.openDatabase(fresh);
      final Map<String, String> freshTimeline =
          await _shape(freshDb, kTimelineTable);
      final Map<String, String> freshOutbox =
          await _shape(freshDb, kOutboxTable);
      // Card F2 phase 2 — the THIRD table joins the parity check the day it is added.
      // The create path and the v5 step are two hand-written copies of the same
      // DDL (D13 rule 1 freezes the step, so they cannot be one function), and
      // this is what keeps the two copies honest.
      final Map<String, String> freshMap =
          await _shape(freshDb, kInstanceMachineMapTable);
      expect(freshMap, isNotEmpty,
          reason: 'the create path did not build the map table at all');
      // Card E-CL — the FOURTH table joins on the same terms. Its create path and
      // its v6 step are likewise two hand-written copies of one DDL.
      final Map<String, String> freshCloud =
          await _shape(freshDb, kBlindStoreCloudStateTable);
      expect(freshCloud, isNotEmpty,
          reason: 'the create path did not build the blind-store table at all');
      final Map<String, String> freshIdx = <String, String>{
        ...await _indexes(freshDb, kTimelineTable),
        ...await _indexes(freshDb, kOutboxTable),
        ...await _indexes(freshDb, kInstanceMachineMapTable),
        ...await _indexes(freshDb, kBlindStoreCloudStateTable),
      };
      await freshDb.close();

      // ② The database an install from the FIRST shipped version gets, walked
      // step by step. Built with this file's own v1 DDL (the @visibleForTesting
      // hook) — a hand-copied CREATE here could drift from production and the
      // comparison would then prove nothing.
      final String upgraded = _freshPath();
      final Database v1 = await databaseFactoryFfi.openDatabase(
        upgraded,
        options: OpenDatabaseOptions(
          version: 1,
          onCreate: (Database d, int _) => createTimelineSchemaV1ForTest(d),
        ),
      );
      await v1.close();
      final TimelineStorageOpen walked = await _open(upgraded);
      expect(walked.kind, TimelineStorageKind.sqlite,
          reason: 'the upgrade must not fall back to the 100-row store');
      final Database upDb = await databaseFactoryFfi.openDatabase(upgraded);

      // Positive control: this really was an upgrade, i.e. the outbox table did
      // not exist before and was built by the v2 STEP, not by onCreate.
      expect(await upDb.getVersion(), kTimelineDbVersion);

      expect(await _shape(upDb, kTimelineTable), freshTimeline);
      expect(await _shape(upDb, kOutboxTable), freshOutbox,
          reason: 'a column added to the create statement without a matching '
              '_upgradeVn step is exactly the D13 ② trap — every install that '
              'already had the table stays short of it forever');
      expect(await _shape(upDb, kInstanceMachineMapTable), freshMap,
          reason: 'the v5 step and the create path disagree about the '
              'instance→machine table');
      expect(await _shape(upDb, kBlindStoreCloudStateTable), freshCloud,
          reason: 'the v6 step and the create path disagree about the '
              'blind-store ledger table');
      expect(<String, String>{
        ...await _indexes(upDb, kTimelineTable),
        ...await _indexes(upDb, kOutboxTable),
        ...await _indexes(upDb, kInstanceMachineMapTable),
        ...await _indexes(upDb, kBlindStoreCloudStateTable),
      }, freshIdx, reason: 'an index that only the create path builds is a '
          'query plan that only new installs get');
      await upDb.close();
    });

    test('🔴 D13 ② — the TRAPPED install (outbox table born pre-B3-2b) can '
        'enqueue again after v4', () async {
      // The real-world shape: the table exists WITHOUT covered_entry_ids /
      // wire_entry_id and the db already says v2, so the edited create never
      // ran and never would.
      final String trapped = _freshPath();
      final Database old = await databaseFactoryFfi.openDatabase(
        trapped,
        options: OpenDatabaseOptions(
          version: 2,
          onCreate: (Database d, int _) async {
            await createTimelineSchemaV1ForTest(d);
            await createOutboxSchemaV2ForTest(d);
          },
        ),
      );
      // Positive control ① — the trap is real: the columns are absent and the
      // enqueue INSERT the queue does every time fails on this table.
      final Map<String, String> before = await _shape(old, kOutboxTable);
      expect(before.containsKey('covered_entry_ids'), isFalse);
      expect(before.containsKey('wire_entry_id'), isFalse);
      await expectLater(
        SqfliteOutboxStore(old).upsert(_item('req-trapped')),
        throwsA(isA<DatabaseException>()),
      );
      await old.close();

      // The app upgrades it.
      final TimelineStorageOpen healed = await _open(trapped);
      expect(healed.kind, TimelineStorageKind.sqlite);

      // …and the queue works. This is the assertion that matters: not 「the
      // column exists」 but 「an enqueue lands and comes back」.
      await healed.outbox!.upsert(_item('req-healed'));
      final List<OutboxItem> pending = await healed.outbox!.loadPending();
      expect(pending, hasLength(1));
      expect(pending.single.coveredEntryIds,
          <String>['loc_req-healed', 'loc_req-healed_b']);
      expect(pending.single.wireEntryId, 'loc_req-healed');
    });

    test('D13 ② — running the healing step against an install that already has '
        'the columns is a no-op, not a duplicate-column failure', () async {
      // The other population: installs whose table came from the EDITED create,
      // i.e. the columns are present while the version is still 2.
      final String path = _freshPath();
      final Database d = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 2,
          onCreate: (Database db, int _) async {
            await createTimelineSchemaV1ForTest(db);
            await createOutboxSchemaV2ForTest(db);
            await db.execute(
              'ALTER TABLE $kOutboxTable ADD COLUMN duration_ms INTEGER',
            );
            await db.execute("ALTER TABLE $kOutboxTable ADD COLUMN "
                "covered_entry_ids TEXT NOT NULL DEFAULT ''");
            await db.execute(
              'ALTER TABLE $kOutboxTable ADD COLUMN wire_entry_id TEXT',
            );
          },
        ),
      );
      await d.close();

      final TimelineStorageOpen out = await _open(path);
      expect(out.kind, TimelineStorageKind.sqlite,
          reason: 'a duplicate-column error here would drop this install to '
              'the 100-row store on every launch');
      await out.outbox!.upsert(_item('req-idem'));
      expect(await out.outbox!.loadPending(), hasLength(1));
    });
  });

  group('D13 ③ — a real file, closed and reopened (「is it still there after a restart」)', () {
    test('🔴 rows AND queued deliveries survive a close/reopen cycle', () async {
      final String path = _freshPath();
      final TimelineStorageOpen first = await _open(path);
      expect(first.kind, TimelineStorageKind.sqlite);
      await first.persistence.upsert(_entry('loc_a'));
      await first.persistence.upsert(_entry('loc_b', at: DateTime.utc(2026, 8, 4, 11)));
      await first.outbox!.upsert(_item('req-restart'));
      await (first.persistence as SqfliteTimelinePersistence).close();

      // Positive control: the file is really on disk and non-trivial.
      expect(File(path).existsSync(), isTrue);
      expect(File(path).lengthSync(), greaterThan(0));

      // A SECOND process would do exactly this.
      final TimelineStorageOpen second = await _open(path);
      expect(second.kind, TimelineStorageKind.sqlite,
          reason: 'reopening an existing file must not fall back — that would '
              'be a 100-row store telling the user only about history');
      final List<TimelineEntry> rows = await second.persistence.loadAll();
      expect(rows.map((TimelineEntry e) => e.id).toList()..sort(),
          <String>['loc_a', 'loc_b']);
      final List<OutboxItem> pending = await second.outbox!.loadPending();
      expect(pending, hasLength(1),
          reason: '「pending delivery」 is only allowed while a persistent queue actually '
              'redeems it — this is the assertion that proves the queue is '
              'persistent at all');
      expect(pending.single.requestId, 'req-restart');
      expect(pending.single.durationMs, 1234,
          reason: 'a queued retry must deliver the duration the live send '
              'stamped (v3 exists for this)');
    });
  });

  group('D13 ① — an older APK opening a newer database', () {
    test('🔴 the downgrade is REFUSED, reported by name, and destroys nothing',
        () async {
      final String path = _freshPath();
      // A future build's file: same tables, higher version stamp.
      final Database future = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: kTimelineDbVersion + 1,
          onCreate: (Database d, int _) => createTimelineSchemaV1ForTest(d),
        ),
      );
      await SqfliteTimelinePersistence(future).upsert(_entry('loc_future'));
      await future.close();

      final TimelineStorageOpen out = await _open(path);

      // ① The app still runs — on the legacy store, not on a crash.
      expect(out.kind, TimelineStorageKind.sharedPrefsFallback);
      // ② …and it can say WHY. A downgrade dressed up as 「disk trouble」 is the
      // silent story this card removes.
      expect(out.failure, contains('TIMELINE_DB_DOWNGRADE_REFUSED'));
      expect(out.failure, contains('v${kTimelineDbVersion + 1}'));
      final String trail = DiagLog.instance.snapshot().join('\n');
      expect(trail, contains('timeline.db_downgrade_refused'));
      // ③ The consequence the history footnote CANNOT state: the delivery queue
      // is not persistent in this state.
      expect(out.outbox, isNull);
      expect(trail, contains('outbox_persistent'));

      // ④ 🔴 NOTHING WAS TOUCHED. Reinstalling the newer APK must find the file
      // exactly as it was — this is the whole reason the policy is REFUSE.
      // MEASURED with the callback removed: sqflite does not throw and does not
      // delete, it opens the newer file happily (`kind == sqlite`, the assertion
      // above is the one that goes red) and then STAMPS IT DOWN to this build's
      // version (sqflite_common 2.5.8 database_mixin.dart:1166
      // `if (oldVersion != options.version) setVersion(...)`). The expect below
      // is what names the lasting damage that silent stamp does.
      final Database check = await databaseFactoryFfi.openDatabase(path);
      expect(await check.getVersion(), kTimelineDbVersion + 1,
          reason: 'the version stamp was rewritten — the file has been '
              'silently downgraded');
      expect(
        await check.query(kTimelineTable, where: 'id = ?', whereArgs: <Object?>['loc_future']),
        hasLength(1),
        reason: 'the newer build\'s row is gone: the refusal deleted data');
      await check.close();
    });

    test('D13 ① — the ORDINARY open failure keeps its own reason (the two '
        'stories must not be read as one)', () async {
      final TimelineStorageOpen out = await openTimelinePersistence(
        prefs: await SharedPreferences.getInstance(),
        factory: databaseFactoryFfi,
        // A directory, not a file — an open failure that is genuinely 「disk
        // trouble」.
        path: _tmp.path,
      );
      expect(out.kind, TimelineStorageKind.sharedPrefsFallback);
      expect(out.failure, isNot(contains('TIMELINE_DB_DOWNGRADE_REFUSED')));
      final String trail = DiagLog.instance.snapshot().join('\n');
      expect(trail, contains('timeline.storage_fallback'));
      expect(trail, contains('open_failed'));
      expect(trail, isNot(contains('timeline.db_downgrade_refused')));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Card F2 phase 2 — v5 `instance_machine_map`. Design §3.2 / §3.3.
  // ───────────────────────────────────────────────────────────────────────────
  group('Card F2 phase 2 — v5 map table', () {
    test('🔴 re-running the v5 create step does not explode: a db that was stamped down and raised again still has the table and the rows', () async {
      // The claim `timeline_sqlite_migrations.dart` makes in prose — 「a file
      // that was stamped down and re-upgraded walks this step a second time,
      // which is why the STEP carries IF NOT EXISTS and the CREATE path does
      // not」 — walked instead of quoted. Without it the step raises
      // 「table instance_machine_map already exists」 inside onUpgrade, and this
      // install drops to the 100-row store on EVERY launch, permanently.
      final String path = _freshPath();
      final TokenStorage pairings = InMemoryTokenStorage();
      await pairings.addOrUpdatePairing(_lan);
      await pairings.addOrUpdatePairing(_relay);

      final TimelineStorageOpen born = await _open(path);
      expect(born.kind, TimelineStorageKind.sqlite);
      await seedInstanceMachineMap(map: born.machineMap, storage: pairings);
      await born.persistence.upsert(_entry('loc_v5_row'));
      final Map<String, String> shapeWas =
          await _shape(await _rawOf(path), kInstanceMachineMapTable);
      expect(shapeWas.keys.toSet(),
          <String>{'instance_id', 'machine_uid', 'learned_at', 'source'});
      // 🔴 NOT NULL on machine_uid is the load-bearing column property: a row
      // that said 「null」 would group with every other null, which is exactly
      // 「could not ask」 rendered as 「yes」 (machine_group.dart rule ①).
      expect(shapeWas['machine_uid'], contains('notnull=1'));
      await (born.persistence as SqfliteTimelinePersistence).close();

      // The file an older APK left behind: same tables, version stamped down.
      final Database stamped = await databaseFactoryFfi.openDatabase(path);
      await stamped.execute('PRAGMA user_version = 4');
      await stamped.close();

      final TimelineStorageOpen again = await _open(path);
      expect(again.kind, TimelineStorageKind.sqlite,
          reason: 're-running the v5 step exploded ⇒ this machine falls to the 100-row fallback on every launch');
      expect(await again.machineMap!.readAll(), <String, String>{
        _lan.connectionIdentity: 'machine-AAAA',
        _relay.connectionIdentity: 'machine-AAAA',
      }, reason: 're-run rebuilt the table ⇒ the learned mapping was wiped');
      final Database raw = await _rawOf(path);
      expect(await raw.getVersion(), kTimelineDbVersion);
      expect(await _shape(raw, kInstanceMachineMapTable), shapeWas);
      expect(await raw.query(kInstanceMachineMapTable), hasLength(2),
          reason: 're-run grew a third and fourth row');
      expect(
        await raw.query(kTimelineTable,
            where: 'id = ?', whereArgs: <Object?>['loc_v5_row']),
        hasLength(1),
      );
      await raw.close();
    });

    test('🔴 seed runs on every launch: a re-run only overwrites itself, the row count does not grow', () async {
      final String path = _freshPath();
      final TokenStorage pairings = InMemoryTokenStorage();
      await pairings.addOrUpdatePairing(_lan);
      await pairings.addOrUpdatePairing(_relay);
      final TimelineStorageOpen open = await _open(path);

      for (int run = 1; run <= 3; run++) {
        final int written = await seedInstanceMachineMap(
          map: open.machineMap,
          storage: pairings,
        );
        expect(written, 2, reason: 'run $run');
        expect(await open.machineMap!.readAll(), <String, String>{
          _lan.connectionIdentity: 'machine-AAAA',
          _relay.connectionIdentity: 'machine-AAAA',
        }, reason: 'run $run');
      }
      final Database raw = await _rawOf(path);
      expect(await raw.query(kInstanceMachineMapTable), hasLength(2),
          reason: 'INSERT OR REPLACE degenerated into INSERT ⇒ two extra rows on every launch');
      // The cloud instance is excluded at the WRITE, not only at the read.
      await pairings.addOrUpdatePairing(_cloud);
      expect(await seedInstanceMachineMap(map: open.machineMap, storage: pairings), 2,
          reason: 'the saas row was written into the machine map');
      expect(await raw.query(kInstanceMachineMapTable), hasLength(2));
      await raw.close();
    });

    test('🔴 a v4 db raised to v5: the old db grows the map table in place, not one history row is lost', () async {
      // The population this step really runs against: an install that shipped
      // before this card. Built with this file's own frozen v2 DDL + the app's
      // own steps, so it is a REAL v4 database, not a hand-written v5 one.
      final String path = _freshPath();
      final Database old = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(
          version: 4,
          onCreate: (Database db, int _) async {
            await createTimelineSchemaV1ForTest(db);
            await createOutboxSchemaV2ForTest(db);
          },
        ),
      );
      await SqfliteTimelinePersistence(old).upsert(_entry('loc_before_f2'));
      // Positive control — the table genuinely is not there yet.
      expect(
        await old.rawQuery(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          <Object?>[kInstanceMachineMapTable],
        ),
        isEmpty,
      );
      await old.close();

      final TimelineStorageOpen up = await _open(path);
      expect(up.kind, TimelineStorageKind.sqlite,
          reason: 'the upgrade must not fall to the 100-row fallback');
      expect(await up.machineMap!.readAll(), isEmpty,
          reason: 'creating the table ≠ seeding: openTimelinePersistence must not seed itself');
      final List<TimelineEntry> kept = await up.persistence.loadAll();
      expect(kept.map((TimelineEntry e) => e.id), contains('loc_before_f2'),
          reason: 'the upgrade touched existing history');
    });

    test('🔴 a seed failure must not drop the whole db into the fallback (seed is not inside open\'s wide catch)',
        () async {
      final String path = _freshPath();
      final TimelineStorageOpen open = await _open(path);
      // ① The store is already open and serving history BEFORE the seed runs.
      expect(open.kind, TimelineStorageKind.sqlite);
      await open.persistence.upsert(_entry('loc_survives_seed'));

      // ② The worst the seed can do: its input throws.
      final int written = await seedInstanceMachineMap(
        map: open.machineMap,
        storage: _ThrowingTokenStorage(),
      );
      expect(written, 0);
      expect(DiagLog.instance.snapshot().join('\n'),
          contains('machine_map.seed_failed'),
          reason: 'silent failure is a red line: even without a merge it must make a sound');

      // ③ 🔴 …and the user's history is untouched and still on SQLite.
      //
      // REVERSE CONTROL — see this test's entry in
      // docs/strategy/2026-08-05-f2-machine-merge-delivery-cn.md §6 for the
      // verbatim red output: moving this seed inside openTimelinePersistence's
      // try (which design §3.2 forbids) turns assertion ① red, i.e. one failed
      // seed of DERIVED data costs the user the 100-row cap on their REAL
      // history.
      expect(open.kind, TimelineStorageKind.sqlite);
      final List<TimelineEntry> kept = await open.persistence.loadAll();
      expect(kept.map((TimelineEntry e) => e.id), contains('loc_survives_seed'));
    });

    test('🔴 §3.3 downgrade: installing the old APK is blocked by D13\'s gate, the map table and its rows are still there untouched',
        () async {
      // The seam between D13 and Card F2, walked instead of quoted: v5 is the
      // first version bump since `onDowngrade` shipped, so this is the first
      // file this repo has ever produced that an older APK can be asked to open.
      final String path = _freshPath();
      final TokenStorage pairings = InMemoryTokenStorage();
      await pairings.addOrUpdatePairing(_lan);
      final TimelineStorageOpen born = await _open(path);
      await seedInstanceMachineMap(map: born.machineMap, storage: pairings);
      await born.persistence.upsert(_entry('loc_v5'));

      // Make the file NEWER than this build, the way a future APK would: the
      // table and the rows are the REAL ones this build just wrote, only the
      // stamp is raised.
      final Database bump = await databaseFactoryFfi.openDatabase(path);
      await bump.execute('PRAGMA user_version = ${kTimelineDbVersion + 1}');
      await bump.close();

      DiagLog.instance.clear();
      final TimelineStorageOpen older = await _open(path);

      // ① Refused BY NAME, not dressed up as disk trouble.
      expect(older.kind, TimelineStorageKind.sharedPrefsFallback);
      expect(older.failure, contains('TIMELINE_DB_DOWNGRADE_REFUSED'));
      expect(DiagLog.instance.snapshot().join('\n'),
          contains('timeline.db_downgrade_refused'));

      // ② 🔴 NOTHING DESTROYED — including this card's new table.
      //
      // REVERSE CONTROL — removing `onDowngrade:` from timeline_sqlite.dart;
      // the verbatim red output is in
      // docs/strategy/2026-08-05-f2-machine-merge-delivery-cn.md §6. That is the
      // D13 gate this card waited on: without it, v5 is the hand that turns a
      // dormant hazard into an incident (design §3.3), because v5 is the first
      // version bump this repo has shipped since `onDowngrade` existed.
      final Database check = await databaseFactoryFfi.openDatabase(path);
      expect(await check.getVersion(), kTimelineDbVersion + 1,
          reason: 'the version stamp was rewritten = the file was silently downgraded');
      expect(await check.query(kInstanceMachineMapTable), hasLength(1));
      expect(
        await check.query(kTimelineTable,
            where: 'id = ?', whereArgs: <Object?>['loc_v5']),
        hasLength(1),
      );
      await check.close();
    });
  });
}

/// A storage that throws — the cheapest way to make the seed fail.
///
/// ⚠️ Honest about what it does and does not model. `SecureTokenStorage
/// .readPairings` catches `on Object` and returns `[]`
/// (`token_storage.dart:414-423`), so THIS input cannot throw in production.
/// The reachable production failure is the other half — a `map.put` that hits a
/// disk/db error — and both land in the same `catch` in
/// [seedInstanceMachineMap]. What this fixture pins is that seed failure, from
/// whatever source, is a non-event for the user's history; it is not evidence
/// that the pairing list can throw.
class _ThrowingTokenStorage extends TokenStorage {
  @override
  Future<List<MobileSession>> readPairings() async =>
      throw StateError('keystore unavailable');

  @override
  Future<void> addOrUpdatePairing(MobileSession session) async {}

  @override
  Future<void> removePairing(MobileSession session) async {}

  @override
  Future<void> setPairingAlias(MobileSession session, String? alias) async {}

  @override
  Future<void> clearAll() async {}
}
