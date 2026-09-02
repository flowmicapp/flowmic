// SPEC-REF:
//   docs/ui-design/2026-08-29-continuous-recording-demo.html — `.lr` / `.lr.off`
//     (cells A-1 available, A-2 refused-with-a-reason)
//   apps/mobile/lib/src/audio/continuous_offer.dart — the DECISION; this file
//     only draws it
//   task unit §6 C6 — 「unavailable ⇒ and a reason」, asserted on the RENDERED
//     result (the 0.2.53 law), which is why the reason is a real Text with its
//     own key rather than a tooltip or a semantics-only string
//
// The continuous-recording entry, as it stands in the light-record dock.
//
// ── 🔴 IT DRAWS A DECISION IT DOES NOT MAKE ─────────────────────────────────
//
// [ContinuousOffer] answers 「may it be pressed」 and 「what does it owe the
// user」; this widget answers neither. The split is the reason the decision can
// be tested without a frame and the copy can be tested without a network — and
// it is why a future change to, say, the link rule cannot be made here by
// accident.
//
// ⚠️ [ContinuousOffer.visible] is the CALLER's business. A row that decided its
// own absence would still be a widget on the tree deciding to paint nothing,
// and the dock's layout (its gaps in particular) has to know whether the row
// exists at all. The caller asks, then builds — see `compose_band.dart`, which
// makes the same choice for the PC key group.

import 'package:flutter/widgets.dart';

import '../audio/continuous_offer.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

/// Keys, so tests can assert on what was RENDERED rather than on what was
/// passed in.
class ContinuousEntryKeys {
  const ContinuousEntryKeys._();
  static const ValueKey<String> row = ValueKey<String>('continuous.entry');
  static const ValueKey<String> title = ValueKey<String>('continuous.entry.title');

  /// The numbers line — present only when there is a number to print.
  static const ValueKey<String> numbers = ValueKey<String>('continuous.entry.numbers');

  /// The refusal line — present only when the entry owes a sentence.
  ///
  /// 🔴 A DIFFERENT KEY FROM [numbers] ON PURPOSE. They occupy the same slot,
  /// and one key for both would let a test that meant 「it explained itself」 be
  /// satisfied by 「it printed a ceiling」 — a ruler answering the adjacent
  /// question, which is the failure this repo keeps finding in its own checks.
  static const ValueKey<String> reason = ValueKey<String>('continuous.entry.reason');
}

class ContinuousEntryRow extends StatelessWidget {
  const ContinuousEntryRow({
    super.key,
    required this.offer,
    required this.strings,
    required this.onStart,
  });

  final ContinuousOffer offer;
  final AppStrings strings;

  /// Opens the pre-flight sheet (demo cell B). Required and non-nullable: 13 册
  /// §7 F1 ② — no friendly default, because a default here would be a row that
  /// looks live and does nothing.
  final VoidCallback onStart;

