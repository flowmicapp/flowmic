// NR-146 — fallback keeps every row and rejects unconfirmed writes.
// Memory list is caller's concern; this file only asserts the save/load contract.

import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_platform_interface/types.dart';
import 'support/di.dart';

TimelineEntry _entry(String id, DateTime createdAt) => TimelineEntry(
      id: 'loc_test_$id',
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      sourceText: 't-$id',
      outputText: 't-$id',
      status: EntryStatus.cached,
      createdAt: createdAt,
      updatedAt: createdAt,
    );

class _RefusingPrefs extends InMemorySharedPreferencesStore {
  _RefusingPrefs() : super.empty();
  @override
  Future<bool> setValue(String valueType, String key, Object value) async => false;
}

class _AcknowledgesWithoutWriting extends InMemorySharedPreferencesStore {
  _AcknowledgesWithoutWriting() : super.empty();
  @override
  Future<bool> setValue(String valueType, String key, Object value) async => true;
}
class _ThrowingPrefs extends InMemorySharedPreferencesStore {
  _ThrowingPrefs() : super.empty();
  bool throwWrites = true;
  bool throwDeletes = false;
  @override
  Future<bool> setValue(String valueType, String key, Object value) async {
    if (throwWrites) throw StateError('platform write exception');
    return super.setValue(valueType, key, value);
  }
  @override
  Future<bool> remove(String key) async {
    if (throwDeletes) throw StateError('platform delete exception');
    return super.remove(key);
  }
}
class _MeasuredPrefs extends InMemorySharedPreferencesStore {
  _MeasuredPrefs() : super.empty();
  final writes = <String>[];
  final reads = <GetAllParameters>[];
  @override
  Future<Map<String, Object>> getAllWithParameters(GetAllParameters parameters) async {
    reads.add(parameters);
    return super.getAllWithParameters(parameters);
  }
  @override
  Future<bool> setValue(String valueType, String key, Object value) async {
    if (value is String) writes.add(value);
    return super.setValue(valueType, key, value);
  }
}
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SharedPreferences prefs;
  late SharedPrefsTimelinePersistence store;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    prefs = await SharedPreferences.getInstance();
    store = SharedPrefsTimelinePersistence(prefs);
  });

  test('setString false is surfaced through the production write notice', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    SharedPreferencesStorePlatform.instance = _RefusingPrefs();
    prefs = await SharedPreferences.getInstance();
    store = SharedPrefsTimelinePersistence(prefs);
    final timeline = newTestStore(persistence: store);
    addTearDown(timeline.dispose);
    final row = timeline.buildFromUtterance(clientId: 'refused',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'kept in memory');
    await timeline.awaitPersisted(row.id);
    expect(timeline.writeFailures.noticeTicket, isNotNull);
    expect(timeline.entries.single.id, row.id);
    expect(await timeline.isPersisted(row.id), isFalse);
    await expectLater(store.saveAll(<TimelineEntry>[row]), throwsStateError);
  });

  test('iOS-style acknowledgement without a write raises the production notice', () async {
    SharedPreferencesStorePlatform.instance = _AcknowledgesWithoutWriting();
    prefs = await SharedPreferences.getInstance();
    final timeline = newTestStore(persistence: SharedPrefsTimelinePersistence(prefs));
    addTearDown(timeline.dispose);
    final row = timeline.buildFromUtterance(clientId: 'ios-refused',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'visible unsaved sentence');
    await timeline.awaitPersisted(row.id);
    expect(timeline.writeFailures.noticeTicket, isNotNull);
    expect(await timeline.isPersisted(row.id), isFalse);
  });
  test('a save encodes one row regardless of history length', () async {
    final platform = _MeasuredPrefs(); SharedPreferencesStorePlatform.instance = platform;
    prefs = await SharedPreferences.getInstance();
    store = SharedPrefsTimelinePersistence(prefs);
    for (int i = 0; i < 120; i++) { await store.upsert(_entry('b$i', DateTime.utc(2026))); }
    platform.writes.clear();
    platform.reads.clear();
    await store.upsert(_entry('last', DateTime.utc(2026)));
    expect(platform.writes, hasLength(1));
    expect(platform.reads, hasLength(1));
    expect(platform.reads.single.filter.prefix, 'flutter.');
    expect(platform.reads.single.filter.allowList, {'flutter.flowmic.timeline.pending.v3.loc_test_last'});
    expect(platform.writes.single.length, lessThan(2500));
    expect(await store.loadAll(), hasLength(121));
  });

  test('platform exceptions cannot license phantom saves or phantom deletes', () async {
    final platform = _ThrowingPrefs(); SharedPreferencesStorePlatform.instance = platform;
    prefs = await SharedPreferences.getInstance(); store = SharedPrefsTimelinePersistence(prefs);
    final timeline = newTestStore(persistence: store); addTearDown(timeline.dispose);
    final row = timeline.buildFromUtterance(clientId: 'platform-exception',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'kept in memory');
    await timeline.awaitPersisted(row.id);
    expect(await timeline.isPersisted(row.id), isFalse);
    platform.throwWrites = false; await timeline.saveExternalRecord(row);
    platform.throwDeletes = true; timeline.delete(row.id); await pumpEventQueue();
    expect(timeline.findById(row.id), isNotNull);
    expect(await store.loadById(row.id), isNotNull);
    platform.throwDeletes = false; timeline.delete(row.id); await pumpEventQueue();
    expect(timeline.findById(row.id), isNull);
    expect(await store.loadById(row.id), isNull);
  });

  test('≤100 entries: saveAll persists the full list', () async {
    final DateTime base = DateTime.utc(2026, 7, 25, 4);
    final List<TimelineEntry> all = <TimelineEntry>[
      for (int i = 0; i < 50; i++) _entry('e$i', base.add(Duration(seconds: i))),
    ];
    await store.saveAll(all);
    final List<TimelineEntry> loaded = await store.loadAll();
    expect(loaded.length, 50);
    expect(
      loaded.map((TimelineEntry e) => e.clientId).toSet(),
      all.map((TimelineEntry e) => e.clientId).toSet(),
    );
  });

  test('>100 entries: saveAll persists all rows', () async {
    final DateTime base = DateTime.utc(2026, 7, 25, 4);
    // Deliberately oldest-first so the trim cannot rely on input order.
    final List<TimelineEntry> all = <TimelineEntry>[
      for (int i = 0; i < 120; i++) _entry('e$i', base.add(Duration(seconds: i))),
    ];
    expect(all.length, 120);
    await store.saveAll(all);

    // Caller list must be untouched (disk trim only).
    expect(all.length, 120);

    final List<TimelineEntry> loaded = await store.loadAll();
    expect(loaded.length, 120);

    final Set<String> ids = loaded.map((TimelineEntry e) => e.clientId).toSet();
    // Newest 100 = e20..e119 (createdAt seconds 20..119).
    for (int i = 0; i < 120; i++) {
      expect(ids.contains('e$i'), isTrue, reason: 'missing newest e$i');
    }
  });

  test('loadAll after a trimmed save does not throw', () async {
    final DateTime base = DateTime.utc(2026, 7, 25, 4);
    await store.saveAll(<TimelineEntry>[
      for (int i = 0; i < 105; i++) _entry('r$i', base.add(Duration(minutes: i))),
    ]);
    await expectLater(store.loadAll(), completes);
    final List<TimelineEntry> loaded = await store.loadAll();
    expect(loaded.length, 105);
    expect(loaded.every((TimelineEntry e) => e.clientId.startsWith('r')), isTrue);
  });
}
