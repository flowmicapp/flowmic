// NR-115 N2: mount the real + notes tab and open its real article route.
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'support/fakes.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/article_rig.dart';

void main() {
  testWidgets(
    'N2: plus route shares status and top-line rule, including live retry updates',
    (t) async {
      final rig = ArticleRig();
      addTearDown(rig.dispose);
      await mountLightRecordScreen(t, rig);
      late String id;
      await t.runAsync(() async => id = await rig.recordThreeAndStop());
      await t.runAsync(pumpEventQueue);
      final head = rig.store.entries.singleWhere(
        (e) => e.entryType == TimelineEntry.kArticle,
      );
      final strings = AppStrings.of(AppLocale.zh);
      final backfill = ValueNotifier<BackfillProgress>(BackfillProgress.idle);
      addTearDown(backfill.dispose);
      void debt(
        PendingRecoveryState? state, {
        bool automatic = false,
        bool retrying = false,
        bool otherAccount = false,
        bool partlySaved = false,
      }) {
        backfill.value = BackfillProgress(
          pendingMs: 1000,
          running: retrying,
          recoveringArticleId: retrying ? id : null,
          byArticle: {
            id: ArticleBackfill(
              pendingMs: 1000,
              fromOutage: true,
              waitingAuto: automatic,
              recoveryItem: state == null
                  ? null
                  : PendingRecoveryItem(
                      id: id,
                      state: state,
                      durationMs: 1000,
                      legacy: false,
                      otherAccount: otherAccount,
                      partlySaved: partlySaved,
                    ),
            ),
          },
        );
      }

      debt(PendingRecoveryState.serverUnsupported);
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PlusPanelNotesTab(
              strings: strings,
              query: LightRecordQuery(persistence: rig.persistence),
              isSignedIn: () => true,
              backfill: backfill,
            ),
          ),
        ),
      );
      await t.runAsync(pumpEventQueue);
      await t.pumpAndSettle();
      await t.tap(find.byKey(ValueKey('plus.notes.article.${head.id}')));
      await t.runAsync(pumpEventQueue);
      await t.pumpAndSettle();
      expect(find.byType(ArticlePage), findsOneWidget);
      expect(
        find.text(strings.pendingRecoveryStateServerUnsupported),
        findsOneWidget,
      );
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      for (final state in [
        PendingRecoveryState.needsManual,
        PendingRecoveryState.shortfall,
      ]) {
        debt(state);
        await t.pump();
        expect(
          find.text(
            state == PendingRecoveryState.needsManual
                ? strings.pendingRecoveryStateNeedsManual
                : strings.pendingRecoveryStateShortfall,
          ),
          findsOneWidget,
        );
        expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      }
      debt(PendingRecoveryState.waitingAuto, otherAccount: true);
      await t.pump();
      expect(find.text(strings.pendingRecoveryOtherAccount), findsOneWidget);
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      debt(PendingRecoveryState.waitingAuto, automatic: true);
      await t.pump();
      expect(find.text(strings.articleTailOwedWaiting), findsOneWidget);
      expect(find.byKey(const Key('article.backfill.text')), findsOneWidget);
      debt(PendingRecoveryState.needsManual, retrying: true, partlySaved: true);
      await t.pump();
      expect(find.text(strings.articleFinishingStatus), findsOneWidget);
      expect(find.text(strings.pendingRecoveryPartlySaved), findsOneWidget);
      expect(find.byKey(const Key('article.backfill.text')), findsOneWidget);
      debt(PendingRecoveryState.needsManual);
      await t.pump();
      expect(
        find.text(strings.pendingRecoveryStateNeedsManual),
        findsOneWidget,
      );
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      debt(null);
      await t.pump();
      expect(t.takeException(), isNull);
      expect(find.byKey(const Key('article.completion')), findsNothing);
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      await t.pumpWidget(const SizedBox());
    },
  );
  testWidgets('G-1: real plus route retains the finishing draft until final', (
    t,
  ) async {
    final rig = ArticleRig();
    addTearDown(() => t.runAsync(rig.dispose));
    t.view.physicalSize = const Size(800, 2400);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final strings = AppStrings.of(AppLocale.zh);
    await t.pumpWidget(
      MaterialApp(
        home: ChatFlowPage(
          controller: rig.controller,
          historySource: rig.persistence,
          isSignedIn: () => true,
        ),
      ),
    );
    late String id;
    await t.runAsync(() async {
      id = await rig.startRecording();
      rig.recorder.feed(makePcm(16000 * 2));
      await rig.say('prefix-fixture', 0, isSegment: true, durationMs: 1000);
      rig.transport.pushIncoming(FlowMicEvents.sttInterim, {
        'text': 'kept-draft-fixture',
        'segment_idx': 1,
      });
      await pumpEventQueue();
    });
    await t.pump();
    await t.tap(find.byKey(ContinuousLiveKeys.open));
    await t.pumpAndSettle();
    await t.runAsync(() async {
      await t.tap(find.byKey(ContinuousLiveKeys.stop));
      await pumpEventQueue();
    });
    await t.pump();
    expect(find.text(strings.articleFinishingStatus), findsOneWidget);
    await t.pageBack();
    await t.pumpAndSettle();
    // Mount the actual notes tab route while Stop's final is still held.
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlusPanelNotesTab(
            strings: strings,
            query: LightRecordQuery(persistence: rig.persistence),
            isSignedIn: () => true,
            backfill: rig.controller.backfill.progress,
            articleController: rig.controller,
          ),
        ),
      ),
    );
    await t.runAsync(pumpEventQueue);
    await t.pumpAndSettle();
    final head = rig.store.entries.singleWhere(
      (e) => e.entryType == TimelineEntry.kArticle,
    );
    await t.tap(find.byKey(ValueKey('plus.notes.article.${head.id}')));
    await t.runAsync(pumpEventQueue);
    await t.pumpAndSettle();
    expect(find.byType(ArticlePage), findsOneWidget);
    expect(find.text(strings.articleFinishingStatus), findsOneWidget);
    expect(find.text(strings.articleDraftFinishing), findsOneWidget);
    expect(
      t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text,
      'kept-draft-fixture',
    );
    expect(rig.controller.articleCompletion(id), ArticleCompletion.finishing);
    await t.runAsync(
      () => rig.say('final-fixture', 1, isSegment: false, durationMs: 1000),
    );
    await t.pumpAndSettle();
    expect(find.byKey(const Key('article.completion')), findsNothing);
    expect(find.byType(LiveDraftTile), findsNothing);
    expect(find.textContaining('final-fixture'), findsOneWidget);
    debugCancelBannerAutoHideTimers(rig.controller);
    await t.pumpWidget(const SizedBox());
    await t.pump(const Duration(seconds: 5));
  });
}
