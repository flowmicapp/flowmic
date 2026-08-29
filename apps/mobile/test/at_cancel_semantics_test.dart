// 🔴 NR-4 (g) — the accessible way to DISCARD a hold, on both controls that
// have one.
//
// Source of truth:
//   docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §4 / §6
//
// ── The hole this closes ────────────────────────────────────────────────────
// `PttBar._handleSemanticActivate` is a two-step toggle: one activation starts
// the hold, a second one ends it — which is the honest accessible form of a
// press-and-hold. But finishing SENDS. The finger has a third option (slide up
// past the threshold, release, and the utterance is thrown away) and assistive
// technology had none: that file's own header booked it as an explicit open
// item rather than faking it. `chat_flow_edit_sheet_append.dart` had the
// identical hole and nobody had written it down — unsurprising, since its
// header says it runs 「the SAME GESTURE CHAIN as the PTT bar」.
//
// ── What this file insists on ───────────────────────────────────────────────
//   ① the action EXISTS only while a hold is live (an always-there 「cancel
//      the recording」 with nothing to cancel is this repo's 「a control that
//      changes nothing」 red line wearing an accessibility costume);
//   ② firing it lands on the SAME downstream chain the finger gesture uses —
//      `onCancel` fires, the hold really closes, and the cancel counter moves
//      exactly once (not zero, not twice);
//   ③ the two controls carry their OWN sentence. A shared 「Cancel」 would
//      leave an AT user unable to tell which of the two they are on.
//
// 🔴 REVERSE CONTROL [measured 2026-08-27]: delete the `customSemanticsActions`
// argument from `ptt_bar.dart`'s `Semantics(...)` (leave everything else — the
// label, the toggle, `_handleSwipeCancel` itself — untouched) and this file
// goes red:
//     PttBar · the cancel action appears the moment a hold is live
//     Expected: a value greater than <0>
//       Actual: <0>
//     the PTT bar exposes no custom action while a hold is live
// Restored afterwards; leftover-string grep for `REVERSE-CONTROL-NR4G` = 0 and
// this file is green again.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart' show SheetAppendButton;
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

final AppStrings _en = AppStrings.of(AppLocale.en);

/// The cancel counter both controls share — read straight out of the prefs the
/// package-wide harness installs (`test/flutter_test_config.dart`).
Future<int> _cancelCount() async =>
    (await SharedPreferences.getInstance()).getInt('usage.pttCancel') ?? 0;

/// The custom actions on [node], as `label -> action id`.
Map<String, int> _customActions(SemanticsNode node) {
  final Map<String, int> out = <String, int>{};
  for (final int id in node.getSemanticsData().customSemanticsActionIds ??
      const <int>[]) {
    final String? label = CustomSemanticsAction.getAction(id)?.label;
    if (label != null) out[label] = id;
  }
  return out;
}

Widget _pttHost({
  required Future<void> Function() onCancel,
  required Future<void> Function() onUp,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 360,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          PttBar(
            visual: PttVisual.idle,
            strings: _en,
            onDown: () async => true,
            onUp: onUp,
            onCancel: onCancel,
          ),
        ],
      ),
    ),
  ),
);

Widget _appendHost({
  required Future<void> Function() onCancel,
  required Future<void> Function() onUp,
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 360,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          SheetAppendButton(
            appending: false,
            strings: _en,
            onDown: () async => true,
            onUp: onUp,
            onCancel: onCancel,
          ),
        ],
      ),
    ),
  ),
);

