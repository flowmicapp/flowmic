// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (QR payload; B4-15 adds `alt=`)
//   docs/rebuild/08-MOBILE-SPEC.md §4 (pairing entry / reconnect ladder)
//   apps/desktop/src/lib/pairing.ts `buildQrPayload` / `qrAltHosts` — THE WRITER
//   CLAUDE.md red line: no silent failure (没有静默失败)
//
// Card B4-15 —— 「这台 PC 有好几个地址，哪个是手机够得着的」 ("this PC has
// several addresses — which one can the phone actually reach").
//
// WHY THIS EXISTS. The desktop resolves exactly ONE pairing endpoint and picks it
// by the server's own ranking of this host's NICs. That ranking is a GUESS about
// which cable the phone shares, and on a machine with both a LAN address and a
// VPN address it guessed the VPN three rounds running. The QR carried that single
// guess, so a phone that could not reach it had a code that scanned and then
// could not connect — with no address anywhere on screen to fall back to.
//
// 🔴 THE PROBE IS A CHOOSER, NEVER A GATE. Everything here can do exactly one
// thing: reorder addresses we were going to dial anyway. When it cannot decide —
// one candidate, no answer, every candidate silent — the caller dials the
// endpoint it would have dialled before this file existed. That rule is what
// keeps a false-negative probe (a firewalled /api/health, a captive portal, a
// test harness with no network) from turning a working pairing into a refusal.
// It is the same stance `instance_probe.dart` states for the instance list:
// 「A probe is not a session … its verdict never gates the tap」.
//
// The second rule: WITH ONE CANDIDATE NOTHING RUNS. No probe, no delay, no new
// failure mode — a pre-B4-15 QR and a hand-typed address behave byte-for-byte as
// they did before.

import 'dart:async';

import '../auth/token_storage.dart';
import '../signaling/http_endpoint.dart';
import '../signaling/lan_tls_fingerprint.dart' show isWellFormedLanTlsFingerprint;
import 'instance_probe.dart';

/// The additive query key the desktop appends to the pairing QR (B4-15). Hosts
/// only, comma-separated: one sidecar means one scheme and one port, so the
/// phone rebuilds each alternate from the primary endpoint — which makes it
/// structurally impossible for an alternate to disagree about the port.
const String kQrAltKey = 'alt';

/// D2LAN-B3 — the additive query key carrying the sidecar's SPKI fingerprint
/// (apps/desktop/src/lib/pairing.ts, symbol `buildQrPayload`).
///
/// 🔴 THIS FILE IS THE SECOND PARSER OF THAT PAYLOAD, and that is the whole
/// reason this constant is here. `PairEntry.parse` reads the link to build the
/// pairing frame; this reads the SAME link to build the dial list. Teaching only
/// one of them about `fp=` would have produced the worst possible split — a
/// pairing that believes it is pinned dialling `ws://`, or a dial upgraded to
/// `wss://` by a session holding no pin to check it with.
const String kQrFingerprintKey = 'fp';

/// Every endpoint that could be THIS pairing's dial target, primary first.
///
/// [primary] is a full endpoint (`ws://host:port`, as `endpoint=` carries it);
/// [altHosts] are bare hosts. The result is deduped and keeps the declared
/// order, because the order is what makes the choice reproducible: two reachable
/// NICs must always yield the same answer, or the stored endpoint would flap
/// between them on every reconnect.
List<String> expandCandidates({
  required String primary,
  Iterable<String> altHosts = const <String>[],
}) {
  final String head = primary.trim();
  if (head.isEmpty) return const <String>[];
  final List<String> out = <String>[head];
  final Set<String> seen = <String>{head.toLowerCase()};

  final Uri? base = Uri.tryParse(head);
  // No parseable host ⇒ no way to rebuild an alternate from it. The primary is
  // still returned: a weird endpoint is the caller's to fail on, loudly, exactly
  // as before — silently dropping it would be worse than dialling it.
  if (base == null || base.host.isEmpty) return out;

  for (final String raw in altHosts) {
    final String host = raw.trim();
    if (host.isEmpty) continue;
    final String url = base.replace(host: host).toString();
    if (seen.add(url.toLowerCase())) out.add(url);
  }
  return out;
}

/// D2LAN-B3 — the well-formed `fp=` a pairing link carries, or `null`.
///
/// Shape-checked here as well as in `PairEntry.parse` because the two are read
/// on different paths and a value that is a pin for one and not the other is the
/// split this file's `kQrFingerprintKey` doc warns about. This one returns null
/// rather than throwing: it answers 「要不要走 TLS」 ("whether to use TLS"), and
/// `PairEntry.parse` is the place that refuses the payload outright.
String? qrFingerprint(String rawLink) {
  final Uri? uri = Uri.tryParse(rawLink.trim());
  if (uri == null) return null;
  final String fp = (uri.queryParameters[kQrFingerprintKey] ?? '').trim();
  return isWellFormedLanTlsFingerprint(fp) ? fp : null;
}

