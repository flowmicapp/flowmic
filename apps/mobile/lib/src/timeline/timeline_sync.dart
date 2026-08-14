// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (owner's
//     architecture ruling: phone↔PC does not do cloud storage sync, the
//     cloud does not store transcripts; the phone is the owner of its own record)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (heartbeat{ts} — the liveness event)
//   packages/protocol/src/protocol-schemas-sync.ts (the `history:*` event NAMES
//     and schemas deliberately STAY on the wire — rule 8 — and the server answers
//     each of them HISTORY_SYNC_RETIRED)
//
// ── 0.2.27: THIS CLASS NO LONGER SYNCS ANYTHING ──────────────────────────────
//
// It used to be the ONE emitter of `history:*` (create / update / delete /
// inject) — the mobile half of "the phone uploads its own transcripts to the
// server". owner's ruling removed the destination: `transcript_history` is
// dropped, every `history:*` frame is now refused out loud, and the phone is
// the OWNER of its record rather than one of two writers of a server row.
//
// RETIRED WITH THE FLOW (each had no object left to act on — a method that keeps
// serving a flow that does not exist is the façade shape this project keeps
// paying for, so these are DELETED rather than left in place):
//
//   · `onEntryBuilt` + `shouldSync` (the §4.0 C emit-side gate) and
//     `forceCreate` / `createAcked` — there is no room row to create.
//     ⚠️ §4.0 C "record-only stays on the phone" is NOT retired; it became
//     STRUCTURAL. Nothing about a row leaves this phone unless the user
//     explicitly delivers it, so the gate has nothing left to withhold.
//   · `reflushPending` — it replayed unsynced rows into `transcript_history` on
//     every connection edge. It never delivered anything to a PC (delivery is
//     `inject:request`, always was), so retiring it costs the user no capability
//     — see chat_row_uplink.dart for what became of the queue it drained.
//   · `pushEdit` + its two ack readers — the C5 verdict arbitrated TWO writers of
//     ONE server row. `HistoryUpdateSchema.base_output_text` and the whole ack
//     shape left the protocol in this same window; the design knowledge is kept
//     in docs/strategy/2026-07-30-c5-conflict-criteria-design.md.
//     ⚠️ This is also where stopping the server writes would have hurt most:
//     the server answers `SETTINGS_SYNC_FAIL/'no such entry'` for a row it does
//     not hold, and `_readUpdateAck` read that code as "the other side deleted
//     this row" and physically DELETED the local row. That code answers "the
//     id is not in the table"; reading it as "the other side deleted it" is
//     this repo's headline bug shape, and a cleared table would have turned
//     it from rare into certain.
//   · `emitInject` (`history:inject`) — deferred delivery (补投) carries its
//     own text now (manual_delivery.dart `reInject`). The phone owns the
//     words, so it no longer asks the server to look them up.
//   · `emitDelete` — there is nothing up there to tombstone.
//
// WHAT IS LEFT (both still have a live production consumer):
//   · [probeLink] — the delivery paths' link-liveness gate (RCA-v3), re-carried
//     off the retired `history:list` onto `heartbeat`.
//   · [wireItem] — `POST /api/inject/image` still carries a history item in its
//     body (the HTTP ingress mirrors the socket frame's shape, one contract not
//     two). ⚠️ Known open item, NOT introduced here: [RoomIdentity] has no
//     production setter (`grep 'identity ='` finds only its own declaration), so
//     every field is the sentinel default. It has never shown because the server
//     re-stamps identity from the verified token either way.
//
// The class KEEPS its name so the retirement is readable in one place next to
// the history the name refers to. Renaming it is a separate, cosmetic change.

import '../../generated/flowmic_events.g.dart';
import '../diag/diag_log.dart';
import '../signaling/socket_core.dart';
import '../signaling/wire_payloads.dart' show HeartbeatPayload;
import 'timeline_entry.dart';

