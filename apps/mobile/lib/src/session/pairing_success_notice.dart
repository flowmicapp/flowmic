// Card PAIR-SUCCESS (owner 2026-08-25, §3-4 ⑤-b) — the phone's 「you just
// connected」 fact, raised ONLY by a user action.
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §3-4 ⑤-b
//     (owner: the phone lands on the transcription page — fine — and MUST show
//     a floating confirmation there; 「这非常重要」)
//   ui/connections_page.dart `_enterChat` — the ONE funnel every deliberate
//     entry goes through (scan-pair, typed code, a tap on a listed PC, the
//     cloud card); main.dart wires it to [raise].
//   session/chat_transient_banner_timers.dart — the EVENT-type banner
//     machinery (kBannerAutoHideAfter) this rides; the banner itself is in
//     ui/banner_queue.dart under BannerIds.pairingSuccess.
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
  void raise() {
    _ticket = ++_next;
    unawaited(_haptic());
    _onChanged();
  }

  void dismiss() {
    if (_ticket == null) return;
    _ticket = null;
    _onChanged();
  }
}
