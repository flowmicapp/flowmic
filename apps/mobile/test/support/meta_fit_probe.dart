// CARD-UI — the rendered-result checks shared by the two meta fit tests
// (`chat_message_meta_fit_test.dart`: the chat page's tile matrix;
// `history_card_meta_fit_test.dart`: the real history page). Every check reads
// the laid-out render tree, never `Text.data` (D-15).
//
// The rule they check (docs/strategy/2026-10-14-card-meta-two-lines-rule.md):
//   · at every text size: no fact is hidden, cut or ellipsized — every fact
//     item is painted, and its text is not clipped (it may wrap inside itself
//     only where its `Text` allows lines to wrap);
//   · up to text size 1.15 ([strict]): the delivery state stays on line 1 and
//     time / duration and count / polish state on line 2, each unwrapped;
//   · nothing is painted past the card edge; at most three meta lines.
// A card with a third line at <= 1.15 is reported as a residual cell for the
// fixture; at 1.3 a third line is allowed and not pinned.

import 'package:flowmic/src/ui/chat_message_meta.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/middle_ellipsis_text.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// What one card's meta must show.
class MetaExpectation {
  const MetaExpectation({
    required this.key,
    required this.fullTexts,
    required this.pcText,
    this.pcAlwaysShown = false,
  });

  /// `locale/width/rung/...` — names the cell in failures and in the fixture.
  final String key;

  /// Each fact must be painted, uncut, in ONE of its wordings (the polish
  /// mark has a full and a short one). A paragraph's text CONTAINS the string
  /// (the pill prefixes its glyph).
  final List<List<String>> fullTexts;

  /// The PC instance's text: only ever in the flexible item, never on line 2
  /// on the chat page.
  final String? pcText;

  /// The history page: the PC instance is never hidden (it may move down).
  final bool pcAlwaysShown;
}

/// The result of probing one card.
class MetaProbe {
  final List<String> failures = <String>[];

  /// `key/line3` when the card needed a third line (strict sizes only).
  final List<String> residual = <String>[];

  /// One line per residual cell: what put it on a third line.
  final List<String> detail = <String>[];

  /// `key/line3` when the card's two-or-three-line answer flips within
  /// [kMetaShapingBand] of the card's width (strict sizes only): the host's
  /// text shaping, not our layout, decides which side of the edge it lands.
  final List<String> borderline = <String>[];
}

/// How close to the card's width (dp) a third meta line counts as decided by
/// the host's text shaping rather than by our layout.
///
/// Measured 2026-10-23: `en/360/xlarge/{injected,noted}/modelRejected/
/// thisYear/selecting` need a third line on Windows (and on macOS: mac-verify
/// passed with them pinned) and are 0.20 dp short of fitting two (dry layout
/// at width + 0.05 dp steps). Public CI's Linux runner (run for b3d64055, the
/// same Flutter 3.44 SDK, whose Roboto files are the ones this ruler loads)
/// laid both out on two lines, so 「pinned but fits two lines now」 turned red
/// there. 2 dp is ten times that flip and well under one glyph at these
/// sizes, so a real layout change (a word or an item moving) still moves a
/// cell out of the band.
///
/// The band only excuses the pin RATCHET (a pinned cell that fits two lines
/// on this host). It never excuses a hidden, cut or ellipsized fact, an item
/// past the card edge, a wrapped fact, or an unpinned card that needs a
/// third line — those checks read the laid-out tree as before.
const double kMetaShapingBand = 2.0;

/// Every `KeyedSubtree` with a string key under [root], by key — one walk of
/// the tree, not one search per card (a Finder per card made this quadratic).
Map<String, Element> keyedCards(Element root) {
  final Map<String, Element> out = <String, Element>{};
  void visit(Element e) {
    final Widget w = e.widget;
    if (w is KeyedSubtree && w.key is ValueKey<String>) {
      out[(w.key! as ValueKey<String>).value] = e;
    }
    e.visitChildren(visit);
  }

  visit(root);
  return out;
}

