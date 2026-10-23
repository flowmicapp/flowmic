// NR-213 + NR-225 — the screens that are the deliverable (CLAUDE.md ⑥):
//   · the light-record (notes) list, whose banner slot carries the return notice;
//   · the in-progress article page, which carries the same notice as a status
//     line AND draws the gap marker between paragraphs;
//   · the notes dock offline (NR-225: no computer keys).
// Driven through the REAL session edges the app root calls
// (`PttSession.pauseCapture` / `resumeCapture`, app_lifecycle_edges.dart),
// never by poking the away log directly.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/audio/continuous_away.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/state_machine.dart' as fsm;
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh); // ChatFlowPage's default

Future<void> _mountArticle(WidgetTester tester, ArticleRig r, String id) async {
  await tester.pumpWidget(MaterialApp(
    home: ArticlePage.live(
      controller: r.controller,
      articleId: id,
      strings: _zh,
      bar: () => null,
    ),
  ));
  await tester.pump();
}

/// The Text at [key], or the one Text inside it (the live page keys the
/// status line's box, not its Text).
String _text(WidgetTester tester, String key) {
  final Widget w = tester.widget(find.byKey(Key(key)));
  if (w is Text) return w.data!;
  return tester
      .widget<Text>(
          find.descendant(of: find.byKey(Key(key)), matching: find.byType(Text)))
      .data!;
}

