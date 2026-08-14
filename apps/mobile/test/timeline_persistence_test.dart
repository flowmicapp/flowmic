// T-6a ② — SharedPrefsTimelinePersistence disk trim (100 newest).
// Memory list is caller's concern; this file only asserts the save/load contract.

import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SharedPreferences prefs;
  late SharedPrefsTimelinePersistence store;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    prefs = await SharedPreferences.getInstance();
    store = SharedPrefsTimelinePersistence(prefs);
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

  test('>100 entries: saveAll persists exactly the 100 newest', () async {
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
    expect(loaded.length, SharedPrefsTimelinePersistence.maxPersistedEntries);

    final Set<String> ids = loaded.map((TimelineEntry e) => e.clientId).toSet();
    // Newest 100 = e20..e119 (createdAt seconds 20..119).
    for (int i = 20; i < 120; i++) {
      expect(ids.contains('e$i'), isTrue, reason: 'missing newest e$i');
    }
    for (int i = 0; i < 20; i++) {
      expect(ids.contains('e$i'), isFalse, reason: 'stale e$i should be trimmed');
    }
  });

  test('loadAll after a trimmed save does not throw', () async {
    final DateTime base = DateTime.utc(2026, 7, 25, 4);
    await store.saveAll(<TimelineEntry>[
      for (int i = 0; i < 105; i++) _entry('r$i', base.add(Duration(minutes: i))),
    ]);
    await expectLater(store.loadAll(), completes);
    final List<TimelineEntry> loaded = await store.loadAll();
    expect(loaded.length, 100);
    expect(loaded.every((TimelineEntry e) => e.clientId.startsWith('r')), isTrue);
  });
}
