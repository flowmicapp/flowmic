// owner 2026-08-30 — 本机 → 边缘 → 节点 = 总，and each part has to mean what it says.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4.

import 'package:flowmic/src/session/node_latency.dart';
import 'package:flutter_test/flutter_test.dart';

NodeLatency _s(int? edge, int? total, {String? miss}) =>
    NodeLatency(id: 'srvjp', url: 'https://srvjp.flowmic.app',
        edgeMs: edge, totalMs: total, miss: miss);

void main() {
  test('the middle segment is total − edge, which is the whole point', () {
    // 60 ms to the nearest edge, 190 ms in total ⇒ 130 ms across the ocean.
    // Two of the three numbers are measured and the third is their difference;
    // showing only the total would leave a user unable to tell 「my wifi」 from
    // 「the Pacific」, which is the question this panel exists to answer.
    expect(_s(60, 190).originMs, 130);
  });

  test('🔴 a missing half yields NULL, never 0', () {
    // 0 reads as 「instant」. Absence must not be able to look like excellence.
    expect(_s(null, 190).originMs, isNull);
    expect(_s(60, null).originMs, isNull);
  });

  test('timer granularity cannot produce a negative millisecond', () {
    expect(_s(40, 38).originMs, 0);
  });

  test('median, not mean and not best-of', () {
    // One cold connection is normal and would drag a mean; a best-of would
    // flatter a node that is usually slow. The desktop selector takes the
    // median too — the panel and the selector must not be able to disagree
    // about what a node's latency IS.
    final NodeLatency m = medianOf('srvjp', 'https://srvjp.flowmic.app',
        <NodeLatency>[_s(20, 900), _s(20, 100), _s(20, 120)]);
    expect(m.totalMs, 120);
  });

  test('samples that failed are ignored, and the survivors still answer', () {
    final NodeLatency m = medianOf('srvjp', 'https://srvjp.flowmic.app',
        <NodeLatency>[_s(null, null, miss: 'timeout'), _s(20, 100), _s(20, 140)]);
    expect(m.totalMs, 140, reason: 'two survivors ⇒ the upper middle');
    expect(m.ok, isTrue);
  });

  test('🔴 a node that never answered is NAMED, not given a huge number', () {
    // A row reading 「9999 ms」 would be sortable, comparable and wrong: that
    // node is not slow, it did not answer, and the two have different answers
    // for the person reading the panel.
    final NodeLatency m = medianOf('srvjp', 'https://srvjp.flowmic.app',
        <NodeLatency>[_s(null, null, miss: 'timeout')]);
    expect(m.ok, isFalse);
    expect(m.totalMs, isNull);
    expect(m.miss, 'timeout');
  });

  test('no samples at all is its own named state', () {
    final NodeLatency m =
        medianOf('srvjp', 'https://srvjp.flowmic.app', const <NodeLatency>[]);
    expect(m.miss, 'unmeasured',
        reason: '「never asked」 is not 「asked and got nothing」');
  });

  test('probeNode takes the median of its rounds through the seam', () async {
    final List<int> totals = <int>[300, 100, 200];
    int i = 0;
    final NodeLatency out = await probeNode(
      'srvjp',
      'https://srvjp.flowmic.app',
      ping: (String id, String url, Duration _) async =>
          _s(20, totals[i++]),
    );
    expect(i, 3, reason: 'three rounds, sequentially — they must not race');
    expect(out.totalMs, 200);
  });
}