void main() {
  testWidgets(
      '🔴 away and back: the notice on BOTH screens, the gap in the article, '
      'and the notice goes away by itself', (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    DateTime now = DateTime.utc(2026, 10, 14, 9);
    r.session.continuous.away.debugClock = () => now;
    late String id;
    await tester.runAsync(() async {
      id = await r.startRecording();
      await r.say('第一段在这里', 0, isSegment: true, durationMs: 5000);
      await r.say('第二段在这里', 1, isSegment: true, durationMs: 5000);
      now = now.add(const Duration(seconds: 10));
      await r.session.pauseCapture(reason: 'background'); // the app root's edge
      now = now.add(const Duration(seconds: 130));
      await r.session.resumeCapture();
      await r.say('第三段回来以后', 2, isSegment: true, durationMs: 5000);
      await pumpEventQueue();
    });
    final ContinuousAwayReturn back = r.session.continuous.away.lastReturn.value!;
    expect(back.outcome, ContinuousAwayOutcome.resumed);
    expect(back.notRecordedMs, 130000);

    // ① the notes list: the banner slot says it.
    await mountLightRecordScreen(tester, r);
    expect(find.text(_zh.continuousAwayResumed('2:10')), findsOneWidget,
        reason: 'D1 — coming back must be told, on the list as well');

    // ② the in-progress article page: same sentence, and the marker.
    await _mountArticle(tester, r, id);
    expect(_text(tester, 'article.live.awayReturn'),
        _zh.continuousAwayResumed('2:10'));
    expect(_text(tester, 'article.awayGap.0.text'), _zh.articleAwayGap('2:10'),
        reason: 'D3 — the time away is drawn, not folded into a row');
    // The row minted after the return opens its own paragraph, below the
    // marker (the three short rows are ONE paragraph without the gap — see
    // continuous_away_test.dart's positive control). ⚠️ Compared by the
    // paragraph's own text, not 「contains」: this rig's live rows carry the
    // later segments' words too (measured with and without a pause — not
    // NR-213's doing), so a substring would match the wrong paragraph.
    expect(find.byKey(const Key('article.paragraph.2.box')), findsNothing);
    expect(_text(tester, 'article.paragraph.1.text'), '第三段回来以后');
    final double p0 =
        tester.getTopLeft(find.byKey(const Key('article.paragraph.0.box'))).dy;
    final double gap =
        tester.getTopLeft(find.byKey(const Key('article.awayGap.0'))).dy;
    final double p1 =
        tester.getTopLeft(find.byKey(const Key('article.paragraph.1.box'))).dy;
    expect(p0 < gap && gap < p1, isTrue,
        reason: 'the marker sits between the paragraph before and the one after');
    // D-15: the line is READ, not merely set — it wraps instead of clipping.
    final RenderParagraph rp = tester.renderObject<RenderParagraph>(
        find.byKey(const Key('article.awayGap.0.text')));
    expect(rp.didExceedMaxLines, isFalse);
    expect(rp.size.width, lessThanOrEqualTo(tester.view.physicalSize.width));

    // ③ EVENT-type: gone after the auto-hide window, on its own; the marker
    // stays. Stopped first so no capture watchdog runs during the real wait.
    await tester.runAsync(() async {
      await r.controller.pttUp();
      r.session.endContinuous();
      await Future<void>.delayed(kBannerAutoHideAfter + const Duration(milliseconds: 300));
    });
    await tester.pump();
    expect(find.byKey(const Key('article.live.awayReturn')), findsNothing);
    expect(find.byKey(const Key('article.awayGap.0.text')), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    debugCancelBannerAutoHideTimers(r.controller);
    await tester.runAsync(r.dispose);
  });

  testWidgets(
      '🔴 D5 — the ceiling stopped it while away: said on return, with how '
      'long was not recorded', (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    DateTime now = DateTime.utc(2026, 10, 14, 9);
    r.session.continuous.away.debugClock = () => now;
    await tester.runAsync(() async {
      await r.startRecording();
      await r.say('开会了', 0, isSegment: true, durationMs: 5000);
      now = now.add(const Duration(seconds: 5));
      await r.session.pauseCapture(reason: 'background');
      now = now.add(const Duration(seconds: 40));
      await r.session.stopForContinuousCap(); // the cap timer's own call
      now = now.add(const Duration(minutes: 5));
      await r.session.resumeCapture();
      await pumpEventQueue();
    });
    expect(r.session.continuous.away.lastReturn.value!.outcome,
        ContinuousAwayOutcome.stoppedAtCap);
    await mountLightRecordScreen(tester, r);
    expect(find.text(_zh.continuousAwayStoppedAtCap('40s')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    debugCancelBannerAutoHideTimers(r.controller);
    await tester.runAsync(r.dispose);
  });

  testWidgets(
      '🔴 D5 — the one-minute reminder came due while away (real cap timer): '
      'the return carries it', (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    DateTime now = DateTime.utc(2026, 10, 14, 9);
    r.session.continuous.away.debugClock = () => now;
    await tester.runAsync(() async {
      // Ceiling 60.05 s ⇒ the reminder fires 50 ms in, through the wiring in
      // `beginContinuous` (not by calling the away log).
      r.session.beginContinuous(
        cap: const Duration(milliseconds: 60050),
        onWarning: r.controller.noteContinuousCapWarning,
      );
      await r.controller.pttDown();
      await r.session.pauseCapture(reason: 'background');
      await Future<void>.delayed(const Duration(milliseconds: 300));
      // Inside the 60 s ceiling: the away span is clamped to the deadline (F3).
      now = now.add(const Duration(seconds: 30));
      await r.session.resumeCapture();
      await pumpEventQueue();
    });
    expect(r.session.continuous.away.lastReturn.value!.outcome,
        ContinuousAwayOutcome.resumedNearCap);
    await mountLightRecordScreen(tester, r);
    expect(find.text(_zh.continuousAwayResumedNearCap('30s')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    debugCancelBannerAutoHideTimers(r.controller);
    await tester.runAsync(() async {
      await r.controller.pttUp();
      r.session.endContinuous(); // disarm the 60 s ceiling
      await r.dispose();
    });
  });

  testWidgets('🔴 NR-225 — notes screen OFFLINE shows no computer keys',
      (WidgetTester tester) async {
    final ArticleRig r = ArticleRig(); // record-only destination
    r.transport.pushStatus(SocketStatus.disconnected);
    await tester.runAsync(pumpEventQueue);
    await mountLightRecordScreen(tester, r);
    // Positive control: the band IS on screen, in the offline face that used
    // to bring the keys back (`_pttVisualRouted` answers `disabled` first).
    expect(find.byType(ComposeBand), findsWidgets);
    expect(r.controller.connection, isNot(fsm.ConnectionState.connected));
    expect(find.byKey(const ValueKey<String>('compose.keys.group')), findsNothing,
        reason: 'light record has no PC focus — clear/backspace/undo/enter '
            'must be absent, connected or not');
    await tester.pumpWidget(const SizedBox());
    debugCancelBannerAutoHideTimers(r.controller);
    await tester.runAsync(r.dispose);
  });
}