/// Every `ChatMessageTile` under [root], by its row id.
Map<String, Element> tilesById(Element root) {
  final Map<String, Element> out = <String, Element>{};
  void visit(Element e) {
    if (e.widget case final ChatMessageTile t) {
      out[t.entry.id] = e;
      return;
    }
    e.visitChildren(visit);
  }

  visit(root);
  return out;
}

MetaProbe probeMetaCell(
  Element card,
  MetaExpectation want, {
  required bool strict,
  bool shapingBand = false,
}) {
  final MetaProbe out = MetaProbe();
  final String key = want.key;
  final List<RenderMetaLines> blocks = <RenderMetaLines>[];
  void findBlocks(Element e) {
    if (e.widget is MetaLines) {
      blocks.add(e.renderObject! as RenderMetaLines);
      return;
    }
    e.visitChildren(findBlocks);
  }

  findBlocks(card);
  if (blocks.length != 1) {
    out.failures.add('$key: ${blocks.length} meta blocks');
    return out;
  }
  final RenderMetaLines block = blocks.single;
  if (block.lineCount > 3) out.failures.add('$key: ${block.lineCount} lines');

  RenderBox? top(RenderObject o) {
    RenderObject? cur = o;
    while (cur != null && !identical(cur.parent, block)) {
      cur = cur.parent;
    }
    return cur as RenderBox?;
  }

  if (strict) {
    for (int i = 0; i < 2; i++) {
      if (block.fixedOverflow[i]) {
        out.failures.add(
          '$key/line${i + 1}: a fact does not fit its line (required at this '
          'size; needs ${block.fixedDemand[i].toStringAsFixed(1)} of '
          '${block.size.width.toStringAsFixed(1)})',
        );
      }
    }
    // The other side of the edge, by dry layout (no side effects on the
    // painted tree): a three-line card that fits two at width + band, or a
    // card that fits two that needs a third at width - band. Opt-in: the
    // history card's RenderMetaPriorityRow (chat_message_meta.dart) has no
    // computeDryLayout, so the history test keeps the exact ratchet (it did
    // not trip on public CI; only the chat cell did).
    if (shapingBand) {
      final double w = block.constraints.maxWidth;
      final double h = block.size.height;
      final bool nearEdge = block.lineCount == 3
          ? block
                    .getDryLayout(
                      BoxConstraints(maxWidth: w + kMetaShapingBand),
                    )
                    .height <
                h - 0.5
          : block
                    .getDryLayout(
                      BoxConstraints(maxWidth: w - kMetaShapingBand),
                    )
                    .height >
                h + 0.5;
      if (nearEdge) out.borderline.add('$key/line3');
    }
    if (block.lineCount == 3) {
      out.residual.add('$key/line3');
      out.detail.add(
        '$key/line3: ${block.factsMoved} fact(s), '
        '${block.optionalOverflow} optional(s); fixed '
        '${block.fixedDemand[0].toStringAsFixed(1)} + '
        '${block.fixedDemand[1].toStringAsFixed(1)} of '
        '${block.size.width.toStringAsFixed(1)}',
      );
    }
  }

  // Nothing painted past the card edge; every two-form item painted exactly
  // once; every fact painted.
  final Map<int, int> paintedForms = <int, int>{};
  final Set<int> groups = <int>{};
  block.visitChildren((RenderObject o) {
    final RenderBox c = o as RenderBox;
    final int group = block.groupOf(c);
    if (group >= 0) groups.add(group);
    if (block.lineOf(c) < 0) {
      if (block.isFact(c) && group < 0) {
        out.failures.add('$key: a fact is not painted');
      }
      return;
    }
    if (group >= 0) paintedForms[group] = (paintedForms[group] ?? 0) + 1;
    final double right =
        (c.parentData! as BoxParentData).offset.dx + c.size.width;
    if (right > block.size.width + 0.5) {
      out.failures.add(
        '$key/line${block.lineOf(c) + 1}: item ends at '
        '${right.toStringAsFixed(1)} > ${block.size.width.toStringAsFixed(1)}',
      );
    }
  });
  for (final int g in groups) {
    if (paintedForms[g] != 1) {
      out.failures.add(
        '$key: two-form item #$g painted ${paintedForms[g] ?? 0}x',
      );
    }
  }

  // Every paragraph on a painted fact: not ellipsized, not clipped. Up to
  // 1.15 the facts of lines 1-2 also stay on one line.
  final List<RenderParagraph> paras = <RenderParagraph>[];
  final List<RenderMiddleEllipsisText> middles = <RenderMiddleEllipsisText>[];
  void walk(RenderObject o) {
    if (o is RenderParagraph) paras.add(o);
    if (o is RenderMiddleEllipsisText) middles.add(o);
    o.visitChildren(walk);
  }

  walk(block);
  final List<String> shown = <String>[];
  for (final RenderParagraph p in paras) {
    final RenderBox? child = top(p);
    if (child == null || !block.isFact(child)) continue;
    final int line = block.lineOf(child);
    if (line < 0) continue;
    final String text = p.text.toPlainText();
    final double natural = p.getMaxIntrinsicWidth(double.infinity);
    final bool wraps = natural > p.size.width + 0.5;
    final bool cut = p.didExceedMaxLines || (wraps && p.maxLines != null);
    if (cut) {
      out.failures.add(
        '$key/line${line + 1}: fact "$text" cut '
        '(${natural.toStringAsFixed(1)} > ${p.size.width.toStringAsFixed(1)})',
      );
      continue;
    }
    if (strict && wraps && line < 2) {
      out.failures.add(
        '$key/line${line + 1}: fact "$text" wraps (required unwrapped at '
        'this size)',
      );
    }
    shown.add(text);
  }
  // Positive control, on every card: each listed fact was found painted.
  for (final List<String> fact in want.fullTexts) {
    if (!shown.any((String s) => fact.any(s.contains))) {
      out.failures.add('$key: "${fact.first}" not painted whole');
    }
  }

  // The PC instance lives only in the flexible item; on the history page it
  // is always painted.
  if (want.pcText case final String pc?) {
    final List<RenderBox> pcs = <RenderBox>[
      ...paras.where((RenderParagraph p) => p.text.toPlainText().contains(pc)),
      ...middles.where((RenderMiddleEllipsisText m) => m.text.contains(pc)),
    ];
    if (pcs.isEmpty) out.failures.add('$key: PC instance not built');
    for (final RenderMiddleEllipsisText m in middles) {
      if (!m.text.contains(pc)) continue;
      out.detail.add('$key/pc: ${m.shownChars} of ${m.text.length} shown');
      // The chip keeps the END of the name (default Windows names differ
      // only there): what it paints ends with the name's last characters.
      final int tail = m.shownChars - (m.shownChars * 0.4).floor();
      if (!m.shown.endsWith(m.text.substring(m.text.length - tail))) {
        out.failures.add('$key: PC chip "${m.shown}" lost the end of the name');
      }
    }
    if (want.pcAlwaysShown &&
        !middles.any((RenderMiddleEllipsisText m) => m.text.contains(pc))) {
      out.failures.add('$key: PC chip does not keep the end of the name');
    }
    for (final RenderBox p in pcs) {
      final RenderBox? child = top(p);
      if (child == null || !block.isFlexible(child)) {
        out.failures.add('$key: PC instance is not the flexible item');
        continue;
      }
      final int line = block.lineOf(child);
      if (want.pcAlwaysShown && line < 0) {
        out.failures.add('$key: PC instance hidden on the history page');
      }
      if (!want.pcAlwaysShown && line > 0) {
        out.failures.add('$key: PC instance left line 1 on the chat page');
      }
    }
  }
  return out;
}

/// Reads a fixture of pinned residual cells (`#` comments allowed).
Set<String> readPinned(String text) => text
    .split('\n')
    .map((String l) => l.trim())
    .where((String l) => l.isNotEmpty && !l.startsWith('#'))
    .toSet();
