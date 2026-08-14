// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (pairing entry: 4-digit code / QR)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (QR payload:
//     flowmic://pair?endpoint=<ws-url>&code=NNNN&channel=standalone|saas
//     [&alt=<host>,<host>] — B4-15's additive candidate list, read by
//     session/endpoint_candidates.dart, NOT here: this file still answers only
//     「这是不是我们的码」("is this our code") and the extra key changes nothing
//     about that.)
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

/// The FlowMic pairing-link scheme + host (04 §3.1). A payload must start with
/// this to be ours; anything else is somebody else's QR.
const String kPairLinkPrefix = 'flowmic://pair';

/// The account-login link the web console renders (GA-31). Recognised here so a
/// user who scans it inside the PAIRING sheet is told to use the login screen,
/// instead of being told their pairing code is malformed.
const String kLoginLinkPrefix = 'flowmic://login';

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
  if (lower.startsWith(kPairLinkPrefix)) return ScanResult(ScanVerdict.pairLink, value);
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

/// owner 2026-07-26:「扫码优先于手输」("scan takes priority over manual typing")
/// — scan is the default entry.
///
/// [cameraUsable] is false when the platform has no camera or the user refused
/// permission. Falling back is correct; falling back SILENTLY is not, which is
/// why this returns the reason alongside the tab so the caller must render it.
class PairEntryMode {
  const PairEntryMode(this.tab, {this.fallbackReason});

  final PairTab tab;

  /// Non-null only when we landed on [PairTab.manual] against the default —
  /// the sheet MUST show this, or the user just sees a form and never learns
  /// the camera was refused.
  final String? fallbackReason;
}

PairEntryMode resolvePairEntryMode({
  required bool cameraUsable,
  required String cameraUnavailableReason,
}) {
  if (cameraUsable) return const PairEntryMode(PairTab.scan);
  return PairEntryMode(PairTab.manual, fallbackReason: cameraUnavailableReason);
}
