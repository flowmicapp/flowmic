// The four rules of the list-side collapse (cell E-1), as a pure function.
//
// ⚠️ READ `article_screen_test.dart` FIRST if you are here to judge whether the
// feature works. THESE RULES WERE ALREADY RIGHT during the 0.3.47 defect — the
// collapse was simply not applied to the screen the user was looking at. A test
// file that pins a correct rule can be green for as long as nobody calls it,
// which is why the wiring gets its own file and this one says so out loud.
//
// What is worth pinning here, and only here, is the two cases the screen test
// cannot conveniently build: a member with no head in the window, and the
// difference between 「recording」 and 「being caught up」.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_view.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

const String kA = 'a0-1788000000000000';
const String kB = 'a1-1788000000009999';

TimelineEntry _row(String id, {String? article, int? offsetMs}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: id,
  outputText: id,
  status: EntryStatus.noted,
  origin: 'cloud',
  articleId: article,
  articleOffsetMs: offsetMs,
  createdAt: DateTime.utc(2026, 8, 30, 9),
  updatedAt: DateTime.utc(2026, 8, 30, 9),
);

TimelineEntry _head(String article) => TimelineEntry(
  id: 'loc_$article',
  clientId: article,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '会议记录',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kArticle,
  articleId: article,
  origin: 'cloud',
  createdAt: DateTime.utc(2026, 8, 30, 9),
  updatedAt: DateTime.utc(2026, 8, 30, 9),
);

List<String> _ids(List<TimelineEntry> rows) =>
    rows.map((TimelineEntry e) => e.id).toList();

void main() {
  test('a finished article keeps its head and loses its members', () {
    final List<TimelineEntry> out = collapseArticles(<TimelineEntry>[
      _head(kA),
      _row('s1', article: kA, offsetMs: 0),
      _row('s2', article: kA, offsetMs: 30000),
      _row('note'),
    ]);
    // The head stays WHERE IT WAS, which is the recording's start — the list is
    // chronological and the card belongs at the moment the button was pressed,
    // not at the moment its first sentence settled.
    expect(_ids(out), <String>['loc_$kA', 'note']);
  });

  test('the live recording is left alone — rows stay, and its card is not drawn yet', () {
    final List<TimelineEntry> out = collapseArticles(
      <TimelineEntry>[
        _head(kA),
        _row('a1', article: kA, offsetMs: 0),
        _head(kB),
        _row('b1', article: kB, offsetMs: 0),
      ],
      liveArticleId: kB,
    );
    // 🔴 RE-JUDGED, NOT RELAXED (2026-08-30). This case used to expect
    // `loc_$kB` — the LIVE recording's own head — to stand in the list.
    // Mounting the real screen showed what that means: a half-built card
    // sitting beside the in-progress bar, both answering 「how is this
    // recording going」, and the card always the staler of the two. Demo cell
    // C-1 draws the bar and no card.
    // ⇒ the rule changed and this expectation follows it. The C-1 case in
    // `article_screen_test.dart` is what pins the new one on a real screen —
    // this line alone could have been 「fixed」 in either direction.
    expect(_ids(out), <String>['loc_$kA', 'b1'],
        reason: 'yesterday\'s recording is a card; the one being recorded is '
            'still a transcript, and has no card of its own yet');
  });

  test('🔴 a member whose head is not in the window stays a row', () {
    // Two real producers: the page pages UPWARD, so a card can be one scroll
    // above the rows it owns; and a head deleted while its members were not.
    // In both, hiding the member would take words off the screen with nothing
    // to open instead — the collapse may only ever REPLACE, never subtract.
    final List<TimelineEntry> out = collapseArticles(<TimelineEntry>[
      _row('orphan', article: kA, offsetMs: 0),
      _row('note'),
    ]);
    expect(_ids(out), <String>['orphan', 'note']);
  });

  test('a list with no articles is returned untouched', () {
    final List<TimelineEntry> rows = <TimelineEntry>[_row('x'), _row('y')];
    expect(identical(collapseArticles(rows), rows), isTrue,
        reason: 'the common case must not allocate a copy of every list on '
            'every rebuild of the chat screen');
  });

  test('🔴 a backfill sweep does NOT un-collapse the article it is filling',
      () {
    // The reverse control for `ArticleScribe.liveArticleId` existing at all.
    // `ArticleScribe.articleId` names the REPLAYED article during a recovery
    // sweep — passing that here would make a finished recording explode back
    // into rows mid-sweep and collapse again when it ended. The screen asks
    // 「is this still being recorded」, and only the clock answers that.
    final List<TimelineEntry> rows = <TimelineEntry>[
      _head(kA),
      _row('a1', article: kA, offsetMs: 0),
    ];
    // liveArticleId is null: the microphone is closed, even though a sweep is
    // placing rows into kA right now.
    expect(_ids(collapseArticles(rows)), <String>['loc_$kA']);
  });
}
