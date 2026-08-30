// owner 2026-08-30 — 「手机在检查与电脑的连接状态时应先尝试获取 PC 端连接的节点，
// 然后直接连接对应的节点获取连接状态，这应该是可以做到确定性的」.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §3;
//   apps/server-core/src/http/presence-routes.ts (`pc_online` = this process's
//   room membership); apps/server-core/src/room/store.ts ("Live socket presence
//   ONLY", a per-process Map).
//
// ── THE DEFECT THIS CLOSES, AND WHY IT ONLY BECAME REACHABLE TODAY ──────────
//
// `GET /api/pc/presence` answers from the ROOM STORE OF THE PROCESS THAT
// RECEIVES IT. Rooms are per-process. So a phone that asks node A about a PC
// living on node B is told, truthfully and uselessly, that its computer is not
// there — and nothing anywhere reports an error, because nothing is wrong with
// the answer. It is the right answer to the question that was asked, and the
// wrong question.
//
// Before 2026-08-30 this could not happen: `srvjp` was published with
// `selectable:false`, so every client was on the writer. The owner turned it on
// that day, which turned a latent design note into a live one.
//
// ── WHY `home_node` AND NOT `GET /api/node/locate` ──────────────────────────
//
// The design's §3-2 reached for `locate`, and `locate` is real and already
// deployed. But it is keyed on the PCID, which this app does not hold — and it
// is a SECOND question, over the network, that can fail on its own.
//
// The ack already answers the first one: `home_node` is on every
// `mobile:reconnect` / `mobile:pair` ack, from the same instant and the same
// row. Using it costs no request and cannot fail separately. `locate` stays the
// right tool for the case this cannot serve (a phone with no fresh ack), and
// that case falls back to today's behaviour rather than to a guess.
//
// 🔴 EVERY FAILURE FALLS BACK TO 「ASK WHOEVER I AM TALKING TO」, WHICH IS
// EXACTLY TODAY'S BEHAVIOUR — never to 「the computer is offline」. That is the
// whole safety argument of this file: the worst case is the status quo.

import '../signaling/node_follow.dart';

/// Where to send `GET /api/pc/presence` for this pairing.
///
/// [currentEndpoint] is the address this phone is dialling (today's target, and
/// the fallback for everything below). [homeNode] is the PC's node id from the
/// last ack — null on LAN, on a single-node deployment, and on a relay too old
/// to send it. [nodes] is whatever node directory this app has read.
///
/// Returns [currentEndpoint] unchanged whenever it cannot do better, so the
/// caller has no 「could not decide」 branch to forget.
String presenceEndpointFor({
  required String currentEndpoint,
  String? homeNode,
  List<RelayNode> nodes = const <RelayNode>[],
}) {
  final String here = currentEndpoint.trim();
  final String want = (homeNode ?? '').trim();
  if (here.isEmpty || want.isEmpty || nodes.isEmpty) return currentEndpoint;
  final String? url = resolveNodeUrl(nodes, want);
  if (url == null) {
    // The directory does not know this node. That is 「we could not resolve it」,
    // and resolving is not something to improvise — the same rule
    // `planNodeHop` follows before a hop, for the same reason.
    return currentEndpoint;
  }
  return url;
}

/// True when the presence answer we are about to get CANNOT be trusted to mean
/// 「that computer is not running」.
///
/// 🔴 THE SECOND HALF OF THE FIX, AND THE ONE THAT MATTERS WHEN THE FIRST FAILS.
/// Routing to the right node is best-effort: the directory can be unread, the
/// ack can be old, the PC can have moved a second ago. When we KNOW we asked a
/// node that is not the PC's, a `pc_online:false` establishes nothing about the
/// computer — it establishes something about that node's room. Reporting it as
/// 「电脑已离线」 would be this repo's #1 shape with a network hop in the middle.
///
/// The caller turns a `false` into [PcPresence.unknown] in that case, which the
/// hold then covers (liveness_hold.dart) — so the screen keeps the last thing
/// that was actually established instead of acquiring a new, wrong certainty.
bool presenceAnswerIsAboutAnotherNode({
  required String askedEndpoint,
  String? homeNode,
  List<RelayNode> nodes = const <RelayNode>[],
}) {
  final String want = (homeNode ?? '').trim();
  if (want.isEmpty || nodes.isEmpty) return false; // nothing says otherwise
  final String? homeUrl = resolveNodeUrl(nodes, want);
  if (homeUrl == null) return false; // we cannot tell; do not invent doubt
  return !_sameHost(homeUrl, askedEndpoint);
}

bool _sameHost(String a, String b) {
  final Uri? ua = Uri.tryParse(a);
  final Uri? ub = Uri.tryParse(b);
  if (ua == null || ub == null) return a == b;
  return ua.host.toLowerCase() == ub.host.toLowerCase();
}
