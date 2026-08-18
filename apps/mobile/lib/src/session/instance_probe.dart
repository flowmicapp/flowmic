// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §1 (instance list = the launch home screen;
//     launching does NOT auto-connect (Option B))
//   apps/server-core/src/http/router.ts (GET /api/health → {ok,mode,port,version,script})
//   CLAUDE.md red line: no silent failure
//
// The instance list's LIGHTWEIGHT reachability probe (owner 2026-07-27).
//
// The list used to show nothing at rest, on purpose: presence was unknown until a
// tap connected, and inventing a green dot would have been a façade. owner asked
// for the state anyway — so it is MEASURED, not guessed: one unauthenticated HTTP
// GET /api/health per distinct endpoint (the cloud relay included, it serves the
// same route). A probe is not a session: it opens no socket, holds no token, and
// its verdict never gates the tap.
//
// 🔴 IN-PLACE CORRECTION (2026-08-18). This header used to end: 「Anything that
// is not a clean `{ok:true}` inside the timeout is reported as OFFLINE — the
// honest reading of 「unreachable」.」 **That sentence was true when written and
// is false now, and it was also the defect**: on a path that loses packets, 「we
// could not get an answer this once」 is not 「unreachable」, and reporting it as
// such put a red 「离线」("offline") on a relay that was serving. The rule now:
//   · a read is retried only while retrying could change the answer ([HealthMiss]);
//   · a miss keeps its CLASS all the way to the caller, so 「问不到」("could not
//     get an answer") and 「它说不行」("it said no") never render alike;
//   · the connection is REUSED between probes, which is where the whole measured
//     failure tail lived (the table on [_probeClientCache]).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart';

/// What we know about one endpoint RIGHT NOW. `unknown` = never probed; it must
/// render as「never probed」, never as online.
///
/// 🔴 [unanswered] is NOT a gentler [offline] — the two answer different
/// questions, and they were one value until 2026-08-18.
///   · [offline]    — we asked, repeatedly, and this address is not serving.
///   · [unanswered] — THIS round produced no answer at all. Nothing is known to
///     be wrong over there; what we know is that we could not find out.
///
/// **The measurement that forced the split** (tablet TB335ZC, office Wi-Fi,
/// direct — no proxy — 2026-08-18, 80 samples of the exact request this file
/// makes): to the cloud relay, `total` p50 1.14 s, p90 2.68 s, p95 3.37 s,
/// max 8.53 s, with **7.5 % of probes past 3 s**. The same tablet, same minute,
/// same tool, to a domestic host: p50 0.092 s, p90 0.107 s, nothing past 2 s.
/// The device and the network were fine; that one path simply loses packets, so
/// a single miss was never evidence that the relay had gone away — and painting
/// it 「离线」("offline") said exactly that, once every few minutes, in red.
enum InstanceReach { unknown, checking, online, unanswered, offline }

/// WHY a health read came back empty-handed.
///
/// It exists for the same reason `PcPresenceMiss` does one file over
/// (pc_presence_probe.dart): **a retry is only honest when asking again could
/// change the answer**, and a `bool` cannot say which case this was. Until this
/// enum existed, [httpHealthRead] folded DNS failure, a lost SYN, a 502 and a
/// captive portal's HTML into one `false` — so this probe could not retry
/// intelligently, and it could not tell anyone afterwards what had happened.
enum HealthMiss {
  /// The per-attempt budget elapsed with nothing back. **Retryable** — on the
  /// measured path above this is the commonest miss by a wide margin.
  timeout,

  /// The connection itself failed (`SocketException` / TLS / a socket that died
  /// mid-read). **Retryable**: a Wi-Fi roam, a relay restart and a lost SYN all
  /// look exactly like this and are over in well under a second.
  network,

  /// A non-200. **Not retryable**: the server answered, it just answered 「no」.
  http,

  /// 200, but the body is not ours — `ok != true`, or not even JSON (a captive
  /// portal answers 200 for everything). **Not retryable** for the same reason:
  /// whatever is on the other end, it will still be there next attempt.
  malformed,
}

