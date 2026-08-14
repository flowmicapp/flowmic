// SPEC-REF:
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §2 (PTT bar
//     "mic glyph 17 leading"; edit-sheet append "mic 15").
//   docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html — every
//     Plan A′ frame draws the SAME inline SVG mic (viewBox 24): a filled
//     capsule <rect x=9 y=2.5 w=6 h=12 rx=3>, a stroke-2 round-capped pickup
//     arc <path d="M6 12a6 6 0 0 0 12 0">, and a stroke-2 stem
//     <path d="M12 18.5v3.5">.
//
// WP8 replaces Material's `Icons.mic_none` on the Plan A′ surfaces with this
// 1:1 transcription of the mock's own glyph, so the dock and the sheet render
// the DESIGN's microphone rather than a near-miss from the icon font. One
// painter, two consumers (PttBar @17, SheetAppendButton @15) — a second
// hand-drawn mic anywhere is a bug, point it here instead.

import 'package:flutter/widgets.dart';

/// The Plan A′ mock's microphone glyph at [size] logical pixels, tinted
/// [color]. Stateless and box-sized exactly [size]×[size], like an [Icon].
class MicGlyph extends StatelessWidget {
  const MicGlyph({super.key, required this.size, required this.color});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _MicGlyphPainter(color: color)),
    );
  }
}

class _MicGlyphPainter extends CustomPainter {
  const _MicGlyphPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    // The mock SVG uses a 24×24 viewBox; scale every coordinate uniformly.
    final double u = size.width / 24;

    final Paint fill = Paint()
      ..style = PaintingStyle.fill
      ..color = color;
    final Paint stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2 * u
      ..strokeCap = StrokeCap.round
      ..color = color;

    // <rect x="9" y="2.5" width="6" height="12" rx="3"> — the capsule.
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(9 * u, 2.5 * u, 6 * u, 12 * u),
        Radius.circular(3 * u),
      ),
      fill,
    );

    // <path d="M6 12a6 6 0 0 0 12 0"> — the pickup arc: a semicircle of
    // radius 6 from (6,12) to (18,12), sweeping through the bottom.
    canvas.drawArc(
      Rect.fromCircle(center: Offset(12 * u, 12 * u), radius: 6 * u),
      0, // 3 o'clock
      3.141592653589793, // sweep π through 6 o'clock to 9 o'clock
      false,
      stroke,
    );

    // <path d="M12 18.5v3.5"> — the stem.
    canvas.drawLine(Offset(12 * u, 18.5 * u), Offset(12 * u, 22 * u), stroke);
  }

  @override
  bool shouldRepaint(_MicGlyphPainter oldDelegate) =>
      oldDelegate.color != color;
}
