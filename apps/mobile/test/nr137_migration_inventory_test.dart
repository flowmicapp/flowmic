// NR-137 round 8 (review r7, BLOCKING D2) — A ROW THE ACTIVE STORE CANNOT
// SEE IS NEVER A ROW THAT IS GONE.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   lib/src/timeline/timeline_row_stores.dart (every place a row can live)
//   lib/src/timeline/timeline_unresolved_rows.dart (how SQLite carries them)
//
// Review of `13025e9d` (`_dispatch/2026-10-02-nr137-r7-review.md.out`): the
// one-time import read the fallback through its LENIENT reader, so an
// undecodable row never reached it; the device was then marked migrated and
// SQLite's inventory scanned only its own table. Measured there, in all four
// places the row can sit: fallback holes 1 → SQLite holes 0, absence proven,
// press `done`, PCM released, the undecodable bytes still in SharedPrefs.
//
// The first four cases are those four repros, on the real chain (`Rc3Rig` →
// `PendingRecoveryStore.retryNow`), the shipped opener and a real SQLite file.
// The adapter only switches which shipped backend the rig calls, as an app
// reopen would; it injects no fault.
//
// The fifth case is the same defect in the other direction, found while
// listing the stores (round-8 report §1): a session that runs on the fallback
// because SQLite will not open cannot see SQLite's rows at all, and took that
// for "this article has no rows".
//
// The resolution cases pin the only two ways an unresolved row stops counting
// (its bytes are gone, or a valid record for its id was written by the active
// store), and that ordinary list output does not change.
//
// REVERSE CONTROL (2026-10-02): this file on `13025e9d`, unmodified product
// code — the four review variants and the unreachable-SQLite case red on
// `Expected: failed, Actual: done`; see the round-8 report.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/rc3_rig.dart';

const String _legacyKey = 'flowmic.timeline.entries.v1';
String _v3(String id) => 'flowmic.timeline.pending.v3.${Uri.encodeComponent(id)}';
String _v2(String id) => 'flowmic.timeline.row.v2.${Uri.encodeComponent(id)}';

/// Switches which shipped backend the rig calls, as an app reopen would.
/// Every read, write, scan and delete is delegated without fault injection.
class _BackendSlot
    implements TimelinePersistence, TimelineVerifiedReads, TimelineKeyedPersistence {
  _BackendSlot(this.current);
  TimelinePersistence current;
  @override
  Future<List<TimelineEntry>> loadAll() => current.loadAll();
  @override
  Future<TimelineEntry?> readRecord(String id) => current.loadById(id);
  @override
  Future<TimelineInventory> loadInventory() => current.inventory();
  @override
  Future<bool> mayHoldRow(String id) =>
      (current as TimelineVerifiedReads).mayHoldRow(id);
  @override
  Future<void> upsert(TimelineEntry row) => current.upsert(row);
  @override
  Future<void> delete(String id) => current.delete(id);
  @override
  Future<void> saveAll(List<TimelineEntry> rows) => current.saveAll(rows);
  @override
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit}) =>
      current.loadPage(before: before, limit: limit);
  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 1000}) =>
      current.search(query, limit: limit);
}

/// SQLite that will not open this session; whether its file exists is real.
class _UnopenableFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Close at teardown; a test that closed it already to reopen is fine.
void _closeLater(SqfliteTimelinePersistence sql) => addTearDown(() async {
      try {
        await sql.close();
      } on Object {
        // already closed by the test
      }
    });

Future<SharedPreferences> _emptyPrefs() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return SharedPreferences.getInstance();
}

