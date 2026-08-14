// V2-06b UI — the search box and the paged tail on 全部历史.
//
// Three failures this guards, all of the "looks fine but is lying" kind:
//   ① showing 「还没有历史记录」 when a SEARCH found nothing — the user reads it
//     as "my records are gone", not as "no hits";
//   ② a search that filters the loaded page instead of asking storage, so it
//     finds less the less you have scrolled;
//   ③ a blank tail at the bottom, which looks identical whether more is
//     loading or there is nothing left — and the user waits forever for the
//     second one.

import 'support/di.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart' show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _s = AppStringsZh();

TimelineEntry _row(int i, String text) {
  final DateTime t = DateTime.utc(2026, 1, 1).add(Duration(minutes: i));
  return TimelineEntry(
    id: 'e$i',
    clientId: 'e$i',
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: text,
    outputText: text,
    status: EntryStatus.noted,
    createdAt: t,
    updatedAt: t,
  );
}

Future<TimelineStore> _storeWith(List<TimelineEntry> rows) async {
  final InMemoryTimelinePersistence p = InMemoryTimelinePersistence();
  for (final TimelineEntry e in rows) {
    await p.upsert(e);
  }
  final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
  await store.load();
  return store;
}

Widget _page(TimelineStore store) => MaterialApp(
  home: HistoryPage(store: store, storageKind: TimelineStorageKind.sqlite),
);

void main() {
  testWidgets('searching finds a row that is NOT in the loaded page', (
    WidgetTester tester,
  ) async {
    // The needle is the oldest row, far above the first page — a search
    // implemented over `entries` returns nothing here.
    final List<TimelineEntry> rows = <TimelineEntry>[
      _row(0, '很久以前说的那句关键词'),
      for (int i = 1; i < TimelineStore.pageSize * 2; i++) _row(i, '普通的一行'),
    ];
    final TimelineStore store = await _storeWith(rows);
    addTearDown(store.dispose);

    await tester.pumpWidget(_page(store));
    await tester.pumpAndSettle();
    expect(
      store.entries.any((TimelineEntry e) => e.id == 'e0'),
      isFalse,
      reason: 'precondition: the needle is not loaded',
    );

    await tester.enterText(find.byKey(const ValueKey<String>('history.search')), '关键词');
    await tester.pumpAndSettle();

    expect(find.text('很久以前说的那句关键词'), findsOneWidget);
    expect(find.text(_s.historySearchHits(1)), findsOneWidget);
  });

  testWidgets('a search with no hits says 没有匹配的记录 — NOT 还没有历史记录', (
    WidgetTester tester,
  ) async {
    final TimelineStore store = await _storeWith(<TimelineEntry>[_row(1, '有内容')]);
    addTearDown(store.dispose);

    await tester.pumpWidget(_page(store));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey<String>('history.search')),
      '一个不存在的词',
    );
    await tester.pumpAndSettle();

    expect(find.text(_s.historySearchNoHit), findsOneWidget);
    expect(
      find.text(_s.historyEmpty),
      findsNothing,
      reason: '「还没有历史记录」on a failed search reads as "my records are gone"',
    );
  });

  testWidgets('clearing the search restores the timeline', (
    WidgetTester tester,
  ) async {
    final TimelineStore store = await _storeWith(<TimelineEntry>[
      _row(1, '第一条'),
      _row(2, '第二条'),
    ]);
    addTearDown(store.dispose);

    await tester.pumpWidget(_page(store));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const ValueKey<String>('history.search')), '第一');
    await tester.pumpAndSettle();
    expect(find.text('第二条'), findsNothing);

    await tester.tap(find.byKey(const ValueKey<String>('history.search.clear')));
    await tester.pumpAndSettle();
    expect(find.text('第一条'), findsOneWidget);
    expect(find.text('第二条'), findsOneWidget);
  });

  testWidgets('the tail SAYS 没有更早的记录了 rather than going blank', (
    WidgetTester tester,
  ) async {
    // Blank space is what "still fetching" also looks like. Saying it is the
    // difference between "we've reached the end" and a user waiting for a page
    // that will never come.
    final TimelineStore store = await _storeWith(<TimelineEntry>[_row(1, '唯一一条')]);
    addTearDown(store.dispose);

    await tester.pumpWidget(_page(store));
    await tester.pumpAndSettle();

    expect(store.hasMore, isFalse);
    expect(find.text(_s.historyReachedEnd), findsOneWidget);
  });

  testWidgets('a full first page does NOT claim the end yet', (
    WidgetTester tester,
  ) async {
    final TimelineStore store = await _storeWith(<TimelineEntry>[
      for (int i = 0; i < TimelineStore.pageSize * 2; i++) _row(i, '行 $i'),
    ]);
    addTearDown(store.dispose);

    await tester.pumpWidget(_page(store));
    await tester.pumpAndSettle();

    expect(store.hasMore, isTrue);
    expect(
      find.text(_s.historyReachedEnd),
      findsNothing,
      reason: 'there IS more — claiming the end would hide it',
    );
  });
}
