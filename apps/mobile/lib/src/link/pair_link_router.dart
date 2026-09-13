// SPEC-REF:
//   incoming_link.dart (the two pure halves this file drives)
//   CLAUDE.md 反 façade ②: a DI default is the real implementation or a throw,
//     never a friendly empty one
//   CLAUDE.md red line: no silent failures
//
// Card APPLINK-2 — THE MOVING PARTS of「the OS just handed us a pairing URL」:
// a subscription, a launch-argument drain, and one slot for a link that
// arrived at a moment we may not act on.
//
// ── WHY A SECOND SUBSCRIPTION, AND NOT THE SIGN-IN SHEET'S ────────────────
// `AppLinks()` is a singleton whose `uriLinkStream` is a BROADCAST controller
// (app_links 7.0.0, lib/src/app_links.dart), so a second listener is free and
// changes nothing about the first. That is a convenience; it is not the
// reason.
//
// The sign-in sheet's subscription is built inside `BrowserLoginController`,
// lives only while that sheet is open, and answers exactly one question —
//「did the browser round trip come back」. A pairing link can arrive at any
// second of the app's life and answers a different one. Folding both into one
// listener would make a single object decide, per URL, which of two flows it
// belongs to: this repo's number-one defect shape. Instead there are two
// listeners, each of which recognises exactly ONE kind BY NAME
// (`classifyIncomingLink` here, `isBrowserLoginLink` there) and declines the
// other's — and neither of them declines a link by falling off the end of an
// `if`.
//
// ⚠️ [BrowserLoginLinks] in auth/deep_link_source.dart has the same two
// members as [IncomingLinks] below. They are deliberately NOT merged: that one
// is named for its flow and documents the sign-in cold start in its own terms,
// and making the pairing path reach into `auth/` for a plugin wrapper would be
// a worse coupling than two four-line adapters over the same singleton.

import 'dart:async';

import 'package:app_links/app_links.dart';

import 'incoming_link.dart';

/// Incoming OS URLs, both halves of delivery:
///  · [stream] — the app was ALREADY RUNNING when the link arrived;
///  · [initialLink] — the app was NOT running and the OS started it with the
///    URL. This is a different call, and it is the half naive implementations
///    miss: scanning the QR works while the app is open and does nothing at
///    all from cold, which reads as a flaky link rather than as a code path
///    that was never written.
abstract class IncomingLinks {
  Stream<Uri> get stream;

  /// The URL this process was launched with, or null. Answering the same URL
  /// on a second call is fine — [PairLinkRouter] de-duplicates.
  Future<Uri?> initialLink();
}

/// Production: the app_links plugin.
class AppLinksIncomingLinks implements IncomingLinks {
  AppLinksIncomingLinks([AppLinks? links]) : _links = links ?? AppLinks();

  final AppLinks _links;

  @override
  Stream<Uri> get stream => _links.uriLinkStream;

  @override
  Future<Uri?> initialLink() => _links.getInitialLink();
}

/// Routes incoming pairing links into the pairing path the「add device」button
/// already uses, and holds one back when this is not a moment to pair.
///
/// This object owns no product decisions: [decidePairLink] makes them and the
/// three callbacks below carry them out. What it owns is the SLOT — the reason
/// a link that arrives at a bad moment is still acted on later instead of
/// being dropped on the floor.
class PairLinkRouter {
  PairLinkRouter({
    required IncomingLinks links,
    required PairLinkSituation Function() situation,
    // 反 façade ②: both required, and neither defaulted to a no-op. A
    // silently-succeeding `pair` would leave every test green over an app that
    // never pairs — which is the exact failure this card repairs.
    required Future<void> Function(String link) pair,
    required void Function() returnToInstanceList,
  })  : _links = links,
        _situation = situation,
        _pair = pair,
        _returnToInstanceList = returnToInstanceList {
    _sub = links.stream.listen(
      _onLink,
      // A dead link stream must not take the page down with it. There is
      // nothing to tell the user here: they have not asked for anything yet.
      onError: (Object _) {},
    );
  }

  final IncomingLinks _links;
  final PairLinkSituation Function() _situation;
  final Future<void> Function(String link) _pair;
  final void Function() _returnToInstanceList;

  StreamSubscription<Uri>? _sub;
  bool _disposed = false;

  /// The launch URL, once consumed, so a second [drainInitialLink] — the page
  /// remounted after onboarding, say — does not re-run a link already
  /// answered.
  Uri? _drainedInitial;

  /// The one link waiting for a moment in which it may be acted on. One slot,
  /// last-one-wins: two pairing links in a row means the person aimed at a
  /// second computer, and the second one is the one they meant.
  String? _held;

  /// True while [_pair] is outstanding, so a re-entrant advance cannot start a
  /// second pairing over the first.
  bool _acting = false;

  /// COLD START. The app was not running; the OS started it with the URL, and
  /// no stream listener existed at that instant to receive it.
  Future<void> drainInitialLink() async {
    final Uri? link = await _links.initialLink();
    if (_disposed || link == null) return;
    if (_drainedInitial == link) return;
    _drainedInitial = link;
    _onLink(link);
  }

  /// Re-ask「may we act now」for a link that is being held. Called from the
  /// edges that can turn that answer from no to yes: the instance list
  /// becoming the current route again — which is also when a recording has
  /// ended, because a capture only ever runs from a page stacked above it.
  void retryHeld() => unawaited(_advance());

  void _onLink(Uri link) {
    switch (classifyIncomingLink(link)) {
      case IncomingLinkKind.pairing:
        break;
      case IncomingLinkKind.browserLogin:
        // Named, not swallowed: `BrowserLoginController` owns this one and is
        // subscribed to the same broadcast stream while its sheet is open.
        return;
      case IncomingLinkKind.unrecognised:
        // Nothing this app declared produces such a URL, so nothing here can
        // act on it honestly. Guessing is worse than declining.
        return;
    }
    _held = link.toString();
    unawaited(_advance());
  }

  Future<void> _advance() async {
    if (_disposed || _acting) return;
    final String? link = _held;
    if (link == null) return;
    switch (decidePairLink(_situation())) {
      case PairLinkAction.pairNow:
        // Cleared BEFORE the await, never after: `_pair` ends by pushing the
        // chat page, and a slot still holding this link at that moment would
        // be picked up by the very return edge that push creates — the same
        // computer paired twice off one scan.
        _held = null;
        _acting = true;
        try {
          await _pair(link);
        } finally {
          _acting = false;
        }
        // A link that arrived while the first one was on the wire is still
        // here, and is now the one the person meant.
        if (!_disposed && _held != null) unawaited(_advance());
      case PairLinkAction.returnToInstanceList:
        // Idempotent by construction: popUntil(isFirst) on a list that is
        // already first does nothing, and this is only ever reached from an
        // arrival or from an explicit retry edge — never from a loop.
        _returnToInstanceList();
      case PairLinkAction.hold:
        return;
    }
  }

  void dispose() {
    _disposed = true;
    unawaited(_sub?.cancel());
    _sub = null;
  }
}
