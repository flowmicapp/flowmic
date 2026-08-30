// Card NR-3 —— 🔴 **wiring** test for the all-history page's new interactions.
//
// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 8
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §3
//     (「把聊天页的长按菜单 + EntrySelection + SelectionBar 原样接到
//       history_page.dart」 — 「不为历史页另造第二套菜单」)
//
// Written to the same rule as `selection_wire_test.dart`, and for the same
// reason it exists: this page's defect was never 「the component is missing」,
// it was 「the component is right there and the page passes it no callbacks」.
// A test that asserts 「HistoryPage imports EntrySelection」 would have been
// green for the entire year this page was read-only. So every case below
// operates the REAL page: a real long press, a real menu tap, a real toolbar,
// a real confirm dialog.
//
// ⚠️ This window has **no real device**. Everything below is
// 「unit-test proven + real-device unproven」.
//
// ── 🔴 REVERSE CONTROL (measured, red, restored, green) ─────────────────────
// Change: in `history_page.dart`'s `itemBuilder`, drop the three gesture
// arguments again — i.e. restore the page to exactly what it was before this
// card (`selected` / `onSelectToggle` / `onLongPress` / `onZoom` removed).
// **Measured: 2 passed, 11 FAILED** — every wiring case in this file, first
// one verbatim:
//   ① the long-press menu is really hung up on this page / a long press opens
//     the SAME sheet the chat page opens
//       Expected: exactly one matching candidate
//         Actual: _TextWidgetFinder:<Found 0 widgets with text "复制": []>
//        Which: means none were found but one was expected
// 🔴 The two that stayed green are the two that are NOT about wiring (the
// nine-locale copy control, and one that never touched a row) — and every
// other suite stayed green too: `selection_bar_render_test` (14),
// `selection_batch_delete_test` (11) and every existing
// `history_page_widget_test` case. All of them are structurally blind to
// 「is it hung up」, which is exactly the year-long defect this file closes.
// Restored; `REVERSE-CONTROL-NR3-HISTORY` grep = 0; re-greened at 13.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart'
    show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodCall, SystemChannels;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const AppStrings _zh = AppStringsZh();

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

void _seed(TimelineStore store, String clientId, String text) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    text: text,
    origin: 'paired',
  );
}

/// The real page over a real store, seeded with three rows.
Future<TimelineStore> _pump(WidgetTester tester) async {
  final TimelineStore store = newTestStore(
    deviceId: 'phone',
    owner: _FakeOwner('standalone|instance:pc-study', '书房电脑'),
  );
  addTearDown(store.dispose);
  _seed(store, 'a1', '第一句');
  _seed(store, 'b1', '第二句');
  _seed(store, 'c1', '第三句');
  // A phone-tall surface: the default 800×600 virtualises rows off the tree and
  // every row-targeting finder then fails for a reason that is geometry, not
  // wiring (`selection_wire_test`'s `_pump` records the same measurement).
  tester.view.physicalSize = const Size(800 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: HistoryPage(
        store: store,
        storageKind: TimelineStorageKind.sqlite,
      ),
    ),
  );
  await tester.pump();
  return store;
}

