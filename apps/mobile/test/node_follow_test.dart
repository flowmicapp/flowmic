// Phone-follows-PC — the decision, in isolation.
//
// SPEC-REF:
//   apps/mobile/lib/src/signaling/node_follow.dart
//   packages/protocol/src/protocol-schemas-auth.ts
//     (MobileReconnectAckNodeFieldsSchema)
//
// 🔴 THE FIRST GROUP IS THE ONE THAT MATTERS AND IT IS DELIBERATELY THE
// LONGEST. Every FlowMic handset in the world will see neither node field until
// an operator turns a node list on, and most will never see them. If absence
// ever stopped meaning 「stay exactly where you are」, every one of those phones
// would start dialling somewhere on the strength of a field it never received —
// and none of them can tell us it happened.
//
// So absence is not tested as one case. It is tested as every shape absence can
// arrive in: missing, null, empty, wrong type, one side only, and an ack that is
// not a Map at all because the call timed out.

import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> _ack({Object? home, Object? node}) => <String, Object?>{
      // A real ack carries much more; these two are the only keys this
      // decision reads, and the rest is here to prove it ignores them.
      'error': null,
      'pc_id': 'pc-1',
      'retry_after_ms': null,
      'home_node': ?home,
      'node': ?node,
    };

void main() {
  group('🔴 absence means single-node — the assertion protecting every phone '
      'already installed', () {
    test('neither field: no hop', () {
      expect(nodeToFollow(_ack()), isNull);
    });

    test('only home_node: no hop', () {
      // A relay that learned to stamp the PC's node but not to name itself.
      // The phone's question is a COMPARISON and half of one is not an answer.
      expect(nodeToFollow(_ack(home: 'srvjp')), isNull);
    });

    test('only node: no hop', () {
      expect(nodeToFollow(_ack(node: 'srvny')), isNull);
    });

    test('explicit nulls: no hop', () {
      expect(
        nodeToFollow(<String, Object?>{'home_node': null, 'node': null}),
        isNull,
      );
    });

    test('🔴 empty strings: no hop, and never an empty dial', () {
      // The schema refuses `min(1)`, so an empty string means we are not
      // talking to what we think we are. Doing nothing is the only safe
      // reading of an answer we cannot parse.
      expect(nodeToFollow(_ack(home: '', node: 'srvny')), isNull);
      expect(nodeToFollow(_ack(home: 'srvjp', node: '')), isNull);
      expect(nodeToFollow(_ack(home: '', node: '')), isNull);
    });

    test('wrong types: no hop', () {
      for (final Object bad in <Object>[42, true, <String>['srvjp'], <String, Object?>{}]) {
        expect(nodeToFollow(_ack(home: bad, node: 'srvny')), isNull,
            reason: 'home_node: $bad');
        expect(nodeToFollow(_ack(home: 'srvjp', node: bad)), isNull,
            reason: 'node: $bad');
      }
    });

    test('a non-Map ack: no hop', () {
      // What a timeout or a throw leaves behind upstream.
      for (final Object? bad in <Object?>[null, 'nope', 7, <int>[1]]) {
        expect(nodeToFollow(bad), isNull, reason: '$bad');
      }
    });

    test('same node on both sides: no hop', () {
      expect(nodeToFollow(_ack(home: 'srvny', node: 'srvny')), isNull);
    });
  });

  group('the hop itself', () {
    test('🔴 different nodes: follow the PC, and return ITS id', () {
      expect(nodeToFollow(_ack(home: 'srvjp', node: 'srvny')), 'srvjp');
      // The other direction too — the phone follows the PC wherever it is,
      // never toward some node it prefers.
      expect(nodeToFollow(_ack(home: 'srvny', node: 'srvjp')), 'srvny');
    });

    test('ids are compared exactly — no case folding, no trimming', () {
      // A node id is a subdomain and the DB value in pc_devices.home_node.
      // Folding two spellings together here would let a phone conclude it is
      // already in the right place when it is not, which is the failure with
      // no symptom.
      expect(nodeToFollow(_ack(home: 'SRVNY', node: 'srvny')), 'SRVNY');
      expect(nodeToFollow(_ack(home: ' srvny', node: 'srvny')), ' srvny');
    });
  });

  group('resolveNodeUrl', () {
    const List<RelayNode> nodes = <RelayNode>[
      RelayNode(id: 'srvny', url: 'https://srvny.flowmic.app', isWriter: true),
      RelayNode(id: 'srvjp', url: 'https://srvjp.flowmic.app', selectable: false),
    ];

    test('resolves an id to its url', () {
      expect(resolveNodeUrl(nodes, 'srvjp'), 'https://srvjp.flowmic.app');
    });

    test('🔴 a DRAINED node still resolves — draining is about selection, not '
        'about reachability', () {
      // srvjp above is `selectable:false`. A phone whose PC is registered there
      // must still be able to reach it, or draining a node would strand exactly
      // the pairings the operator is migrating gently.
      expect(resolveNodeUrl(nodes, 'srvjp'), isNotNull);
    });

    test('an id the list does not know resolves to null — stay put', () {
      expect(resolveNodeUrl(nodes, 'srvde'), isNull);
      expect(resolveNodeUrl(const <RelayNode>[], 'srvny'), isNull);
    });
  });

  group('parseNodeList', () {
    test('reads a list, and the {nodes:[...]} envelope', () {
      final List<Object?> rows = <Object?>[
        <String, Object?>{
          'id': 'srvny',
          'url': 'https://srvny.flowmic.app',
          'region': 'us-east',
          'role': 'writer',
        },
        <String, Object?>{
          'id': 'srvjp',
          'url': 'https://srvjp.flowmic.app/',
          'selectable': false,
        },
      ];
      for (final Object? body in <Object?>[
        rows,
        <String, Object?>{'nodes': rows},
      ]) {
        final List<RelayNode> got = parseNodeList(body);
        expect(got.length, 2);
        expect(got[0].id, 'srvny');
        expect(got[0].isWriter, isTrue);
        expect(got[0].selectable, isTrue, reason: 'absent selectable = offered');
        expect(got[1].url, 'https://srvjp.flowmic.app',
            reason: 'the trailing slash is stripped, as the server does');
        expect(got[1].selectable, isFalse);
        expect(got[1].isWriter, isFalse);
      }
    });

    test('🔴 an unreadable list is EMPTY, never an error', () {
      // A single-node deployment does not serve this route, and an old one does
      // not know it. Both must read as "stay where you are" rather than as a
      // fault worth telling anybody about.
      for (final Object? bad in <Object?>[
        null,
        'nope',
        42,
        <String, Object?>{'nodes': 'not a list'},
      ]) {
        expect(parseNodeList(bad), isEmpty, reason: '$bad');
      }
    });

    test('rows that cannot be dialled are dropped, not defaulted', () {
      final List<RelayNode> got = parseNodeList(<Object?>[
        <String, Object?>{'url': 'https://no-id.example'},
        <String, Object?>{'id': '   ', 'url': 'https://blank-id.example'},
        <String, Object?>{'id': 'nourl'},
        // 🔴 http, not https: the server refuses it and so does this. A row we
        // keep is a row that can become a dial.
        <String, Object?>{'id': 'insecure', 'url': 'http://plain.example'},
        <String, Object?>{'id': 'ok', 'url': 'https://ok.example'},
      ]);
      expect(got.map((RelayNode n) => n.id), <String>['ok']);
    });

    test('🔴 an unrecognised role does not promote a replica', () {
      // Exact match only. A typo must not be able to send first contact to a
      // node whose copy is seconds behind.
      final List<RelayNode> got = parseNodeList(<Object?>[
        <String, Object?>{'id': 'a', 'url': 'https://a.example', 'role': 'Writer'},
        <String, Object?>{'id': 'b', 'url': 'https://b.example', 'role': 'primary'},
        <String, Object?>{'id': 'c', 'url': 'https://c.example', 'role': true},
      ]);
      expect(got.every((RelayNode n) => !n.isWriter), isTrue);
    });
  });

  test('🔴 END TO END, the shape that must never move a phone off a '
      'self-hosted relay', () {
    // A pairing's endpoint is not always ours — `addByCode` stores whatever the
    // user typed or scanned. The protection is structural rather than a check:
    // an id is only ever resolved against a list SERVED BY THE ENDPOINT THE
    // PHONE IS ALREADY TALKING TO, and there is no built-in list to fall back
    // on. A self-hosted deployment either serves no list (single-node ⇒ the ack
    // fields are absent ⇒ no hop) or serves its own, and the phone then moves
    // within that operator's deployment.
    //
    // Asserted here as the composition, because neither half says it alone.
    final String? hop = nodeToFollow(_ack(home: 'their-node-2', node: 'their-node-1'));
    expect(hop, 'their-node-2');

    final List<RelayNode> operatorsOwnList = parseNodeList(<Object?>[
      <String, Object?>{'id': 'their-node-1', 'url': 'https://relay1.someone-else.example'},
      <String, Object?>{'id': 'their-node-2', 'url': 'https://relay2.someone-else.example'},
    ]);
    expect(resolveNodeUrl(operatorsOwnList, hop!),
        'https://relay2.someone-else.example');

    // And our own node ids mean nothing against their list.
    expect(resolveNodeUrl(operatorsOwnList, 'srvny'), isNull);
  });
}
