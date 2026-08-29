// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card NR-2b
//     — 「健壮性清单」: deep link unregistered / no browser installed / the user
//     cancels half way / the code expires / state binding against login
//     injection / a named message and a retry when the hand-back fails; a
//     loading state throughout, and no silent failure)
//
// The MOVING PARTS of the browser sign-in round trip: a clock, a subscription,
// a launcher and a store. Every DECISION it makes lives next door in
// browser_login.dart, which is pure; this file is the wiring, and the wiring is
// where each line of the robustness checklist is actually answered:
//
//   · no browser / launch refused → [BrowserLoginCodes.openFailed], phase back
//     to failed, the sheet offers a retry and still shows the QR entry;
//   · the user cancels and comes back with nothing → nothing on either OS emits
//     a "the user gave up" event, so [kBrowserLoginWaitTimeout] is the only
//     mechanism there can be: the wait ends, the spinner stops, the sheet says
//     so and offers a retry;
//   · the deep link is not registered → indistinguishable, FROM HERE, from a
//     user who cancelled — the OS tells this process nothing in either case, so
//     it lands on the same timeout and the same retry. Stated rather than
//     implied: this app cannot detect an unregistered scheme, and the copy is
//     therefore written to be true for both;
//   · the code expires → the SERVER refuses it and its own code is rendered by
//     LoginController (this flow adds no second opinion about the server's
//     answer);
//   · state binding → verified in browser_login.dart before the nonce is ever
//     sent anywhere;
//   · cold start → the pending request is PERSISTED, and [drainInitialLink]
//     picks up the URL the process was launched with.
//
// 🔴 TWO ERROR SURFACES, ON PURPOSE. This controller reports what went wrong
// with the ROUND TRIP; `LoginController.errorCode` reports what the account
// SERVER said. Folding them into one field would be this repo's number-one
// defect shape (one value answering two questions) and would make 「the browser
// never came back」 indistinguishable from 「the server rejected the code」 —
// two failures with opposite actions.

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'browser_login.dart';
import 'deep_link_source.dart';
import 'login_controller.dart';
import 'saas_endpoint.dart';

enum BrowserLoginPhase {
  /// Nothing in flight. Also where a completed sign-in lands: success is
  /// LoginController's to report, not this one's.
  idle,

  /// Handing the URL to the OS.
  opening,

  /// The browser has it; we are waiting for the callback.
  waiting,

  /// A callback arrived, passed verification, and the nonce is being redeemed.
  redeeming,

  /// The round trip failed. [BrowserLoginController.errorCode] says how.
  failed,
}

class BrowserLoginController extends ChangeNotifier {
  BrowserLoginController({
    required LoginController login,
    required BrowserLoginLinks links,
    required BrowserLoginStateStore store,
    // 反 façade ②: required, and NOT defaulted to a no-op that returns true.
    // A silently-succeeding opener would leave the flow permanently in
    // `waiting` with every test green.
    required BrowserLoginOpener opener,
    String? endpoint,
    Duration waitTimeout = kBrowserLoginWaitTimeout,
    Duration stateTtl = kBrowserLoginStateTtl,
    DateTime Function() now = DateTime.now,
    String Function() mintState = mintBrowserLoginState,
  }) : _login = login,
       _links = links,
       _store = store,
       _opener = opener,
       _endpoint = endpoint ?? resolveSaasEndpoint(),
       _waitTimeout = waitTimeout,
       _stateTtl = stateTtl,
       _now = now,
       _mintState = mintState {
    _sub = _links.stream.listen(
      _onLink,
      // A dead link stream must not take the sheet down with it. There is
      // nothing to tell the user here — they have not asked for anything yet —
      // and the wait timeout still covers the case where this was the delivery
      // that would have arrived.
      onError: (Object _) {},
    );
  }

  final LoginController _login;
  final BrowserLoginLinks _links;
  final BrowserLoginStateStore _store;
  final BrowserLoginOpener _opener;
  final String _endpoint;
  final Duration _waitTimeout;
  final Duration _stateTtl;
  final DateTime Function() _now;
  final String Function() _mintState;

  StreamSubscription<Uri>? _sub;
  Timer? _waitTimer;
  bool _disposed = false;

  /// The URL this process was launched with, once consumed. Kept so a second
  /// [drainInitialLink] — the sheet is opened, closed and opened again — does
  /// not re-run a link that has already been answered.
  Uri? _drainedInitial;

  BrowserLoginPhase _phase = BrowserLoginPhase.idle;
  BrowserLoginPhase get phase => _phase;

  String? _errorCode;

  /// A [BrowserLoginCodes] value, or null. Rendered by
  /// `AppStrings.browserLoginError`.
  String? get errorCode => _errorCode;

  /// True while the user must be shown a spinner and the two entries must not
  /// be tappable again.
  bool get isBusy =>
      _phase == BrowserLoginPhase.opening ||
      _phase == BrowserLoginPhase.waiting ||
      _phase == BrowserLoginPhase.redeeming;

