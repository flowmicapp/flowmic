// SPEC-REF:
//   docs/ui-design/2026-08-29-continuous-recording-demo.html — cells B-1
//     (「开始前 · 正常」) and B-2 (「开始前 · 余额不够」)
//   task unit §5-2 (the three things that must be said, and the fourth case that
//     must not be left as arithmetic), §6 C1c
//   apps/mobile/lib/src/audio/continuous_offer.dart — every number here comes
//     from one [ContinuousOffer]; this file computes none of them
//
// The pre-flight sheet: the one moment the user can still change their mind.
//
// ── 🔴 A BRIEFING, NOT A CONFIRM ────────────────────────────────────────────
//
// It deliberately does not go through `confirmDestructive`, whose own header
// refuses wider use — 「a confirm on everything trains people to tap through
// confirms, which is how the one that mattered gets tapped through」. Starting a
// recording destroys nothing. Owner's ruling ⑥ is 「按下的时候它就知道」: the user
// is being TOLD things, and 「cancel」 is the way out of being told.
//
// ⚠️ WHICH MEANS THE LINES ARE THE FEATURE. A prettier sheet that drops one of
// them is worse than no sheet, in the exact way the sign-out dialog's rewrite
// records for its own reassurance clauses.

import 'package:flutter/material.dart';

import '../audio/continuous_offer.dart';
import '../settings/app_strings.dart';
import 'tokens.dart';

class ContinuousSheetKeys {
  const ContinuousSheetKeys._();
  static const ValueKey<String> sheet = ValueKey<String>('continuous.sheet');
  static const ValueKey<String> cap = ValueKey<String>('continuous.sheet.cap');
  static const ValueKey<String> left = ValueKey<String>('continuous.sheet.left');

  /// B-2 only. Its own key, because 「the sheet warned about the balance」 and
  /// 「the sheet printed a balance」 are different claims and a shared key would
  /// let a test meaning the first be satisfied by the second.
  static const ValueKey<String> earlyStop =
      ValueKey<String>('continuous.sheet.earlyStop');
  static const ValueKey<String> noCancel =
      ValueKey<String>('continuous.sheet.noCancel');
  static const ValueKey<String> start = ValueKey<String>('continuous.sheet.start');
  static const ValueKey<String> cancel = ValueKey<String>('continuous.sheet.cancel');
}

/// Ask before a continuous recording starts. `true` only on an explicit press of
/// the go-ahead.
///
/// 🔴 EVERY OTHER WAY OUT IS A NO — the drag-down, the scrim tap, the system back
/// gesture — via the `?? false` on the result. Same rule `confirmDestructive`
/// states for itself: a dismissal is never consent. Here it matters for a
/// different reason: the sheet's own third line promises there is no cancel once
/// started, so the sheet is the last place that promise can still be kept.
///
/// ⚠️ REFUSES TO OPEN ON AN OFFER IT CANNOT DESCRIBE. Without a ceiling there is
/// no sentence to write and no timer to arm, and a sheet that opened anyway
/// would have to invent one of the two. Callers should not be able to reach this
/// (`ContinuousOffer.enabled` is false without a ceiling) — this is the
/// assertion that keeps 「should not」 from quietly becoming 「did」.
Future<bool> askToStartContinuous(
  BuildContext context, {
  required ContinuousOffer offer,
  required AppStrings strings,
}) async {
  final int? cap = offer.capMinutes;
  if (cap == null) return false;
  final bool? ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext ctx) =>
        _Sheet(offer: offer, strings: strings, cap: cap),
  );
  return ok ?? false;
}

class _Sheet extends StatelessWidget {
  const _Sheet({required this.offer, required this.strings, required this.cap});

  final ContinuousOffer offer;
  final AppStrings strings;
  final int cap;

  @override
  Widget build(BuildContext context) {
    final int? left = offer.remainingMinutes;
    final bool short = offer.boundedByBalance;
    return SafeArea(
      top: false,
      child: Container(
        key: ContinuousSheetKeys.sheet,
        margin: const EdgeInsets.all(12),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: BoxDecoration(
          color: FlowMicDockColors.panel,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: FlowMicDockColors.line),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: FlowMicDockColors.line,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              strings.continuousEntryTitle,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: FlowMicDockColors.ink,
              ),
            ),
            const SizedBox(height: 12),
            _Line(
              key: ContinuousSheetKeys.cap,
              icon: Icons.timer_outlined,
              text: strings.continuousSheetCap(cap),
            ),
            // §5-2 「读不到就不画」: a balance we could not read is a line that is
            // not there. It is NOT rendered as 0, and the sheet does not soften
            // into a vaguer sentence to cover for it — the ceiling line above is
            // still exactly true.
            if (left != null) ...<Widget>[
              const SizedBox(height: 8),
              _Line(
                key: ContinuousSheetKeys.left,
                icon: Icons.schedule,
                text: strings.continuousSheetLeft(left),
              ),
            ],
            if (short && left != null) ...<Widget>[
              const SizedBox(height: 8),
              _Line(
                key: ContinuousSheetKeys.earlyStop,
                icon: Icons.flag_outlined,
                text: strings.continuousSheetEarlyStop(left),
                accent: FlowMicDockColors.processing,
              ),
            ],
            const SizedBox(height: 8),
            _Line(
              key: ContinuousSheetKeys.noCancel,
              icon: Icons.error_outline,
              text: strings.continuousSheetNoCancel,
              accent: FlowMicDockColors.rec,
            ),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                Expanded(
                  child: _Button(
                    key: ContinuousSheetKeys.cancel,
                    label: strings.continuousSheetCancel,
                    onTap: () => Navigator.of(context).pop(false),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _Button(
                    key: ContinuousSheetKeys.start,
                    // The label changes with the warning above it. A button
                    // still reading 「start recording」 under 「this will be cut
                    // short」 reads as though the warning were decoration.
                    label: short
                        ? strings.continuousSheetStartAnyway
                        : strings.continuousSheetStart,
                    primary: true,
                    onTap: () => Navigator.of(context).pop(true),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One briefed fact: an icon and a sentence.
///
/// The icon is not decoration — owner 2026-08-01, 「颜色+图标组合，不能只靠颜色」.
/// Remove the accent colour and the three lines are still told apart.
class _Line extends StatelessWidget {
  const _Line({super.key, required this.icon, required this.text, this.accent});

  final IconData icon;
  final String text;
  final Color? accent;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Icon(icon, size: 16, color: accent ?? FlowMicDockColors.sub),
      const SizedBox(width: 9),
      Expanded(
        child: Text(
          text,
          style: TextStyle(
            fontSize: 12.5,
            height: 1.4,
            color: accent ?? FlowMicDockColors.ink,
          ),
        ),
      ),
    ],
  );
}

class _Button extends StatelessWidget {
  const _Button({
    super.key,
    required this.label,
    required this.onTap,
    this.primary = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool primary;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: primary ? FlowMicDockColors.pri : FlowMicDockColors.chipbg,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: primary ? FlowMicDockColors.onPri : FlowMicDockColors.ink,
          ),
        ),
      ),
    ),
  );
}
