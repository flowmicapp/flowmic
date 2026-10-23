// CARD-UI (owner 2026-10-14) — a transcript card's meta: two lines, neither
// of which wraps, at the app's text sizes up to 1.15.
//
// The owner's words: the card's first line read 「Delivered」 and then nothing,
// the PC instance had fallen to the line below, that line no longer fitted and
// wrapped again — three lines. The meta used to be ONE `Wrap`, and a `Wrap`
// moves a whole child to the next run whenever it does not fit, so a long PC
// name took the space of a full line instead of giving way.
//
// The owner's layout (2026-10-14, second pass): line 1 = delivery state + PC
// instance; line 2 = the polish state, the character count and the duration.
// Time, duration, character count, polish state and delivery state are always
// shown in full. The rule for the text sizes (MAIN 2026-10-14, written down in
// docs/strategy/2026-10-14-card-meta-two-lines-rule.md): up to 1.15 those
// facts stay on their two lines, unwrapped; above 1.15 a fact may move to a
// third line or wrap inside itself, but no fact is ever hidden, cut or
// ellipsized. `ChatMessageTile` builds the lines; this file knows these kinds:
//
//   · FIXED — one of those facts, on its own line at its natural width. It
//     may carry a SHORT form ([MetaShortenable]): a complete, shorter wording
//     of the same fact, used only when the full one does not fit (the caller
//     keeps the full words in its tooltip and semantics label). A fixed item
//     that does not fit after another item on its line moves to the overflow
//     (third) line; one that does not fit even alone breaks inside itself.
//   · FACT ([MetaFact]) — a fact the row carries besides those five (the
//     failure code, 「Resent 23:59」, the picture note): on its own line when
//     it fits, else on the other line (ahead of the PC instance), else on the
//     overflow line; never hidden, never cut.
//   · FLEXIBLE ([MetaFlexible]) — the PC instance: gets what the others
//     leave, single-line and ellipsized. Below its minimum it is hidden from
//     sight — but laid out at its own width and kept in the semantics tree,
//     so a screen reader still reads it, after line 1's other items (pinned
//     by chat_message_meta_a11y_test.dart C1). With `keep` (the history page,
//     where a failed row must say WHICH computer) it is never hidden: its
//     minimum is reserved on its own line, or on the next one.
//   · OPTIONAL ([MetaOptional]) — not a fact (selection tick, mode badge,
//     Resend, edited mark, favourite star). Never cut: it goes, in this
//     order, to the first place that holds it whole — its own line in full,
//     the other line in full, its own line in its COMPACT form, the other line
//     in its compact form. The compact form is an icon whose screen-reader
//     label carries the full words. When that leaves one without a place, the
//     pass is re-run holding the fewest items (later ones first) to their
//     short / compact forms; what still has no place goes to the overflow
//     line, never hidden and never painted over a fact.
//   · the LINE BREAK ([MetaLineBreak]) between the two lines' children.
//
// The lines are ONE render object because where an item goes on one line
// depends on what the other line has left. Why not `Row` + `Flexible`: a
// `Row` gives non-flex children UNBOUNDED width, so when the fixed items alone
// are wider than the card it throws a RenderFlex overflow and clips silently.
//
// Tap targets: an icon form is drawn small but should be hit as 48 × 48 dp.
// [MetaTapTarget] gives its child a 48 dp semantic rect, and the meta block
// routes a tap on its own empty space inside that area to it — never a tap
// on a neighbouring item or outside the block (see `hitTestChildren`).

import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

part 'chat_message_meta_layout.dart';

enum _Kind {
  fixed,
  fixedShort,
  fact,
  flexible,
  optionalFull,
  optionalCompact,
  lineBreak,
}

/// Which form a two-form item was painted in.
enum MetaForm { full, compact }

class _KindData extends ParentDataWidget<_MetaParentData> {
  const _KindData({
    required this.kind,
    this.group = -1,
    this.minWidth = 0,
    this.leads = false,
    this.keep = false,
    required super.child,
  });
  final _Kind kind;
  final int group;
  final double minWidth;
  final bool leads;
  final bool keep;

