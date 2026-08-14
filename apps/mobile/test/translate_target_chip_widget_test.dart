// GA-01 (widget half) — the translate target chip beside the mode chip.
//
// SPEC-REF: docs/ui-design/REDESIGN-PLAN.md D4 ("choose in place with translate mode");
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-01 ruling 2.
//
// Fake callbacks only — the controller/wire half is covered by
// utterance_compose_test.dart's plain `test()`s (the real PTT chain deadlocks
// inside testWidgets' FakeAsync zone).

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart' show kTranslateTargets;
import 'package:flowmic/src/ui/mode_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();

Widget _host(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  testWidgets('shows the current target and cycles the pair on tap', (
    WidgetTester tester,
  ) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'en', strings: _zh, onTap: picked.add)),
    );
    expect(find.text('→ EN'), findsOneWidget);
    await tester.tap(find.byType(TranslateTargetChip));
    expect(picked, <String>['zh'], reason: 'en → zh');

    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'zh', strings: _zh, onTap: picked.add)),
    );
    expect(find.text('→ 中'), findsOneWidget);
    await tester.tap(find.byType(TranslateTargetChip));
    expect(picked.last, 'en', reason: 'and back around');
  });

  testWidgets('an unknown stored tag still renders and rejoins the cycle', (
    WidgetTester tester,
  ) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(TranslateTargetChip(target: 'ja', strings: _zh, onTap: picked.add)),
    );
    // Never a blank chip: a tag outside the offered pair is shown verbatim
    // rather than silently rendering nothing.
    expect(find.text('→ JA'), findsOneWidget);
    await tester.tap(find.byType(TranslateTargetChip));
    expect(picked.single, kTranslateTargets.first);
  });

  testWidgets('goes inert while an utterance is being transformed', (
    WidgetTester tester,
  ) async {
    final List<String> picked = <String>[];
    await tester.pumpWidget(
      _host(
        TranslateTargetChip(
          target: 'en',
          strings: _zh,
          enabled: false,
          onTap: picked.add,
        ),
      ),
    );
    await tester.tap(find.byType(TranslateTargetChip));
    // Re-aiming mid-flight would say nothing about the sentence already in the
    // air, so the tap must not pretend to have done something.
    expect(picked, isEmpty);
  });
}