/// A four-second article kept `settled_unverified` with two paragraphs; a
/// recovery answers the whole recording.
Future<Rc3Rig> _article(TimelinePersistence p) async {
  final Rc3Rig r = await Rc3Rig.open(persistence: p);
  addTearDown(r.dispose);
  r.relay.onStop = (Rc3Stop stop) {
    Future<void>.delayed(
        const Duration(milliseconds: 20),
        () => r.relay.pushIncoming(
            FlowMicEvents.sttFinal,
            stop.recovery
                ? r.relay.terminal(stop,
                    text: 'Verified new whole recording', durationMs: 4000)
                : r.relay.terminal(stop,
                    text: '', durationMs: 0, segmentIdx: 2,
                    endedNormally: false)));
  };
  await r.begin();
  await r.feedMs(4000);
  await r.segment('First earlier visible paragraph', 0, 2000);
  await r.segment('Second earlier visible paragraph', 1, 2000);
  await r.controller.pttUp();
  await r.untilAsync(() async =>
      (await r.manifest())?.recoveryState ==
      RecoveryQueueState.settledUnverified);
  for (final TimelineEntry row in r.rows) {
    await r.timeline.awaitPersisted(row.id);
  }
  expect(r.rows, hasLength(2));
  expect(r.pcmPresent, isTrue);
  return r;
}

Future<PendingRetryOutcome> _press(Rc3Rig r) async {
  final PendingRecoveryStore pending = PendingRecoveryStore(
      runner: r.controller.backfill, sourceLang: () => 'zh');
  final PendingRetryOutcome out =
      await pending.retryNow((await pending.list()).single);
  await r.recoveries(1);
  return out;
}

Map<String, Object?> _undecodable(TimelineEntry row) =>
    Map<String, Object?>.from(row.toJson())
      ..['duration_ms'] = 'undecodable-duration';

/// Where one of the article's rows is put, undecodable.
enum _Place { array, v2, v3, v3AfterMigration }

/// The fallback state a recording leaves, one member made undecodable at
/// [place]. Returns the key and the exact bytes that now hold that member.
Future<(String, String)> _corrupt(_Place place, SharedPreferences prefs,
    SharedPrefsTimelinePersistence fallback, TimelineEntry old) async {
  final Map<String, Object?> bad = _undecodable(old);
  expect(decodeTimelineRow(bad), isNull, reason: 'decoder control');
  switch (place) {
    case _Place.array:
      await fallback.delete(old.id);
      final String bytes = jsonEncode(<Object?>[bad]);
      await prefs.setString(_legacyKey, bytes);
      return (_legacyKey, bytes);
    case _Place.v2:
      await fallback.delete(old.id);
      final String bytes = jsonEncode(bad);
      await prefs.setString(_v2(old.id), bytes);
      return (_v2(old.id), bytes);
    case _Place.v3:
    case _Place.v3AfterMigration:
      final String bytes = jsonEncode(bad);
      await prefs.setString(_v3(old.id), bytes);
      return (_v3(old.id), bytes);
  }
}

/// Open the shipped SQLite store over [prefs] at [path] (the one-time import
/// runs), close it, and open it again: the state a later launch finds.
Future<TimelineStorageOpen> _migrateAndReopen(
    SharedPreferences prefs, String path) async {
  final TimelineStorageOpen first = await openTimelinePersistence(
      prefs: prefs, factory: databaseFactoryFfi, path: path);
  expect(first.kind, TimelineStorageKind.sqlite);
  expect(prefs.getBool(kTimelineMigratedKey), isTrue,
      reason: 'control: the shipped import marked this device migrated');
  await (first.persistence as SqfliteTimelinePersistence).close();
  final TimelineStorageOpen again = await openTimelinePersistence(
      prefs: prefs, factory: databaseFactoryFfi, path: path);
  expect(again.kind, TimelineStorageKind.sqlite);
  _closeLater(again.persistence as SqfliteTimelinePersistence);
  return again;
}

/// A completed migration BEFORE the recording is made; returns its path.
Future<String> _migratedEarlier(
    SharedPreferences prefs, SharedPrefsTimelinePersistence fallback) async {
  final Directory tmp = await Directory.systemTemp.createTemp('nr137-r8-');
  final String path = '${tmp.path}/timeline.db';
  addTearDown(() async {
    await databaseFactoryFfi.deleteDatabase(path);
    try { await tmp.delete(recursive: true); } on Object { /* best effort */ }
  });
  await fallback.upsert(TimelineEntry(
      id: 'initial-migration-control',
      clientId: 'initial',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: 'Unrelated migration control',
      outputText: '',
      status: EntryStatus.noted,
      createdAt: DateTime.utc(2026, 9, 1),
      updatedAt: DateTime.utc(2026, 9, 1)));
  final TimelineStorageOpen initial = await openTimelinePersistence(
      prefs: prefs, factory: databaseFactoryFfi, path: path);
  expect(initial.kind, TimelineStorageKind.sqlite);
  expect(prefs.getBool(kTimelineMigratedKey), isTrue);
  await (initial.persistence as SqfliteTimelinePersistence).close();
  return path;
}

