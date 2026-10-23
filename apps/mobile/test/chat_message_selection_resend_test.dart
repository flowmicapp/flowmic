// CARD-UI (MAIN 2026-10-14) — no inline Resend in selection mode.
//
// In selection mode a tap on a row must toggle its selection (FB-7 / NR-3);
// a Resend link inside the row would resend instead. So the tile drops the
// inline Resend (word and icon) while `onSelectToggle` is set, and a tap
// where it used to be toggles the selection. Outside selection mode the
// same row still offers Resend and the tap resends.
//
// Reverse control (2026-10-14): with the `onSelectToggle == null` clause
// removed from `canRetry` in chat_message_tile.dart (marker RC-REVERT),
// `flutter test test/chat_message_selection_resend_test.dart` read `+1 -1`
// (`Expected: no matching candidates` on the Resend link in selection
// mode); restored ⇒ `+2: All tests passed!`, RC-REVERT grep=0.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/meta_fit_rows.dart';

void main() {
  final DateTime now = DateTime.now();
  final MetaRow row = metaRows(now).firstWhere((MetaRow r) => r.id == 'failed');
  final TimelineEntry entry = row.build(
    createdAt: MetaStamp.today.at(now),
    edited: false,
  );
  final AppStrings s = AppStrings.of(AppLocale.en);

  Future<void> mount(
    WidgetTester tester, {
    required void Function() onToggle,
    required void Function(TimelineEntry) onRetry,
    required bool selecting,
  }) async {
    tester.view.physicalSize = const Size(412, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(14),
            child: ChatMessageTile(
              entry: entry,
              strings: s,
              queued: row.queued,
              canResendImage: false,
              onRetry: onRetry,
              selected: false,
              onSelectToggle: selecting ? onToggle : null,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Finder resendWord() =>
      find.byKey(ValueKey<String>('entry.resend.${entry.id}'));
  Finder resendIcon() =>
      find.byKey(ValueKey<String>('entry.resend.icon.${entry.id}'));

  testWidgets('selection mode: no Resend, and a tap toggles the selection', (
    WidgetTester tester,
  ) async {
    int toggled = 0;
    int resent = 0;
    await mount(
      tester,
      onToggle: () => toggled++,
      onRetry: (_) => resent++,
      selecting: true,
    );
    // Positive control: this row's face is one Resend is offered on.
    expect(deliveryFaceOf(entry, queued: row.queued), DeliveryFace.failed);
    expect(find.byType(ChatMessageTile), findsOneWidget);
    expect(resendWord(), findsNothing);
    expect(resendIcon(), findsNothing);
    expect(find.text(s.resendAction), findsNothing);
    await tester.tap(find.byType(StatusPill));
    await tester.pump();
    expect(toggled, 1);
    expect(resent, 0);
  });

  testWidgets('outside selection mode the same row still resends', (
    WidgetTester tester,
  ) async {
    int resent = 0;
    await mount(
      tester,
      onToggle: () {},
      onRetry: (_) => resent++,
      selecting: false,
    );
    expect(resendWord().hitTestable(), findsOneWidget);
    await tester.tap(resendWord());
    await tester.pump();
    expect(resent, 1);
  });
}