extension HealthMissRetry on HealthMiss {
  /// The one place the retry rule is written down. Deliberately narrow — the
  /// same 「只重试 timeout 与 network」("retry only timeout and network") ruling
  /// `PcPresenceMiss.retryable` states, so the two probes on this page cannot
  /// drift into two different ideas of what is worth asking twice.
  bool get retryable => this == HealthMiss.timeout || this == HealthMiss.network;
}

/// The seam: unit tests supply a fake instead of touching the network.
typedef HealthProbe = Future<bool> Function(Uri url, Duration timeout);

// ─── which CHANNEL is on the other end (v0.2.1) ──────────────────────────
//
// owner 2026-07-28: 「the connection I established by scanning the PC-side
// cloud-relay QR code shows as local LAN」. The chip was reading
// `destination.isFixed`, which answers a DIFFERENT
// question — 「is the other end that focus-less virtual cloud instance」 —
// and a real PC reached
// THROUGH the relay answers `false` to it. Same socket, PC said cloud, phone
// said LAN.
//
// The endpoint string cannot settle it either. There was already an
// `_inferChannel` here matching the literal `flowmic.app`, which is wrong for
// a self-hosted relay, and「a private-network address is LAN」is wrong too: this deployment's
// own LAN lives on 100.64.7.x, which is PUBLICLY REGISTERED space, not RFC1918.
// Guessing from an address is how the first version of this got it wrong.
//
// So we ask the server what it is. `/api/health` already returns `mode` and the
// list already calls it — 'standalone' IS the LAN sidecar running on someone's
// PC, 'saas' IS the relay. That is measured, it costs nothing new, and it is
// right for a self-hosted relay on a private address as well.

/// What the server said it is. `null` = we have not been able to ask yet, which
/// must render as NO chip — never as a guess (V2-15: a missing field vanishes,
/// it is never back-filled with something plausible).
enum ServerChannel { lan, cloudRelay }

/// Map the `/api/health` `mode` field. Anything we do not recognise is `null`:
/// a future third mode must not silently read as one of these two.
ServerChannel? channelFromHealthMode(Object? mode) => switch (mode) {
  'standalone' => ServerChannel.lan,
  'saas' => ServerChannel.cloudRelay,
  _ => null,
};

/// One health reading: reachability AND which channel answered.
class HealthReading {
  const HealthReading({required this.ok, this.channel, this.miss});
  final bool ok;
  final ServerChannel? channel;

  /// WHY this read failed, when the reader could say. `null` on every success,
  /// and — deliberately — also on a miss nobody classified.
  ///
  /// 🔴 THE NULL IS NOT A DEFAULT, IT IS AN ANSWER: 「we do not know whether
  /// asking again would help」, and the safe reading of that is 「do not ask
  /// again」 ([readHealthRetrying] rule ③). That is what keeps [offline] below —
  /// and every injected test reader that returns it — behaving exactly as it did
  /// before retries existed.
  final HealthMiss? miss;

  /// An unclassified miss. **Kept for its existing callers** (endpoint_candidates
  /// .dart's two fallbacks, and the fakes across the mobile suite), all of which
  /// mean 「something went wrong and we are not saying what」.
  static const HealthReading offline = HealthReading(ok: false);

  /// A classified miss — what [httpHealthRead] returns, and the only shape a
  /// retry can act on.
  const HealthReading.missed(HealthMiss this.miss) : ok = false, channel = null;
}

/// How many times, and how long, one health question may be asked.
///
/// A class rather than three loose parameters for the same reason
/// `PcPresenceRetryBudget` is one: the three numbers only mean anything
/// together, and [worstCase] is the arithmetic that has to fit inside the
/// caller's tick.
class HealthRetryBudget {
  const HealthRetryBudget({
    required this.attempts,
    required this.perAttemptTimeout,
    required this.backoff,
  });

  final int attempts;
  final Duration perAttemptTimeout;

  /// Waits BETWEEN attempts, so its length is `attempts - 1`.
  final List<Duration> backoff;

  Duration get worstCase =>
      perAttemptTimeout * attempts +
      backoff.fold<Duration>(Duration.zero, (Duration a, Duration b) => a + b);
}

