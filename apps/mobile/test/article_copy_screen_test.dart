// owner 2026-08-30: 「轻记录的转录历史中复制」 — on the light-record screen,
// copying a finished recording's card copied its title.
//
// 🔴 DRIVEN THROUGH THE SCREEN, per CLAUDE.md anti-facade ⑥: the deliverable is
// 「what lands on the clipboard when the user copies THIS card on THIS screen」,
// so the real page is mounted, the real long-press menu is opened, the real
// toolbar is pressed, and the clipboard is read through the platform channel
// the product writes to. `article_copy_test.dart` pins the renderer; this file
// pins that the screen calls it.
//
// ── RED, MEASURED (pre-fix lib restored from HEAD, this file unchanged) ────────
//   ① long-press → 复制:
//        Expected: '00:00–00:30 今天先过两件事第一件是库存口径第二件是采购节奏'
//          Actual: '今天先过两件事第一件是库存口径第二件是采购节奏'
//        (the card's title — under this rig the three settles merged into one
//        member, so the title IS the sentence; what is missing is the piece)
//   ② multi-select → 复制: same string, same reason.
// Both green after the fix; ③ (the card) green on both, as a control must be.
// The three-line shape the owner asked for is pinned where the fixture
// controls its segments: article_copy_test.dart and
// history_page_article_copy_test.dart.
//
// ⚠️ THE SEGMENT ROWS' EXACT TEXT IS NOT ASSERTED. Under `runAsync` the settles
// interleave differently than under plain `test()`, so a row can carry the span
// it covers rather than one segment (article_screen_test.dart records the same
// measurement). What IS asserted: one line per member, each starting with the
// range the page shows for that member, in the page's order, and all three
// sentences present — which is the owner's expectation exactly.

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart' show articleMembersOf;
import 'package:flowmic/src/ui/article_page.dart' show formatArticleRange;
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' show Text, ValueKey;
import 'package:flutter/services.dart' show MethodCall, SystemChannels;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

const AppStrings _zh = AppStringsZh();

/// What the clipboard MUST hold for this recording, derived from the same rows
/// and the same formatter the page renders — not typed by hand, because the
/// segment boundaries under `runAsync` are a fixture property (see header).
String _expectedPiece(ArticleRig r, String articleId) => <String>[
      for (final TimelineEntry m in articleMembersOf(r.store, articleId))
        '${formatArticleRange(m)} ${m.displayText}',
    ].join('\n');

void main() {
  late List<String> clipboard;

  setUp(() {
    clipboard = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (
      MethodCall call,
    ) async {
      if (call.method == 'Clipboard.setData') {
        clipboard.add(
          (call.arguments as Map<Object?, Object?>)['text'] as String,
        );
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<ArticleRig> mounted(WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    await tester.runAsync(r.recordThreeAndStop);
    await mountLightRecordScreen(tester, r);
    expect(find.byType(ChatArticleTile), findsOneWidget,
        reason: 'positive control: the recording is a card on this screen');
    return r;
  }

  void expectWholePiece(ArticleRig r, String articleId) {
    expect(clipboard, hasLength(1), reason: 'exactly one write');
    final String got = clipboard.single;
    final String want = _expectedPiece(r, articleId);
    expect(got, want);
    // Spelled out, so a reader of a failure sees what the owner asked for
    // rather than a diff of two derived strings.
    final List<String> lines = got.split('\n');
    expect(lines.length, articleMembersOf(r.store, articleId).length,
        reason: 'one line per segment');
    for (final String line in lines) {
      expect(RegExp(r'^\d\d:\d\d(–\d\d:\d\d)? ').hasMatch(line), isTrue,
          reason: 'each line starts with the page\'s range label — got "$line"');
    }
    expect(got, contains('两件事'));
    expect(got, contains('库存口径'));
    expect(got, contains('采购节奏'));
  }

  testWidgets('🔴 ① long-press the card → 复制 copies the whole recording',
      (WidgetTester tester) async {
    final ArticleRig r = await mounted(tester);
    final String id = tester
        .widget<ChatArticleTile>(find.byType(ChatArticleTile))
        .entry
        .articleId!;

    await tester.longPress(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.entryCopy));
    await tester.pumpAndSettle();

    expectWholePiece(r, id);
  });

  testWidgets('🔴 ② multi-select with the card ticked → 复制 copies the whole '
      'recording', (WidgetTester tester) async {
    final ArticleRig r = await mounted(tester);
    final String id = tester
        .widget<ChatArticleTile>(find.byType(ChatArticleTile))
        .entry
        .articleId!;

    // The long-press menu's 多选 seeds the selection with the row held.
    await tester.longPress(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.selectionEnter));
    await tester.pumpAndSettle();
    // The toolbar's copy — the only 复制 on screen once the sheet is gone.
    await tester.tap(find.text(_zh.selectionCopy));
    await tester.pumpAndSettle();

    expectWholePiece(r, id);
  });

  testWidgets('③ negative control: the card on screen is still the lead only',
      (WidgetTester tester) async {
    final ArticleRig r = await mounted(tester);
    final ChatArticleTile card =
        tester.widget<ChatArticleTile>(find.byType(ChatArticleTile));
    final RegExp range = RegExp(r'\d\d:\d\d–\d\d:\d\d');

    // ⚠️ NOT 「the third sentence is absent from the screen」. Under this rig
    // the settles can merge into ONE member (see header), whose opening — and
    // therefore the card's title — is the whole sentence; the first draft of
    // this control asserted that and went red against a correct build. What
    // the card must not show is the PIECE: no range label on either of its
    // texts, and no segment drawn as a row. The tall surface in
    // mountLightRecordScreen is what makes findsNothing evidence here.
    final Text title = tester.widget<Text>(
      find.byKey(ValueKey<String>('entry.article.title.${card.entry.id}')),
    );
    final Text meta = tester.widget<Text>(
      find.byKey(ValueKey<String>('entry.article.meta.${card.entry.id}')),
    );
    expect(title.data, card.entry.displayText, reason: 'the lead, verbatim');
    expect(range.hasMatch(title.data ?? ''), isFalse);
    expect(range.hasMatch(meta.data ?? ''), isFalse,
        reason: 'ranges belong to the page and the clipboard, not the card');
    expect(find.byType(ChatMessageTile), findsNothing,
        reason: 'the fix must not expand the card into rows');
    // …while copying yields the piece: range-prefixed, and not the title.
    await tester.longPress(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.entryCopy));
    await tester.pumpAndSettle();
    expect(range.hasMatch(clipboard.single), isTrue);
    expect(clipboard.single, isNot(card.entry.displayText),
        reason: 'the title alone is the defect');
    expect(r.store.entries.where((TimelineEntry e) => e.isArticle).length, 1);
  });
}
