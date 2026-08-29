// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (owner
//     ruling: the clients carry NO username/password login. The phone gets two
//     entries — "sign in with the browser" and "scan the QR" — and account
//     creation, verification and password recovery live on the web only. Its
//     robustness checklist is the list this file answers, item by item.)
//   apps/server-core/src/auth/qr-grant.ts (the credential this flow redeems: a
//     60-second, single-use, 128-bit nonce minted only by an authenticated
//     console — see that file's header for what it is and is not)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §2
//
// The DECISIONS of the browser sign-in round trip, with no plugin, no clock and
// no I/O in sight. The controller next door (browser_login_controller.dart) owns
// the moving parts; everything that can be got WRONG lives here, where a test
// can drive it directly.
//
// THE ROUND TRIP, in one paragraph. The phone mints a random `state`, remembers
// it, and opens the system browser at `<endpoint>/signin?flow=mobile&state=…`.
// The user signs in (or registers, or uses Google — all of that is the web's
// job now). The console then sends the browser to
// `flowmic://login?endpoint=<origin>&t=<nonce>&state=<echoed>`, the OS hands
// that URL to this app, and the nonce is redeemed over the EXISTING
// `mobile:login {qr_nonce}` arm — the same wire the QR scan has used since
// GA-31. Nothing new is added to the protocol by this card.
//
// 🔴 WHY `state` EXISTS AT ALL, since it is easy to read it as ceremony.
// `flowmic://login?t=…` is a URL, and any web page, any chat message and any
// other app on the phone can make this app open one. Without a binding, a link
// carrying an ATTACKER's nonce would sign the victim's phone into the
// ATTACKER's account, quietly, and every subsequent utterance would be
// delivered there. That is login CSRF, and the defence is the whole reason this
// file refuses a callback that does not match a request WE started:
//   · no pending request at all   ⇒ [BrowserLoginCodes.noRequest]
//   · a state we did not mint     ⇒ [BrowserLoginCodes.stateMismatch]
// Neither is a degraded success. Both stop the flow and say so in words.
//
// ⚠️ The comparison below is a plain `==`, not a constant-time compare, and that
// is deliberate rather than overlooked: the attacker here does not get to
// observe our timing — they get one shot at handing the OS a URL, and they
// cannot measure how long our string compare took. Adding a constant-time
// helper would suggest a threat model this surface does not have.

import 'dart:convert';
import 'dart:math';

/// The URL scheme the OS routes back to this app. Registered in
/// `android/app/src/main/AndroidManifest.xml` (an `<intent-filter>` on
/// MainActivity) and `ios/Runner/Info.plist` (`CFBundleURLTypes`).
///
/// 🔴 The two registrations and this constant are three copies of one fact and
/// no compiler checks any of them against the others. `browser_login_test.dart`
/// reads the manifest and the plist off disk and asserts they carry exactly
/// this scheme and this host — that gate is the only thing standing between a
/// renamed constant and a callback the OS silently drops.
const String kBrowserLoginScheme = 'flowmic';

/// The host component of the callback — `flowmic://login`. A host, not a path,
/// because Android matches `android:host` and iOS gives us the whole URL: one
/// value both platforms can filter on.
const String kBrowserLoginHost = 'login';

/// How long a minted `state` stays redeemable on THIS side.
///
/// Ten minutes, and the number is chosen for the human, not the credential: a
/// first-time user in that browser tab may be registering an account, waiting
/// on a verification mail, or typing a password from a manager. A two-minute
/// binding would refuse people who did nothing wrong.
///
/// ⚠️ THIS IS NOT THE CREDENTIAL'S LIFETIME AND MUST NOT BE READ AS ONE. The
/// nonce is minted by the console at REDIRECT time and the server gives it 60
/// seconds (`QR_GRANT_TTL_MS`), which is plenty for a redirect that happens
/// immediately after sign-in. The owner ruling records that the browser
/// round-trip case may want a TTL of its own; that decision is the SERVER's and
/// is deliberately not made here (this card does not touch server-core). If the
/// server refuses an old nonce, the refusal is rendered by its own name.
const Duration kBrowserLoginStateTtl = Duration(minutes: 10);

/// How long the sheet waits for a callback before it goes back to idle.
///
/// 🔴 THE REASON THIS CONSTANT EXISTS: a user who opens the browser and then
/// changes their mind — closes the tab, swipes back, gets a phone call — comes
/// back to an app that was never told anything happened. Without a deadline the
/// button spins for the rest of the session and the only way out is to kill the
/// app. Nothing delivers a "the user gave up" event, on either OS, so a timeout
/// is not a fallback here; it is the only mechanism there is.
const Duration kBrowserLoginWaitTimeout = Duration(minutes: 3);

