// CARD-UI — the layout of [RenderMetaLines] (see chat_message_meta.dart for
// the kinds of item and the rule). A `part` so it shares the private parent
// data; split out to keep both files under the 800-line cap.
part of 'chat_message_meta.dart';

/// One candidate arrangement, on widths only.
class _Plan {
  final List<double> used = <double>[0, 0, 0];
  final List<int> visible = <int>[0, 0, 0];
  final List<bool> over = <bool>[false, false];
  final List<double> demand = <double>[0, 0];
  final Map<RenderBox, int> lineOf = <RenderBox, int>{};
  int factsMoved = 0;
  int missed = 0;

  /// Line the kept flexible item was given room on (null: not kept).
  int? flexLine;

  /// A fixed fact that does not fit its line outweighs anything that only
  /// goes to the overflow line.
  int get cost =>
      (over[0] ? 1000 : 0) + (over[1] ? 1000 : 0) + factsMoved + missed;
}

Size _layoutMetaLines(
  RenderMetaLines r,
  BoxConstraints constraints, {
  required bool dry,
}) {
  final double maxW = constraints.maxWidth;
  final double spacing = r.spacing;
  _MetaParentData pd(RenderBox c) => r._pd(c);

  // Source order, split at the break.
  final List<RenderBox> source = <RenderBox>[];
  final Map<RenderBox, int> home = <RenderBox, int>{};
  int at = 0;
  for (final RenderBox c in r._children) {
    if (pd(c).kind == _Kind.lineBreak) {
      at = 1;
      continue;
    }
    source.add(c);
    home[c] = at;
  }
  final Map<RenderBox, double> natural = <RenderBox, double>{
    for (final RenderBox c in source)
      c: c.getMaxIntrinsicWidth(double.infinity),
  };

  // Two-form items, by group: the full child, and the short / compact one.
  final Map<int, RenderBox> fullOf = <int, RenderBox>{};
  final Map<int, RenderBox> altOf = <int, RenderBox>{};
  for (final RenderBox c in source) {
    final int g = pd(c).group;
    if (g < 0) continue;
    switch (pd(c).kind) {
      case _Kind.fixed || _Kind.optionalFull:
        fullOf[g] = c;
      case _Kind.fixedShort || _Kind.optionalCompact:
        altOf[g] = c;
      default:
    }
  }
  bool isFixed(RenderBox c) => pd(c).kind == _Kind.fixed;
  final List<int> optionalGroups = <int>[
    for (final int g in fullOf.keys.toList()..sort())
      if (!isFixed(fullOf[g]!)) g,
  ];
  final RenderBox? flex = source
      .where((RenderBox c) => pd(c).kind == _Kind.flexible)
      .firstOrNull;

  // 1. The plan: which form every two-form item takes and where everything
  // but the flexible item goes. [held] holds items to their short / compact
  // form even where the full one would fit.
  _Plan plan(Set<int> held) {
    final _Plan p = _Plan();
    double gap(int line) => p.visible[line] == 0 ? 0 : spacing;
    bool fits(double w, int line) =>
        p.used[line] + gap(line) + w <= maxW + 0.01;
    void put(RenderBox c, int line) {
      p.used[line] += gap(line) + natural[c]!;
      p.visible[line]++;
      p.lineOf[c] = line;
    }

    // Fixed facts, each on its own line; a two-form one in its full wording
    // when that fits (and it is not held), else its short one. One that does
    // not fit after another item on its line moves to the overflow line; one
    // that does not fit even alone stays and breaks inside itself.
    for (final RenderBox c in source) {
      if (!isFixed(c)) continue;
      final int line = home[c]!;
      RenderBox chosen = c;
      final RenderBox? short = altOf[pd(c).group];
      if (short != null &&
          (held.contains(pd(c).group) || !fits(natural[c]!, line))) {
        chosen = short;
      }
      p.demand[line] += (p.demand[line] == 0 ? 0 : spacing) + natural[chosen]!;
      if (fits(natural[chosen]!, line) || p.visible[line] == 0) {
        if (!fits(natural[chosen]!, line)) p.over[line] = true;
        put(chosen, line);
        continue;
      }
      p.over[line] = true;
      if (short != null && fits(natural[c]!, 2)) chosen = c;
      put(chosen, 2);
    }
    // Other facts: their own line, else the other line (before the PC
    // instance gives way: a failure code or 「Resent 23:59」 beside the
    // delivery state is still the row's own news), else the overflow line.
    for (final RenderBox c in source) {
      if (pd(c).kind != _Kind.fact) continue;
      final int line = home[c]!;
      if (fits(natural[c]!, line)) {
        put(c, line);
      } else if (fits(natural[c]!, 1 - line)) {
        put(c, 1 - line);
      } else {
        p.factsMoved++;
        put(c, 2);
      }
    }
    // A kept flexible item: its minimum is reserved on its line, else on the
    // next ones.
    if (flex != null && pd(flex).keep) {
      final double need = math.min(pd(flex).minWidth, natural[flex]!);
      final int line = <int>[home[flex]!, 1, 2].firstWhere(
        (int l) => l >= home[flex]! && fits(need, l),
        orElse: () => 2,
      );
      p.used[line] += gap(line) + need;
      p.visible[line]++;
      p.flexLine = line;
    }
    // Optional items, in source order: own line full, other line full, own
    // line compact, other line compact; no place: the overflow line.
    for (final int g in optionalGroups) {
      final RenderBox full = fullOf[g]!;
      final RenderBox? compact = altOf[g];
      final int own = home[full]!;
      final bool onlyCompact = compact != null && held.contains(g);
      final List<(RenderBox, int)> tries = <(RenderBox, int)>[
        if (!onlyCompact) (full, own),
        if (!onlyCompact) (full, 1 - own),
        if (compact != null) (compact, own),
        if (compact != null) (compact, 1 - own),
      ];
      (RenderBox, int)? placed;
      for (final (RenderBox c, int line) in tries) {
        if (fits(natural[c]!, line)) {
          placed = (c, line);
          break;
        }
      }
      if (placed == null) {
        p.missed++;
        placed = (
          fits(natural[full]!, 2) || compact == null ? full : compact,
          2,
        );
      }
      put(placed.$1, placed.$2);
    }
    return p;
  }

  // Search: nothing held first; then the fewest held, in the order the
  // owner's rule can best spare them (the edited mark's word, then the polish
  // mark's long wording, then Resend's word — each keeps its full words in
  // its semantics label).
  _Plan best = plan(<int>{});
  if (best.cost > 0) {
    // Edited mark (an optional at home on line 2) 0, polish mark 1, Resend
    // (an optional at home on line 1) 2.
    int rank(int g) =>
        isFixed(fullOf[g]!) ? 1 : (home[fullOf[g]!] == 1 ? 0 : 2);
    final List<int> spare = <int>[for (final int g in altOf.keys) g]
      ..sort((int a, int b) {
        final int c = rank(a).compareTo(rank(b));
        return c != 0 ? c : b.compareTo(a);
      });
    List<Set<int>> subsets(int k, int from) => k == 0
        ? <Set<int>>[<int>{}]
        : <Set<int>>[
            for (int i = from; i < spare.length; i++)
              for (final Set<int> rest in subsets(k - 1, i + 1))
                <int>{spare[i], ...rest},
          ];
    search:
    for (int k = 1; k <= spare.length; k++) {
      for (final Set<int> held in subsets(k, 0)) {
        final _Plan next = plan(held);
        if (next.cost < best.cost) best = next;
        if (best.cost == 0) break search;
      }
    }
  }

  // 2. Lay out what the plan chose, in the order it measured: facts first,
  // then optionals. A fact gets at most what its line has left (it breaks
  // inside itself rather than being painted past the card edge); an optional
  // gets its natural width.
  final Map<RenderBox, Size> sizes = <RenderBox, Size>{};
  final Map<RenderBox, int> lineOf = <RenderBox, int>{};
  final List<double> used = <double>[0, 0, 0];
  final List<int> visible = <int>[0, 0, 0];
  Size lay(RenderBox c, BoxConstraints cc) {
    final Size s = dry
        ? c.getDryLayout(cc)
        : (c..layout(cc, parentUsesSize: true)).size;
    sizes[c] = s;
    return s;
  }

  double gapOn(int line) => visible[line] == 0 ? 0 : spacing;
  final List<List<RenderBox>> received = <List<RenderBox>>[
    <RenderBox>[],
    <RenderBox>[],
    <RenderBox>[],
  ];
  final List<List<RenderBox>> receivedLead = <List<RenderBox>>[
    <RenderBox>[],
    <RenderBox>[],
    <RenderBox>[],
  ];
  bool isFactForm(RenderBox c) => switch (pd(c).kind) {
    _Kind.fixed || _Kind.fixedShort || _Kind.fact => true,
    _ => false,
  };
  for (final RenderBox c in <RenderBox>[
    ...source.where((RenderBox c) => pd(c).kind != _Kind.fact && isFactForm(c)),
    ...source.where((RenderBox c) => pd(c).kind == _Kind.fact),
    ...source.where(
      (RenderBox c) => !isFactForm(c) && pd(c).kind != _Kind.flexible,
    ),
  ]) {
    final int? line = best.lineOf[c];
    if (line == null) {
      // The unused form: laid out at its own width (squeezing a chip to zero
      // would report an overflow) and not painted.
      lay(c, BoxConstraints(maxWidth: natural[c]!));
      lineOf[c] = -1;
      continue;
    }
    final double left = math.max(0, maxW - used[line] - gapOn(line));
    final double w = isFactForm(c) ? math.min(natural[c]!, left) : natural[c]!;
    used[line] += gapOn(line) + lay(c, BoxConstraints(maxWidth: w)).width;
    visible[line]++;
    lineOf[c] = line;
    if (line != home[c]) {
      (pd(c).leads ? receivedLead : received)[line].add(c);
    }
  }

  // 3. The flexible item gets exactly what its line has left. Hidden below
  // its minimum (unless kept): then laid out at its own width (at most the
  // card's) inside line 1's box and not painted, so it keeps a real semantic
  // rect.
  bool flexHidden = false;
  double hiddenWidth = 0;
  if (flex != null) {
    final int line = best.flexLine ?? home[flex]!;
    final double left = maxW - used[line] - gapOn(line);
    final bool keep = pd(flex).keep;
    if (keep || left >= pd(flex).minWidth) {
      final double w = math.min(
        natural[flex]!,
        math.max(left, math.min(pd(flex).minWidth, maxW)),
      );
      lay(flex, BoxConstraints.tightFor(width: math.max(0, w)));
      lineOf[flex] = line;
      if (line != home[flex]) received[line].add(flex);
    } else {
      // Laid out in what line 1 has left (at least 12 px; a single-line
      // ellipsized text, so it stays one line) and placed at line 1's end:
      // a real rect, read after the delivery state.
      hiddenWidth = math.min(
        natural[flex]!,
        math.max(12.0, maxW - used[0] - gapOn(0)),
      );
      lay(flex, BoxConstraints.tightFor(width: hiddenWidth));
      lineOf[flex] = -1;
      flexHidden = true;
    }
  }
  for (final RenderBox c in r._children) {
    if (pd(c).kind == _Kind.lineBreak) {
      lay(c, const BoxConstraints.tightFor(width: 0, height: 0));
    }
  }

  final List<double> h = <double>[0, 0, 0];
  for (final MapEntry<RenderBox, int> e in lineOf.entries) {
    if (e.value < 0) continue;
    h[e.value] = math.max(h[e.value], sizes[e.key]!.height);
  }
  final bool hasLine2 = lineOf.values.contains(1);
  final bool hasLine3 = lineOf.values.contains(2);
  final double y2 = h[0] + r.lineGap;
  final double y3 = h[0] + (hasLine2 ? r.lineGap + h[1] : 0) + r.lineGap;
  final double height =
      h[0] +
      (hasLine2 ? r.lineGap + h[1] : 0) +
      (hasLine3 ? r.lineGap + h[2] : 0);

  if (!dry) {
    r.fixedOverflow[0] = best.over[0];
    r.fixedOverflow[1] = best.over[1];
    r.fixedDemand[0] = best.demand[0];
    r.fixedDemand[1] = best.demand[1];
    r.factsMoved = best.factsMoved;
    r.optionalOverflow = best.missed;
    r.lineCount = hasLine3 ? 3 : (hasLine2 ? 2 : 1);
    for (final RenderBox c in r._children) {
      pd(c)
        ..line = lineOf[c] ?? -1
        ..home = home[c] ?? 0;
    }
    // Visual order per line: a leading item it received, its own items in
    // source order, what else it received, then the flexible item.
    List<RenderBox> order(int line) => <RenderBox>[
      ...receivedLead[line],
      ...source.where(
        (RenderBox c) =>
            home[c] == line &&
            pd(c).kind != _Kind.flexible &&
            lineOf[c] == line,
      ),
      ...received[line].where((RenderBox c) => !identical(c, flex)),
      if (flex != null && lineOf[flex] == line) flex,
    ];
    void place(List<RenderBox> items, double y, double lineH) {
      double x = 0;
      bool first = true;
      for (final RenderBox c in items) {
        if (!first) x += spacing;
        first = false;
        // Only reachable on an overfull line: an item squeezed to nothing
        // must not push the gap past the card edge.
        x = math.min(x, math.max(0, maxW - c.size.width));
        pd(c).offset = Offset(x, y + (lineH - c.size.height) / 2);
        x += c.size.width;
      }
    }

    place(order(0), 0, h[0]);
    place(order(1), y2, h[1]);
    place(
      <RenderBox>[
        ...receivedLead[2],
        ...received[2].where((RenderBox c) => !identical(c, flex)),
        if (flex != null && lineOf[flex] == 2) flex,
      ],
      y3,
      h[2],
    );
    if (flexHidden) {
      pd(flex!).offset = Offset(
        math.max(0, maxW - hiddenWidth),
        (h[0] - flex.size.height) / 2,
      );
    }
  }
  return constraints.constrain(Size(maxW.isFinite ? maxW : used[0], height));
}