void main() {
  group('① the action only exists while a hold is live', () {
    testWidgets('PttBar · the cancel action appears the moment a hold is live',
        (WidgetTester tester) async {
      // ⚠️ Disposed at the END of the body rather than through `addTearDown`:
      // the framework verifies outstanding handles BEFORE tear-downs run, so a
      // tear-down here reports 「a SemanticsHandle was active at the end of the
      // test」 on a case that did nothing wrong (measured 2026-08-27).
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _pttHost(onCancel: () async {}, onUp: () async {}),
      );

      SemanticsNode node = tester.getSemantics(find.byType(PttBar));
      expect(
        _customActions(node),
        isEmpty,
        reason: 'idle: there is nothing to cancel, so no such action may be '
            'offered',
      );

      // Start a hold the way an AT user does — the node's own tap action.
      node.owner!.performAction(node.id, SemanticsAction.tap);
      await tester.pumpAndSettle();

      node = tester.getSemantics(find.byType(PttBar));
      final Map<String, int> live = _customActions(node);
      expect(
        live.length,
        greaterThan(0),
        reason: 'the PTT bar exposes no custom action while a hold is live',
      );
      expect(live.keys, contains(_en.pttCancelSemanticAction));

      handle.dispose();
    });

    testWidgets('SheetAppendButton · same rule, its own sentence',
        (WidgetTester tester) async {
      // ⚠️ Disposed at the END of the body rather than through `addTearDown`:
      // the framework verifies outstanding handles BEFORE tear-downs run, so a
      // tear-down here reports 「a SemanticsHandle was active at the end of the
      // test」 on a case that did nothing wrong (measured 2026-08-27).
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _appendHost(onCancel: () async {}, onUp: () async {}),
      );

      SemanticsNode node = tester.getSemantics(find.byType(SheetAppendButton));
      expect(_customActions(node), isEmpty);

      node.owner!.performAction(node.id, SemanticsAction.tap);
      await tester.pumpAndSettle();

      node = tester.getSemantics(find.byType(SheetAppendButton));
      expect(
        _customActions(node).keys,
        contains(_en.appendCancelSemanticAction),
      );

      handle.dispose();
    });
  });

  group('② firing it runs the SAME chain the finger gesture runs', () {
    testWidgets('PttBar · onCancel fires once, the hold closes, and nothing is sent',
        (WidgetTester tester) async {
      // ⚠️ Disposed at the END of the body rather than through `addTearDown`:
      // the framework verifies outstanding handles BEFORE tear-downs run, so a
      // tear-down here reports 「a SemanticsHandle was active at the end of the
      // test」 on a case that did nothing wrong (measured 2026-08-27).
      final SemanticsHandle handle = tester.ensureSemantics();
      int cancels = 0;
      int ups = 0;
      await tester.pumpWidget(
        _pttHost(
          onCancel: () async => cancels++,
          onUp: () async => ups++,
        ),
      );
      final int before = await _cancelCount();

      SemanticsNode node = tester.getSemantics(find.byType(PttBar));
      node.owner!.performAction(node.id, SemanticsAction.tap);
      await tester.pumpAndSettle();

      node = tester.getSemantics(find.byType(PttBar));
      final int cancelId = _customActions(node)[_en.pttCancelSemanticAction]!;
      node.owner!.performAction(node.id, SemanticsAction.customAction, cancelId);
      await tester.pumpAndSettle();

      expect(cancels, 1);
      expect(
        ups,
        0,
        reason: 'cancelling must not also send — that is the whole difference '
            'between this action and finishing the hold',
      );
      expect(
        await _cancelCount(),
        before + 1,
        reason: 'the AT path and the finger path share one counting point, so '
            'this must move by exactly one',
      );

      // The hold really closed: the action is gone again, and a fresh
      // activation starts a NEW hold instead of ending the old one.
      node = tester.getSemantics(find.byType(PttBar));
      expect(_customActions(node), isEmpty);

      handle.dispose();
    });

    testWidgets('SheetAppendButton · same downstream effects',
        (WidgetTester tester) async {
      // ⚠️ Disposed at the END of the body rather than through `addTearDown`:
      // the framework verifies outstanding handles BEFORE tear-downs run, so a
      // tear-down here reports 「a SemanticsHandle was active at the end of the
      // test」 on a case that did nothing wrong (measured 2026-08-27).
      final SemanticsHandle handle = tester.ensureSemantics();
      int cancels = 0;
      int ups = 0;
      await tester.pumpWidget(
        _appendHost(
          onCancel: () async => cancels++,
          onUp: () async => ups++,
        ),
      );
      final int before = await _cancelCount();

      SemanticsNode node = tester.getSemantics(find.byType(SheetAppendButton));
      node.owner!.performAction(node.id, SemanticsAction.tap);
      await tester.pumpAndSettle();

      node = tester.getSemantics(find.byType(SheetAppendButton));
      final int cancelId =
          _customActions(node)[_en.appendCancelSemanticAction]!;
      node.owner!.performAction(node.id, SemanticsAction.customAction, cancelId);
      await tester.pumpAndSettle();

      expect(cancels, 1);
      expect(ups, 0);
      expect(await _cancelCount(), before + 1);
      expect(_customActions(tester.getSemantics(find.byType(SheetAppendButton))),
          isEmpty);

      handle.dispose();
    });
  });

  group('③ the two labels are two sentences, in all nine languages', () {
    test('non-empty everywhere, and never the same string as each other', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.pttCancelSemanticAction, isNotEmpty, reason: locale.name);
        expect(s.appendCancelSemanticAction, isNotEmpty, reason: locale.name);
        expect(
          s.pttCancelSemanticAction,
          isNot(s.appendCancelSemanticAction),
          reason: '${locale.name}: an AT user hearing the same sentence on both '
              'controls cannot tell which one they are on',
        );
        // And neither is a copy of the finger gesture's state line: 「release
        // to cancel」 answers 「what happens if I let go now」 and is
        // meaningless read out of an action list.
        expect(s.pttCancelSemanticAction, isNot(s.pttCancelArmed),
            reason: locale.name);
        expect(s.appendCancelSemanticAction, isNot(s.appendCancelArmed),
            reason: locale.name);
      }
    });
  });
}
