// SPEC-REF:
//   docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md §Chose
//     (「单条轨道 + 中点刻度；左侧填充 = min(used_min/limit_min,1) × 50%（品牌色），
//      右侧填充 = min(tokens_used/limit,1) × 50%（teal）… 用满（≥100%）⇒ 填充到
//      中点并换警示色，数字照实显示」)
//   apps/mobile/lib/src/auth/cloud_summary.dart (where the numbers come from)
//   CLAUDE.md red line: no invented colours outside tokens.dart / a copy
//     assertion must land on the RENDERED result, not on `Text.data` (0.2.53)
//
// The two-way quota gauge — one track, minutes growing in from the left, context
// tokens growing in from the right, a tick at the middle. Owner's shape, and the
// property that makes it legible is arithmetic rather than styling: **each side's
// 100% is the centre**, so the two fills can approach but never overlap and a
// full bar always means 「one of them is spent」 rather than 「something is 200%」.
//
// ── 🔴 THE MATH IS A SEPARATE, PURE TYPE, AND THAT IS THE POINT ─────────────
//
// [QuotaGaugeLayout] takes numbers and answers fractions/flags with no widget,
// no context and no strings. It is what the unit tests drive. The widget below
// only turns those fractions into boxes. Written the other way round — fractions
// computed inline in `build` — the only way to test「a used-up meter fills to the
// centre and no further」would be to measure pixels, and a layout regression and
// an arithmetic regression would be indistinguishable.
//
// ── 🔴 THERE IS NO 「UNLIMITED」 FACE ───────────────────────────────────────
//
// A side whose numbers could not be read is simply NOT DRAWN — no bar, no
// label, no sentence. `cloud_summary.dart`'s [CloudMeter] carries the whole
// argument: the server retired ∞-as-`null` on 2026-08-07, so an empty ceiling
// can only mean 「we failed to read it」, and printing 「unlimited」 for it would
// put a boundless claim under a live gate (R11). A zero-length bar is refused
// for the same reason — it would read as 「you have used none of it」, which is
// an answer we do not have.

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../auth/cloud_summary.dart';
import '../auth/cloud_summary_controller.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

/// The height of the track itself. Fully rounded, so the radius is half of it.
const double kQuotaTrackHeight = 6;

/// The box the track is drawn in. Taller than the track so the centre tick can
/// stand slightly proud of it at both ends — a tick contained INSIDE a 6dp bar
/// is invisible the moment either fill reaches it, which is exactly when it
/// matters most.
const double kQuotaTrackBoxHeight = 10;

/// One side of the gauge, resolved. Fractions are **of the whole track**, so
/// `0.5` is the centre and a side can never be handed a number larger than that.
@immutable
class QuotaGaugeSide {
  const QuotaGaugeSide({required this.fillFraction, required this.overLimit});

  /// 🔴 The one rule, in one place: `min(used/limit, 1) × 0.5`.
  ///
  /// TWO cases that are not that formula, both deliberate:
  ///   · `limit <= 0` with nothing spent ⇒ **0**, and no warning. A zero
  ///     ceiling that has not been touched is not an overrun;
  ///   · `limit <= 0` with something spent ⇒ **0.5 + warning**. Every unit
  ///     spent against a zero allowance is over it. This branch exists because
  ///     the formula would divide by zero, and answering `NaN` into a layout is
  ///     how a gauge becomes an exception in `build`.
  ///
  /// There is no third case for 「no ceiling」: a meter without one never gets
  /// this far — it is not a [CloudMeter] at all (see that type's header).
  factory QuotaGaugeSide.of(CloudMeter meter) {
    final double limit = meter.limit;
    if (limit <= 0) {
      final bool spent = meter.used > 0;
      return QuotaGaugeSide(fillFraction: spent ? 0.5 : 0, overLimit: spent);
    }
    final double ratio = math.max(0, meter.used) / limit;
    return QuotaGaugeSide(
      // Clamped for DRAWING only. The numbers in the label are never clamped —
      // owner's ruling says 「数字照实显示」, so a user who is 130% through their
      // minutes reads 130% worth of minutes next to a bar that stops at the
      // middle.
      fillFraction: math.min(ratio, 1) * 0.5,
      // `>=`, not `>`: spending exactly the allowance IS spending it, and the
      // server's own guard refuses the next request at that point.
      overLimit: meter.used >= limit,
    );
  }

  /// How much of the FULL track this side fills, `0 … 0.5`.
  final double fillFraction;

  /// Spent it all. Drives the warning colour and nothing else — the label keeps
  /// stating the true numbers either way.
  final bool overLimit;
}

/// Both sides of one gauge. **Either side may be null**, meaning 「that end
/// could not be read, so it is not drawn」 — never a zero-length bar.
@immutable
class QuotaGaugeLayout {
  const QuotaGaugeLayout({required this.minutes, required this.tokens});

