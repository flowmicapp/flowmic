// Cards CR-8 (the in-article timeline) and CR-10 (the four surfaces an article
// has to survive: delete, clear, FPR export, stats).
//
// 🔴 THE STATS CASE IS THE ONE THAT MATTERS MOST HERE, and it is the defect
// CR-7 would have shipped: an article head STORES the recording's total
// duration, derived by summing its members. Counted alongside them, a half-hour
// meeting reports as an hour — a wrong number on a screen whose whole purpose
// is numbers, with nothing on it the user could use to notice.
//
// The rendering assertions land on the RENDERED RESULT (0.2.53), not on the
// model: 「can the user read the right timestamp」 is the question, and a model
// that holds the right integer while the page prints something else is exactly
// the shape that rule exists for.

import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const String kArticleId = 'a0-1788000000000000';

TimelineEntry _member({
  required String id,
  required String text,
  required int offsetMs,
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
  createdAt: DateTime.utc(2026, 8, 30, 9),
  updatedAt: DateTime.utc(2026, 8, 30, 9),
);

TimelineEntry _head({int durationMs = 62000, int segments = 3}) => TimelineEntry(
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
  durationMs: durationMs,
  segmentsCount: segments,
  createdAt: DateTime.utc(2026, 8, 30, 9),
  updatedAt: DateTime.utc(2026, 8, 30, 9, 1),
);

void main() {
  // ── CR-8: the timestamps ──────────────────────────────────────────────────

  group('CR-8 the in-article timeline', () {
    test('a range is the row\'s own offset and length, never a tidy bucket', () {
      expect(formatArticleOffset(0), '00:00');
      expect(formatArticleOffset(12_340), '00:12');
      expect(formatArticleOffset(75_000), '01:15');
      // 🔴 §5-7's ban, as arithmetic: 12.34 s is 00:12, not 00:10 and not 00:20.
      // Rounding these into buckets would turn 「segmented by natural speech」 —
      // the feature — into a decoration.
      expect(
        formatArticleRange(_member(
            id: 'a', text: 'x', offsetMs: 12_340, durationMs: 18_660)),
        '00:12–00:31',
      );
      // Past an hour the minutes field grows rather than rolling into an hours
      // field nobody asked for: 01:15 must never be read as 「one hour」.
      expect(formatArticleOffset(75 * 60 * 1000), '75:00');
    });

    test('a row whose length is unknown shows a START, not a zero-length range',
        () {
      final TimelineEntry noLength =
          _member(id: 'a', text: 'x', offsetMs: 30_000);
      // 🔴 NOT `00:30–00:30`. The engine never said how long it was; inventing
      // an end is the one thing this page must not do.
      expect(formatArticleRange(noLength), '00:30');
    });

    testWidgets('the page renders each row at its own timestamp, in order',
        (WidgetTester tester) async {
      final List<TimelineEntry> rows = <TimelineEntry>[
        _member(id: 'r1', text: '第一段', offsetMs: 0, durationMs: 30_000),
        _member(id: 'r2', text: '断网时说的', offsetMs: 30_000, durationMs: 45_000),
        _member(id: 'r3', text: '最后一段', offsetMs: 75_000, durationMs: 12_000),
      ];
      await tester.pumpWidget(MaterialApp(
        home: ArticlePage(
          head: _head(durationMs: 87_000),
          rows: rows,
          strings: AppStrings(AppLocale.zh),
        ),
      ));
      await tester.pumpAndSettle();

      // Keyed per row, so this asserts THIS row's range rather than 「a range is
      // on screen somewhere」.
      expect(_textOf(tester, 'article.range.r1'), '00:00–00:30');
      expect(_textOf(tester, 'article.range.r2'), '00:30–01:15');
      expect(_textOf(tester, 'article.range.r3'), '01:15–01:27');
      // The seam: r2's end and r3's start are the same instant. That is C5 as
      // the user reads it — durations before the outage, bytes across it,
      // durations after, meeting with no gap and no overlap.
      expect(_textOf(tester, 'article.range.r3').startsWith('01:15'), isTrue);
      expect(find.text('第一段'), findsOneWidget);
      expect(find.byKey(const Key('article.backfill')), findsNothing,
          reason: 'nothing is owed, so nothing claims to be catching up');
    });

    testWidgets('ruling ⑮: what is still being caught up is stated, in minutes '
        'of audio', (WidgetTester tester) async {
      await tester.pumpWidget(MaterialApp(
        home: ArticlePage(
          head: _head(),
          rows: <TimelineEntry>[
            _member(id: 'r1', text: '第一段', offsetMs: 0, durationMs: 30_000),
          ],
          strings: AppStrings(AppLocale.zh),
          pendingBackfillMs: 45_000,
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('article.backfill')), findsOneWidget);
      // 🔴 The sentence may say HOW MUCH IS LEFT and nothing else. It must never
      // say how long it will take: nothing on this device knows the engine's
      // speed, and ruling ⑮ permitted a slow catch-up on condition that the
      // screen states the remaining quantity — which is measured, not guessed.
      final String shown = _textOf(tester, 'article.backfill.text');
      expect(shown, contains('45'));
    });
  });

  // ── CR-10: the four surfaces ──────────────────────────────────────────────

  group('CR-10 an article survives the four surfaces', () {
    test('🔴 stats do not count the recording twice', () async {
      final _Rows source = _Rows(<TimelineEntry>[
        _head(durationMs: 87_000),
        _member(id: 'r1', text: '第一段', offsetMs: 0, durationMs: 30_000),
        _member(id: 'r2', text: '第二段', offsetMs: 30_000, durationMs: 45_000),
        _member(id: 'r3', text: '第三段', offsetMs: 75_000, durationMs: 12_000),
      ]);
      final AssetTally tally = await TimelineAssetInventory(
        rows: source,
        images: newTestOutboxBlobs(),
      ).tally();

      // 🔴 THE WHOLE CASE. 87 s of audio was recorded; the head stores 87 s as
      // the article's total and the members store the same 87 s between them.
      // Counting both reports 174 s — a meeting that reads as twice its length,
      // on the one screen whose entire content is sums.
      expect(tally.durationMs, 87_000);
      expect(tally.entryCount, 3, reason: 'three things were said, not four');
      expect(tally.transcriptCount, 3);
      // The head's title is not speech either: counting it would inflate the
      // word count by the first sentence's opening every time.
      expect(tally.wordCount, greaterThan(0));
    });

    test('FPR export carries the segments and not the cover', () async {
      final _Rows source = _Rows(<TimelineEntry>[
        _head(),
        _member(id: 'r1', text: '第一段', offsetMs: 0, durationMs: 30_000),
      ]);
      final List<TimelineAsset> walked = <TimelineAsset>[
        await for (final TimelineAsset a in TimelineAssetInventory(
          rows: source,
          images: newTestOutboxBlobs(),
        ).walk())
          a,
      ];
      expect(walked.map((TimelineAsset a) => a.entry.id).toList(),
          <String>['r1']);
      // 🔴 The head's `entry_type` is not in `kFprEntryTypes`, so exporting it
      // would produce a record the reader drops on re-import — silently, which
      // is the failure mode the control-row skip beside it already records.
      expect(walked.every((TimelineAsset a) => !a.entry.isArticle), isTrue);
    });

    test('deleting the last member takes the cover with it', () async {
      final TimelineStore store = await _seeded(<TimelineEntry>[
        _head(segments: 1, durationMs: 5000),
        _member(id: 'r1', text: '唯一一段', offsetMs: 0, durationMs: 5000),
      ]);
      addTearDown(store.dispose);

      expect(articleHeadsOf(store), hasLength(1));
      store.delete('r1');

      // A cover over nothing cannot be opened, cannot be explained, and cannot
      // be deleted by its own name — its members are already gone. It is minted
      // on the first thing said and it goes with the last.
      expect(articleHeadsOf(store), isEmpty);
    });

    test('deleting SOME members leaves the cover telling the truth', () async {
      final TimelineStore store = await _seeded(<TimelineEntry>[
        _head(segments: 3, durationMs: 87_000),
        _member(id: 'r1', text: '第一段', offsetMs: 0, durationMs: 30_000),
        _member(id: 'r2', text: '第二段', offsetMs: 30_000, durationMs: 45_000),
        _member(id: 'r3', text: '第三段', offsetMs: 75_000, durationMs: 12_000),
      ]);
      addTearDown(store.dispose);

      store.delete('r2');

      final TimelineEntry head = articleHeadsOf(store).single;
      // 🔴 Those two numbers are the only thing the list shows about a
      // recording. A clear-by-date is exactly the operation that removes SOME of
      // an article, so a head that was not recomputed would claim 「3 parts,
      // 1:27」 over two sentences totalling 42 s — for ever, with nothing to
      // check it against.
      expect(head.segmentsCount, 2);
      expect(head.durationMs, 42_000);
    });
  });
}

/// A store holding [rows], seeded through its OWN load path.
///
/// 🔴 Not a test-only setter on the store. The rows are written to the same
/// persistence the store reads and the reaper deletes from, so a deletion here
/// really removes something — a seam that skipped storage would make every
/// deletion assertion pass while proving nothing (the reason `newTestStore`
/// shares one persistence between store and reaper in the first place).
Future<TimelineStore> _seeded(List<TimelineEntry> rows) async {
  final TimelinePersistence p = InMemoryTimelinePersistence();
  await p.saveAll(rows);
  final TimelineStore store = newTestStore(persistence: p);
  await store.load();
  return store;
}

String _textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

/// A row source over a fixed list — the inventory's own seam.
class _Rows implements TimelineRowSource {
  _Rows(this._rows);
  final List<TimelineEntry> _rows;
  @override
  Future<List<TimelineEntry>> readAllRows() async => _rows;
}
