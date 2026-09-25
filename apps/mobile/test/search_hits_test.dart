// Card CR-12-G — the grouping rule both search screens share (search_hits.dart),
// and the storage limit it depends on.
//
// SPEC-REF: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//   §11.3 (one result per recording, newest matching row decides the order),
//   §11.5 (rows read with a larger limit, cut to results after grouping).
//
// The screens are driven in search_article_screen_test.dart; this file pins the
// rule's edges the screens would only reach by accident.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/search_hits.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

DateTime _t(int minute) => DateTime.utc(2026, 9, 1).add(Duration(minutes: minute));

TimelineEntry _row(
  String id,
  String text, {
  required int at,
  String? articleId,
  int? offsetMs,
  bool head = false,
}) => TimelineEntry(
  id: id,
  clientId: head ? articleId! : id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: head ? null : text,
  outputText: text,
  status: EntryStatus.noted,
  origin: 'cloud',
  entryType: head ? TimelineEntry.kArticle : TimelineEntry.kTranscript,
  articleId: articleId,
  articleOffsetMs: offsetMs,
  durationMs: head ? null : 45000,
  createdAt: _t(at),
  updatedAt: _t(at),
);

List<String> _ids(List<TimelineEntry> rows) =>
    rows.map((TimelineEntry e) => e.id).toList(growable: false);

void main() {
  final TimelineEntry head = _row('h', '会议', at: 0, articleId: 'A', head: true);
  final TimelineEntry m0 =
      _row('m0', '开场白。', at: 1, articleId: 'A', offsetMs: 0);
  final TimelineEntry m1 =
      _row('m1', '说到账期。', at: 2, articleId: 'A', offsetMs: 45000);
  final TimelineEntry m2 =
      _row('m2', '账期还没回。', at: 3, articleId: 'A', offsetMs: 90000);
  final List<TimelineEntry> article = <TimelineEntry>[head, m0, m1, m2];

  test('matching parts of one recording are ONE result, at the position of the '
      'newest matching part, with the first matching paragraph as its focus', () {
    final TimelineEntry older = _row('p-old', '账期旧事', at: -5);
    final TimelineEntry between = _row('p-mid', '账期中间', at: 2);
    // Newest first, as storage hands them over.
    final SearchResults r = groupSearchHits(
      <TimelineEntry>[m2, between, m1, older],
      articleRows: article,
      query: '账期',
    );
    expect(_ids(r.rows), <String>['h', 'p-mid', 'p-old']);
    final ArticleSearchHit hit = r.articleOf(r.rows.first)!;
    expect(hit.hitCount, 2);
    expect(hit.focus!.rowId, 'm1',
        reason: 'first in TRANSCRIPT order, not the newest row');
    expect(hit.focus!.paragraphIndex, 1);
    expect(r.articleOf(between), isNull);
  });

  test('a title-only match is still the recording, with no count and no focus',
      () {
    final SearchResults r = groupSearchHits(<TimelineEntry>[head],
        articleRows: article, query: '账期');
    expect(_ids(r.rows), <String>['h']);
    expect(r.articleOf(head)!.hitCount, 0);
    expect(r.articleOf(head)!.focus, isNull);
  });

  test('a part whose head is gone stays an ordinary row (collapseArticles rule)',
      () {
    final SearchResults r = groupSearchHits(
      <TimelineEntry>[m1],
      articleRows: <TimelineEntry>[m0, m1, m2],
      query: '账期',
    );
    expect(_ids(r.rows), <String>['m1']);
    expect(r.articles, isEmpty);
  });

  test('the limit counts RESULTS: sixty matching parts take one slot', () {
    final List<TimelineEntry> parts = <TimelineEntry>[
      for (int i = 0; i < 60; i++)
        _row('b$i', '账期 $i。', at: 100 + i, articleId: 'B', offsetMs: i * 45000),
    ];
    final TimelineEntry bHead =
        _row('bh', '长会', at: 99, articleId: 'B', head: true);
    final List<TimelineEntry> plain = <TimelineEntry>[
      for (int i = 0; i < 5; i++) _row('q$i', '账期 q$i', at: 50 - i),
    ];
    final SearchResults r = groupSearchHits(
      <TimelineEntry>[...parts.reversed, ...plain],
      articleRows: <TimelineEntry>[bHead, ...parts],
      query: '账期',
      limit: 3,
    );
    expect(_ids(r.rows), <String>['bh', 'q0', 'q1']);
    expect(r.articleOf(bHead)!.hitCount, 60);
  });

  test('hitCount counts OCCURRENCES of the word, not matching rows', () {
    // m2 twice in one row, m1 once: 3, not 2.
    final TimelineEntry twice =
        _row('m3', '账期先说一次，账期再说一次。', at: 4, articleId: 'A', offsetMs: 135000);
    final SearchResults r = groupSearchHits(
      <TimelineEntry>[twice, m1],
      articleRows: <TimelineEntry>[head, m0, m1, m2, twice],
      query: '账期',
    );
    expect(r.articleOf(r.rows.first)!.hitCount, 3);
  });

  test('matchRanges is case-insensitive and finds every occurrence', () {
    expect(matchRanges('Deploy the SERVER, then server', 'server'),
        <(int, int)>[(11, 17), (24, 30)]);
    expect(matchRanges('无关', '账期'), isEmpty);
    expect(matchRanges('anything', '  '), isEmpty);
  });

  test('searchSnippet keeps ~30 characters either side and marks the cuts', () {
    final String text = '${'前' * 50}账期${'后' * 50}';
    final String s = searchSnippet(text, '账期');
    expect(s, '…${'前' * 30}账期${'后' * 30}…');
    expect(searchSnippet('短句里有账期', '账期'), '短句里有账期');
  });

  group('storage', () {
    setUpAll(sqfliteFfiInit);
    setUp(() => databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath));

    test('🔴 the SQLite search reads 1,000 rows by default, so a recording '
        'with 250 matching parts does not push an older ordinary hit out', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final TimelineStorageOpen open = await openTimelinePersistence(
        prefs: await SharedPreferences.getInstance(),
        factory: databaseFactoryFfi,
        path: inMemoryDatabasePath,
      );
      expect(open.kind, TimelineStorageKind.sqlite);
      final TimelinePersistence p = open.persistence;
      await p.upsert(_row('old-plain', '账期在最早那条', at: -1000));
      await p.upsert(_row('ch', '长会', at: 0, articleId: 'C', head: true));
      final List<TimelineEntry> parts = <TimelineEntry>[
        for (int i = 0; i < 250; i++)
          _row('c$i', '账期第 $i 次。', at: i + 1, articleId: 'C', offsetMs: i * 45000),
      ];
      for (final TimelineEntry e in parts) {
        await p.upsert(e);
      }
      final List<TimelineEntry> found = await p.search('账期');
      expect(found, hasLength(251));
      final SearchResults r = groupSearchHits(
        found,
        articleRows: <TimelineEntry>[
          for (final TimelineEntry e in await p.loadAll())
            if (articleIdsOf(found).contains(e.articleId)) e,
        ],
        query: '账期',
      );
      expect(_ids(r.rows), <String>['ch', 'old-plain']);
      expect(r.articleOf(r.rows.first)!.hitCount, 250);
    });
  });
}