  factory QuotaGaugeLayout.of(CloudSummary summary) {
    final CloudMeter? m = summary.minutes;
    final CloudMeter? t = summary.tokens;
    return QuotaGaugeLayout(
      minutes: m == null ? null : QuotaGaugeSide.of(m),
      tokens: t == null ? null : QuotaGaugeSide.of(t),
    );
  }

  /// The LEFT half — speech minutes, growing from the left edge inward.
  final QuotaGaugeSide? minutes;

  /// The RIGHT half — context tokens, growing from the right edge inward.
  final QuotaGaugeSide? tokens;
}

/// A quota number as the label states it: an integer when it is one, otherwise
/// one decimal place.
///
/// 🔴 ONE DECIMAL IS A CEILING, NOT A FORMAT. `toStringAsFixed(1)` on a whole
/// number gives 「900.0」, which reads as a measurement precise to a tenth of a
/// minute — a claim about our accounting that we are not making. Whole numbers
/// therefore print whole.
String formatQuotaAmount(double value) {
  final double rounded = (value * 10).roundToDouble() / 10;
  if (rounded == rounded.roundToDouble()) return rounded.toStringAsFixed(0);
  return rounded.toStringAsFixed(1);
}

/// Tokens expressed in millions, which is the unit the plans are sold in
/// (1M / 5M / 15M). Same ≤1-decimal rule as [formatQuotaAmount].
String formatQuotaTokensInMillions(double tokens) =>
    formatQuotaAmount(tokens / 1000000);

/// The gauge. Pure presentation — it takes the numbers and the strings and
/// paints them; it never fetches, and it has no opinion about when to.
class QuotaGauge extends StatelessWidget {
  const QuotaGauge({
    super.key,
    required this.summary,
    required this.strings,
    this.now,
  });

  final CloudSummary summary;
  final AppStrings strings;

  /// Injectable clock, for the reset line only. Production passes nothing.
  ///
  /// ⚠️ Here rather than inside the string method's default because 「in 14
  /// days」 changes every midnight: a test that let it read the wall clock would
  /// be asserting a sentence that is only true on the day it was written.
  final DateTime? now;

  /// Key of the left (minutes) fill, so a widget test can MEASURE it rather
  /// than trust a fraction it computed itself.
  static const ValueKey<String> minutesFillKey =
      ValueKey<String>('settings.quota.fill.minutes');
  static const ValueKey<String> tokensFillKey =
      ValueKey<String>('settings.quota.fill.tokens');
  static const ValueKey<String> trackKey = ValueKey<String>('settings.quota.track');
  static const ValueKey<String> minutesLabelKey =
      ValueKey<String>('settings.quota.label.minutes');
  static const ValueKey<String> tokensLabelKey =
      ValueKey<String>('settings.quota.label.tokens');

  /// The line that says when the allowance starts over. Keyed so a widget test
  /// can assert it is ABSENT — the shape that matters most here, because a
  /// server that never sent the field must produce no row at all.
  static const ValueKey<String> resetLabelKey =
      ValueKey<String>('settings.quota.label.reset');

