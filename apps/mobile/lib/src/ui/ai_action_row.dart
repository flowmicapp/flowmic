// SPEC-REF:
//   docs/ui-design/2026-08-11-ai-pills-edit-mode-and-floating-confirm.md §3
//     (the trio renders ONLY inside the edit card, below the text field;
//     labelled when the measured card width fits it, compact only as fallback;
//     a disabled pill must SPEAK on tap, never play dead)
//   docs/decisions/2026-08-11-owner-deferred-batch-explanations-and-rulings.md
//     §二-A (owner ruling #4: only appears in edit state / icon+text preferred)
//   docs/ui-design/REDESIGN-PLAN.md §6.2 ④ (AI action row: polish/organize/translate
//     three pills, act on the buffer, do not inject), §2 F-3 (under manual
//     mode the three actions replace the buffer, do not inject; on failure
//     the pre-action buffer is preserved)
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §0 D6 + §2
//     (「AI pill row: pills 1dp line border, r99, padding 8v×15h, 12.5sp,
//     page-bg fill」) — the WP8 face, transcribed below.
//
// Three pills over the compose buffer. They are pure text transforms: the
// result lands back in the editable box and the user still has to press ➤. The
// standing caption states that outright, because「the AI sent it」must never be a
// reasonable reading of these buttons.
//
// While a run streams, the active pill shows a spinner and the whole row goes
// inert — a second run into the same buffer would race the first.
//
// ── WP8 VF-4: the face is the mock's, and the icons are GONE ─────────────────
// Contract §0 row D6 (「AI pills tinted with icons」) is one of the deltas the
// owner rejected WP7 over. The mock's `.aib` is
//   `border:1px solid var(--line);border-radius:99px;padding:8px 15px;
//    font-size:12.5px;background:var(--bg)`
// — a plain outlined pill on the PAGE background (one step behind the sheet
// panel it sits on), text-only, no font-weight override. Frame A-08 draws one
// extra face, the pill whose transform is currently applied:
//   `background:var(--pri);color:#fff;border-color:var(--pri)` with the label
// read `polish ✓`. That is [appliedTask] below.
//
// 🔴 The leading icons died in the LABELLED branch only. [compact] keeps them
// because a compact pill has no words at all — an icon-less compact pill would
// be a blank circle, which is not "the mock's face", it is no face. The mock
// never draws a compact row (it is this app's narrow-width fallback), so the
// mock decides its colours and nothing else.
//
// ── History of [compact], kept because the ruling reversed it ────────────────
// FB-3 D1 (2026-08-06) folded this trio into the toolbar, where the labels
// measurably did NOT fit on a 360dp phone (the old width account lived in this
// header and in compose_three_row_layout_test.dart), so [compact] dropped the
// words to icons. Owner ruling #4 (2026-08-11) reverses the RESIDENCY: the
// pills left the toolbar for the edit card, whose inner width usually does fit
// the labelled row — so labelled is now the preferred branch and [compact] is
// the measured fallback, decided by [labelledRowFits] against the card's real
// width, not guessed from the screen width. In the compact branch the label
// and the caption still live in the pill's Tooltip + Semantics, and the SHEET
// prints the caption on its own line (chat_flow_edit_sheet.dart) — the honesty
// the caption carries is not something a layout change may spend.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../signaling/wire_payloads.dart' show ComposeTask;
import 'tokens.dart';

/// Demo order: polish · organize · translate.
const List<ComposeTask> kAiComposeTasks = <ComposeTask>[
  ComposeTask.draftPolish,
  ComposeTask.organize,
  ComposeTask.translate,
];

class AiActionRow extends StatelessWidget {
  const AiActionRow({
    super.key,
    required this.strings,
    required this.enabled,
    required this.runningTask,
    required this.onTask,
    this.onDisabledTap,
    this.compact = false,
    this.appliedTask,
    this.showNote = true,
  });

  // ── Layout constants, named so [labelledRowWidth] and [build] cannot drift
  //    apart: the measurement below is only honest while it reads the SAME
  //    numbers the paint does. ──────────────────────────────────────────────
  /// Mock `.aib{padding:8px 15px}` — horizontal half.
  static const double _labelledPillHPad = 15;

