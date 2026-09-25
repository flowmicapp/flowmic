// 🔴 CARD RC4-S5 FOLLOW-UP (MAIN ruling 2) — NO 「SAY THAT PART AGAIN」 BANNER
// FOR A STRETCH THE APP WILL RECOVER BY ITSELF; PUSH-TO-TALK KEEPS IT.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5
//     follow-up block)
//   lib/src/ptt/ptt_inbound.dart (`stt:error` arm) + lib/src/ptt/ptt_unheard_tail.dart
//     `_oweUnheardTail` (its return value)
//   test/segment_not_transcribed_banner_test.dart (the banner's own rendering)
//
// A long recording whose relay says STT_SEGMENT_NOT_TRANSCRIBED with
// `unheard_from_ms` now owes that stretch and recovers it in place (the RC4-S5
// block). Telling the user to say it again would put the words in twice; the
// article page's pending line (`article.backfill`) is the sentence that is
// true. A push-to-talk press owes nothing, so there saying it again is the only
// remedy and the banner stays. Both on the real chain, mounted on ChatFlowPage
// (the banner slot) and, for the long recording, ArticlePage (the pending line).
//
// The recovery is answered with a failure here on purpose, so the stretch is
// still owed and the pending line is on the page when it is read.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

// ChatFlowPage paints with the default UI locale (segment_not_transcribed_banner_test.dart says why).
const AppStrings _zh = AppStringsZh();

const int _prefixMs = 36800;
const int _unheardMs = 84000;
const int _totalMs = 102400;
const String _row0 = '今天上午我们先把仓库里积压的几张任务卡过一遍。';
const String _draft = '清晨的访问量最低，就算出了问题影响到的用户也会少很多。';

Finder _sayAgainBanner() => find.descendant(
      of: find.byType(BannerSlot),
      matching: find.text(_zh.sttStallSegmentNotTranscribed),
    );

/// The relay's closing answer to a live stop: the code first, the final after it.
void _answerLiveStop(Rc3Rig r, Rc3Stop stop, {required String text, int? unheardFrom, int segmentIdx = 0, required int durationMs}) {
  Future<void>.delayed(const Duration(milliseconds: 20), () {
    r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
      'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
      'message': 'The recording ended with captured voice that no engine received',
      'retryable': false,
      'unheard_from_ms': ?unheardFrom,
    });
  });
  Future<void>.delayed(const Duration(milliseconds: 80), () {
    r.relay.pushIncoming(FlowMicEvents.sttFinal,
        r.relay.terminal(stop, text: text, durationMs: durationMs, segmentIdx: segmentIdx));
  });
}

Future<void> _mount(WidgetTester tester, Rc3Rig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
}

void main() {
  testWidgets(
      '🔴 a long recording whose unheard stretch is owed ⇒ no say-again banner, '
      'and the article page shows the pending line', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
    });
    addTearDown(() => tester.runAsync(r.dispose));
    await _mount(tester, r);
    await tester.runAsync(() async {
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) {
          // The recovery fails (the vendor is out of time): the stretch stays owed and pending.
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
              'code': 'STT_ENGINE_TIMEOUT', 'message': 'flush cap ran out', 'retryable': false,
            });
          });
          return;
        }
        _answerLiveStop(r, stop, text: _draft, unheardFrom: _unheardMs, segmentIdx: 1,
            durationMs: _totalMs - _prefixMs);
      };
      await r.begin();
      await r.feedMs(_prefixMs);
      await r.segment(_row0, 0, _prefixMs);
      await r.feedMs(_totalMs - _prefixMs);
      await r.controller.pttUp();
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _draft));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // Read right after the relay's frames, where the push-to-talk case below shows the banner.
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _draft],
        reason: 'positive control: the frames arrived and the words that were transcribed are a row');
    expect(_sayAgainBanner(), findsNothing,
        reason: 'the app recovers this stretch; saying it again puts it in twice');

    await tester.runAsync(() async {
      await r.until(() => r.controller.backfill.progress.value.forArticle(r.articleId!).pendingMs > 0);
    });
    await tester.pump();
    expect(_sayAgainBanner(), findsNothing);

    await tester.tap(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();
    expect(find.byType(ArticlePage), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsOneWidget,
        reason: 'the page says the stretch is waiting to be transcribed');
    // The failed pass arms its due-time retry (RC-O) on its way out; let it finish,
    // so the teardown's dispose cancels that timer instead of racing the pass.
    await tester.runAsync(() => r.until(() => !r.controller.backfill.isBusy));
  });

  testWidgets('positive control: a push-to-talk press gets the same frames ⇒ the say-again banner shows',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
    });
    addTearDown(() => tester.runAsync(r.dispose));
    await _mount(tester, r);
    await tester.runAsync(() async {
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) return;
        _answerLiveStop(r, stop, text: _draft, unheardFrom: 2000, durationMs: 4000);
      };
      await r.controller.pttDown();
      await r.feedMs(4000);
      await r.controller.pttUp();
      await r.until(() => r.timeline.entries.any((TimelineEntry e) => e.displayText == _draft));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(r.timeline.entries.map((TimelineEntry e) => e.displayText), contains(_draft),
        reason: 'positive control: the frames arrived');
    expect(_sayAgainBanner(), findsOneWidget);
  });
}
