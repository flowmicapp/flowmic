import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'support/di.dart';

void main() {
  for (final count in [0, 120]) {
    testWidgets('real History shows fallback notice above $count notes without scrolling', (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final persistence = InMemoryTimelinePersistence();
      for (int i = 0; i < count; i++) {
        final stamp = DateTime.utc(2026, 10, 1).add(Duration(seconds: i)).toIso8601String();
        await persistence.upsert(TimelineEntry.fromJson({'id': 'row-$i', 'client_id': 'row-$i',
          'mode': 'realtime', 'delivery': 'none', 'output_text': 'fallback note $i', 'status': 'noted',
          'created_at': stamp, 'updated_at': stamp})!);
      }
      final store = newTestStore(persistence: persistence);
      addTearDown(store.dispose);
      await store.load();
      await tester.pumpWidget(MaterialApp(home: HistoryPage(store: store,
        storageKind: TimelineStorageKind.sharedPrefsFallback)));
      await tester.pump();
      final strings = AppStrings.of(AppLocale.zh);
      final warning = find.text(strings.historyFallbackNote);
      expect(warning, findsOneWidget);
      final bounds = tester.getRect(warning);
      expect(bounds.top, greaterThanOrEqualTo(0));
      expect(bounds.bottom, lessThanOrEqualTo(800));
      final search = tester.getRect(find.byKey(const ValueKey('history.search')));
      expect(bounds.bottom, lessThanOrEqualTo(search.top), reason: 'fault disclosure is prominent above search and notes');
      final Text text = tester.widget(warning);
      expect(text.style!.fontSize, greaterThanOrEqualTo(13));
      final RenderParagraph paragraph = tester.renderObject(warning);
      expect(paragraph.didExceedMaxLines, isFalse);
      expect(find.text(strings.historyAllPersisted), findsNothing);
      if (count > 0) expect(find.text('fallback note 119'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
