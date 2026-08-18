// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 / §B-3 (background → audio:pause,
//     return-from-background → audio:resume)
//   ui/app_lifecycle_bridge.dart (WHICH lifecycle transitions count as a real
//     background — this file is only WHAT to do on them)
//   signaling/reconnect.dart ([ReconnectCoordinator.kickNow])
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// main.dart crossed `verify/lint/file-size.mjs`'s SRC_MAX=800 when card B2
// (2026-08-18) added a third consumer to the return-from-background edge.
// Splitting under the gate rather than at it is this repo's standing rule, and
// deleting the reasoning to save lines would throw away the part of these edges
// that is hardest to reconstruct — every clause below is a defect somebody paid
// for.
//
// 🔴 The cut follows 「which question it answers」: 「进出后台的那一刻要做什么」
// ("what to do at the moment of leaving/returning to the background"). What
// stayed in main.dart is everything about WHICH objects exist. These two
// functions take their collaborators as arguments rather than reading fields,
// which is what makes the edge testable with no widget tree at all.
//
// 🔴 DIFF DISCIPLINE: both bodies moved **character-for-character** out of
// main.dart's `AppLifecycleBridge`, comments included. **Any difference beyond
// the parameters is a bug.**

import 'dart:async';

import '../ptt/ptt_session.dart';
import '../session/connections_controller.dart';

/// Leaving for the background.
///
/// ⚠️ Returns the future rather than swallowing it: `AppLifecycleBridge`'s
/// `onBackground` is a `Future<void> Function()` **because the bridge awaits it**
/// to keep its background/foreground pairs 1:1. Dropping it here would let a
/// return-from-background edge overtake the pause it is supposed to undo.
Future<void> onAppBackground(PttSession session) =>
    session.pauseCapture(reason: 'background');

/// Coming back from a real background.
Future<void> onAppForeground({
  required PttSession session,
  required ConnectionsController connections,
}) async {
  // ONE return-from-background edge, two independent consumers: restore a
  // paused capture (and un-pause the PC capsule) and replace the instance
  // list's stale probe snapshot. Starting both before awaiting also keeps
  // probing alive if audio resume later reports an error.
  // ⚠️ Card F1 narrowed WHEN this runs: `resumed` edges that were never a
  // background (a permission dialog, the notification shade) no longer
  // reach it. That is the point for `resumeCapture` — an unpaired resume
  // re-surfaces a PC capsule the user dismissed — and it is harmless for
  // the probe snapshot, which is only stale after a real absence.
  // 🔴 B2 (2026-08-18) — THE THIRD CONSUMER of this one edge, and the one
  // it was missing. Coming back to a phone whose link died while it was
  // parked does not dial: Android freezes Dart timers in the background,
  // so the ladder's rung is not merely late, it did not run at all — and
  // nothing here ever told it to try. The user's only lever was backing
  // out to the instance list and tapping the row.
  //
  // ⚠️ Not a claim that the link is down: `kickNow` re-checks `_running`
  // and the live socket status at fire time, so on a session that stayed
  // up this is a no-op that writes one forensic line.
  //
  // ⚠️ It is fired BEFORE the two awaits on purpose. `resumeCapture` can put a
  // frame on the wire, and a frame emitted into a dead socket is dropped
  // silently; asking for the dial first costs nothing and gives the link the
  // head start.
  session.reconnect.kickNow(reason: 'foreground');
  await Future.wait<void>(<Future<void>>[
    session.resumeCapture(),
    connections.refreshReachability(),
  ]);
}
