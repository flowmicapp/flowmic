// Card CR-12-B — the read-back page draws PARAGRAPHS, reached from both of
// the places a finished recording is opened.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §6 (the CR-12-B row is this file's acceptance), §3.3 items 3–4 (what a
//     paragraph label says when a length or a start is unknown), §4.6 (zero
//     new strings)
//   docs/ui-design/2026-09-22-cr12-live-article-view-demo.html cell E-2′
//
// The deliverable is 「what the user sees on ArticlePage」, and there are two
// doors into it: the card on the light-record screen (`chat_flow_article.dart`)
// and the 「+」 panel's light-record tab (`plus_panel_notes_tab.dart`). Each
// door hands the page its own member list, so both are mounted here — the
// rule from article_screen_test.dart's header (anti-façade ⑥): a page test
// with a hand-built list is one half of the claim, the door is the other.
//
// The recording is 45 s / 30 s / 40 s with the first row ending on 「。」:
// under design §3 the first row stands alone (45 s ≥ the 40 s floor, edge
// qualified) and the other two form one paragraph (30 s is under the floor).
// So the page must show 00:00–00:45 and 00:45–01:55 — and must NOT show
// 00:45–01:15, which is the second ROW's own range and exactly what the
// superseded per-row page (cell E-2) would have drawn.

import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart' show articleMembersOf;
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

