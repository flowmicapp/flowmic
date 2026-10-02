import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/article_recovery_presentation.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/inset_geometry.dart';
import 'support/article_rig.dart';

TimelineEntry row(int i) => TimelineEntry(
  id: 'r$i',
  clientId: 'r$i',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: '段落$i',
  outputText: '段落$i',
  status: EntryStatus.noted,
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
  articleId: 'a',
  durationMs: 60000,
  articleOffsetMs: i * 60000,
  pauseBeforeMs: 59000,
);

void main() {
  const AppStrings s = AppStringsZh();
  for (final InsetCase c in insetCases) {
    for (final bool bar in <bool>[false, true]) {
      testWidgets('article final paragraph safe ${c.name} recovery=$bar', (
        WidgetTester tester,
      ) async {
        c.apply(tester);
        await tester.pumpWidget(
          c.app(
            ArticlePage(
              head: row(0),
              rows: List<TimelineEntry>.generate(12, row),
              strings: s,
              recoveryStatus: bar
                  ? const ArticleRecoveryStatus(
                      completion: ArticleCompletion.recovering,
                      sentence: '正在恢复',
                    )
                  : null,
            ),
          ),
        );
        await tester.pumpAndSettle();
        final Finder list = find.byKey(const Key('article.body'));
        final ScrollableState scroll = tester.state(
          find.descendant(of: list, matching: find.byType(Scrollable)),
        );
        scroll.position.jumpTo(scroll.position.maxScrollExtent);
        await tester.pumpAndSettle();
        final Finder last = find.byKey(const Key('article.paragraph.11.box'));
        await reveal(tester, last);
        expectInside(tester, last, c);
        if (bar) {
          expectInside(
            tester,
            find.byKey(const Key('article.completion')),
            c.ime == 0 ? c : const InsetCase('bar', bottom: 0),
          );
          final Rect viewport = tester.getRect(list);
          final Rect status = tester.getRect(
            find.byType(ArticleRecoveryStatus),
          );
          if (c.ime == 0) {
            expect(
              viewport.bottom,
              closeTo(status.top, .01),
              reason: 'bar owns the bottom inset once',
            );
          }
        }
        expect(tester.takeException(), isNull);
      });
    }
  }
  for (final InsetCase c in <InsetCase>[
    ...insetCases.where((InsetCase c) => c.ime == 0 && c.scale == 1),
    const InsetCase('large-text', size: Size(480, 844), bottom: 80, scale: 1.3),
  ]) {
    testWidgets('live article stop and final paragraph safe ${c.name}', (
      WidgetTester tester,
    ) async {
      final ArticleRig rig = ArticleRig();
      addTearDown(rig.dispose);
      final String id = (await tester.runAsync(rig.startRecording))!;
      for (int i = 0; i < 12; i++) {
        await tester.runAsync(
          () => rig.say('段落$i。', i, isSegment: true, durationMs: 60000),
        );
      }
      c.apply(tester);
      bool stopped = false;
      await tester.pumpWidget(
        c.app(
          ArticlePage.live(
            controller: rig.controller,
            articleId: id,
            strings: s,
            bar: () => ContinuousLiveBar(
              remaining: const Duration(minutes: 18),
              amplitudeWindow: const <double>[],
              segmentCount: 12,
              screenHeld: false,
              engineReconnect: null,
              strings: s,
              onStop: () => stopped = true,
            ),
          ),
        ),
      );
      await tester.pump();
      final Finder stop = find.byKey(ContinuousLiveKeys.stop);
      expectInside(tester, stop, c);
      final Finder last = find.byKey(const Key('article.paragraph.11.box'));
      await reveal(tester, last);
      expectInside(tester, last, c);
      await tester.tap(stop);
      await tester.pump();
      expect(stopped, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() => rig.controller.pttUp());
      rig.session.endContinuous();
      await tester.pump(const Duration(seconds: 10));
    });
  }
}
