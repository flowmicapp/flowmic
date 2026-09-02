// owner 2026-08-30 — 本机 → 边缘 → 节点 = 总，and each part has to mean what it says.
// 2026-09-01 WP2 Card 1 — the headline is a HOT round trip. Connect is the first
// sample; latency is the min of the rest. 836 ms was the cold first round.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4;
//   docs/strategy/2026-09-01-lan-fable-work-package-2.md Card 1.

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

  test('hotOf: headline is the min of samples AFTER the first success', () {
    // Card 1: 836 ms was handshake + cold origin; 67 ms is the hot RTT.
    final NodeLatency h = hotOf('srvjp', 'https://srvjp.flowmic.app',
        <NodeLatency>[_s(400, 836), _s(10, 67), _s(10, 70)]);
    expect(h.edgeMs, 836, reason: 'first success is connect, reported separately');
    expect(h.totalMs, 67, reason: 'min of the hot set, never the cold first');
    expect(h.ok, isTrue);
  });

  test('hotOf: a lone cold sample is unanswered, not a headline', () {
    final NodeLatency h = hotOf('srvjp', 'https://srvjp.flowmic.app',
        <NodeLatency>[_s(400, 836)]);
    expect(h.edgeMs, 836);
    expect(h.totalMs, isNull);
    expect(h.ok, isFalse);
  });

  test('probeNode takes the hot split of its rounds through the seam', () async {
    final List<int> totals = <int>[300, 100, 200];
    int i = 0;
    final NodeLatency out = await probeNode(
      'srvjp',
      'https://srvjp.flowmic.app',
      ping: (String id, String url, Duration _) async =>
          _s(20, totals[i++]),
    );
    expect(i, 3, reason: 'three rounds, sequentially — they must not race');
    expect(out.edgeMs, 300);
    expect(out.totalMs, 100, reason: 'skip first, min of [100, 200]');
  });
}
