// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §2 (how a
//     node is chosen, and why the probe must be application-level)
//   apps/desktop/src-tauri/src/socket/node_select.rs (the desktop's version of
//     this decision — same rules, same numbers, stated once per client because
//     they share no runtime)
//
// WHEN THERE IS NO PC TO FOLLOW, THE PHONE PICKS FOR ITSELF.
//
// 🔴 THE GAP THIS CLOSES, MEASURED 2026-08-31. The whole multi-node design rests
// on 「the desktop selects, the phone follows its PC」, and that is right for a
// paired session because rooms are per-process: a phone on a different node from
// its PC is not in a slow room, it is in a different one. But a light-record
// ("FlowMic Cloud") session HAS NO PC. Its `pc_devices` row is virtual, nothing
// ever connects to it as a PC, and so nothing ever stamps `home_node` — measured
// on the writer's database that day: every FlowMic Cloud row's home_node is
// NULL. `nodeToFollow` therefore answers 「stay put」 forever, and the phone sits
// on the endpoint it was first given (flowmic.app = the writer, New York) no
// matter where in the world it is. From a mainland tablet the same afternoon:
// 1026 ms to that node, 215 ms to the nearest one.
//
// ⇒ 「follow your PC」 and 「there is no PC」 are two different situations, and
// only the first one has a reason to refuse to choose.
//
// 🔴 AND WHY THIS IS SAFE HERE AND WOULD NOT BE FOR A PAIRED SESSION. The reason
// the phone must not choose for itself normally is that it would leave the room
// its PC is in, and `mirrorToPc` drops audio for an absent PC with no error, no
// refusal and no log. A light-record session mirrors to nobody. There is no room
// to leave, so the constraint that produced the rule does not apply.
//
// ⚠️ SAME NUMBERS AS THE DESKTOP, DELIBERATELY. A node must beat the one in use
// by [kStickyMarginMs] before a reconnect is worth it, and a spread under
// [kNoiseFloorMs] is not distance at all — five VPS measured a 3 ms spread of
// TLS handshake to one host whose real sessions spanned 44→279 ms. Choosing on
// readings that flat produces a confident, arbitrary answer that never looks
// wrong, which is the failure this floor exists to refuse.
//
// ⚠️ ONE DIFFERENCE FROM THE DESKTOP, STATED RATHER THAN HIDDEN: it takes the
// MIN of its probe rounds and this takes the MEDIAN, because the median is what
// `probeNode` already computes and what the settings panel already shows the
// user. Same source, same route, same rounds — a user comparing the panel with
// what got chosen must not find two different numbers.

import 'dart:async';

import '../diag/diag_log.dart' show diag;
import '../session/node_latency.dart';
import 'node_follow.dart';
import 'node_list_client.dart';

/// A challenger must be at least this much faster before we drop a live socket.
const int kStickyMarginMs = 25;

/// Below this spread the readings are not distance — refuse to choose.
const int kNoiseFloorMs = 20;

/// Where this phone should move to, or `null` to stay exactly where it is.
///
/// `null` — stay — in every one of these cases, and each is the honest answer
/// rather than a fallback:
///   · the ack names a `home_node`: there IS a PC to follow, and following it is
///     [planNodeHop]'s job, not this one's;
///   · the deployment publishes fewer than two selectable nodes: nothing to
///     choose between (which is every single-node deployment);
///   · the directory could not be read: a hop we cannot resolve is not a reason
///     to guess;
///   · fewer than two nodes answered the probe: one reading is not a comparison;
///   · the spread is under the noise floor: see the header;
///   · the winner is not better than where we are by [kStickyMarginMs];
///   · the winner resolves to the address we are already dialling.
Future<String?> planSelfNodeHop({
  required Object? ack,
  required String currentEndpoint,
  required NodeListFetcher fetch,
  NodePinger probe = httpNodePing,
  Duration probeTimeout = const Duration(seconds: 5),
}) async {
  // A paired session is not ours to route. `nodeToFollow` owns that, and two
  // authors for 「which node am I on」 is exactly what this repo keeps paying for.
  if (pcHomeNodeOf(ack) != null) return null;
  final String? here = answeringNode(ack);
  if (here == null) return null; // single-node relay: it does not name itself

  final List<RelayNode> nodes;
  try {
    nodes = await fetch(nodeListUri(currentEndpoint), kNodeListTimeout);
  } on Object {
    diag('node.self.unreadable', const <String, Object?>{});
    return null;
  }
  final List<RelayNode> candidates = nodes
      .where((RelayNode n) => n.selectable && n.url.startsWith('https://'))
      .toList();
  if (candidates.length < 2) return null;

  final List<NodeLatency> timed = <NodeLatency>[];
  for (final RelayNode n in candidates) {
    final NodeLatency r = await probeNode(n.id, n.url, ping: probe, timeout: probeTimeout);
    if (r.ok) timed.add(r);
  }
  if (timed.length < 2) {
    diag('node.self.too_few_answers', <String, Object?>{'n': timed.length});
    return null;
  }
  timed.sort((NodeLatency a, NodeLatency b) => a.totalMs!.compareTo(b.totalMs!));
  final int spread = timed.last.totalMs! - timed.first.totalMs!;
  if (spread < kNoiseFloorMs) {
    diag('node.self.below_floor', <String, Object?>{'spread': spread});
    return null;
  }

  final NodeLatency best = timed.first;
  // What we are on now, if it answered at all. Absent ⇒ nothing to beat, and the
  // winner wins outright: a node that did not answer is not a node we should
  // stay on to be polite.
  final NodeLatency? mine = timed.where((NodeLatency r) => r.id == here).firstOrNull;
  if (mine != null && mine.totalMs! <= best.totalMs! + kStickyMarginMs) {
    diag('node.self.kept', <String, Object?>{'node': here, 'ms': mine.totalMs});
    return null;
  }
  if (_sameEndpoint(best.url, currentEndpoint)) return null;

  diag('node.self.moving', <String, Object?>{
    'to': best.id, 'ms': best.totalMs, 'from': here, 'spread': spread,
  });
  return best.url;
}

/// Host-and-scheme comparison, so a trailing slash or a case difference cannot
/// be read as 「a different node」 and produce a reconnect to where we already are.
bool _sameEndpoint(String a, String b) {
  final Uri? ua = Uri.tryParse(a.trim());
  final Uri? ub = Uri.tryParse(b.trim());
  if (ua == null || ub == null) return false;
  return ua.host.toLowerCase() == ub.host.toLowerCase()
      && ua.scheme.toLowerCase() == ub.scheme.toLowerCase();
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
