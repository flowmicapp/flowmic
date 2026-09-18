// NR-61 — the node directory this app keeps in memory, and the one way it was
// allowed to lose it.
//
// SPEC-REF: lib/src/signaling/node_labels.dart (NodeLabels.ensureLoaded)
//           lib/src/signaling/node_list_client.dart (httpNodeListFetch — "returns
//             an empty list for EVERY failure")
//
// ── WHY THIS FILE EXISTS NOW AND NOT BEFORE ────────────────────────────────
//
// The directory started life as a source of two-letter badges: losing it cost a
// chip its label, so `ensureLoaded` overwriting it with whatever the last read
// returned was fine, and a failed read returning `[]` was indistinguishable from
// an operator publishing nothing.
//
// It is no longer only that. `presenceEndpointFor`, the idle poll's wrong-node
// gate and `_followMovedPcNode` all resolve node ids through this list, and all
// three degrade to 「stay exactly where you are」 when it is empty. So an empty
// read no longer costs a label — it costs the phone the ability to follow its PC,
// which is the failure NR-61 exists to remove. And the moment it would strike is
// the worst one available: right after a hop, when `ensureLoaded` is called for a
// new endpoint over the radio that just changed.

import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flowmic/src/signaling/node_labels.dart';
import 'package:flutter_test/flutter_test.dart';

const List<RelayNode> _directory = <RelayNode>[
  RelayNode(id: 'srvny', url: 'https://srvny.example', short: 'us', isWriter: true),
  RelayNode(id: 'srvjp', url: 'https://srvjp.example', short: 'asia'),
];

void main() {
  test('a successful read fills the directory and the labels', () async {
    final NodeLabels labels = NodeLabels(
      fetch: (Uri url, Duration timeout) async => _directory,
    );
    await labels.ensureLoaded('https://srvny.example');
    expect(labels.nodes.length, 2);
    expect(labels.shortById['srvjp'], 'asia');
  });

  test('🔴 a FAILED read (which arrives as an empty list) does not erase what we have', () async {
    int calls = 0;
    final NodeLabels labels = NodeLabels(
      fetch: (Uri url, Duration timeout) async {
        calls++;
        // First endpoint answers; the second one fails — and `httpNodeListFetch`
        // spells every failure as `[]`, so this IS what a dropped radio looks
        // like from here.
        return calls == 1 ? _directory : const <RelayNode>[];
      },
    );
    await labels.ensureLoaded('https://srvny.example');
    await labels.ensureLoaded('https://srvjp.example');

    expect(calls, 2, reason: 'positive control: the second read really happened, '
        'so what follows is the empty answer being refused and not a read that '
        'never took place');
    expect(labels.nodes.map((RelayNode n) => n.id).toList(), <String>['srvny', 'srvjp'],
        reason: 'a phone that has just hopped would otherwise be unable to '
            'resolve any node id, and every follow decision degrades to 「stay」 '
            '— the exact failure NR-61 removes, re-introduced by a failed fetch');
  });

  test('one read per endpoint, and the failed one is not retried', () async {
    int calls = 0;
    final NodeLabels labels = NodeLabels(
      fetch: (Uri url, Duration timeout) async {
        calls++;
        return const <RelayNode>[];
      },
    );
    await labels.ensureLoaded('https://srvny.example');
    await labels.ensureLoaded('https://srvny.example');
    // Stated rather than assumed: NOT retrying is the existing decision (a retry
    // loop for a chip is how a background request becomes a battery report), and
    // it is exactly why an empty result must not be destructive — there is no
    // second chance this app run to undo it.
    expect(calls, 1);
    expect(labels.nodes, isEmpty);
  });
}
