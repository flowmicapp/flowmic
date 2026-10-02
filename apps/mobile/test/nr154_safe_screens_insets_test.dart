import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/confirm_dialog.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/article_rig.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/inset_geometry.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

class PendingFixture implements PendingRecoverySource {
  int retries = 0;
  @override
  PendingRetryBlocker? get retryBlocker => null;
  @override
  Future<List<PendingRecoveryItem>> list() async =>
      List<PendingRecoveryItem>.generate(
        12,
        (int i) => PendingRecoveryItem(
          id: 'p$i',
          state: PendingRecoveryState.needsManual,
          durationMs: 5000,
          legacy: false,
        ),
      );
  @override
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item) async {
    retries++;
    return PendingRetryOutcome.done;
  }

  @override
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item) async =>
      PendingDeleteOutcome.done;
}

void main() {
  const AppStrings s = AppStringsZh();
  late ArticleRig rig;
  late AppSettingsController settings;
  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    settings = AppSettingsController(
      prefs: await SharedPreferences.getInstance(),
    );
    await settings.load();
    rig = ArticleRig();
    for (int i = 0; i < 18; i++) {
      rig.store.buildFromUtterance(
        clientId: 'r$i',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: '记录$i',
        origin: 'cloud',
      );
    }
  });
  tearDown(() async {
    settings.dispose();
    await rig.dispose();
  });

  final List<InsetCase> safeCases = <InsetCase>[
    ...insetCases.where((InsetCase c) => c.scale == 1 && c.name != 'landscape'),
    const InsetCase('large-text', size: Size(480, 844), bottom: 80, scale: 1.3),
    const InsetCase(
      'landscape',
      size: Size(640, 480),
      bottom: 80,
      left: 44,
      right: 24,
      top: 24,
    ),
  ];
  for (final InsetCase c in safeCases) {
    for (final bool cloud in <bool>[false, true]) {
      testWidgets(
        'Chat Notes header PTT and last row safe ${c.name} cloud=$cloud',
        (WidgetTester tester) async {
          c.apply(tester);
          await tester.pumpWidget(
            c.app(
              ChatFlowPage(
                controller: rig.controller,
                appSettings: settings,
                onBack: () {},
                isCloudInstance: cloud,
              ),
            ),
          );
          await tester.pumpAndSettle();
          expectInside(
            tester,
            find.byKey(const ValueKey<String>('chat.back')),
            c,
          );
          expectInside(
            tester,
            find.byKey(const ValueKey<String>('ptt.bar')),
            c,
          );
          expectInside(
            tester,
            find.byKey(const ValueKey<String>('compose.dock')),
            c,
            hit: false,
          );
          final Finder list = find.byKey(
            const ValueKey<String>('chat.timeline'),
          );
          expectInside(tester, list, c, hit: false);
          final Finder last = find.ancestor(
            of: find.text('记录17'),
            matching: find.byType(ChatMessageTile),
          );
          expect(last, findsOneWidget);
          await reveal(tester, last);
          expectInside(tester, last, c);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
        },
      );
    }
    testWidgets('history header last record footer safe ${c.name}', (
      WidgetTester tester,
    ) async {
      c.apply(tester);
      await tester.pumpWidget(
        c.app(
          HistoryPage(
            store: rig.store,
            storageKind: TimelineStorageKind.sqlite,
            appSettings: settings,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expectInside(
        tester,
        find.byKey(const ValueKey<String>('history.back')),
        c,
      );
      final Finder last = find.text('记录0');
      await reveal(tester, last);
      expectInside(
        tester,
        find.ancestor(of: last, matching: find.byType(ChatMessageTile)),
        c,
      );
      final Finder footer = find.text(AppStrings.of(settings.locale).historyAllPersisted);
      await reveal(tester, footer);
      expectInside(tester, footer, c);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
    testWidgets('settings header and final action safe ${c.name}', (
      WidgetTester tester,
    ) async {
      final scenario = ScenarioCardController(
        cache: InMemoryScenarioCardCache(),
      );
      await scenario.load();
      final login = newTestLogin(transport: rig.transport);
      final portable = newTestPortableController();
      final prefs = newTestPrefsController();
      final update = newTestUpdateController();
      final summary = newTestCloudSummary(login: login);
      addTearDown(() {
        scenario.dispose();
        login.dispose();
        portable.dispose();
        prefs.dispose();
        update.dispose();
        summary.dispose();
      });
      c.apply(tester);
      await tester.pumpWidget(
        c.app(
          SettingsPage(
            scenario: scenario,
            appSettings: settings,
            login: login,
            destination: rig.controller.destination,
            session: rig.session,
            portable: portable,
            prefs: prefs,
            backup: newTestSettingsBackup(),
            inventory: newTestInventory(
              rows: const <TimelineEntry>[],
              images: InMemoryOutboxBlobStore(),
            ),
            timeline: rig.store,
            version: const FixedAppVersion('test'),
            update: update,
            cloudSummary: summary,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expectInside(
        tester,
        find.byKey(const ValueKey<String>('settings.back')),
        c,
      );
      final Finder last = find.byKey(const ValueKey<String>('update.checkNow'));
      await reveal(tester, last);
      expectInside(tester, last, c);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
    testWidgets('pending header last retry delete safe ${c.name}', (
      WidgetTester tester,
    ) async {
      final PendingFixture source = PendingFixture();
      c.apply(tester);
      await tester.pumpWidget(
        c.app(PendingRecoveryPage(source: source, strings: s)),
      );
      await tester.pumpAndSettle();
      expectInside(tester, find.byKey(const Key('pendingRecovery.title')), c);
      final Finder retry = find.byKey(
        const ValueKey<String>('pendingRecovery.retry.p11'),
      );
      final Finder delete = find.byKey(
        const ValueKey<String>('pendingRecovery.delete.p11'),
      );
      await reveal(tester, delete);
      expectInside(tester, retry, c);
      expectInside(tester, delete, c);
      await tester.tap(retry);
      await tester.pumpAndSettle();
      expect(source.retries, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
    testWidgets('standard confirm dialog actions safe ${c.name}', (
      WidgetTester tester,
    ) async {
      bool? answer;
      await openSheet(tester, c, (BuildContext context) {
        confirmDestructive(
          context,
          title: s.confirmDelete,
          message: s.editEntryNote,
          confirmLabel: s.confirmDelete,
          cancelLabel: s.cancel,
        ).then((bool value) => answer = value);
      });
      for (final Element e in find.bySubtype<ButtonStyleButton>().evaluate()) {
        final Finder button = find.byWidget(e.widget);
        if (find
            .ancestor(of: button, matching: find.byType(AlertDialog))
            .evaluate()
            .isNotEmpty) {
          expectInside(tester, button, c);
        }
      }
      await tester.tap(find.text(s.cancel));
      await tester.pumpAndSettle();
      expect(answer, isFalse);
      expect(tester.takeException(), isNull);
    });
  }
}