/// 45 s ending on 「。」, then 30 s, then the terminal 40 s — see the header.
///
/// ⚠️ THE SCREEN IS MOUNTED FIRST AND PUMPED AFTER EVERY FINAL. Fed back to
/// back inside one `runAsync` (as `ArticleRig.recordThreeAndStop` does), the
/// settles interleave and the first row carries the whole span it covers —
/// measured here: row 0 read 「今天先过两件事。\n第一件是库存口径第二件是采购
///节奏」, which does not end on 「。」, so the page correctly drew one
/// paragraph. This file's claim depends on the per-row text, so each settle is
/// allowed to land (it needs a widget pump, article_wp2_screen_test.dart A-1)
/// before the next final arrives.
Future<String> _recordFortyFiveThirtyForty(
  WidgetTester tester,
  ArticleRig r,
) async {
  await mountLightRecordScreen(tester, r);
  Future<void> step(Future<void> Function() f) async {
    await tester.runAsync(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  late String id;
  await step(() async => id = await r.startRecording());
  await step(() => r.say('今天先过两件事。', 0, isSegment: true, durationMs: 45000));
  await step(() => r.say('第一件是库存口径', 1, isSegment: true, durationMs: 30000));
  await step(() => r.controller.pttUp());
  await step(() => r.say('第二件是采购节奏', 2, isSegment: false, durationMs: 40000));
  await step(() async => r.session.endContinuous());
  return id;
}

/// Positive control: the chain really produced three rows of the lengths the
/// header argues from. Without it a merged fixture (article_screen_test.dart
/// warns settles can interleave under `runAsync`) would make the assertions
/// below pass or fail for a reason unrelated to the page.
void _expectThreeRows(ArticleRig r, String articleId) {
  final List<TimelineEntry> members = articleMembersOf(r.store, articleId);
  expect(
    <int?>[for (final TimelineEntry m in members) m.durationMs],
    <int>[45000, 30000, 40000],
    reason: 'the recording must be three rows, 45 s / 30 s / 40 s',
  );
  expect(members.first.displayText, '今天先过两件事。',
      reason: 'row 0 must end on 「。」 — the fixture fact the header argues '
          'from (see the interleaving note above)');
}

String _textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data ?? '';

/// What both doors must show, asserted on the rendered page.
void _expectParagraphHeads(WidgetTester tester) {
  expect(find.byType(ArticlePage), findsOneWidget);
  expect(find.text('00:00–00:45'), findsOneWidget);
  expect(find.text('00:45–01:55'), findsOneWidget);
  expect(find.text('00:45–01:15'), findsNothing,
      reason: 'that is the second ROW\'s range; the page draws paragraphs');
  expect(_textOf(tester, 'article.paragraph.0'), '00:00–00:45');
  expect(_textOf(tester, 'article.paragraph.1'), '00:45–01:55');
  expect(find.byKey(const Key('article.paragraph.2')), findsNothing,
      reason: 'three rows, two paragraphs');
  // The words are all still there — grouping must not drop a row.
  expect(find.textContaining('两件事'), findsWidgets);
  expect(find.textContaining('库存口径'), findsWidgets);
  expect(find.textContaining('采购节奏'), findsWidgets);
  // And a paragraph is drawn as ONE passage (approved cell E-2′): no '\n'
  // inside, CJK rows joined directly — the [paragraphText] rule, not the
  // forward rule `joinSelectedTexts` (one record, one newline).
  final String p0 = _textOf(tester, 'article.paragraph.0.text');
  expect(p0, isNot(contains('\n')));
  expect(p0, '今天先过两件事。');
  final String p1 = _textOf(tester, 'article.paragraph.1.text');
  expect(p1, isNot(contains('\n')));
  expect(p1, '第一件是库存口径第二件是采购节奏');
}

const String kArticleId = 'a0-1788000000000000';

TimelineEntry _member({
  required String id,
  required String text,
  required int? offsetMs,
  int? durationMs,
}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  origin: 'cloud',
  durationMs: durationMs,
  articleId: kArticleId,
  articleOffsetMs: offsetMs,
  createdAt: DateTime.utc(2026, 9, 23, 9),
  updatedAt: DateTime.utc(2026, 9, 23, 9),
);

TimelineEntry _head() => TimelineEntry(
  id: 'loc_head',
  clientId: kArticleId,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '会议记录',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kArticle,
  articleId: kArticleId,
  origin: 'cloud',
  durationMs: 85000,
  segmentsCount: 3,
  createdAt: DateTime.utc(2026, 9, 23, 9),
  updatedAt: DateTime.utc(2026, 9, 23, 9, 1),
);

Future<void> _mountPage(WidgetTester tester, List<TimelineEntry> rows) async {
  await tester.pumpWidget(MaterialApp(
    home: ArticlePage(
      head: _head(),
      rows: rows,
      strings: AppStrings(AppLocale.zh),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('🔴 from the card: the page shows paragraphs, not rows',
      (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    final String id = await _recordFortyFiveThirtyForty(tester, r);
    _expectThreeRows(r, id);

    await tester.tap(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();

    _expectParagraphHeads(tester);
  });

  testWidgets('🔴 from the 「+」 panel: the same paragraphs',
      (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    final String id = await _recordFortyFiveThirtyForty(tester, r);
    // One more beat lets the fire-and-forget persist reach the disk the panel
    // reads (article_wp2_screen_test.dart A-1).
    await tester.runAsync(pumpEventQueue);
    _expectThreeRows(r, id);
    final TimelineEntry head = r.store.entries.singleWhere(
      (TimelineEntry e) => e.entryType == TimelineEntry.kArticle,
    );

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PlusPanelNotesTab(
          strings: AppStrings(AppLocale.zh),
          query: LightRecordQuery(persistence: r.persistence),
          isSignedIn: () => true,
        ),
      ),
    ));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();

    await tester.tap(
      find.byKey(ValueKey<String>('plus.notes.openArticle.${head.id}')),
    );
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();

    _expectParagraphHeads(tester);
  });

  testWidgets('🔴 a row without a length: the label gives the start, never a '
      'made-up end', (WidgetTester tester) async {
    // r1 has no duration, so the article clock did not advance past it and
    // r2 sits at the same offset (ArticleClock.claim). The rule still groups
    // r1+r2 (the unknown row adds 0 to the floor), and `last.offset +
    // last.duration` would print 00:45–01:25 — earlier than the audio runs.
    await _mountPage(tester, <TimelineEntry>[
      _member(id: 'r0', text: '今天先过两件事。', offsetMs: 0, durationMs: 45000),
      _member(id: 'r1', text: '中间这一段', offsetMs: 45000),
      _member(id: 'r2', text: '最后一段', offsetMs: 45000, durationMs: 40000),
    ]);

    expect(_textOf(tester, 'article.paragraph.0'), '00:00–00:45',
        reason: 'positive control: a paragraph whose rows all have a length '
            'keeps its end');
    expect(_textOf(tester, 'article.paragraph.1'), '00:45');
    expect(find.text('00:45–01:25'), findsNothing,
        reason: 'the end would be short by the unknown row\'s real length');
    final String body = _textOf(tester, 'article.paragraph.1.text');
    expect(body, contains('中间这一段'));
    expect(body, contains('最后一段'),
        reason: 'the start-only label is on a paragraph that really holds '
            'both rows');
  });

  testWidgets('a paragraph whose start is unknown has no label, and keeps its '
      'words', (WidgetTester tester) async {
    await _mountPage(tester, <TimelineEntry>[
      _member(id: 'r0', text: '不知道从哪开始的一段', offsetMs: null, durationMs: 30000),
    ]);

    expect(find.byKey(const Key('article.paragraph.0')), findsNothing);
    expect(find.byKey(const Key('article.paragraph.0.text')), findsOneWidget,
        reason: 'positive control: the paragraph itself is drawn');
    expect(find.textContaining('00:00'), findsNothing,
        reason: 'unknown is not 0 (design §3.3 item 4)');
  });

  test('a paragraph\'s rows read as one passage (paragraphText), blank rows '
      'dropped', () {
    final ArticleParagraph p = ArticleParagraph(<TimelineEntry>[
      _member(id: 'a', text: '你好。', offsetMs: 0, durationMs: 30000),
      _member(id: 'b', text: '   ', offsetMs: 30000, durationMs: 30000),
      _member(id: 'c', text: 'world', offsetMs: 60000, durationMs: 30000),
    ], closed: true);
    // No space at a CJK boundary, no newline anywhere: this is the read-as-a-
    // paragraph rule, not the forward rule `joinSelectedTexts`.
    expect(paragraphText(p), '你好。world');
  });
}