  /// The sub-line: the numbers when there are numbers, the refusal when there is
  /// a refusal, and nothing at all when neither.
  ///
  /// 🔴 THE REFUSAL WINS THE SLOT. When the entry cannot be pressed, 「why」 is
  /// what the user needs; the ceiling is a fact about the plan they can read on
  /// any other day. The one case that has neither — link down with everything
  /// else fine — deliberately prints NOTHING rather than reaching for a third
  /// sentence: the dock one centimetre up already says 未连接 (`ContinuousBlock`
  /// carries the argument in full).
  Widget? _subLine() {
    final ContinuousBlock? reason = offer.reason;
    if (reason != null) {
      return Text(
        switch (reason) {
          // Owner ruling (2026-09-02) — scope breach flagged in the B2-N
          // report: this file is not in that task's file list, but the new
          // `ContinuousBlock.notSignedIn` member makes this `switch`
          // non-exhaustive without a case for it, so the minimum edit to keep
          // the build green is one line here.
          ContinuousBlock.notSignedIn => strings.continuousEntrySignInNote,
          ContinuousBlock.modeNotRealtime => strings.continuousEntryModeNote,
          ContinuousBlock.ceilingUnknown => strings.continuousEntryNoCeilingNote,
          ContinuousBlock.quotaSpent => strings.continuousEntryQuotaSpentNote,
        },
        key: ContinuousEntryKeys.reason,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 10, height: 1.35, color: FlowMicDockColors.sub),
      );
    }
    final int? cap = offer.capMinutes;
    // Without a ceiling there is no sentence to build — and no ceiling with no
    // refusal cannot happen (`continuousOffer` returns `ceilingUnknown` for it),
    // so this is a defensive nothing rather than a face anybody sees.
    if (cap == null) return null;
    final int? left = offer.remainingMinutes;
    return Text(
      left == null
          // §5-2: one end unreadable ⇒ that end is not drawn. Never 「还剩 0」,
          // never a vaguer sentence that hides both.
          ? strings.continuousEntryCap(cap)
          : strings.continuousEntryCapAndLeft(cap, left),
      key: ContinuousEntryKeys.numbers,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontSize: 10,
        color: FlowMicDockColors.sub,
        letterSpacing: 0.1,
        // Digits in a row that changes between frames: tabular figures keep the
        // line from twitching as the balance ticks down.
        fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool on = offer.enabled;
    // `.lr` / `.lr.off`. The disabled face drops the tinted fill entirely rather
    // than dimming it — §5-9 asks for no large static bright areas on a screen
    // that may stay lit for half an hour, and a control that cannot be used has
    // no claim on the eye at all.
    final Color border = on
        ? FlowMicDockColors.pri.withValues(alpha: 0.34)
        : FlowMicDockColors.line;
    final Widget? sub = _subLine();

    final Widget content = Container(
      key: ContinuousEntryKeys.row,
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
      decoration: BoxDecoration(
        color: on ? FlowMicDockColors.pri.withValues(alpha: 0.07) : null,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(13),
      ),
      child: Row(
        children: <Widget>[
          _Glyph(on: on),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  strings.continuousEntryTitle,
                  key: ContinuousEntryKeys.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: FlowMicDockColors.ink,
                  ),
                ),
                if (sub != null) ...<Widget>[const SizedBox(height: 2), sub],
              ],
            ),
          ),
          const SizedBox(width: 8),
          // `.go` — the chevron. Drawn, not written: a `›` glyph is a font
          // question and this has to look the same in nine locales.
          _Chevron(color: on ? FlowMicDockColors.pri : FlowMicDockColors.sub),
        ],
      ),
    );

    if (!on) {
      // 🔴 The row keeps its GEOMETRY when refused — it does not shrink, move,
      // or leave. A dock that re-arranges when the mode chip is tapped is the
      // 0.3.1 P3 defect in miniature, and the reason line has to be readable in
      // the place the user just looked.
      return Opacity(
        opacity: 0.4,
        // Semantics stay: a screen reader must be able to reach the sentence
        // explaining why this cannot be used. `ExcludeSemantics` here would
        // make the refusal invisible to exactly the users who most need it read
        // aloud.
        child: Semantics(
          button: true,
          enabled: false,
          child: IgnorePointer(child: content),
        ),
      );
    }
    return Semantics(
      button: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onStart,
        child: content,
      ),
    );
  }
}

/// `.lr .ic` — the 32dp rounded square with a record mark in it.
///
/// Two concentric circles rather than the demo's `◉` character: a glyph is a
/// font lookup, and a font that lacks it draws a tofu box in the one place the
/// control identifies itself.
class _Glyph extends StatelessWidget {
  const _Glyph({required this.on});
  final bool on;

  @override
  Widget build(BuildContext context) {
    final Color ink = on ? FlowMicDockColors.pri : FlowMicDockColors.sub;
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        color: on
            ? FlowMicDockColors.pri.withValues(alpha: 0.14)
            : FlowMicDockColors.chipbg,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Center(
        child: Container(
          width: 15,
          height: 15,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: ink, width: 1.4),
          ),
          child: Center(
            child: Container(
              width: 6.5,
              height: 6.5,
              decoration: BoxDecoration(shape: BoxShape.circle, color: ink),
            ),
          ),
        ),
      ),
    );
  }
}

/// `.lr .go` — a plain 「go on」 chevron, drawn.
class _Chevron extends StatelessWidget {
  const _Chevron({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) =>
      CustomPaint(size: const Size(7, 12), painter: _ChevronPainter(color));
}

class _ChevronPainter extends CustomPainter {
  const _ChevronPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final Path path = Path()
      ..moveTo(size.width * 0.15, size.height * 0.12)
      ..lineTo(size.width * 0.85, size.height * 0.5)
      ..lineTo(size.width * 0.15, size.height * 0.88);
    canvas.drawPath(path, p);
  }

  @override
  bool shouldRepaint(_ChevronPainter old) => old.color != color;
}