  @override
  Widget build(BuildContext context) {
    final QuotaGaugeLayout layout = QuotaGaugeLayout.of(summary);
    final AppStrings s = strings;
    final CloudMeter? m = summary.minutes;
    final CloudMeter? t = summary.tokens;

    // 🔴 A side that could not be read contributes NO label and NO fill — not an
    // empty string and not a zero bar. Its half of the row still holds its
    // width, so the other label stays at the end it belongs to instead of
    // sliding into the middle.
    final String? minutesLabel = m == null
        ? null
        : s.quotaVoiceUsed(
            formatQuotaAmount(m.used),
            formatQuotaAmount(m.limit),
          );
    final String? tokensLabel = t == null
        ? null
        : s.quotaContextUsed(
            formatQuotaTokensInMillions(t.used),
            formatQuotaTokensInMillions(t.limit),
          );

    // 🔴 「17 / 20 min」 IS HALF AN ANSWER WITHOUT THIS (owner 2026-09-07). Since
    // the cycle became account-anchored (2026-09-05) the user cannot work out
    // the other half either: two people looking at this screen on the same day
    // reset on different dates. Absent — not blank, not a dash — when the server
    // did not say; see [AppStrings.quotaResetsAt].
    final DateTime? resetsAt = summary.resetsAt;
    final String? resetLabel =
        resetsAt == null ? null : s.quotaResetsAt(resetsAt, now: now);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 🔴 Two Expanded halves, not a Row of intrinsic widths: at 320dp the
        // longest pair of these sentences (de/ru) does not fit side by side, and
        // an unbounded Row would overflow rather than ellipsize. Each label owns
        // exactly half the width and clips inside it.
        Row(
          children: <Widget>[
            Expanded(
              child: minutesLabel == null
                  ? const SizedBox.shrink()
                  : Text(
                      minutesLabel,
                      key: minutesLabelKey,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: layout.minutes!.overLimit
                            ? FlowMicColors.amber
                            : FlowMicColors.t3,
                        fontSize: 10.5,
                      ),
                    ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: tokensLabel == null
                  ? const SizedBox.shrink()
                  : Text(
                      tokensLabel,
                      key: tokensLabelKey,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.right,
                      style: TextStyle(
                        color: layout.tokens!.overLimit
                            ? FlowMicColors.amber
                            : FlowMicColors.t3,
                        fontSize: 10.5,
                      ),
                    ),
            ),
          ],
        ),
        const SizedBox(height: 5),
        SizedBox(
          height: kQuotaTrackBoxHeight,
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints c) {
              final double w = c.maxWidth;
              return Stack(
                children: <Widget>[
                  Positioned(
                    left: 0,
                    right: 0,
                    top: (kQuotaTrackBoxHeight - kQuotaTrackHeight) / 2,
                    height: kQuotaTrackHeight,
                    child: DecoratedBox(
                      key: trackKey,
                      decoration: BoxDecoration(
                        color: FlowMicColors.surface2,
                        borderRadius: BorderRadius.circular(kQuotaTrackHeight / 2),
                      ),
                    ),
                  ),
                  if (layout.minutes != null)
                    _fill(
                      key: minutesFillKey,
                      width: w * layout.minutes!.fillFraction,
                      fromLeft: true,
                      color: layout.minutes!.overLimit
                          ? FlowMicColors.amber
                          : FlowMicColors.brand,
                    ),
                  if (layout.tokens != null)
                    _fill(
                      key: tokensFillKey,
                      width: w * layout.tokens!.fillFraction,
                      fromLeft: false,
                      color: layout.tokens!.overLimit
                          ? FlowMicColors.amber
                          : FlowMicColors.teal,
                    ),
                  // The centre tick, drawn LAST so it stays visible when a fill
                  // reaches it — which is the only moment it has to answer
                  // anything ("is that side full, or nearly?").
                  Positioned(
                    left: (w - 1.5) / 2,
                    top: 0,
                    width: 1.5,
                    height: kQuotaTrackBoxHeight,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: FlowMicColors.t3,
                        borderRadius: BorderRadius.circular(1),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
        // Under the rail, spanning the full width: it speaks about BOTH meters,
        // so it belongs to neither half. A `null` contributes no SizedBox
        // either — an empty gap under the bar would be a row that answers
        // nothing, the same call the two labels above already make.
        if (resetLabel != null) ...<Widget>[
          const SizedBox(height: 5),
          // 🔴 IT WRAPS; IT DOES NOT ELLIPSIZE. The two labels above can be cut
          // because each is 「number / number」 and the front of it carries the
          // answer. This one is a sentence, and 0.2.53 is the standing bill for
          // cutting one: `INJECT_SELF_WINDOW_NO_INPUT` reached a real phone as
          // 「INJ…」. German is the long case here (「Setzt sich am 24.9. um
          // 08:00 zurück · in 14 Tagen」) and it is allowed a second line rather
          // than a shorter truth.
          Text(
            resetLabel,
            key: resetLabelKey,
            style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
          ),
        ],
      ],
    );
  }

  Widget _fill({
    required ValueKey<String> key,
    required double width,
    required bool fromLeft,
    required Color color,
  }) => Positioned(
    left: fromLeft ? 0 : null,
    right: fromLeft ? null : 0,
    top: (kQuotaTrackBoxHeight - kQuotaTrackHeight) / 2,
    width: math.max(width, 0),
    height: kQuotaTrackHeight,
    child: DecoratedBox(
      key: key,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(kQuotaTrackHeight / 2),
      ),
    ),
  );
}

/// The gauge WITH its trigger — what the settings cloud card actually embeds.
///
/// 🔴 STATEFUL FOR ONE REASON: `initState` is 「this card just became visible」,
/// and that is one of owner's two moments for asking. `build` is not — it runs
/// on every unrelated notify from the five controllers the settings page
/// merges, and asking there would turn one question per visit into a request
/// storm nobody would notice locally.
///
/// 🔴 IT RENDERS NOTHING WHEN THERE IS NOTHING TO RENDER, and that is the
/// owner-ruled degrade: no gauge, no error row, no spinner. The card's real
/// business (account, tier, entering Notes) does not depend on this read and
/// must not be interrupted by it. The failure is not silent in the banned sense
/// — every miss names itself in the diagnostic trail (`cloud.summary.miss`).
class CloudQuotaGaugeSection extends StatefulWidget {
  const CloudQuotaGaugeSection({
    super.key,
    required this.controller,
    required this.strings,
  });

  final CloudSummaryController controller;
  final AppStrings strings;

  @override
  State<CloudQuotaGaugeSection> createState() => _CloudQuotaGaugeSectionState();
}

class _CloudQuotaGaugeSectionState extends State<CloudQuotaGaugeSection> {
  @override
  void initState() {
    super.initState();
    widget.controller.refresh();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (BuildContext context, _) {
      final CloudSummary? summary = widget.controller.summary;
      if (summary == null) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(top: 10),
        child: QuotaGauge(
          key: const ValueKey<String>('settings.quota.gauge'),
          summary: summary,
          strings: widget.strings,
        ),
      );
    },
  );
}
