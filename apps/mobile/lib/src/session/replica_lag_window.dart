// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4 (the
//     writer owns writes; replicas PULL, they are not pushed to)
//   apps/mobile/lib/src/signaling/mobile_reconnect_flow.dart (the ONE reader —
//     the AUTH_TOKEN_INVALID branch that deletes the local pairing)
//   apps/mobile/lib/src/signaling/node_follow.dart (the hop that puts this
//     phone in front of a node that may not have heard of it yet)
//
// ── 🔴 A CREDENTIAL CAN BE VALID AND UNKNOWN AT THE SAME TIME ────────────────
//
// `mobile:pair` is writer-only, so a token is always MINTED on the writer. The
// phone then follows its PC to a replica, and the replica answers with the only
// truthful thing it can say about a row it has not pulled yet:
// `AUTH_TOKEN_INVALID`.
//
// The phone's standing reading of that code — 「this pairing is dead, delete the
// token and stop the ladder」 (`runMobileReconnect`, `removeByToken`) — is
// correct for every other way it can arrive, and catastrophic for this one: the
// pairing the user completed SECONDS ago is erased, the instance list comes back
// empty, and the only recovery is to scan the QR again — which pairs on the
// writer again, hops again, and can be erased again. That is the owner's P0 read
// literally: pairing must succeed ONCE.
//
// ⇒ this class holds the one fact that tells the two apart: 「is the credential
// we are presenting NEWER than a replica could be expected to know about」.
//
// ── 🔴 IT SUPPRESSES A DELETION, IT DOES NOT INVENT A SUCCESS ────────────────
//
// Inside the window an `AUTH_TOKEN_INVALID` still refuses the reconnect, still
// reaches `onRejected`, still leaves the phone out of the room, and still says
// so in the trail. The ONLY thing that changes is that the local token survives
// and something asks again. Nothing is reported as connected that is not
// connected — 「no silent failure」 cuts both ways and this window is on the
// deletion, never on the verdict.
//
// ── WHY 75 SECONDS ──────────────────────────────────────────────────────────
//
// Derivation, not a round number:
//   · the writer drains its replication outbox on a 5 s tick;
//   · a replica PULLS on a 30 s tick — nothing is pushed to it, so the worst
//     case for one pull is a full 30 s of waiting plus the drain that was just
//     missed;
//   · one pull is not enough to bet a user's pairing on: the pull that lands
//     first may be the one that started before our row was drained.
// ⇒ two pulls (60 s) plus the drain tick and a margin for a slow round trip.
// **75 s is an upper bound on 「it is still reasonable to blame replication」,
// not an estimate of how long it takes.** Past it, an `AUTH_TOKEN_INVALID` is
// taken at face value again, exactly as it is today.
//
// ⚠️ It is deliberately NOT derived from a server-sent budget. The relay has no
// field for 「your row has not replicated yet」 and inventing one would be a
// protocol change; a client-side ceiling that only ever DELAYS a deletion needs
// no permission from the wire.

import '../diag/diag_log.dart' show diag;

/// How long after a mint or a move an `AUTH_TOKEN_INVALID` may be blamed on
/// replication lag rather than on the pairing. See the header for the
/// derivation (5 s outbox drain + 2 × 30 s replica pull + margin).
const Duration kReplicaLagWindow = Duration(seconds: 75);

/// 「is the credential this session is presenting newer than the replicas may
/// know」 — one fact, one author, two writers.
///
/// The two writers are the only two moments at which the answer can become
/// true, and they are different events rather than two names for one:
///   · [notePaired] — a `mobile:pair` ack minted a token ON THE WRITER;
///   · [noteNodeHop] — we are deliberately moving this socket to another node,
///     which may be a replica that has never seen this token even if it was
///     minted long ago.
/// A phone that pairs and never hops still needs the first (its own PC's node
/// may answer the very next reconnect), and a phone that hops years after
/// pairing still needs the second.
class ReplicaLagWindow {
  ReplicaLagWindow({DateTime Function()? clock}) : clock = clock ?? DateTime.now;

  /// The clock, as a field for the same reason `PttSession.healthReader` is one:
  /// a test must be able to stand outside the window without waiting 75 real
  /// seconds, and `DateTime.now` does not move under `FakeAsync`.
  ///
  /// ⚠️ The default is the real clock — never a frozen or zero one. A friendly
  /// default here would hold the window open forever and turn a suppression into
  /// a pairing that can never be deleted.
  DateTime Function() clock;

  DateTime? _at;

  /// Test-visible: when the window was last opened, or null if never.
  DateTime? get openedAt => _at;

  /// A `mobile:pair` ack was just validated — the token exists on the writer and
  /// nowhere else yet.
  void notePaired() => _open('pair');

  /// We are about to point this socket at a different node.
  void noteNodeHop() => _open('hop');

  void _open(String reason) {
    _at = clock();
    diag('replica.lag.window', <String, Object?>{
      'reason': reason,
      'ms': kReplicaLagWindow.inMilliseconds,
    });
  }

  /// Is an `AUTH_TOKEN_INVALID` right now more likely to be lag than a verdict?
  ///
  /// False before anything has opened it, so a phone that simply launches and
  /// taps a PC paired last month gets today's behaviour with no window at all —
  /// which is the point: this must not become a blanket 「never delete a
  /// pairing」, or a genuinely revoked phone would keep a dead row forever.
  ///
  /// ⚠️ A clock that goes BACKWARDS (a user changing the device time, an NTP
  /// step) makes the elapsed span negative, which reads as 「inside」. That is the
  /// direction to fail in: the cost is one delayed deletion, and the cost of the
  /// other direction is the pairing the user just made.
  bool get open {
    final DateTime? at = _at;
    if (at == null) return false;
    return clock().difference(at) < kReplicaLagWindow;
  }

  /// The window is over as a FACT, not because we gave up — used by the ack legs
  /// once a reconnect has actually been accepted, since a phone that is in the
  /// room is a phone whose credential every node it is talking to now knows.
  void close() => _at = null;
}
