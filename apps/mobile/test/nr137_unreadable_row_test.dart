// NR-137 round 6 (final review D2) — A ROW STORAGE STILL HOLDS BUT CANNOT
// DECODE IS NEVER A REMOVED ROW.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   lib/src/timeline/timeline_verified_reads.dart (the three-state reads)
//
// The production decoders skip an undecodable payload (`_decode` in
// timeline_sqlite.dart, the fallback's `loadAll`), so the keyed read answered
// null for a row that was still on disk, and the removal proof took null for
// 「gone」. Measured by the final review on `86b7ede4`
// (`_dispatch/nr137-r5-review-decoder-final.log`): `absenceProven=true` with
// the row physically there; a legacy press `done`, audio 6,400 → 0 bytes.
//
// BOTH BACKENDS: the shipped SQLite store and the SharedPrefs fallback the app
// runs on when SQLite will not open. Every case carries a positive control
// that the row really is physically present and really is undecodable, so a
// green proves the product refused, not that the fault was never injected.
//
// The deletion faults below (a `delete` that returns but leaves an undecodable
// payload behind) are injected at the deletion boundary. They do NOT claim the
// shipped stores do that on their own; the first case of each group shows the
// mistaken absence on an unmodified reader.
//
// REVERSE CONTROL (2026-10-02): this file run on `86b7ede4` (the production
// code before round 6) — the D2 cases red; see the round-6 report.

import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/di.dart';
import 'support/legacy_backfill_rig.dart';

const String _bad = '{unreadable';

/// SQLite whose `delete` returns but leaves an undecodable payload behind.
class _SqlDeleteLeavesUnreadable extends SqfliteTimelinePersistence {
  _SqlDeleteLeavesUnreadable(this.raw, SharedPreferences prefs)
      : super(raw, prefs: prefs);
  final Database raw;
  @override
  Future<void> delete(String id) => corruptSql(raw, id);
}

Future<void> corruptSql(Database db, String id) => db.update(
    kTimelineTable, <String, Object?>{'payload': _bad},
    where: 'id = ?', whereArgs: <Object?>[id]);

Future<int> physicalSql(Database db, String id) async => (await db.query(
        kTimelineTable,
        columns: <String>['id'],
        where: 'id = ?',
        whereArgs: <Object?>[id]))
    .length;

/// The production opener (so the schema is the shipped one), plus a raw
/// handle onto the same in-memory database for corruption and the controls.
Future<(SqfliteTimelinePersistence, Database)> _sqlite() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
  final TimelineStorageOpen opened = await openTimelinePersistence(
      prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi,
      path: inMemoryDatabasePath);
  expect(opened.kind, TimelineStorageKind.sqlite);
  final Database db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
  return (opened.persistence as SqfliteTimelinePersistence, db);
}

/// The fallback's own row key (`SharedPrefsTimelinePersistence._key`).
String _prefsKey(String id) =>
    'flowmic.timeline.pending.v3.${Uri.encodeComponent(id)}';

/// The fallback whose `delete` returns but leaves an undecodable value.
class _PrefsDeleteLeavesUnreadable extends SharedPrefsTimelinePersistence {
  _PrefsDeleteLeavesUnreadable(this.prefs)
      : super(prefs, sqliteFile: SqliteFileEvidence.absent);
  final SharedPreferences prefs;
  @override
  Future<void> delete(String id) async {
    await prefs.setString(_prefsKey(id), _bad);
  }
}

Future<SharedPreferences> _prefs() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return SharedPreferences.getInstance();
}

TimelineEntry _row(TimelineStore t, String clientId, String text,
        {String? article, int? offsetMs}) =>
    t.buildFromUtterance(
      clientId: clientId,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: text,
      articleId: article,
      articleOffsetMs: offsetMs,
      durationMs: 1000,
    );

Future<String> _pressLegacy(LegacyRig r, String key) async {
  await r.seed(key);
  await r.store.markUnverified(0, session: key);
  r.relay.replyWords('Fresh words from this press');
  final PendingRetryOutcome out =
      await r.pending.retryNow((await r.pending.list()).single);
  await r.idle();
  return out.name;
}

