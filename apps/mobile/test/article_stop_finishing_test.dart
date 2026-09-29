// NR-115 / NR-105: real ChatFlowPage -> ArticlePage, real stop button,
// PttSession, journal, recovery runner and final settlement. Only IO is fake.
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/ui/pending_recovery_card.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'support/fakes.dart' show makePcm;
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart' as sm;
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_header.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const _prefix = 'The first paragraph is already complete.';
const _draft = 'The final paragraph is still arriving';
const _final = 'The final paragraph has now arrived.';
final _strings = AppStrings.of(AppLocale.zh);

Future<void> _paint(WidgetTester t) async {
  await t.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 35)),
  );
  await t.pump();
}

Future<Rc3Rig> _open(
  WidgetTester t, {
  Duration? ceiling,
  bool retainAudio = true,
  String? Function()? account,
}) async {
  t.view.physicalSize = const Size(1080, 2340);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
  late Rc3Rig r;
  await t.runAsync(() async {
    r = await Rc3Rig.open(longStopCeiling: ceiling, retainAudio: retainAudio);
    if (account != null) r.spill.recordingAccount.bind(account);
    await r.begin();
    await r.feedMs(45000);
    await r.segment(_prefix, 0, 45000);
    await r.feedMs(10000);
    await r.push(FlowMicEvents.sttInterim, {
      'text': _draft,
      'segment_idx': 1,
      'acked_audio_ms': 50000,
    });
  });
  addTearDown(() => t.runAsync(r.dispose));
  await t.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: r.controller,
        onClearHistory: () => fail('clear must be disabled during finishing'),
      ),
    ),
  );
  await _paint(t);
  await t.tap(find.byKey(ContinuousLiveKeys.open));
  await t.pumpAndSettle();
  expect(find.byType(ArticlePage), findsOneWidget);
  return r;
}

Future<void> _stop(WidgetTester t) async {
  await t.runAsync(() async {
    await t.tap(find.byKey(ContinuousLiveKeys.stop));
    await Future<void>.delayed(const Duration(milliseconds: 40));
  });
  await t.pump();
}

Future<void> _answer(WidgetTester t, Rc3Rig r) async {
  await t.runAsync(
    () => r.push(
      FlowMicEvents.sttFinal,
      r.relay.terminal(
        Rc3Stop(r.relay.starts.first, 275),
        text: _final,
        durationMs: 10000,
        segmentIdx: 1,
      ),
    ),
  );
  await _paint(t);
}

void _status(WidgetTester t, String state, String label) {
  final f = find.byKey(Key('article.completion.$state'));
  expect(f, findsOneWidget);
  expect(t.widget<Text>(f).data, label);
  final RenderParagraph paragraph = t.renderObject<RenderParagraph>(f);
  expect(paragraph.didExceedMaxLines, isFalse);
  final Rect box = t.getRect(f);
  expect(box.left, greaterThanOrEqualTo(0));
  expect(box.right, lessThanOrEqualTo(360));
  expect(box.bottom, lessThanOrEqualTo(780));
}

Future<void> _clean(WidgetTester t, Rc3Rig r) async {
  debugCancelBannerAutoHideTimers(r.controller);
  await t.pumpWidget(const SizedBox());
  await t.pump(const Duration(seconds: 5));
}

