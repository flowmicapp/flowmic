// Card CR-12-G — searching finds words INSIDE a recording, answers with the
// recording once, and opens it at the paragraph that holds them.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §6 (the CR-12-G row is this file's acceptance), §11 (the whole rule)
//   docs/ui-design/2026-09-22-cr12-live-article-view-demo.html cell G-1
//
// Both search screens are mounted for real (anti-façade ⑥): the full-history
// page (`history.search`) and the 「+」 panel's light-record tab
// (`plus.notes.search`). The recording is made through the production chain
// (`ArticleRig`), so the head, the members and their offsets are the ones the
// app writes — not a hand-built list that could agree with any grouping.
//
// The recording is three rows of 45 s, each ending on 「。」, so under design §3
// every row is its own paragraph. The word 琥珀计划 appears in the SECOND
// paragraph only, and the first paragraph is long enough that the second one
// starts below the fold of a 400×700 page — asserted, not assumed.

import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart' show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart' show articleMembersOf;
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart';
import 'package:flowmic/src/ui/search_article_hit_card.dart';
import 'package:flowmic/src/ui/search_highlight.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

const String kWord = '琥珀计划';
const String kPlainWord = '橘子汽水';
final AppStrings _s = AppStrings(AppLocale.zh);
const Size kPage = Size(400, 700);

/// Long enough (Ahem draws every glyph a font-size square) that paragraph 0
/// fills more than one 700-px page on its own.
final String kFirstRow = '${'今天先把库存口径对一遍再说采购节奏' * 50}。';
const String kSecondRow = '第二段里我们说到了$kWord的进度。';
const String kThirdRow = '最后收个尾。';

/// An ordinary light record — the positive control on both screens.
TimelineEntry _plainRow() => TimelineEntry(
  id: 'plain-1',
  clientId: 'plain-1',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: '普通一行提到了$kPlainWord',
  outputText: '普通一行提到了$kPlainWord',
  status: EntryStatus.noted,
  origin: 'cloud',
  createdAt: DateTime.utc(2026, 1, 1),
  updatedAt: DateTime.utc(2026, 1, 1),
);

class _Made {
  _Made(this.rig, this.head, this.hitRowId);
  final ArticleRig rig;
  final TimelineEntry head;
  final String hitRowId;
}

/// Records the three rows through the production chain, then writes the plain
/// row. Each settle gets a widget pump before the next final (the interleaving
/// note in article_paragraph_screen_test.dart).
Future<_Made> _record(WidgetTester tester) async {
  final ArticleRig r = ArticleRig();
  addTearDown(r.dispose);
  await mountLightRecordScreen(tester, r);
  Future<void> step(Future<void> Function() f) async {
    await tester.runAsync(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  late String id;
  await step(() async => id = await r.startRecording());
  await step(() => r.say(kFirstRow, 0, isSegment: true, durationMs: 45000));
  await step(() => r.say(kSecondRow, 1, isSegment: true, durationMs: 45000));
  await step(() => r.controller.pttUp());
  await step(() => r.say(kThirdRow, 2, isSegment: false, durationMs: 45000));
  await step(() async => r.session.endContinuous());
  await tester.runAsync(() => r.persistence.upsert(_plainRow()));
  await tester.runAsync(pumpEventQueue);

  // Positive controls on the FIXTURE: three rows, three paragraphs, and the
  // word in the second paragraph only. Without these a merged fixture would
  // make every assertion below pass or fail for a reason unrelated to search.
  final List<TimelineEntry> members = articleMembersOf(r.store, id);
  expect(<String>[for (final TimelineEntry m in members) m.displayText],
      <String>[kFirstRow, kSecondRow, kThirdRow]);
  final List<ArticleParagraph> paragraphs = paragraphsOf(members);
  expect(paragraphs, hasLength(3), reason: 'one paragraph per 45 s row');
  expect(paragraphText(paragraphs[1]), contains(kWord));
  expect(paragraphText(paragraphs[0]), isNot(contains(kWord)));
  expect(paragraphText(paragraphs[2]), isNot(contains(kWord)));
  final TimelineEntry head = r.store.entries.singleWhere(
    (TimelineEntry e) => e.entryType == TimelineEntry.kArticle,
  );
  expect(head.outputText, isNotEmpty);
  expect(head.outputText, isNot(contains(kWord)),
      reason: 'the word must be found in the body, not in the title');

  tester.view.physicalSize = kPage;
  tester.view.devicePixelRatio = 1.0;
  return _Made(r, head, members[1].id);
}

/// The whole result list is one recording card: its title, match count 1.
void _expectOneRecordingResult(WidgetTester tester, TimelineEntry head) {
  expect(find.byType(SearchArticleHitCard), findsOneWidget,
      reason: 'the recording is ONE result');
  expect(
    tester.widget<Text>(
        find.byKey(ValueKey<String>('entry.article.title.${head.id}'))).data,
    head.outputText,
  );
  expect(
    tester.widget<Text>(
        find.byKey(ValueKey<String>('search.article.hits.${head.id}'))).data,
    _s.historyHitsInRecording(1),
  );
}

/// The current route is the recording, the matching paragraph's header is on
/// screen, and the word is washed in the RENDERED paragraph.
void _expectOpenedAtHit(WidgetTester tester) {
  expect(find.byType(ArticlePage), findsOneWidget);
  expect(ModalRoute.of(tester.element(find.byType(ArticlePage)))!.isCurrent,
      isTrue);
  final Finder header = find.byKey(const Key('article.paragraph.1'));
  expect(header, findsOneWidget,
      reason: 'the paragraph holding the match must be on screen');
  final Rect r = tester.getRect(header);
  expect(r.top >= 0 && r.bottom <= kPage.height, isTrue,
      reason: 'header rect $r must lie inside the 700-px page');

  final RenderParagraph body = tester.renderObject<RenderParagraph>(
    find.descendant(
      of: find.byKey(const Key('article.paragraph.1.text')),
      matching: find.byType(RichText),
    ),
  );
  final List<TextSpan> washed = <TextSpan>[];
  body.text.visitChildren((InlineSpan span) {
    if (span is TextSpan &&
        span.text == kWord &&
        span.style?.backgroundColor == searchHighlightColor) {
      washed.add(span);
    }
    return true;
  });
  expect(washed, hasLength(1),
      reason: 'the word is highlighted exactly once in paragraph 1');
}

Future<void> _mountHistory(WidgetTester tester, ArticleRig r) async {
  await tester.pumpWidget(MaterialApp(
    home: HistoryPage(
      store: r.store,
      storageKind: TimelineStorageKind.sqlite,
    ),
  ));
  await tester.pumpAndSettle();
}

Future<void> _mountPanel(WidgetTester tester, ArticleRig r) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: PlusPanelNotesTab(
        strings: _s,
        query: LightRecordQuery(persistence: r.persistence),
        isSignedIn: () => true,
      ),
    ),
  ));
  await tester.runAsync(pumpEventQueue);
  await tester.pumpAndSettle();
}

