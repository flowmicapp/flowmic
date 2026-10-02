// Real ChatFlowPage, controller subscriptions, banner adapter and persistence
// failure. D-15: check the rendered paragraph, including its actual bounds.
import 'package:flowmic/src/session/chat_controller.dart';
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

class _WriteFailsPersistence extends InMemoryTimelinePersistence {
  bool failWrites = true;
  int failedWrites = 0;

  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (failWrites) {
      failedWrites++;
      throw StateError('disk write refused (test)');
    }
    return super.upsert(entry);
  }
}

void main() {
  for (final bool notes in <bool>[false, true]) {
    for (final bool fails in <bool>[true, false]) {
      testWidgets(
        '${notes ? 'Notes' : 'chat'} real screen: '
        '${fails ? 'failed save is readable' : 'successful save stays silent'}',
        (WidgetTester tester) async {
          SharedPreferences.setMockInitialValues(<String, Object>{});
          final AppSettingsController settings = AppSettingsController(
            prefs: await SharedPreferences.getInstance(),
          );
          await settings.load();
          settings.setLocale(AppLocale.en);
          addTearDown(settings.dispose);
          final AppStrings strings = AppStrings.of(AppLocale.en);
          final _WriteFailsPersistence persistence = _WriteFailsPersistence()
            ..failWrites = fails;
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
            expect(find.text(strings.timelineLocalSaveFailed), findsNothing);

            final TimelineEntry row = rig.store.buildFromUtterance(
              clientId: 'screen-row',
              mode: FlowMode.realtime,
              delivery: notes ? Delivery.none : Delivery.inject,
              text: 'Synthetic timeline sentence',
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));
            expect(rig.store.entries.single.id, row.id);
            expect(find.byType(ChatMessageTile), findsOneWidget);
            expect(find.text(row.sourceText!), findsOneWidget);

            final Finder warning = find.descendant(
              of: find.byType(BannerSlot),
              matching: find.text(strings.timelineLocalSaveFailed),
            );
            if (fails) {
              expect(persistence.failedWrites, 1);
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
              expect(await persistence.loadAll(), isEmpty);

              await tester.pump(kBannerAutoHideAfter);
              expect(warning, findsNothing);
              expect(rig.store.writeFailures.entryIds, contains(row.id));
              rig.store.applyEdit(row.id, 'edited sentence');
              await tester.pump();
              expect(
                warning,
                findsOneWidget,
                reason: 'a later burst gets its own visible warning',
              );
              await tester.tap(
                find.descendant(
                  of: find.byType(BannerSlot),
                  matching: find.byIcon(Icons.close),
                ),
              );
              await tester.pump();
              expect(warning, findsNothing);
            } else {
              expect(warning, findsNothing);
              expect(await persistence.loadAll(), hasLength(1));
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
