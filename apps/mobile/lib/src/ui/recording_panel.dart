// SPEC-REF:
//   docs/ui-design/2026-08-13-plan-a-dock-and-edit-sheet-contract.md §5-1
//     (Recording strip: one row `[↑cancel · live amplitude bars · m:ss]`),
//     §4 A3, MD-3 (the honesty signals the mock dropped stay: link face when
//     and only when unhealthy, segment counter only when ≥2, silence = bars
//     at the floor — never fabricated motion)
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §2
//     "Recording strip" (WP8 VF-5: bars are ALWAYS `FlowMicDockColors.rec`,
//     including at the floor; link + segment faces restyle to small chipbg
//     pills, r99, padding h12/v4, text `sub` 11sp — appearance predicates
//     UNCHANGED)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.2 F-7 (silence turns grey) —
//     ⚠️ SUPERSEDED for COLOUR by VF-5: the mock's A-04 (silence) frame draws
//     its floor-height bars in the SAME rec red as A-03 (speaking) — never
//     grey — and the motion table says so explicitly: 「amplitude: … hugs
//     the floor with 4dp
//     micro-motion when silent, never fabricated」(floor-height micro-motion from the real low-level RMS,
//     never fabricated — a HEIGHT claim, not a colour claim). F-7's "reads as
//     silence" half survives through bar HEIGHT (the floor) and the
//     recNoSound sentence below; only the grey RECOLOUR dies.
//     🔴 DISCREPANCY ON RECORD: the visual-fidelity contract's own §2 prose
//     reads "…rec color, heights from the real amplitude window, 4dp floor
//     when silent — flat gray floor bars per §8-ter precedent…" — "rec color"
//     and "gray" in the same clause. The mock's CSS (`.ab{background:#DC2626}`,
//     no silence override) and every A-04/A-D2 frame (inline `background:
//     #DC2626`/`#F87171` on EVERY bar, floor height included) contradict the
//     "gray" half; §8-ter (the mechanics contract's real-device round) pins
//     bar HEIGHT going to the floor, never a colour — it is not a second
//     source for grey. Per the contract's own supremacy clause ("where this
//     document and the mock disagree, the mock wins — and file the
//     discrepancy"), the mock's CSS/frames win: bars stay `rec`-red always.
//
// PA-3: the recording panel restyled from the bordered card to Plan A′'s
// minimal in-dock strip. RED LINE (anti-façade): every indicator is fed by a
// REAL source or it is not drawn at all —
//   ⏱  local monotonic elapsed since audio:start (ChatController clock);
//   📊  the last N dBFS samples measured on-device from the captured PCM
//       (AudioCapture.amplitudeDb). Empty window = no samples yet → inert
//       floor bars, never a fake animation. WP8 VF-5: the floor bars stay
//       `rec` red (never grey, see SPEC-REF above) — HEIGHT is the only
//       honesty signal now, colour carries none;
//   📍  the highest segment_idx actually OBSERVED — and since PA-3 the chip
//       only appears from the SECOND segment on (a routine one-segment
//       utterance shows the mock's minimal strip; 「seg 1」 is noise);
//   📡  the FSM connection state, shown WHEN AND ONLY WHEN unhealthy (MD-3).
//       There is NO RTT probe on the mobile side, so the face is the link
//       STATE — never an invented latency number.
//
// ⚠️ Kept BEYOND the mock, deliberately (documented deviation, WP7 report):
// the silence sentence (recNoSound, owner-ruled wording Q5㋐ 2026-08-13) still
// renders beside the floor-height bars. The mock shows floor bars only;
// dropping an owner-ruled honesty sentence is not a call a restyle card gets
// to make.
//
// Pure presentation: every value is passed in, so the widget is testable with
// a plain WidgetTester and no session/FakeAsync chain.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'tokens.dart';

/// 📡 face. Mapped from ConnectionState by the caller (the panel stays free of
/// the signalling layer).
enum RecordingLink {
  /// connected — healthy: since PA-3 the strip shows NOTHING for this state
  /// (MD-3: the link face appears when and only when the link is not healthy).
  ok,

  /// connecting / reconnecting — amber; capture continues, chunks buffered.
  degraded,

