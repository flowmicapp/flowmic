// SPEC-REF:
//   docs/ui-design/2026-08-29-continuous-recording-demo.html — cell C-1
//     (`.recbar` / `.live-dot` / `.bars` / `.clk` / `.segchip`, and `.ptt.stop`)
//   task unit §5-3 (countdown not stopwatch, real amplitude, stop and no
//     cancel), §5-9 (a screen that may stay lit for half an hour), §6 C1
//   apps/mobile/lib/src/ui/recording_panel.dart (RecordingAmplitudeBars — the
//     one meter, shared rather than reproduced)
//
// The in-progress face of a continuous recording. The user's finger left the
// screen minutes ago; everything here is something we say without being asked,
// and the single control is 「stop」.
//
// ── 🔴 A COUNTDOWN, AND THE STOPWATCH IS THE BUG IT AVOIDS ──────────────────
//
// `RecordingPanel` — the ordinary push-to-talk strip — shows ELAPSED, which is
// the right answer to 「how long have I been holding this」. It is the wrong
// answer to the only question anybody asks in minute nineteen of a meeting, and
// a face that made one clock answer both would leave the subtraction to the
// user at exactly the moment they are not doing arithmetic.
//
// ⇒ this is a separate widget rather than a mode of that one. Two more of its
// behaviours would have had to be switched off anyway (the swipe-up cancel hint
// — there IS no cancel here — and an amber warning wired to the server's
// five-minute utterance cap, which is not the ceiling in force), and a widget
// with three 「except when」 branches is a widget that answers two questions.
//
// ── 🔴 NOTHING HERE IS DRAWN WITHOUT A SOURCE ───────────────────────────────
//
//   · the meter is the REAL dBFS window (§5-3 「不许伪造」), through the shared
//     [RecordingAmplitudeBars]; an empty window holds still rather than
//     animating;
//   · the segment count is the server's own finalised-slot count
//     (`SegmentBuffer.finalizedCount`), so 「natural segments」 is its claim and
//     not ours;
//   · the screen note is drawn ONLY when the platform actually granted the hold
//     (`ScreenWakeHold.isHeld`), whose own doc asks for exactly this check.

import 'package:flutter/widgets.dart';

import '../settings/app_strings.dart';
import 'recording_panel.dart' show RecordingAmplitudeBars, RecordingPanel;
import 'tokens.dart';

class ContinuousLiveKeys {
  const ContinuousLiveKeys._();
  static const ValueKey<String> bar = ValueKey<String>('continuous.live');
  static const ValueKey<String> clock = ValueKey<String>('continuous.live.clock');
  static const ValueKey<String> segments =
      ValueKey<String>('continuous.live.segments');
  static const ValueKey<String> screenOn =
      ValueKey<String>('continuous.live.screenOn');
  static const ValueKey<String> stop = ValueKey<String>('continuous.live.stop');
  static const ValueKey<String> caption =
      ValueKey<String>('continuous.live.caption');
}

class ContinuousLiveBar extends StatelessWidget {
  const ContinuousLiveBar({
    super.key,
    required this.remaining,
    required this.amplitudeWindow,
    required this.segmentCount,
    required this.screenHeld,
    required this.strings,
    required this.onStop,
  });

  /// How much of this sitting is left. Clamped at zero for display; the stop
  /// itself is the ceiling timer's job, never this widget's.
  final Duration remaining;

  /// Real dBFS samples, oldest → newest.
  final List<double> amplitudeWindow;

  /// Segments the SERVER has finalised so far.
  final int segmentCount;

  /// Is the platform actually holding the screen? False when we asked and were
  /// refused — in which case the note is not drawn, because it would be false.
  final bool screenHeld;

  final AppStrings strings;

  /// Ends the recording. There is deliberately no cancel counterpart (CR-D ③,
  /// owner-approved): every finished segment is already saved, so a cancel
  /// button could not undo what it appeared to offer.
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final Duration left = remaining.isNegative ? Duration.zero : remaining;
    return Column(
      key: ContinuousLiveKeys.bar,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
          decoration: BoxDecoration(
            color: FlowMicDockColors.rec.withValues(alpha: 0.05),
            border: Border.all(color: FlowMicDockColors.rec.withValues(alpha: 0.3)),
            borderRadius: BorderRadius.circular(13),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: FlowMicDockColors.rec,
                    ),
                  ),
                  const SizedBox(width: 7),
                  Text(
                    strings.continuousLiveLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: FlowMicDockColors.rec,
                    ),
                  ),
                  // The meter takes whatever the two ends leave it, and may be
                  // squeezed to nothing on a narrow dock — it is the one thing
                  // here that says nothing in words, so it is the one thing
                  // that may go.
                  Expanded(
                    child: Center(
                      child: RecordingAmplitudeBars(
                        amplitudeWindow: amplitudeWindow,
                      ),
                    ),
                  ),
                  const SizedBox(width: 7),
                  Text(
                    // ⚠️ Formatted by `RecordingPanel.formatElapsed`, which is a
                    // pure Duration → m:ss and named for its first caller. Used
                    // rather than copied: two clock formatters in one dock is
                    // how 「0:06」 and 「00:06」 end up on adjacent rows.
                    strings.continuousRemaining(RecordingPanel.formatElapsed(left)),
                    key: ContinuousLiveKeys.clock,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: FlowMicDockColors.rec,
                      fontFeatures: const <FontFeature>[
                        FontFeature.tabularFigures(),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: <Widget>[
                  _Chip(
                    key: ContinuousLiveKeys.segments,
                    label: strings.continuousSegments(segmentCount),
                  ),
                  if (screenHeld) ...<Widget>[
                    const SizedBox(width: 6),
                    Flexible(
                      child: _Chip(
                        key: ContinuousLiveKeys.screenOn,
                        label: strings.continuousScreenOn,
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 9),
        // `.ptt.stop`, flat rather than the mock's gradient — WP8 VF-2 deleted
        // every gradient in this dock, and §5-9 has an additional reason to keep
        // a face that may be lit for half an hour off its brightest setting.
        Semantics(
          button: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onStop,
            child: Container(
              key: ContinuousLiveKeys.stop,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: FlowMicDockColors.rec,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                strings.continuousStop,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1,
                  color: FlowMicDockColors.onPri,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          strings.continuousLiveCaption,
          key: ContinuousLiveKeys.caption,
          textAlign: TextAlign.center,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 10.5, color: FlowMicDockColors.sub),
        ),
      ],
    );
  }
}

/// `.segchip` — a small pill for one standing fact.
class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: FlowMicDockColors.chipbg,
      borderRadius: BorderRadius.circular(99),
    ),
    child: Text(
      label,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontSize: 9.5,
        fontWeight: FontWeight.w600,
        color: FlowMicDockColors.sub,
      ),
    ),
  );
}
