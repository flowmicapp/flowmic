// NR-146 single-delete failure through the real Notes/chat banner.
// Reverse control: drop the row before reap in _deleteOne.
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/article_rig.dart';

class _DeleteFailsPersistence extends InMemoryTimelinePersistence {
  bool failDeletes = true;
  int failedDeletes = 0;

  @override
  Future<void> delete(String id) async {
    if (failDeletes) {
      failedDeletes++;
      throw StateError('disk write refused (test)');
    }
    return super.delete(id);
  }
}

void main() {
  for (final bool notes in <bool>[false, true]) {
    for (final bool fails in <bool>[true, false]) {
      testWidgets(
        '${notes ? 'Notes' : 'chat'} real screen: '
        '${fails ? 'failed deletion is readable' : 'successful deletion stays silent'}',
        (WidgetTester tester) async {
          SharedPreferences.setMockInitialValues(<String, Object>{});
          final AppSettingsController settings = AppSettingsController(
            prefs: await SharedPreferences.getInstance(),
          );
          await settings.load();
          settings.setLocale(AppLocale.en);
          addTearDown(settings.dispose);
          final AppStrings strings = AppStrings.of(AppLocale.en);
          final _DeleteFailsPersistence persistence = _DeleteFailsPersistence()
            ..failDeletes = fails;
          final ArticleRig rig = ArticleRig(persistence: persistence);
          rig.controller.destination.configureFixed(fixedRecordOnly: notes);
          tester.view.physicalSize = const Size(360, 800);
          tester.view.devicePixelRatio = 1;
          tester.platformDispatcher.textScaleFactorTestValue = 1.3;
          addTearDown(tester.view.reset);
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          try {
            await tester.pumpWidget(
              MaterialApp(
                home: ChatFlowPage(
                  controller: rig.controller,
                  appSettings: settings,
                  historySource: persistence,
                  isCloudInstance: notes,
                ),
              ),
            );
            await tester.pump();
            expect(find.text(strings.selectionDeleteFailed), findsNothing);

            final TimelineEntry row = rig.store.buildFromUtterance(
              clientId: 'screen-row',
              mode: FlowMode.realtime,
              delivery: notes ? Delivery.none : Delivery.inject,
              text: 'Synthetic timeline sentence',
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));
            rig.store.delete(row.id);
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));
            expect(find.byType(ChatMessageTile), fails ? findsOneWidget : findsNothing);
            expect(find.text(row.sourceText!), fails ? findsOneWidget : findsNothing);

            final Finder warning = find.descendant(
              of: find.byType(BannerSlot),
              matching: find.text(strings.selectionDeleteFailed),
            );
            if (fails) {
              expect(persistence.failedDeletes, 1);
              expect(warning, findsOneWidget);
              final RenderParagraph paragraph = tester.renderObject(warning);
              expect(paragraph.didExceedMaxLines, isFalse);
              final TextPainter painter = TextPainter(
                text: paragraph.text,
                textDirection: paragraph.textDirection,
                textScaler: paragraph.textScaler,
              )..layout(maxWidth: paragraph.size.width);
              expect(
                painter.height,
                lessThanOrEqualTo(paragraph.size.height + .01),
              );
              painter.dispose();
              final Rect rect = tester.getRect(warning);
              expect(rect.left, greaterThanOrEqualTo(0));
              expect(rect.right, lessThanOrEqualTo(360));
              expect(rect.top, greaterThanOrEqualTo(0));
              expect(rect.bottom, lessThanOrEqualTo(800));
              expect(await persistence.loadAll(), hasLength(1));
              expect(rig.store.entries.single.deleted, isFalse);
              await tester.pump(const Duration(seconds: 5));
              expect(warning, findsNothing, reason: 'delete event auto-hides');
              persistence.failDeletes = false;
              rig.store.delete(row.id);
              await tester.pump();
              await tester.pump(const Duration(milliseconds: 50));
              expect(rig.store.findById(row.id), isNull);
              expect(rig.store.deleteFailures.noticeTicket, isNull);

            } else {
              expect(warning, findsNothing);
              expect(await persistence.loadAll(), isEmpty);
            }
            expect(tester.takeException(), isNull);
          } finally {
            await tester.pumpWidget(const SizedBox());
            await tester.runAsync(rig.dispose);
          }
        },
      );
    }
  }
}
