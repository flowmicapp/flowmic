// REQ-12-09 09-B/09-C — the 「+」 panel's light-records tab: the three states and the
// search box.
//
// SPEC-REF: docs/strategy/2026-08-12-req1209-plus-panel-design.md §3-3, §5-1, §9.
//
// 🔴 THE ONE THAT MATTERS is state B: signed out, and the rows ARE on disk. The
// easy implementation ——「signed out ⇒ show empty」—— is a lie in the direction book 15 F2
// forbids just as hard as inventing data, and it is the one a reader would
// assume is correct. Its reverse control is exactly that implementation, and it
// was OBSERVED RED before this file was left green.
//
// ⚠️ THE STORE HERE IS [InMemoryTimelinePersistence], AND THAT IS A MEASUREMENT
// CONSTRAINT, NOT A SHORTCUT. `testWidgets` runs inside a FakeAsync zone, and
// sqflite_common_ffi's futures are real I/O that never completes there — the
// widget would sit on its loading line forever and `pumpAndSettle` would hang
// (measured: the first draft of this file did exactly that). What is NOT lost:
// the widget still talks to the real [LightRecordQuery], and the property that
// needs a real database — the 200-row truncation the origin narrowing has to
// run ahead of — is pinned against actual SQLite in
// `light_record_query_test.dart`. So the two files split the job rather than
// one of them faking it.
//
// ⚠️ And `pumpAndSettle` is avoided after the search box has focus: a focused
// `TextField` blinks its caret forever, so「settle」never arrives. The pumps
// below are explicit for that reason.

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
// The debounce is imported rather than re-typed as `Duration(milliseconds: 250)`
// — a test that hard-codes the wait passes for a while after someone changes the
// constant, and then starts failing for a reason nobody can find.
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart'
    show kLightRecordSearchDebounce;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

TimelineEntry _entry(
  String id, {
  required String origin,
  required String text,
  required DateTime at,
  String entryType = TimelineEntry.kTranscript,
}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  createdAt: at,
  updatedAt: at,
  origin: origin,
  entryType: entryType,
);

Future<TimelinePersistence> _store() async => InMemoryTimelinePersistence();

Future<Widget> _panel({
  required TimelinePersistence persistence,
  required bool signedIn,
  Future<void> Function()? onSignIn,
  AppStrings strings = _zh,
}) async => MaterialApp(
  home: Scaffold(
    body: PlusPanel(
      favorites: FavoritesStore(prefs: InMemoryLocalPrefs()),
      strings: strings,
      buffer: '',
      noPcTarget: false,
      onSend: (_) {},
      onFeedback: (_) {},
      lightRecords: LightRecordQuery(persistence: persistence),
      isSignedIn: () => signedIn,
      onSignIn: onSignIn,
    ),
  ),
);

/// Open the panel, switch to light-records, and let the store read land.
Future<void> _openNotes(WidgetTester tester, Widget w) async {
  await tester.pumpWidget(w);
  await tester.tap(find.byKey(const ValueKey<String>('plus.tab.notes')));
  await tester.pump(); // tab switch → the tab mounts and starts its read
  await tester.pump(); // the read resolves → setState
}

/// Type into the search box and let the debounce + query land. Explicit pumps
/// rather than `pumpAndSettle` — see the file header (caret blink).
Future<void> _search(WidgetTester tester, String q) async {
  await tester.enterText(find.byKey(const ValueKey<String>('plus.notes.search')), q);
  await tester.pump(); // controller listener → debounce armed (or cleared)
  await tester.pump(kLightRecordSearchDebounce); // the timer fires
  await tester.pump(); // the query resolves → setState
}