  @override
  void applyParentData(RenderObject renderObject) {
    final _MetaParentData data = renderObject.parentData! as _MetaParentData;
    if (data.kind != kind ||
        data.group != group ||
        data.minWidth != minWidth ||
        data.leads != leads ||
        data.keep != keep) {
      data
        ..kind = kind
        ..group = group
        ..minWidth = minWidth
        ..leads = leads
        ..keep = keep;
      renderObject.parent?.markNeedsLayout();
    }
  }

  @override
  Type get debugTypicalAncestorWidgetClass => MetaLines;
}

/// The one item that gives way (single-line, ellipsized). See the header.
class MetaFlexible extends StatelessWidget {
  const MetaFlexible({
    super.key,
    required this.child,
    this.minWidth = 12,
    this.keep = false,
  });
  final Widget child;

  /// Below this width it is not painted squeezed: under one glyph an
  /// ellipsis is noise, and a chip with a fixed icon and padding would
  /// overflow inside itself.
  final double minWidth;

  /// Never hidden: [minWidth] is reserved on its line, or on the next one.
  final bool keep;

  @override
  Widget build(BuildContext context) => child;
}

/// An item that is not a fact (see the file header): placed whole on
/// whichever line has room, in [child]'s full form first and [compact]'s form
/// only when neither line can hold the full one.
class MetaOptional extends StatelessWidget {
  const MetaOptional({
    super.key,
    required this.child,
    this.compact,
    this.leads = false,
  });
  final Widget child;

  /// When it has to move to the other line, it goes FIRST on that line (the
  /// selection tick: it marks the card, so it stays at a line's start).
  final bool leads;

  /// The icon form. Its semantics label must carry the same words as [child].
  final Widget? compact;

  @override
  Widget build(BuildContext context) => child;
}

/// A fixed item with a shorter wording of the same fact (see the file header).
class MetaShortenable extends StatelessWidget {
  const MetaShortenable({super.key, required this.child, required this.short});
  final Widget child;
  final Widget short;
  @override
  Widget build(BuildContext context) => child;
}

