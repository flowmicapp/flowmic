// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (background/lock screen → audio:pause
//     {background} + stop the heartbeat; foreground return only resumes while
//     still the active role) / §B-3 (never a silent stop)
//   docs/strategy/R6-UI-AUDIT-REMEDIATION.md P0-R5
//
// Bridges Flutter's app-lifecycle transitions to the app-root background /
// foreground work (session pause/resume plus foreground reachability refresh).
// Before this seam existed nothing in the app implemented WidgetsBindingObserver,
// so backgrounding / lock-screen left capture running (or dropped it silently) —
// the exact silent-stop the red line forbids.
//
// Host this HIGH in the tree (app root) so the observer lives for the whole app
// session and never re-registers on navigation. The pause/resume callbacks are
// injected (wired to PttSession.pauseCapture / resumeCapture) so the widget is
// unit-testable without the composition root.
//
// ── 🔴 Card F1: WHICH EDGES COUNT AS「后台」("background") ────────────────
// owner ruling ①: 「电脑应该认为手机是『暂停』（还在配对，只是胶囊收起）」 ("the
// PC should treat the phone as 'paused' — still paired, just with the capsule
// collapsed"). The PC
// now COLLAPSES ITS CAPSULE on the pause this widget triggers, so a wrong edge is
// no longer a harmless extra frame — it is a visible flicker on another machine.
//
// ONLY [AppLifecycleState.paused] counts. The judge is the SDK's own enum doc
// (bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart), which is explicit:
//   · `paused` — 「The application is not currently visible to the user, and not
//     responding to user input.」 That IS 「切到后台/锁屏」 ("switched to
//     background / lock screen"), and nothing else is.
//   · `inactive` — 「a system dialog, another view… It will also be inactive when
//     the notification window shade is down, or the application switcher is
//     visible.」 The app is STILL VISIBLE. Counting it collapses the PC capsule
//     for the microphone-permission dialog this app now shows on first PTT
//     (card U2, `Permission.microphone.request()`), for the notification shade, for
//     the app switcher and for an incoming-call banner.
//   · `hidden` — 「a transition to this state is synthesized before the [paused]
//     state is entered when coming from [inactive], AND before the [inactive]
//     state is entered when coming from [paused].」 It fires on BOTH legs, so
//     counting it re-pauses the session while the app is coming BACK. (The
//     pre-F1 mapping counted all three: one away-and-back round trip called
//     onBackground four times, twice of them on the return.)
//   · `detached` — terminal teardown; dispose() handles the session.
//
// ── 🔴 THE EDGES ARE PAIRED ────────────────────────────────────────────────
// [onForeground] fires ONLY after a matching [onBackground]. Without that latch a
// permission dialog (inactive → resumed, no background at all) would emit a
// resume nobody paused — and on the PC an unpaired resume re-surfaces a capsule
// the user had just dismissed. The pairing also makes both callbacks idempotent
// at the source, which matters now that the session's wire emits are no longer
// gated on the recorder being in a particular state.

import 'dart:async';

import 'package:flutter/widgets.dart';

class AppLifecycleBridge extends StatefulWidget {
  const AppLifecycleBridge({
    super.key,
    required this.onBackground,
    required this.onForeground,
    required this.child,
  });

  /// Invoked when the app actually LEAVES THE FOREGROUND — the `paused` edge and
  /// only that one (app-switch, home, lock screen). Wired to
  /// PttSession.pauseCapture(reason:'background'), which stops an in-flight
  /// capture and tells the PC 「暂停」 ("paused") even when nothing is recording.
  /// Called at most once per background; see the header for the excluded edges.
  final Future<void> Function() onBackground;

  /// Invoked when the app RETURNS FROM a background — the `resumed` edge, and
  /// only when [onBackground] actually fired for it. The app root wires both
  /// PttSession.resumeCapture() and the instance reachability refresh here,
  /// reusing this one lifecycle observer.
  final Future<void> Function() onForeground;

  final Widget child;

  @override
  State<AppLifecycleBridge> createState() => _AppLifecycleBridgeState();
}

class _AppLifecycleBridgeState extends State<AppLifecycleBridge>
    with WidgetsBindingObserver {
  /// True between a delivered [onBackground] and its matching [onForeground].
  /// This is the whole pairing latch — see the header.
  bool _backgrounded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
        if (_backgrounded) return;
        _backgrounded = true;
        unawaited(widget.onBackground());
      case AppLifecycleState.resumed:
        if (!_backgrounded) return;
        _backgrounded = false;
        unawaited(widget.onForeground());
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        // Deliberately inert — see the header for why each of these three is
        // NOT 「后台」 ("background"). `detached` is terminal teardown; dispose() owns it.
        break;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

