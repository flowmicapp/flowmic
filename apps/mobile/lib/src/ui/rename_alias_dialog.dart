// The rename-alias dialog for one remembered PC row (long-press on the card).
//
// WHY IT IS ITS OWN FILE. connections_page.dart stood at 798 lines against the
// 800-line source cap (`SRC_MAX` in verify/lint/file-size.mjs) when the
// instance-list guide entry (P-7 ②) had to be added to its app bar. The
// precedent is in this same directory and is not optional — the header of
// data_flow_disclosure_entry.dart records it: when that exact file crossed the
// cap once before, the piece moved out VERBATIM and took its own reasoning with
// it, because deleting the reasoning to make room is the one thing this repo
// has ruled out.
//
// WHAT MOVED. The class body below is the `RenameAliasDialog` that stood at the
// bottom of connections_page.dart, character for character, including its doc
// comment. (No line coordinate is given for where it stood: it no longer exists
// there, so any number written here would be false the moment it was written.)
// Exactly two things changed, both forced by the move itself:
//   · the leading underscore is gone — the one call site (`_renameAlias`) is
//     now in another file and could not see a library-private class;
//   · `super.key` was added, because `use_key_in_widget_constructors` applies
//     to a public widget and did not apply to a private one.
// No layout value, no string, no lifecycle detail was touched.
//
// WHY IT WAS ITS OWN STEP. The split landed as its own commit, BEFORE the guide
// entry existed, so that "the dialog regressed" and "the guide regressed" can
// never be the same bisect result.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'tokens.dart';

/// Owns the TextEditingController so dispose aligns with the dialog route
/// (avoids the caret-attach race when the host pops then disposes).
class RenameAliasDialog extends StatefulWidget {
  const RenameAliasDialog({
    super.key,
    required this.strings,
    required this.initial,
  });

  final AppStrings strings;
  final String initial;

  @override
  State<RenameAliasDialog> createState() => _RenameAliasDialogState();
}

class _RenameAliasDialogState extends State<RenameAliasDialog> {
  late final TextEditingController _tc = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _tc.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return AlertDialog(
      backgroundColor: FlowMicColors.surface,
      title: Text(
        s.renameAliasTitle,
        style: TextStyle(color: FlowMicColors.t1, fontSize: 15),
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            TextField(
              controller: _tc,
              autofocus: true,
              style: TextStyle(color: FlowMicColors.t1),
              decoration: InputDecoration(
                hintStyle: TextStyle(color: FlowMicColors.t3),
                enabledBorder: UnderlineInputBorder(
                  borderSide: BorderSide(color: FlowMicColors.line),
                ),
                focusedBorder: UnderlineInputBorder(
                  borderSide: BorderSide(color: FlowMicColors.brand),
                ),
              ),
              onSubmitted: (String v) => Navigator.of(context).pop(v),
            ),
            const SizedBox(height: 10),
            Text(
              s.renameAliasHint,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.cancel, style: TextStyle(color: FlowMicColors.t2)),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(''),
          child: Text(
            s.restoreDefaultName,
            style: TextStyle(color: FlowMicColors.t2),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(_tc.text),
          child: Text(s.save, style: TextStyle(color: FlowMicColors.brand)),
        ),
      ],
    );
  }
}
