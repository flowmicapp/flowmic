// SPEC-REF:
//   apps/mobile/lib/src/session/instance_probe.dart  (GET  /api/health)
//   apps/mobile/lib/src/session/image_upload.dart    (POST /api/inject/image)
//   apps/mobile/lib/src/diag/diag_upload.dart        (POST /api/diag/mobile)
//   apps/mobile/lib/src/session/connections_controller.dart (dial URL)
//   apps/desktop/src/lib/pairing.ts `toWsUrl()` (the QR always carries a **ws-url**)
//   CLAUDE.md red line: no silent failures / one value answers only one question
//
// ── 🔴 THE ONE RULE FOR 「把配对端点当 HTTP 基址时它是什么」("what a pairing
//    endpoint becomes when treated as an HTTP base") (RV-97) ───────────
//
// A pairing endpoint is a DIAL string. The desktop's QR always writes
// `ws://host:port` (`flowmic://pair?endpoint=ws://192.168.1.5:41879&…`), and
// socket.io is happy with that — but `HttpClient.getUrl`/`postUrl` are not:
// they throw `ArgumentError: Unsupported scheme 'ws'`, which is an **Error, not
// an Exception**, so an `on Exception` catch does not see it.
//
// Before this file the rule existed TWICE and was applied at THREE of the four
// places that needed it:
//
//   · connections_controller.normalizePairEndpoint — its own copy (dial URL);
//   · instance_probe.healthUri                     — a second copy (RV-89);
//   · image_upload.uploadImageInject               — NONE  ⇒ RV-97 (owner
//       real-device:
//       「联系不上电脑（… Unsupported scheme 'ws' …），图片没有发出」("can't reach
//       the computer (… Unsupported scheme 'ws' …), the picture was not sent"));
//   · diag_upload.uploadDiagnostics                — NONE  ⇒ the same bug,
//       silently, for every QR-paired session since the feature shipped.
//
// Two copies of one rule is this repo's #1 bug shape waiting to happen, and the
// two call sites that had no copy at all are the shape that already happened —
// twice. So the rule lives HERE, once, and the three http funnels ask it. The
// normalisation is done INSIDE each funnel (never at its call sites), which is
// the approach RV-89 established: the call site that was wrong had no way to know it
// was wrong, and a fourth caller would have inherited the same trap.

/// The http(s) form of a pairing/dial [endpoint].
///
/// `ws://` → `http://`, `wss://` → `https://`, a bare `host:port` → `http://…`,
/// and ANY other scheme is passed through untouched so a malformed endpoint
/// still fails loudly as itself rather than as an http 404. The scheme is
/// compared case-insensitively; everything after `://` is preserved verbatim,
/// because this answer is also what `connections_controller` DIALS with.
///
/// Empty in ⇒ empty out. Callers that can be handed an empty endpoint say so in
/// their own words (`uploadImageInject` → 「no endpoint」); inventing a URL for
/// one here would turn 「没配对」("not paired") into 「连不上」("can't connect").
String httpBaseOf(String endpoint) {
  final String e = endpoint.trim();
  if (e.isEmpty) return '';
  final int sep = e.indexOf('://');
  if (sep < 0) return 'http://$e';
  return switch (e.substring(0, sep).toLowerCase()) {
    'ws' => 'http://${e.substring(sep + 3)}',
    'wss' => 'https://${e.substring(sep + 3)}',
    _ => e,
  };
}

/// D2LAN-B3 — is this dial/HTTP endpoint carried over TLS?
///
/// FOUR schemes, not two, and that is not defensiveness: the same endpoint is
/// stored as `https://` ([httpBaseOf]'s output, which is what a pairing persists)
/// and dialled as `wss://` (what the QR carries and what socket.io wants), so a
/// check that knew only one of the pair would answer 「没加密」("not encrypted")
/// about a connection
/// that is. Anything else — including a bare `host:port` — is NOT secure, because
/// [httpBaseOf] gives a scheme-less endpoint `http://`.
bool isSecureEndpoint(String endpoint) {
  final String e = endpoint.trim().toLowerCase();
  return e.startsWith('wss://') || e.startsWith('https://');
}

/// The TLS form of a dial endpoint: `ws://`→`wss://`, `http://`→`https://`, a
/// bare `host:port`→`wss://…`.
///
/// 🔴 CALLED ONLY WHERE A PIN EXISTS. Upgrading an endpoint we cannot verify
/// would move the failure direction from 「退回今天的明文」("fall back to today's
/// plaintext") to 「连不上」("can't connect") for every
/// sidecar serving plain — the compatibility rule design §4 "compatibility and
/// ordering" (兼容与顺序) states.
/// With a pin the opposite is true: dialling plain would be a downgrade the user
/// is told nothing about, so there the upgrade is mandatory.
///
/// A bare host becomes `wss://` rather than `https://` because the only caller
/// that hands over a scheme-less string is the dial-candidate expansion, and
/// socket.io is what dials it. [httpBaseOf] maps that back to `https://` for the
/// HTTP funnels, so both forms still come from this one pair of functions.
String secureDialUrl(String endpoint) {
  final String e = endpoint.trim();
  if (e.isEmpty) return e;
  final int sep = e.indexOf('://');
  if (sep < 0) return 'wss://$e';
  return switch (e.substring(0, sep).toLowerCase()) {
    'ws' => 'wss://${e.substring(sep + 3)}',
    'http' => 'https://${e.substring(sep + 3)}',
    // Already secure, or a scheme we do not rewrite — passed through untouched
    // for the same reason [httpBaseOf] does it: a malformed endpoint must fail
    // loudly as itself.
    _ => e,
  };
}

/// [endpoint] + an ABSOLUTE server route → the URL to request.
///
/// Any path/query the endpoint carried is dropped: `/api/health`,
/// `/api/inject/image` and `/api/diag/mobile` are absolute routes on the server
/// root, and a pairing endpoint with a stray path (a QR that carried
/// `…/socket.io/?EIO=4`, say) is exactly the input that would otherwise request
/// a 404 and read as 「够不着」("unreachable").
///
/// Built rather than `.replace`d: `Uri.replace(query: null)` KEEPS the original
/// query (null means 「不改」("don't change"), not 「清空」("clear")), so
/// constructing the URI is the only
/// way to make the sentence above true of both path and query.
Uri httpEndpointUri(String endpoint, String path) {
  final Uri parsed = Uri.parse(httpBaseOf(endpoint));
  return Uri(
    scheme: parsed.scheme,
    userInfo: parsed.userInfo,
    host: parsed.host,
    port: parsed.hasPort ? parsed.port : null,
    path: path,
  );
}