/// 🔴 The instance list's reach budget, and the arithmetic is the constraint.
///
/// The list re-probes on `kInstanceListPresencePollInterval` (15 s) and this
/// runs CONCURRENTLY with the presence probe's own budget (worst case 10.2 s),
/// so this one's worst case must also fit inside a tick: 2 × 3 s + 0.3 s =
/// **6.3 s**. Two attempts, not three, for that reason and one more — with the
/// connection now reused ([httpHealthRead]), the first attempt already skips the
/// handshake where 100 % of the measured tail lived, so the second attempt is
/// there for the burst case, not for the ordinary one.
const HealthRetryBudget kInstanceListReachBudget = HealthRetryBudget(
  attempts: 2,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[Duration(milliseconds: 300)],
);

/// How many CONSECUTIVE answer-less rounds before an endpoint is called
/// [InstanceReach.offline] rather than [InstanceReach.unanswered].
///
/// 🔴 Two, and the second one is not free — it costs the user up to one whole
/// poll interval (15 s) of 「暂时问不到」("no answer right now") before the row
/// turns red. That is the trade being made deliberately: on the measured path
/// a lone miss is far more likely to be a lost packet than a relay that went
/// away, and **the two mistakes are not symmetric**. Saying 「问不到」 about a
/// relay that really is down costs 15 seconds of vagueness; saying 「离线」
/// about a relay that is serving sends someone to debug a server that is fine
/// — and it did, several times an hour.
///
/// ⚠️ Not a general timeout knob: it counts ROUNDS, not seconds, so it stays
/// correct if the poll interval is ever tuned.
const int kReachMissesBeforeOffline = 2;

/// Ask once, and ask again only when asking again could change the answer.
///
/// Returns the first ANSWERED reading. When the budget runs out — or the miss
/// says another attempt is pointless — the LAST miss is returned with its class
/// intact, so the caller can still tell 「问不到」("could not get an answer")
/// from 「它说不行」("it said no").
///
/// 🔴 THREE THINGS THAT ARE NEVER RETRIED, each for its own reason — the same
/// three, in the same order, as `readPcPresenceRetrying`:
///   ① a successful read — that is a MEASUREMENT, re-asking would only delay it;
///   ② a miss whose class is not [HealthMissRetry.retryable] — the server
///      answered, it just answered 「no」;
///   ③ a miss with NO class at all (`miss == null`) — an injected reader that
///      did not classify. Unclassified means 「we do not know whether asking
///      again would help」, and the safe reading of that is 「do not ask again」.
Future<HealthReading> readHealthRetrying(
  Uri url, {
  required HealthRetryBudget budget,
  HealthReader? reader,
}) async {
  final HealthReader read = reader ?? httpHealthRead;
  HealthReading last = HealthReading.offline;
  for (int attempt = 0; attempt < budget.attempts; attempt++) {
    if (attempt > 0) {
      final int i = attempt - 1;
      await Future<void>.delayed(
        i < budget.backoff.length ? budget.backoff[i] : budget.backoff.last,
      );
    }
    try {
      last = await read(url, budget.perAttemptTimeout);
    } on Object {
      // A reader that THROWS is a reader that did not classify — rule ③.
      return HealthReading.offline;
    }
    if (last.ok) return last;
    final HealthMiss? miss = last.miss;
    if (miss == null || !miss.retryable) return last;
  }
  return last;
}

/// The seam for the richer probe.
typedef HealthReader = Future<HealthReading> Function(Uri url, Duration timeout);

