// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4.1 (RV-98)
//   apps/server-core/src/http/presence-routes.ts (GET /api/pc/presence)
//   CLAUDE.md red line: no silent failure
//
// RV-98 — the static instance-list page **actually asks** whether that
// computer is there.
//
// owner's own words from a 2026-08-01 real-device session: 「截图 2 中的云端中
// 继这个实例显示的是『中继可达 · 电脑是否在线未知』，实际上 PC 是在线的，这样显示
// 不对，要能正确显示 PC 端是否在线」 ("in screenshot 2, the cloud-relay instance
// shows 'relay reachable · PC online status unknown', but the PC is actually
// online — this display is wrong, it should correctly show whether the PC side
// is online").
//
// This file is the **transport side** of that question; the vocabulary
// ([PcPresence]) lives in `pc_presence.dart`. Splitting it into two files is
// deliberate, the same split as `instance_probe.dart` / `pc_presence.dart`: one
// answers 「怎么问」 ("how to ask"), the other answers 「答案叫什么」 ("what the
// answer is called").
//
// 🔴 **Three deliberate differences** from the `/api/health` probe, each one a
// considered decision:
//   ① it **carries credentials** (this pairing's own token), because it is
//      asking about something private — 「某人的某台电脑此刻在不在线」
//      ("whether a particular person's particular computer is online right
//      now") is not something that can be asked for anonymously;
//   ② it asks **per pairing**, not per address: two pairings can share one
//      relay address yet point at two different computers, so deduping by
//      address would paint A's answer onto B's row (a cross-wired variant of
//      the instance-list page);
//   ③ any case where the question could not be answered (an old server's 404 /
//      a rejected token's 401 / a network fault / the field not being a bool)
//      is uniformly [PcPresence.unknown], **never `offline`** — calling it
//      offline would turn 「we don't know」 into 「we know it's not there」.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../signaling/http_endpoint.dart' show httpEndpointUri;
import '../signaling/lan_pinning.dart' show openPairingHttpClient;
import 'pc_presence.dart' show PcPresence;

/// The result of one presence question-and-answer. [pcId] is the server's own
/// echo of 「我答的是哪台」 ("which one I'm answering for"), `null` = the
/// question never got answered.
class PcPresenceReading {
  const PcPresenceReading({required this.presence, this.pcId});

  final PcPresence presence;

  /// Which PC (`pc_id`) the server says it is answering for. The caller checks
  /// it against the one it has stored —
  /// 🔴 this is the instance-list page's side of the 「绝不许串号」 ("never
  /// cross-wire ids") iron rule: **if the answer doesn't match, it doesn't
  /// count as an answer.**
  final String? pcId;

  /// 「这一次没问到」 ("this question went unanswered"). Distinct from
  /// `offline` — do not merge the two.
  static const PcPresenceReading unknown =
      PcPresenceReading(presence: PcPresence.unknown);
}

/// Test seam: unit tests supply a fake; production's [httpPcPresenceRead] is
/// never dialed from a unit test.
typedef PcPresenceReader =
    Future<PcPresenceReading> Function(Uri url, String token, Duration timeout);

/// Pairing endpoint → the presence-query URL.
///
/// 🔴 **Scheme normalization goes through the repo's ONE canonical
/// [httpEndpointUri]** (`signaling/http_endpoint.dart`) — never rewrite the
/// `ws→http` rule here a second time: both RV-89 and RV-97's root cause was
/// 「同一条规则有几份实现，而没实现的那几处正是出事的那几处」 ("the same rule had
/// several implementations, and it was exactly the places that DIDN'T
/// implement it where things broke") — the desktop's QR code stores `ws://`,
/// and `HttpClient.getUrl` throws **`ArgumentError` (an Error, not an
/// Exception)** on it. This is the **fourth** http funnel, and it has asked
/// that one canonical function from day one.
Uri pcPresenceUri(String endpoint) =>
    httpEndpointUri(endpoint, '/api/pc/presence');

/// The production implementation: one GET with a Bearer token.
///
/// ⚠️ It catches `Object`, not `Exception`, for the same reason as above
/// (RV-89: the thing that actually bit us on this path was an **Error**).
/// This is **not** swallowing a failure: every failure path in this function
/// lands on [PcPresenceReading.unknown], and 「不知道」 ("don't know") is a
/// **spoken sentence** on the UI (「中继可达 · 电脑是否在线未知」 — "relay
/// reachable · PC online status unknown"), not a value quietly smoothed away
/// to nothing.
///
/// D2LAN-B3 — [pin] is the pairing's `MobileSession.lanTlsFp`. This request
/// CARRIES THE PAIRING TOKEN, so unlike the health probe it does not get to be
/// agnostic about who answers: an unpinned https here would hand the credential
/// to whoever picked up. Null pin ⇒ an unpinned pairing ⇒ plain http, exactly as
/// before. `openPairingHttpClient` refuses the impossible combination (a pin on
/// a non-https URL) rather than letting it degrade quietly.
///
/// ⚠️ The extra parameter is OPTIONAL and NAMED on purpose: that keeps this
/// function assignable to [PcPresenceReader], so every existing test double
/// still satisfies the seam untouched.
Future<PcPresenceReading> httpPcPresenceRead(
  Uri url,
  String token,
  Duration timeout, {
  String? pin,
}) async {
  final HttpClient client = openPairingHttpClient(
    url: url,
    pin: pin,
    connectionTimeout: timeout,
  ).client;
  try {
    final HttpClientRequest req = await client.getUrl(url).timeout(timeout);
    req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    final HttpClientResponse res = await req.close().timeout(timeout);
    if (res.statusCode != 200) {
      // 404 = the old server doesn't have this endpoint yet; 401 = this token
      // is not recognised. Both mean 「问不到」 ("couldn't get an answer"),
      // neither means 「电脑不在」 ("the computer isn't there").
      await res.drain<void>().timeout(timeout);
      return PcPresenceReading.unknown;
    }
    final String body =
        await res.transform(utf8.decoder).join().timeout(timeout);
    final Object? decoded = jsonDecode(body);
    if (decoded is! Map<String, Object?> || decoded['ok'] != true) {
      return PcPresenceReading.unknown;
    }
    final Object? online = decoded['pc_online'];
    // 🔴 Field missing / wrong type ⇒ unknown. **Never backfill it with a
    // value that merely looks plausible** — a guessed bool is type-identical
    // to a real measurement, which is exactly the shape of this repo's V2-15.
    if (online is! bool) return PcPresenceReading.unknown;
    final Object? pcId = decoded['pc_id'];
    return PcPresenceReading(
      presence: online ? PcPresence.online : PcPresence.offline,
      pcId: pcId is String && pcId.isNotEmpty ? pcId : null,
    );
  } on Object {
    return PcPresenceReading.unknown;
  } finally {
    client.close(force: true);
  }
}