void main() {

  testWidgets('09-B: the panel opens on Favorites (the tab that existed before this '
      'card), with a light-records tab beside it', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await tester.pumpWidget(await _panel(persistence: p, signedIn: true));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey<String>('plus.tab.favorites')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('plus.tab.notes')), findsOneWidget);
    // Favorites' own empty state is what is on screen — i.e. the default tab is Favorites.
    expect(find.text(_zh.favoritesEmpty), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('plus.notes.search')), findsNothing);
  });

  testWidgets('anti-façade: no light-records source ⇒ no tab bar at all, not an empty tab',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlusPanel(
            favorites: FavoritesStore(prefs: InMemoryLocalPrefs()),
            strings: _zh,
            buffer: '',
            noPcTarget: false,
            onSend: (_) {},
            onFeedback: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('plus.tab.notes')), findsNothing);
    expect(find.byKey(const ValueKey<String>('plus.tab.favorites')), findsNothing);
  });

  testWidgets('09-B state A: signed out with nothing on disk — the sentence AND '
      'a sign-in entry point', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    // A paired row exists, so 「empty」 here means 「no LIGHT RECORDS」 rather than
    // 「no rows at all」 — the narrowing is part of what state A asserts.
    await p.upsert(_entry('paired-1',
        origin: 'paired', text: '发给电脑的一句话', at: DateTime.utc(2026, 8, 1)));

    int signIns = 0;
    await _openNotes(
      tester,
      await _panel(
        persistence: p,
        signedIn: false,
        onSignIn: () async => signIns++,
      ),
    );

    expect(
      find.byKey(const ValueKey<String>('plus.notes.state.signedOutEmpty')),
      findsOneWidget,
    );
    expect(find.text(_zh.lightRecordsSignedOutEmpty), findsOneWidget);
    // The entry point is REAL, not a label: tapping it runs the callback.
    await tester.tap(find.byKey(const ValueKey<String>('plus.notes.signin')));
    await tester.pumpAndSettle();
    expect(signIns, 1);
  });

  testWidgets('09-B state A without a sign-in route: the fact is stated and no '
      'button is drawn', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await _openNotes(tester, await _panel(persistence: p, signedIn: false));

    expect(find.text(_zh.lightRecordsSignedOutEmpty), findsOneWidget);
    // A button that goes nowhere is the affordance this panel refuses to ship.
    expect(find.byKey(const ValueKey<String>('plus.notes.signin')), findsNothing);
  });

  testWidgets('🔴 09-B state B: signed OUT while rows are on disk — the rows are '
      'LISTED, with a note bounding what the list claims',
      (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-2',
        origin: 'cloud', text: '周三还书', at: DateTime.utc(2026, 8, 2)));

    await _openNotes(tester, await _panel(persistence: p, signedIn: false));

    // 🔴 The rows are really there, so hiding them would be a lie — the same red
    // line, in the other direction, as inventing them.
    expect(find.text('牛奶和鸡蛋'), findsOneWidget);
    expect(find.text('周三还书'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('plus.notes.state.signedOutNotice')),
      findsOneWidget,
    );
    expect(find.text(_zh.lightRecordsSignedOutNotice), findsOneWidget);
    // …and it must NOT be the 「you have no light records」 face.
    expect(find.text(_zh.lightRecordsEmpty), findsNothing);
  });

  testWidgets('09-B state C: signed in — the rows are listed and nothing extra '
      'is said', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));

    expect(find.text('牛奶和鸡蛋'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('plus.notes.state.signedOutNotice')),
      findsNothing,
    );
    expect(find.text(_zh.lightRecordsSignedOutNotice), findsNothing);
  });

  testWidgets('09-B: signed in with genuinely no light records says so — a '
      'different sentence from 「no match」', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await _openNotes(tester, await _panel(persistence: p, signedIn: true));

    expect(find.byKey(const ValueKey<String>('plus.notes.empty')), findsOneWidget);
    expect(find.text(_zh.lightRecordsEmpty), findsOneWidget);
    expect(find.text(_zh.lightRecordsSearchNoMatch), findsNothing);
  });

  testWidgets('09-C: typing filters to the matching note; clearing the box '
      'returns the full list', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-2',
        origin: 'cloud', text: '周三还书', at: DateTime.utc(2026, 8, 2)));

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));

    await _search(tester, '还书');
    expect(find.text('周三还书'), findsOneWidget);
    expect(find.text('牛奶和鸡蛋'), findsNothing);

    // 🔴 An empty box is not a search that found nothing — it is 「back to the full list」.
    await _search(tester, '');
    expect(find.text('周三还书'), findsOneWidget);
    expect(find.text('牛奶和鸡蛋'), findsOneWidget);
    expect(find.text(_zh.lightRecordsSearchNoMatch), findsNothing);
  });

  testWidgets('09-C: a search that matched nothing says THAT, not 「you don\'t have light records yet」',
      (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));
    await _search(tester, '不存在的词');

    expect(find.byKey(const ValueKey<String>('plus.notes.noMatch')), findsOneWidget);
    expect(find.text(_zh.lightRecordsSearchNoMatch), findsOneWidget);
    expect(find.text(_zh.lightRecordsEmpty), findsNothing);
  });

  testWidgets('🔴 09-C: a note deep in history is found WITHOUT scrolling first '
      '— the box asks storage, not the rendered list',
      (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-ancient',
        origin: 'cloud', text: '抽屉里的备用钥匙', at: DateTime.utc(2025, 3, 3)));
    for (int i = 0; i < 200; i++) {
      await p.upsert(_entry('cloud-$i',
          origin: 'cloud',
          text: '日常第 $i 条',
          at: DateTime.utc(2026, 8, 1).add(Duration(minutes: i))));
    }

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));

    // The oldest row is at the BOTTOM of a 201-row list. Nothing scrolls in this
    // test — if the search filtered what is rendered, this row was never built
    // and could not be found.
    expect(find.text('抽屉里的备用钥匙'), findsNothing);
    await _search(tester, '备用钥匙');
    expect(find.text('抽屉里的备用钥匙'), findsOneWidget);
  });

  testWidgets('09-C: a picture note shows its label (existing behaviour, now '
      'visible), and that label is searchable', (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-img',
        origin: 'cloud',
        text: '🖼 PNG · 214 KB',
        at: DateTime.utc(2026, 8, 1),
        entryType: TimelineEntry.kImage));

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));
    expect(find.text('🖼 PNG · 214 KB'), findsOneWidget);

    await _search(tester, 'png');
    expect(find.text('🖼 PNG · 214 KB'), findsOneWidget);
  });

  testWidgets('09-B: read-only for now — a note row has no tap target',
      (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));

    await _openNotes(tester, await _panel(persistence: p, signedIn: true));

    // 09-D/09-F (multi-select and send) are not in this card. The honest shape
    // of 「not done yet」 is no control, never a dead one.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey<String>('plus.notes.row.cloud-1')),
        matching: find.byType(InkWell),
      ),
      findsNothing,
    );
  });

  testWidgets('i18n: the tab and its three states are not zh-only',
      (WidgetTester tester) async {
    final TimelinePersistence p = await _store();
    await _openNotes(
      tester,
      await _panel(persistence: p, signedIn: false, strings: _en),
    );
    expect(find.text(_en.lightRecordsSignedOutEmpty), findsOneWidget);
    expect(find.text(_en.cloudInstance), findsOneWidget);
    // …and the four-language table really has four entries for every key this
    // tab renders (a missing one is a compile error, but a zh string copied
    // into the en slot is not).
    for (final AppLocale l in AppLocale.values) {
      final AppStrings s = AppStrings.of(l);
      expect(s.lightRecordsSignedOutEmpty.trim(), isNotEmpty);
      expect(s.lightRecordsSignedOutNotice.trim(), isNotEmpty);
      expect(s.lightRecordsEmpty.trim(), isNotEmpty);
      expect(s.lightRecordsSearchHint.trim(), isNotEmpty);
      expect(s.lightRecordsSearchNoMatch.trim(), isNotEmpty);
      expect(s.lightRecordsLoading.trim(), isNotEmpty);
    }
  });
}