/// A pairing endpoint → its health URL. Any path/query the stored endpoint
/// carried is dropped: /api/health is an absolute route on the server root, and
/// a pairing endpoint with a stray path is exactly the input that would
/// otherwise probe a 404 and read as offline.
///
/// 🔴 RV-89 — THE SCHEME IS NORMALIZED **HERE**, AND THAT IS NOT A CONVENIENCE.
///
/// This function used to be documented as taking an endpoint 「already normalized
/// by normalizePairEndpoint」. That sentence was true of ONE of its two callers
/// and false of the other, and nobody re-checked it — the anti-façade ④ shape: a
/// comment defending a design is itself a claim, and this one was wrong.
///
///   · connections_controller.refreshReachability → normalizePairEndpoint ⇒ http(s). ✔
///   · ptt_session._refreshServerChannel → `MobileSession.endpoint` VERBATIM. ✘
///
/// A QR-paired PC stores what the QR carried, and the desktop always writes a
/// **ws-url** (`apps/desktop/src/lib/pairing.ts` `toWsUrl()`, pinned by its own test:
/// `flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone`).
/// `HttpClient.getUrl` on a `ws://` URI throws `ArgumentError: Unsupported scheme
/// 'ws'` — an **Error, not an Exception** — so [httpHealthRead]'s `on Exception`
/// never saw it, it escaped to the caller's blanket catch, and the caller wrote
/// down 「unknown」. Every QR-paired session therefore read as 「channel
/// unknown」 for its
/// whole life, which is fail-closed and silent: no channel chip, no LAN http
/// image ingress (RCA-v3 inert), LAN pictures picked at the CLOUD tier, and — the
/// bug owner reported — no original-image tick box on the LAN leg.
///
/// Normalizing at the funnel rather than at the two call sites is deliberate:
/// the call site that was wrong had no way to know it was wrong, and a third
/// caller would have inherited the same trap.
///
/// 🔴 RV-97 Correction —— **the sentence above is correct, but RV-89 only did
/// half the job.** Normalization does indeed
/// land in the funnel, but **there is more than one funnel**: the image HTTP
/// upload (`uploadImageInject`) and the diagnostics
/// upload (`uploadDiagnostics`) also treat the same endpoint as an HTTP base,
/// and they had **not one character of normalization**
/// at all — so owner got, on a 0.2.35 real device,
/// 「cannot reach the computer (… Unsupported scheme 'ws' …), the picture was
/// not sent」.
/// ⇒ The rule itself has been moved to `signaling/http_endpoint.dart`, **the
/// only copy in the whole repo**, and all three funnels
/// ask it. What this function retains is 「what the /api/health URL looks
/// like」, no longer 「how ws becomes http」.
Uri healthUri(String endpoint) => httpEndpointUri(endpoint, '/api/health');

/// The production probe. dart:io does its own networking, so a cleartext LAN
/// address works here for the same reason ws://172.x already does (Android's
/// usesCleartextTraffic governs the PLATFORM http stacks, not Dart's).
Future<bool> httpHealthProbe(Uri url, Duration timeout) async =>
    (await httpHealthRead(url, timeout)).ok;

