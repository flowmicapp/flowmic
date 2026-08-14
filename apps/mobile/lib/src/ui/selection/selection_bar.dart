// SPEC-REF:
//   docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md FB-7
//
// The multi-select-state toolbar. Docked right below the top bar, exists only
// in multi-select state.
//
// ── Why two rows — this is a computed layout, not a style preference ────────────────────────────
// The rule the 0.2.51 card established (the top-bar PC name getting squeezed
// out, the third time at the same spot) was: on 360dp, work out the width
// budget once before deciding the row count, do not keep reallocating within
// one row. Followed here:
//   a 360dp narrow screen, 12 on each side of the page ⇒ 336 available.
//   Row 1 = ✕(36) + the count + select-all. English "Select all" is about
//   70px in a real font,
//   plus padding about 100 ⇒ the count has about 200 left, "12 selected" fits.
//   Row 2 = the two actions each take half ⇒ 164 each (minus padding and
//   border, text width about 142).
//   And 「hand off to AI to organize」's English label "Organize with AI" is
//   16 characters, the sub-line is even longer.
//   ⇒ a single row cannot fit the second action's sub-line, and the sub-line
//   **is NOT an optional decoration** (see below).
// ⇒ two rows.
// ⚠️ This budget **was corrected once by measurement**: the English sub-line's
//   first draft was 41 characters, `maxLines: 3` went red on the spot
//   (`selection_bar_render_test.dart` ①). Shortened to 31 characters + 4 lines
//   of headroom before it went green.
//   Being able to compute it does not mean computing it correctly — the
//   numbers are whatever that test says.
//
// 🔴 Why the sub-line cannot be dropped: `ai_action_row.dart` has a standing
// 「acts on the buffer · does not inject」, the reason
// is written there verbatim — 「AI sent it out」 must never be a plausible
// reading of these buttons. This card is more dangerous than that one: what
// the user has ticked is a record that has **already been delivered**,
// 「hand off to AI to organize」 is very easy to misread as 「send it again」.
// So the sub-line and the label live in the same control, visible at the same
// time, rather than hidden behind an after-the-fact toast.
//
// ⚠️ The two action buttons are **always pressable**. 0 rows selected,
// disconnected, the buffer has text ... pressing any of them all produces a
// readable reason (`batchOrganizeRefusalText`), rather than a silent nothing
// happening —
// 「a control that changes nothing is worse than no control」 (0.2.27 precedent).
// ⇒ Visually it dims with availability, but the hit region is always there,
// a tap always gets an answer.

import 'package:flutter/material.dart';

import '../../settings/app_strings.dart';
import '../tokens.dart';

class SelectionBar extends StatelessWidget {
  const SelectionBar({
    super.key,
    required this.strings,
    required this.selectedCount,
    required this.onCancel,
    required this.onSelectAll,
    required this.onCopy,
    required this.onOrganize,
  });

  final AppStrings strings;

  /// The selected row count that **is actually still present** in the current
  /// list (`visibleSelected(...).length`),
  /// NOT `EntrySelection.ids.length` — see the class doc on `entry_selection.dart`.
  final int selectedCount;

  final VoidCallback onCancel;
  final VoidCallback onSelectAll;
  final VoidCallback onCopy;
  final VoidCallback onOrganize;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey<String>('selection.bar'),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(
        color: FlowMicColors.surface2,
        border: Border(bottom: BorderSide(color: FlowMicColors.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Semantics(
                button: true,
                label: strings.selectionCancel,
                child: GestureDetector(
                  key: const ValueKey<String>('selection.cancel'),
                  behavior: HitTestBehavior.opaque,
                  onTap: onCancel,
                  child: SizedBox(
                    width: 36,
                    height: 36,
                    child: Icon(Icons.close, size: 18, color: FlowMicColors.t2),
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  strings.selectionCount(selectedCount),
                  key: const ValueKey<String>('selection.count'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: FlowMicColors.t1,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Semantics(
                button: true,
                label: strings.selectionSelectAll,
                child: GestureDetector(
                  key: const ValueKey<String>('selection.selectAll'),
                  behavior: HitTestBehavior.opaque,
                  onTap: onSelectAll,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 9,
                    ),
                    child: Text(
                      strings.selectionSelectAll,
                      key: const ValueKey<String>('selection.selectAll.label'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: FlowMicColors.brand,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          // 🔴 IntrinsicHeight is load-bearing, not decoration. The two boxes
          // must be the same height (their labels wrap to a different number of
          // lines in different languages — 「Copy」 is one line where "Organize
          // with AI" is two), and `CrossAxisAlignment.stretch` is what equalises
          // them. But stretch needs a BOUNDED cross axis, and this bar lives in
          // a Column with unbounded height, so a bare stretch throws
          // `'hasSize'` at layout time. Measured, not guessed: the first run of
          // `selection_bar_render_test.dart` failed exactly that way.
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Expanded(
                  child: _action(
                    id: 'copy',
                    icon: Icons.copy_all_outlined,
                    label: strings.selectionCopy,
                    sub: strings.selectionCopySub,
                    onTap: onCopy,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _action(
                    id: 'organize',
                    icon: Icons.segment,
                    label: strings.selectionOrganize,
                    sub: strings.selectionOrganizeSub,
                    tint: FlowMicColors.brand,
                    onTap: onOrganize,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// One cell of label + sub-line. The shape is copied from
  /// `entry_context_menu.dart`'s `_row`
  /// (label on top, sub below), so the two places' 「one action + its scope
  /// note」 look the same.
  ///
  /// `maxLines`'s value is **measured**, not guessed: the criterion is in
  /// `test/selection_bar_render_test.dart` (label 2 lines, sub-line 4 lines).
  /// The budget: a 360dp narrow screen ⇒ each cell's text width is about
  /// 142px ⇒ under Ahem about 14 characters per line; the English
  /// sub-line takes 3 lines under greedy wrapping, leaving one line of
  /// headroom. **The very first run went red exactly because 3 lines was not
  /// enough**
  /// (the English original at 41 characters needs 4 lines), so these two
  /// numbers have a documented origin.
  /// ⚠️ Under Ahem every glyph is a full em square ⇒ the budget that test
  /// gives is **more conservative** than a real device's font
  /// (not clipped under Ahem ⇒ guaranteed not clipped on a real device), the
  /// reverse does not hold.
  Widget _action({
    required String id,
    required IconData icon,
    required String label,
    required String sub,
    required VoidCallback onTap,
    Color? tint,
  }) {
    final Color fg = tint ?? FlowMicColors.t1;
    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        key: ValueKey<String>('selection.$id'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: FlowMicColors.surface,
            border: Border.all(color: FlowMicColors.line),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Icon(icon, size: 15, color: fg),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      label,
                      key: ValueKey<String>('selection.$id.label'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: fg,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                sub,
                key: ValueKey<String>('selection.$id.sub'),
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: FlowMicColors.t3, fontSize: 10),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
