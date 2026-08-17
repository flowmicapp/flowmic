// Part of connections_controller.dart — the presence half: 「这一行背后那台电脑
// 此刻在不在」("is the computer behind this row here right now"), list-scope.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4.1 (RV-98)
//   session/pc_presence_probe.dart (the transport surface: how to ask)
//   session/pc_presence.dart (the vocabulary: what the answer is called)
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// connections_controller.dart was at 767 of `verify/lint/file-size.mjs`'s
// SRC_MAX=800 and this round adds to exactly this half of it. Splitting under
// the gate rather than at it is the repo's standing rule (the alternative —
// deleting comments to fit — would throw away the evidence that is most of
// what these blocks are).
//
// 🔴 **The cut follows 「which question it answers」, not line count.** What
// moved here is the whole of one question — the map that holds the answers, the
// in-flight set that keeps it from being asked twice, the reader the page calls,
// and the sole writer. What stayed behind is the *other* question
// (`_reach`/`_channel`, `GET /api/health`: 「这个服务器地址够不着吗」("is this
// server address unreachable")) plus the two places that legitimately touch both
// tables at once (`refreshReachability` fans out to both; `_pruneStaleProbeKeys`
// prunes both). Those two are deliberately NOT dragged along: they are about the
// list, not about presence, and moving them would make this file answer two
// questions again — the exact shape RV-92 was.
//
// ⚠️ **Do not read this split as an architectural statement.**
// `ConnectionsController` is still one object with one lifetime; only the
// declaration site moved. `pc_presence_probe.dart` / `pc_presence.dart` remain
// the real layering ("how to ask" / "what the answer is called") and this file
// is neither — it is the list domain's *holder* of that answer.
//
// 🔴 DIFF DISCIPLINE: the two fields, [presenceOf] and [_probePresenceOne] were
// moved **character-for-character** out of connections_controller.dart, comments
// included. The only change is the one this shape always needs: a mixin cannot
// see the host class's other fields, so the two collaborators the moved body
// reads — `_presenceRead` and `probeTimeout` — are declared here as abstract
// getters and satisfied by the fields that are still declared over there.
// **Any difference beyond that is a bug.**
//
// ⚠️ A `mixin` rather than the `extension` used by ptt_presence_poll.dart, and
// the reason is mechanical, not stylistic: an extension cannot declare instance
// fields, and the two fields are the half of this question that most needed the
// room. Same `part`-of-one-library shape, so the private names below stay
// private to the controller's library and `_pruneStaleProbeKeys` over there can
// still reach `_presence` — that reachability is why this is a `part` and not
// its own library.
part of 'connections_controller.dart';