/// Read the dial candidates out of a scanned/pasted `flowmic://pair` link.
///
/// Returns `[]` when the link carries no `endpoint=` — that is the pre-existing
/// 「a bare 4-digit code needs a typed address」 case, which `addByCode` already
/// answers with `NO_ENDPOINT`, and inventing a candidate here would hide it.
///
/// D2LAN-B3 — with a `fp=` present the PRIMARY is upgraded to `wss://` before
/// expansion, so every alternate inherits the secure scheme by the same
/// mechanism that already makes it inherit the port. One rewrite covers all six
/// candidates, and no alternate can end up on a different scheme from the
/// primary — which is exactly the property `expandCandidates` was built for.
List<String> qrDialCandidates(String rawLink) {
  final Uri? uri = Uri.tryParse(rawLink.trim());
  if (uri == null) return const <String>[];
  String primary = (uri.queryParameters['endpoint'] ?? '').trim();
  if (primary.isEmpty) return const <String>[];
  if (qrFingerprint(rawLink) != null) primary = secureDialUrl(primary);
  final String alt = (uri.queryParameters[kQrAltKey] ?? '').trim();
  return expandCandidates(
    primary: primary,
    altHosts: alt.isEmpty ? const <String>[] : alt.split(','),
  );
}

/// The candidate list for a REMEMBERED pairing: whatever worked last time,
/// first, then everything else that pairing was told about.
///
/// [current] leads deliberately — it is the address a successful connection was
/// actually made on, which is a stronger fact than the desktop's original
/// ranking. On a network that has not changed this makes the probe pick the same
/// address again, so nothing is rewritten and nothing flaps.
List<String> rememberedDialCandidates(String current, Iterable<String> stored) {
  final String head = current.trim();
  final List<String> out = <String>[];
  final Set<String> seen = <String>{};
  if (head.isNotEmpty && seen.add(head.toLowerCase())) out.add(head);
  for (final String raw in stored) {
    final String e = raw.trim();
    if (e.isEmpty) continue;
    if (seen.add(e.toLowerCase())) out.add(e);
  }
  return out;
}

/// Every address ONE PAIRING ATTEMPT could dial, best guess first.
///
/// [qrLink] is the scanned/pasted link when there was one (`null` for a bare
/// 4-digit code and for the cloud-instance (云端实例) entry). [endpoint] LEADS even when the link
/// declares its own, because that is the value `addByCode` resolved and the one
/// a pre-B4-15 build would have dialled — leading with it makes everything this
/// card adds strictly a fallback. (In practice they are the same string:
/// `addByCode` reads the endpoint out of the very link parsed here.)
///
/// D2LAN-B3 — [pinned] is 「this pairing has a fingerprint to check」, from the QR
/// or (TOFU) from what the address just showed us. It upgrades the LEADING
/// endpoint too, which the QR-derived ones already are: leaving it plain would
/// put an un-upgradeable `ws://` at the head of a pinned list and every dial
/// would take it — a pin that is never checked, which is worse than no pin
/// because the badge would say it was.
List<String> pairDialCandidates({
  required String? qrLink,
  required String endpoint,
  bool pinned = false,
}) {
  final String head = pinned ? secureDialUrl(endpoint) : endpoint;
  if (qrLink == null) return <String>[head];
  final List<String> fromQr = qrDialCandidates(qrLink);
  if (fromQr.isEmpty) return <String>[head];
  return rememberedDialCandidates(head, fromQr);
}

/// The reconnect ladder's per-rung address chooser (`ReconnectCoordinator
/// .dialUrlResolver`). `null` ⇒ 「keep dialling what you were dialling」.
///
/// 🔴 绝不许串号 ("never let IDs cross-wire — no crosstalk"). This may only ever move the ladder between addresses OF THE SAME
/// PC, so it refuses outright unless [current] is itself one of [known]. Without
/// that check a stale list left over from a previous pairing could redirect a
/// live ladder at another machine — and the token would then be presented to a
/// PC it was never issued for.
Future<String?> resolveLadderUrl({
  required String current,
  required List<String> known,
  required HealthReader read,
  required Duration timeout,
}) async {
  if (known.length < 2) return null;
  final String key = current.toLowerCase();
  if (!known.any((String c) => c.toLowerCase() == key)) return null;
  // `chooseDialEndpoint` falls back to the head (= `current`) when nothing
  // answered, so a probe that can reach nothing never MOVES the ladder — it only
  // ever promotes an address something positively answered on.
  final EndpointChoice choice = await chooseDialEndpoint(
    candidates: rememberedDialCandidates(current, known),
    read: read,
    timeout: timeout,
  );
  return choice.endpoint;
}

