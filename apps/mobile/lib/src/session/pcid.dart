// SPEC-REF:
//   docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md
//     §3 (behaviour matrix — PCID exists on the CLOUD RELAY only; LAN unchanged)
//     §4 (form: /^\d{9}$/, decimal, server-minted, not a secret)
//     §7 (mobile lane: the field, the visibility rule, local validation)
//   docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
//   packages/protocol/src/protocol-schemas-auth.ts  MobilePairSchema (`pcid?`)
//
// The PCID rules the phone owns, in ONE place. Four questions live here because
// they are one decision seen from four sides, and this repo's #1 defect shape is
// one rule written twice:
//   · what counts as a PCID                       → [readPcid]
//   · when the field is shown                     → [addressIsCloudRelay]
//   · when the SERVER overrules that guess        → [isPcidRequiredRefusal]
//   · what the two wire codes are called          → the constants below
//
// 🔴 WHAT A PCID IS NOT: it is not a secret. It addresses one PC row on the
// relay; the 4-digit code is still the only secret and still carries the whole
// TTL/attempt budget. Nothing here may grow into an authentication check.

// The two rules this file borrows rather than restates. `httpBaseOf` is the
// single funnel RV-97 established for 「把配对端点当地址读时它是什么」("what it is
// when the pairing endpoint is read as an address") (it is also
// the whole body of `connections_controller.normalizePairEndpoint`, so calling
// it directly is the same rule, not a second copy); the fullwidth fold is the
// one the pairing fields already apply live as the user types.
import '../signaling/http_endpoint.dart' show httpBaseOf;
import '../ui/ime_normalizer.dart' show normalizeFullwidthAscii;

/// Digits in a PCID. Mirrors `/^\d{9}$/` on the server (design §4).
const int kPcidLength = 9;

/// 「这一帧没带 PCID，而中继要求带」("this frame doesn't carry a PCID, and the
/// relay requires one") — the refusal the server answers a bare code
/// with, on the relay only. Registered in `packages/protocol/src/error-codes.ts`
/// by the T1 lane; the phone hand-mirrors its copy in `pairing_strings.dart`
/// (the standing gap CLAUDE.md records: nothing binds the two tables).
const String kPairPcidRequired = 'PAIR_PCID_REQUIRED';

/// 「这个 PCID 指不到任何一台电脑」("this PCID doesn't point to any PC") — a
/// different question with a different
/// remedy, which is why it is a second code and not a flag on the first.
const String kPairPcidUnknown = 'PAIR_PCID_UNKNOWN';

/// The bare 9 digits to send, or null when what was typed is not a PCID.
///
/// ONE function answers both 「填对了吗」("was it typed correctly") and 「发什么
/// 上去」("what to send up") on purpose. Two
/// functions would be two answers, and the pair that drifts is exactly the pair
/// that lets a value pass validation in one shape and go on the wire in another.
///
/// Grouped input is accepted (`123 456 789`, and the fullwidth digits a Chinese
/// IME substitutes) and normalised away before the check — the display grouping
/// is ours, so refusing the user for typing it back would be our own fault
/// charged to them.
String? readPcid(String raw) {
  final String digits = normalizeFullwidthAscii(raw)
      .split('')
      .where((String c) => c.codeUnitAt(0) >= 0x30 && c.codeUnitAt(0) <= 0x39)
      .join();
  return digits.length == kPcidLength ? digits : null;
}

/// Does [typedAddress] point at the cloud relay [relayEndpoint]?
///
/// 🔴 THIS IS A GUESS, AND IT IS NOT THE AUTHORITY. It exists so the common
/// path (the sheet pre-fills the relay URL when there is no prior pairing) shows
/// the PCID field without the user having to discover it. A self-hosted relay,
/// or the relay reached by bare IP, answers `false` here and is CORRECTED by the
/// server: see [isPcidRequiredRefusal] and its call site in the pairing sheet.
/// Anything in this function that starts refusing to send a frame — rather than
/// deciding what to draw — is a bug: it would lock those users out on a guess.
///
/// Compared on HOST alone, after the same normalisation the dial path uses
/// ([httpBaseOf]), so `flowmic.app`, `https://flowmic.app` and
/// `wss://flowmic.app/` are one answer. Port is deliberately not compared:
/// the relay is reachable on more than one and the guess errs toward showing an
/// optional field, never toward hiding a required one.
bool addressIsCloudRelay(String typedAddress, String relayEndpoint) {
  final String? typed = _hostOf(typedAddress);
  final String? relay = _hostOf(relayEndpoint);
  if (typed == null || relay == null) return false;
  return typed == relay;
}

String? _hostOf(String endpoint) {
  final String normalized = httpBaseOf(endpoint);
  if (normalized.isEmpty) return null;
  final Uri? uri = Uri.tryParse(normalized);
  if (uri == null || uri.host.isEmpty) return null;
  return uri.host.toLowerCase();
}

/// Is this refusal the server saying 「我要 PCID」("I need a PCID")?
///
/// Exact match, and that is checked rather than assumed: the pairing error
/// channel decorates exactly one code with a payload
/// (`ACCOUNT_RESTRICTED:<reason_key>` —
/// `encodeRestrictionReason` in `mobile_reconnect_flow.dart:130-135`
/// returns every other code untouched), and the hold-out budget rides only
/// `PAIR_RELEASED`/`PC_BUSY`. So this one arrives verbatim.
bool isPcidRequiredRefusal(String? code) => code == kPairPcidRequired;