  /// Mock `.aib{padding:8px 15px}` — vertical half. The pill is
  /// PADDING-driven since WP8 (the old fixed `height: 30` is gone): 8 + 8 +
  /// a 12.5sp line ≈ 33dp, which is the mock's own rendered height.
  static const double _labelledPillVPad = 8;

  /// The glyph slot in a labelled pill. Since WP8 a RESTING labelled pill draws
  /// nothing there (mock `.aib` is text-only) — the slot is occupied only by
  /// the busy spinner.
  static const double _labelledIconSize = 12;
  static const double _labelledIconGap = 5;
  static const double _labelledPillGap = 7;
  static const double _labelFontSize = 12.5;
  static const double _noteFontSize = 10.5;

  /// `Border.all` on every pill, both sides. A [Container]'s border is layout,
  /// not paint — it is added to the padding — so [labelledRowWidth] has to bill
  /// it. It did not, and that was a 2dp-per-pill under-bill (measured).
  static const double _pillBorderWidth = 1;

  /// A-08's applied pill reads `polish ✓`. A LAYOUT glyph, never a change to
  /// [AppStrings.aiTaskLabel] — the four-locale copy is frozen and this mark is
  /// a face, not a word.
  ///
  /// 🔴 Drawn as its OWN run with an explicit [_appliedGlyphGap], exactly like
  /// the deliver button's `➤`, and NOT as the string `' ✓'`. A space character
  /// is a font's opinion about spacing: the flutter_test font advances every
  /// glyph a full em, so `' ✓'` measured 25.5dp there against ~16dp with real
  /// fonts, and those 9dp were enough to push the 360dp row over its budget.
  /// A layout gap must be a layout gap.
  static const String _appliedGlyph = '✓';
  static const double _appliedGlyphGap = 4;

  final AppStrings strings;

  /// ChatController.canAiCompose — the ONE enable source (ruling #4 contract
  /// §3 collapsed the duplicate buffer term the toolbar caller used to AND in).
  final bool enabled;

  /// Non-null ⇒ that task is streaming right now (progress + disabled state).
  final ComposeTask? runningTask;

  final void Function(ComposeTask task) onTask;

  /// Ruling #4's dead-control ban: when the row is disabled and NOTHING is running,
  /// a tap must explain itself instead of playing dead. Wired by the edit
  /// sheet to a toast with the aiComposeError copy. Null (component tests,
  /// legacy callers) keeps the old inert `onTap: null` behaviour — while a
  /// run streams the pills stay inert either way, because 「the previous run
  /// hasn't finished yet」
  /// is already spoken by the spinner + aiRunning caption.
  final void Function(ComposeTask task)? onDisabledTap;

  /// Icon-only pills. Since owner ruling #4 this is a measured FALLBACK for a
  /// card too narrow for the labelled row — see this file's header.
  final bool compact;

  /// WP8 / mock A-08 — the transform whose result the buffer is CURRENTLY
  /// showing, drawn as the filled `pri` face with a ✓.
  ///
  /// 🔴 It is an INPUT, not a memory: this widget is stateless and cannot know
  /// whether a run succeeded, whether the user has since typed over the result,
  /// or whether 「restore original text」 put the original back. Its owner (the sheet) watches
  /// those edges and passes the answer down. Default null keeps every other
  /// consumer — plus_panel_widget_test's bare rows — byte-identical.
  final ComposeTask? appliedTask;

  /// Whether the labelled branch prints the standing caption at the row's end.
  ///
  /// 🔴 The ONLY caller that passes false is the sheet while an in-sheet append
  /// is live (mock A-07 drops the caption from `.aic`), and it is legitimate
  /// there for a reason that is about the BUTTONS, not about the sentence: the
  /// whole row is at .4 opacity inside an [IgnorePointer] in that window, so
  /// there is no button the caption could be misread as describing. The moment
  /// the pills become pressable again the caption is back. Anything else
  /// passing false would be spending the sentence ruling #4 forbids spending.
  final bool showNote;