/// Write down the address a reconnect actually succeeded on.
///
/// Called only after the token was ACCEPTED there: a dial that connects proves
/// nothing about admission, and writing the address down earlier is the same
/// mistake `resumePairing`'s own move-to-front comment warns about. Normalized
/// to the http form, like every other persisted endpoint (RV-97).
Future<void> persistDialedEndpoint({
  required TokenStorage storage,
  required String token,
  required String url,
}) async {
  final String normalized = httpBaseOf(url);
  for (final MobileSession s in await storage.readPairings()) {
    if (s.token != token) continue;
    if (s.endpoint == normalized) return;
    await storage.addOrUpdatePairing(s.copyWith(endpoint: normalized));
    return;
  }
}

/// What one candidate answered. `reachable` is 「it served /api/health」, nothing
/// more — never 「the pairing will succeed」.
class CandidateAttempt {
  const CandidateAttempt(this.endpoint, {required this.reachable});
  final String endpoint;
  final bool reachable;
}

/// The decision: which endpoint to dial, and what we learned on the way.
class EndpointChoice {
  const EndpointChoice(this.endpoint, {this.probed = false, this.attempts = const <CandidateAttempt>[]});

  /// The endpoint to dial. ALWAYS non-empty when there was any candidate at all
  /// — with nothing reachable this is the declared primary, i.e. exactly what a
  /// pre-B4-15 build would have dialled.
  final String endpoint;

  /// Whether any probe ran. False for the single-candidate path.
  final bool probed;

  /// The answers we actually waited for, in declared order. Empty when [probed]
  /// is false. Partial by design on the success path: candidates ranked BELOW
  /// the winner were never awaited, and reporting a verdict we did not wait for
  /// would be an invented fact.
  final List<CandidateAttempt> attempts;
}

/// Probe [candidates] and choose one to dial.
///
/// Cost model, because it sits in front of a user-visible action:
///   · 0/1 candidate            → returns immediately, no request at all;
///   · primary reachable        → one LAN round-trip (milliseconds);
///   · primary dead, N-th alive → one [timeout], because the probes run in
///     PARALLEL and only the await is ordered. Total wait is bounded by
///     [timeout] however many candidates there are.
///
/// Priority-ordered rather than first-to-answer on purpose: 「谁先答应」
/// ("whichever answers first") makes the winner depend on scheduling noise, so
/// two runs on one network could store two
/// different endpoints. The declared order is the desktop's, and it is stable.
Future<EndpointChoice> chooseDialEndpoint({
  required List<String> candidates,
  required HealthReader read,
  Duration timeout = const Duration(seconds: 2),
}) async {
  if (candidates.isEmpty) return const EndpointChoice('');
  if (candidates.length == 1) return EndpointChoice(candidates.first);

  final List<Future<bool>> probes = <Future<bool>>[
    for (final String e in candidates) _probeReachable(e, read, timeout),
  ];
  final List<CandidateAttempt> attempts = <CandidateAttempt>[];
  for (int i = 0; i < candidates.length; i++) {
    final bool ok = await probes[i];
    attempts.add(CandidateAttempt(candidates[i], reachable: ok));
    if (ok) {
      return EndpointChoice(candidates[i], probed: true, attempts: attempts);
    }
  }
  // Nothing answered. Dial the declared primary anyway (see the file header): a
  // probe that cannot reach anything may be wrong about the socket, and refusing
  // here would invent a failure the previous build did not have. The attempts
  // ride along so a real dial failure can name every address it tried.
  return EndpointChoice(candidates.first, probed: true, attempts: attempts);
}

Future<bool> _probeReachable(String endpoint, HealthReader read, Duration timeout) async {
  try {
    // `healthUri` is the funnel that maps ws→http (RV-89); calling it here rather
    // than normalizing at the call site is the same decision that file documents.
    //
    // 🔴 ORDER IS LOAD-BEARING: neutralize the error FIRST, apply the belt SECOND.
    //
    // The obvious spelling — `await read(...).timeout(...)` inside this try — is
    // WRONG, and wrong in a way `on Object` cannot save: when the source future
    // completes with an error, `Future.timeout` re-reports it to the enclosing
    // zone even though the `await` also delivers it here and this catch swallows
    // it. Measured, not assumed: the 「a reader that THROWS an Error」 case in
    // endpoint_candidates_test.dart fails that way and passes this way, and the
    // difference is entirely the `.then(onError:)` below. So `raw` can only ever
    // complete with a VALUE, and `.timeout` never sees an error at all.
    //
    // The belt itself guards a reader that ignores its own budget — it must not
    // be able to park the user on 配对中… ("pairing…") forever.
    final Future<HealthReading> raw = read(healthUri(endpoint), timeout).then<HealthReading>(
      (HealthReading r) => r,
      // `Object`, not `Exception`: RV-89 was a swallowed `ArgumentError` (an
      // Error) escaping an `on Exception`. Unreachable IS the answer.
      onError: (Object e, StackTrace s) => HealthReading.offline,
    );
    final HealthReading reading = await raw.timeout(
      timeout + const Duration(seconds: 1),
      onTimeout: () => HealthReading.offline,
    );
    return reading.ok;
  } on Object {
    // A synchronously-thrown one (an unparseable endpoint reaching `healthUri`)
    // never becomes a future at all, so it still needs catching here.
    return false;
  }
}

