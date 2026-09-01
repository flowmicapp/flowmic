// Card PAIR-SUCCESS (owner 2026-08-25, §3-4 ⑤-b) — the phone's 「you just
// connected」 fact, raised ONLY by a user action.
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §3-4 ⑤-b
//     (owner: the phone lands on the transcription page — fine — and MUST show
//     a floating confirmation there; 「这非常重要」)
//   ui/connections_page.dart `_enterChat(pairingJustEstablished: true)` —
//     reached from `_add()` alone (scan or typed code, a re-pair included);
//     `_connect()` and `_openCloud()` share the funnel but do NOT raise this
//     (owner 2026-08-26: it fired on every entry). main.dart wires it to
//     [raise].
//   ui/pairing_success_toast.dart — the renderer since 2026-08-26: a CENTRED
//     self-fading panel, no longer a banner-queue entry.
//   session/chat_transient_banner_timers.dart — still watches this ticket, as
//     the BACKSTOP: if the chat page unmounts before the panel expires, its
//     window still returns the ticket to null.
//
// ── THE TRIGGER IS THE USER'S ACTION, NOT 「CONNECTED」 ─────────────────────
// A banner that fires on every `roomJoins` edge would also fire on every
// automatic reconnect after a network flap — and a banner that fires 36 out of
// 36 times (the 0.3.27 warning) is a banner nobody reads. So the entry funnel
// is the only thing that can ARM this, and the ladder's rejoin can only ever
// RELEASE something the user already asked for. That is the reverse control the
// card demands, and the test makes it red by construction.
//
// ── 🔴 P0 (owner, 2026-09-01): ARMED BY THE USER, RAISED BY THE FACT ────────
// The owner's requirement is one sentence: 「the QR dissolving on the PC and the
// phone's 'connected' message must correspond to the same fact」. Until now they
// did not. `mobile:pair` is writer-only, so on a multi-node relay the phone
// pairs on the WRITER while its PC may live on a replica; the phone then follows
// its PC (`_followNodeIfMisplaced`) — and that hop is fire-and-forget, so this
// confirmation was raised, and the chat page opened, while the socket was still
// on the wrong node. 「Connected to the PC」 was on screen next to a 「PC is
// offline」 chip, and every audio frame was being dropped by `mirrorToPc` with no
// error, no refusal and no log.
//
// ⇒ the funnel now [armDeliberateEntry]s a ONE-SHOT ticket, and the first
// accepted ack that is [settledAtHomeNode] releases it ([noteJoinAtHomeNode]).
//
// ⚠️ ON EVERY DEPLOYMENT THAT EXISTS TODAY THIS CHANGES NOTHING. A single-node
// ack carries neither node field ⇒ `settledAtHomeNode` is true ⇒ the pair ack
// has already reported it by the time the funnel arms ⇒ the arm raises
// immediately, in the same turn, at byte-for-byte the moment it fires today.
//
// ── THE BUDGET DIES UNRAISED, AND THAT IS THE HONEST DEGRADE ────────────────
// If the phone has not settled within [kPairingSuccessSettleBudget] the ticket
// is dropped and NOTHING is shown. It is not shown late, and it is not replaced
// by an apology: the chat page is already open, and the surfaces that describe a
// phone which has not arrived are already on it and already true (the 「PC is
// offline」 chip, the connecting states, the queue's own count). A confirmation
// arriving 40 s after the user scanned a code would be answering a question they
// stopped asking, and a second sentence about the same link would be the
// stacking this repo refuses elsewhere.
//
// ── SHAPE ───────────────────────────────────────────────────────────────────
// A monotonically increasing ticket, null when nothing is up. The banner
// reconciler treats a changed non-null value as a FRESH occurrence and arms the
// 4 s auto-hide; `dismiss` (✕ or the timer) returns it to null. Not a bool: two
// raises in a row must each get a full window, and a bool that goes
// true→true is 「unchanged」 to the reconciler.

import 'dart:async';

import '../diag/diag_log.dart';
import '../ui/haptics.dart';

/// How long an armed ticket waits for this phone to settle on the PC's node.
///
/// 🔴 A CEILING ON THE WAIT, NOT AN ESTIMATE OF IT. The steps it has to cover
/// are all bounded and all measured elsewhere: the node-list read is capped at
/// [kNodeListTimeout] (5 s, and usually skipped now that the badge's directory
/// is reused), the socket teardown is local, the re-dial is immediate since the
/// hop kicks the ladder rather than riding its 1 s first rung, and the second
/// `mobile:reconnect` carries a 5 s ack timeout. Ten seconds is those two
/// timeouts back to back with room for one slow radio round trip.
///
/// ⚠️ It is deliberately NOT stretched to cover the replica-lag window
/// (kReplicaLagWindow, 75 s). Those two answer different questions: the lag
/// window decides how long we refuse to DELETE a pairing, and this decides how
/// long a user will still recognise a confirmation as being about the thing they
/// just did. Making one of them the other's number is how a value ends up
/// answering two questions.
const Duration kPairingSuccessSettleBudget = Duration(seconds: 10);

class PairingSuccessNotice {
  PairingSuccessNotice({
    required void Function() onChanged,
    Future<void> Function()? haptic,
    this.settleBudget = kPairingSuccessSettleBudget,
  }) : _onChanged = onChanged,
       _haptic = haptic ?? FlowMicHaptics.pairingSuccess;