/// The list domain's presence half. Mixed into [ConnectionsController]; not
/// usable on its own, and deliberately not general — [PcPresence]'s cross-scope
/// vocabulary lives in pc_presence.dart, and the only other asker (the live
/// session, `ptt/ptt_presence_poll.dart`) holds stronger evidence and must not
/// share this table (doc 15 §1.4).
mixin ConnectionsPresenceHost on ChangeNotifier {
  /// Supplied by [ConnectionsController]: the injectable presence reader (null
  /// in production — see the field's own doc over there).
  PcPresenceReader? get _presenceRead;

  /// Supplied by [ConnectionsController]: the per-probe budget.
  Duration get probeTimeout;

  /// 🔴 RV-98 — the list-scope [PcPresence], keyed by [keyFor] (the PAIRING),
  /// **never by endpoint**: two pairings can share one relay address and point at
  /// two different computers, so an endpoint key would paint A's answer on B's
  /// row — the instance-list variant of ID crosstalk (串号).
  ///
  /// [_probePresenceOne] is the ONLY writer (volume 15 §1.4 「唯一写者」/ "sole
  /// writer"). Absent =
  /// [PcPresence.unknown] = 「这一趟没问到」("didn't get an answer this round").
  ///
  /// ⚠️ **Cleared, not kept, when a poll starts or fails** — the deliberate
  /// OPPOSITE of [_channel]'s RV-54 rule. `_channel` answers 「这是台什么服务器」
  /// ("what kind of server is this"),
  /// which barely changes, so a stale value is still informative; presence
  /// answers 「此刻在不在」("is it here right now"), whose entire value is being
  /// current. Keeping the last
  /// `online` through a failed poll would re-create the exact lie owner reported.
  ///
  /// ⚠️ The value is a [PcPresenceRow], not a bare [PcPresence]: the server's
  /// `pc_absent_reason` rides in the SAME entry as the absence it explains. A
  /// second, parallel map would be two things to prune, two things to
  /// invalidate, and eventually a row whose presence and whose reason came from
  /// two different rounds.
  final Map<String, PcPresenceRow> _presence = <String, PcPresenceRow>{};
  final Set<String> _presenceProbing = <String>{};

  /// 🔴 RV-98 — what the last poll said about the PC behind [pairing].
  /// [PcPresence.unknown] until one has answered; callers must render that as
  /// 「不知道」("don't know"), **never as offline** (that would be saying we know it is not
  /// there) and never as online.
  PcPresence presenceOf(MobileSession pairing) =>
      _presence[ConnectionsController.keyFor(pairing)]?.presence ??
      PcPresence.unknown;

  /// 🔴 WHY that computer is absent, when the server said. `null` for every
  /// other case — online, never asked, an old server, a LAN sidecar, or a
  /// reason string this build does not know.
  ///
  /// ⚠️ Only meaningful next to [presenceOf]'s `offline`; on its own it can
  /// never make a row absent. Deliberately a second GETTER over one map rather
  /// than a second map — see [_presence].
  PcAbsentReason? pcAbsentReasonOf(MobileSession pairing) =>
      _presence[ConnectionsController.keyFor(pairing)]?.absentReason;

  /// 🔴 C4 — did the server tell us, in as many words, that it does not know
  /// this pairing? `false` for every other case, including 「never asked」 and
  /// 「could not ask」 — the default has to be the one that claims nothing,
  /// because this flag is the only thing on the page that tells a user to go
  /// and pair again.
  bool pairingRejectedFor(MobileSession pairing) =>
      _presence[ConnectionsController.keyFor(pairing)]?.pairingRejected ?? false;

  /// The ONE writer of [_presence]. Every non-answer lands on
  /// [PcPresence.unknown]; nothing here can produce a `offline` that was not
  /// measured, and nothing can keep a previous `online` alive.
  ///
  /// 🔴 Bounded retry WITHIN this one cycle ([kInstanceListPresenceBudget], 3
  /// attempts / 300 ms then 900 ms). This path gets the generous budget of the
  /// two because **nothing here is coming back to correct a wrong answer**:
  /// `refreshReachability` has no timer of its own on the instance list, so
  /// before this a single transient stall left the row saying 「电脑是否在线
  /// 未知」 ("PC status unknown") until the user thought to pull to refresh. The
  /// wait is honest — the row paints 检测中 ("checking…") for the whole of it.
  Future<void> _probePresenceOne(MobileSession pairing, String key) async {
    PcPresenceReading reading;
    try {
      final Uri url = pcPresenceUri(pairing.endpoint);
      reading = await readPcPresenceRetrying(
        url,
        pairing.token,
        budget: PcPresenceRetryBudget(
          attempts: kInstanceListPresenceBudget.attempts,
          // ⚠️ NOT the budget constant's own 3 s: [probeTimeout] is this
          // controller's injectable per-probe budget and is the same 3 s. Two
          // spellings of one number would be the drift this repo keeps paying
          // for — the constant declares the intent, this field is what
          // production and the tests actually dial with.
          perAttemptTimeout: probeTimeout,
          backoff: kInstanceListPresenceBudget.backoff,
        ),
        // 🔴 THE PIN COMES FROM THIS ROW, not from 「当前连着哪台」("which one is
        // currently connected"). The list
        // probes every remembered pairing, and two rows can share one relay
        // address while pointing at two different computers — the same reason
        // ② in pc_presence_probe.dart's header gives for probing per pairing
        // rather than per address.
        reader: _presenceRead,
        pin: pairing.lanTlsFp,
      );
    } on Object {
      reading = PcPresenceReading.unknown; // could-not-reach IS an answer, not a swallowed failure
    } finally {
      _presenceProbing.remove(key);
    }
    // 🔴 ID crosstalk is never allowed: if the server-echoed `pc_id` does not
    // match the one this row has stored ⇒ **it is not this row's answer** —
    // treat it as no answer received. (`pcId == null` means an old server / no
    // echo, nothing to check against ⇒ do not block; `pairing.pcId == null`
    // means a row saved before 0.2.4, same reasoning.)
    final String? expected = pairing.pcId;
    final String? answered = reading.pcId;
    final bool mismatched =
        expected != null && answered != null && expected != answered;
    // ⚠️ A cross-wired answer loses its REASON along with its presence. The
    // reason describes whichever computer actually answered, and pinning
    // someone else's lapsed sign-in onto this row would be the crosstalk this
    // check exists to stop, wearing a more convincing sentence.
    //
    // ⚠️ `pairingRejected` survives the mismatch check on purpose, and it is
    // the one field that may: a refusal is about the TOKEN this row sent, and
    // an answer that named no `pc_id` (there is no pairing to name one for)
    // cannot be cross-wired to another row's computer. Zeroing it here would
    // throw away the only actionable answer on this path for a mismatch that
    // structurally cannot have happened.
    _presence[key] = mismatched
        ? (
            presence: PcPresence.unknown,
            absentReason: null,
            pairingRejected: reading.pairingRejected,
          )
        : (
            presence: reading.presence,
            absentReason: reading.absentReason,
            pairingRejected: reading.pairingRejected,
          );
    notifyListeners();
  }
}
