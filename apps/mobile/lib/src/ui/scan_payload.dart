// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (pairing entry: 4-digit code / QR)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (QR payload:
//     flowmic://pair?endpoint=<ws-url>&code=NNNN&channel=standalone|saas
//     [&alt=<host>,<host>] — B4-15's additive candidate list, read by
//     session/endpoint_candidates.dart, NOT here: this file still answers only
//     「这是不是我们的码」("is this our code") and the extra key changes nothing
//     about that.)
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §3 (the
//     same query also arrives as `https://flowmic.app/go/pair?...` once S1-01
//     ships — S1-02 recognises that prefix here too, otherwise the camera path
//     would show 「foreign QR」 for the new code before `PairEntry.parse` ever
//     saw it)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-30
//   CLAUDE.md red line: no silent failures
//
// What a camera frame MEANS — the pure half of QR pairing.
//
// owner 2026-07-26:「扫码优先于手输」("scan takes priority over manual typing").
// The camera itself cannot be unit-tested, so
// everything that is a decision lives here and the widget only owns pixels:
//
//   · a frame with no barcode, or a barcode with no value, is NOTHING. It happens
//     dozens of times a second while the user aims — it must not blink an error;
//   · a barcode that is not a FlowMic pairing link is a LOUD, NAMED refusal. The
//     alternative — handing an arbitrary URL to the pairing call and letting the
//     server say PAIR_INVALID_CODE — would tell the user their code is wrong when
//     in fact they scanned a Wi-Fi QR;
//   · a real pairing link is passed through VERBATIM. It already carries its own
//     endpoint, and `ConnectionsController.addByCode` has parsed that exact form
//     since WP-R23-1 (the 「paste the whole link」 path). Scanning is therefore a
//     new INPUT for an existing, tested route — not a second pairing code path.

import '../../generated/flowmic_protocol.g.dart' show FlowMicPairLink;

/// The FlowMic pairing-link scheme + host (04 §3.1). A payload must start with
/// this to be ours; anything else is somebody else's QR.
///
/// 🔴 GENERATED, NOT HAND-TYPED (card H-14, 2026-09-15) — same treatment as
/// [kPairLinkPrefixHttps] below, and for the same reason one card later.
/// [FlowMicPairLink.customPrefix] is emitted from `PAIR_CUSTOM_SCHEME` +
/// `PAIR_CUSTOM_HOST` in packages/protocol/src/constants.ts by
/// apps/mobile/tool/gen_protocol.mjs, which every mobile target runs through
/// `make gen`. Before that this literal was ONE of at least three: the desktop
/// builder typed the prefix inline, this file declared it, and
/// `PairEntry.parse` (signaling/wire_payloads.dart) typed a third copy rather
/// than importing this one — while the lint that guards the https twin
/// (`pair-link-single-source`) covered only the https spelling, so nothing in
/// the repo could even count them.
///
/// 🔴 THE ONE Dart spelling. `PairEntry.parse` imports this; nothing under
/// `apps/mobile/lib` may re-type it — `verify:lint pair-link-single-source`
/// now fails on a hand-typed literal of this prefix exactly as it does on the
/// https form. (That scan looks for the prefix immediately after a quote, so
/// this very comment may not spell it in quotes — which is the guard working,
/// not a wording preference.)
const String kPairLinkPrefix = FlowMicPairLink.customPrefix;

/// S1-02 — the https form of the same link (design addendum §3: only the
/// scheme+host change, the query is identical). The host is part of the fixed
/// prefix on purpose: `https://` alone would accept ANY web URL as「ours」,
/// which is precisely the foreign-QR hole this file exists to close.
///
/// 🔴 THE ONE Dart spelling. `PairEntry.parse` (wire_payloads.dart) and the
/// paste gate (add_pairing_sheet.dart) import this rather than re-type it.
///
/// 🔴 GENERATED, NOT HAND-TYPED. [FlowMicPairLink.httpsPrefix] is emitted from
/// `PAIR_HTTPS_HOST` + `PAIR_HTTPS_PATH` in packages/protocol/src/constants.ts
/// by apps/mobile/tool/gen_protocol.mjs, which every mobile target runs through
/// `make gen`. Dart cannot import TypeScript, so this used to be a second
/// hand-written copy compared against the first by a lint; equality is now by
/// construction. What is still guarded is that nobody adds a THIRD copy:
/// `verify:lint pair-link-single-source` fails on any hand-typed
/// `'https://<host><path>'` literal under `apps/mobile/lib`.
///
/// 🔴 THE APEX, NOT `www.` (card DOM-1, owner ruling 2026-09-08). iOS Universal
/// Links do not follow redirects, so the host in a scanned link has to be one
/// the app declared (`applinks:flowmic.app`); `www.flowmic.app` is a different
/// host and opens Safari. There is a `www` -> apex 301 at the edge for links a
/// person typed or forwarded, and it is deliberately NOT a second prefix here:
/// a parser that accepted more than the OS routes would behave differently
/// depending on how the same link arrived.
const String kPairLinkPrefixHttps = FlowMicPairLink.httpsPrefix;

/// The account-login link the web console renders (GA-31). Recognised here so a
/// user who scans it inside the PAIRING sheet is told to use the login screen,
/// instead of being told their pairing code is malformed.
const String kLoginLinkPrefix = 'flowmic://login';

/// The LAST path segment of the site-demo pair link (`DEMO_PAIR_HTTPS_PATH`,
/// generated as [FlowMicPairLink.demoPath]). `demo` today — read off the
/// generated constant rather than typed, for the same reason the two prefixes
/// above are generated.
///
/// owner 2026-09-17 (docs/decisions/2026-09-17-owner-app-scans-demo-qr-as-
/// ephemeral-session.md): the App may scan the site's demo QR and join as an
/// EPHEMERAL session. Design: docs/strategy/2026-09-17-app-ephemeral-demo-
/// session-design.md §0.
final String kDemoPairLinkLastSegment =
    FlowMicPairLink.demoPath.split('/').last;

/// 「这是不是官网演示码」("is this the site's demo code") — host + LAST path
/// segment, deliberately NOT a prefix test.
///
/// 🔴 WHY NOT `startsWith`. The site prefixes a locale in front of the path
/// (`/go/zh-cn/demo` on the Simplified-Chinese page; the island only promises
/// the last segment stays put), so a fixed prefix would accept the English
/// page's code and refuse every other language's — a defect that is invisible
/// on the developer's own locale. `/go/pair` and `/go/xx/pair` end in `pair`
/// and are not this; `/go/demo/anything` does not end in `demo` and is not
/// this either — a foreign QR must keep getting the loud, named refusal.
///
/// The host is compared LITERALLY, exactly as [kPairLinkPrefixHttps] does:
/// `https://` alone would let any web page's URL through as 「ours」.
///
/// 🔴 THE ONE reader for both consumers: [classifyScan] (camera frame) and
/// `PairEntry.parse` (signaling/wire_payloads.dart, which marks the entry
/// `ephemeral`). Two hand-written copies of this judgement would drift the
/// first time one of them was edited.
bool isDemoPairLink(String raw) {
  final Uri? uri = Uri.tryParse(raw.trim());
  if (uri == null) return false;
  if (uri.scheme.toLowerCase() != 'https') return false;
  if (uri.host.toLowerCase() != FlowMicPairLink.host) return false;
  final List<String> segments = uri.pathSegments;
  if (segments.isEmpty) return false;
  return segments.last == kDemoPairLinkLastSegment;
}

enum ScanVerdict {
  /// No barcode / empty value — keep scanning, say nothing.
  nothing,

  /// A FlowMic pairing link. [ScanResult.payload] is the verbatim string.
  pairLink,

  /// A FlowMic LOGIN link scanned in the pairing sheet — the right app, the
  /// wrong screen. Worth its own verdict because the fix is different.
  loginLink,

  /// A readable barcode that is not ours.
  foreign,
}

class ScanResult {
  const ScanResult(this.verdict, [this.payload]);

  final ScanVerdict verdict;

  /// Present only for [ScanVerdict.pairLink] — the untouched link to hand to
  /// `addByCode`, which owns the parse.
  final String? payload;

  /// Whether the sheet should stop the camera and act on this.
  bool get isTerminal => verdict == ScanVerdict.pairLink;
}

/// Classify one decoded barcode value.
///
/// Deliberately NOT a parser: validating the query string here would put a second
/// implementation of the payload format next to `PairEntry.parse`, and the two
/// would drift. This answers one question — 「这是不是我们的码」("is this our
/// code") — and lets the
/// existing parser own the rest, including its own loud failure.
ScanResult classifyScan(String? raw) {
  final String value = (raw ?? '').trim();
  if (value.isEmpty) return const ScanResult(ScanVerdict.nothing);
  final String lower = value.toLowerCase();
  if (lower.startsWith(kPairLinkPrefix) || lower.startsWith(kPairLinkPrefixHttps)) {
    return ScanResult(ScanVerdict.pairLink, value);
  }
  // owner 2026-09-17 — the site's demo QR is ours too, passed through verbatim
  // like the two forms above; `PairEntry.parse` is what turns it into an
  // ephemeral entry. Same verdict on purpose: the sheet's job is unchanged
  // (stop the camera, hand the link to `addByCode`), and a third verdict would
  // be a second place deciding what 「temporary」 means.
  if (isDemoPairLink(value)) return ScanResult(ScanVerdict.pairLink, value);
  if (lower.startsWith(kLoginLinkPrefix)) return const ScanResult(ScanVerdict.loginLink);
  return const ScanResult(ScanVerdict.foreign);
}

/// The two fields a `flowmic://login` QR carries (GA-31). `endpoint` is present
/// so a self-hosted relay works without the user typing its address; `null` means
/// the app falls back to its configured SaaS endpoint.
class LoginScan {
  const LoginScan({required this.nonce, this.endpoint});
  final String nonce;
  final String? endpoint;
}

/// Read a scanned login link. `null` when it is not one, or carries no nonce —
/// a link without a `t` is not a login code, and guessing would send an empty
/// credential to the server.
LoginScan? parseLoginLink(String raw) {
  final String value = raw.trim();
  if (!value.toLowerCase().startsWith(kLoginLinkPrefix)) return null;
  final Uri? uri = Uri.tryParse(value);
  if (uri == null) return null;
  final String nonce = (uri.queryParameters['t'] ?? '').trim();
  if (nonce.isEmpty) return null;
  final String endpoint = (uri.queryParameters['endpoint'] ?? '').trim();
  return LoginScan(nonce: nonce, endpoint: endpoint.isEmpty ? null : endpoint);
}

/// Which tab the 「添加配对」("add pairing") sheet opens on.
enum PairTab { scan, manual }

/// Which channel the MANUAL tab is set to (P2, 0.3.1 design §4).
///
/// Two segments because the two channels take different inputs, and one form
/// that morphs on a host-comparison guess made the difference invisible:
///   · [lan]   — address + 4-digit code (owner 2026-08-14: the LAN has no
///     PCID). Self-hosted relays and bare-IP dials live here too, rescued by
///     the server's `PAIR_PCID_REQUIRED` force-show when they need a PCID.
///   · [cloud] — PCID + 4-digit code, NO address: the official relay's
///     endpoint is resolved, not typed (owner: 「不用输端点URL，因为是确定的」
///     "no need to type the endpoint URL, because it is fixed").
enum PairChannel { lan, cloud }

