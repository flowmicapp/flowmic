// SPEC-REF:
//   docs/ui-design/demo/mobile.html (.ctxmenu delete [danger])
//   CLAUDE.md red line: no silent failure — and its sibling, no silent destruction
//   owner 2026-08-01 "color + icon combination, never rely on color alone"
//     (「颜色+图标组合，不能只靠颜色」) — the C-8 criterion, cited at
//     apps/desktop/src/main-window/DevicesPage.vue (channel cards).
//
// owner 2026-07-27: "all deletions... must have a second confirmation"
// (「所有删除…都要二次确认」).
//
// One dialog for every destructive action on the phone, because three
// hand-rolled AlertDialogs would drift into three different wordings and one of
// them would eventually forget to ask. The shape is fixed here:
//
//   · the title NAMES the thing being destroyed, so the user can see they
//     grabbed the row they meant;
//   · the danger action is LAST, cancel is first — the accidental tap lands on
//     cancel;
//   · dismissing by tapping outside counts as CANCEL (`?? false`), never as
//     consent, which is why every call site must treat a null as "no".
//
// ── REQ-12-01 (owner 2026-08-12 requirement ① "the sign-out confirm dialog's
//    styling needs improvement" 「退出登录二次确认样式要改进」) ────────────
// The GATE is untouched — same one call, same `?? false`, same "dismiss means
// no". What changed is the two things that were visually wrong:
//
//   ① "cancel" and the danger action were bare TextButtons of identical size and
//      weight, differing ONLY in label colour. That is the exact shape owner
//      2026-08-01 ruled against on the desktop channel cards
//      ("color + icon combination, never rely on color alone" 「颜色+图标组合，
//      不能只靠颜色」) — and it mattered far more here, because
//      on those cards colour decorated an identity while here it is the only
//      thing separating "cancel" from "delete it". Now the difference is carried by
//      THREE independent signals: fill (cancel is a solid neutral chip, the
//      danger action is a red-tinted outlined one), an icon on the danger
//      action only, and the label colour that was already there. Remove the
//      colour entirely and the two are still told apart.
//      ⚠️ The safe action is deliberately the SOLID one. Making the destructive
//      button the biggest, most-filled thing on screen is the usual product
//      instinct and it is wrong for a confirm: it lowers the cost of the click
//      this dialog exists to raise.
//   ② the body had to say two OPPOSITE things at once —「you will lose X」and
//      「Y is not affected」— and said them in one run-on paragraph of the same
//      13.5px secondary grey. A skimming reader took neither. The reassurance
//      clauses now live in [unaffected]: their own inset panel, each line
//      check-marked, under a label that says what the panel is. The clauses
//      themselves are load-bearing (a prettier dialog that drops them is worse
//      than the one it replaced) — this moves them, it does not shorten them.
//
// Deliberately NOT applied to reversible actions (editing a row, clearing the
// compose buffer, renaming an alias): a confirm on everything trains people to
// tap through confirms, which is how the one that mattered gets tapped through.

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Ask before destroying something. Returns true only on an explicit confirm.
///
/// [title] names the object ("Delete pairing", "Delete this record"); [message]
/// states what is actually lost — a confirm that only says "are you sure?"
/// makes the user guess at the consequence they are agreeing to.
///
/// [unaffected] is the other half of that honesty for actions whose name reads
/// scarier than their blast radius ("sign out" 退出登录 does not delete your
/// records and does not delete your account). Each entry is one thing that
/// SURVIVES the
/// action. Optional on purpose: a delete that really does destroy everything it
/// touches must NOT grow a reassurance panel just because the widget offers one.
/// [unaffectedLabel] names the panel; required whenever [unaffected] is used, so
/// the list can never render as an unexplained set of ticks.
Future<bool> confirmDestructive(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  required String cancelLabel,
  List<String> unaffected = const <String>[],
  String? unaffectedLabel,
}) async {
  assert(
    unaffected.isEmpty || unaffectedLabel != null,
    'unaffected lines need a label — an unlabelled tick list does not say what '
    'it is claiming survives',
  );
  final bool? ok = await showDialog<bool>(
    context: context,
    builder: (BuildContext ctx) => AlertDialog(
      backgroundColor: FlowMicColors.surface,
      surfaceTintColor: FlowMicColors.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      titlePadding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
      actionsPadding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
      title: _DangerTitle(title: title),
      // Scrollable: the body is now a consequence line PLUS a panel, and the
      // four locales are not the same length. An AlertDialog does not scroll its
      // content on its own, so a long ko/ja body on a short phone would overflow
      // — and an overflowing confirm hides the very sentence it exists to show.
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              message,
              style: TextStyle(color: FlowMicColors.t1, fontSize: 13.5, height: 1.55),
            ),
            if (unaffected.isNotEmpty) ...<Widget>[
              const SizedBox(height: 14),
              _UnaffectedPanel(label: unaffectedLabel!, lines: unaffected),
            ],
          ],
        ),
      ),
      actions: <Widget>[
        _ConfirmAction(
          label: cancelLabel,
          onTap: () => Navigator.of(ctx).pop(false),
          // The SOLID one. See ① above: the safe choice is the easy target.
          background: FlowMicColors.surface2,
          ink: FlowMicColors.t1,
          borderColor: FlowMicColors.surface2,
        ),
        _ConfirmAction(
          label: confirmLabel,
          onTap: () => Navigator.of(ctx).pop(true),
          background: FlowMicColors.redSoft,
          ink: FlowMicColors.red,
          borderColor: FlowMicColors.red,
          // The second, non-colour signal. A user who cannot see the red still
          // has an outline and a glyph telling these two buttons apart.
          icon: Icons.warning_amber_rounded,
        ),
      ],
    ),
  );
  // A dialog dismissed by tapping outside returns null. That is NOT consent.
  return ok ?? false;
}

