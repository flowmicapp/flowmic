import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_recovery_failures.dart';
import 'support/di.dart';
import 'support/temp_teardown.dart';

void main() {
  test('acknowledged identities survive restart, subsets, ordering and a new kind', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final first = TimelineRecoveryFailures(prefs: prefs); addTearDown(first.dispose);
    first.recordCorruption('storage', ['row-a', 'row-b']);
    first.dismissNotice(); await first.acknowledgement;
    final restarted = TimelineRecoveryFailures(prefs: prefs); addTearDown(restarted.dispose);
    restarted.recordCorruption('storage', ['row-b']);
    restarted.recordCorruption('storage', ['row-b', 'row-a']);
    expect(restarted.noticeTicket, isNull);
    restarted.recordCorruption('storage', ['row-c']);
    expect(restarted.noticeTicket, isNotNull);
    restarted.dismissNotice(); await restarted.acknowledgement;
    restarted.recordCorruption('cloud:another-account', ['row-a']);
    expect(restarted.noticeTicket, isNotNull);
    const key = '${TimelineRecoveryFailures.acknowledgementPrefix}storage';
    expect(prefs.getString(key), matches(RegExp(r'^[a-f0-9]{64}$')));
    expect(prefs.getStringList('$key.rows'), everyElement(matches(RegExp(r'^[a-f0-9]{64}$'))));
  });

  test('a problem arriving during acknowledgement keeps its notice', () async {
    SharedPreferences.setMockInitialValues({});
    final failures = TimelineRecoveryFailures(prefs: await SharedPreferences.getInstance());
    addTearDown(failures.dispose);
    failures.recordCorruption('storage', ['first']);
    failures.dismissNotice();
    failures.recordCorruption('storage', ['second']);
    await failures.acknowledgement;
    expect(failures.noticeTicket, isNotNull);
    failures.dismissNotice(); await failures.acknowledgement;
    expect(failures.noticeTicket, isNull);
  });

  test('a different unreadable row on page two raises a notice at the same count', () async {
    sqfliteFfiInit(); SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('same-count-');
    addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    final persistence = opened.persistence as SqfliteTimelinePersistence;
    addTearDown(persistence.close);
    final db = await databaseFactoryFfi.openDatabase(path);
    for (int i = 0; i < 71; i++) {
      final time = DateTime.utc(2026, 1, 1).add(Duration(minutes: i)).toIso8601String();
      await persistence.upsert(TimelineEntry.fromJson({'id': 'row-$i', 'client_id': 'row-$i',
        'output_text': 'note $i', 'mode': 'realtime', 'delivery': 'none', 'status': 'noted',
        'created_at': time, 'updated_at': time})!);
    }
    await db.update(kTimelineTable, {'payload': '{broken'}, where: 'id = ?', whereArgs: ['row-70']);
    final store = newTestStore(persistence: persistence, recoveryPrefs: prefs);
    addTearDown(store.dispose);
    await store.load();
    expect(store.recoveryFailures.noticeTicket, isNotNull);
    store.recoveryFailures.dismissNotice(); await store.recoveryFailures.acknowledgement;
    expect(store.recoveryFailures.noticeTicket, isNull);
    expect(prefs.getKeys().any((key) => key.startsWith(TimelineRecoveryFailures.acknowledgementPrefix)), isTrue);
    await db.update(kTimelineTable, {'payload': '{broken'}, where: 'id = ?', whereArgs: ['row-0']);
    await store.loadMore();
    expect(store.entries.where((e) => e.id == 'row-0'), isEmpty);
    expect(store.recoveryFailures.noticeTicket, isNotNull,
      reason: 'a newly unreadable note vanished with no notice');
    expect((await db.query(kTimelineTable, columns: ['payload'], where: 'id = ?', whereArgs: ['row-0'])).single['payload'], '{broken');
  });
}
