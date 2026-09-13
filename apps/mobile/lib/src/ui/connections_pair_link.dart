// Part of connections_page.dart — card APPLINK-2: the instance list is where
// an incoming pairing URL is ANSWERED.
//
// ── WHY HERE, AND NOT AT THE COMPOSITION ROOT ─────────────────────────────
// This page already owns the pairing funnel: `_add` submits a code, and
// `_enterChat` is the ONE place that scopes the destination from the pairing
// being entered, raises the pairing confirmation and leaves the room on the
// way back. Putting the listener at the composition root would mean rebuilding
// that follow-up somewhere else, i.e. a second pairing path — and the sheet's
// own header already says what scanning is: 「an INPUT, not a second pairing
// path」. An OS link is one more input to the same funnel.
//
// ⚠️ WHAT THAT COSTS, stated rather than implied: this page's State does not
// exist during the first-run language screen and the 3-page guide (main.dart's
// `home:` builds those INSTEAD of it). A link arriving in those few seconds
// reaches no listener. The launch-argument half is still answered — the OS
// keeps handing us the same initial link and [_attachPairLinkRouterRouted]
// drains it the moment this page finally mounts — but a link that arrives on
// the STREAM while onboarding is on screen is lost. Not fixed here, and not
// pretended away.
//
// ── WHAT A PERSON SEES ────────────────────────────────────────────────────
//   · on the instance list, nothing recording → the pairing runs and the chat
//     page opens, exactly as it does after a camera scan;
//   · a pair the server refuses → the mapped, loud sentence
//     (`AppStrings.pairError`) in the same toast this page already uses for a
//     refused cloud entry. No new copy, and never a fabricated success;
//   · settings / history / an old chat on top, nothing recording → the app
//     comes back to the instance list by itself and then pairs;
//   · a capture open → NOTHING MOVES. See `decidePairLink` for why that is the
//     one arm that waits, and for the sentence this card does not write.

part of 'connections_page.dart';

/// Build this page's link router and answer the URL this process may have been
/// launched with.
///
/// 🔴 A null `incomingLinks` builds the REAL app_links source, never a quiet
/// double (反 façade ②). A no-op default here would make every test green over
/// an app in which no link is ever delivered — which is the state this card
/// found the product in.
PairLinkRouter _attachPairLinkRouterRouted(_ConnectionsPageState page) {
  final PairLinkRouter router = PairLinkRouter(
    links: page.widget.incomingLinks ?? AppLinksIncomingLinks(),
    situation: () => _pairLinkSituationRouted(page),
    pair: (String link) => _pairFromLinkRouted(page, link),
    returnToInstanceList: () => _returnToInstanceListRouted(page),
  );
  // COLD START. The app was not running and the OS started it with the URL, so
  // no stream event ever existed for it. This is a different call from the
  // subscription above, and forgetting it is the classic asymmetry: the link
  // works while the app is open and does nothing at all from cold.
  unawaited(router.drainInitialLink());
  return router;
}

/// Re-ask 「may we act now」 for a held link. Wired to the edges on which the
/// instance list becomes the current route again — which is also when a
/// recording has ended, since a capture only ever runs from a page stacked
/// above this one.
///
/// ⚠️ IT ASKS IMMEDIATELY, and that was MEASURED rather than assumed. This was
/// first written to defer a frame, on the theory that the Navigator would
/// still be unwinding the route it just closed and 「is the instance list the
/// current route」 would still answer NO. A reverse control that removed the
/// deferral passed on the first attempt — i.e. it measured nothing, and the
/// deferral was defending a hazard that does not exist here: a pushed route's
/// future completes after that route has left the navigator's present set, and
/// `_enterChat`'s tail runs later still, after `leaveRoom()` and the reload.
/// A frame of delay nothing needs, explained by a confident comment nothing
/// tests, is the shape this repo calls a façade — so it was removed.
void _retryHeldPairLinkRouted(_ConnectionsPageState page) =>
    page._pairLinks?.retryHeld();

/// The three facts `decidePairLink` weighs, each read from something the
/// person can see or hear.
PairLinkSituation _pairLinkSituationRouted(_ConnectionsPageState page) {
  final ConnectionsController c = page.widget.connections;
  return PairLinkSituation(
    // `isCurrent` is false for anything stacked on top — a pushed page and a
    // modal sheet alike. Deliberately not「is this page mounted」: this page
    // stays mounted underneath the chat page for the whole session.
    instanceListIsCurrent: ModalRoute.of(page.context)?.isCurrent ?? false,
    // Two capture shapes, and both must count. The FSM's `recording` is a held
    // PTT utterance; `continuousStillCapturing` is a long recording, which is
    // the one that can genuinely still be open when a link arrives (it
    // survives backgrounding, and backgrounding is how the person got to the
    // QR in the first place).
    captureInFlight: c.session.fsm.session == SessionState.recording ||
        c.session.continuousStillCapturing,
    pairingInFlight: c.busy,
  );
}

/// Pair from [link], through the funnel「add device」already uses.
///
/// 🔴 `addByCode` is THE pairing path and `PairEntry.parse` inside it is THE
/// parser — this passes the URL through VERBATIM, exactly as the scan sheet
/// does for a decoded barcode. It writes no second parser, spells no prefix of
/// its own, and reads nothing out of the query.
Future<void> _pairFromLinkRouted(_ConnectionsPageState page, String link) async {
  final AppStrings s = AppStrings.of(page.widget.appSettings.locale);
  final ConnectOutcome outcome =
      await page.widget.connections.addByCode(rawEndpoint: '', code: link);
  if (!page.mounted) return;
  if (outcome.success) {
    // Deliberately NOT awaited: `_enterChat` does not return until the person
    // leaves the chat page, and holding the router's in-flight guard for a
    // whole session would stop a second link from ever asking to be answered.
    // The same call, and the same `pairingJustEstablished`, that `_add` makes —
    // this really did just establish a pairing.
    unawaited(page._enterChat(pairingJustEstablished: true));
    return;
  }
  // Fail-loud, in the sentence this page already owns for a refused entry
  // (`_openCloud` toasts `cloudError` from the same spot). `pairError` maps the
  // server's code — including the pre-0.2.66 desktop's missing `pcid=`, whose
  // sentence names the way out — so a refusal is never a shrug and never a new
  // string invented at the edge.
  page._toast(s.pairError(outcome.error));
}

/// Come back to the instance list. The same movement the person's own back
/// gesture makes, which is why it needs no words: it is loud, immediate and
/// reversible.
///
/// ⚠️ It only ASKS. The link stays held and is acted on by the return edge the
/// pop itself produces — `_enterChat`'s tail, or `whenComplete` on the
/// settings / history pushes. Acting here instead would race that tail:
/// `_enterChat` ends with `leaveRoom()`, which would tear down the socket a
/// pairing started from here was in the middle of dialling.
void _returnToInstanceListRouted(_ConnectionsPageState page) {
  if (!page.mounted) return;
  Navigator.of(page.context).popUntil((Route<dynamic> r) => r.isFirst);
}
