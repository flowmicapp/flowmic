// owner 2026-08-30: 「轻记录的转录历史中复制」「手机端的全部历史记录中复制」 —
// copying a continuous-recording card copied the text VISIBLE on the collapsed
// card (its title), not the recording. Expected: every segment, each with the
// time label the recording's own timeline shows.
//
// This file pins the ONE renderer (`articleCopyText`) and the two seams every
// copy site goes through (`copyRowToClipboard` for a row, `selectedRecords`
// for a batch). The two screens are driven for real in
// article_copy_screen_test.dart (light-record screen) and
// history_page_article_copy_test.dart (full history) — CLAUDE.md anti-facade
// ⑥: a renderer asserted here and a screen that never calls it are two halves
// that can both be green while the product copies a title.
//
// ⚠️ These cases cannot be run red against the pre-fix tree: they name symbols
// the fix introduces. The red evidence for this defect is the two screen
// files, which drive the product through its menus and read the clipboard.

import 'package:flowmic/src/session/image_clipboard.dart'
    show ImageCopyOutcome;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/article_copy.dart';
import 'package:flowmic/src/ui/article_page.dart' show formatArticleRange;
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/selection/batch_actions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();
const String kArt = 'a0-1788000000000000';
final DateTime _t0 = DateTime.utc(2026, 8, 30, 9);

TimelineEntry _member(String id, String text, int offsetMs, {int? ms}) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      articleId: kArt,
      articleOffsetMs: offsetMs,
      durationMs: ms ?? 30_000,
      createdAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
      updatedAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
    );

/// The cover: its `outputText` is the TITLE (the opening of the first thing
/// said), which is exactly the string the old copy paths handed over.
TimelineEntry _head() => TimelineEntry(
      id: 'loc_$kArt',
      clientId: kArt,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: null,
      outputText: '今天先过两件事',
      status: EntryStatus.noted,
      entryType: TimelineEntry.kArticle,
      articleId: kArt,
      origin: 'cloud',
      durationMs: 90_000,
      segmentsCount: 3,
      createdAt: _t0,
      updatedAt: _t0,
    );

TimelineEntry _plain(String id, String text, DateTime at) => TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      createdAt: at,
      updatedAt: at,
    );

final List<TimelineEntry> _members = <TimelineEntry>[
  _member('s1', '今天先过两件事', 0),
  _member('s2', '第一件是库存口径', 30_000),
  _member('s3', '第二件是采购节奏', 60_000),
];

/// The format, written out once so the assertions below read as the owner's
/// expectation and not as the implementation echoed back.
const String kPiece = '00:00–00:30 今天先过两件事\n'
    '00:30–01:00 第一件是库存口径\n'
    '01:00–01:30 第二件是采购节奏';

