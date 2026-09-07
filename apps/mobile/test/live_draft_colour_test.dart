// What the PHONE actually renders while somebody is speaking.
//
// 🔴 THE ASSERTIONS LAND ON THE RENDERED RESULT, NOT ON `Text.data` — the rule
// this repo wrote after 0.2.53 (a sentence that was correct in the widget and
// three letters on screen). Colours are read off the laid-out span tree the
// painter uses, and "nothing was truncated" is a MEASUREMENT (`RenderParagraph
// .didExceedMaxLines` + the paragraph's own height against a `TextPainter`
// layout of the same spans at the same width), never an inspection of the
// string that was handed in.
//
// ⚠️ `flutter_test` uses the Ahem placeholder font: every glyph is a full em
// square, so a line holds far fewer characters than on a real device. That
// direction is SAFE here — if a string overflows under Ahem it may well fit on
// a device, and the assertions below are about what happens WHEN it overflows.
// Nothing here may be read as "this exact sentence fits on a real phone".

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

// 900 wide, not a phone width: under Ahem every glyph is a full em square, so
// the tile's HEADER row (badge + labels + duration) overflows a 360 dp box and
// the harness turns that into a failure. Widening is a fixture concession to
// the placeholder font — the assertions below are all about the BODY.
Widget _host(Widget child, {double width = 900, double height = 400}) {
  return MaterialApp(
    home: Scaffold(
      body: Center(
        child: SizedBox(width: width, height: height, child: child),
      ),
    ),
  );
}

const AppStringsEn _liveDraftColourStrings = AppStringsEn();

LiveDraftTile _tile(String text, int committedChars) {
  return LiveDraftTile(
    text: text,
    committedChars: committedChars,
    mode: FlowMode.realtime,
    strings: _liveDraftColourStrings,
    statusLabel: _liveDraftColourStrings.liveTranscribing,
    healthNote: null,
    elapsed: const Duration(seconds: 3),
  );
}

/// The paragraph that renders the draft body (the last RichText in the tile —
/// the header row's labels come first).
RenderParagraph _draftParagraph(WidgetTester tester) {
  final Iterable<Element> found = find
      .descendant(of: find.byType(LiveDraftTile), matching: find.byType(RichText))
      .evaluate();
  return found.last.renderObject! as RenderParagraph;
}

/// Flatten the LAID-OUT span tree into (text, colour) runs.
List<(String, Color?)> _runs(RenderParagraph p) {
  final List<(String, Color?)> out = <(String, Color?)>[];
  p.text.visitChildren((InlineSpan span) {
    if (span is TextSpan && span.text != null && span.text!.isNotEmpty) {
      out.add((span.text!, span.style?.color));
    }
    return true;
  });
  return out;
}

void main() {
  testWidgets('the confirmed head is BLACK and the transcribing tail is GREY', (
    WidgetTester tester,
  ) async {
    // 「这个方案可以。」 has been finalised by the server; 「我们下周」 is still
    // an interim. The joiner newline belongs to the black run (it is
    // whitespace; a grey leading break would be a character nobody spoke).
    const String display = '这个方案可以。\n我们下周';
    await tester.pumpWidget(_host(_tile(display, '这个方案可以。\n'.length)));

    final List<(String, Color?)> runs = _runs(_draftParagraph(tester));
    expect(runs.length, 2, reason: 'exactly two colour runs, one paragraph');
    expect(runs[0].$1, '这个方案可以。\n');
    expect(runs[0].$2, FlowMicColors.t1, reason: 'confirmed text is black');
    expect(runs[1].$1, '我们下周');
    expect(runs[1].$2, FlowMicColors.t3, reason: 'interim text is grey');
    // And together they are the display string, character for character — the
    // same string the PC capsule shows (verify/fixtures/utterance-view-parity
    // .json, "zh translate", last interim step).
    expect(runs.map((r) => r.$1).join(), display);
  });

  testWidgets('with nothing finalised yet the WHOLE draft is grey', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(_tile('hello world', 0)));
    final List<(String, Color?)> runs = _runs(_draftParagraph(tester));
    expect(runs.length, 1);
    expect(runs[0].$2, FlowMicColors.t3);
  });

  testWidgets('an out-of-range split falls back to ALL GREY, it never throws', (
    WidgetTester tester,
  ) async {
    // Grey claims nothing; black claims the server finalised it. If the two
    // strings ever stop lining up, the honest answer is "we do not know yet".
    await tester.pumpWidget(_host(_tile('short', 999)));
    final List<(String, Color?)> runs = _runs(_draftParagraph(tester));
    expect(runs.length, 1);
    expect(runs[0].$1, 'short');
    expect(runs[0].$2, FlowMicColors.t3);
  });

  testWidgets('a long draft is NOT truncated — every character is laid out', (
    WidgetTester tester,
  ) async {
    final String long = List<String>.filled(40, '这是一句很长的话。').join();
    await tester.pumpWidget(_host(_tile(long, 40), height: 900));
    final RenderParagraph p = _draftParagraph(tester);

    // ① the paragraph itself imposes no ceiling…
    expect(p.maxLines, isNull, reason: 'a maxLines here would drop spoken words');
    expect(p.didExceedMaxLines, isFalse);
    expect(p.overflow, TextOverflow.clip, reason: 'never ellipsis: no silent loss');

    // ② …and it really laid out the full height the text needs, measured
    //    independently rather than read off the widget that produced it.
    final TextPainter ruler = TextPainter(
      text: p.text,
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: p.size.width);
    expect(p.size.height, closeTo(ruler.height, 0.5));
    expect(ruler.height, greaterThan(60), reason: 'the fixture must really wrap');
  });

  testWidgets(
    'when it overflows the viewport the TAIL stays visible and the head scrolls off',
    (WidgetTester tester) async {
      // This mirrors chat_flow_page's list: `reverse: true` with the live tile
      // at index 0, which is what puts the newest words against the bottom
      // edge. The production coordinates are asserted separately below, so a
      // change there cannot leave this test quietly measuring a shape the app
      // no longer has.
      final String long = List<String>.filled(400, '这是一句很长的话。').join();
      await tester.pumpWidget(
        _host(
          ListView(
            reverse: true,
            children: <Widget>[_tile(long, 40)],
          ),
          height: 200,
        ),
      );

      final Rect viewport = tester.getRect(find.byType(ListView));
      final Rect para = tester.getRect(
        find
            .descendant(
              of: find.byType(LiveDraftTile),
              matching: find.byType(RichText),
            )
            .last,
      );
      expect(
        para.height,
        greaterThan(viewport.height),
        reason: 'the fixture must actually overflow, or this proves nothing',
      );
      // The newest words: the bottom of the text sits inside the viewport…
      expect(para.bottom, lessThanOrEqualTo(viewport.bottom + 0.5));
      expect(para.bottom, greaterThan(viewport.top));
      // …while the head is above the top edge, i.e. elided by scrolling and
      // still reachable, not deleted.
      expect(para.top, lessThan(viewport.top));
    },
  );

  test('the production list really is reverse-with-the-draft-at-index-0', () {
    // Literal-anchor guard (the culture mode-badge.test.ts established): the
    // widget test above builds its own list, so the coordinates it mirrors
    // must be pinned in the file that owns them.
    final String src = const LineSplitter()
        .convert(
          File('lib/src/ui/chat_flow_scroll.dart').readAsStringSync(),
        )
        .join('\n');
    expect(src, contains('reverse: true'));
    expect(src, contains('if (live && i == 0)'));
    expect(src, contains('committedChars: controller.liveCommittedChars'));
  });
}
