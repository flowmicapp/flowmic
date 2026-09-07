// Part of chat_controller.dart — card RC-1b's ONE adapter.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/pending_recovery_store.dart (what it builds)
//   apps/mobile/lib/src/ui/pending_recovery_route.dart (its only caller)
//
// WHY A PART FILE AND NOT A FIELD ON THE CONTROLLER
//
// The source needs two things the controller owns and nothing outside this
// library can reach: `backfill` (public) and `_recoverySourceLang` (private,
// and deliberately so — `chat_inbound_routes.dart` documents it as read by the
// two sweep edges and nothing else). A getter here is the smallest thing that
// hands both over without widening either.
//
// 🔴 IT BUILDS A NEW ONE EACH CALL, AND THAT IS CORRECT RATHER THAN LAZY.
// `PendingRecoveryStore` holds no state: it is two closures over the runner,
// and every answer it gives is read from disk at the moment it is asked. A
// cached instance would only add a lifetime to manage, and a stale one would
// be a screen reading a store bound to a session that has gone.

part of 'chat_controller.dart';

/// The pending-recovery screen's source, bound to this controller.
///
/// CALLER: `ui/pending_recovery_route.dart` — the light-record screen's entry
/// row and the retained-audio banner's action, which are the only two doors
/// into that page.
PendingRecoverySource pendingRecoveryOf(ChatController c) =>
    PendingRecoveryStore(
      runner: c.backfill,
      // The same value the two automatic sweep edges pass, read at press time
      // rather than captured: `chat_inbound_routes.dart` states the cost of
      // this approximation (a spoken-language change between recording and
      // recovery), and a copy taken when the screen opened would add a second,
      // staler approximation on top of it.
      sourceLang: () => c._recoverySourceLang,
    );
