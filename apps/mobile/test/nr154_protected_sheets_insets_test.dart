import 'package:flowmic/src/audio/continuous_offer.dart';
import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/portable/export_sheet.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flowmic/src/ui/guide/instance_guide_sheet.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/inset_geometry.dart';
import 'support/portable_fakes.dart';

void main() {
  const AppStrings s = AppStringsZh();
  for (final InsetCase c in insetCases.where((InsetCase c) => c.ime == 0)) {
    testWidgets('export action inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      final controller = newTestPortableController();
      addTearDown(controller.dispose);
      await openSheet(tester, c, (BuildContext context) {
        showExportSheet(context, controller: controller, strings: s);
      });
      final Finder button = find.byType(FilledButton);
      await reveal(tester, button);
      expectInside(tester, button, c);
      await reveal(tester, find.text(s.exportTitle));
      expectInside(tester, find.text(s.exportTitle), c);
      expect(tester.takeException(), isNull);
    });
    testWidgets('continuous-start actions inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      bool? answer;
      await openSheet(tester, c, (BuildContext context) {
        askToStartContinuous(
          context,
          strings: s,
          offer: continuousOffer(
            recordOnly: true,
            mode: FlowMode.realtime,
            linkUp: true,
            signedIn: true,
            summary: const CloudSummary(
              minutes: CloudMeter(used: 0, limit: 900),
              tokens: CloudMeter(used: 0, limit: 900),
              continuousMinutes: 30,
            ),
          ),
        ).then((bool value) => answer = value);
      });
      for (final Key key in <Key>[
        ContinuousSheetKeys.cancel,
        ContinuousSheetKeys.start,
      ]) {
        final Finder target = find.byKey(key);
        await reveal(tester, target);
        expectInside(tester, target, c);
      }
      await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
      await tester.pumpAndSettle();
      expect(answer, isFalse);
      expect(tester.takeException(), isNull);
    });
    testWidgets('guide header and final card inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      await openSheet(tester, c, (BuildContext context) {
        showInstanceGuide(context, strings: s);
      });
      final Finder close = find.byKey(
        const ValueKey<String>('guide.instances.close'),
      );
      expectInside(tester, close, c);
      final Finder last = find
          .descendant(
            of: find.byType(SingleChildScrollView),
            matching: find.byType(Text),
          )
          .last;
      await reveal(tester, last);
      expectInside(tester, last, c);
      final Finder lastCard = find
          .ancestor(of: last, matching: find.byType(Container))
          .first;
      await reveal(tester, lastCard);
      expectInside(tester, lastCard, c);
      final Finder bottomClose = find.ancestor(
        of: find.text(s.guideClose),
        matching: find.byType(InkWell),
      );
      expectInside(tester, bottomClose, c);
      await tester.tap(bottomClose);
      await tester.pumpAndSettle();
      expect(find.byType(InstanceGuideBody), findsNothing);
      expect(tester.takeException(), isNull);
    });
    testWidgets('Plus Notes list and header inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      final FavoritesStore favorites = FavoritesStore(
        prefs: InMemoryLocalPrefs(),
      );
      await favorites.load();
      final TimelinePersistence persistence = InMemoryTimelinePersistence();
      await persistence.saveAll(
        List<TimelineEntry>.generate(
          14,
          (int i) => TimelineEntry(
            id: 'n$i',
            clientId: 'n$i',
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            sourceText: '笔记$i',
            outputText: '笔记$i',
            status: EntryStatus.noted,
            createdAt: DateTime(2026).add(Duration(minutes: i)),
            updatedAt: DateTime(2026),
            origin: 'cloud',
          ),
        ),
      );
      await openSheet(tester, c, (BuildContext context) {
        showPlusPanel(
          context,
          favorites: favorites,
          strings: s,
          buffer: '',
          noPcTarget: true,
          onSend: (_) {},
          onFeedback: (_) {},
          lightRecords: LightRecordQuery(persistence: persistence),
          isSignedIn: () => true,
          onSignIn: () async {},
        );
      });
      final Finder notes = find.byKey(const ValueKey<String>('plus.tab.notes'));
      expectInside(tester, notes, c);
      await tester.tap(notes);
      await tester.pumpAndSettle();
      final Finder lastNote = find.byKey(
        const ValueKey<String>('plus.notes.row.n0'),
      );
      await reveal(tester, lastNote);
      expectInside(tester, lastNote, c);
      final Finder lists = find.byType(ListView);
      for (final Element e in lists.evaluate()) {
        expectInside(tester, find.byWidget(e.widget), c, hit: false);
      }
      await tester
          .state<NavigatorState>(find.byType(Navigator).last)
          .maybePop();
      await tester.pumpAndSettle();
      expect(find.byType(PlusPanel), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
