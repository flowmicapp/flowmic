import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flutter/rendering.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/edit_entry_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/inset_geometry.dart';

TimelineEntry entry({String text = '编辑内容'}) => TimelineEntry(
  id: 'edit',
  clientId: 'edit',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: '原文',
  outputText: text,
  status: EntryStatus.noted,
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
);

void main() {
  const AppStrings s = AppStringsZh();
  for (final locale in AppLocale.values) {
    for (final c in [
      const InsetCase(
        '568x320-keyboard',
        size: Size(568, 320),
        ime: 180,
        bottom: 80,
        top: 24,
        scale: 1.3,
      ),
      const InsetCase('390x844', scale: 1.3),
      const InsetCase('390x844-keyboard', ime: 300, scale: 1.3),
      const InsetCase('tablet', size: Size(800, 1024), scale: 1.3),
      const InsetCase(
        'tablet-keyboard',
        size: Size(800, 1024),
        ime: 400,
        scale: 1.3,
      ),
      const InsetCase('390x844-large-keyboard', ime: 300, scale: 1.8),
    ]) {
      testWidgets('NR-154 rendered editor ${locale.name} ${c.name}', (
        tester,
      ) async {
        c.apply(tester);
        final strings = AppStrings.of(locale);
        EditResult? saved;
        await tester.pumpWidget(
          c.app(
            Builder(
              builder: (context) => Scaffold(
                body: ElevatedButton(
                  onPressed: () async {
                    saved = await Navigator.of(context).push<EditResult>(
                      MaterialPageRoute(
                        builder: (_) =>
                            EditEntryPage(entry: entry(), strings: strings),
                      ),
                    );
                  },
                  child: const Text('open-editor'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open-editor'));
        await tester.pumpAndSettle();
        final title = find.text(strings.editEntryTitle);
        await tester.ensureVisible(title);
        await tester.pumpAndSettle();
        expectInside(tester, title, c, hit: false);
        expectReadable(tester, title);
        final field = find.byType(EditableText);
        final input = tester.widget<EditableText>(field);
        final longText = List.filled(200, 'long note line').join('\n');
        await tester.enterText(find.byType(TextField), longText);
        await tester.pumpAndSettle();
        await tester.ensureVisible(field);
        await tester.pumpAndSettle();
        final editable = tester.state<EditableTextState>(field).renderEditable;
        final visible = (editable.localToGlobal(Offset.zero) & editable.size)
            .intersect(c.safe);
        expect(
          visible.height,
          greaterThanOrEqualTo(editable.preferredLineHeight * 3 - .01),
          reason:
              'three actual rendered text lines must be visible above the keyboard',
        );
        final caret = editable
            .getLocalRectForCaret(input.controller.selection.extent)
            .shift(editable.localToGlobal(Offset.zero));
        expect(
          visible.contains(caret.center),
          isTrue,
          reason: 'the end caret is visible',
        );
        final note = find.text(strings.editEntryNote);
        await tester.ensureVisible(note);
        await tester.pumpAndSettle();
        expectInside(tester, note, c, hit: false);
        expectReadable(tester, note);
        for (final label in [
          strings.cancel,
          strings.save,
          strings.saveAndReInject,
        ]) {
          final text = find.text(label);
          final button = find.ancestor(
            of: text,
            matching: find.bySubtype<ButtonStyleButton>(),
          );
          await tester.ensureVisible(button);
          await tester.pumpAndSettle();
          expectInside(tester, button, c);
          expectReadable(tester, text);
        }
        expect(tester.takeException(), isNull);
        // Real navigation and result: the adaptive layout retains both save paths.
        final reInject = c.ime > 0;
        final action = find.text(
          reInject ? strings.saveAndReInject : strings.save,
        );
        await tester.ensureVisible(action);
        await tester.pumpAndSettle();
        await tester.tap(action);
        await tester.pumpAndSettle();
        expect(find.byType(EditEntryPage), findsNothing);
        expect(saved!.text, longText);
        expect(saved!.reInject, reInject);
      });
    }
  }
  testWidgets(
    'NR-154 short landscape keyboard: scroll to every editor action',
    (tester) async {
      const c = InsetCase(
        'short-landscape-ime',
        size: Size(568, 320),
        ime: 180,
        bottom: 80,
        scale: 1.3,
        top: 24,
      );
      c.apply(tester);
      EditResult? saved;
      await tester.pumpWidget(
        c.app(
          Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () async {
                  saved = await Navigator.of(context).push<EditResult>(
                    MaterialPageRoute(
                      builder: (_) => EditEntryPage(entry: entry(), strings: s),
                    ),
                  );
                },
                child: const Text('open-editor'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open-editor'));
      await tester.pumpAndSettle();
      for (final label in [s.cancel, s.save, s.saveAndReInject]) {
        final button = find.ancestor(
          of: find.text(label),
          matching: find.bySubtype<ButtonStyleButton>(),
        );
        await tester.ensureVisible(button);
        await tester.pumpAndSettle();
        expectInside(tester, button, c);
      }
      expect(tester.takeException(), isNull);
      await tester.tap(find.text(s.save));
      await tester.pumpAndSettle();
      expect(find.byType(EditEntryPage), findsNothing);
      expect(saved!.text, entry().displayText);
    },
  );
  for (final c in [
    const InsetCase(
      'long-phone',
      size: Size(390, 844),
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    ),
    const InsetCase('long-tablet', size: Size(800, 1024)),
  ]) {
    testWidgets('NR-154 pinned actions with 200 lines ${c.name}', (
      tester,
    ) async {
      c.apply(tester);
      await tester.pumpWidget(
        c.app(
          EditEntryPage(
            entry: entry(text: List.filled(200, 'long note line').join('\n')),
            strings: s,
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final label in [s.cancel, s.save, s.saveAndReInject]) {
        expectInside(
          tester,
          find.ancestor(
            of: find.text(label),
            matching: find.bySubtype<ButtonStyleButton>(),
          ),
          c,
        );
      }
      final before = tester.getRect(find.byType(FilledButton));
      await tester.drag(find.byType(TextField), const Offset(0, -400));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.byType(FilledButton)), before);
      expect(tester.takeException(), isNull);
    });
  }
  for (final InsetCase c in insetCases) {
    testWidgets('entry actions inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      c.apply(tester);
      await tester.pumpWidget(c.app(EditEntryPage(entry: entry(), strings: s)));
      await tester.pumpAndSettle();
      for (final String label in <String>[
        s.cancel,
        s.save,
        s.saveAndReInject,
      ]) {
        final Finder button = find.ancestor(
          of: find.text(label),
          matching: find.bySubtype<ButtonStyleButton>(),
        );
        await tester.ensureVisible(button);
        await tester.pumpAndSettle();
        expectInside(tester, button, c);
      }
      expect(tester.takeException(), isNull);
      if (c.ime > 0) {
        tester.view.viewInsets = FakeViewPadding.zero;
        tester.view.padding = FakeViewPadding(
          top: c.top,
          left: c.left,
          right: c.right,
          bottom: c.bottom,
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byType(FilledButton));
        await tester.pumpAndSettle();
        expectInside(
          tester,
          find.byType(FilledButton),
          InsetCase('dismissed', bottom: c.bottom),
        );
      }
    });
  }
}

// D-15: compare laid-out glyph boxes with actual paragraph bounds.
// Skia rounds advances at subpixel precision; allow at most 0.1dp.
void expectReadable(WidgetTester tester, Finder text) {
  final paragraph = tester.renderObject<RenderParagraph>(text);
  expect(paragraph.didExceedMaxLines, isFalse);
  final bounds = Offset.zero & paragraph.size;
  // Selection includes trailing wrap spaces outside the painted line. Check
  // each non-whitespace run so the assertion concerns visible glyphs.
  final runs = RegExp(r'\S+').allMatches(paragraph.text.toPlainText()).toList();
  expect(runs, isNotEmpty);
  for (final run in runs) {
    final boxes = paragraph.getBoxesForSelection(
      TextSelection(baseOffset: run.start, extentOffset: run.end),
    );
    expect(boxes, isNotEmpty);
    for (final box in boxes) {
      expect(box.left, greaterThanOrEqualTo(bounds.left - .1));
      expect(box.right, lessThanOrEqualTo(bounds.right + .1));
      expect(box.top, greaterThanOrEqualTo(bounds.top - .1));
      expect(box.bottom, lessThanOrEqualTo(bounds.bottom + .1));
    }
  }
}
