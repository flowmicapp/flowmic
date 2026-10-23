// CARD-UI (MAIN 2026-10-14, C6) — one line of text that, when it does not
// fit, drops characters from the MIDDLE and keeps more of the end.
//
// Why: the history page's attribution chip names the computer a row went to
// (owner 2026-07-27 hard requirement ①). Windows names computers
// 「DESKTOP-7F3K2QX」 by default, so two machines differ only at the END — an
// end ellipsis (「DESKTOP-…」) shows exactly the part they share. Here the
// kept characters are split 40 % head / 60 % tail (「DES…7F3K2QX」).
//
// It IS a `Text` (same `data`, so `find.text` and every reader of `Text.data`
// keep working) whose build draws through [RenderMiddleEllipsisText]; a
// render object rather than a LayoutBuilder because the card's meta lines ask
// their items for intrinsic widths, which a LayoutBuilder cannot give. A
// screen reader always gets the whole text.

import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

class MiddleEllipsisText extends Text {
  const MiddleEllipsisText(super.data, {super.key, super.style});

  @override
  Widget build(BuildContext context) => _MiddleEllipsis(
    text: data!,
    style: DefaultTextStyle.of(context).style.merge(style),
    textScaler: MediaQuery.textScalerOf(context),
    textDirection: Directionality.of(context),
  );
}

class _MiddleEllipsis extends LeafRenderObjectWidget {
  const _MiddleEllipsis({
    required this.text,
    required this.style,
    required this.textScaler,
    required this.textDirection,
  });
  final String text;
  final TextStyle style;
  final TextScaler textScaler;
  final TextDirection textDirection;

  @override
  RenderMiddleEllipsisText createRenderObject(BuildContext context) =>
      RenderMiddleEllipsisText(text, style, textScaler, textDirection);

  @override
  void updateRenderObject(
    BuildContext context,
    RenderMiddleEllipsisText renderObject,
  ) {
    renderObject.configure(text, style, textScaler, textDirection);
  }
}

class RenderMiddleEllipsisText extends RenderBox {
  RenderMiddleEllipsisText(
    this._text,
    this._style,
    this._textScaler,
    this._textDirection,
  );

  String _text;
  TextStyle _style;
  TextScaler _textScaler;
  TextDirection _textDirection;
  final TextPainter _painter = TextPainter(maxLines: 1);

  /// The whole text.
  String get text => _text;

  /// What is painted after the last layout.
  String shown = '';

  /// How many characters of [text] are painted (all of them when it fits).
  int shownChars = 0;

  void configure(
    String text,
    TextStyle style,
    TextScaler textScaler,
    TextDirection textDirection,
  ) {
    if (text == _text &&
        style == _style &&
        textScaler == _textScaler &&
        textDirection == _textDirection) {
      return;
    }
    _text = text;
    _style = style;
    _textScaler = textScaler;
    _textDirection = textDirection;
    markNeedsLayout();
    markNeedsSemanticsUpdate();
  }

  double _widthOf(String s) {
    _painter
      ..text = TextSpan(text: s, style: _style)
      ..textScaler = _textScaler
      ..textDirection = _textDirection
      ..layout();
    return _painter.width;
  }

  @override
  double computeMaxIntrinsicWidth(double height) => _widthOf(_text);

  @override
  double computeMinIntrinsicWidth(double height) => _widthOf('…');

  @override
  double computeMaxIntrinsicHeight(double width) {
    _widthOf(_text);
    return _painter.height;
  }

  @override
  double computeMinIntrinsicHeight(double width) =>
      computeMaxIntrinsicHeight(width);

  (String, int) _fit(double maxWidth) {
    final List<String> chars = _text.characters.toList();
    if (_widthOf(_text) <= maxWidth) return (_text, chars.length);
    String cut(int n) {
      final int head = (n * 0.4).floor();
      final int tail = n - head;
      return '${chars.take(head).join()}…'
          '${chars.skip(chars.length - tail).join()}';
    }

    int lo = 0;
    int hi = chars.length - 1;
    while (lo < hi) {
      final int mid = (lo + hi + 1) ~/ 2;
      if (_widthOf(cut(mid)) <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return (cut(lo), lo);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final (String s, _) = _fit(constraints.maxWidth);
    final double w = _widthOf(s);
    return constraints.constrain(Size(w, _painter.height));
  }

  @override
  void performLayout() {
    final (String s, int n) = _fit(constraints.maxWidth);
    shown = s;
    shownChars = n;
    _widthOf(s);
    size = constraints.constrain(Size(_painter.width, _painter.height));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    _widthOf(shown);
    context.canvas.save();
    context.canvas.clipRect(offset & size);
    _painter.paint(
      context.canvas,
      offset + Offset(0, math.max(0, (size.height - _painter.height) / 2)),
    );
    context.canvas.restore();
  }

  @override
  void describeSemanticsConfiguration(SemanticsConfiguration config) {
    super.describeSemanticsConfiguration(config);
    config
      ..isSemanticBoundary = true
      ..label = _text
      ..textDirection = _textDirection;
  }
}