  /// disconnected / error — red.
  down,
}

class RecordingPanel extends StatelessWidget {
  const RecordingPanel({
    super.key,
    required this.elapsed,
    required this.amplitudeWindow,
    required this.segmentCount,
    required this.link,
    required this.strings,
  });

  /// Time since audio:start (local clock).
  final Duration elapsed;

  /// Real dBFS samples, oldest → newest, at most [kBars]. EMPTY means no
  /// sample has arrived — the bars render at the floor and nothing is claimed.
  final List<double> amplitudeWindow;

  /// Soft segments observed on the wire. <2 ⇒ the chip is omitted (MD-3: the
  /// counter is a long-recording signal, not standing chrome).
  final int segmentCount;

  final RecordingLink link;
  final AppStrings strings;

  /// Plan A′ §5-1 geometry: 12 bars, 3px wide, 2px radius, 3px gap, 24px lane,
  /// 4dp floor.
  static const int kBars = 12;
  static const double _barW = 3;
  static const double _barGap = 3;
  static const double _waveH = 24;
  static const double _barMinH = 4;

  /// dBFS floor under which the meter reads as silence (F-7 「silence turns grey」).
  static const double kSilenceFloorDb = -55;

  /// dBFS window mapped onto the bar height.
  static const double _dbFloor = -60;

  /// §6.3 5-min hard cap: the timer turns amber on the approach so the
  /// auto-stop is not a surprise. The cap itself is enforced server-side.
  static const Duration kNearLimit = Duration(seconds: 270);

  bool get _hasSamples => amplitudeWindow.isNotEmpty;

  bool get _silent =>
      _hasSamples && amplitudeWindow.every((double db) => db <= kSilenceFloorDb);

  /// m:ss — the strip's own face (contract §5-1). Minutes unpadded: the mock's
  /// 「0:06」, not a wall-clock 「00:06」.
  static String formatElapsed(Duration d) {
    final int total = d.inSeconds < 0 ? 0 : d.inSeconds;
    final String ss = (total % 60).toString().padLeft(2, '0');
    return '${total ~/ 60}:$ss';
  }

