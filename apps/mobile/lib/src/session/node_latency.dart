// owner 2026-08-30 — 「考虑在手机端的设置中增加所有节点的连接设置，能够看到
// 本机-CF延时-中继节点延时 = 总延时 的信息以方便了解网络情况」.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4;
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §2-2;
//   docs/strategy/2026-09-01-lan-fable-work-package-2.md Card 1 (hot round trip).
//
// ── WHAT THE TWO NUMBERS ARE ───────────────────────────────────────────────
//
//   · Connect  = the first sample that answered. It pays TLS and a cold origin
//     fetch. Under Cloudflare that first round is handshake + origin, and it
//     is how this panel used to say **836 ms** for a path whose real RTT was
//     **67 ms**.
//   · Latency  = one round trip on the HOT connection: the minimum of the
//     samples AFTER that first success. That is the headline, and it is the
//     same definition the PC settings panel reports.
//
// 🔴 THE MIDDLE SUBTRACTION (total − edge) IS GONE FROM THE HEADLINE. It
// mixed a cold first round with a later one and answered a question nobody
// asked. The edge clock (`getUrl` completing) is still recorded on each raw
// ping for diagnostics; [hotOf] does not use it as the headline.
//
// ⚠️ The panel this feeds is INFORMATION, not a control: the desktop selects a
// node, the phone follows its PC (multi-node design §4-1, and that following is
// what removes cross-node room sync from the whole design). Copy must not imply
// a choice, and there is deliberately no 「use this node」 button — a control
// that changed nothing would be worse than no control (R8).

import 'dart:async';
import 'dart:io';

/// One node's two numbers, or the reason there are none.
class NodeLatency {
  const NodeLatency({
    required this.id,
    required this.url,
    this.edgeMs,
    this.totalMs,
    this.miss,
  });

  final String id;
  final String url;

  /// First successful sample's whole round trip: TLS + cold origin. Shown as
  /// "Connect". Not the headline.
  final int? edgeMs;

  /// Hot round-trip: the minimum of the samples AFTER the first success.
  /// Shown as "Latency". This is the number that must match the PC panel.
  final int? totalMs;

  /// Why there are no numbers — `timeout`, `network`, `tls`, `status`,
  /// `malformed`. Set when nothing answered.
  ///
  /// 🔴 A FAILURE IS NAMED, NEVER DRAWN AS A LARGE NUMBER. A row that showed
  /// 「9999 ms」 for an unreachable node would be sortable, comparable and
  /// wrong: it is not slow, it did not answer, and those two have different
  /// answers for the person reading.
  final String? miss;

  /// Edge → origin on a SINGLE constructed sample. Null when either half is
  /// missing — never 0, which would read as 「instant」. The panel no longer
  /// paints this (it mixed cold and hot); the getter stays so a raw ping can
  /// still answer "which half of THIS request was the ocean".
  int? get originMs {
    final int? t = totalMs;
    final int? e = edgeMs;
    if (t == null || e == null) return null;
    return t - e < 0 ? 0 : t - e;
  }

  bool get ok => totalMs != null;
}

/// The seam. Production is [httpNodePing]; tests supply their own.
typedef NodePinger = Future<NodeLatency> Function(
    String id, String url, Duration timeout);

/// Headline aggregation: first success is connect, the rest are hot, the
/// reported latency is the **minimum** of the hot set.
///
/// ⚠️ Do not take the median of all three: for `[836, 67, 70]` that is 70,
/// which still mixes the cold sample into the headline. The reverse control
/// for this function is to put the first sample back into the headline and
/// watch that sequence report 836.
NodeLatency hotOf(String id, String url, List<NodeLatency> samples) {
  final List<NodeLatency> good =
      samples.where((NodeLatency s) => s.ok).toList();
  if (good.isEmpty) {
    return NodeLatency(
      id: id,
      url: url,
      miss: samples.isEmpty ? 'unmeasured' : (samples.first.miss ?? 'unexpected'),
    );
  }
  final int connect = good.first.totalMs!;
  if (good.length == 1) {
    // One sample paid setup. That is not a hot round trip, so there is no
    // headline — named unanswered, never a huge number.
    return NodeLatency(id: id, url: url, edgeMs: connect);
  }
  int rtt = good[1].totalMs!;
  for (int i = 2; i < good.length; i++) {
    final int t = good[i].totalMs!;
    if (t < rtt) rtt = t;
  }
  return NodeLatency(id: id, url: url, edgeMs: connect, totalMs: rtt);
}

/// Three samples against one node, sequentially.
///
/// ⚠️ SEQUENTIAL ON PURPOSE. Three concurrent requests share one radio and one
/// TCP slow-start; they would measure each other. This panel is opened by hand,
/// so the extra second costs nothing that matters.
///
/// Production reuses one [HttpClient] across the rounds so rounds 2 and 3
/// ride a hot connection. The previous implementation opened and
/// `close(force: true)`'d a client per ping, so every sample was cold — that
/// is the 836 ms number. Tests that pass a fake [ping] still go through the
/// seam and do not need a real client.
Future<NodeLatency> probeNode(
  String id,
  String url, {
  NodePinger ping = httpNodePing,
  Duration timeout = const Duration(seconds: 5),
  int rounds = 3,
}) async {
  HttpClient? owned;
  final NodePinger effective;
  if (identical(ping, httpNodePing)) {
    owned = HttpClient()..connectionTimeout = timeout;
    effective = (String i, String u, Duration t) =>
        pingOnClient(owned!, i, u, t);
  } else {
    effective = ping;
  }
  try {
    final List<NodeLatency> samples = <NodeLatency>[];
    for (int i = 0; i < rounds; i++) {
      samples.add(await effective(id, url, timeout));
    }
    return hotOf(id, url, samples);
  } finally {
    owned?.close(force: true);
  }
}

/// One application-layer round trip to `GET {url}/api/node/ping` on an
/// existing client (keep-alive).
Future<NodeLatency> pingOnClient(
  HttpClient client,
  String id,
  String url,
  Duration timeout,
) async {
  final Stopwatch sw = Stopwatch()..start();
  int? edge;
  try {
    final Uri uri = Uri.parse('$url/api/node/ping');
    // `getUrl` completes once the socket is connected and TLS is negotiated —
    // that instant IS the edge boundary under Cloudflare.
    final HttpClientRequest req = await client.getUrl(uri).timeout(timeout);
    edge = sw.elapsedMilliseconds;
    final HttpClientResponse res = await req.close().timeout(timeout);
    if (res.statusCode != 200) {
      unawaited(res.drain<void>().catchError((Object _) {}));
      return NodeLatency(id: id, url: url, miss: 'status');
    }
    await res.drain<void>().timeout(timeout);
    return NodeLatency(
        id: id, url: url, edgeMs: edge, totalMs: sw.elapsedMilliseconds);
  } on TimeoutException {
    return NodeLatency(id: id, url: url, miss: 'timeout');
  } on SocketException {
    return NodeLatency(id: id, url: url, miss: 'network');
  } on HandshakeException {
    return NodeLatency(id: id, url: url, miss: 'tls');
  } on Object {
    return NodeLatency(id: id, url: url, miss: 'unexpected');
  }
}

/// One-shot ping: a fresh client, closed after the sample. Used as the
/// [NodePinger] default so tests that call it directly still compile; production
/// [probeNode] does not go through this (it would make every round cold).
Future<NodeLatency> httpNodePing(String id, String url, Duration timeout) async {
  final HttpClient client = HttpClient()..connectionTimeout = timeout;
  try {
    return await pingOnClient(client, id, url, timeout);
  } finally {
    client.close(force: true);
  }
}
