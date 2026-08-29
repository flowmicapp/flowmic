// 🔴 NR-4 (d) + (e) — the in-sheet append button joins the PTT visual family,
// and the collapsed draft preview grows to two lines with an origin glyph.
//
// Source of truth:
//   docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §2.2 / §3 / §6
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md ruling ③ (option B:
//     「抽屉内追加按钮升级为与主说话条同视觉族，不动覆盖结构」 — the in-sheet
//     append button joins the main speak bar's visual family; the covering
//     structure is untouched)
//
// ⚠️ WHAT IS DELIBERATELY NOT RE-TESTED HERE. The sheet's covering geometry and
// the SEG-2 mid-hold guard are option B's PREMISE, and they already have owners
// (`edit_sheet_test.dart`, `edit_sheet_not_during_hold_test.dart`). Copying
// their assertions here would give the same promise two homes; what proves
// option B kept its word is that those two files stay green, unedited.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart' show SheetAppendButton;
import 'package:flowmic/src/ui/compose_band.dart' show ComposeBufferPreview;
import 'package:flowmic/src/ui/mic_glyph.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _appendBtn = find.byType(SheetAppendButton);
final Finder _previewText =
    find.byKey(const ValueKey<String>('compose.preview.text'));
final Finder _originGlyph =
    find.byKey(const ValueKey<String>('compose.preview.origin'));
final Finder _count = find.byKey(const ValueKey<String>('compose.preview.count'));

Widget _host(Widget child, {double width = 360}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: width,
      child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[child]),
    ),
  ),
);

Widget _append({bool appending = false}) => SheetAppendButton(
  appending: appending,
  strings: _zh,
  onDown: () async => true,
  onUp: () async {},
  onCancel: () async {},
);

Widget _preview({
  required String buffer,
  bool? origin,
  bool enabled = true,
}) => ComposeBufferPreview(
  strings: _zh,
  enabled: enabled,
  buffer: buffer,
  origin: origin,
  onTap: () {},
);

/// The `BoxDecoration` on the append button's own face box.
BoxDecoration? _faceDecoration(WidgetTester tester) {
  final Iterable<Container> boxes = tester.widgetList<Container>(
    find.descendant(of: _appendBtn, matching: find.byType(Container)),
  );
  for (final Container c in boxes) {
    if (c.constraints?.maxHeight == kSpeakControlHeight ||
        c.decoration != null) {
      return c.decoration as BoxDecoration?;
    }
  }
  return null;
}

