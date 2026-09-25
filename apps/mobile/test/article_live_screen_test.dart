// Card CR-12-C — the in-progress article page, on the REAL light-record screen.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §4.2–§4.6, §6 CR-12-C row (this file is its acceptance)
//   docs/ui-design/2026-09-22-cr12-live-article-view-demo.html cells F-1 / F-2 / F-3
//   apps/mobile/lib/src/ui/article_page_live.dart
//
// The deliverable is 「what the user sees after pressing Start」, so every case
// starts at the dock's entry row on a mounted `ChatFlowPage`, goes through the
// briefing sheet, and lets production push the page (anti-façade ⑥: the
// screen that is the deliverable is the one mounted). Finals arrive as wire
// frames through `ArticleRig`; nothing between the socket and the pixels is
// stubbed except the recorder and the account fetcher.
//
// ⚠️ `runAsync` around every step that awaits production futures — the
// session's `pttDown`, the store's settle — for the reason article_rig.dart
// gives: in the fake-async zone they never complete and the test hangs quietly.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart' show PttSessionContinuous;
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show LiveDraftTile;
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart' show makePcm;

final AppStrings _zh = AppStrings.of(AppLocale.zh);

/// A phone-sized light-record screen whose dock offers continuous recording:
/// record-only destination (the rig), signed in, a 30-minute ceiling.
Future<ArticleRig> _mount(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final ArticleRig r = ArticleRig();
  final login = newTestLogin(
    transport: r.transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-cr12c', email: 'x@example.com', plan: 'pro'),
    ),
  );
  await tester.runAsync(login.hydrate);
  final account = newTestCloudSummary(
    login: login,
    fetcher: fixedCloudSummary(testSummary(continuousMinutes: 30)),
  );
  addTearDown(() async {
    account.dispose();
    login.dispose();
    await r.dispose();
  });
  await tester.runAsync(() async {
    account.refresh();
    await Future<void>.delayed(Duration.zero);
  });
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: r.controller,
        cloudSummary: account,
        isSignedIn: () => login.isLoggedIn,
      ),
    ),
  );
  await tester.pump();
  return r;
}

/// Let production futures finish, then let the frame (and any route
/// transition) land.
Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 4; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump(const Duration(milliseconds: 400));
}

/// Entry row → briefing sheet → Start: the user's two taps.
Future<void> _startFromEntry(WidgetTester tester, ArticleRig r) async {
  expect(
    find.byKey(ContinuousEntryKeys.row),
    findsOneWidget,
    reason: 'positive control: the dock offers the entry',
  );
  await tester.tap(find.byKey(ContinuousEntryKeys.row));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ContinuousSheetKeys.start));
  await _settle(tester);
  _feed(tester, r);
}

/// Real PCM, so the capture watchdog (`DEAD CAPTURE` after 1.5 s of silence
/// from the platform) does not abort a case that runs longer than that.
void _feed(WidgetTester tester, ArticleRig r) => r.recorder.feed(makePcm(6400));

/// End whatever is still running so no session timer outlives the test.
Future<void> _wrapUp(WidgetTester tester, ArticleRig r) async {
  if (r.controller.hasLiveDraft) {
    await tester.runAsync(() => r.controller.pttUp());
    await _final(tester, r, '收尾', 99, isSegment: false, durationMs: 1000);
  }
  r.session.endContinuous();
  // Two beats: a banner auto-hide window (4 s) can be armed by the first.
  await tester.pump(const Duration(seconds: 5));
  await tester.pump(const Duration(seconds: 5));
}