Future<void> _typePanel(WidgetTester tester, String q) async {
  await tester.enterText(
      find.byKey(const ValueKey<String>('plus.notes.search')), q);
  await tester.pump(kLightRecordSearchDebounce + const Duration(milliseconds: 50));
  await tester.runAsync(pumpEventQueue);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('precondition: opened without a focus, paragraph 1 is below the '
      'fold', (WidgetTester tester) async {
    final _Made m = await _record(tester);
    await tester.pumpWidget(MaterialApp(
      home: ArticlePage(
        head: m.head,
        rows: articleMembersOf(m.rig.store, m.head.articleId!),
        strings: _s,
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('article.paragraph.0')), findsOneWidget);
    expect(find.byKey(const Key('article.paragraph.1')), findsNothing,
        reason: 'the scroll assertion below is only worth something if the '
            'paragraph did not start on screen');
  });

  testWidgets('🔴 full history: one result per recording, opens at the '
      'matching paragraph with the word highlighted', (WidgetTester tester) async {
    final _Made m = await _record(tester);
    await _mountHistory(tester, m.rig);

    await tester.enterText(
        find.byKey(const ValueKey<String>('history.search')), kWord);
    await tester.pumpAndSettle();

    _expectOneRecordingResult(tester, m.head);
    expect(find.byType(ChatMessageTile), findsNothing,
        reason: 'the matching part is not listed on its own');
    expect(find.text(_s.historySearchHits(1)), findsOneWidget);

    await tester.tap(
        find.byKey(ValueKey<String>('entry.article.open.${m.head.id}')));
    await tester.pumpAndSettle();
    _expectOpenedAtHit(tester);
  });

  testWidgets('full history: an ordinary row is still an ordinary result '
      '(positive control)', (WidgetTester tester) async {
    final _Made m = await _record(tester);
    await _mountHistory(tester, m.rig);

    await tester.enterText(
        find.byKey(const ValueKey<String>('history.search')), kPlainWord);
    await tester.pumpAndSettle();

    expect(find.text('普通一行提到了$kPlainWord'), findsOneWidget);
    expect(find.byType(ChatMessageTile), findsOneWidget);
    expect(find.byType(SearchArticleHitCard), findsNothing);
  });

  testWidgets('🔴 「+」 panel: one result per recording, opens at the matching '
      'paragraph with the word highlighted', (WidgetTester tester) async {
    final _Made m = await _record(tester);
    await _mountPanel(tester, m.rig);

    await _typePanel(tester, kWord);

    _expectOneRecordingResult(tester, m.head);
    expect(find.byKey(ValueKey<String>('plus.notes.row.${m.hitRowId}')),
        findsNothing,
        reason: 'the matching part is not listed on its own');
    expect(find.byKey(const ValueKey<String>('plus.notes.row.plain-1')),
        findsNothing);

    await tester.tap(
        find.byKey(ValueKey<String>('entry.article.open.${m.head.id}')));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    _expectOpenedAtHit(tester);
  });

  testWidgets('「+」 panel: an ordinary light record is still an ordinary '
      'result (positive control)', (WidgetTester tester) async {
    final _Made m = await _record(tester);
    await _mountPanel(tester, m.rig);

    await _typePanel(tester, kPlainWord);

    expect(find.byKey(const ValueKey<String>('plus.notes.row.plain-1')),
        findsOneWidget);
    expect(find.text('普通一行提到了$kPlainWord'), findsOneWidget);
    expect(find.byType(SearchArticleHitCard), findsNothing);
  });
}
