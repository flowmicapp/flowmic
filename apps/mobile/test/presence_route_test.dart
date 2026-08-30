// owner 2026-08-30 — ask the node the PC is actually on.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §3.

import 'package:flowmic/src/session/presence_route.dart';
import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flutter_test/flutter_test.dart';

const List<RelayNode> kNodes = <RelayNode>[
  RelayNode(id: 'srvny', url: 'https://srvny.flowmic.app', isWriter: true),
  RelayNode(id: 'srvjp', url: 'https://srvjp.flowmic.app'),
];

void main() {
  test('🔴 the probe goes to the PC\'s node, not to the one we happen to dial',
      () {
    // The live case as of 2026-08-30: the phone pairs on the writer (pairing is
    // writer-only), its PC has settled on the Tokyo replica, and rooms are
    // per-process. Asking the writer gets a truthful 「not in my room」 about a
    // computer that is running perfectly.
    expect(
      presenceEndpointFor(
        currentEndpoint: 'https://srvny.flowmic.app',
        homeNode: 'srvjp',
        nodes: kNodes,
      ),
      'https://srvjp.flowmic.app',
    );
  });

  test('already on the right node ⇒ unchanged', () {
    expect(
      presenceEndpointFor(
        currentEndpoint: 'https://srvjp.flowmic.app',
        homeNode: 'srvjp',
        nodes: kNodes,
      ),
      'https://srvjp.flowmic.app',
    );
  });

  group('🔴 every failure falls back to TODAY\'s behaviour, never to offline',
      () {
    const String here = 'https://flowmic.app';
    test('no home_node (LAN, single node, or an older relay)', () {
      expect(presenceEndpointFor(currentEndpoint: here, nodes: kNodes), here);
    });
    test('no directory read yet', () {
      expect(presenceEndpointFor(currentEndpoint: here, homeNode: 'srvjp'),
          here);
    });
    test('a node id the directory does not know', () {
      // Resolving is not something to improvise — the same rule planNodeHop
      // follows before a hop, for the same reason.
      expect(
        presenceEndpointFor(
            currentEndpoint: here, homeNode: 'srvfr', nodes: kNodes),
        here,
      );
    });
  });

  group('and when we know we asked the WRONG node', () {
    test('the answer is flagged as being about another node', () {
      expect(
        presenceAnswerIsAboutAnotherNode(
          askedEndpoint: 'https://srvny.flowmic.app',
          homeNode: 'srvjp',
          nodes: kNodes,
        ),
        isTrue,
        reason: 'a pc_online:false from there says nothing about the computer',
      );
    });

    test('asking the right node is not flagged', () {
      expect(
        presenceAnswerIsAboutAnotherNode(
          askedEndpoint: 'https://srvjp.flowmic.app/',
          homeNode: 'srvjp',
          nodes: kNodes,
        ),
        isFalse,
        reason: 'host comparison, so a trailing slash is not a different node',
      );
    });

    test('🔴 not knowing does NOT manufacture doubt', () {
      // The failure direction matters as much as the check. With no home_node
      // and no directory we are in exactly the world we were in yesterday, and
      // yesterday's answers were usable. Flagging them all as untrustworthy
      // would turn every single-node deployment's presence into 「unknown」
      // forever — a regression dressed as caution.
      expect(
        presenceAnswerIsAboutAnotherNode(
            askedEndpoint: 'https://flowmic.app', nodes: kNodes),
        isFalse,
      );
      expect(
        presenceAnswerIsAboutAnotherNode(
            askedEndpoint: 'https://flowmic.app', homeNode: 'srvjp'),
        isFalse,
      );
    });
  });
}