  /// The sign-in page's plain address, WITHOUT the one-time query — shown on
  /// screen, selectable and copyable, so a user whose phone opens nothing still
  /// has a route, and so the site they are about to type a password into is
  /// named before they leave this app.
  ///
  /// The `state` is deliberately not in it: a value pasted into another device
  /// would carry a binding that device cannot satisfy, and the resulting
  /// refusal would be ours, not the user's mistake.
  String get signInPageUrl => '${_endpoint.replaceAll(RegExp(r'/+$'), '')}/signin';

  /// Start a round trip: mint the binding, persist it, open the browser.
  Future<void> start() async {
    if (isBusy) return;
    _errorCode = null;
    _phase = BrowserLoginPhase.opening;
    _notify();

    final BrowserLoginRequest request = BrowserLoginRequest(
      state: _mintState(),
      startedAtMs: _now().millisecondsSinceEpoch,
      endpoint: _endpoint,
    );
    // Persisted BEFORE the browser opens, never after: between those two
    // moments the OS may hand our process to the background and kill it, and a
    // callback arriving against no stored request is refused (correctly, and
    // for a reason that would be entirely our fault).
    await _store.write(request.encode());
    if (_disposed) return;

    final bool opened = await _opener(
      buildBrowserSignInUrl(endpoint: _endpoint, state: request.state),
    );
    if (_disposed) return;
    if (!opened) {
      await _store.clear();
      _fail(BrowserLoginCodes.openFailed);
      return;
    }
    _phase = BrowserLoginPhase.waiting;
    _armWaitTimer();
    _notify();
  }

  /// The user backed out of the wait themselves. Not an error: they are exactly
  /// where they were before they tapped, and the sheet says nothing.
  Future<void> cancel() async {
    if (_phase != BrowserLoginPhase.waiting &&
        _phase != BrowserLoginPhase.opening) {
      return;
    }
    _waitTimer?.cancel();
    _waitTimer = null;
    await _store.clear();
    if (_disposed) return;
    _phase = BrowserLoginPhase.idle;
    _errorCode = null;
    _notify();
  }

  /// Clear a failure so the sheet's two entries read as tappable again.
  void clearError() {
    if (_phase != BrowserLoginPhase.failed) return;
    _phase = BrowserLoginPhase.idle;
    _errorCode = null;
    _notify();
  }

  /// COLD START. Called when the sign-in sheet opens: if this process was
  /// launched by a `flowmic://login` URL, that URL is still available from the
  /// platform and is answered now.
  ///
  /// ⚠️ WHAT THIS DOES AND DOES NOT BUY, stated so nobody reads more into it.
  /// The pending request survives the relaunch (it is on disk) so the binding
  /// still verifies and the sign-in completes. What does NOT survive is the
  /// screen: the app comes back on its normal first page, and the callback is
  /// consumed at the moment the user opens the sign-in sheet again — not
  /// before. Within [kBrowserLoginStateTtl] that is a working flow with one
  /// extra tap; past it the user gets [BrowserLoginCodes.expired] in words.
  Future<void> drainInitialLink() async {
    final Uri? link = await _links.initialLink();
    if (_disposed || link == null) return;
    if (_drainedInitial == link) return;
    _drainedInitial = link;
    await _onLink(link);
  }

  Future<void> _onLink(Uri link) async {
    // Not ours: another app's scheme, or another `flowmic://` host. Silence is
    // correct here — this is not a failure of anything the user asked for.
    if (!isBrowserLoginLink(link)) return;

    final BrowserLoginRequest? pending = BrowserLoginRequest.decode(
      await _store.read(),
    );
    if (_disposed) return;

    final BrowserLoginVerdict verdict = verifyBrowserLoginCallback(
      link: link,
      pending: pending,
      nowMs: _now().millisecondsSinceEpoch,
      ttl: _stateTtl,
    );
    _waitTimer?.cancel();
    _waitTimer = null;
    // One-time by construction: the binding is dropped whatever the verdict, so
    // a replayed URL finds nothing and is refused as unsolicited.
    await _store.clear();
    if (_disposed) return;

    if (!verdict.ok) {
      _fail(verdict.refusal!);
      return;
    }

    _phase = BrowserLoginPhase.redeeming;
    _errorCode = null;
    _notify();
    // The EXISTING redemption path — the same one the QR scan has used since
    // GA-31, over `mobile:login {qr_nonce}`. This card adds no second way in,
    // which is also why an expired code reads here exactly as it reads there.
    await _login.loginWithQr(nonce: verdict.nonce!, endpoint: verdict.endpoint);
    if (_disposed) return;
    // Whatever the server said is now LoginController's to render. This
    // controller goes quiet rather than paraphrasing it.
    _phase = BrowserLoginPhase.idle;
    _notify();
  }

  void _armWaitTimer() {
    _waitTimer?.cancel();
    _waitTimer = Timer(_waitTimeout, () async {
      if (_disposed || _phase != BrowserLoginPhase.waiting) return;
      await _store.clear();
      if (_disposed) return;
      _fail(BrowserLoginCodes.timedOut);
    });
  }

  void _fail(String code) {
    _phase = BrowserLoginPhase.failed;
    _errorCode = code;
    _notify();
  }

  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _waitTimer?.cancel();
    _waitTimer = null;
    unawaited(_sub?.cancel());
    _sub = null;
    super.dispose();
  }
}
