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
  late final TextEditingController _ctl =
      TextEditingController(text: widget.entry.displayText);

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
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      appBar: AppBar(
        backgroundColor: FlowMicColors.canvas,
        foregroundColor: FlowMicColors.t1,
        elevation: 0,
        title: Text(s.editEntryTitle, style: const TextStyle(fontSize: 15)),
      ),
      body: Column(
        children: <Widget>[
          Expanded(
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
                style: TextStyle(
                  color: FlowMicColors.t1,
                  fontSize: 14,
                  height: 1.7,
                ),
                decoration: const InputDecoration.collapsed(hintText: ''),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              children: <Widget>[
                Icon(Icons.info_outline, size: 12, color: FlowMicColors.t3),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    s.editEntryNote,
                    style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(s.cancel),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _save(reInject: false),
                    child: Text(s.save),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: () => _save(reInject: true),
                    child: Text(s.saveAndReInject),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