/// The room-membership identity stamped onto a history item. Sourced from the
/// pair ack; a standalone LAN pairing has no SaaS user, so [userId] falls back
/// to a non-empty local sentinel (HistoryItemSchema.user_id is NonEmpty).
class RoomIdentity {
  final String pcDeviceId;
  final String userId;
  final String? mobileId;
  final String? pairingId;
  const RoomIdentity({
    this.pcDeviceId = 'standalone-pc',
    this.userId = 'local',
    this.mobileId,
    this.pairingId,
  });
}

class TimelineSyncGate {
  TimelineSyncGate({
    required SocketTransport transport,
    RoomIdentity identity = const RoomIdentity(),
  }) : _transport = transport,
       _identity = identity;

  final SocketTransport _transport;
  RoomIdentity _identity;

  set identity(RoomIdentity id) => _identity = id;

  /// The delivery paths' link-liveness gate: can an application frame still get
  /// to the server AND back, right now?
  ///
  /// WHY IT EXISTS (RCA-v3). After the system photo picker — or any
  /// backgrounding — this handset's OS severs background TCP and socket.io does
  /// not notice for up to 30 s. Inside that window `emit` returning true means
  /// 「handed to the socket object」 and nothing more, so a delivery emitted there
  /// vanishes with no receipt. Only a round-trip that came BACK proves the pipe.
  ///
  /// CARRIER: `heartbeat`, as of 0.2.27. It used to be `history:list` — an event
  /// whose server handler is retired in this same window, so the probe would
  /// have been measuring a refusal. `heartbeat` is the event whose ONE job is
  /// this question (04 §3.2) and its handler does real authenticated work:
  /// heartbeat.handler.ts stamps `last_seen_at` on THIS socket's identity and
  /// acks `{ok:true,last_seen_at}`. An `ok:true` therefore means the server got
  /// the frame, recognised who we are, wrote a row and answered — four facts,
  /// none of which is "was emitted". Its side effect is honest, too: a probe fires
  /// because the user just pressed send, so 「this phone was active just now」 is
  /// exactly true.
  ///
  /// THE CRITERION IS `ok == true`, deliberately narrower than the old 「any ack,
  /// even an error ack, proves the link」. `AUTH_TOKEN_INVALID` is the only error
  /// this handler can produce, and it means the pipe is up but this socket cannot
  /// deliver anything — for which the caller's response (kick the link, let the
  /// ladder re-auth) is the correct one. So a false never claims the network is
  /// down; it says 「a delivery cannot go out on this socket right now」, which is
  /// the only question either caller asks. The diag line keeps the three cases
  /// (refused / no answer / ok) distinguishable in forensics, because collapsing
  /// them into one boolean at the door is how the last two mysteries lasted a day.
  Future<bool> probeLink({
    Duration timeout = const Duration(milliseconds: 2500),
  }) async {
    try {
      final Object? ack = await _transport.emitWithAck<Object?>(
        FlowMicEvents.heartbeat,
        HeartbeatPayload(DateTime.now().millisecondsSinceEpoch).toJson(),
        timeout: timeout,
      );
      final bool alive = ack is Map && ack['ok'] == true;
      diag('probe.link', <String, Object?>{
        'alive': alive,
        // Present ⇒ the handler's success branch ran (server clock, not ours).
        'last_seen_at': ack is Map ? ack['last_seen_at'] : null,
        'error': ack is Map ? ack['error'] : null,
      });
      return alive;
    } on Object {
      // No answer inside the budget: the honest reading is 「dead-but-undetected」,
      // which is precisely the case this probe was built to catch.
      diag('probe.link', const <String, Object?>{'alive': false, 'no_answer': true});
      return false;
    }
  }

  /// The history-item wire shape for [entry] under the current room identity.
  /// Public for the http image ingress (RCA-v3), whose body carries the exact
  /// item `history:create` used to — the server re-stamps identity from the
  /// verified token, so these claimed fields only need to parse.
  Map<String, Object?> wireItem(TimelineEntry entry) => entry.toHistoryItem(
    pcDeviceId: _identity.pcDeviceId,
    userId: _identity.userId,
    mobileId: _identity.mobileId,
    pairingId: _identity.pairingId,
  );
}
