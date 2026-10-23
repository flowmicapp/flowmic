// The 「+」 panel's send bar layout: 「N ticked」 (with its optional picture
// note), the optional 「with times」 chip, and the send button.
//
// WHY A LAYOUT OF ITS OWN: the bar used to be one fixed `Row` whose count was
// `Expanded`. At the larger text sizes, and in the longer languages even at
// the default size, the chip and the send button no longer fit beside each
// other: the count was squeezed to zero width and the send button was painted
// past the screen edge (measured in test/plus_panel_send_fit_test.dart, which
// pins every reading below in nine languages at 320 and 360 dp).
//
// THE RULE (same shape as the edit page footer that wraps when its labels
// cannot fit one row, NR-154 in the 2026-08-27 ledger):
//   1. Everything fits at its natural width ⇒ one row, exactly as before: the
//      count takes the space left over, the chip and the send button sit at
//      the right edge, all vertically centred.
//   2. Otherwise the bar wraps. Row 1 keeps the count and, when it fits there,
//      the chip at the right edge. The send button goes below, right-aligned
//      at its natural width (with the chip beside it if the chip could not
//      stay on row 1 but fits next to the send button; else on rows of their
//      own).
// Nothing is ever laid out narrower than its natural width when the bar has
// room for it, so no label is clipped and nothing is squeezed to zero.

import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// The four places a child of [PlusSendBarLayout] can go.
enum PlusSendBarSlot { count, note, chip, send }

/// Lays out the send bar: one row when it fits, wrapped rows when it does not.
class PlusSendBarLayout
    extends SlottedMultiChildRenderObjectWidget<PlusSendBarSlot, RenderBox> {
  const PlusSendBarLayout({
    super.key,
    required this.count,
    this.note,
    this.chip,
    required this.send,
  });

  /// The 「N ticked」 line. Its natural width is what decides the shape.
  final Widget count;

  /// The optional line under the count (drawn when a picture is ticked). It
  /// wraps inside whatever width the count gets and never forces a wrap.
  final Widget? note;

  /// The optional 「with times」 chip.
  final Widget? chip;

  /// The send button.
  final Widget send;

  @override
  Iterable<PlusSendBarSlot> get slots => PlusSendBarSlot.values;

  @override
  Widget? childForSlot(PlusSendBarSlot slot) => switch (slot) {
    PlusSendBarSlot.count => count,
    PlusSendBarSlot.note => note,
    PlusSendBarSlot.chip => chip,
    PlusSendBarSlot.send => send,
  };

  @override
  RenderPlusSendBar createRenderObject(BuildContext context) =>
      RenderPlusSendBar(textDirection: Directionality.of(context));

  @override
  void updateRenderObject(
    BuildContext context,
    RenderPlusSendBar renderObject,
  ) {
    renderObject.textDirection = Directionality.of(context);
  }
}