/// The same single request, keeping BOTH facts it already returns. Reachability
/// is what the list dot needs; `mode` is what the channel chip needs. Reading
/// them from one response is the only way the two can never disagree.
///
/// D2LAN-B3 — 🔴 THE ONE FUNNEL THAT DOES NOT PIN, AND IT IS NOT AN OVERSIGHT.
///
/// This request is unauthenticated (`/api/health` takes no token) and its answer
/// is a CHOOSER, never a gate — the rule this file and endpoint_candidates.dart
/// both state. Refusing an unrecognised certificate here would report 「unreachable」
/// about an address that is answering, which would silently delete the multi-NIC
/// selection feature on every pinned pairing AND make a fingerprint mismatch look
/// like a network problem — the exact degradation design §3-5 named. The identity
/// check happens on the DIAL, loudly, where a token is actually presented.
///
/// It sends nothing secret and grants nothing, which is what makes that safe. The
/// `mode` it reads was already an unauthenticated claim over plain HTTP before
/// this card, so nothing here got weaker.
/// 🔴 ONE CLIENT, KEPT ALIVE — and this is the single highest-leverage line in
/// the file. **Measured** (tablet TB335ZC, office Wi-Fi, direct, 2026-08-18):
///
/// | | fresh connection every probe (what this used to do) | connection reused |
/// |---|---|---|
/// | p50 | 1.14 s | 0.55 s |
/// | p90 | 2.68 s | 1.25 s |
/// | p95 | **3.37 s** | **1.43 s** |
/// | max | **8.53 s** | **1.90 s** |
/// | past the 3 s budget | **7.5 %** | **0 of 80** |
///
/// And directly, not by subtraction — five requests down one curl invocation on
/// the same device: first (new connection) 1.096 s, then 0.350 / 0.352 / 0.351 /
/// 0.606 s. **Every one of the 80 samples' tail lived in the TCP+TLS handshake**,
/// which this probe was paying on every single tick and then throwing away with
/// `close(force: true)`. The relay is 167 ms away and loses SYNs; the handshake
/// is what turned that into a red row.
///
/// ⚠️ **`idleTimeout` IS LOAD-BEARING AND ITS DEFAULT IS A TRAP.** Dart's default
/// is **15 s** (`dart-sdk/lib/_http/http.dart`, `Duration idleTimeout = const
/// Duration(seconds: 15)`) and the list re-probes every **15 s**
/// (`kInstanceListPresencePollInterval`) — the pooled connection would expire at
/// almost exactly the moment the next probe wants it, so reuse would be a coin
/// flip and this whole change would look like it did nothing. 60 s is chosen to
/// clear that interval with room, and to stay well inside both Cloudflare's
/// client keep-alive and any plausible NAT idle timeout.
///
/// ⚠️ Sharing is safe **on this arm only**: [HttpTrust.unverifiedProbe] carries
/// no pin and this funnel sends no credential (the file header's D2LAN-B3 note).
/// The pinned/credentialed funnels keep building a client per call, because
/// there the client object IS where the per-attempt verdict is recorded.
/// How long a pooled probe connection may sit idle before dart:io drops it.
/// **Must exceed the list's re-probe interval** — see the ⚠️ above.
const Duration kProbeClientIdleTimeout = Duration(seconds: 60);

PinnedHttpClient? _probeClientCache;

/// Deliberately written out rather than as `??=` with a cascade: `a ??= b..c`
/// parses correctly but reads ambiguously, and the thing being set here is the
/// one field whose default silently undoes the whole change.
HttpClient _probeClient(Duration connectionTimeout) {
  PinnedHttpClient? cached = _probeClientCache;
  if (cached == null) {
    cached = openHttpClient(
      trust: HttpTrust.unverifiedProbe,
      connectionTimeout: connectionTimeout,
    );
    cached.client.idleTimeout = kProbeClientIdleTimeout;
    _probeClientCache = cached;
  }
  // Re-applied per call, because the budget is injectable
  // (`ConnectionsController.probeTimeout`) and a cached client must not pin the
  // FIRST caller's number onto every later one.
  cached.client.connectionTimeout = connectionTimeout;
  return cached.client;
}

Future<HealthReading> httpHealthRead(Uri url, Duration timeout) async {
  final HttpClient client = _probeClient(timeout);
  HttpClientRequest? req;
  try {
    req = await client.getUrl(url).timeout(timeout);
    final HttpClientResponse res = await req.close().timeout(timeout);
    if (res.statusCode != 200) {
      await res.drain<void>().timeout(timeout);
      return const HealthReading.missed(HealthMiss.http);
    }
    final String body = await res.transform(utf8.decoder).join().timeout(timeout);
    // 200 alone is not proof it is US — a captive portal answers 200 for
    // everything. The health body has to actually say so.
    final Object? decoded = jsonDecode(body);
    if (decoded is! Map<String, Object?> || decoded['ok'] != true) {
      return const HealthReading.missed(HealthMiss.malformed);
    }
    return HealthReading(ok: true, channel: channelFromHealthMode(decoded['mode']));
  } on TimeoutException {
    // 🔴 ABORT, do not just walk away. The old code killed the whole client in
    // its `finally`, which incidentally killed the socket too; now the client
    // OUTLIVES the request, so an abandoned request would leave a half-used
    // connection in the pool for the next probe to trip over.
    req?.abort();
    return const HealthReading.missed(HealthMiss.timeout);
  } on FormatException {
    return const HealthReading.missed(HealthMiss.malformed); // 200, but not JSON
  } on Exception {
    req?.abort();
    return const HealthReading.missed(HealthMiss.network); // refused / DNS / TLS / socket died
  }
}