/// The title row: a danger mark plus the sentence that names the object.
class _DangerTitle extends StatelessWidget {
  const _DangerTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: FlowMicColors.redSoft,
            shape: BoxShape.circle,
          ),
          child: Icon(Icons.priority_high_rounded, size: 17, color: FlowMicColors.red),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            title,
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 16,
              fontWeight: FontWeight.w700,
              height: 1.3,
            ),
          ),
        ),
      ],
    );
  }
}

/// 「What this does NOT touch」 — the reassurance clauses, given their own
/// surface so they stop competing with the consequence sentence above them.
class _UnaffectedPanel extends StatelessWidget {
  const _UnaffectedPanel({required this.label, required this.lines});

  final String label;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      decoration: BoxDecoration(
        color: FlowMicColors.surface2,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            label,
            style: TextStyle(
              color: FlowMicColors.t3,
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
          for (final String line in lines)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.only(top: 1.5),
                    child: Icon(Icons.check_rounded, size: 14, color: FlowMicColors.green),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      line,
                      style: TextStyle(
                        color: FlowMicColors.t2,
                        fontSize: 12.5,
                        height: 1.45,
                      ),
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

/// One dialog action. Both actions are the same widget with different paint, so
/// a future edit cannot accidentally give one of them a bigger hit box than the
/// other — which is how a confirm quietly becomes cheaper to click through.
class _ConfirmAction extends StatelessWidget {
  const _ConfirmAction({
    required this.label,
    required this.onTap,
    required this.background,
    required this.ink,
    required this.borderColor,
    this.icon,
  });

  final String label;
  final VoidCallback onTap;
  final Color background;
  final Color ink;
  final Color borderColor;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        backgroundColor: background,
        foregroundColor: ink,
        // 44 is the floor both actions share. The old bare TextButtons were
        // ~36 tall with the label as the only visible surface.
        minimumSize: const Size(96, 44),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: borderColor),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 15, color: ink),
            const SizedBox(width: 6),
          ],
          Text(
            label,
            style: TextStyle(color: ink, fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