/// The render object behind [PlusSendBarLayout].
class RenderPlusSendBar extends RenderBox
    with SlottedContainerRenderObjectMixin<PlusSendBarSlot, RenderBox> {
  RenderPlusSendBar({required TextDirection textDirection})
    : _textDirection = textDirection;

  /// Gap between the count and whatever follows it on the same row.
  static const double gapAfterCount = 10;

  /// Gap between the chip and the send button when they share a row.
  static const double gapChipSend = 8;

  /// Gap between the count line and the note under it.
  static const double gapNote = 2;

  /// Gap between wrapped rows.
  static const double gapRow = 8;

  TextDirection get textDirection => _textDirection;
  TextDirection _textDirection;
  set textDirection(TextDirection value) {
    if (_textDirection == value) return;
    _textDirection = value;
    markNeedsLayout();
  }

  RenderBox? get _count => childForSlot(PlusSendBarSlot.count);
  RenderBox? get _note => childForSlot(PlusSendBarSlot.note);
  RenderBox? get _chip => childForSlot(PlusSendBarSlot.chip);
  RenderBox? get _send => childForSlot(PlusSendBarSlot.send);

  double _natural(RenderBox? b) =>
      b == null ? 0 : b.getMaxIntrinsicWidth(double.infinity);

  /// The width the bar needs to stay on one row.
  double get _oneRowWidth {
    final RenderBox? chip = _chip;
    return _natural(_count) +
        gapAfterCount +
        (chip == null ? 0 : _natural(chip) + gapChipSend) +
        _natural(_send);
  }

  @override
  double computeMinIntrinsicWidth(double height) => <double>[
    _count?.getMinIntrinsicWidth(height) ?? 0,
    _note?.getMinIntrinsicWidth(height) ?? 0,
    _natural(_chip),
    _natural(_send),
  ].reduce(math.max);

  @override
  double computeMaxIntrinsicWidth(double height) => _oneRowWidth;

  @override
  double computeMinIntrinsicHeight(double width) =>
      _plan(BoxConstraints(maxWidth: width), dry: true).height;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      _plan(BoxConstraints(maxWidth: width), dry: true).height;

  @override
  Size computeDryLayout(covariant BoxConstraints constraints) =>
      _plan(constraints, dry: true);

  @override
  void performLayout() {
    size = _plan(constraints, dry: false);
  }

  /// Measures (and, unless [dry], lays out and positions) every child for the
  /// given constraints, returning the bar's size.
  Size _plan(BoxConstraints constraints, {required bool dry}) {
    final double w = constraints.maxWidth.isFinite
        ? constraints.maxWidth
        : _oneRowWidth;
    final RenderBox? count = _count;
    final RenderBox? note = _note;
    final RenderBox? chip = _chip;
    final RenderBox? send = _send;

    Size measure(RenderBox? b, double maxWidth) {
      if (b == null) return Size.zero;
      final BoxConstraints c = BoxConstraints(maxWidth: math.max(0, maxWidth));
      if (dry) return b.getDryLayout(c);
      b.layout(c, parentUsesSize: true);
      return b.size;
    }

    void place(RenderBox? b, double x, double y) {
      if (dry || b == null) return;
      final double dx = textDirection == TextDirection.rtl
          ? w - x - b.size.width
          : x;
      (b.parentData! as BoxParentData).offset = Offset(dx, y);
    }

    // The trailing controls at their natural widths (never wider than the bar).
    final Size chipSize = measure(chip, math.min(_natural(chip), w));
    final Size sendSize = measure(send, math.min(_natural(send), w));

    // Which trailing controls share row 1 with the count.
    final bool oneRow = _oneRowWidth <= w;
    final bool chipOnFirstRow =
        chip != null &&
        (oneRow || _natural(count) + gapAfterCount + chipSize.width <= w);
    final List<(RenderBox, Size)> firstRow = <(RenderBox, Size)>[
      if (chipOnFirstRow) (chip, chipSize),
      if (oneRow && send != null) (send, sendSize),
    ];
    final List<(RenderBox, Size)> rest = <(RenderBox, Size)>[
      if (chip != null && !chipOnFirstRow) (chip, chipSize),
      if (!oneRow && send != null) (send, sendSize),
    ];

    double trailingWidth(List<(RenderBox, Size)> items) {
      double sum = 0;
      for (int i = 0; i < items.length; i++) {
        sum += items[i].$2.width + (i == 0 ? 0 : gapChipSend);
      }
      return sum;
    }

    // Row 1: the count block takes what the trailing controls leave over.
    final double trailing1 = trailingWidth(firstRow);
    final double leftWidth = firstRow.isEmpty
        ? w
        : w - gapAfterCount - trailing1;
    final Size countSize = measure(count, leftWidth);
    final Size noteSize = measure(note, leftWidth);
    final double leftHeight =
        countSize.height + (note == null ? 0 : gapNote + noteSize.height);

    double rowHeight(List<(RenderBox, Size)> items, double floor) => items.fold(
      floor,
      (double h, (RenderBox, Size) e) => math.max(h, e.$2.height),
    );

    // Lays a group of trailing controls right-aligned on a row at [y].
    void placeTrailing(List<(RenderBox, Size)> items, double y, double h) {
      double x = w - trailingWidth(items);
      for (final (RenderBox b, Size s) in items) {
        place(b, x, y + (h - s.height) / 2);
        x += s.width + gapChipSend;
      }
    }

    final double h1 = rowHeight(firstRow, leftHeight);
    final double leftTop = (h1 - leftHeight) / 2;
    place(count, 0, leftTop);
    place(note, 0, leftTop + countSize.height + gapNote);
    placeTrailing(firstRow, 0, h1);

    double y = h1;
    if (rest.isNotEmpty) {
      // The leftovers share one row when they fit side by side, else each
      // gets a row of its own.
      final List<List<(RenderBox, Size)>> rows = trailingWidth(rest) <= w
          ? <List<(RenderBox, Size)>>[rest]
          : <List<(RenderBox, Size)>>[
              for (final (RenderBox, Size) e in rest) <(RenderBox, Size)>[e],
            ];
      for (final List<(RenderBox, Size)> row in rows) {
        y += gapRow;
        final double h = rowHeight(row, 0);
        placeTrailing(row, y, h);
        y += h;
      }
    }
    return constraints.constrain(Size(w, y));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    for (final RenderBox child in children) {
      context.paintChild(
        child,
        offset + (child.parentData! as BoxParentData).offset,
      );
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    for (final RenderBox child in children.toList().reversed) {
      final Offset at = (child.parentData! as BoxParentData).offset;
      final bool hit = result.addWithPaintOffset(
        offset: at,
        position: position,
        hitTest: (BoxHitTestResult r, Offset p) =>
            child.hitTest(r, position: p),
      );
      if (hit) return true;
    }
    return false;
  }
}
