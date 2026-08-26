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
// 36 times (the 0.3.27 warning) is a banner nobody reads. So this is raised
// from the connections page's entry funnel and NOWHERE ELSE: the ladder's
// rejoin does not know this object exists. That is the reverse control the
// card demands, and the test makes it red by construction.
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

class PairingSuccessNotice {
  PairingSuccessNotice({required void Function() onChanged, Future<void> Function()? haptic})
    : _onChanged = onChanged,
      _haptic = haptic ?? FlowMicHaptics.pairingSuccess;

  final void Function() _onChanged;
  final Future<void> Function() _haptic;

  int _next = 0;

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
    _ticket = ++_next;
    diag('pairing.success.raised', <String, Object?>{'ticket': _ticket});
    unawaited(_haptic());
    _onChanged();
  }

  void dismiss() {
    if (_ticket == null) return;
    _ticket = null;
    _onChanged();
  }
}
