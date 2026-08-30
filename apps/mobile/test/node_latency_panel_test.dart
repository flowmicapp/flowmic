// owner 2026-08-30 — the node panel, asserted on what it RENDERS.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4-2.

import 'package:flowmic/src/session/node_latency.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flowmic/src/ui/node_badge.dart';
import 'package:flowmic/src/ui/node_latency_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final AppStrings _zh = AppStrings(AppLocale.zh);

const List<RelayNode> kNodes = <RelayNode>[
  RelayNode(
      id: 'srvny', url: 'https://srvny.flowmic.app', short: 'us', isWriter: true),
  RelayNode(id: 'srvjp', url: 'https://srvjp.flowmic.app', short: 'asia'),
];

Future<void> _mount(
  WidgetTester tester, {
  List<RelayNode> nodes = kNodes,
  String? current = 'srvjp',
  Future<NodeLatency> Function(String, String)? probe,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: ListView(children: <Widget>[
        NodeLatencyPanel(
          strings: _zh,
          nodes: nodes,
          currentNodeId: current,
          probe: probe ??
              (String id, String url) async =>
                  NodeLatency(id: id, url: url, edgeMs: 30, totalMs: 190),
        ),
      ]),
    ),
  ));
  await tester.pump();
}

void main() {
  testWidgets('🔴 a single-node deployment gets NO panel at all',
      (WidgetTester tester) async {
    // Which is every deployment until an operator publishes a second node. A
    // section with one row and no choice in it would be a menu that is not a
    // menu — and the panel's whole subject is the comparison.
    await _mount(tester, nodes: const <RelayNode>[]);
    expect(find.text(_zh.nodePanelTitle), findsNothing);
  });

  testWidgets('nothing is measured until the user asks',
      (WidgetTester tester) async {
    int calls = 0;
    await _mount(tester, probe: (String id, String url) async {
      calls++;
      return NodeLatency(id: id, url: url, edgeMs: 30, totalMs: 190);
    });
    // Three sequential requests per node on a radio is not something to do
    // because a screen opened.
    expect(calls, 0);
    expect(find.text(_zh.nodePanelTitle), findsOneWidget);
  });

  testWidgets('🔴 the three legs are rendered, and the middle one is the point',
      (WidgetTester tester) async {
    await _mount(tester);
    await tester.tap(find.text(_zh.nodePanelMeasure));
    await tester.pumpAndSettle();

    final String legs = tester
        .widget<Text>(find.byKey(const ValueKey<String>('node.legs.srvjp')))
        .data!;
    // 30 to the edge, 190 in total ⇒ 160 across the ocean. A single total
    // cannot tell a user which half is slow, which is the entire reason this
    // panel exists.
    expect(legs, contains('30'));
    expect(legs, contains('160'));
    expect(legs, contains('190'));
    expect(legs, contains(_zh.nodeLegEdge));
    expect(legs, contains(_zh.nodeLegOrigin));
    expect(legs, contains(_zh.nodeLegTotal));
  });

  testWidgets('🔴 a node that did not answer is NAMED, not given a big number',
      (WidgetTester tester) async {
    await _mount(tester,
        probe: (String id, String url) async =>
            NodeLatency(id: id, url: url, miss: 'timeout'));
    await tester.tap(find.text(_zh.nodePanelMeasure));
    await tester.pumpAndSettle();

    final String legs = tester
        .widget<Text>(find.byKey(const ValueKey<String>('node.legs.srvny')))
        .data!;
    expect(legs, contains(_zh.reachUnanswered));
    // ⚠️ The raw miss code (`timeout`) is deliberately NOT here — see the
    // internal-vocabulary case below. It stays on the object for a logger.
    // 「9999 ms」 would be sortable, comparable and wrong: that node is not
    // slow, it did not answer, and the two have different answers.
    expect(RegExp(r'\d{3,} ms').hasMatch(legs), isFalse);
  });

  testWidgets('🔴 owner 2026-08-30: a screen never shows the node ID',
      (WidgetTester tester) async {
    // 「当前只有 asia/us 两个节点，不要显示其它文字」. `srvjp` is our word for
    // that machine, not the user's, and the 2026-08-22 iron rule forbids
    // internal vocabulary in anything a user can see. Asserted over EVERY
    // rendered Text, because the id could leak from a title, a row label or a
    // failure string, and a case that checked only one of those would pass
    // while another leaked.
    await _mount(tester,
        probe: (String id, String url) async =>
            NodeLatency(id: id, url: url, miss: 'timeout'));
    await tester.tap(find.text(_zh.nodePanelMeasure));
    await tester.pumpAndSettle();

    final Iterable<String> shown = tester
        .widgetList<Text>(find.byType(Text))
        .map((Text t) => t.data ?? '');
    for (final String word in <String>['srvny', 'srvjp', 'timeout']) {
      expect(shown.any((String t) => t.contains(word)), isFalse,
          reason: '$word is internal vocabulary and must not reach a screen');
    }
    // …and the operator's words DID reach it — the positive control, without
    // which every assertion above would pass on a blank panel.
    expect(shown.any((String t) => t.contains(_zh.reachUnanswered)), isTrue);
    expect(find.byType(NodeBadge), findsNWidgets(2));
  });

  testWidgets('🔴 it says the phone does not choose — R8, in copy',
      (WidgetTester tester) async {
    // A list of latencies with one row marked, and no sentence around it, reads
    // as a menu. There is no menu: the desktop selects, the phone follows its
    // PC. Asserted on the RENDERED sentence (0.2.53), not on the getter.
    await _mount(tester);
    final Text note = tester
        .widget<Text>(find.byKey(const ValueKey<String>('node.panel.note')));
    expect(note.data, _zh.nodePanelNote);
    expect(note.data!.isNotEmpty, isTrue);
    // …and there is no per-node control to press.
    expect(find.byType(Radio<String>), findsNothing);
    expect(find.byType(Switch), findsNothing);
  });
}
