// Phone-follows-PC — the planner, which is where the decision meets the fetch.
//
// SPEC-REF: apps/mobile/lib/src/signaling/node_list_client.dart (planNodeHop)
//
// Two properties are load-bearing here and neither is visible from the pure
// half:
//
//   · on a single-node deployment NO REQUEST IS MADE. Every installation today
//     is single-node, so if the ordering ever inverted, every phone in the
//     world would start making an extra HTTP call on every reconnect, forever,
//     to learn something the ack already told it;
//   · A FETCH THAT FAILS CANNOT MOVE ANYONE. Every failure lands on an empty
//     list, which resolves to nothing, which means stay put. The failure
//     direction has to be "keep talking to the node we are on", never "dial
//     something we guessed".

import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flowmic/src/signaling/node_list_client.dart';
import 'package:flutter_test/flutter_test.dart';

const String _here = 'https://srvny.flowmic.app';

Map<String, Object?> _ack({String? home, String? node}) => <String, Object?>{
      'home_node': ?home,
      'node': ?node,
    };

/// Records every call so a test can assert that NONE were made.
class _Fetcher {
  _Fetcher(this._answer);
  final List<RelayNode> Function() _answer;
  final List<Uri> calls = <Uri>[];

  Future<List<RelayNode>> call(Uri url, Duration timeout) async {
    calls.add(url);
    return _answer();
  }
}

List<RelayNode> _bothNodes() => const <RelayNode>[
      RelayNode(id: 'srvny', url: _here, isWriter: true),
      RelayNode(id: 'srvjp', url: 'https://srvjp.flowmic.app'),
    ];

void main() {
  test('🔴 single-node: no hop AND NO REQUEST', () async {
    // The ordering is the whole performance story. Every phone installed today
    // takes this path on every single reconnect.
    final _Fetcher f = _Fetcher(_bothNodes);
    final String? url = await planNodeHop(
      ack: _ack(),
      currentEndpoint: _here,
      fetch: f.call,
    );
    expect(url, isNull);
    expect(f.calls, isEmpty,
        reason: 'the ack alone answered it; asking the network would be a '
            'round trip per reconnect for every installation in the world');
  });

  test('same node on both sides: no hop and no request either', () async {
    final _Fetcher f = _Fetcher(_bothNodes);
    expect(
      await planNodeHop(
        ack: _ack(home: 'srvny', node: 'srvny'),
        currentEndpoint: _here,
        fetch: f.call,
      ),
      isNull,
    );
    expect(f.calls, isEmpty);
  });

  test('🔴 a real hop resolves to the PC\'s node, asking the CURRENT endpoint',
      () async {
    final _Fetcher f = _Fetcher(_bothNodes);
    final String? url = await planNodeHop(
      ack: _ack(home: 'srvjp', node: 'srvny'),
      currentEndpoint: _here,
      fetch: f.call,
    );
    expect(url, 'https://srvjp.flowmic.app');
    expect(f.calls.single, nodeListUri(_here),
        reason: 'the list must come from where we already are — that is what '
            'keeps a self-hosted pairing inside its own deployment');
  });

  group('🔴 a fetch that fails cannot move anyone', () {
    test('an empty list means stay put', () async {
      final _Fetcher f = _Fetcher(() => const <RelayNode>[]);
      expect(
        await planNodeHop(
          ack: _ack(home: 'srvjp', node: 'srvny'),
          currentEndpoint: _here,
          fetch: f.call,
        ),
        isNull,
      );
      expect(f.calls, hasLength(1), reason: 'positive control: it did ask');
    });

    test('a list that does not contain the wanted node means stay put',
        () async {
      final _Fetcher f = _Fetcher(() => const <RelayNode>[
            RelayNode(id: 'srvny', url: _here),
          ]);
      expect(
        await planNodeHop(
          ack: _ack(home: 'srvde', node: 'srvny'),
          currentEndpoint: _here,
          fetch: f.call,
        ),
        isNull,
      );
    });
  });

  test('🔴 a list that maps a different id onto the SAME address is not a hop',
      () async {
    // Otherwise an alias or a CNAME in the operator's list would produce an
    // endless reconnect: move, land on the same host, be told to move again.
    final _Fetcher f = _Fetcher(() => const <RelayNode>[
          RelayNode(id: 'srvny-alias', url: _here),
        ]);
    expect(
      await planNodeHop(
        ack: _ack(home: 'srvny-alias', node: 'srvny'),
        currentEndpoint: _here,
        fetch: f.call,
      ),
      isNull,
    );
  });

  test('a trailing slash on either side is not a difference', () async {
    final _Fetcher f = _Fetcher(() => const <RelayNode>[
          RelayNode(id: 'srvny-alias', url: '$_here/'),
        ]);
    expect(
      await planNodeHop(
        ack: _ack(home: 'srvny-alias', node: 'srvny'),
        currentEndpoint: _here,
        fetch: f.call,
      ),
      isNull,
    );
  });

  test('🔴 a DRAINED node is still followed', () async {
    // `selectable:false` withdraws a node from being CHOSEN by new PCs. A phone
    // whose PC is already registered there must still reach it, or draining
    // would strand exactly the pairings the operator is migrating gently.
    final _Fetcher f = _Fetcher(() => const <RelayNode>[
          RelayNode(id: 'srvny', url: _here, isWriter: true),
          RelayNode(
            id: 'srvjp',
            url: 'https://srvjp.flowmic.app',
            selectable: false,
          ),
        ]);
    expect(
      await planNodeHop(
        ack: _ack(home: 'srvjp', node: 'srvny'),
        currentEndpoint: _here,
        fetch: f.call,
      ),
      'https://srvjp.flowmic.app',
    );
  });
}