void main() {
  group('the one renderer', () {
    test('🔴 every segment, in timeline order, each with the page\'s label',
        () {
      expect(articleCopyText(_members), kPiece);
    });

    test('the label IS the article page\'s label, not a second format', () {
      // `formatArticleRange` is what ArticlePage draws above each row. If
      // someone re-implements the prefix here the two will drift apart and
      // nothing on any screen will say which one is right.
      for (final TimelineEntry m in _members) {
        expect(articleCopyText(<TimelineEntry>[m]),
            '${formatArticleRange(m)} ${m.displayText}');
      }
    });

    test('a segment with no known length gets a START, like the page', () {
      final TimelineEntry m = _member('s9', '不知道多长', 90_000, ms: 0);
      expect(articleCopyText(<TimelineEntry>[m]), '01:30 不知道多长');
    });

    test('a segment with no words prints no line; an empty piece is empty',
        () {
      expect(
        articleCopyText(<TimelineEntry>[_members[0], _member('e', '  ', 30_000)]),
        '00:00–00:30 今天先过两件事',
      );
      expect(articleCopyText(const <TimelineEntry>[]), '');
    });
  });

  group('the single-row seam (long-press → copy)', () {
    test('🔴 a recording head copies its whole piece', () async {
      final List<String> clipboard = <String>[];
      final ImageCopyOutcome out = await copyRowToClipboard(
        _head(),
        membersOf: (String id) async => id == kArt ? _members : const [],
        text: (String t) async => clipboard.add(t),
      );
      expect(out, ImageCopyOutcome.copiedText);
      expect(clipboard, <String>[kPiece]);
      // The negative half: the title alone is what the defect copied.
      expect(clipboard.single, isNot('今天先过两件事'));
    });

    test('an ordinary row is untouched — the reverse control', () async {
      final List<String> clipboard = <String>[];
      bool asked = false;
      await copyRowToClipboard(
        _plain('p', '随口一句', _t0),
        membersOf: (String id) async {
          asked = true;
          return const <TimelineEntry>[];
        },
        text: (String t) async => clipboard.add(t),
      );
      expect(clipboard, <String>['随口一句']);
      expect(asked, isFalse, reason: 'no recording, no lookup');
    });

    test('an empty piece leaves the clipboard alone', () async {
      final List<String> clipboard = <String>[];
      await copyRowToClipboard(
        _head(),
        membersOf: (String id) async => const <TimelineEntry>[],
        text: (String t) async => clipboard.add(t),
      );
      expect(clipboard, isEmpty, reason: 'a copy that wipes is a loss');
    });
  });

  group('the batch seam (multi-select → copy)', () {
    List<TimelineEntry> members(String id) => id == kArt ? _members : const [];

    test('🔴 a recording beside a normal entry: expanded, unchanged, oldest first',
        () {
      // Screen order on the full-history page: newest first.
      final SelectedRecords out = selectedRecords(<TimelineEntry>[
        _plain('later', '录完之后说的', _t0.add(const Duration(minutes: 5))),
        _head(),
      ], membersOf: members);
      expect(out.text, '$kPiece\n录完之后说的');
      expect(out.textRows, 2, reason: 'a recording is ONE record');
      expect(out.imageRows, 0);
    });

    test('a normal entry OLDER than the recording still comes first', () {
      final SelectedRecords out = selectedRecords(<TimelineEntry>[
        _head(),
        _plain('earlier', '录之前说的', _t0.subtract(const Duration(minutes: 5))),
      ], membersOf: members);
      expect(out.text, '录之前说的\n$kPiece');
    });

    test('a segment ticked beside its own recording is not copied twice', () {
      // The full-history page lists members as rows, so 「select all」 ticks
      // the head AND its segments. The segment is already inside the piece.
      final SelectedRecords out = selectedRecords(<TimelineEntry>[
        _members[2],
        _members[1],
        _members[0],
        _head(),
      ], membersOf: members);
      expect(out.text, kPiece);
      expect(out.textRows, 1);
    });

    test('a segment ticked WITHOUT its recording is still its own line', () {
      // Nothing to fold it into — dropping it would remove words the user
      // pointed at.
      final SelectedRecords out = selectedRecords(<TimelineEntry>[_members[1]]);
      expect(out.text, '第一件是库存口径');
    });

    test('🔴 a caller that forgets the lookup fails loudly, not with the title',
        () {
      // The quiet fallback would be this exact defect, reinstated by the next
      // caller. CLAUDE.md anti-facade ②: a DI default may not be a friendly
      // empty implementation.
      expect(() => selectedRecords(<TimelineEntry>[_head()]), throwsStateError);
    });
  });

  testWidgets('negative control: the collapsed CARD still shows the lead only',
      (WidgetTester tester) async {
    // The fix must not expand the card. What the card shows is its title and
    // its numbers; the segments are reachable by opening it, and by copying.
    final TimelineEntry head = _head();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: ChatArticleTile(entry: head, strings: _zh)),
    ));
    final Text title = tester.widget<Text>(
      find.byKey(ValueKey<String>('entry.article.title.${head.id}')),
    );
    expect(title.data, '今天先过两件事');
    expect(find.textContaining('库存口径'), findsNothing);
    expect(find.textContaining('采购节奏'), findsNothing);
    expect(find.textContaining('00:30'), findsNothing,
        reason: 'the ranges belong to the page and the clipboard, not the card');
  });
}
