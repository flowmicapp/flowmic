// owner 2026-08-30 — 「考虑在手机端的设置中增加所有节点的连接设置，能够看到
// 本机-CF延时-中继节点延时 = 总延时 的信息以方便了解网络情况」.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §4;
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §2-2.
//
// ── THE DECOMPOSITION IS MEASURED, NOT ESTIMATED ────────────────────────────
//
//   · 本机 → 边缘  = the time to get a connected, TLS-negotiated socket. Under
//     Cloudflare that terminates at the nearest EDGE, so this is the distance
//     to it and to nothing else;
//   · 边缘 → 节点  = total − edge. The hop to the origin, plus the origin's own
//     work on the request;
//   · 总          = the application-layer round trip to /api/node/ping.
//
// 🔴 THIS IS THE EXACT NUMBER §2-2 FORBIDS AS A SELECTION CRITERION, AND THAT
// IS NOT A CONTRADICTION — IT IS THE REASON THIS PANEL IS USEFUL. Five VPSes
// measured 7/8/10/9/10 ms of TLS handshake to the same host while their real
// sessions spanned 44→279 ms: the handshake answers 「how far is your edge」 and
// nothing else, so choosing on it picks a node at random with great confidence.
// Shown BESIDE the total, the same number is the one thing that tells a user
// WHICH HALF is slow — their own link, or the ocean.
//
// ⚠️ The panel this feeds is INFORMATION, not a control: the desktop selects a
// node, the phone follows its PC (multi-node design §4-1, and that following is
// what removes cross-node room sync from the whole design). Copy must not imply
// a choice, and there is deliberately no 「use this node」 button — a control
// that changed nothing would be worse than no control (R8).

import 'dart:async';
import 'dart:io';

/// One node's three numbers, or the reason there are none.
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

  /// Connect + TLS: the distance to the nearest Cloudflare edge.
  final int? edgeMs;

  /// The whole application-layer round trip.
  final int? totalMs;

  /// Why there are no numbers — `timeout`, `network`, `tls`, `status`,
  /// `malformed`. Non-null IFF the other two are null.
  ///
  /// 🔴 A FAILURE IS NAMED, NEVER DRAWN AS A LARGE NUMBER. A row that showed
  /// 「9999 ms」 for an unreachable node would be sortable, comparable and
  /// wrong: it is not slow, it did not answer, and those two have different
  /// answers for the person reading.
  final String? miss;

  /// Edge → origin, the hop this panel exists to expose. Null when either half
  /// is missing — never 0, which would read as 「instant」.
  int? get originMs {
    final int? t = totalMs;
    final int? e = edgeMs;
    if (t == null || e == null) return null;
    // Clamped at 0 rather than allowed negative: the two clocks are the same
    // clock, so a negative can only come from timer granularity, and a negative
    // millisecond on a screen is a bug report about us.
    return t - e < 0 ? 0 : t - e;
  }

  bool get ok => totalMs != null;
}

/// The seam. Production is [httpNodePing]; tests supply their own.
typedef NodePinger = Future<NodeLatency> Function(
    String id, String url, Duration timeout);

/// The median of the samples that answered, per node.
///
/// 🔴 MEDIAN, NOT MEAN, and not 「best of」. One request landing on a cold
/// connection or a retried TLS is normal and would drag a mean; taking the best
/// would flatter a node that is usually slow. Three samples, middle one —
/// the same rule the desktop selector uses (multi-node design §2-2), because
/// the panel and the selector must not be able to disagree about what a node's
/// latency IS.
NodeLatency medianOf(String id, String url, List<NodeLatency> samples) {
  final List<NodeLatency> good = samples.where((NodeLatency s) => s.ok).toList()
    ..sort((NodeLatency a, NodeLatency b) => a.totalMs!.compareTo(b.totalMs!));
  if (good.isEmpty) {
    return NodeLatency(
      id: id,
      url: url,
      // The first named failure, or a generic one. Named beats counted: the
      // user's next move differs between 「timed out」 and 「TLS refused」.
      miss: samples.isEmpty ? 'unmeasured' : (samples.first.miss ?? 'unexpected'),
    );
  }
  return good[good.length ~/ 2];
}

/// Three samples against one node, sequentially.
///
/// ⚠️ SEQUENTIAL ON PURPOSE. Three concurrent requests share one radio and one
/// TCP slow-start; they would measure each other. This panel is opened by hand,
/// so the extra second costs nothing that matters.
Future<NodeLatency> probeNode(
  String id,
  String url, {
  NodePinger ping = httpNodePing,
  Duration timeout = const Duration(seconds: 5),
  int rounds = 3,
}) async {
  final List<NodeLatency> samples = <NodeLatency>[];
  for (int i = 0; i < rounds; i++) {
    samples.add(await ping(id, url, timeout));
  }
  return medianOf(id, url, samples);
}

/// One application-layer round trip to `GET {url}/api/node/ping`, split.
///
/// ⚠️ THE ROUTE MUST NOT BE CACHEABLE, and the server already says so
/// (`cache-control: no-store` in node-routes.ts). A cached ping would be served
/// by the edge and this function would report a beautiful, meaningless number
/// — the failure mode §2-2 is about, arriving through the other door.
Future<NodeLatency> httpNodePing(String id, String url, Duration timeout) async {
  final HttpClient client = HttpClient()..connectionTimeout = timeout;
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
    // Drained before stopping the clock: a round trip that stops at the headers
    // is not the round trip a user experiences.
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
  } finally {
    client.close(force: true);
  }
}
