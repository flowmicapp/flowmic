// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §3 (the
//     pairing QR also exists as `https://flowmic.app/go/pair?…`)
//   apps/mobile/android/app/src/main/AndroidManifest.xml + ios/Runner/
//     Runner.entitlements (card APPLINK-1: the two declarations that make the
//     OS hand that URL to THIS app instead of a browser)
//   CLAUDE.md red line: no silent failures — in BOTH directions
//
// Card APPLINK-2 — WHAT AN INCOMING OS LINK MEANS, and WHETHER THIS MOMENT IS
// ONE IN WHICH WE MAY ACT ON IT. Both halves are pure so both can be driven
// from a table; the moving parts are next door in pair_link_router.dart.
//
// 🔴 WHY THIS FILE EXISTS AT ALL. APPLINK-1 told Android and iOS that this app
// owns `https://flowmic.app/go/pair`, and nothing in the Dart tree was
// listening: the only `app_links` subscription in the app is built inside the
// sign-in sheet (ui/login_sheet.dart) and only recognises the
// `flowmic://login` hand-back. So once the association files are published, a
// person scanning the pairing QR would watch the OS open FlowMic — and FlowMic
// would do nothing at all. That is worse than not claiming the link: the app
// is now visibly in front of them, visibly not reacting.

import '../ui/scan_payload.dart';

/// The kinds of incoming URL this app can be handed, named so that a router
/// says out loud which ones it acts on rather than acting on 「whatever
/// arrives」.
///
/// 🔴 [browserLogin] is listed HERE and acted on NOWHERE IN THIS FAMILY. Its
/// one consumer is `BrowserLoginController._onLink` (auth/
/// browser_login_controller.dart), which is subscribed only while the sign-in
/// sheet is open and which already refuses everything that is not a login
/// callback (`isBrowserLoginLink`). Naming the kind is the difference between
/// 「this router deliberately leaves that to someone else」 and 「this router
/// happened not to match it」 — the second is how one listener quietly becomes
/// the answer to two questions.
enum IncomingLinkKind {
  /// A FlowMic pairing link — `flowmic://pair?…` or its https twin.
  pairing,

  /// The console's `flowmic://login` hand-back. Not this family's business.
  browserLogin,

  /// Anything else. Reachable in practice only if a future declaration claims
  /// a URL shape nothing here understands, which is precisely when silence
  /// would be the wrong answer to give the user — so it is named, not dropped
  /// into an `else`.
  unrecognised,
}

/// Classify one URL the operating system handed this process.
///
/// 🔴 DELEGATES, does not decide. `classifyScan` (ui/scan_payload.dart) is
/// already THE author of 「is this our link」 for the camera, and it owns the
/// one Dart spelling of both prefixes ([kPairLinkPrefix] /
/// [kPairLinkPrefixHttps], the latter GENERATED from the protocol package's
/// `PAIR_HTTPS_HOST` + `PAIR_HTTPS_PATH` by
/// apps/mobile/tool/gen_protocol.mjs). A second prefix test here would be
/// a second answer to that question, and the day the host or the path moves
/// only one of them would be updated.
IncomingLinkKind classifyIncomingLink(Uri link) {
  switch (classifyScan(link.toString()).verdict) {
    case ScanVerdict.pairLink:
      return IncomingLinkKind.pairing;
    case ScanVerdict.loginLink:
      return IncomingLinkKind.browserLogin;
    case ScanVerdict.foreign:
    case ScanVerdict.nothing:
      return IncomingLinkKind.unrecognised;
  }
}

/// What the app is doing at the instant a pairing link lands. Three facts, and
/// each of them is READ from something the user can see or hear, never from a
/// flag this family keeps for itself.
class PairLinkSituation {
  const PairLinkSituation({
    required this.instanceListIsCurrent,
    required this.captureInFlight,
    required this.pairingInFlight,
  });

  /// Is the instance list the route the person is looking at? False whenever
  /// anything is stacked on top of it — the chat page, settings, history, or a
  /// modal sheet.
  final bool instanceListIsCurrent;

  /// Is a microphone capture open right now — a held PTT utterance, or a long
  /// recording that is still running (it survives backgrounding, which is
  /// exactly how it can still be open when a link arrives).
  final bool captureInFlight;

  /// Is a pair attempt already on the wire? Acting again would be a second
  /// dial over the first, and the refusal the user would see
  /// (`ConnectionsController.addByCode`'s `'BUSY'` early exit) sets no error
  /// at all — a refusal with nothing to render is the banned shape.
  final bool pairingInFlight;
}

/// What to do with a pairing link that has just arrived.
enum PairLinkAction {
  /// Pair now, through the funnel the 「add device」 button already uses.
  pairNow,

  /// Something is stacked on top of the instance list and nothing is being
  /// captured: come back to the list — which is the same movement the person's
  /// own back gesture makes — and pair from there.
  returnToInstanceList,

  /// Keep the link and do NOTHING ELSE. Chosen when acting would destroy
  /// something the person cannot get back (an open capture) or would collide
  /// with a pairing already in flight.
  hold,
}

/// 🔴 THE DECISION, and the reasoning behind each arm.
///
/// There are only three possible answers to 「a pairing link arrived at a bad
/// moment」: act anyway, drop it, or keep it. Dropping it is the defect this
/// whole card exists to remove, so it is not on the list. Acting anyway is
/// available only while acting costs nothing.
///
/// · [PairLinkAction.hold] while a capture is open. Pairing dials a different
///   computer, which tears down the socket the current utterance is riding —
///   a long recording would lose the rest of itself. 「Interrupt it and say
///   so」 would need a sentence this card is not allowed to write, and 「stop
///   recording silently」 is not on the table at any price. So the link waits.
///   It is not forgotten: the moment the person leaves the recording screen,
///   the instance list's own return path re-asks this question (see
///   connections_pair_link.dart), and the pairing happens then.
///   ⚠️ WHAT THIS COSTS, stated rather than implied: between arrival and that
///   moment the app says nothing about the link it is holding. A sentence is
///   owed there and this card does not author it.
/// · [PairLinkAction.returnToInstanceList] when a route is merely stacked on
///   top. Popping back is loud, immediate, reversible and is what the person
///   would have done by hand; leaving them on the settings page staring at an
///   app that did not react is the shape being fixed.
/// · [PairLinkAction.pairNow] otherwise.
PairLinkAction decidePairLink(PairLinkSituation now) {
  if (now.captureInFlight || now.pairingInFlight) return PairLinkAction.hold;
  if (!now.instanceListIsCurrent) return PairLinkAction.returnToInstanceList;
  return PairLinkAction.pairNow;
}
