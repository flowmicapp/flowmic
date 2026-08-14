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
// its verdict never gates the tap. Anything that is not a clean `{ok:true}` inside
// the timeout is reported as OFFLINE — the honest reading of 「unreachable」.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../signaling/http_endpoint.dart';
import '../signaling/lan_pinning.dart';

/// What we know about one endpoint RIGHT NOW. `unknown` = never probed; it must
/// render as「never probed」, never as online.
enum InstanceReach { unknown, checking, online, offline }

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
  const HealthReading({required this.ok, this.channel});
  final bool ok;
  final ServerChannel? channel;
  static const HealthReading offline = HealthReading(ok: false);
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
Future<HealthReading> httpHealthRead(Uri url, Duration timeout) async {
  final PinnedHttpClient probe = openHttpClient(
    trust: HttpTrust.unverifiedProbe,
    connectionTimeout: timeout,
  );
  final HttpClient client = probe.client;
  try {
    final HttpClientRequest req = await client.getUrl(url).timeout(timeout);
    final HttpClientResponse res = await req.close().timeout(timeout);
    if (res.statusCode != 200) {
      await res.drain<void>().timeout(timeout);
      return HealthReading.offline;
    }
    final String body = await res.transform(utf8.decoder).join().timeout(timeout);
    // 200 alone is not proof it is US — a captive portal answers 200 for
    // everything. The health body has to actually say so.
    final Object? decoded = jsonDecode(body);
    if (decoded is! Map<String, Object?> || decoded['ok'] != true) {
      return HealthReading.offline;
    }
    return HealthReading(ok: true, channel: channelFromHealthMode(decoded['mode']));
  } on Exception {
    return HealthReading.offline; // refused / timed out / DNS / not our JSON — all mean unreachable
  } finally {
    client.close(force: true);
  }
}