  static double _level(double db) =>
      ((db - _dbFloor) / (0 - _dbFloor)).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final bool nearLimit = elapsed >= kNearLimit;
    final bool showMeta = link != RecordingLink.ok || segmentCount >= 2;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              // ↑ cancel hint — the strip's left slot. The gesture itself is
              // unchanged (swipe-up on the held PTT). WP8 VF-5 §2: sub, 11sp.
              //
              // 🔴 Parity-walk micro-fix: the mock paints `↑ 上滑取消` (↑ swipe
              // up to cancel)
              // (A-03/A-04/A-07: `<span>↑ 上滑取消</span>`); this strip was
              // rendering the bare frozen string with no glyph. Same rule as
              // ptt_bar.dart's `● ` prefix on the recording label — A LAYOUT
              // GLYPH, NOT A COPY EDIT: `AppStrings.recSwipeCancel` is
              // owner-frozen and stays byte-untouched, the arrow is
              // concatenated here for painting only.
              //
              // It stays OUT of the a11y label on purpose. This Text had NO
              // explicit Semantics before this fix, and a bare Text always
              // auto-generates a semantics node from its OWN painted string
              // regardless (confirmed precedent, ptt_bar_a11y_test.dart's
              // header: "the plain Text widget still auto-generates a
              // semantics node carrying its own string as the label, wrapper
              // or not") — so left alone, a screen reader would receive
              // "↑ 上滑取消" (↑ swipe up to cancel) verbatim and could try to pronounce the arrow,
              // exactly the risk ptt_bar.dart already documents for `●`.
              // `excludeSemantics: true` drops that auto-generated node and
              // substitutes the raw, unprefixed sentence as the ONE label
              // announced.
              Semantics(
                label: strings.recSwipeCancel,
                excludeSemantics: true,
                child: Text(
                  '↑ ${strings.recSwipeCancel}',
                  style: TextStyle(color: FlowMicDockColors.sub, fontSize: 11),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(child: _wave()),
              const SizedBox(width: 10),
              Text(
                formatElapsed(elapsed),
                style: TextStyle(
                  // WP8 VF-5 §2: rec red (was FlowMicColors.red — a
                  // byte-identical alias in dark, a different hex in light).
                  // The near-cap amber face is a DELIBERATE keep: the mock
                  // never draws this state, and it is an honesty face (the
                  // approach to the server-side hard cap), not a look.
                  color: nearLimit ? FlowMicColors.amber : FlowMicDockColors.rec,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  fontFeatures: const <FontFeature>[
                    FontFeature.tabularFigures(),
                  ],
                ),
              ),
            ],
          ),
          // MD-3: the honesty line — present when and only when there is
          // something honest to say (unhealthy link / a second segment).
          if (showMeta) ...<Widget>[
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: <Widget>[
                if (link != RecordingLink.ok) _linkFace(),
                if (link != RecordingLink.ok && segmentCount >= 2)
                  const SizedBox(width: 10),
                if (segmentCount >= 2)
                  _honestyChip(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(
                          Icons.layers_outlined,
                          size: 11,
                          color: FlowMicDockColors.sub,
                        ),
                        const SizedBox(width: 5),
                        Text(
                          strings.recSegments(segmentCount),
                          style: TextStyle(
                            color: FlowMicDockColors.sub,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  // ── 📊 amplitude ────────────────────────────────────────────────────────
  Widget _wave() {
    // The newest sample sits at the RIGHT-most bar; missing history pads the
    // left with floor bars (no data ⇒ no motion).
    final List<double?> slots = List<double?>.filled(kBars, null);
    final int take =
        amplitudeWindow.length < kBars ? amplitudeWindow.length : kBars;
    for (int i = 0; i < take; i++) {
      slots[kBars - take + i] = amplitudeWindow[amplitudeWindow.length - take + i];
    }
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        SizedBox(
          height: _waveH,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              for (int i = 0; i < kBars; i++) ...<Widget>[
                if (i > 0) const SizedBox(width: _barGap),
                Container(
                  width: _barW,
                  height: slots[i] == null
                      ? _barMinH
                      : _barMinH + (_waveH - _barMinH) * _level(slots[i]!),
                  decoration: BoxDecoration(
                    // WP8 VF-5: bars are ALWAYS the recording red — silence
                    // and no-data drop to the 4dp FLOOR HEIGHT (computed
                    // above, unchanged) but never recolour. See this file's
                    // header SPEC-REF for why the earlier grey face (F-7)
                    // died and the mock-vs-contract-prose discrepancy on it.
                    color: FlowMicDockColors.rec,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ],
            ],
          ),
        ),
        if (_silent) ...<Widget>[
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              strings.recNoSound,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: FlowMicDockColors.sub, fontSize: 10.5),
            ),
          ),
        ],
      ],
    );
  }

  // ── 📡 link — unhealthy faces only (MD-3) ───────────────────────────────
  Widget _linkFace() {
    final (Color dot, String label) = switch (link) {
      // Unreachable by construction (the caller gates on != ok), kept total so
      // a future face cannot fall through to an invented one.
      RecordingLink.ok => (FlowMicColors.green, strings.recLinkOk),
      RecordingLink.degraded => (FlowMicColors.amber, strings.recLinkDegraded),
      RecordingLink.down => (FlowMicColors.red, strings.recLinkDown),
    };
    // WP8 VF-5 §2: the container restyles to a small chip; the dot's colour
    // logic is UNCHANGED — it is the one thing in this chip that still
    // carries real, distinguishing state (ok/degraded/down), so it keeps its
    // three-way colour rather than folding into the flat chip look.
    return _honestyChip(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(color: FlowMicDockColors.sub, fontSize: 11),
          ),
        ],
      ),
    );
  }

  // ── honesty-face chip (WP8 VF-5 §2) ─────────────────────────────────────
  // Shared container for the link face and the segment-count face: the mock's
  // small-pill look — chipbg fill, r99, padding h12/v4. Both callers stay
  // exception-only (link: unhealthy only; segments: ≥2 only) — this helper
  // only changes what the face LOOKS like, never when it appears.
  Widget _honestyChip({required Widget child}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: FlowMicDockColors.chipbg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: child,
    );
  }
}