  final void Function() _onChanged;
  final Future<void> Function() _haptic;

  /// A field so a harness can shrink it, exactly as `PttSession
  /// .candidateProbeTimeout` is one. The default is the real budget.
  final Duration settleBudget;

  int _next = 0;

  /// Is a deliberate entry waiting for this phone to reach the PC's node?
  bool get pendingSettle => _settleTimer != null;
  Timer? _settleTimer;

  /// The current occurrence, or null when nothing is up. Read by the banner
  /// reconciler (chat_transient_banner_timers.dart) as its 「face value」.
  int? get ticket => _ticket;
  int? _ticket;

  /// A deliberate entry into the chat page just succeeded. One haptic — its
  /// own feel, distinct from the three push-to-talk ones — and a fresh ticket.
  ///
  /// 🔴 THE DIAG LINE IS NOT DECORATION (2026-08-26). owner reported this
  /// banner missing on 0.3.33, and the investigation stopped at two mechanisms
  /// that cannot be told apart from outside the phone:
  ///   ① the ticket is raised while the connections page is still on top — the
  ///      chat page mounts one frame later, and the 4 s auto-hide window is
  ///      already running by then;
  ///   ② the slot renders exactly ONE banner, chosen by severity with a
  ///      first-pushed tie-break, and this one is pushed LAST — so anything
  ///      else queued (a mic-permission face, a link-drop) simply keeps it.
  ///
  /// Guessing between them is what produced all three of that day's defects, so
  /// this instruments instead: the next real session leaves a trail that names
  /// which one it was. The PC has had forensic for months and answered its own
  /// half of this bug in minutes; the phone had nothing, and that asymmetry is
  /// the actual finding.
  void raise() {
    _cancelSettleWait();
    _ticket = ++_next;
    diag('pairing.success.raised', <String, Object?>{'ticket': _ticket});
    unawaited(_haptic());
    _onChanged();
  }

  /// 🔴 P0 — THE FUNNEL'S ENTRY POINT. The user deliberately entered the chat
  /// page from a pairing they just completed; that is permission to show the
  /// confirmation, and it is the ONLY thing that is permission for it.
  ///
  /// It does not decide WHEN. Two outcomes, and the first is the one every
  /// installation in the world takes:
  ///   · the phone is already where its PC is — which includes every ack that
  ///     carries no node fields at all — so the fact is in hand and [raise] runs
  ///     in this same turn, at exactly the moment the old direct call ran;
  ///   · the phone still has to follow its PC to another node ⇒ hold the ticket
  ///     for [settleBudget] and let the first settled ack release it.
  ///
  /// [atHomeNodeNow] is the verdict of the ack behind the LAST room join
  /// (`ReconnectCoordinator.lastJoinAtHomeNode`), which the pair ack has always
  /// already written by the time this runs — `pair()` records the verdict and
  /// bumps `roomJoins` before it returns, and this funnel only runs after that
  /// return.
  ///
  /// ⚠️ ONE-SHOT, AND RE-ARMING RESTARTS THE WHOLE THING. A second deliberate
  /// entry is a second question by the user and gets its own full budget; the
  /// previous wait is dropped rather than inherited, for the same reason the
  /// banner reconciler refuses to let a fresh occurrence inherit a running
  /// window.
  void armDeliberateEntry({required bool atHomeNodeNow}) {
    _cancelSettleWait();
    if (atHomeNodeNow) {
      raise();
      return;
    }
    diag('pairing.success.armed', <String, Object?>{
      'budget_ms': settleBudget.inMilliseconds,
    });
    _settleTimer = Timer(settleBudget, () {
      _settleTimer = null;
      // 🔴 NOTHING IS SHOWN, AND NOTHING IS SAID INSTEAD. See the header: the
      // page is open, the honest surfaces are already on it, and a late
      // confirmation would be about a question the user stopped asking.
      diag('pairing.success.expired', const <String, Object?>{});
    });
  }

  /// 🔴 P0 — every accepted `mobile:pair` / `mobile:reconnect` ack reports
  /// whether it came from the node the paired PC lives on
  /// (`settledAtHomeNode`, signaling/node_follow.dart), routed here from
  /// `ChatController._onRoomJoined`.
  ///
  /// 🔴 IT CANNOT RAISE ANYTHING ON ITS OWN, and that is the whole of the
  /// 0.3.27 「36 out of 36」 protection surviving this change: with no armed
  /// ticket this method does nothing at all, so the ladder's rejoin after a
  /// network flap — which fires this on every single reconnect — still cannot
  /// put a confirmation on screen. An expired budget is the same as never armed.
  void noteJoinAtHomeNode(bool atHomeNode) {
    if (_settleTimer == null || !atHomeNode) return;
    raise();
  }

  void dismiss() {
    if (_ticket == null) return;
    _ticket = null;
    _onChanged();
  }

  /// The chat controller's teardown (chat_transient_banner_timers.dart
  /// `disposeRouted`). An armed budget outliving its controller would fire a
  /// diag line into a dead session and, worse, leave a pending timer that a
  /// widget test reports as a leak in whichever test happens to run next.
  void dispose() => _cancelSettleWait();

  void _cancelSettleWait() {
    _settleTimer?.cancel();
    _settleTimer = null;
  }
}
