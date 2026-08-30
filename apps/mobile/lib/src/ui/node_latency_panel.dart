// owner 2026-08-30 — 「在手机端的设置中增加所有节点的连接设置，能够看到
// 本机-CF延时-中继节点延时 = 总延时 的信息以方便了解网络情况」.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4;
//   lib/src/session/node_latency.dart (where the three numbers come from and
//   why the middle one is a subtraction).
//
// ── IT IS INFORMATION, AND THE COPY HAS TO SAY SO ───────────────────────────
//
// The desktop selects a node; this phone FOLLOWS its PC (multi-node design
// §4-1, and that following is what lets the whole design skip cross-node room
// sync). A list of latencies with no sentence around it reads as a menu, and
// there is no menu — so [AppStrings.nodePanelNote] is load-bearing, not a
// footnote. There is deliberately no 「use this node」 button: a control that
// changed nothing would be worse than no control (R8, three times paid for).
//
// ⚠️ NOTHING IS MEASURED UNTIL THE USER ASKS. Three sequential requests per
// node on a radio is not something to do because a screen opened.

import 'package:flutter/material.dart';

import '../session/node_latency.dart';
import '../settings/app_strings.dart';
import '../signaling/node_follow.dart';
import 'node_badge.dart';
import 'settings_widgets.dart';
import 'tokens.dart';

class NodeLatencyPanel extends StatefulWidget {
  const NodeLatencyPanel({
    super.key,
    required this.strings,
    required this.nodes,
    this.currentNodeId,
    this.probe = probeNode,
  });

  final AppStrings strings;

  /// The operator's directory as this app last read it. EMPTY is the normal
  /// state on a single-node deployment, and the panel then draws nothing at all
  /// rather than a section with one row and no choice in it.
  final List<RelayNode> nodes;

  /// The node this session is on, so the row can be marked 「you are here」 —
  /// a statement, never a selection.
  final String? currentNodeId;

  /// Test seam. Production measures for real.
  final Future<NodeLatency> Function(String id, String url) probe;

  @override
  State<NodeLatencyPanel> createState() => _NodeLatencyPanelState();
}

class _NodeLatencyPanelState extends State<NodeLatencyPanel> {
  final Map<String, NodeLatency> _results = <String, NodeLatency>{};
  bool _busy = false;

  Future<void> _measure() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      // 🔴 CLEARED FIRST. Leaving the previous round on screen while a new one
      // runs would show numbers from two different moments side by side, and
      // nothing on the row would say which was which.
      _results.clear();
    });
    for (final RelayNode n in widget.nodes) {
      final NodeLatency r = await widget.probe(n.id, n.url);
      if (!mounted) return;
      setState(() => _results[n.id] = r);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.nodes.isEmpty) return const SizedBox.shrink();
    final AppStrings s = widget.strings;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        settingsSection(s.nodePanelTitle),
        settingsCard(
          child: Column(
            children: <Widget>[
              for (int i = 0; i < widget.nodes.length; i++)
                settingsRow(
                  last: i == widget.nodes.length - 1,
                  child: _row(widget.nodes[i], s),
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  s.nodePanelNote,
                  key: const ValueKey<String>('node.panel.note'),
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
                ),
              ),
              const SizedBox(width: 10),
              ghostButton(
                s.nodePanelMeasure,
                onTap: _busy ? null : () => _measure(),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(RelayNode n, AppStrings s) {
    final NodeLatency? r = _results[n.id];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            // 🔴 THE BADGE IS THE WHOLE NAME. Owner 2026-08-30: 「不要显示其它
            // 文字」 — `srvjp` is our word for that machine, not the user's, and
            // the 2026-08-22 iron rule forbids internal vocabulary in anything
            // a user can see. A node the operator gave no label is therefore
            // unnamed here, and the row is still useful: it carries the three
            // numbers, which is what the panel is for.
            NodeBadge(label: nodeBadgeLabel(n.id, _shortById())),
            const Spacer(),
            if (n.id == widget.currentNodeId)
              settingsDot(FlowMicColors.teal),
          ],
        ),
        const SizedBox(height: 4),
        // 🔴 The three legs, and the middle one is why the panel exists: the
        // edge time answers 「how far is your nearest Cloudflare」 and the
        // remainder answers 「how far is the machine room from it」. A single
        // total cannot tell a user which half is slow.
        Text(
          r == null
              ? '—'
              : (r.ok
                  ? '${s.nodeLegEdge} ${r.edgeMs} ms · '
                      '${s.nodeLegOrigin} ${r.originMs} ms · '
                      '${s.nodeLegTotal} ${r.totalMs} ms'
                  // A failure is SAID, not scored. 「9999 ms」 would be
                  // sortable, comparable and wrong — that node is not slow, it
                  // did not answer, and those have different answers for the
                  // reader.
                  //
                  // ⚠️ `r.miss` (`timeout` / `tls` / `network`) is deliberately
                  // NOT appended: those are our words, and the same 2026-08-22
                  // rule that keeps `srvjp` off this screen keeps them off it.
                  // They stay in the object for a caller that logs.
                  : s.reachUnanswered),
          key: ValueKey<String>('node.legs.${n.id}'),
          style: TextStyle(
            color: r != null && !r.ok ? FlowMicColors.amber : FlowMicColors.t2,
            fontSize: 11,
            fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }

  Map<String, String> _shortById() => <String, String>{
        for (final RelayNode n in widget.nodes)
          if (n.short != null && n.short!.trim().isNotEmpty)
            n.id: n.short!.trim(),
      };
}
