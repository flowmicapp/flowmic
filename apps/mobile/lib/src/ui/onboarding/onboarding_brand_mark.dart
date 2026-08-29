// SPEC-REF:
//   docs/ui-design/2026-08-27-nr6-onboarding-visual-upgrade-design.md §3.2
//     (the shared 「phone + two-tone shoulder arcs」 figure)
//   docs/ui-design/brand/BRAND.md §LOGO 2.0 (the motif this distils)
//
// 🔴 WHAT THIS IS AND, JUST AS IMPORTANTLY, WHAT IT IS NOT.
// It is a distillation of the BRAND.md 2.0 mark's GEOMETRY — a phone silhouette
// with two two-tone arcs rising from its shoulders — redrawn at illustration
// scale. It is NOT the brand asset: those live as SVG under docs/ui-design/brand
// with their own build.py pipeline, are proportioned for a square single-colour
// app-icon field, and would need `flutter_svg` plus an asset pipeline to land
// here. Nor is it [MicGlyph], which is the Plan A′ dock's microphone and belongs
// to a different visual system entirely (design §1 row 17).
//
// ⚠️ NOTHING HERE IS TAPPABLE, AND THAT IS A MECHANICAL CONSTRAINT, not taste.
// `onboarding_first_run_test.dart:474-505` counts `find.byType(InkWell)` per
// page and pins the census at `<int>[2, 3, 3]`, BY TYPE — an `IgnorePointer`
// wrapper does not remove an `InkWell` from the render tree. Every figure in the
// guide is therefore drawn with `CustomPaint`/`Container`/`Text` and never with
// anything that builds an `InkWell` underneath.
//
// Colours come from `FlowMicColors.*` getters, never from literals, which is
// what makes the light/dark pair free (design §3.2's last bullet, and
// tokens.dart's own rule 「the widgets must not invent colours」).

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../tokens.dart';

/// How much of the mark to draw. BRAND.md's micro tier drops detail rather than
/// scaling the whole figure down until it turns to mush (:15), and the guide has
/// exactly that split: page 1 shows the mark at full size, page 2 shows a small
/// one inside a device card where two concentric arcs would read as noise.
enum PhoneMarkDetail {
  /// Phone + both arcs per shoulder (inner brand, outer teal).
  full,

  /// Phone + the inner arc only.
  compact,
}

/// The mark, sized to fit whatever box it is given.
class PhoneMark extends StatelessWidget {
  const PhoneMark({
    super.key,
    required this.width,
    required this.height,
    this.detail = PhoneMarkDetail.full,
  });

  final double width;
  final double height;
  final PhoneMarkDetail detail;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: width,
    height: height,
    child: CustomPaint(
      painter: PhoneMarkPainter(
        detail: detail,
        outline: FlowMicColors.line,
        innerArc: FlowMicColors.brand,
        outerArc: FlowMicColors.teal,
      ),
    ),
  );
}

/// The figure itself.
///
/// 🔴 THE THREE INKS ARE CONSTRUCTOR ARGUMENTS, NOT READS OF
/// `FlowMicColors` FROM INSIDE `paint`. A `CustomPainter` is compared with
/// `shouldRepaint`, so a painter that resolved the theme inside `paint` would be
/// equal to its predecessor across a light/dark flip and simply not repaint.
/// Passing them in also gives the theme test something to READ (design §11 row
/// 2 asserts the painter's fields, not pixels).
///
/// ── PROPORTIONS (design §3.2), all against ONE reference length `h` ──────────
///   phone body   : 0.42h wide × 0.72h tall, corner radius 0.10 × width,
///                  1.5dp stroke in [outline]
///   inner arc    : radius 0.18h, 2.5dp stroke in [innerArc]
///   outer arc    : radius 0.30h, 2.5dp stroke in [outerArc]
///   both arcs    : centred on the phone's two top corners («shoulders»),
///                  sweeping 200° outward, mirrored left/right
///
/// 🔴 FILED DEVIATION FROM THE DESIGN, and it is arithmetic rather than taste.
/// §3.2 writes every ratio against 「canvasHeight」 and §3.3 then puts the figure
/// in a 56×96 box. Those two do not fit each other: at h=96 the outer arcs reach
/// 0.21h+0.30h = 0.51h ≈ 49dp either side of centre, i.e. a 98dp-wide figure
/// inside a 56dp box, which would have painted straight over the arrow and the
/// PC card beside it (a `CustomPaint` does not clip). The RATIOS are kept
/// verbatim; the reference length is derived so the whole figure fits the box it
/// is handed — `h = min(height, width / 1.02)`, where 1.02 is exactly
/// `0.42 + 2 × 0.30`. Recorded in the design doc's §3.2 as a dated correction.
class PhoneMarkPainter extends CustomPainter {
  const PhoneMarkPainter({
    required this.detail,
    required this.outline,
    required this.innerArc,
    required this.outerArc,
  });

  final PhoneMarkDetail detail;
  final Color outline;
  final Color innerArc;
  final Color outerArc;

  /// `0.42 + 2 × 0.30` — the figure's full width as a multiple of `h`.
  static const double _widthPerH = 1.02;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final double h = math.min(size.height, size.width / _widthPerH);
    final double bodyW = 0.42 * h;
    final double bodyH = 0.72 * h;
    final Offset centre = Offset(size.width / 2, size.height / 2);
    final Rect body = Rect.fromCenter(
      center: centre,
      width: bodyW,
      height: bodyH,
    );

    final Paint stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    canvas.drawRRect(
      RRect.fromRectAndRadius(body, Radius.circular(0.10 * bodyW)),
      stroke
        ..color = outline
        ..strokeWidth = 1.5,
    );

    // The two shoulders. Sweeping outward means the right shoulder's arc opens
    // to the right and the left one mirrors it, so the pair reads as sound
    // leaving the device rather than as a circle drawn around it.
    for (final bool right in <bool>[false, true]) {
      final Offset shoulder = Offset(
        right ? body.right : body.left,
        body.top,
      );
      // Right: -100° → +100°. Left: the mirror, 80° → 280°.
      final double start = right ? -100 : 80;
      _arc(canvas, shoulder, 0.18 * h, start, innerArc, stroke);
      if (detail == PhoneMarkDetail.full) {
        _arc(canvas, shoulder, 0.30 * h, start, outerArc, stroke);
      }
    }
  }

  void _arc(
    Canvas canvas,
    Offset centre,
    double radius,
    double startDegrees,
    Color color,
    Paint stroke,
  ) {
    const double toRad = math.pi / 180;
    canvas.drawArc(
      Rect.fromCircle(center: centre, radius: radius),
      startDegrees * toRad,
      200 * toRad,
      false,
      stroke
        ..color = color
        ..strokeWidth = 2.5,
    );
  }

  @override
  bool shouldRepaint(PhoneMarkPainter old) =>
      old.detail != detail ||
      old.outline != outline ||
      old.innerArc != innerArc ||
      old.outerArc != outerArc;
}
