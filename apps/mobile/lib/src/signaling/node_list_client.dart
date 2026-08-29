// SPEC-REF:
//   apps/server-core/src/http/node-routes.ts (GET /api/node/list)
//   apps/mobile/lib/src/signaling/node_follow.dart (the PURE half — what a
//     believable list looks like and what to do with it)
//   apps/mobile/lib/src/auth/cloud_summary.dart (httpCloudSummaryFetch — the
//     discipline this copies: ONE deadline for the whole attempt, catch Object
//     not Exception, one diag line only on a miss)
//
// The WIRE half of phone-follows-PC: where to ask and how. The DECISION is
// `node_follow.dart` and stays pure; this file owns nothing but the fetch.
//
// ── 🔴 NO BEARER, AND THAT IS THE ROUTE'S DESIGN RATHER THAN AN OVERSIGHT ───
//
// `/api/node/list` is public and unauthenticated on purpose: a client may need
// to know where to make FIRST contact, which is before it has anywhere to
// authenticate. Sending a token here would be handing a credential to a route
// that does not want one, on a host we may be about to stop talking to.
//
// ── 🔴 EVERY FAILURE IS AN EMPTY LIST ───────────────────────────────────────
//
// And that is not a swallowed failure. A single-node deployment does not serve
// this route at all and an older one does not know it, so 404 and 「could not
// reach it」 must both read as 「stay where you are」 — which is today's product,
// working. What keeps it honest is the diagnostic line: every miss says which
// kind it was, in the trail the user can upload. Nothing user-facing is raised,
// because there is nothing a user could do and nothing has gone wrong for them.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../diag/diag_log.dart' show diag;
import 'http_endpoint.dart' show httpBaseOf, httpEndpointUri;
import 'node_follow.dart';

/// The node-list URL for a relay endpoint.
///
/// Through the repo's ONE canonical [httpEndpointUri], never a second copy of
/// the `ws→http` rule — RV-89/RV-97's root cause was that the same rule had
/// several implementations, and the places without one were exactly the places
/// that broke.
Uri nodeListUri(String endpoint) =>
    httpEndpointUri(endpoint, '/api/node/list');

/// How long one node-list read may take, end to end.
///
/// Short on purpose. This runs on a reconnect, which is already a moment the
/// user is waiting through; a generous budget would turn 「we might be on the
/// wrong node」 into a stall on the path that was working.
const Duration kNodeListTimeout = Duration(seconds: 5);

/// Test seam. Production is [httpNodeListFetch]; a unit test supplies its own
/// and never touches the network.
///
/// ⚠️ No friendly default anywhere (13 册 §7 F1 ②): a caller either dials for
/// real or is handed one of these.
typedef NodeListFetcher = Future<List<RelayNode>> Function(
  Uri url,
  Duration timeout,
);

/// The production read: one plain GET.
///
/// Returns an empty list for every failure — see the header. The list is only
/// ever fetched from the endpoint the phone is ALREADY talking to, which is
/// what keeps a self-hosted pairing inside its own operator's deployment
/// (`node_follow.dart`, 「the direction this file must not take」).
Future<List<RelayNode>> httpNodeListFetch(Uri url, Duration timeout) async {
  final HttpClient client = HttpClient()..connectionTimeout = timeout;
  final DateTime deadline = DateTime.now().add(timeout);
  Duration left() {
    final Duration remaining = deadline.difference(DateTime.now());
    return remaining > Duration.zero ? remaining : const Duration(milliseconds: 1);
  }

  String miss = 'unexpected';
  int? code;
  List<RelayNode> out = const <RelayNode>[];
  try {
    final HttpClientRequest req = await client.getUrl(url).timeout(left());
    final HttpClientResponse res = await req.close().timeout(left());
    if (res.statusCode != 200) {
      // 404 is the ORDINARY answer from a single-node deployment, named
      // separately so a reader of the trail can tell 「this deployment has no
      // node list」 from 「we could not reach it」. Only one of those is worth
      // looking at twice.
      miss = res.statusCode == 404 ? 'notFound' : 'status';
      code = res.statusCode;
      unawaited(res.drain<void>().catchError((Object _) {}));
    } else {
      final String body = await res.transform(utf8.decoder).join().timeout(left());
      out = parseNodeList(jsonDecode(body) as Object?);
      if (out.isEmpty) miss = 'malformed';
    }
  } on TimeoutException {
    miss = 'timeout';
  } on SocketException catch (e) {
    miss = 'network';
    // The OS code only. The exception's `message` spells the HOST, and the
    // trail leaves the phone (diag_log.dart's rule).
    code = e.osError?.errorCode;
  } on TlsException {
    miss = 'tls';
  } on HttpException {
    miss = 'http';
  } on FormatException {
    miss = 'malformed';
  } on Object {
    miss = 'unexpected';
  } finally {
    client.close(force: true);
  }
  if (out.isEmpty) {
    final Map<String, Object?> line = <String, Object?>{'miss': miss};
    // Written as a statement rather than a collection-`if` so the line carries
    // `code` only when there IS one: a `'code': null` entry reads as 「we looked
    // and there was none」, a different claim.
    if (code != null) line['code'] = code;
    diag('node.list.miss', line);
  }
  return out;
}

