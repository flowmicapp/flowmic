// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 B (two-state header
//     badge + input-area quick mirror; strong visual split for record-only)
//   docs/ui-design/demo/mobile.html (.devhead .tgt / .destmirror; .tgt.noted /
//     .tgt.fixed with 🔒 for a cloud instance)
//
// The destination selector surface: the header badge (→ {app} / → record only
// / 仅记录).
//
// There used to be TWO — the badge plus a composer-row mirror beside the mode
// chip (§4.0 B argued it was reachable a beat before speaking). owner removed
// the mirror in V2-03 as a duplicate; see the note at the foot of this file.
// The spec line above is kept for provenance, not as a description of today.
// Pure widgets driven by primitive props so a widget test can pin every state.

import 'package:flutter/widgets.dart';
import 'package:flutter/material.dart' show Icons, InkWell;

import '../session/usage_counters.dart';

import 'tokens.dart';

/// Header `.tgt` badge. Tappable to toggle unless [fixed] (cloud instance 🔒).
/// [connected] false renders the neutral `→ —` (demo frame 9).
class DestinationHeaderBadge extends StatelessWidget {
  const DestinationHeaderBadge({
    super.key,
    required this.recordOnly,
    required this.label,
    required this.fixed,
    required this.connected,
    this.onToggle,
  });

  final bool recordOnly;
  final String label;
  final bool fixed;
  final bool connected;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final bool neutral = !connected;
    final Color fg = neutral
        ? FlowMicColors.t3
        : recordOnly
        ? FlowMicColors.slate
        : FlowMicColors.teal;
    final Color bg = neutral
        ? FlowMicColors.surface2
        : recordOnly
        ? FlowMicColors.slateSoft
        : FlowMicColors.tealSoft;
    final String text = neutral ? '→ —' : '→ $label';

    final Widget pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (fixed) ...<Widget>[
            Icon(Icons.lock_outline, size: 11, color: FlowMicColors.slate),
            const SizedBox(width: 3),
          ],
          // 🔴 owner 2026-08-03 —— 「顶部的 PC 实例名称看不清楚，不知道在跟哪台
          // 电脑发消息，要退出才能了解」("the PC instance name at the top isn't
          // legible — I can't tell which computer I'm sending messages to, and
          // I'd have to exit to find out").
          //
          // This label's content is the PC's **focused window** (`FocusState.appLabel`:
          // the process name,
          // **falling back to the window title** when the process name is empty
          // — which could be a whole sentence like 「M3窗口主控启动与关键
          // 任务… - CLAUDE.md - Cursor」). It used to be an **incompressible**
          // `Text`:
          // inside the `Row` it claimed its full intrinsic width first, and only
          // what was left went to everyone else ⇒ **a long window title would
          // directly squeeze out 「which computer am I talking to」**.
          //
          // 🔴 The root cause was the priority being backwards, not the font
          // size or the colour: what got squeezed out was **identity** (which
          // computer, which barely changes within one session), and what was
          // squeezing it was a **transient value** (the focused window, which
          // changes every few seconds).
          // So here the label is made to ellipsize itself first, and
          // `chat_header.dart` on the other end gives it a width ceiling.
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );

    if (fixed || onToggle == null || neutral) return pill;
    // V2-04: the input-row duplicate entry is gone, so THIS badge is the only
    // way to switch destination — its tap target is stretched to ≥40dp while
    // the pill's own visuals stay byte-identical.
    return InkWell(
      // R-UX-09: after V2-03 removes the composer mirror this badge is the ONLY
      // destination switch, so its count is also the honest total for the action.
      onTap: onToggle == null
          ? null
          : () {
              countUsage(UsageEvent.destinationToggle);
              onToggle!();
            },
      borderRadius: BorderRadius.circular(99),
      child: Container(
        constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
        alignment: Alignment.center,
        child: pill,
      ),
    );
  }
}


// DestinationMirror (the composer-row twin of the header badge) was DELETED in
// V2-03. owner 2026-07-28:「说话按钮上方的焦点按钮清掉，因为顶部已有目标焦点，
// 不需要重复显示」("clear out the focus button above the speak button, because
// the top already has the target focus — no need to show it twice"). It was a
// fully-equivalent second entry point — same label,
// same toggle — so removing it cost no capability.
//
// It is deleted rather than left behind「以防以后要用」("in case it's needed
// later"): a widget that exists
// and is never rendered is the third form of façade this repo keeps finding
// (volume 13 §8 F9), and the next reader would have no way to tell whether it is
// live. git history is where unused code belongs.