/// Stable, fail-loud codes for everything that can go wrong on THIS side of the
/// round trip. Rendered by `AppStrings.browserLoginError`.
///
/// 🔴 They are deliberately NOT folded into [LoginErrorCodes]. Those answer
/// 「what did the account server say」; these answer 「the round trip through the
/// browser did not complete」, and the two are shown from different places for
/// different reasons. One enum answering both questions is this repo's
/// number-one defect shape.
class BrowserLoginCodes {
  BrowserLoginCodes._();

  /// The OS would not open a browser (none installed, or the launch was
  /// refused). The one failure the user can definitely act on.
  static const String openFailed = 'BROWSER_LOGIN_OPEN_FAILED';

  /// We opened the browser and no callback ever arrived — the user cancelled,
  /// closed the tab, or the OS never delivered the link.
  static const String timedOut = 'BROWSER_LOGIN_TIMED_OUT';

  /// A `flowmic://login` URL arrived while this app had asked for nothing.
  /// See the login-CSRF paragraph at the top of this file.
  static const String noRequest = 'BROWSER_LOGIN_NO_REQUEST';

  /// The callback echoed a `state` that is not the one we minted.
  static const String stateMismatch = 'BROWSER_LOGIN_STATE_MISMATCH';

  /// Our own binding aged out ([kBrowserLoginStateTtl]) before the callback
  /// arrived. Distinct from [timedOut]: this one is delivered by a link that
  /// DID come back, just far too late — typically a cold start hours later.
  static const String expired = 'BROWSER_LOGIN_EXPIRED';

  /// The callback carried no `t=` — a malformed redirect, not a refusal.
  static const String noCode = 'BROWSER_LOGIN_NO_CODE';

  /// The callback names a different server than the one we sent the user to.
  /// Its own code, because the action differs from every line above: nothing
  /// the user does fixes it, and the nonce must not be sent anywhere.
  static const String endpointMismatch = 'BROWSER_LOGIN_ENDPOINT_MISMATCH';

  /// Every code above, for the exhaustiveness assertions in the copy tests.
  static const List<String> all = <String>[
    openFailed,
    timedOut,
    noRequest,
    stateMismatch,
    expired,
    noCode,
    endpointMismatch,
  ];
}

/// A sign-in the user started here: the binding value, when it was minted, and
/// the origin the browser was pointed at.
///
/// It is PERSISTED (see `BrowserLoginStateStore`) because the OS is allowed to
/// kill this app while the user is in the browser — a cold start is a normal
/// outcome of this flow, not an edge case. Nothing secret is stored: `state` is
/// a binding value, it grants nothing, and it is worthless to anyone who did
/// not also mint the nonce it will be compared against.
class BrowserLoginRequest {
  const BrowserLoginRequest({
    required this.state,
    required this.startedAtMs,
    required this.endpoint,
  });

  final String state;
  final int startedAtMs;
  final String endpoint;

  String encode() => jsonEncode(<String, Object?>{
    's': state,
    't': startedAtMs,
    'e': endpoint,
  });

  /// Decode a persisted request, or null when there is nothing usable there.
  ///
  /// ⚠️ Every malformed shape answers null rather than throwing. A corrupt
  /// preference must degrade to 「no request is pending」 — which refuses a
  /// callback loudly — and never to a crash on a screen the user opened to log
  /// in.
  static BrowserLoginRequest? decode(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final Object? parsed = jsonDecode(raw);
      if (parsed is! Map) return null;
      final Object? s = parsed['s'];
      final Object? t = parsed['t'];
      final Object? e = parsed['e'];
      if (s is! String || s.isEmpty) return null;
      if (t is! int) return null;
      return BrowserLoginRequest(
        state: s,
        startedAtMs: t,
        endpoint: e is String ? e : '',
      );
    } on Object {
      return null;
    }
  }
}

/// What [verifyBrowserLoginCallback] decided. Exactly one of [nonce] and
/// [refusal] is non-null — there is no third state, and in particular no
/// 「accepted with a warning」.
class BrowserLoginVerdict {
  const BrowserLoginVerdict._(this.nonce, this.endpoint, this.refusal);

  /// The callback is ours, bound to our request, and carries a code to redeem.
  const BrowserLoginVerdict.accepted({
    required String nonce,
    required String endpoint,
  }) : this._(nonce, endpoint, null);

  /// The callback is refused, by name. [BrowserLoginCodes].
  const BrowserLoginVerdict.refused(String code) : this._(null, '', code);

  final String? nonce;

  /// The origin to redeem at. ALWAYS the one we opened the browser at — never
  /// the one the link asked for. See [verifyBrowserLoginCallback].
  final String endpoint;
  final String? refusal;