void main() {
  group('① (d) the resting append button IS the PTT bar\'s face', () {
    testWidgets('same height as the real PttBar, both reading kSpeakControlHeight',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_append()));
      final double appendH = tester.getSize(_appendBtn).height;

      await tester.pumpWidget(
        _host(
          PttBar(
            visual: PttVisual.idle,
            strings: _zh,
            onDown: () async => true,
            onUp: () async {},
            onCancel: () async {},
          ),
        ),
      );
      final double barH = tester
          .getSize(find.byKey(const ValueKey<String>('ptt.bar')))
          .height;

      expect(appendH, kSpeakControlHeight);
      expect(
        barH,
        appendH,
        reason: 'option B says the two controls are one face — if their heights '
            'can differ, they are not',
      );
    });

    testWidgets('solid pri fill at rest, radius 17, and NO dashed outline anywhere',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_append()));

      final BoxDecoration? d = _faceDecoration(tester);
      expect(d, isNotNull);
      expect(
        d!.color,
        FlowMicDockColors.pri,
        reason: 'the resting face must be filled, not outlined',
      );
      expect(d.border, isNull, reason: 'a solid fill carries its own edge (P5b)');
      expect(
        d.borderRadius,
        BorderRadius.circular(kSpeakControlRadius),
      );

      // 🔴 The dashed painter is GONE, asserted by walking every painter this
      // button still draws. Naming the deleted class is impossible (it is
      // deleted); what is checkable is that the ONLY painter left is the shared
      // mic glyph's.
      final Iterable<CustomPaint> painters = tester.widgetList<CustomPaint>(
        find.descendant(of: _appendBtn, matching: find.byType(CustomPaint)),
      );
      for (final CustomPaint p in painters) {
        if (p.painter == null) continue;
        expect(
          p.painter.runtimeType.toString(),
          contains('MicGlyph'),
          reason: 'an outline painter came back onto the resting face: '
              '${p.painter.runtimeType}',
        );
      }
    });

    testWidgets('the mic is the PTT bar\'s size, and the label size did NOT change',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_append()));
      expect(
        tester
            .widget<MicGlyph>(
              find.descendant(of: _appendBtn, matching: find.byType(MicGlyph)),
            )
            .size,
        kSpeakControlGlyphSize,
      );
      // §2.2 is explicit that only geometry and fill were unified. 13.5 is the
      // append button's own size and stays: the bar's 17 is sized for a full
      // sentence across a full-width bar.
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey<String>('compose.sheet.append.label')),
            )
            .style!
            .fontSize,
        13.5,
      );
    });

    testWidgets('the RECORDING face is untouched — still an outline, still red',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_append(appending: true)));
      final BoxDecoration? d = _faceDecoration(tester);
      expect(d, isNotNull);
      expect(
        d!.color,
        isNull,
        reason: 'option B moved the RESTING face only; re-skinning the alarm '
            'would be a regression dressed as consistency',
      );
      expect(d.border, isNotNull);
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey<String>('compose.sheet.append.label')),
            )
            .data,
        _zh.appendRelease,
      );
    });
  });

  group('② (e) the collapsed preview shows two lines and where the draft came from',
      () {
    testWidgets('maxLines is 2 — asserted on the widget the renderer reads',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_preview(buffer: '一段草稿', origin: true)));
      expect(tester.widget<Text>(_previewText).maxLines, 2);
      expect(tester.widget<Text>(_previewText).overflow, TextOverflow.ellipsis);
    });

    testWidgets('🔴 a draft too long for two lines is still truncated (rendered result)',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        _host(_preview(buffer: '很长的草稿内容' * 40, origin: true)),
      );
      final RenderParagraph p = tester.renderObject<RenderParagraph>(
        _previewText,
      );
      // `maxLines` IS set here, so this reading is a real one — unlike the
      // guide's body text, where the same call is permanently false. It says
      // the strip is still a PREVIEW: two lines, not a full draft.
      expect(p.didExceedMaxLines, isTrue);

      // Positive control: a short draft in the same box is NOT truncated, so
      // the assertion above is reporting the draft's length and not a box that
      // truncates everything.
      await tester.pumpWidget(_host(_preview(buffer: '短', origin: true)));
      expect(
        tester.renderObject<RenderParagraph>(_previewText).didExceedMaxLines,
        isFalse,
      );
    });

    testWidgets('voice ⇒ the shared mic glyph; typed ⇒ the pencil; unknown ⇒ nothing',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_preview(buffer: '说出来的', origin: true)));
      expect(_originGlyph, findsOneWidget);
      expect(
        find.descendant(of: _originGlyph, matching: find.byType(MicGlyph)),
        findsOneWidget,
        reason: 'the voice glyph must be the app\'s ONE mic, not a second '
            'hand-drawn one',
      );

      await tester.pumpWidget(_host(_preview(buffer: '打出来的', origin: false)));
      expect(
        find.descendant(
          of: _originGlyph,
          matching: find.byIcon(Icons.edit_outlined),
        ),
        findsOneWidget,
      );

      await tester.pumpWidget(_host(_preview(buffer: '来源不明')));
      expect(
        _originGlyph,
        findsNothing,
        reason: 'null means 「nothing to say about where this came from」 — a '
            'glyph there would be a claim we cannot back',
      );
    });

    testWidgets('no draft, and the disabled face, carry no origin glyph',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_preview(buffer: '', origin: true)));
      expect(_originGlyph, findsNothing);
      expect(_count, findsNothing);

      await tester.pumpWidget(
        _host(_preview(buffer: '有草稿', origin: true, enabled: false)),
      );
      expect(
        _originGlyph,
        findsNothing,
        reason: 'S8 is not showing a draft at all — it is saying the cell is '
            'closed',
      );
    });

    testWidgets('the word count survives as its own Text, below the last line',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        _host(_preview(buffer: '很长的草稿内容' * 40, origin: true)),
      );
      expect(
        _count,
        findsOneWidget,
        reason: 'folded into the sentence as a TextSpan it would be the first '
            'thing the ellipsis ate, on exactly the drafts where it is worth '
            'something',
      );
      // It sits at the bottom of the two-line block, not beside the first line.
      final double textBottom = tester.getRect(_previewText).bottom;
      final double countBottom = tester.getRect(_count).bottom;
      expect((textBottom - countBottom).abs(), lessThan(1.0));
    });

    testWidgets('🔴 origin is a value the strip is HANDED, never one it looks up',
        (WidgetTester tester) async {
      // Design §6 row 7. Two builds that differ ONLY in the parameter must
      // differ in the glyph — which is only possible if the parameter is what
      // decides. The day someone re-routes this through an InheritedWidget or a
      // controller, this pair stops being able to say anything, because there
      // would be a second author for the same fact.
      await tester.pumpWidget(_host(_preview(buffer: '同一段草稿', origin: true)));
      expect(
        find.descendant(of: _originGlyph, matching: find.byType(MicGlyph)),
        findsOneWidget,
      );
      await tester.pumpWidget(_host(_preview(buffer: '同一段草稿', origin: false)));
      expect(
        find.descendant(of: _originGlyph, matching: find.byType(MicGlyph)),
        findsNothing,
      );
      expect(
        find.descendant(
          of: _originGlyph,
          matching: find.byIcon(Icons.edit_outlined),
        ),
        findsOneWidget,
      );
    });
  });
}
