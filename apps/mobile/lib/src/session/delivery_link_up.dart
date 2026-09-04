// ONE fact — 「the delivery link to the target PC is up right now」 — assembled
// from the two edges that can establish it, so the persistent outbox has a
// single thing to subscribe to.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 (delivery vs
//     injection) / §2.5 (the 「pending delivery」 red line: a wait may only be
//     named when something redeems it)
//   session/pc_presence.dart ([PcPresence], the session-scope 「is that PC in
//     its room」 value and its five wire writers)
//   ptt/ptt_session.dart (`roomJoins`, the counter F-1 created)
//
// ── WHY THIS EXISTS (2026-09-04, owner-reported, real devices, 0.3.61) ──────
// F-1 (0.2.52) moved the drain off the `ConnectionState.connected` rising edge
// onto `PttSession.roomJoins`, because 「the socket is up」 is one beat EARLIER
// than 「the server has put this connection in a room」 and the server rightfully
// refused every frame the early edge produced. That fix was correct and is not
// touched here.
//
// What it left out is the OTHER end of the link. `roomJoins` only ever answers
// 「THIS PHONE got into the room」. On the cloud leg the relay does not drop when
// the PC quits, so the phone stays in its room the whole time: the PC goes away,
// an item is queued, the PC comes back — and NOTHING fires. Measured:
//
//   relay   audio:start: fanned-out utterance has no PC in this room
//   relay   inject:request but no PC in room
//   PC      pc:reconnect ack roster on cloud — 1 phone(s) / pc:mobile-joined
//   phone   「Pending delivery」 … for minutes, until the phone was made to leave
//           and re-enter the room, at which point the drain fired 0.7 s later.
//
// ⇒ The missing edge is not a connection edge at all — it is 「the DESTINATION is
// reachable again」. That fact already exists on this phone and is already
// written from five wire sources ([PcPresenceTracker]: the pairing ack's
// `pc_online`, `focus:state`, an `inject:result` the PC itself produced, the
// idle `GET /api/pc/presence` poll, and the R3 watchdog that lapses all of them
// when the connection drops). Nothing consumed it for delivery.
//
// 🔴 THIS IS THE 0.2.52 LESSON APPLIED, NOT REVERSED. That lesson was 「when you
// fix an 『one beat early』 defect, turn the LATER FACT into something
// subscribable and ask who else needs it」. The later fact here is strictly
// later than `connected`: `PcPresence.online` is only ever written from evidence
// that the PC itself is in the room. Hanging the drain back on a socket edge is
// still forbidden, and this class deliberately cannot be fed one — it takes a
// room-join counter and a presence value, and no socket status at all.

import 'package:flutter/foundation.dart';

import 'pc_presence.dart';

/// Which of the two edges bumped [DeliveryLinkUp] last. Forensics only — the
/// drain treats both identically, and it is recorded so a later reader can tell
/// 「the phone got back in」 from 「the computer came back」 without guessing.
enum DeliveryLinkEdge {
  /// Nothing has fired yet.
  none,

  /// This phone was admitted to the room (`PttSession.roomJoins`, whose writers
  /// are `pair()` success and `mobile:reconnect`'s `onAccepted`).
  phoneJoinedRoom,

  /// The paired PC is in its room again ([PcPresence.online]).
  pcBackInRoom,
}

/// A counter, not a flag: a boolean that stays `true` notifies nobody on the
/// second occurrence, and both of these edges repeat for the life of a session.
/// Same reasoning as `roomJoins` itself.
class DeliveryLinkUp extends ValueNotifier<int> {
  DeliveryLinkUp({
    required ValueListenable<int> roomJoins,
    required ValueListenable<PcPresence> pcPresence,
  }) : _roomJoins = roomJoins,
       _pcPresence = pcPresence,
       _pcWasOnline = pcPresence.value == PcPresence.online,
       super(0) {
    _roomJoins.addListener(_onRoomJoined);
    _pcPresence.addListener(_onPcPresence);
  }

  final ValueListenable<int> _roomJoins;
  final ValueListenable<PcPresence> _pcPresence;

  /// The rising-edge latch for the presence half. Without it every repeated
  /// piece of evidence that the PC is still there would be a fresh edge — a
  /// `focus:state` per window switch, an `inject:result` per delivery — and the
  /// queue would be drained on a schedule set by unrelated traffic.
  ///
  /// ⚠️ [PcPresenceTracker] already collapses same-value writes, so this latch
  /// is not merely a copy of that: it is what makes
  /// online → unknown → online (the R3 watchdog lapsing on a disconnect and the
  /// next ack re-establishing it) a NEW edge, while online → online is not one.
  bool _pcWasOnline;

  DeliveryLinkEdge _lastEdge = DeliveryLinkEdge.none;

  /// Which edge produced the current [value]. Read at the drain site for its
  /// diag line only.
  DeliveryLinkEdge get lastEdge => _lastEdge;

  void _onRoomJoined() => _bump(DeliveryLinkEdge.phoneJoinedRoom);

  void _onPcPresence() {
    final bool online = _pcPresence.value == PcPresence.online;
    // 🔴 `offline` and `unknown` are BOTH 「not up」 here, and that is deliberate.
    // They mean very different things to the screen (「measured gone」 vs 「we do
    // not know」), but to this question they mean the same one: whatever comes
    // next, if it says `online`, is new evidence and deserves an edge.
    if (online == _pcWasOnline) return;
    _pcWasOnline = online;
    if (online) _bump(DeliveryLinkEdge.pcBackInRoom);
  }

  void _bump(DeliveryLinkEdge edge) {
    _lastEdge = edge;
    value = value + 1;
  }

  @override
  void dispose() {
    _roomJoins.removeListener(_onRoomJoined);
    _pcPresence.removeListener(_onPcPresence);
    super.dispose();
  }
}