/// A fact that may move to the overflow line but is never hidden or cut
/// (see the file header). Its text must not set `maxLines` or an ellipsis.
class MetaFact extends StatelessWidget {
  const MetaFact({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => child;
}

/// Separates line 1's children from line 2's.
class MetaLineBreak extends StatelessWidget {
  const MetaLineBreak({super.key});
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

/// The meta lines (see the file header).
class MetaLines extends MultiChildRenderObjectWidget {
  MetaLines({
    super.key,
    required List<Widget> children,
    this.spacing = 7,
    this.lineGap = 4,
  }) : super(children: _expand(children));

  static List<Widget> _expand(List<Widget> children) {
    final List<Widget> out = <Widget>[];
    int group = 0;
    for (final Widget c in children) {
      switch (c) {
        case MetaFlexible(:final double minWidth, :final bool keep):
          out.add(
            _KindData(
              kind: _Kind.flexible,
              minWidth: minWidth,
              keep: keep,
              child: c,
            ),
          );
        case MetaLineBreak():
          out.add(_KindData(kind: _Kind.lineBreak, child: c));
        case MetaFact(:final Widget child):
          out.add(_KindData(kind: _Kind.fact, child: child));
        case MetaShortenable(:final Widget child, :final Widget short):
          out
            ..add(_KindData(kind: _Kind.fixed, group: group, child: child))
            ..add(
              _KindData(kind: _Kind.fixedShort, group: group, child: short),
            );
          group++;
        case MetaOptional(
          :final Widget child,
          :final Widget? compact,
          :final bool leads,
        ):
          out.add(
            _KindData(
              kind: _Kind.optionalFull,
              group: group,
              leads: leads,
              child: child,
            ),
          );
          if (compact != null) {
            out.add(
              _KindData(
                kind: _Kind.optionalCompact,
                group: group,
                child: compact,
              ),
            );
          }
          group++;
        default:
          out.add(_KindData(kind: _Kind.fixed, child: c));
      }
    }
    return out;
  }

  /// Gap between two VISIBLE items on a line.
  final double spacing;

  /// Gap between two lines.
  final double lineGap;

  @override
  RenderMetaLines createRenderObject(BuildContext context) =>
      RenderMetaLines(spacing: spacing, lineGap: lineGap);

  @override
  void updateRenderObject(BuildContext context, RenderMetaLines renderObject) {
    renderObject
      ..spacing = spacing
      ..lineGap = lineGap;
  }
}

class _MetaParentData extends ContainerBoxParentData<RenderBox> {
  _Kind kind = _Kind.fixed;

  /// Two-form items: both children of one item share it.
  int group = -1;

  /// Flexible items: not painted below this width.
  double minWidth = 0;

  /// Flexible items: never hidden.
  bool keep = false;

  /// Optional items: first on the other line when moved there.
  bool leads = false;

  /// Which line the child sits on in the SOURCE (0 or 1).
  int home = 0;

  /// 0 = line 1, 1 = line 2, 2 = the overflow line, -1 = not painted (a
  /// hidden flexible item, the unused form of a two-form item, the break).
  int line = -1;
}

/// The render half of [MetaLines]. Public so tests can read the per-line
/// facts off the real tree.
class RenderMetaLines extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _MetaParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _MetaParentData> {
  RenderMetaLines({double spacing = 7, double lineGap = 4})
    : _spacing = spacing,
      _lineGap = lineGap;

  double _spacing;
  double get spacing => _spacing;
  set spacing(double v) {
    if (v == _spacing) return;
    _spacing = v;
    markNeedsLayout();
  }

  double _lineGap;
  double get lineGap => _lineGap;
  set lineGap(double v) {
    if (v == _lineGap) return;
    _lineGap = v;
    markNeedsLayout();
  }

  /// Per line, on the last layout: did a FIXED item not fit on it (it then
  /// moved to the overflow line, or broke inside itself as the line's only
  /// item)?
  final List<bool> fixedOverflow = <bool>[false, false];

  /// Facts ([MetaFact]) that went to the overflow line on the last layout.
  int factsMoved = 0;

  /// Optional items that neither line could hold on the last layout (they
  /// went to the overflow line).
  int optionalOverflow = 0;

  /// Per line, on the last layout: the width its fixed items asked for
  /// (natural widths and gaps), before any other item.
  final List<double> fixedDemand = <double>[0, 0];

  /// How many lines were painted on the last layout (1 to 3).
  int lineCount = 1;

  /// Which line [child] (a direct child) was painted on: 0, 1, 2, or -1.
  int lineOf(RenderBox child) => _pd(child).line;

  /// Whether [child] (a direct child) is the flexible item.
  bool isFlexible(RenderBox child) => _pd(child).kind == _Kind.flexible;

  /// Whether [child] (a direct child) is a fact: fixed, its short form, or a
  /// [MetaFact].
  bool isFact(RenderBox child) => switch (_pd(child).kind) {
    _Kind.fixed || _Kind.fixedShort || _Kind.fact => true,
    _ => false,
  };

  /// The form of [child] if it is one form of a two-form item, else null.
  MetaForm? formOf(RenderBox child) => switch (_pd(child).kind) {
    _Kind.optionalFull => MetaForm.full,
    _Kind.optionalCompact || _Kind.fixedShort => MetaForm.compact,
    _Kind.fixed => _pd(child).group >= 0 ? MetaForm.full : null,
    _ => null,
  };

  /// The two-form item [child] belongs to (shared by its forms), or -1.
  int groupOf(RenderBox child) => _pd(child).group;

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _MetaParentData) {
      child.parentData = _MetaParentData();
    }
  }

  Iterable<RenderBox> get _children sync* {
    RenderBox? c = firstChild;
    while (c != null) {
      yield c;
      c = childAfter(c);
    }
  }

  _MetaParentData _pd(RenderBox c) => c.parentData! as _MetaParentData;

  @override
  double computeMinIntrinsicWidth(double height) =>
      computeMaxIntrinsicWidth(height);

  @override
  double computeMaxIntrinsicWidth(double height) {
    double w = 0;
    for (final RenderBox c in _children) {
      final _Kind k = _pd(c).kind;
      if (k == _Kind.optionalCompact || k == _Kind.fixedShort) continue;
      w += c.getMaxIntrinsicWidth(height) + spacing;
    }
    return w;
  }

  @override
  double computeMinIntrinsicHeight(double width) =>
      _layoutMetaLines(this, BoxConstraints(maxWidth: width), dry: true).height;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      _layoutMetaLines(this, BoxConstraints(maxWidth: width), dry: true).height;

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      _layoutMetaLines(this, constraints, dry: true);

  @override
  void performLayout() {
    size = _layoutMetaLines(this, constraints, dry: false);
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    for (final RenderBox c in _children) {
      final _MetaParentData pd = _pd(c);
      if (pd.line < 0) continue;
      context.paintChild(c, pd.offset + offset);
    }
  }

  // The unused form of a two-form item is not part of the card: a screen
  // reader must not read 「Resend」 twice. A hidden flexible item (the PC
  // instance with no room left) stays in the tree: it is laid out at its own
  // width inside line 1's box (see the layout), so its node has a real rect
  // and is read.
  @override
  void visitChildrenForSemantics(RenderObjectVisitor visitor) {
    for (final RenderBox c in _children) {
      final _MetaParentData pd = _pd(c);
      if (pd.line >= 0 || pd.kind == _Kind.flexible) visitor(c);
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    RenderBox? c = lastChild;
    while (c != null) {
      final _MetaParentData pd = _pd(c);
      final RenderBox child = c;
      // First pass: exact boxes only.
      if (pd.line >= 0 && (pd.offset & child.size).contains(position)) {
        final bool hit = result.addWithPaintOffset(
          offset: pd.offset,
          position: position,
          hitTest: (BoxHitTestResult r, Offset p) =>
              child.hitTest(r, position: p),
        );
        if (hit) return true;
      }
      c = pd.previousSibling;
    }
    // Second pass: the tap landed on no painted item of the meta block (empty
    // space between or around them, inside the block). A tap target whose
    // 48 dp area holds that point takes it. Its area never reaches a
    // neighbouring item (that item took the tap above) nor anything outside
    // the block (this box is only asked about points inside it): a Resend
    // re-types text on the computer, so it must not answer a tap that was
    // meant for the delivery state, the count or the transcript.
    c = lastChild;
    while (c != null) {
      final _MetaParentData pd = _pd(c);
      final RenderBox child = c;
      if (pd.line >= 0 &&
          child is RenderMetaTapTarget &&
          child.targetRect.shift(pd.offset).contains(position)) {
        final bool hit = result.addWithPaintOffset(
          offset: pd.offset,
          position: position,
          hitTest: (BoxHitTestResult r, Offset p) =>
              child.hitTest(r, position: p),
        );
        if (hit) return true;
      }
      c = pd.previousSibling;
    }
    return false;
  }

  /// Whether [child] (a direct child) is painted — a tap target asks.
  bool _paints(RenderBox child) => child.parent == this && _pd(child).line >= 0;
}

/// Gives [child] a 48 × 48 dp hit area and semantic rect (or its own size
/// when larger) centred on it, without changing the layout. A tap on the
/// meta block's empty space inside that area reaches [child] at its nearest
/// point ([RenderMetaLines.hitTestChildren], second pass).
class MetaTapTarget extends SingleChildRenderObjectWidget {
  const MetaTapTarget({super.key, required Widget super.child});

  @override
  RenderMetaTapTarget createRenderObject(BuildContext context) =>
      RenderMetaTapTarget();
}

class RenderMetaTapTarget extends RenderProxyBox {
  static const double minSide = 48;

  /// The hit area, in this box's coordinates.
  Rect get targetRect => Rect.fromCenter(
    center: size.center(Offset.zero),
    width: math.max(size.width, minSide),
    height: math.max(size.height, minSide),
  );

  bool get painted => switch (parent) {
    final RenderMetaLines lines => lines._paints(this),
    _ => true,
  };

  @override
  Rect get semanticBounds => targetRect;

  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) {
    if (!hasSize || !painted || !targetRect.contains(position)) return false;
    final Offset inside = Offset(
      position.dx.clamp(0, math.max(0, size.width - 0.01)),
      position.dy.clamp(0, math.max(0, size.height - 0.01)),
    );
    if (child?.hitTest(result, position: inside) ?? false) {
      result.add(BoxHitTestEntry(this, position));
      return true;
    }
    return false;
  }
}

/// CARD-UI (C6): two children on one line where [first] has priority — it
/// gets its natural width (up to the line), [second] gets what is left and is
/// not painted below [secondMin]. Used for the history page's PC region: the
/// attribution chip (which computer) before 「→ window」.
class MetaPriorityRow extends MultiChildRenderObjectWidget {
  MetaPriorityRow({
    super.key,
    required Widget first,
    Widget? second,
    this.gap = 7,
    this.secondMin = 24,
  }) : super(children: <Widget>[first, ?second]);

