// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-2
//   packages/protocol/src/protocol-schemas-auth.ts
//     (MobileReconnectAckNodeFieldsSchema — `home_node` / `node`)
//   apps/server-core/src/http/node-routes.ts (GET /api/node/list, NodeEntry)
//   apps/mobile/lib/src/auth/saas_endpoint.dart
//     (planRetiredSaasEndpointHeal — the shape this file copies: a PURE planner
//      that returns 「the address to move to, or null」 and writes nothing)
//
// ── THE PHONE FOLLOWS ITS PC ────────────────────────────────────────────────
//
// Rooms are per-process (`server-core room/store.ts`: 「Live socket presence
// ONLY」). A phone connected to a different node from its PC is therefore not in
// a slow room — it is in a DIFFERENT room, and it would sit reporting the PC
// offline while the PC reports itself perfectly connected. No error, no log, no
// timeout: both ends working exactly as designed.
//
// The `mobile:reconnect` ack carries the comparison in ONE instant:
//   · `home_node` — the node the paired PC is registered on right now;
//   · `node`      — the node that answered this ack.
//
// ── 🔴 ABSENCE MEANS SINGLE-NODE, AND THAT IS THE ASSERTION THAT PROTECTS
//    EVERY PHONE ALREADY INSTALLED ────────────────────────────────────────────
//
// Every handset in the world today will see neither field until an operator
// flips a node list on, and most will never see them at all. So the rule is not
// 「default to no hop」 — it is that a missing field, an empty field, an equal
// pair, or a field of the wrong type ALL produce exactly today's behaviour, and
// none of them may produce a dial anywhere. `node_follow_test.dart` asserts that
// first and at length, because those phones cannot tell us if it breaks.
//
// ── 🔴 THE DIRECTION THIS FILE MUST NOT TAKE ────────────────────────────────
//
// Copied from `planRetiredSaasEndpointHeal`, which states the same danger for
// the same field: **a pairing's endpoint is not always ours.** `addByCode`
// stores whatever address the user typed or scanned, which on a self-hosted
// deployment is that operator's own relay.
//
// ⇒ [resolveNodeUrl] resolves an id ONLY against a node list that was served by
// the endpoint the phone is already talking to. It never consults a built-in
// list and there is no built-in list to consult. A self-hosted deployment
// either serves no node list (single-node ⇒ the fields are absent ⇒ no hop) or
// serves its own, and the phone then moves within that operator's own
// deployment. There is no input to this file that can move a phone onto our
// infrastructure, and that is a property of the shape rather than of a check.

// ── ⚠️ THIS FILE IS WIRED. THE PARAGRAPH THAT USED TO STAND HERE SAID IT WAS
//    NOT, AND IT OUTLIVED ITS OWN TRUTH ────────────────────────────────────────
//
// Until 2026-08-30 this header opened with "NOTHING CALLS THIS IN PRODUCTION
// YET", and it went on to argue that the missing APPLY was a product decision
// (「may the phone move mid-utterance?」) rather than plumbing. The apply was
// written on 2026-08-30 and the paragraph was not — so a reader arriving here
// on 2026-09-01 was told, in a confident voice, that a live path was dead code.
// That is anti-façade ④ in its most expensive shape: a stale truth reads exactly
// like a current one, and nobody re-measures a sentence that sounds settled.
//
// THE PRODUCTION CALLERS, greppable, both of them:
//   · `_followNodeIfMisplaced` in ptt_reconnect_ack.dart — the `mobile:reconnect`
//     ack leg (the reconnect ladder, `resumePairing`, the hold-out recheck);
//   · the same function called from ptt_pair.dart — the `mobile:pair` ack leg,
//     because `mobile:pair` is writer-only so a phone ALWAYS pairs on the writer.
// Both are pinned by `test/node_follow_wired_test.dart`, which exists precisely
// because one wired caller was once mistaken for a wired feature.
//
// The mid-utterance question was answered rather than dropped, and the answer is
// in `_followNodeIfMisplaced`'s own doc ("WHY IMMEDIATELY, RATHER THAN WAITING
// FOR AN IDLE MOMENT"): `mirrorToPc` drops a frame for an absent PC with no
// error, no refusal and no log, so staying put does not trade one lost utterance
// against a delay — it trades a whole session of silent loss against one
// reconnect.
//
// The insertion point named below is the one that was used:
// `ReconnectCoordinator._resolveThenDial` asks a `DialUrlResolver` which address
// each rung should use and ADOPTS the answer, and a resolver that throws falls
// back to the address it had. Persisting through `persistDialedEndpoint`
// (session/endpoint_candidates.dart) is the other half — and it is also the
// whole of "remember the last known node per instance", because the persisted
// endpoint IS that memory. No new stored field.

/// One row of `GET /api/node/list`, as this phone needs it.
///
/// ⚠️ Deliberately NOT the server's full `NodeEntry`. `region` is free text for
/// humans reading logs and nothing here renders it; parsing it would be a field
/// with no consumer.
class RelayNode {
  const RelayNode({
    required this.id,
    required this.url,
    this.selectable = true,
    this.isWriter = false,
    this.short,
  });

