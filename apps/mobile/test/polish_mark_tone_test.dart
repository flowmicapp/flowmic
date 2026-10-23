// UI-1 (2026-10-13): the polish-skipped row mark is a calm neutral chip unless
// the user has something to fix (no model / model refused), where it stays
// amber. Original amber spec: docs/archive/strategy/R4-PRIVATE-TASK-CARDS.md
// WP-R4-6 (7). These cases mount the real ChatMessageTile and assert the
// RENDERED decoration and text colours, not the widget's constructor flag.
// The wiring from the controller's badge to the tile flag is held by
// polish_badge_screen_test.dart (`tile.polishNeedsAction`).
// Reverse control: with PolishSkippedMark always amber (the old code) every
// neutral case below goes red.

import 'package:flowmic/src/session/polish_badge.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _entry() {
  final DateTime now = DateTime.utc(2026, 10, 13, 9, 0);
  return TimelineEntry(
    id: 'loc_mobile_c',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: '正文',
    outputText: '正文',
    status: EntryStatus.injected,
    edited: false,
    origin: 'paired',
    createdAt: now,
    updatedAt: now,
  );
}

Future<void> _pump(WidgetTester tester, PolishBadge badge) async {
  final AppStrings strings = AppStrings.of(AppLocale.en);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: strings,
          entry: _entry(),
          polishSkippedLabel: badge.label(strings),
          polishNeedsAction: badge.needsUserFix,
        ),
      ),
    ),
  );
}

void main() {
  final AppStrings strings = AppStrings.of(AppLocale.en);
  for (final PolishBadge badge in PolishBadge.values) {
    final bool amber =
        badge == PolishBadge.noModel || badge == PolishBadge.modelRejected;
    testWidgets('${badge.name}: row mark is ${amber ? 'amber' : 'neutral'}', (
      WidgetTester tester,
    ) async {
      await _pump(tester, badge);
      final Finder mark = find.byType(PolishSkippedMark);
      expect(mark, findsOneWidget);
      final Finder text = find.descendant(
        of: mark,
        matching: find.text(badge.label(strings)),
      );
      expect(text, findsOneWidget);
      final Container box = tester.widget<Container>(
        find.descendant(of: mark, matching: find.byType(Container)).first,
      );
      final BoxDecoration deco = box.decoration! as BoxDecoration;
      final Border border = deco.border! as Border;
      final TextStyle style = tester.widget<Text>(text).style!;
      expect(
        deco.color,
        amber ? FlowMicColors.amberSoft : FlowMicColors.surface2,
      );
      expect(
        border.top.color,
        amber ? const Color(0x4DFBBF24) : FlowMicColors.line,
      );
      expect(style.color, amber ? FlowMicColors.amber : FlowMicColors.t2);
    });
  }
}