/// A recording on the fallback with one member undecodable at [place], then
/// migrated to SQLite and reopened, the rig switched onto SQLite and reloaded.
class _Migrated {
  _Migrated(this.r, this.prefs, this.old, this.key, this.bytes, this.sql,
      this.open);
  final Rc3Rig r;
  final SharedPreferences prefs;
  final TimelineEntry old;
  final String key;
  final String bytes;
  final SqfliteTimelinePersistence sql;
  final TimelineStorageOpen open;
}

Future<_Migrated> _migrated(_Place place,
    {Future<void> Function(SharedPreferences, TimelineEntry)? beforeReopen}) async {
  final SharedPreferences prefs = await _emptyPrefs();
  // Before the migration this device has no SQLite file; the degraded session
  // after an earlier migration has one (and cannot see it).
  final SharedPrefsTimelinePersistence fallback =
      SharedPrefsTimelinePersistence(prefs, sqliteFile: SqliteFileEvidence.absent);
  final String? earlier = place == _Place.v3AfterMigration
      ? await _migratedEarlier(prefs, fallback)
      : null;
  if (earlier != null) fallback.sqliteFile = SqliteFileEvidence.unknown;
  final _BackendSlot slot = _BackendSlot(fallback);
  final Rc3Rig r = await _article(slot);
  final TimelineEntry old = r.rows.first;
  final (String key, String bytes) =
      await _corrupt(place, prefs, fallback, old);
  final TimelineInventory before = await fallback.loadInventory();
  expect(before.unreadable, hasLength(1),
      reason: 'control: the fallback itself sees the undecodable member');
  expect(before.mayOmitMemberOf(r.articleId!), isTrue);
  expect(await provenGone(r.timeline, old.id), isFalse,
      reason: 'control: on the fallback the member is not proven gone');
  final String path = earlier ?? '${r.tmp.path}/timeline-r8.sqlite';
  if (earlier == null) {
    addTearDown(() => databaseFactoryFfi.deleteDatabase(path));
  }
  final TimelineStorageOpen first = await openTimelinePersistence(
      prefs: prefs, factory: databaseFactoryFfi, path: path);
  expect(first.kind, TimelineStorageKind.sqlite);
  expect(prefs.getBool(kTimelineMigratedKey), isTrue,
      reason: 'control: the shipped import marked this device migrated');
  await (first.persistence as SqfliteTimelinePersistence).close();
  await beforeReopen?.call(prefs, old);
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs, factory: databaseFactoryFfi, path: path);
  expect(open.kind, TimelineStorageKind.sqlite);
  final SqfliteTimelinePersistence sql =
      open.persistence as SqfliteTimelinePersistence;
  _closeLater(sql);
  slot.current = sql;
  // The same storage-open notice integration as main.dart.
  r.timeline.recoveryFailures.reportStorageOpen(open.failure, open.corruptionRowIds);
  await r.timeline.load();
  return _Migrated(r, prefs, old, key, bytes, sql, open);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  group('an undecodable fallback row survives migration as uncertainty', () {
    for (final _Place place in _Place.values) {
      test('${place.name}: the press fails and the audio is kept', () async {
        final _Migrated m = await _migrated(place);
        final TimelineInventory inv = await m.sql.loadInventory();
        final bool absence = await provenGone(m.r.timeline, m.old.id);
        final List<TimelineEntry>? members =
            await articleMembersVerified(m.r.timeline, m.r.articleId!);

        final PendingRetryOutcome out = await _press(m.r);

        // ignore: avoid_print
        print('R8 migrated ${place.name}: sqlHoles=${inv.unreadable.length} '
            'absenceProven=$absence membershipVerified=${members != null} '
            'reopenFailure=${m.open.failure} outcome=$out '
            'audioPresent=${m.r.pcmPresent}');
        expect(m.prefs.getString(m.key), m.bytes,
            reason: 'control: the undecodable bytes are still stored, unchanged');
        expect(out, PendingRetryOutcome.failed,
            reason: 'a member migration could not read is not proven gone');
        expect(m.r.pcmPresent, isTrue);
        expect(absence, isFalse);
        expect(members, isNull);
        expect(inv.mayOmitMemberOf(m.r.articleId!), isTrue);
        expect(await provenGone(m.r.timeline, m.old.id), isFalse);
        expect(m.prefs.getString(m.key), m.bytes,
            reason: 'nothing deletes or rewrites the stored bytes');
      });
    }

    test('control: a readable migrated article is replaced and released', () async {
      final SharedPreferences prefs = await _emptyPrefs();
      final _BackendSlot slot =
          _BackendSlot(SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent));
      final Rc3Rig r = await _article(slot);
      final String path = '${r.tmp.path}/timeline-r8.sqlite';
      addTearDown(() => databaseFactoryFfi.deleteDatabase(path));
      final TimelineStorageOpen open = await _migrateAndReopen(prefs, path);
      slot.current = open.persistence;
      await r.timeline.load();
      expect((await open.persistence.inventory()).complete, isTrue);

      expect(await _press(r), PendingRetryOutcome.done);
      expect(r.pcmPresent, isFalse);
    });

    test('ordinary lists and the open notice do not change', () async {
      final _Migrated m = await _migrated(_Place.array);
      expect(m.open.failure, isNull,
          reason: 'the reopen notice reports what it reported before');
      expect(m.open.corruptionRowIds, isEmpty);
      await m.sql.loadInventory();
      expect(m.sql.unreadableRows, 0,
          reason: 'carried uncertainty is never a display report');
      final List<TimelineEntry> listed = await m.sql.loadAll();
      expect(m.sql.unreadableRows, 0);
      expect(listed.map((TimelineEntry e) => e.id), isNot(contains(m.old.id)));
      expect(listed.where((TimelineEntry e) => e.articleId == m.r.articleId),
          hasLength(2), reason: 'the head and the readable member, as before');
    });
  });

  group('an unresolved row stops counting only when it is resolved', () {
    test('its bytes are gone: the next open resolves it and the press succeeds',
        () async {
      final _Migrated m = await _migrated(_Place.v3,
          beforeReopen: (SharedPreferences prefs, TimelineEntry old) =>
              prefs.remove(_v3(old.id)));
      expect(m.prefs.containsKey(m.key), isFalse, reason: 'control');
      expect((await m.sql.loadInventory()).complete, isTrue);
      expect(await provenGone(m.r.timeline, m.old.id), isTrue);

      expect(await _press(m.r), PendingRetryOutcome.done);
      expect(m.r.pcmPresent, isFalse);
    });

    test('a valid record for its id is written: superseded, press succeeds, '
        'bytes untouched', () async {
      final _Migrated m = await _migrated(_Place.v2);
      expect(await provenGone(m.r.timeline, m.old.id), isFalse, reason: 'control');
      await m.sql.upsert(m.old);
      await m.r.timeline.load();
      expect((await m.sql.loadInventory()).complete, isTrue);

      expect(await _press(m.r), PendingRetryOutcome.done);
      expect(m.r.pcmPresent, isFalse);
      expect(await provenGone(m.r.timeline, m.old.id), isTrue);
      expect(m.prefs.getString(m.key), m.bytes,
          reason: 'a superseded copy is kept as it was, never deleted');
    });

    test('a superseded row stays resolved on the next open', () async {
      final _Migrated m = await _migrated(_Place.array);
      await m.sql.upsert(m.old);
      await m.sql.close();
      final TimelineStorageOpen again = await openTimelinePersistence(
          prefs: m.prefs, factory: databaseFactoryFfi,
          path: '${m.r.tmp.path}/timeline-r8.sqlite');
      _closeLater(again.persistence as SqfliteTimelinePersistence);
      expect((await again.persistence.inventory()).complete, isTrue);
      expect(m.prefs.getString(m.key), m.bytes);
    });
  });

  group('a session on the fallback cannot see SQLite', () {
    test('rows in a database that will not open block the press', () async {
      final SharedPreferences prefs = await _emptyPrefs();
      final Directory tmp = await Directory.systemTemp.createTemp('nr137-r8-db-');
      final String path = '${tmp.path}/timeline.db';
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(path);
        try { await tmp.delete(recursive: true); } on Object { /* best effort */ }
      });
      final TimelineStorageOpen sqlite = await openTimelinePersistence(
          prefs: prefs, factory: databaseFactoryFfi, path: path);
      expect(sqlite.kind, TimelineStorageKind.sqlite);
      final _BackendSlot slot = _BackendSlot(sqlite.persistence);
      final Rc3Rig r = await _article(slot);
      await (sqlite.persistence as SqfliteTimelinePersistence).close();

      final TimelineStorageOpen degraded = await openTimelinePersistence(
          prefs: prefs, factory: _UnopenableFactory(), path: path);
      expect(degraded.kind, TimelineStorageKind.sharedPrefsFallback);
      slot.current = degraded.persistence;
      await r.timeline.load();
      expect(await degraded.persistence.loadAll(), isEmpty,
          reason: 'control: none of the article is visible this session');

      final PendingRetryOutcome out = await _press(r);

      final Database raw = await databaseFactoryFfi.openDatabase(path);
      final int stillThere = (await raw.query(kTimelineTable,
              where: 'article_id = ?', whereArgs: <Object?>[r.articleId]))
          .length;
      await raw.close();
      // ignore: avoid_print
      print('R8 unreachable sqlite: rowsInDb=$stillThere outcome=$out '
          'audioPresent=${r.pcmPresent}');
      expect(stillThere, greaterThanOrEqualTo(2),
          reason: 'control: the article is still in the database file');
      expect(out, PendingRetryOutcome.failed,
          reason: 'rows this session cannot see are not proven absent');
      expect(r.pcmPresent, isTrue);
    });

    test('control: with no database file the fallback press still succeeds',
        () async {
      final SharedPreferences prefs = await _emptyPrefs();
      final Directory tmp = await Directory.systemTemp.createTemp('nr137-r8-nodb-');
      addTearDown(() async {
        try { await tmp.delete(recursive: true); } on Object { /* best effort */ }
      });
      final TimelineStorageOpen degraded = await openTimelinePersistence(
          prefs: prefs, factory: _UnopenableFactory(),
          path: '${tmp.path}/never-created.db');
      expect(degraded.kind, TimelineStorageKind.sharedPrefsFallback);
      final Rc3Rig r = await _article(degraded.persistence);

      expect(await _press(r), PendingRetryOutcome.done);
      expect(r.pcmPresent, isFalse);
    });
  });

  test('a frozen v2 hole with unknown attribution still blocks the fallback',
      () async {
    final SharedPreferences prefs = await _emptyPrefs();
    // No SQLite file on this device: the case is decided by the v2 hole.
    final SharedPrefsTimelinePersistence fallback =
        SharedPrefsTimelinePersistence(prefs, sqliteFile: SqliteFileEvidence.absent);
    final Rc3Rig r = await _article(fallback);
    final TimelineEntry old = r.rows.first;
    await fallback.delete(old.id);
    final String bytes = jsonEncode(_undecodable(old)
      ..['article_id'] = <String>['damaged-attribution']);
    expect(decodeTimelineRow(bytes), isNull);
    await prefs.setString(_v2(old.id), bytes);
    await prefs.setBool(kTimelineMigratedKey, true);
    final TimelineInventory before = await fallback.loadInventory();
    expect(before.unreadable, hasLength(1));
    expect(before.unreadable.single.articleKnown, isFalse);
    expect(before.mayOmitMemberOf('an-unrelated-article'), isTrue);

    expect(await _press(r), PendingRetryOutcome.failed);
    expect(r.pcmPresent, isTrue);
    expect(prefs.getString(_v2(old.id)), bytes);
  });
}