Future<void> _final(
  WidgetTester tester,
  ArticleRig r,
  String text,
  int idx, {
  bool isSegment = true,
  int durationMs = 30000,
}) async {
  await tester.runAsync(
    () => r.say(text, idx, isSegment: isSegment, durationMs: durationMs),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Finder _onPage(Finder f) =>
    find.descendant(of: find.byType(ArticlePage), matching: f);

bool _pageIsCurrentRoute(WidgetTester tester) {
  final Finder page = find.byType(ArticlePage);
  if (page.evaluate().isEmpty) return false;
  return ModalRoute.of(tester.element(page))?.isCurrent ?? false;
}

String _label(WidgetTester tester, int k) =>
    tester.widget<Text>(find.byKey(Key('article.paragraph.$k'))).data ?? '';

ScrollPosition _position(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(
        of: find.byKey(const Key('article.body')),
        matching: find.byType(Scrollable),
      ),
    )
    .position;

/// About 200 characters: several lines on a 360 dp screen, so a handful of
/// these overflows the viewport.
String _long(int i) => '第$i段：${'库存口径与采购节奏要先对齐定义再看数，分两批走，月初一批，月中看数据再定第二批' * 3}';

void main() {
  testWidgets('🔴 Start ⇒ the article page is the current route, with the bar '
      'at its foot', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);

    expect(
      r.session.continuousStillCapturing,
      isTrue,
      reason: 'positive control: the recording really started',
    );
    expect(
      _pageIsCurrentRoute(tester),
      isTrue,
      reason: 'design §4.3: pressing Start opens the article page',
    );
    expect(_onPage(find.byKey(ContinuousLiveKeys.bar)), findsOneWidget);
    expect(_onPage(find.byKey(ContinuousLiveKeys.stop)), findsOneWidget);
    expect(
      _onPage(find.byKey(ContinuousLiveKeys.open)),
      findsNothing,
      reason: 'on the page itself there is nowhere further to open',
    );
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 three finals ⇒ paragraph heads, the open one start-only, the '
      'draft under it', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, '今天先过两件事。', 0, durationMs: 45000);
    await _final(tester, r, '第一件是库存口径', 1, durationMs: 30000);
    await _final(tester, r, '第二件是采购节奏', 2, durationMs: 40000);

    expect(
      _label(tester, 0),
      '00:00–00:45',
      reason: 'a closed paragraph carries its whole range',
    );
    expect(
      _label(tester, 1),
      '00:45',
      reason: 'design §4.4: the open paragraph shows its start alone',
    );
    expect(find.byKey(const Key('article.paragraph.2')), findsNothing);
    expect(_onPage(find.byType(LiveDraftTile)), findsOneWidget);
    final double openBottom = tester
        .getBottomLeft(find.byKey(const Key('article.paragraph.1.box')))
        .dy;
    final double draftTop = tester
        .getTopLeft(find.byKey(const Key('article.live.draft')))
        .dy;
    expect(
      draftTop,
      greaterThanOrEqualTo(openBottom),
      reason: 'the draft hangs under the open paragraph, outside it',
    );
    expect(
      tester
          .widget<Text>(find.byKey(const Key('article.paragraph.1.text')))
          .data,
      '第一件是库存口径第二件是采购节奏',
      reason: 'the draft is not a row: the open paragraph holds only finals',
    );
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 scrolled up ⇒ a new final does not move the reader; back at '
      'the bottom ⇒ following resumes', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    for (int i = 0; i < 6; i++) {
      await _final(tester, r, '${_long(i)}。', i, durationMs: 45000);
    }
    await tester.pump();
    ScrollPosition p = _position(tester);
    expect(
      p.maxScrollExtent,
      greaterThan(p.viewportDimension),
      reason: 'positive control: the transcript overflows the screen',
    );
    expect(
      p.pixels,
      p.maxScrollExtent,
      reason: 'positive control: at the bottom, new content is followed',
    );

    await tester.drag(
      find.byKey(const Key('article.body')),
      const Offset(0, 700),
    );
    // One frame and no time: nothing live has rebuilt the page yet.
    await tester.pump();
    p = _position(tester);
    expect(
      p.maxScrollExtent - p.pixels,
      greaterThan(p.viewportDimension / 4),
      reason:
          'positive control: the drag took the reader past the follow '
          'threshold',
    );
    // Now let the live draft tick (it rebuilds the page several times a
    // second) and the fling settle.
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    p = _position(tester);
    final double readingAt = p.pixels;
    final double maxBefore = p.maxScrollExtent;
    expect(
      maxBefore - readingAt,
      greaterThan(p.viewportDimension / 4),
      reason:
          'design §4.4: live updates do not pull a reader who scrolled '
          'up back down',
    );

    await _final(tester, r, '${_long(6)}。', 6, durationMs: 45000);
    await tester.pump();
    p = _position(tester);
    expect(
      p.maxScrollExtent,
      greaterThan(maxBefore),
      reason: 'positive control: the new paragraph really arrived below',
    );
    expect(
      p.pixels,
      readingAt,
      reason: 'design §4.4: a reader who scrolled up is not pulled down',
    );

    await tester.drag(
      find.byKey(const Key('article.body')),
      const Offset(0, -6000),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    await _final(tester, r, '${_long(7)}。', 7, durationMs: 45000);
    await tester.pump();
    p = _position(tester);
    expect(
      p.pixels,
      p.maxScrollExtent,
      reason: 'back at the bottom, following resumes',
    );
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 Stop ⇒ the bar goes, every paragraph is closed, the title is '
      'the head\'s', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, '今天先过两件事。', 0, durationMs: 45000);
    await _final(tester, r, '第一件是库存口径', 1, durationMs: 30000);
    expect(_label(tester, 1), '00:45', reason: 'positive control: still open');

    await tester.tap(_onPage(find.byKey(ContinuousLiveKeys.stop)));
    await _settle(tester);
    await _final(tester, r, '第二件是采购节奏', 2, isSegment: false, durationMs: 40000);
    await tester.pump(const Duration(milliseconds: 100));

    expect(
      _pageIsCurrentRoute(tester),
      isTrue,
      reason: 'design §4.3: the page stays where it is',
    );
    expect(_onPage(find.byKey(ContinuousLiveKeys.bar)), findsNothing);
    expect(_onPage(find.byType(LiveDraftTile)), findsNothing);
    expect(_label(tester, 0), '00:00–00:45');
    expect(
      _label(tester, 1),
      '00:45–01:55',
      reason: 'onEnd: the last paragraph is sealed with its end',
    );
    final TimelineEntry head = r.store.entries.singleWhere(
      (TimelineEntry e) => e.entryType == TimelineEntry.kArticle,
    );
    expect(head.outputText, isNotEmpty);
    expect(
      _onPage(
        find.descendant(
          of: find.byType(AppBar),
          matching: find.text(head.outputText),
        ),
      ),
      findsOneWidget,
    );
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 the server\'s ceiling ⇒ recordingAutoStopped stands on the '
      'page', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, '今天先过两件事。', 0, durationMs: 45000);
    expect(
      _onPage(find.text(_zh.recordingAutoStopped)),
      findsNothing,
      reason: 'positive control: nothing claims a stop before one happens',
    );

    // `session_cap` reaches the phone as `hard_limit` (server-core
    // `stt/audio/session.ts`: `HardLimitOrigin` → `autoStop('hard_limit')`).
    await tester.runAsync(() async {
      r.transport.pushIncoming(
        FlowMicEvents.audioAutoStopped,
        <String, Object?>{'reason': 'hard_limit'},
      );
      await pumpEventQueue();
    });
    await _settle(tester);
    expect(_onPage(find.text(_zh.recordingAutoStopped)), findsOneWidget);

    // A status banner, not an event: still there after the list's own
    // auto-hide window has passed.
    _feed(tester, r);
    await tester.pump(const Duration(seconds: 6));
    expect(_onPage(find.text(_zh.recordingAutoStopped)), findsOneWidget);
    await _wrapUp(tester, r);
  });

  testWidgets('the phone\'s own ceiling ⇒ the same sentence the list banner '
      'picks for it', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, '今天先过两件事。', 0, durationMs: 45000);

    await tester.runAsync(() => r.session.stopForContinuousCap());
    await _settle(tester);
    expect(
      _onPage(find.text(_zh.recordingStoppedContinuousCap)),
      findsOneWidget,
    );
    expect(_onPage(find.text(_zh.recordingAutoStoppedQuota)), findsNothing);
    expect(_onPage(find.byKey(ContinuousLiveKeys.bar)), findsNothing);
    await _wrapUp(tester, r);
  });

  testWidgets('🔴 Back ⇒ the recording keeps going, the dock bar reopens the '
      'page', (WidgetTester tester) async {
    final ArticleRig r = await _mount(tester);
    await _startFromEntry(tester, r);
    await _final(tester, r, '今天先过两件事。', 0, durationMs: 45000);

    await tester.pageBack();
    await _settle(tester);
    expect(find.byType(ArticlePage), findsNothing);
    expect(
      r.session.continuousStillCapturing,
      isTrue,
      reason: 'design §4.3: no exit stops the recording',
    );
    expect(
      find.byKey(ContinuousLiveKeys.bar),
      findsOneWidget,
      reason: 'the dock still carries the live bar',
    );

    await tester.tap(find.byKey(ContinuousLiveKeys.open));
    await _settle(tester);
    expect(_pageIsCurrentRoute(tester), isTrue);
    expect(
      _label(tester, 0),
      '00:00',
      reason: 'the same recording, read from the store again',
    );
    await _wrapUp(tester, r);
  });
}
