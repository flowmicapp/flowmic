// 🔴 Codex rc3 ④ — A LATE FINAL OF A PREVIOUS LIVE RECORDING IS NOT THE NEXT
// ONE'S. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   `_dispatch/2026-09-24-codex-review-rc3.out.md` item 4
//   apps/mobile/lib/src/session/chat_utterance_owner.dart (`_ownerOfFinal`)
//   test/support/rc3_rig.dart (the rig)
//
// Long recording A stops; the phone's net gives up before A's final comes
// back (300 ms here), and the user starts long recording B. Then A's terminal
// final arrives, its receipt naming A's attempt. The phone knew only the
// CURRENT live attempt (B's) and recovery attempts, so A's echo was unknown,
// it was labelled `live`, and it was placed on B's clock — A's words inside B,
// B's head longer, and B's hold on the wire released (a recovery could then
// open under B's own final).
//
// Reverse control (log in the report): the prior-live routing removed from
// `_ownerOfFinal` ⇒ red (B gains the row).
//
// ⚠️ 更正（RC4-S5 follow-up, 2026-09-25）：原为 A's net giving up at the rig's
// 300 ms. A long recording's stop now waits max(net, unanswered audio + 5 s),
// or the relay's own stop worst case when no `acked_audio_ms` was seen
// (`ptt_unheard_tail.dart` `_longStopNet`, book 08 §2) — so A's relay here
// reports everything answered (unanswered 0 ⇒ a 5 s net) and B starts after it.
// ⚠️ 更正（RC6 F2，2026-09-25）：that net is now a wait for the final (5 min
// cap); the rig's `longStopCeiling` gives A's wait the original 300 ms again,
// and the answered interim and the 5.5 s sleep above are gone.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _a0 = '第一篇前半段，先把数字过一遍。';
const String _aLast = '第一篇最后一句，迟到的终稿。';
const String _b0 = '第二篇开头，今天只讲发布。';

void main() {
  testWidgets(
      '🔴 Codex rc3 ④: A\'s late terminal final, after B started ⇒ it lands in '
      'A, B gains neither a row nor time, and B keeps the wire',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    late final String a;
    late final String b;
    void Function()? deliverA;
    await tester.runAsync(() async {
      // ⚠️ 更正（RC6 F2，2026-09-25）：a long recording's stop now waits for its
      // final (up to 5 min, `kLongStopWaitCap`); this case needs A's wait to end
      // before its final, so the 300 ms rides on as a ceiling on that wait.
      r = await Rc3Rig.open(processingTimeout: const Duration(milliseconds: 300),
          longStopCeiling: const Duration(milliseconds: 300));
      r.relay.onStop = (Rc3Stop stop) {
        deliverA ??= () => r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _aLast, durationMs: 20000, segmentIdx: 1));
      };
      await r.begin();
      a = r.articleId!;
      await r.feedMs(40000);
      await r.segment(_a0, 0, 40000);
      await r.feedMs(20000);
      await r.controller.pttUp();
      await Future<void>.delayed(const Duration(milliseconds: 500)); // net gave up
      await r.begin();
      b = r.articleId!;
      expect(r.controller.isRecording, isTrue, reason: 'positive control: B runs');
      await r.feedMs(10000);
      await r.segment(_b0, 0, 10000);
      deliverA!();
      await r.until(() =>
          r.timeline.entries.any((TimelineEntry e) => e.displayText == _aLast));
    });
    addTearDown(() => tester.runAsync(() async {
          await r.controller.pttUp();
          await r.dispose();
        }));

    final List<TimelineEntry> rowsB = articleMembersOf(r.timeline, b);
    expect(rowsB.map((TimelineEntry e) => e.displayText).toList(), <String>[_b0],
        reason: 'A\'s words used to land inside B');
    expect(r.timeline.findByClientId(b)!.durationMs, 10000);
    expect(r.session.articles.attempts.liveHold, isTrue,
        reason: 'B\'s final has not come; the wire is still B\'s');
    final List<TimelineEntry> rowsA = articleMembersOf(r.timeline, a);
    expect(rowsA.map((TimelineEntry e) => e.displayText).toList(), <String>[_a0, _aLast]);
    expect(rowsA.last.articleOffsetMs, 40000, reason: 'where A ended');

    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.ancestor(
        of: find.textContaining(_a0.substring(0, 6)),
        matching: find.byType(ChatArticleTile)));
    await tester.pumpAndSettle();
    expect(find.byType(ArticlePage), findsOneWidget);
    expect(find.textContaining(_aLast), findsOneWidget,
        reason: 'A\'s last sentence is on A\'s page');
  });
}