// ── the loud report ─────────────────────────────────────────────────────────
//
// owner-visible half of 「没有静默失败」 ("no silent failure"): when a pairing fails after trying more
// than one address, the message has to say WHICH ones and WHAT each said.
// Encoded into the existing error-code channel (PairResult.error → lastError →
// AppStrings.pairError) because that is the only string the sheet renders; the
// decode lives here too, next to the encode, so the two cannot drift.

/// Error-code prefix for 「试了这几个地址，都不行」 ("tried these addresses, none worked").
const String kCandidateFailurePrefix = 'CONNECT_FAILED_CANDIDATES:';

/// Why one address did not work.
///
/// 🔴 D2LAN-B3 ADDED THE THIRD, and it is a different KIND of fact from the other
/// two. Those two are both 「没连上」 ("did not connect") with different amounts
/// of progress; this one is 「连上了，而对面不是那台电脑」 ("connected, but the
/// other side is not that computer"). Design §3-5 / §6-4 named the trap: a wrong
/// fingerprint that merely made a candidate look unreachable would collapse into
/// 「都够不着，检查一下 Wi-Fi」 ("none of them can be reached, check your Wi-Fi") —
/// a sentence that is false, and that sends the user
/// to fix the one thing that is working.
enum CandidateFailure {
  /// The health probe got no usable answer — 「够不着」 ("can't reach it").
  unreachable,

  /// This is the one we actually dialled, and the dial failed — 「连不上」 ("can't connect").
  dialFailed,

  /// D2LAN-B3: TLS completed far enough to see a certificate, and its public key
  /// is NOT the one this pairing pinned.
  pinMismatch,
}

const String _unreachableTag = 'unreachable';
const String _dialFailedTag = 'dial_failed';
const String _pinMismatchTag = 'pin_mismatch';

/// Build the error code. [dialed] is marked [CandidateFailure.dialFailed] — or
/// [CandidateFailure.pinMismatch] when [dialedPinMismatch] — and every other
/// listed endpoint is [CandidateFailure.unreachable].
///
/// 🔴 [dialedPinMismatch] is about the DIALLED address only, deliberately. The
/// probe does not pin (lan_pinning.dart: it is a chooser, it authenticates
/// nothing), so it has no opinion to report about the others, and inventing one
/// would name addresses we never actually verified.
String encodeCandidateFailure({
  required List<CandidateAttempt> attempts,
  required String dialed,
  bool dialedPinMismatch = false,
}) {
  final String dialedTag = dialedPinMismatch ? _pinMismatchTag : _dialFailedTag;
  final List<String> parts = <String>[];
  final Set<String> seen = <String>{};
  for (final CandidateAttempt a in attempts) {
    if (!seen.add(a.endpoint)) continue;
    final String tag = a.endpoint == dialed ? dialedTag : _unreachableTag;
    parts.add('${a.endpoint}=$tag');
  }
  if (seen.add(dialed)) parts.add('$dialed=$dialedTag');
  return '$kCandidateFailurePrefix${parts.join('|')}';
}

/// Read it back. `null` when [code] is not one of ours — the caller then falls
/// through to its existing copy rather than printing a half-parsed string.
List<MapEntry<String, CandidateFailure>>? decodeCandidateFailure(String? code) {
  if (code == null || !code.startsWith(kCandidateFailurePrefix)) return null;
  final String body = code.substring(kCandidateFailurePrefix.length);
  final List<MapEntry<String, CandidateFailure>> out =
      <MapEntry<String, CandidateFailure>>[];
  for (final String part in body.split('|')) {
    final int at = part.lastIndexOf('=');
    if (at <= 0) continue;
    final String endpoint = part.substring(0, at);
    final String tag = part.substring(at + 1);
    out.add(
      MapEntry<String, CandidateFailure>(endpoint, switch (tag) {
        _dialFailedTag => CandidateFailure.dialFailed,
        _pinMismatchTag => CandidateFailure.pinMismatch,
        // Anything else INCLUDING a tag written by a future build: 「够不着」
        // ("can't reach it") is the weakest claim of the three, so an unknown tag degrades to the one
        // that over-promises least.
        _ => CandidateFailure.unreachable,
      }),
    );
  }
  return out.isEmpty ? null : out;
}
