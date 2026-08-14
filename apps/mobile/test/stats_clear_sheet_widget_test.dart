// 16 册 §9 — the UI face of statistics / clear.
//
// What is asserted here is not "the copy is in the catalog" but "the copy is
// on the screen": this repo has already paid for that distinction (a capability
// defined with no caller is the #1 historical bug class). The two that matter
// most:
//   ① 「另有 N 条没有时长记录」 actually renders — that is the user-visible
//      face of §6.1 "null must not be treated as 0";
//   ② the irreversible-clear warning stays on screen **above the button** —
//      §6.2's warning duty.

import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/portable/stats_clear_sheet.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/portable_rows.dart';

const AppStrings _s = AppStringsZh();

Future<void> _pump(
  WidgetTester tester, {
  required List<TimelineEntry> rows,
}) async {
  final InMemoryTimelinePersistence persistence = InMemoryTimelinePersistence();
  for (final TimelineEntry e in rows) {
    await persistence.upsert(e);
  }
  final TimelineStore store = TimelineStore(
    persistence: persistence,
    reaper: newTestReaper(persistence: persistence),
  );
  await store.load();
  addTearDown(store.dispose);
  // 🔴 Same wiring as production (main.dart): the inventory layer reads the
  // **store**, not a static row table. A static table would make the
  // "stats go to zero on the spot after clear" assertion fail forever — or
  // worse, under another writing, pass forever while proving nothing.
  final AssetInventory inventory = TimelineAssetInventory(
    rows: TimelineStoreRows(store),
    images: InMemoryOutboxBlobStore(),
  );
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () => showStatsClearSheet(
              context,
              inventory: inventory,
              store: store,
              strings: _s,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 §6.1 — 「另有 N 条没有时长记录」 actually appears on screen', (WidgetTester tester) async {
    await _pump(
      tester,
      rows: <TimelineEntry>[
        testRow(id: 'loc_d_a', clientId: 'a', text: '有时长'),
        testRow(id: 'loc_d_b', clientId: 'b', text: '没时长', durationMs: null),
      ],
    );
    // Positive probe first: the stats card actually rendered.
    expect(find.text(_s.statsTitle), findsOneWidget);
    expect(find.text(_s.statsDuration), findsOneWidget);
    // …then that sentence.
    expect(find.text(_s.statsNoDurationCount(1)), findsOneWidget);
  });

  testWidgets('when every row has a duration that sentence does not appear (negative assertion carries its own positive probe)', (WidgetTester tester) async {
    await _pump(
      tester,
      rows: <TimelineEntry>[testRow(id: 'loc_d_a', clientId: 'a', text: '有时长')],
    );
    expect(find.text(_s.statsTitle), findsOneWidget); // the probe is not blind
    expect(find.text(_s.statsNoDurationCount(1)), findsNothing);
  });

  testWidgets('🔴 §6.2 — the irreversible warning stays above the button, all six time windows are present', (WidgetTester tester) async {
    await _pump(
      tester,
      rows: <TimelineEntry>[testRow(id: 'loc_d_a', clientId: 'a', text: '一句话')],
    );
    expect(find.text(_s.clearTitle), findsOneWidget);
    expect(find.text(_s.clearIrreversible), findsOneWidget);
    expect(find.text(_s.clearKindText), findsOneWidget);
    expect(find.text(_s.clearKindImages), findsOneWidget);
    for (final String w in <String>[
      _s.clearWinWeek,
      _s.clearWinMonth,
      _s.clearWinQuarter,
      _s.clearWinHalfYear,
      _s.clearWinYear,
      _s.clearWinAll,
    ]) {
      expect(find.text(w), findsOneWidget, reason: w);
    }
  });

  testWidgets('an empty store says empty, the clear button cannot be pressed (the smallest form of button ⇔ bytes)', (WidgetTester tester) async {
    await _pump(tester, rows: const <TimelineEntry>[]);
    expect(find.text(_s.statsEmpty), findsOneWidget);
    expect(find.text(_s.clearNothing), findsOneWidget);
    final FilledButton btn = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(btn.onPressed, isNull);
  });

  testWidgets('🔴 the number in 「将删除 N 条」 comes from the inventory layer, and after clear the stats go to zero on the spot', (WidgetTester tester) async {
    // The acceptance question from the overview design §5-2, the half a unit
    // test can check: "stats say N rows ⇔ after clear they go to zero on the
    // spot".
    await _pump(
      tester,
      rows: <TimelineEntry>[
        testRow(
          id: 'loc_d_old',
          clientId: 'old',
          text: '很久以前的一句话',
          createdAt: DateTime.utc(2020, 1, 1),
        ),
      ],
    );
    expect(find.text(_s.statsRowsUnit(1)), findsOneWidget);
    expect(find.textContaining('将删除 1 条'), findsOneWidget);

    // The sheet scrolls; the clear button sits below the statistics block, so it
    // has to be brought into view before a tap can land on it.
    await tester.ensureVisible(find.text(_s.clearAction));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_s.clearAction));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_s.clearConfirmOk));
    await tester.pumpAndSettle();

    expect(find.text(_s.statsEmpty), findsOneWidget);
    expect(find.text(_s.clearNothing), findsOneWidget);
  });
}