  bool get ok => nonce != null;
}

/// True iff [link] is the callback this flow listens for. Everything else —
/// another app's scheme, another `flowmic://` host — is not an error and must
/// not be reported as one; it is simply not ours.
bool isBrowserLoginLink(Uri link) =>
    link.scheme.toLowerCase() == kBrowserLoginScheme &&
    link.host.toLowerCase() == kBrowserLoginHost;

/// Mint a binding value. 16 bytes of [Random.secure] as hex — the same entropy
/// and the same encoding the server gives its nonce.
///
/// 🔴 [Random.secure] and not [Random]. A predictable `state` is a state an
/// attacker can echo, which turns the whole check at the bottom of this file
/// into decoration.
String mintBrowserLoginState([Random? rng]) {
  final Random r = rng ?? Random.secure();
  final StringBuffer out = StringBuffer();
  for (int i = 0; i < 16; i++) {
    out.write(r.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// Build the URL the system browser is sent to.
///
/// `flow=mobile` is what tells the console to redirect back to `flowmic://`
/// instead of landing on its own home page; `state` is echoed back untouched.
Uri buildBrowserSignInUrl({required String endpoint, required String state}) {
  final String base = _trimTrailingSlashes(endpoint.trim());
  return Uri.parse('$base/signin').replace(
    queryParameters: <String, String>{'flow': 'mobile', 'state': state},
  );
}

/// Decide what to do with a delivered callback. PURE: no clock, no storage, no
/// side effect — [nowMs] and [pending] are handed in.
///
/// The order of the checks is the security order and must not be rearranged for
/// tidiness: identity of the requester first, freshness second, contents last.
/// Reporting 「no code in the link」 for a link we never asked for would tell an
/// attacker which half of their forgery to fix.
BrowserLoginVerdict verifyBrowserLoginCallback({
  required Uri link,
  required BrowserLoginRequest? pending,
  required int nowMs,
  Duration ttl = kBrowserLoginStateTtl,
}) {
  if (!isBrowserLoginLink(link)) {
    // The controller filters these out before calling; answering a named
    // refusal here keeps the function total rather than silently truthy.
    return const BrowserLoginVerdict.refused(BrowserLoginCodes.noRequest);
  }
  if (pending == null) {
    return const BrowserLoginVerdict.refused(BrowserLoginCodes.noRequest);
  }
  final String echoed = (link.queryParameters['state'] ?? '').trim();
  if (echoed.isEmpty || echoed != pending.state) {
    return const BrowserLoginVerdict.refused(BrowserLoginCodes.stateMismatch);
  }
  if (nowMs - pending.startedAtMs > ttl.inMilliseconds) {
    return const BrowserLoginVerdict.refused(BrowserLoginCodes.expired);
  }
  // 🔴 THE ENDPOINT IN THE LINK IS NOT AUTHORITATIVE AND IS NEVER DIALLED.
  // The origin we redeem at is the one WE opened the browser at, full stop. A
  // link that names a different one is refused rather than followed: sending a
  // nonce somewhere else is the one action in this whole flow that hands a
  // credential to a party of the link's choosing. Under-matching (a scheme or
  // subdomain difference on a self-hosted console) is the safe failure, and it
  // is the same rule `planRetiredSaasEndpointHeal` follows next door.
  final String claimed = (link.queryParameters['endpoint'] ?? '').trim();
  if (claimed.isNotEmpty &&
      _normaliseOrigin(claimed) != _normaliseOrigin(pending.endpoint)) {
    return const BrowserLoginVerdict.refused(
      BrowserLoginCodes.endpointMismatch,
    );
  }
  final String nonce = (link.queryParameters['t'] ?? '').trim();
  if (nonce.isEmpty) {
    return const BrowserLoginVerdict.refused(BrowserLoginCodes.noCode);
  }
  return BrowserLoginVerdict.accepted(
    nonce: nonce,
    endpoint: pending.endpoint,
  );
}

String _trimTrailingSlashes(String v) {
  String s = v;
  while (s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

/// Compare-only normalisation, mirroring `saas_endpoint.dart`'s three steps in
/// the same order (trim, strip trailing `/`, ASCII-only lowercase). ASCII-only
/// on purpose: Dart's Unicode `toLowerCase` can fold two visually different
/// hosts onto one string, and a non-ASCII host must match byte for byte.
String _normaliseOrigin(String v) {
  final String s = _trimTrailingSlashes(v.trim());
  final StringBuffer out = StringBuffer();
  for (final int c in s.codeUnits) {
    out.writeCharCode(c >= 0x41 && c <= 0x5A ? c + 0x20 : c);
  }
  return out.toString();
}
