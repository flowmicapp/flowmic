// SPEC-REF: lib/src/signaling/node_self_select.dart
//
// 🔴 THE DEFECT THIS PINS, MEASURED ON PRODUCTION 2026-08-31. A light-record
// ("FlowMic Cloud") session has a virtual `pc_devices` row that nothing ever
// connects to as a PC, so its `home_node` is NULL — every such row on the
// writer, checked that day. The phone follows its PC, there is no PC, so it
// followed nothing and stayed on the address it was first handed (the writer, in
// New York) wherever in the world it was. From a mainland tablet the same
// afternoon: 1026 ms to that node, 215 ms to the nearest one.
//
// The four assertions that carry weight here are the REFUSALS. Choosing when we
// should not is worse than not choosing: a paired session that wanders off its
// PC's node lands in a different room, and `mirrorToPc` drops audio for an
// absent PC with no error, no refusal and no log.

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/session/node_latency.dart';
import 'package:flowmic/src/signaling/node_follow.dart';
import 'package:flowmic/src/signaling/node_self_select.dart';

const String kUs = 'https://srvny.flowmic.app';
const String kJp = 'https://srvjp.flowmic.app';
const String kHk = 'https://srvasia02.flowmic.app';

const List<RelayNode> kThree = <RelayNode>[
  RelayNode(id: 'srvny', url: kUs, isWriter: true, short: 'us'),
  RelayNode(id: 'srvjp', url: kJp, short: 'asia'),
  RelayNode(id: 'srvasia02', url: kHk, short: 'hk'),
];

Future<List<RelayNode>> Function(Uri, Duration) _fetch(List<RelayNode> nodes) =>
    (Uri _, Duration _) async => nodes;

Future<List<RelayNode>> Function(Uri, Duration) get _failingFetch =>
    (Uri _, Duration _) async => throw StateError('offline');

/// A pinger with a fixed answer per node id. `null` ⇒ that node never answers.
NodePinger _ping(Map<String, int?> ms) =>
    (String id, String url, Duration _) async => ms[id] == null
        ? NodeLatency(id: id, url: url, miss: 'timeout')
        : NodeLatency(id: id, url: url, edgeMs: 10, totalMs: ms[id]);

/// The reconnect ack for a session with NO paired PC — what a light-record
/// session actually receives (`home_node` absent because the column is NULL).
Map<String, Object?> _cloudAck({String node = 'srvny'}) =>
    <String, Object?>{'node': node};

void main() {
  test('🔴 with no PC to follow it moves to the node that answered fastest',
      () async {
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': 1435, 'srvasia02': 215}),
    );
    expect(move, kHk);
  });

  test('🔴 REFUSAL: a paired session is never routed by this function', () async {
    // `home_node` present ⇒ there IS a PC, and following it is planNodeHop's
    // job. Two authors for 「which node am I on」 is the shape this repo pays for.
    final String? move = await planSelfNodeHop(
      ack: <String, Object?>{'node': 'srvny', 'home_node': 'srvny'},
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': 1435, 'srvasia02': 215}),
    );
    expect(move, isNull);
  });

  test('🔴 REFUSAL: readings below the noise floor are not distance', () async {
    // Five VPS measured a 3 ms spread of handshake to one host whose real
    // sessions spanned 44→279 ms. Choosing on a flat spread produces a
    // confident, arbitrary answer that never looks wrong.
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 210, 'srvjp': 215, 'srvasia02': 218}),
    );
    expect(move, isNull);
  });

  test('🔴 REFUSAL: a challenger must beat where we are by the sticky margin',
      () async {
    // 30 ms better is worth a dropped socket; 10 ms is not.
    expect(
      await planSelfNodeHop(
        ack: _cloudAck(),
        currentEndpoint: kUs,
        fetch: _fetch(kThree),
        probe: _ping(<String, int?>{'srvny': 250, 'srvjp': 400, 'srvasia02': 240}),
      ),
      isNull,
      reason: '10 ms is inside the margin',
    );
    expect(
      await planSelfNodeHop(
        ack: _cloudAck(),
        currentEndpoint: kUs,
        fetch: _fetch(kThree),
        probe: _ping(<String, int?>{'srvny': 250, 'srvjp': 400, 'srvasia02': 200}),
      ),
      kHk,
      reason: '50 ms is outside it',
    );
  });

  test('🔴 REFUSAL: an unreadable directory is not a reason to guess', () async {
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _failingFetch,
      probe: _ping(<String, int?>{'srvny': 1026}),
    );
    expect(move, isNull);
  });

  test('REFUSAL: fewer than two selectable nodes is not a choice', () async {
    const List<RelayNode> drained = <RelayNode>[
      RelayNode(id: 'srvny', url: kUs, isWriter: true),
      RelayNode(id: 'srvjp', url: kJp, selectable: false),
      RelayNode(id: 'srvasia02', url: kHk, selectable: false),
    ];
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _fetch(drained),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': 20, 'srvasia02': 20}),
    );
    expect(move, isNull);
  });

  test('REFUSAL: one answer is not a comparison', () async {
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': null, 'srvasia02': null}),
    );
    expect(move, isNull);
  });

  test('REFUSAL: a single-node relay does not name itself, so nothing is chosen',
      () async {
    final String? move = await planSelfNodeHop(
      ack: const <String, Object?>{}, // no `node` field at all
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': 1435, 'srvasia02': 215}),
    );
    expect(move, isNull);
  });

  test('the node we are on need not answer — a dead node is not worth staying on',
      () async {
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(),
      currentEndpoint: kUs,
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': null, 'srvjp': 400, 'srvasia02': 215}),
    );
    expect(move, kHk);
  });

  test('a winner that resolves to the address we already dial is not a hop',
      () async {
    // Guards the pointless reconnect: a directory that maps a different id onto
    // the same host must not be read as 「somewhere else」.
    final String? move = await planSelfNodeHop(
      ack: _cloudAck(node: 'srvasia02'),
      currentEndpoint: '$kHk/',
      fetch: _fetch(kThree),
      probe: _ping(<String, int?>{'srvny': 1026, 'srvjp': 1435, 'srvasia02': 215}),
    );
    expect(move, isNull);
  });
}