Future<void> _enterSelection(WidgetTester tester, String rowText) async {
  await tester.longPress(find.text(rowText));
  await tester.pumpAndSettle();
  await tester.tap(find.text(_zh.selectionEnter));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('① the long-press menu is really hung up on this page', () {
    testWidgets('a long press opens the SAME sheet the chat page opens', (
      WidgetTester tester,
    ) async {
      await _pump(tester);
      await tester.longPress(find.text('第一句'));
      await tester.pumpAndSettle();

      // The four actions this page CAN perform.
      expect(find.text(_zh.entryCopy), findsOneWidget);
      expect(find.text(_zh.selectionEnter), findsOneWidget);
      expect(find.text(_zh.confirmDelete), findsOneWidget);
    });

    testWidgets(
        '🔴 the four controller-bound actions are WITHHELD, not rendered dead',
        (WidgetTester tester) async {
      // This page holds a TimelineStore and nothing else. Rendering 「补投」/
      // 「重新处理」/「编辑」/「收藏」 here and then doing nothing on tap is the
      // 0.2.27 shape (a control that changes nothing is worse than no control);
      // withholding them is the same answer every other `_can…` gate on that
      // sheet gives.
      await _pump(tester);
      await tester.longPress(find.text('第一句'));
      await tester.pumpAndSettle();

      expect(find.text(_zh.entryReInject), findsNothing);
      expect(find.text(_zh.entryReprocess), findsNothing);
      expect(find.text(_zh.entryEdit), findsNothing);
      expect(find.text(_zh.favoriteAdd), findsNothing);
    });

    testWidgets('single-row delete asks first, then really removes the row', (
      WidgetTester tester,
    ) async {
      final TimelineStore store = await _pump(tester);
      await tester.longPress(find.text('第二句'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(_zh.confirmDelete));
      await tester.pumpAndSettle();

      // 🔴 The inline second confirmation. Without it the row would go on the
      // tap that closed a menu the user reached by long-pressing.
      expect(find.text(_zh.deleteEntryConfirmTitle), findsOneWidget);
      expect(
        find.text('第二句'),
        findsOneWidget,
        reason: 'positive control: nothing is deleted before the confirm',
      );

      await tester.tap(find.text(_zh.confirmDelete).last);
      await tester.pumpAndSettle();

      expect(find.text('第二句'), findsNothing);
      expect(store.entries.map((dynamic e) => e.clientId), <String>['c1', 'a1']);
    });

    testWidgets('cancelling the confirm keeps the row', (
      WidgetTester tester,
    ) async {
      final TimelineStore store = await _pump(tester);
      await tester.longPress(find.text('第二句'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(_zh.confirmDelete));
      await tester.pumpAndSettle();
      await tester.tap(find.text(_zh.cancel));
      await tester.pumpAndSettle();

      expect(find.text('第二句'), findsOneWidget);
      expect(store.entries, hasLength(3));
    });
  });

  group('② multi-select is really hung up on this page', () {
    testWidgets('long-press → 「多选」 → the toolbar appears, seeded with that row',
        (WidgetTester tester) async {
      await _pump(tester);
      await _enterSelection(tester, '第一句');

      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsOneWidget,
      );
      // Seeded: the row the user was already holding is ticked, so the count is
      // 1 rather than 0.
      expect(find.text(_zh.selectionCount(1)), findsOneWidget);
    });

    testWidgets('a single tap ticks a row only INSIDE the mode', (
      WidgetTester tester,
    ) async {
      await _pump(tester);
      // Positive control: outside the mode a tap does nothing at all — the
      // toolbar must not appear.
      await tester.tap(find.text('第一句'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsNothing,
        reason: 'a plain tap must not enter multi-select',
      );

      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第二句'));
      await tester.pump();
      expect(find.text(_zh.selectionCount(2)), findsOneWidget);
    });

    testWidgets('🔴 batch delete: confirm names the count, then the rows go', (
      WidgetTester tester,
    ) async {
      final TimelineStore store = await _pump(tester);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第二句'));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.delete')));
      await tester.pumpAndSettle();

      // The two facts the user cannot recover afterwards. No pictures in this
      // fixture ⇒ the picture-free body, and the count is 2.
      expect(
        find.text(_zh.selectionDeleteConfirmTitle(2)),
        findsOneWidget,
      );
      expect(find.text(_zh.selectionDeleteConfirmBody(2)), findsOneWidget);
      expect(
        store.entries,
        hasLength(3),
        reason: 'positive control: nothing is deleted before the confirm',
      );

      await tester.tap(find.text(_zh.confirmDelete).last);
      await tester.pumpAndSettle();

      expect(store.entries.map((dynamic e) => e.clientId), <String>['c1']);
      expect(find.text('第一句'), findsNothing);
      expect(find.text('第二句'), findsNothing);
      expect(find.text('第三句'), findsOneWidget);
      // The mode is left after a real delete, and the result is spoken.
      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsNothing,
      );
      expect(find.text(_zh.selectionDeleted(2)), findsOneWidget);
    });

    testWidgets('🔴 pressing delete with nothing ticked says so out loud', (
      WidgetTester tester,
    ) async {
      // The 0.2.27 rule: the button stays pressable, and the answer is a
      // sentence rather than nothing happening. Reached by ticking the seeded
      // row off again, which is the only way to be in the mode at 0.
      await _pump(tester);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第一句'));
      await tester.pump();
      expect(find.text(_zh.selectionCount(0)), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey<String>('selection.delete')));
      await tester.pumpAndSettle();

      expect(find.text(_zh.selectionDeleteNoSelection), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsOneWidget,
        reason: 'a refusal must not throw away the mode the user is standing in',
      );
    });

    testWidgets('batch copy works here too, through the same two functions', (
      WidgetTester tester,
    ) async {
      // The REAL `Clipboard.setData` (the production default), with only the
      // platform channel swapped so the test can catch what went out — the same
      // arrangement `selection_wire_test` uses, rather than a test-only
      // injection port in production code.
      final List<String> clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (
            MethodCall call,
          ) async {
            if (call.method == 'Clipboard.setData') {
              clipboard.add(
                (call.arguments as Map<Object?, Object?>)['text'] as String,
              );
            }
            return null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );

      await _pump(tester);
      await _enterSelection(tester, '第一句');
      await tester.tap(find.text('第二句'));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey<String>('selection.copy')));
      await tester.pumpAndSettle();

      // 🔴 RE-JUDGED 2026-08-30, owner: 「时间早的放上面，时间迟的放下面」.
      //
      // What stood here read 「the list is newest-first, and copy follows the
      // list」 and asserted ['第二句', '第一句']. That sentence was true about the
      // implementation and wrong about the product: a clipboard is a DOCUMENT,
      // and a document that reads backwards is wrong in a way nobody can see,
      // because every line in it is correct.
      //
      // This line WAS the specification of the defect — the 0.2.52 shape: a
      // control pointing the wrong way does not miss a defect, it writes the
      // defect down as the acceptance criterion, and then goes red on the day
      // the fix arrives so that the fix looks like the mistake.
      expect(clipboard.single.split('\n'), <String>['第一句', '第二句']);
      expect(find.text(_zh.selectionCopiedRecords(2)), findsOneWidget);
    });

    testWidgets(
        '🔴 RE-JUDGED: there is NO organize button here at all (owner 2026-08-30)',
        (WidgetTester tester) async {
      // What stood here asserted that tapping organize produced a 「not here」
      // toast, and the production comment beside it argued that keeping a
      // button which can only refuse was the honest choice, because 「with-
      // holding it would mean a toolbar whose shape changes between two screens
      // showing the same rows」.
      //
      // 🔴 That is R8 with the sign flipped, and this repo has paid for R8
      // three times: a control that cannot change anything is worse than no
      // control. The differing shape is not the cost — it IS the signal, and it
      // is true, because this page has no ChatController and therefore cannot
      // organize anything.
      //
      // ⚠️ The two actions that DO work here are asserted present in the same
      // breath: without that, this case would also pass on a selection bar that
      // failed to render at all.
      await _pump(tester);
      await _enterSelection(tester, '第一句');

      expect(find.byKey(const ValueKey<String>('selection.organize')),
          findsNothing);
      expect(find.text(_zh.selectionOrganizeOffline), findsNothing,
          reason: 'the refusal went with the button that produced it');
      expect(find.byKey(const ValueKey<String>('selection.copy')),
          findsOneWidget);
      expect(find.byKey(const ValueKey<String>('selection.delete')),
          findsOneWidget);
    });

    testWidgets('the back affordance leaves the MODE before it leaves the page',
        (WidgetTester tester) async {
      await _pump(tester);
      await _enterSelection(tester, '第一句');

      await tester.tap(find.byKey(const ValueKey<String>('history.back')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey<String>('selection.bar')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey<String>('history.timeline')),
        findsOneWidget,
        reason: 'the page itself must still be here',
      );
    });
  });

  group('③ no ghost rows in a search result', () {
    testWidgets(
        '🔴 deleting a SEARCH hit removes it from the result set, not just from '
        'the store', (WidgetTester tester) async {
      // The shape this case exists for: `_hits` is a snapshot the search took
      // from storage. The store's notification refreshes `store.entries`; it
      // cannot refresh a snapshot. Without `_forgetDeleted` the deleted row
      // keeps rendering — the screen saying a record exists that does not.
      final TimelineStore store = await _pump(tester);
      await tester.enterText(
        find.byKey(const ValueKey<String>('history.search')),
        '第二',
      );
      await tester.pumpAndSettle();
      expect(
        find.text('第二句'),
        findsOneWidget,
        reason: 'positive control: the search really found it',
      );
      expect(find.text('第一句'), findsNothing);

      await tester.longPress(find.text('第二句'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(_zh.confirmDelete));
      await tester.pumpAndSettle();
      await tester.tap(find.text(_zh.confirmDelete).last);
      await tester.pumpAndSettle();

      expect(find.text('第二句'), findsNothing);
      expect(store.entries.map((dynamic e) => e.clientId), <String>['c1', 'a1']);
    });
  });

  group('④ nine locales, not one string nine times', () {
    test('positive control on the copy this page newly renders', () {
      for (final String Function(AppStrings) pick
          in <String Function(AppStrings)>[
        (AppStrings s) => s.selectionDeleteNoSelection,
        (AppStrings s) => s.selectionDeleteConfirmTitle(2),
      ]) {
        final Set<String> seen = <String>{
          for (final AppLocale loc in AppLocale.values) pick(AppStrings.of(loc)),
        };
        expect(seen, hasLength(AppLocale.values.length));
      }
    });
  });
}