void main() {
  setUpAll(sqfliteFfiInit);

  group('SQLite (production store)', () {
    test('unmodified reader: an undecodable row is not proven absent', () async {
      final (SqfliteTimelinePersistence p, Database db) = await _sqlite();
      addTearDown(p.close);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'direct-unreadable', 'Before.');
      await t.awaitPersisted(row.id);
      await corruptSql(db, row.id);
      expect(await physicalSql(db, row.id), 1, reason: 'control: on disk');
      await p.loadAll();
      expect(p.unreadableRowIds, contains(row.id),
          reason: 'control: the production decoder cannot read it');
      expect(await provenGone(t, row.id), isFalse,
          reason: 'an unreadable physical row cannot be proven absent');
    });

    test('control: a row really deleted is proven absent', () async {
      final (SqfliteTimelinePersistence p, Database db) = await _sqlite();
      addTearDown(p.close);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'really-gone', 'Gone.');
      await t.awaitPersisted(row.id);
      expect(await removeRowsDurably(t, <TimelineEntry>[row]), isTrue);
      expect(await physicalSql(db, row.id), 0);
    });

    test('removal helper: a delete that leaves an undecodable row is unproven',
        () async {
      final (SqfliteTimelinePersistence opened, Database db) = await _sqlite();
      addTearDown(opened.close);
      final _SqlDeleteLeavesUnreadable p = _SqlDeleteLeavesUnreadable(
          db, await SharedPreferences.getInstance());
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'decode-readback', 'Stored text.');
      await t.awaitPersisted(row.id);
      final bool removed = await removeRowsDurably(t, <TimelineEntry>[row]);
      expect(await physicalSql(db, row.id), 1, reason: 'control: still there');
      await p.loadAll();
      expect(p.unreadableRowIds, contains(row.id), reason: 'control');
      expect(removed, isFalse, reason: 'a failed decode must not license it');
    });

    test('real legacy press: unproven removal fails and keeps the audio',
        () async {
      final (SqfliteTimelinePersistence opened, Database db) = await _sqlite();
      addTearDown(opened.close);
      final _SqlDeleteLeavesUnreadable p = _SqlDeleteLeavesUnreadable(
          db, await SharedPreferences.getInstance());
      final LegacyRig r = await LegacyRig.open(persistence: p);
      addTearDown(r.dispose);
      const String key = 'r6-sql-legacy';
      final String out = await _pressLegacy(r, key);
      final int invalid = (await db.query(kTimelineTable,
              columns: <String>['payload'],
              where: 'payload = ?',
              whereArgs: <Object?>[_bad]))
          .length;
      expect(invalid, 1, reason: 'control: the replay row is still on disk');
      expect(out, PendingRetryOutcome.failed.name,
          reason: 'unknown removal is failure');
      expect(await r.store.bytesForSession(key), 6400,
          reason: 'the audio stays when removal is unproven');
    });

    test('in place: an undecodable member of the article blocks replacement',
        () async {
      final (SqfliteTimelinePersistence p, Database db) = await _sqlite();
      addTearDown(p.close);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry old =
          _row(t, 'old', 'Earlier words.', article: 'art-1', offsetMs: 0);
      final TimelineEntry fresh =
          _row(t, 'new', 'The whole recording.', article: 'art-1', offsetMs: 0);
      await t.awaitPersisted(old.id);
      await t.awaitPersisted(fresh.id);
      await corruptSql(db, old.id);
      expect(await physicalSql(db, old.id), 1, reason: 'control');
      expect(
          await replaceKeptRowsInPlace(
              timeline: t,
              articleId: 'art-1',
              ownedRowIds: <String>[fresh.id],
              rangeEndMs: 10000),
          isFalse,
          reason: 'a member storage cannot read would survive beside the new');
      expect(await physicalSql(db, old.id), 1);
    });

    test('in place: an undecodable row of ANOTHER article does not block',
        () async {
      final (SqfliteTimelinePersistence p, Database db) = await _sqlite();
      addTearDown(p.close);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry other =
          _row(t, 'other', 'Somebody else.', article: 'art-2', offsetMs: 0);
      final TimelineEntry old =
          _row(t, 'old', 'Earlier words.', article: 'art-1', offsetMs: 0);
      final TimelineEntry fresh =
          _row(t, 'new', 'The whole recording.', article: 'art-1', offsetMs: 0);
      for (final TimelineEntry e in <TimelineEntry>[other, old, fresh]) {
        await t.awaitPersisted(e.id);
      }
      await corruptSql(db, other.id);
      expect(
          await replaceKeptRowsInPlace(
              timeline: t,
              articleId: 'art-1',
              ownedRowIds: <String>[fresh.id],
              rangeEndMs: 10000),
          isTrue);
      expect(await physicalSql(db, old.id), 0);
      expect(await physicalSql(db, other.id), 1,
          reason: 'corrupt bytes are never removed');
    });

    test('an article whose only rows are undecodable still has stored rows',
        () async {
      final (SqfliteTimelinePersistence p, Database db) = await _sqlite();
      addTearDown(p.close);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry old =
          _row(t, 'old', 'Earlier words.', article: 'art-1', offsetMs: 0);
      await t.awaitPersisted(old.id);
      await corruptSql(db, old.id);
      expect(await replaceableArticles(t, <String>{'art-1', 'art-9'}),
          <String>{'art-1'},
          reason: 'not 「no stored rows」 ⇒ never the note path that releases');
    });
  });

  group('SharedPrefs fallback', () {
    test('unmodified reader: an undecodable row is not proven absent', () async {
      final SharedPreferences prefs = await _prefs();
      final SharedPrefsTimelinePersistence p =
          SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'direct-unreadable', 'Before.');
      await t.awaitPersisted(row.id);
      await prefs.setString(_prefsKey(row.id), _bad);
      expect(prefs.get(_prefsKey(row.id)), _bad, reason: 'control: stored');
      await p.loadAll();
      expect(p.unreadableRowIds, contains(row.id), reason: 'control');
      expect(await provenGone(t, row.id), isFalse);
    });

    test('control: a row really deleted is proven absent', () async {
      final SharedPreferences prefs = await _prefs();
      final TimelineStore t =
          newTestStore(persistence: SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent));
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'really-gone', 'Gone.');
      await t.awaitPersisted(row.id);
      expect(await removeRowsDurably(t, <TimelineEntry>[row]), isTrue);
      expect(prefs.containsKey(_prefsKey(row.id)), isFalse);
    });

    test('removal helper: a delete that leaves an undecodable value is unproven',
        () async {
      final SharedPreferences prefs = await _prefs();
      final _PrefsDeleteLeavesUnreadable p = _PrefsDeleteLeavesUnreadable(prefs);
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = _row(t, 'decode-readback', 'Stored text.');
      await t.awaitPersisted(row.id);
      final bool removed = await removeRowsDurably(t, <TimelineEntry>[row]);
      expect(prefs.get(_prefsKey(row.id)), _bad, reason: 'control');
      expect(removed, isFalse);
    });

    test('real legacy press: unproven removal fails and keeps the audio',
        () async {
      final SharedPreferences prefs = await _prefs();
      final _PrefsDeleteLeavesUnreadable p = _PrefsDeleteLeavesUnreadable(prefs);
      final LegacyRig r = await LegacyRig.open(persistence: p);
      addTearDown(r.dispose);
      const String key = 'r6-prefs-legacy';
      final String out = await _pressLegacy(r, key);
      final int invalid = <String>[
        for (final String k in prefs.getKeys())
          if (k.startsWith('flowmic.timeline.pending.v3.') &&
              prefs.get(k) == _bad)
            k,
      ].length;
      expect(invalid, 1, reason: 'control: the replay row is still stored');
      expect(out, PendingRetryOutcome.failed.name);
      expect(await r.store.bytesForSession(key), 6400);
    });

    test('in place: an undecodable row the fallback cannot attribute blocks',
        () async {
      final SharedPreferences prefs = await _prefs();
      final TimelineStore t =
          newTestStore(persistence: SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent));
      addTearDown(t.dispose);
      final TimelineEntry old =
          _row(t, 'old', 'Earlier words.', article: 'art-1', offsetMs: 0);
      final TimelineEntry fresh =
          _row(t, 'new', 'The whole recording.', article: 'art-1', offsetMs: 0);
      await t.awaitPersisted(old.id);
      await t.awaitPersisted(fresh.id);
      await prefs.setString(_prefsKey(old.id), _bad);
      expect(
          await replaceKeptRowsInPlace(
              timeline: t,
              articleId: 'art-1',
              ownedRowIds: <String>[fresh.id],
              rangeEndMs: 10000),
          isFalse);
      expect(prefs.get(_prefsKey(old.id)), _bad);
    });

    test('in place: a row attributed to ANOTHER article does not block',
        () async {
      final SharedPreferences prefs = await _prefs();
      final TimelineStore t =
          newTestStore(persistence: SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent));
      addTearDown(t.dispose);
      final TimelineEntry old =
          _row(t, 'old', 'Earlier words.', article: 'art-1', offsetMs: 0);
      final TimelineEntry fresh =
          _row(t, 'new', 'The whole recording.', article: 'art-1', offsetMs: 0);
      await t.awaitPersisted(old.id);
      await t.awaitPersisted(fresh.id);
      // Valid JSON naming its article, but not a row the decoder accepts.
      await prefs.setString(
          _prefsKey('stray'), '{"id":"stray","article_id":"art-2"}');
      expect(
          await replaceKeptRowsInPlace(
              timeline: t,
              articleId: 'art-1',
              ownedRowIds: <String>[fresh.id],
              rangeEndMs: 10000),
          isTrue);
      expect(prefs.containsKey(_prefsKey(old.id)), isFalse);
      expect(prefs.containsKey(_prefsKey('stray')), isTrue);
    });
  });
}