  /// `srvny` — the same value that appears in `home_node`.
  final String id;

  /// 2026-08-30 — the two-to-four character label to put on screen beside a
  /// connection (`us`, `asia`). Served by the operator's node directory so the
  /// two clients, which share no runtime, cannot disagree about it.
  ///
  /// ⚠️ Null is legal and means 「the operator gave this node no label」, which a
  /// caller must render as the [id] rather than as nothing: a node the user is
  /// connected to is worth naming awkwardly, and hiding it would make the
  /// badge's absence mean two things (LAN, and 「we have no label」).
  final String? short;

  /// `https://srvny.flowmic.app` — what a client dials.
  final String url;

  /// `selectable:false` means published but not offered: an operator draining a
  /// node keeps the row so the record of what its id meant is not lost.
  ///
  /// 🔴 IT DOES NOT BLOCK A FOLLOW, AND THAT IS THE POINT OF THE FLAG. Draining
  /// stops new PCs CHOOSING a node; a phone whose PC is already registered there
  /// must still be able to reach it, or draining would strand exactly the
  /// pairings the operator is trying to migrate gently. Selection and following
  /// are two questions and this answers only the first.
  final bool selectable;

  /// `role: "writer"` — this node accepts first-contact writes.
  ///
  /// ⚠️ Absent means 「not the writer」 and NEVER 「there is no writer」. The role
  /// is published on every entry precisely so that absence has one meaning: a
  /// client asking the writer would otherwise get the same bytes as a client
  /// talking to a deployment that has none.
  final bool isWriter;
}

/// The node this phone must move to, or `null` to stay exactly where it is.
///
/// **Pure** — nothing is written, nothing is logged, nothing is dialled. The
/// caller owns all three (the contract `planRetiredSaasEndpointHeal` sets).
///
/// `null` — stay put — in every one of these cases:
///   · either field absent: a single-node deployment, or a relay too old to
///     answer. This is the overwhelmingly common case and must stay free;
///   · either field empty or not a string: the schema forbids an empty string,
///     so seeing one means we are not talking to what we think we are. 「Do
///     nothing」 is the only safe reading of an answer we cannot parse;
///   · the two are equal: we are already where the PC is;
///   · the ack is not a Map at all: a timeout or a throw left it null upstream.
///
/// 🔴 IT RETURNS AN ID, NOT A URL, and the split is deliberate. This function
/// can decide 「we are in the wrong place」 from the ack alone, with no network
/// and no second question. Turning that id into an address needs the node list,
/// which is a fetch that can fail — and a fetch that fails must not be able to
/// erase a correct decision. Two steps, two failure modes, neither hidden
/// inside the other.
String? nodeToFollow(Object? ack) {
  if (ack is! Map) return null;
  final Object? home = ack['home_node'];
  final Object? here = ack['node'];
  if (home is! String || here is! String) return null;
  if (home.isEmpty || here.isEmpty) return null;
  if (home == here) return null;
  return home;
}

/// 「this ack already came from where the PC is」 — the ONE fact the pairing
/// confirmation is allowed to wait for.
///
/// 🔴 DEFINED AS `nodeToFollow(ack) == null`, NEVER AS A SECOND PARSE OF THE
/// TWO FIELDS. Every reason [nodeToFollow] answers 「stay」 — both fields absent,
/// either one empty or of the wrong type, the two equal, a null ack from a
/// timeout — is also a reason this answers 「settled」, and that is not a
/// coincidence to be re-derived but the same sentence read from the other end.
/// A second parser would drift on the first edit, and the two would disagree
/// about exactly the malformed acks nobody tests by hand.
///
/// 🔴 AND THE DEGRADE DIRECTION IS THE WHOLE SAFETY ARGUMENT. Every handset in
/// the world sees neither field, so every one of them is 「settled」 from the
/// first ack — which is what makes the pairing confirmation on a single-node
/// deployment fire at byte-for-byte the moment it fires today. A cross-node
/// pairing is the ONLY input that can answer false, and the only thing false
/// costs is that the confirmation waits for the phone to arrive.
///
/// ⚠️ It is NOT 「the PC is online」 and must never be rendered as such. It says
/// where this socket is relative to the PC's node, and a PC can be registered on
/// this very node and still be switched off — `pc_online` is that question and it
/// has its own field on the same ack.
bool settledAtHomeNode(Object? ack) => nodeToFollow(ack) == null;

/// Which node ANSWERED this ack — for the badge, not for routing.
///
/// 🔴 A DIFFERENT QUESTION FROM [nodeToFollow], and kept apart on purpose.
/// [nodeToFollow] answers 「am I in the wrong place」 and is null in the happy
/// case; this one answers 「where am I」 and is non-null whenever the deployment
/// has nodes at all. Deriving one from the other would give the badge nothing
/// to draw exactly when everything is working.
String? answeringNode(Object? ack) {
  if (ack is! Map) return null;
  final Object? here = ack['node'];
  return (here is String && here.trim().isNotEmpty) ? here.trim() : null;
}

