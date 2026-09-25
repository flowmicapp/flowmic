// Card CR-12-G — the search word, marked where it occurs. Style only: no text is
// added, removed or reordered, so a highlighted span reads exactly as the
// plain one does (design §11.2; demo cell G-1 draws it as an amber wash).

import 'package:flutter/material.dart';

import '../timeline/search_hits.dart' show matchRanges;
import 'tokens.dart';

/// The wash behind a matched word. A getter because the palette follows the
/// theme.
Color get searchHighlightColor => FlowMicColors.amber.withValues(alpha: 0.28);

/// [text] as one span, with every occurrence of [query] washed in
/// [searchHighlightColor]. No occurrence ⇒ a single plain span.
TextSpan highlightedSpan(String text, String query, TextStyle style) {
  final List<(int, int)> ranges = matchRanges(text, query);
  if (ranges.isEmpty) return TextSpan(text: text, style: style);
  final TextStyle marked = style.copyWith(
    backgroundColor: searchHighlightColor,
    color: FlowMicColors.t1,
  );
  final List<TextSpan> parts = <TextSpan>[];
  int at = 0;
  for (final (int start, int end) in ranges) {
    if (start > at) parts.add(TextSpan(text: text.substring(at, start)));
    parts.add(TextSpan(text: text.substring(start, end), style: marked));
    at = end;
  }
  if (at < text.length) parts.add(TextSpan(text: text.substring(at)));
  return TextSpan(style: style, children: parts);
}
