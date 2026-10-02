// SPEC-REF:
//   docs/ui-design/demo/mobile.html (frame 6: full-screen edit; note "编辑不会
//     撤销已注入的文本，保存后状态变为「已编辑」" — "editing does not undo text
//     that was already injected; after saving, the status becomes 'edited'";
//     cancel / save / save and re-inject — 取消 / 保存 / 保存并重新注入)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (source_text
//     immutable — the edit moves the DISPLAY face only)
//
// Full-screen edit page. Returns an [EditResult] describing the new display
// text and whether the user also asked to re-inject; the page dispatches to
// ChatController.editEntry (+ reInject). The original source_text is never sent
// here — only output_text moves.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import 'tokens.dart';

class EditResult {
  final String text;
  final bool reInject;
  const EditResult(this.text, {this.reInject = false});
}

class EditEntryPage extends StatefulWidget {
  const EditEntryPage({super.key, required this.entry, required this.strings});
  final TimelineEntry entry;

  /// Required, deliberately — no zh fallback (façade rule ②); explicit locale,
  /// never the OS locale.
  final AppStrings strings;

  @override
  State<EditEntryPage> createState() => _EditEntryPageState();
}

class _EditEntryPageState extends State<EditEntryPage> {
  late final TextEditingController _ctl = TextEditingController(
    text: widget.entry.displayText,
  );

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  void _save({required bool reInject}) {
    Navigator.of(context).pop(EditResult(_ctl.text, reInject: reInject));
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    final media = MediaQuery.of(context);
    final width = media.size.width - media.padding.horizontal - 28;
    final labelStyle = Theme.of(context).textTheme.labelLarge!;
    Size measure(String text, TextStyle style, double maxWidth) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textScaler: media.textScaler,
        textDirection: Directionality.of(context),
      )..layout(maxWidth: maxWidth);
      return painter.size;
    }

    // Use the same font, scaling and padding as the rendered buttons.
    final oneRow = [s.cancel, s.save, s.saveAndReInject].every(
      (label) =>
          measure(label, labelStyle, double.infinity).width + 24 <=
          (width - 20) / 3,
    );
    double buttonHeight(String label, double buttonWidth) {
      final height = measure(label, labelStyle, buttonWidth - 24).height + 24;
      return height < 48 ? 48 : height;
    }

    final halfWidth = (width - 10) / 2;
    final shortHeight =
        buttonHeight(s.cancel, halfWidth) > buttonHeight(s.save, halfWidth)
        ? buttonHeight(s.cancel, halfWidth)
        : buttonHeight(s.save, halfWidth);
    final footerHeight =
        28 +
        (oneRow
            ? [s.cancel, s.save, s.saveAndReInject]
                  .map((label) => buttonHeight(label, (width - 20) / 3))
                  .reduce((a, b) => a > b ? a : b)
            : shortHeight + 10 + buttonHeight(s.saveAndReInject, width));
    final noteStyle = Theme.of(
      context,
    ).textTheme.bodyMedium!.copyWith(color: FlowMicColors.t3, fontSize: 11.5);
    final noteHeight =
        measure(s.editEntryNote, noteStyle, width - 18).height + 14;
    final lineHeight = measure(
      'M',
      const TextStyle(fontSize: 14, height: 1.7),
      width,
    ).height.ceilToDouble();
    // Include the border as well as the field padding and outer margin.
    final minimumFieldHeight = lineHeight * 3 + 58;
    final titleStyle = Theme.of(
      context,
    ).textTheme.titleLarge!.copyWith(fontSize: 15);
    final titleHeight =
        measure(s.editEntryTitle, titleStyle, width - 56).height + 16;
    final toolbarHeight = titleHeight > kToolbarHeight
        ? titleHeight
        : kToolbarHeight;
    final availableHeight =
        media.size.height - media.viewInsets.bottom - media.padding.vertical;
    final scrollPage =
        availableHeight <
        toolbarHeight + footerHeight + noteHeight + minimumFieldHeight;

    final toolbar = AppBar(
      primary: !scrollPage,
      toolbarHeight: toolbarHeight,
      backgroundColor: FlowMicColors.canvas,
      foregroundColor: FlowMicColors.t1,
      elevation: 0,
      title: Text(s.editEntryTitle, style: titleStyle, maxLines: 4),
    );
    Widget field(double height) => SizedBox(
      height: height,
      child: Container(
        margin: const EdgeInsets.all(14),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: FlowMicColors.surface,
          border: Border.all(color: FlowMicColors.line),
          borderRadius: BorderRadius.circular(16),
        ),
        child: TextField(
          controller: _ctl,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          style: TextStyle(color: FlowMicColors.t1, fontSize: 14, height: 1.7),
          decoration: const InputDecoration.collapsed(hintText: ''),
        ),
      ),
    );
    final note = Padding(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
      child: Row(
        children: [
          Icon(Icons.info_outline, size: 12, color: FlowMicColors.t3),
          const SizedBox(width: 6),
          Expanded(child: Text(s.editEntryNote, style: noteStyle)),
        ],
      ),
    );
    final buttonStyle = ButtonStyle(
      textStyle: WidgetStatePropertyAll(labelStyle),
      padding: const WidgetStatePropertyAll(EdgeInsets.all(12)),
      minimumSize: const WidgetStatePropertyAll(Size(0, 48)),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
    final cancel = OutlinedButton(
      style: buttonStyle,
      onPressed: () => Navigator.of(context).pop(),
      child: Text(s.cancel),
    );
    final save = OutlinedButton(
      style: buttonStyle,
      onPressed: () => _save(reInject: false),
      child: Text(s.save),
    );
    final reInject = FilledButton(
      style: buttonStyle,
      onPressed: () => _save(reInject: true),
      child: Text(s.saveAndReInject),
    );
    final footer = Padding(
      padding: const EdgeInsets.all(14),
      child: oneRow
          ? Row(
              children: [
                Expanded(child: cancel),
                const SizedBox(width: 10),
                Expanded(child: save),
                const SizedBox(width: 10),
                Expanded(child: reInject),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: cancel),
                    const SizedBox(width: 10),
                    Expanded(child: save),
                  ],
                ),
                const SizedBox(height: 10),
                reInject,
              ],
            ),
    );
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      appBar: scrollPage ? null : toolbar,
      body: SafeArea(
        top: scrollPage,
        child: scrollPage
            // The toolbar scrolls too: a 320dp phone above an IME cannot hold
            // a fixed toolbar, three text lines and a footer at the same time.
            ? SingleChildScrollView(
                child: Column(
                  children: [
                    SizedBox(height: toolbarHeight, child: toolbar),
                    field(minimumFieldHeight),
                    note,
                    footer,
                  ],
                ),
              )
            : Column(
                children: [
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, viewport) => field(viewport.maxHeight),
                    ),
                  ),
                  note,
                  footer,
                ],
              ),
      ),
    );
  }
}
