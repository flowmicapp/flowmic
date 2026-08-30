// owner 2026-08-30 — the `us` / `asia` labels, and where this app gets them.
//
// SPEC-REF: apps/server-core/src/http/node-routes.ts (NodeEntry.short — why the
//   label lives in the operator's node directory and not in either client).
//
// ── WHY A SEPARATE, LAZY READ ───────────────────────────────────────────────
//
// The phone already parses the node directory, but only inside `planNodeHop`,
// and only when the ack says it is on the WRONG node — which in the steady
// state is never. So the labels were never in hand at the moment a screen
// wanted to draw one.
//
// Three ways to fix that, and why this is the one:
//   · put the label on the ack — one field, no extra request, but it is a
//     protocol change AND the socket handler has no reader for the directory,
//     so it needs a server refactor to keep the label single-authored. Right
//     answer eventually; too much machinery for a chip today;
//   · map ids to labels in the app — two clients, two maps, one fact. Refused
//     at the source (see NodeEntry.short);
//   · read the directory the app already knows how to read, once, lazily, and
//     fall back to the id. That is this file.
//
// 🔴 FAILURE IS SILENT AND THE FALLBACK IS THE ID. Nothing on a screen depends
// on this read succeeding: with no labels the badge says `srvny`, which is true,
// repeatable back to us, and distinguishable from `srvjp` — which is the whole
// job the owner asked for. A read that failed loudly would be a banner about a
// chip.
//
// ⚠️ ONE FETCH PER APP RUN PER ENDPOINT, not per rebuild. The directory is an
// operator file that changes on the order of months; re-reading it on every
// frame would put a network request behind a `build()`.

import 'dart:async';

import '../diag/diag_log.dart' show diag;
import 'node_follow.dart';
import 'node_list_client.dart';

/// `id → short`, for whatever endpoints this app has looked at.
class NodeLabels {
  NodeLabels({NodeListFetcher? fetch}) : _fetch = fetch ?? httpNodeListFetch;

  final NodeListFetcher _fetch;
  final Map<String, String> _shortById = <String, String>{};
  List<RelayNode> _nodes = const <RelayNode>[];
  final Set<String> _asked = <String>{};

  /// What this app currently knows. Empty is the normal state before the first
  /// read completes, and callers must render the id then — see
  /// [nodeBadgeLabel], which is the one place that decision is made.
  Map<String, String> get shortById => Map<String, String>.unmodifiable(_shortById);

  /// The directory itself, for callers that need to RESOLVE an id rather than
  /// label it (presence_route.dart). Empty until the first read completes, and
  /// every consumer must degrade to today's behaviour on empty — never to a
  /// worse claim.
  List<RelayNode> get nodes => _nodes;

  /// Read the directory served by [endpoint], at most once per endpoint.
  ///
  /// Returns immediately on every call after the first; the caller does not
  /// await it in production (a screen must not wait on this to paint).
  Future<void> ensureLoaded(String endpoint) async {
    final String key = endpoint.trim();
    if (key.isEmpty || !_asked.add(key)) return;
    try {
      final List<RelayNode> nodes =
          await _fetch(nodeListUri(key), kNodeListTimeout);
      _nodes = nodes;
      for (final RelayNode n in nodes) {
        final String? s = n.short;
        if (s != null && s.trim().isNotEmpty) _shortById[n.id] = s.trim();
      }
      if (_shortById.isNotEmpty) {
        diag('node.labels', <String, Object?>{'n': _shortById.length});
      }
    } on Object {
      // Deliberately swallowed, and deliberately NOT retried: the fallback is a
      // true label, and a retry loop for a chip is how a background request
      // becomes a battery report. The next app run asks again.
    }
  }

  /// Test seam only — production fills this by reading the directory.
  void debugSeed(Map<String, String> shortById,
      {List<RelayNode> nodes = const <RelayNode>[]}) {
    _shortById
      ..clear()
      ..addAll(shortById);
    _nodes = nodes;
  }
}
