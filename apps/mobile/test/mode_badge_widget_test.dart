// V2-17 — the history-row mode badge: symbols, not ①②③ numerals.
//
// Two guards:
//   ① the three modes render THREE DIFFERENT symbols — three look-alike
//     icons would be the same riddle the numerals were;
//   ② every symbol carries a queryable word — Semantics label for screen
//     readers, long-press Tooltip for everyone else — because an
//     unexplained icon is just a new kind of numeral.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

Widget _host(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  test('modeBadgeMeta: three modes → three distinct icons + labels', () {
    final List<ModeBadgeMeta> metas = FlowMode.values
        .map((FlowMode m) => modeBadgeMeta(m, _zh))
        .toList();
    expect(metas.map((ModeBadgeMeta m) => m.icon).toSet(), hasLength(3));
    expect(metas.map((ModeBadgeMeta m) => m.label).toSet(), hasLength(3));
    for (final ModeBadgeMeta m in metas) {
      expect(m.label.trim(), isNotEmpty);
    }
  });

  testWidgets('each mode renders its own symbol, never a numeral', (
    WidgetTester tester,
  ) async {
    final Set<IconData?> seen = <IconData?>{};
    for (final FlowMode mode in FlowMode.values) {
      await tester.pumpWidget(_host(ModeBadge(mode, strings: _zh)));
      final Icon icon = tester.widget<Icon>(find.byType(Icon));
      expect(
        seen.add(icon.icon),
        isTrue,
        reason: '$mode reuses a symbol — as unreadable as ①②③ was',
      );
      expect(find.text('①'), findsNothing);
      expect(find.text('②'), findsNothing);
      expect(find.text('③'), findsNothing);
    }
  });

  testWidgets('every symbol has a queryable word (Semantics + Tooltip)', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    for (final FlowMode mode in FlowMode.values) {
      await tester.pumpWidget(_host(ModeBadge(mode, strings: _zh)));
      // The expected word is READ FROM THE CATALOGUE, not spelled here — a
      // literal in the test would happily keep passing against a literal in
      // the widget, which is the exact bug this guards.
      final String word = _zh.modeLabel(mode);
      expect(word.trim(), isNotEmpty);
      expect(find.bySemanticsLabel(word), findsOneWidget);
      final Tooltip tip = tester.widget<Tooltip>(find.byType(Tooltip));
      expect(tip.message, word);
    }
    handle.dispose();
  });

  testWidgets('the word follows the LANGUAGE SETTING, not a baked-in literal', (
    WidgetTester tester,
  ) async {
    // V2-17 first shipped these three words as literals inside the widget.
    // Green tests and a working badge — and three strings the zh/en/ja/ko language
    // switch structurally could not reach. This is the assertion that would
    // have caught it: same mode, two locales, two different words.
    for (final FlowMode mode in FlowMode.values) {
      expect(
        _en.modeLabel(mode),
        isNot(equals(_zh.modeLabel(mode))),
        reason: '$mode reads identically in both languages — a literal, not copy',
      );
    }

    final SemanticsHandle handle = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(const ModeBadge(FlowMode.translate, strings: _en)),
    );
    expect(find.bySemanticsLabel(_en.modeLabel(FlowMode.translate)), findsOneWidget);
    expect(find.bySemanticsLabel(_zh.modeLabel(FlowMode.translate)), findsNothing);
    handle.dispose();
  });
}