/// Are these two endpoints the same address? FOR COMPARISON ONLY, never for
/// storage or for dialling — the same split `saas_endpoint.dart` makes with
/// `_normaliseForRetiredMatch`, and for the same reason.
///
/// 🔴 THE TRAILING SLASH IS WHY THIS EXISTS, and it is reachable. [httpBaseOf]
/// preserves everything after `://` VERBATIM, deliberately: its answer is also
/// what gets dialled, so it has no business editing a host. Meanwhile
/// `parseNodeList` strips trailing slashes from node urls, as the server's own
/// parser does. And a stored endpoint can carry one — `addByCode` keeps
/// whatever the user typed or scanned, and `https://relay.example/` is an
/// ordinary thing to type.
///
/// ⇒ without this, a stored `…app/` compared against a parsed `…app` reads as
/// a DIFFERENT node, and the phone hops to the host it is already on, is told
/// again that it is in the wrong place, and hops again. Found by the test that
/// asserts it, not by reading.
///
/// Nothing else is folded: no case folding on the host, no scheme upgrade, no
/// `www.` equivalence. Each of those would let two genuinely different
/// deployments read as one, which is the failure with no symptom.
bool _sameHost(String a, String b) {
  String strip(String v) {
    String s = httpBaseOf(v);
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  return strip(a) == strip(b);
}

/// The URL this phone should move to, or `null` to stay exactly where it is.
///
/// Joins the two pure decisions to the one fetch, in the order that costs
/// nothing in the common case:
///
///   1. [nodeToFollow] answers from the ACK ALONE. On a single-node deployment
///      — every installation today — it returns null here and **no request is
///      made**. That ordering is the whole performance story: the fetch only
///      happens on a reconnect that has already proven the phone is in the
///      wrong place.
///   2. the list is fetched FROM [currentEndpoint], never from anywhere else;
///   3. [resolveNodeUrl] turns the id into an address, or does not.
///
/// 🔴 A FETCH THAT FAILS MUST NOT BE ABLE TO MOVE ANYONE. Every failure lands
/// on an empty list ⇒ no resolution ⇒ null ⇒ the caller leaves the endpoint
/// alone, which is precisely today's behaviour. The phone then keeps talking to
/// the node it is on — where its PC is not — and that is a degraded state we
/// can see in the trail, rather than a dial to somewhere we guessed.
///
/// ⚠️ Returns null when the resolved URL is the one we are already using, so a
/// caller cannot be tricked into a pointless reconnect by a list that maps a
/// different id onto the same address.
Future<String?> planNodeHop({
  required Object? ack,
  required String currentEndpoint,
  required NodeListFetcher fetch,
}) async {
  final String? wanted = nodeToFollow(ack);
  if (wanted == null) return null;
  final List<RelayNode> nodes = await fetch(nodeListUri(currentEndpoint), kNodeListTimeout);
  final String? url = resolveNodeUrl(nodes, wanted);
  if (url == null) {
    diag('node.follow.unresolved', <String, Object?>{'want': wanted});
    return null;
  }
  if (_sameHost(url, currentEndpoint)) return null;
  diag('node.follow.moving', <String, Object?>{'want': wanted});
  return url;
}