  final double gap;
  final double secondMin;

  @override
  RenderMetaPriorityRow createRenderObject(BuildContext context) =>
      RenderMetaPriorityRow(gap: gap, secondMin: secondMin);

  @override
  void updateRenderObject(
    BuildContext context,
    RenderMetaPriorityRow renderObject,
  ) {
    renderObject
      ..gap = gap
      ..secondMin = secondMin;
  }
}

class _PriorityParentData extends ContainerBoxParentData<RenderBox> {
  bool painted = true;
}

class RenderMetaPriorityRow extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _PriorityParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _PriorityParentData> {
  RenderMetaPriorityRow({required this.gap, required this.secondMin});

  double gap;
  double secondMin;

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _PriorityParentData) {
      child.parentData = _PriorityParentData();
    }
  }

  @override
  double computeMaxIntrinsicWidth(double height) {
    double w = 0;
    RenderBox? c = firstChild;
    while (c != null) {
      w += c.getMaxIntrinsicWidth(height) + (c == firstChild ? 0 : gap);
      c = childAfter(c);
    }
    return w;
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      firstChild?.getMinIntrinsicWidth(height) ?? 0;

  @override
  double computeMaxIntrinsicHeight(double width) {
    double h = 0;
    RenderBox? c = firstChild;
    while (c != null) {
      h = math.max(h, c.getMaxIntrinsicHeight(width));
      c = childAfter(c);
    }
    return h;
  }

  @override
  double computeMinIntrinsicHeight(double width) =>
      computeMaxIntrinsicHeight(width);

  @override
  void performLayout() {
    final double maxW = constraints.maxWidth;
    final RenderBox? first = firstChild;
    if (first == null) {
      size = constraints.constrain(Size.zero);
      return;
    }
    final double w1 = math.min(
      first.getMaxIntrinsicWidth(double.infinity),
      maxW,
    );
    first.layout(BoxConstraints(maxWidth: w1), parentUsesSize: true);
    double used = first.size.width;
    double h = first.size.height;
    final RenderBox? second = childAfter(first);
    if (second != null) {
      final _PriorityParentData pd = second.parentData! as _PriorityParentData;
      final double left = maxW - used - gap;
      pd.painted = left >= secondMin;
      final double w2 = pd.painted
          ? math.min(second.getMaxIntrinsicWidth(double.infinity), left)
          : 0;
      second.layout(BoxConstraints.tightFor(width: w2), parentUsesSize: true);
      if (pd.painted) {
        pd.offset = Offset(used + gap, 0);
        used += gap + second.size.width;
        h = math.max(h, second.size.height);
      }
    }
    for (RenderBox? c = firstChild; c != null; c = childAfter(c)) {
      final _PriorityParentData pd = c.parentData! as _PriorityParentData;
      pd.offset = Offset(pd.offset.dx, (h - c.size.height) / 2);
    }
    size = constraints.constrain(Size(used, h));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    for (RenderBox? c = firstChild; c != null; c = childAfter(c)) {
      final _PriorityParentData pd = c.parentData! as _PriorityParentData;
      if (pd.painted) context.paintChild(c, pd.offset + offset);
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