/// Which node the PAIRED PC lives on, per this ack.
///
/// Separate from [answeringNode] and from [nodeToFollow] for the reason those
/// two are separate from each other: three questions — 「where is my PC」,
/// 「where am I」, 「must I move」 — and only the first one tells a presence
/// probe which node to ask.
String? pcHomeNodeOf(Object? ack) {
  if (ack is! Map) return null;
  final Object? home = ack['home_node'];
  return (home is String && home.trim().isNotEmpty) ? home.trim() : null;
}

/// The URL for [nodeId] in [nodes], or `null` when this list cannot answer.
///
/// **Pure.** `null` means 「we could not resolve it」 and the caller must then
/// leave the endpoint alone — a hop we cannot complete is not an excuse to
/// guess, and the phone staying where it is degrades to exactly the behaviour
/// it has today.
///
/// ⚠️ [RelayNode.selectable] is deliberately NOT consulted — see its doc. A
/// drained node is still the node the PC is on.
String? resolveNodeUrl(List<RelayNode> nodes, String nodeId) {
  for (final RelayNode n in nodes) {
    if (n.id == nodeId) return n.url.isEmpty ? null : n.url;
  }
  return null;
}

// ── ⚠️ `writerNode()` LIVED HERE AND WAS DELETED THE SAME DAY IT WAS WRITTEN
//    (2026-08-29) ─────────────────────────────────────────────────────────────
//
// It found the entry claiming `role: "writer"`, so first contact — registration
// and pairing — could be routed to the node that accepts writes rather than to
// a replica whose copy is seconds behind. It was correct, it had six tests, and
// **it had no production caller**: I wrote it for a phone-side need I then did
// not wire.
//
// 🔴 DELETED RATHER THAN LEFT WAITING, and the difference from the mechanisms
// in this repo that ARE legitimately waiting (`settleSegment` for CR-5,
// `ContinuousRecording.begin` for CR-9) is worth stating, because "no
// production caller" is a question and not a verdict:
//
//   · those two have a caller that is DECIDED and named. They are early, not
//     speculative;
//   · this one's caller was a guess. Whether the PHONE needs writer routing at
//     all is undecided — first contact starts from the PC's QR or short code,
//     so the address the phone dials is the PC's, and whether that is ever a
//     replica depends on where PCs are allowed to register (a DESKTOP rule,
//     being written now) and on a server-side named refusal that is waiting on
//     an owner decision about a new error code.
//
// ⇒ keeping it would have meant a future reader finding a tested, documented,
// unreachable function and assuming it was load-bearing. Ten lines are cheap to
// write again on the day something calls them; a wrong assumption about what is
// live is not. `parseNodeList` still reads `role` into [RelayNode.isWriter],
// because that costs nothing and the field is real — what is gone is the
// pretence that anything acts on it.
/// A believable node list out of a decoded JSON body, or an empty list.
///
/// 🔴 EMPTY MEANS 「NOTHING TO ACT ON」 AND IS NEVER AN ERROR. A single-node
/// deployment does not serve this route at all, an old one does not know it, and
/// both must read as 「stay where you are」 rather than as a fault worth telling
/// anyone about. The only thing an unreadable list may cost is the hop.
///
/// Rows that cannot be believed are DROPPED rather than defaulted: an entry with
/// no id, no url, or a non-https url cannot be dialled, and keeping it would let
/// a malformed row resolve into a dial. Same rule the server's own parser uses,
/// deliberately — the two sides drop the same rows for the same reasons.
///
/// ⚠️ `role` is matched EXACTLY. An unrecognised value is dropped rather than
/// carried, so a typo cannot promote a replica to first contact.
List<RelayNode> parseNodeList(Object? decoded) {
  final Object? raw = decoded is Map ? decoded['nodes'] : decoded;
  if (raw is! List) return const <RelayNode>[];
  final List<RelayNode> out = <RelayNode>[];
  for (final Object? e in raw) {
    if (e is! Map) continue;
    final Object? id = e['id'];
    final Object? url = e['url'];
    if (id is! String || id.trim().isEmpty) continue;
    if (url is! String || !url.startsWith('https://')) continue;
    out.add(RelayNode(
      id: id.trim(),
      url: _stripTrailingSlashes(url),
      // Absent or true = offer it, mirroring the server's own reading. Only a
      // literal `false` withdraws a node from selection.
      selectable: e['selectable'] != false,
      isWriter: e['role'] == 'writer',
      // Length-checked on the way in as well as on the way out: this side is
      // the one that puts the string on a screen, and a client that trusted a
      // server field's length would be trusting a file it does not own.
      short: e['short'] is String && (e['short']! as String).trim().isNotEmpty
              && (e['short']! as String).trim().length <= 6
          ? (e['short']! as String).trim()
          : null,
    ));
  }
  return out;
}

String _stripTrailingSlashes(String v) {
  String s = v;
  while (s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}