  /// The width the LABELLED row needs to print all three labels AND the
  /// standing 「acts on the buffer · does not inject」 caption in full, under the ambient text
  /// scale. Reads the same constants [build] paints with (one author).
  ///
  /// 🔴 IT IS MEASURED FOR A STATE, because [build] paints a different width in
  /// each: [runningTask] adds a spinner + gap to one pill, [appliedTask] adds
  /// the ✓ run to one pill, and a RESTING row has neither. Billing the widest
  /// case unconditionally is what made the sheet fall back to icon-only pills
  /// at 360dp: it reserved 16.75dp for a glyph that was not on screen, against
  /// a budget it missed by 0.5dp (both measured — see sheet_faces_test.dart's
  /// paint-vs-bill case, which asserts this function equals the rendered row's
  /// width rather than merely claiming to).
  ///
  /// ⚠️ So the verdict CAN change when a pill changes state. The delta is at
  /// most one glyph slot (≤17dp) and it is the honest answer: the alternative
  /// — a permanent reservation — is what the icon-only regression was.
  static double labelledRowWidth(
    BuildContext context,
    AppStrings strings, {
    ComposeTask? runningTask,
    ComposeTask? appliedTask,
  }) {
    final TextScaler scaler = MediaQuery.textScalerOf(context);
    // 🔴 Measure through the AMBIENT style, not a bare TextStyle. Material's
    // text theme carries `letterSpacing: 0.25`, which every Text in the row
    // inherits and which a bare `TextStyle(fontSize: …)` does not model — it
    // under-billed the caption by 2.75dp and each label by 0.5dp (measured).
    final TextStyle ambient = DefaultTextStyle.of(context).style;
    double textWidth(String text, double fontSize, FontWeight weight) {
      final TextPainter p = TextPainter(
        text: TextSpan(
          text: text,
          style: ambient.merge(
            TextStyle(fontSize: fontSize, fontWeight: weight),
          ),
        ),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      return p.width;
    }

    double w = 0;
    for (final ComposeTask task in kAiComposeTasks) {
      w +=
          _labelledPillHPad * 2 +
          _pillBorderWidth * 2 +
          textWidth(
            strings.aiTaskLabel(task),
            _labelFontSize,
            FontWeight.normal,
          );
      w += _labelledPillGap;
    }
    // At most ONE pill is ever non-resting, and the two ways it can be are
    // mutually exclusive (a run STARTING clears the applied mark — see the
    // sheet's tracker), so each is billed once and only when it is real.
    if (runningTask != null) w += _labelledIconSize + _labelledIconGap;
    if (appliedTask != null && appliedTask != runningTask) {
      w +=
          _appliedGlyphGap +
          textWidth(_appliedGlyph, _labelFontSize, FontWeight.normal);
    }
    // The caption's own intrinsic width is part of the bill: a "labelled" row
    // whose Expanded caption ellipsised down to nothing would silently drop
    // the one sentence the ruling forbids losing.
    //
    // ⚠️ Billed even when [showNote] is false. That is deliberate: the append
    // window must not be able to flip the row's presentation (labelled ⇄
    // compact) under the user's thumb, and the append face is transient.
    w += textWidth(strings.aiRowNote, _noteFontSize, FontWeight.normal);
    return w;
  }

  /// 「use icon+text whenever icon+text fits」, measured (ruling #4 second clause).
  static bool labelledRowFits(
    BuildContext context,
    AppStrings strings,
    double maxWidth, {
    ComposeTask? runningTask,
    ComposeTask? appliedTask,
  }) =>
      labelledRowWidth(
        context,
        strings,
        runningTask: runningTask,
        appliedTask: appliedTask,
      ) <=
      maxWidth;

  @override
  Widget build(BuildContext context) {
    final ComposeTask? running = runningTask;
    if (compact) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final ComposeTask task in kAiComposeTasks) ...<Widget>[
            _pill(task, busy: running == task),
            const SizedBox(width: 6),
          ],
        ],
      );
    }
    return Row(
      children: <Widget>[
        for (final ComposeTask task in kAiComposeTasks) ...<Widget>[
          _pill(task, busy: running == task),
          const SizedBox(width: _labelledPillGap),
        ],
        if (showNote)
          Expanded(
            child: Text(
              running != null ? strings.aiRunning(running) : strings.aiRowNote,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: FlowMicDockColors.sub,
                fontSize: _noteFontSize,
              ),
            ),
          ),
      ],
    );
  }

  Widget _pill(ComposeTask task, {required bool busy}) {
    final String label = strings.aiTaskLabel(task);
    final IconData icon = switch (task) {
      ComposeTask.draftPolish => Icons.auto_awesome,
      ComposeTask.organize => Icons.segment,
      ComposeTask.translate => Icons.translate,
    };
    // A pill is live only when the row is enabled AND nothing is running.
    final bool on = enabled && runningTask == null;
    // A-08's filled face. `!busy` because a pill cannot be reporting a finished
    // transform and running one at the same time — the spinner wins that frame.
    final bool applied = appliedTask == task && !busy;
    // Disabled-but-idle + a caller who wired the explainer ⇒ the tap SPEAKS.
    // Deliberately not an empty function: onDisabledTap carries the reason to
    // a visible toast, so the ripple this handler brings back is no longer the
    // lie it would have been on a silent no-op.
    final VoidCallback? tap = on
        ? () => onTask(task)
        : (runningTask == null && onDisabledTap != null
              ? () => onDisabledTap!(task)
              : null);
    // Mock `.aib`: page-bg fill, 1dp line border, ink label — one neutral face
    // for live / busy / disabled alike. The three states are told apart by the
    // spinner and by the label's ink, NOT by tinting the pill (contract §0 D6).
    final Color face = applied ? FlowMicDockColors.pri : FlowMicDockColors.bg;
    final Color edge = applied ? FlowMicDockColors.pri : FlowMicDockColors.line;
    final Color fg = applied
        ? FlowMicDockColors.onPri
        : (on || busy ? FlowMicDockColors.ink : FlowMicDockColors.sub);
    // Kept from the pre-WP8 face on purpose: a spinner is the run's REAL
    // progress (the only honest one — the server streams text, not percent),
    // and with the icons gone it is now the pill's only leading glyph.
    final Widget? glyph = busy
        ? SizedBox(
            width: _labelledIconSize,
            height: _labelledIconSize,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              valueColor: AlwaysStoppedAnimation<Color>(FlowMicDockColors.pri),
            ),
          )
        : (compact ? Icon(icon, size: 15, color: fg) : null);
    final Widget button = InkWell(
      key: ValueKey<String>('ai.task.${task.wire}'),
      onTap: tap,
      borderRadius: BorderRadius.circular(99),
      child: Container(
        height: compact ? 32 : null,
        width: compact ? 32 : null,
        alignment: compact ? Alignment.center : null,
        padding: compact
            ? null
            : const EdgeInsets.symmetric(
                horizontal: _labelledPillHPad,
                vertical: _labelledPillVPad,
              ),
        decoration: BoxDecoration(
          color: face,
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: edge),
        ),
        child: compact
            ? glyph
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (glyph != null) ...<Widget>[
                    glyph,
                    const SizedBox(width: _labelledIconGap),
                  ],
                  Text(
                    label,
                    style: TextStyle(color: fg, fontSize: _labelFontSize),
                  ),
                  if (applied) ...<Widget>[
                    const SizedBox(width: _appliedGlyphGap),
                    Text(
                      _appliedGlyph,
                      style: TextStyle(color: fg, fontSize: _labelFontSize),
                    ),
                  ],
                ],
              ),
      ),
    );
    if (!compact) return button;
    // The word AND the standing 「acts on the buffer · does not inject」 caption, both of which the
    // compact row has no horizontal room to print. Semantics carries the same
    // pair so a screen reader is not left with a bare icon.
    final String spoken = busy
        ? '${strings.aiRunning(task)} · ${strings.aiRowNote}'
        : '$label · ${strings.aiRowNote}';
    return Tooltip(
      message: spoken,
      child: Semantics(label: spoken, button: true, child: button),
    );
  }
}