void main() {
  testWidgets('i and iii: stop retains marked draft until final replaces it', (
    t,
  ) async {
    final r = await _open(t);
    final Offset before = t.getTopLeft(
      find.byKey(const Key('article.live.draft')),
    );
    await _stop(t);
    final draft = find.byKey(const Key('article.live.draft'));
    expect(draft, findsOneWidget);
    expect(
      t.getTopLeft(draft),
      before,
      reason: 'Stop must not move the last live paragraph',
    );
    final tile = t.widget<LiveDraftTile>(find.byType(LiveDraftTile));
    expect(tile.text, _draft);
    expect(tile.statusLabel, _strings.articleDraftFinishing);
    expect(tile.statusLabel, isNot(_strings.liveTranscribing));
    _status(t, 'finishing', _strings.articleFinishingStatus);
    await _answer(t, r);
    expect(find.byKey(const Key('article.completion')), findsNothing);
    expect(find.byKey(const Key('article.live.draft')), findsNothing);
    expect(find.textContaining(_final), findsOneWidget);
    expect(r.rows.map((e) => e.displayText), [_prefix, _final]);
    expect(r.rows.last.articleOffsetMs, 45000);
    await _clean(t, r);
  });

  testWidgets(
    'ii: finishing holds controls and survives leaving and reopening',
    (t) async {
      final r = await _open(t);
      await _stop(t);
      _status(t, 'finishing', _strings.articleFinishingStatus);
      expect(find.byKey(ContinuousLiveKeys.stop), findsNothing);
      expect(r.controller.canPtt, isFalse);
      expect(r.timeline.articleHolds.contains(r.articleId), isTrue);
      expect(
        r.session.beginContinuous(
          cap: const Duration(minutes: 30),
          onWarning: () {},
        ),
        isNull,
      );
      await t.pageBack();
      await t.pumpAndSettle();
      expect(r.session.fsm.session, sm.SessionState.processing);
      expect(
        DiagLog.instance.snapshot().lastWhere(
          (line) => line.contains('audio.continuous.begin_refused'),
        ),
        contains('reason=finishing'),
      );
      expect(
        t.widget<ChatHeader>(find.byType(ChatHeader)).onClearHistory,
        isNull,
      );
      final plus = find.byKey(const ValueKey<String>('compose.plus'));
      // The phone processing face removes the idle compose band.
      expect(plus, findsNothing);
      await t.tap(find.byType(ChatArticleTile));
      await t.pumpAndSettle();
      _status(t, 'finishing', _strings.articleFinishingStatus);
      expect(t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text, _draft);
      final prefixId = r.rows.first.id;
      r.timeline.delete(prefixId);
      await _paint(t);
      expect(
        r.timeline.findById(prefixId),
        isNotNull,
        reason: 'the shared delete path defers while the article is finishing',
      );
      await _answer(t, r);
      expect(r.timeline.articleHolds.contains(r.articleId), isFalse);
      expect(
        r.timeline.findById(prefixId),
        isNull,
        reason: 'deferred action resumes after terminal settlement',
      );
      await t.pageBack();
      await t.pumpAndSettle();
      final readyPlus = find.byKey(const ValueKey<String>('compose.plus'));
      expect(readyPlus, findsOneWidget);
      expect(t.widget<InkWell>(readyPlus).onTap, isNotNull);
      await _clean(t, r);
    },
  );

  testWidgets(
    'iv: offline stop hands over immediately without a finishing spinner',
    (t) async {
      final r = await _open(t);
      await t.runAsync(() async {
        r.relay.pushStatus(SocketStatus.disconnected);
        await Future<void>.delayed(const Duration(milliseconds: 3200));
        await r.feedMs(5000);
      });
      await _paint(t);
      await _stop(t);
      expect(
        r.controller.articleCompletion(r.articleId!),
        ArticleCompletion.recoveryPending,
        reason:
            'manifest=${r.spill.liveManifest?.recoveryState} '
            'held=${r.session.articles.attempts.liveHold} '
            'tail=${r.session.articles.owedTailPendingFor(r.articleId!)} '
            'tier=${r.controller.backfill.journalLeg?.currentTier}',
      );
      _status(t, 'recoveryPending', _strings.articleTailOwedWaiting);
      expect(
        find.byKey(const Key('article.completion.finishing')),
        findsNothing,
      );
      expect(find.byKey(ContinuousLiveKeys.stop), findsNothing);
      expect(t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text, _draft);
      expect(r.pcmPresent, isTrue);
      expect(r.session.continuousStillCapturing, isFalse);
      await _clean(t, r);
    },
  );

  testWidgets(
    'iv deadline: existing stop deadline changes finishing to recovery',
    (t) async {
      final r = await _open(t, ceiling: const Duration(milliseconds: 700));
      await t.runAsync(() => r.engine('reconnecting'));
      await _stop(t);
      _status(t, 'finishing', _strings.articleFinishingStatus);
      await t.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 850)),
      );
      await _paint(t);
      _status(t, 'recoveryPending', _strings.articleTailOwedWaiting);
      expect(t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text, _draft);
      expect(r.pcmPresent, isTrue);
      final stall = r.controller.sttStalled!;
      expect(stall.reason, sm.SttStallReason.timeout);
      final notice = _strings.sttStallBannerMessage(stall);
      expect(find.byKey(const Key('article.live.stall')), findsOneWidget);
      expect(find.text(notice), findsOneWidget);
      await t.runAsync(
        () => Future<void>.delayed(
          kBannerAutoHideAfter + const Duration(milliseconds: 100),
        ),
      );
      await _paint(t);
      expect(find.byKey(const Key('article.live.stall')), findsNothing);
      expect(r.controller.sttStalled, isNull);
      _status(t, 'recoveryPending', _strings.articleTailOwedWaiting);
      expect(t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text, _draft);
      await _clean(t, r);
    },
  );

  testWidgets('v: 81 second relay finish continues to show more text coming', (
    t,
  ) async {
    final r = await _open(t);
    await _stop(t);
    await t.runAsync(() => Future<void>.delayed(const Duration(seconds: 81)));
    await t.pump();
    _status(t, 'finishing', _strings.articleFinishingStatus);
    expect(t.widget<LiveDraftTile>(find.byType(LiveDraftTile)).text, _draft);
    await _answer(t, r);
    expect(find.byKey(const Key('article.completion')), findsNothing);
    expect(find.textContaining(_final), findsOneWidget);
    await _clean(t, r);
  });

  testWidgets('NR-105: first recovery shows owed work before its final', (
    t,
  ) async {
    final r = await _open(t, ceiling: const Duration(milliseconds: 200));
    Rc3Stop? recoveryStop;
    r.relay.onStop = (stop) {
      if (stop.recovery) recoveryStop = stop;
    };
    await t.runAsync(() => r.engine('reconnecting'));
    await t.runAsync(() => r.feedMs(5000));
    await _stop(t);
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await _paint(t);
    _status(t, 'recoveryPending', _strings.articleTailOwedWaiting);
    await t.runAsync(
      () =>
          r.until(() => recoveryStop != null, max: const Duration(seconds: 65)),
    );
    expect(
      recoveryStop,
      isNotNull,
      reason: DiagLog.instance.snapshot().join('\n'),
    );
    final stop = recoveryStop!;
    await _paint(t);
    _status(t, 'recovering', _strings.articleFinishingStatus);
    final owed = r.controller.backfill.progress.value.forArticle(r.articleId!);
    expect(find.byKey(const Key('article.backfill.text')), findsOneWidget);
    expect(
      t.widget<Text>(find.byKey(const Key('article.backfill.text'))).data,
      _strings.articleBackfillPending(formatEntryDuration(owed.pendingMs)),
    );
    expect(
      r.controller.backfill.progress.value.forArticle(r.articleId!).pendingMs,
      greaterThan(0),
      reason: 'first scan must publish before the pass returns',
    );
    await t.runAsync(
      () => r.push(
        FlowMicEvents.sttFinal,
        r.relay.terminal(
          stop,
          text: _final,
          durationMs: stop.toMs - stop.fromMs,
        ),
      ),
    );
    await t.runAsync(
      () => r.until(() => !r.controller.backfill.progress.value.running),
    );
    await _paint(t);
    expect(find.byKey(const Key('article.completion')), findsNothing);
    expect(find.textContaining(_final), findsOneWidget);
    await _clean(t, r);
  });

  testWidgets('F3: finishing refuses long press with the dedicated toast', (
    t,
  ) async {
    final r = await _open(t);
    await _stop(t);
    await t.pageBack();
    await t.pumpAndSettle();
    await t.longPress(find.byType(ChatArticleTile));
    await t.pump();
    expect(find.text(_strings.articleBusyFinishing), findsOneWidget);
    expect(find.text(_strings.entryCopy), findsNothing);
    await _answer(t, r);
    await _clean(t, r);
  });

  testWidgets('F3: reInject waits for final then emits exactly once', (
    t,
  ) async {
    final r = await _open(t);
    final row = r.timeline.buildFromUtterance(
      clientId: 'forward-row',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: 'Forward this row',
      origin: 'paired',
      articleId: r.articleId,
      articleOffsetMs: 0,
    );
    await _stop(t);
    await t.runAsync(() async {
      r.controller.reInject(row);
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
    expect(r.relay.emittedWhere(FlowMicEvents.injectRequest), isEmpty);
    await _answer(t, r);
    await t.runAsync(
      () => r.until(
        () => r.relay.emittedWhere(FlowMicEvents.injectRequest).isNotEmpty,
      ),
    );
    final sent = r.relay.emittedWhere(FlowMicEvents.injectRequest);
    expect(sent, hasLength(1));
    expect((sent.single.data as Map)['entry_id'], row.id);
    expect((sent.single.data as Map)['text'], row.displayText);
    await _clean(t, r);
  });

  for (final state in [
    RecoveryQueueState.needsManual,
    RecoveryQueueState.shortfall,
    RecoveryQueueState.awaitingServerCapability,
    RecoveryQueueState.pending,
  ]) {
    testWidgets(
      'B1 B1b: resting $state debt tells the truth and permits long press',
      (t) async {
        final r = await _open(t);
        await _stop(t);
        await _answer(t, r);
        await t.runAsync(() => _seedDebt(r, state));
        await _paint(t);
        final automatic = state == RecoveryQueueState.pending;
        _status(
          t,
          automatic ? 'recoveryPending' : 'recoveryManual',
          automatic
              ? _strings.articleTailOwedWaiting
              : switch (state) {
                  RecoveryQueueState.shortfall =>
                    _strings.pendingRecoveryStateShortfall,
                  RecoveryQueueState.awaitingServerCapability =>
                    _strings.pendingRecoveryStateServerUnsupported,
                  _ => _strings.pendingRecoveryStateNeedsManual,
                },
        );
        if (!automatic) {
          expect(find.text(_strings.articleTailOwedWaiting), findsNothing);
        }
        await t.pageBack();
        await t.pumpAndSettle();
        await t.longPress(find.byType(ChatArticleTile));
        await t.pumpAndSettle();
        expect(find.text(_strings.entryCopy), findsOneWidget);
        expect(find.text(_strings.articleBusyFinishing), findsNothing);
        await _clean(t, r);
      },
    );
  }

  testWidgets(
    'B3: tier C uses the same server-unsupported sentence as pending recovery',
    (t) async {
      final r = await _open(t);
      await _stop(t);
      await _answer(t, r);
      await t.runAsync(
        () => _seedDebt(r, RecoveryQueueState.awaitingServerCapability),
      );
      await _paint(t);
      final source = PendingRecoveryStore(
        runner: r.controller.backfill,
        sourceLang: () => 'zh',
      );
      final rows = await t.runAsync(source.list);
      expect(
        rows!.singleWhere((row) => row.id.endsWith('-r9999')).state,
        PendingRecoveryState.serverUnsupported,
      );
      _status(
        t,
        'recoveryManual',
        _strings.pendingRecoveryStateServerUnsupported,
      );
      expect(find.text(_strings.pendingRecoveryStateNeedsManual), findsNothing);
      await _clean(t, r);
    },
  );

  for (final state in [
    RecoveryQueueState.pending,
    RecoveryQueueState.needsManual,
    RecoveryQueueState.shortfall,
    RecoveryQueueState.awaitingServerCapability,
  ]) {
    testWidgets(
      'F9: $state outage debt shows the top line only for waiting auto',
      (t) async {
        final r = await _open(t);
        await _stop(t);
        await _answer(t, r);
        await t.runAsync(() => _seedDebt(r, state, outage: true));
        await _paint(t);
        final line = find.byKey(const Key('article.backfill.text'));
        if (state == RecoveryQueueState.pending) {
          expect(line, findsOneWidget);
          expect(
            t.widget<Text>(line).data,
            _strings.articleBackfillPending(formatEntryDuration(1000)),
          );
        } else {
          expect(line, findsNothing);
          expect(
            find.byKey(const Key('article.completion.recoveryManual')),
            findsOneWidget,
          );
        }
        await _clean(t, r);
      },
    );
  }

  testWidgets(
    'Round 5 N1: h recording under g shows the other-account sentence',
    (t) async {
      String who = 'h@example.com';
      final r = await _open(
        t,
        ceiling: const Duration(milliseconds: 200),
        account: () => who,
      );
      await t.runAsync(() => r.engine('reconnecting'));
      await t.runAsync(() => r.feedMs(5000));
      await _stop(t);
      who = 'g@example.com';
      await t.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 300));
        await r.controller.backfill.sweep(sourceLang: 'zh');
      });
      await _paint(t);
      final source = PendingRecoveryStore(
        runner: r.controller.backfill,
        sourceLang: () => 'zh',
      );
      final items = await t.runAsync(source.list);
      final item = items!.singleWhere((e) => e.otherAccount);
      expect(item.state, PendingRecoveryState.waitingAuto);
      expect(r.relay.recoveryStarts, isEmpty);
      _status(t, 'recoveryManual', _strings.pendingRecoveryOtherAccount);
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      expect(find.text(_strings.pendingRecoveryStateWaiting), findsNothing);
      await t.pumpWidget(const SizedBox());
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PendingRecoveryCard(
              item: item,
              strings: _strings,
              onRetry: () {},
              onDelete: () {},
            ),
          ),
        ),
      );
      expect(find.text(_strings.pendingRecoveryOtherAccount), findsOneWidget);
      expect(
        find.byKey(ValueKey('pendingRecovery.retry.${item.id}')),
        findsNothing,
      );
      await _clean(t, r);
    },
  );

  testWidgets(
    'Round 5 F-b: missing non-automatic state renders no status and does not crash',
    (t) async {
      final r = await _open(t);
      await _stop(t);
      await _answer(t, r);
      await t.runAsync(() => r.until(() => !r.controller.backfill.isBusy));
      r.controller.backfill.progress.value = BackfillProgress(
        pendingMs: 1000,
        running: false,
        byArticle: {
          r.articleId!: const ArticleBackfill(
            pendingMs: 1000,
            fromOutage: true,
          ),
        },
      );
      await t.pump();
      expect(find.byType(ArticlePage), findsOneWidget);
      expect(t.takeException(), isNull);
      expect(find.byKey(const Key('article.completion')), findsNothing);
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      await _clean(t, r);
    },
  );

  testWidgets(
    'Round 5 F-c: manual debt with user retry in flight shows top line and finishing',
    (t) async {
      final r = await _open(t);
      await _stop(t);
      await _answer(t, r);
      await t.runAsync(
        () => _seedDebt(r, RecoveryQueueState.needsManual, outage: true),
      );
      await _paint(t);
      _status(t, 'recoveryManual', _strings.pendingRecoveryStateNeedsManual);
      expect(find.byKey(const Key('article.backfill.text')), findsNothing);
      Rc3Stop? recoveryStop;
      r.relay.onStop = (stop) {
        if (stop.recovery) recoveryStop = stop;
      };
      late Future<PendingRetryOutcome> retry;
      await t.runAsync(() async {
        retry = r.controller.backfill.retranscribe(
          recordingId: '${r.articleId}-r9999',
          sourceLang: 'zh',
        );
        await r.until(() => recoveryStop != null);
      });
      expect(recoveryStop, isNotNull);
      await _paint(t);
      final progress = r.controller.backfill.progress.value;
      expect(progress.forArticle(r.articleId!).waitingAuto, isFalse);
      expect(progress.recoveringArticleId, r.articleId);
      expect(find.byKey(const Key('article.backfill.text')), findsOneWidget);
      _status(t, 'recovering', _strings.articleFinishingStatus);
      await t.runAsync(() async {
        await r.push(
          FlowMicEvents.sttFinal,
          r.relay.terminal(
            recoveryStop!,
            text: 'Manually recovered words.',
            durationMs: 1000,
          ),
        );
        await retry;
      });
      await _paint(t);
      expect(r.controller.backfill.progress.value.recoveringArticleId, isNull);
      await _clean(t, r);
    },
  );

  testWidgets(
    'Round 3: no retained audio timeout shares the chat notice and lifetime',
    (t) async {
      final r = await _open(
        t,
        ceiling: const Duration(milliseconds: 700),
        retainAudio: false,
      );
      await _stop(t);
      _status(t, 'finishing', _strings.articleFinishingStatus);
      await t.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 850)),
      );
      await _paint(t);
      expect(r.session.audio.retainedAudio, isNull);
      expect(r.controller.sttStalled?.reason, sm.SttStallReason.timeout);
      expect(find.byType(ArticlePage), findsOneWidget);
      expect(find.byKey(const Key('article.live.draft')), findsNothing);
      expect(find.byKey(const Key('article.completion')), findsNothing);
      final notice = _strings.sttStallBannerMessage(r.controller.sttStalled!);
      expect(find.byKey(const Key('article.live.stall')), findsOneWidget);
      expect(find.text(notice), findsOneWidget);
      expect(
        find.text(notice, skipOffstage: false),
        findsNWidgets(2),
        reason: 'The article and covered chat page render the same getter',
      );
      // F5: a no-audio timeout cannot leave a hidden draft ready to reappear.
      expect(r.controller.articleDraft(r.articleId!), isNull);
      // MAIN: an event notice, with the existing shared four-second lifetime.
      // The real deadline armed the controller timer in runAsync, not fake time.
      await t.runAsync(
        () => Future<void>.delayed(
          kBannerAutoHideAfter + const Duration(milliseconds: 100),
        ),
      );
      await _paint(t);
      expect(find.byType(ArticlePage), findsOneWidget);
      expect(r.controller.sttStalled, isNull);
      expect(find.byKey(const Key('article.live.stall')), findsNothing);
      expect(find.text(notice, skipOffstage: false), findsNothing);
      await t.pageBack();
      await t.pumpAndSettle();
      expect(find.text(notice), findsNothing);
      await _clean(t, r);
    },
  );
  testWidgets('G-2: a kept draft with missing debt state has no empty pill', (
    t,
  ) async {
    final r = await _open(t, ceiling: const Duration(milliseconds: 100));
    await t.runAsync(() => r.engine('reconnecting'));
    await _stop(t);
    await t.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 180));
      await r.until(() => !r.controller.backfill.isBusy);
    });
    r.controller.backfill.progress.value = BackfillProgress(
      pendingMs: 1000,
      running: false,
      byArticle: {
        r.articleId!: const ArticleBackfill(pendingMs: 1000, fromOutage: true),
      },
    );
    await t.pump();
    expect(find.byType(ArticlePage), findsOneWidget);
    final draft = find.byType(LiveDraftTile);
    expect(draft, findsOneWidget);
    expect(t.widget<LiveDraftTile>(draft).text, _draft);
    expect(t.widget<LiveDraftTile>(draft).statusLabel, isNull);
    expect(find.descendant(of: draft, matching: find.text('')), findsNothing);
    expect(t.takeException(), isNull);
    await _clean(t, r);
  });
}

// Historical queue facts are written to the real journal, then scanned by the
// real runner. No synthetic progress values or stand-in screen.
Future<void> _seedDebt(Rc3Rig r, String state, {bool outage = false}) async {
  if (state == RecoveryQueueState.awaitingServerCapability) {
    r.session.reconnect.noteServerCapabilities({'capabilities': <String>[]});
  }
  final j = await RetainedAudioJournal.open(
    dirPath: r.store.dirPath,
    recordingId: '${r.articleId}-r9999',
    fs: r.fs,
    configSnapshot: {'mode': 'realtime', 'sourceLang': 'zh'},
  );
  await j.appendPcm(makePcm(32000));
  j.setRecoveryState(
    state,
    nextEligibleAtMs: DateTime.now().millisecondsSinceEpoch + 600000,
  );
  await j.close(interruptReason: outage ? JournalInterrupt.linkLoss : null);
  await r.controller.backfill.sweep(sourceLang: 'zh');
}
