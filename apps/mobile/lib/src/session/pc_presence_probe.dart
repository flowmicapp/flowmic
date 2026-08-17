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

import 'package:crypto/crypto.dart' show sha256;

import '../diag/diag_log.dart' show diag;
import '../signaling/http_endpoint.dart' show httpEndpointUri;
import '../signaling/lan_pinning.dart' show openPairingHttpClient;
import 'pc_presence.dart' show PcAbsentReason, PcPresence;

/// 🔴 **Why one presence question came back without an answer.** Client-local:
/// nothing on the wire carries it, nothing is rendered from it — it exists so
/// that a layer above can tell 「再问一次可能就问到了」 ("asking again might have
/// worked") apart from 「再问一万次也是这个答案」 ("asking ten thousand more times
/// gives the same answer").
///
/// 🔴 Until this enum existed, [PcPresenceReading.unknown] was the ONE value
/// every failure collapsed into. That flattening is correct **for the user**
/// (see the header's ③ — a 3-second network hiccup must never render as a
/// confident 「offline」) and it is exactly wrong **for a retry layer**: a 401
/// and a 3-second timeout were type-identical, so no caller could retry the one
/// worth retrying without also hammering the one that will never change its
/// mind. Adding a reason does not soften ③ — every member below still lands on
/// [PcPresence.unknown].
enum PcPresenceMiss {
  /// The per-attempt budget elapsed with nothing back. **Retryable**: the
  /// commonest cause is a momentary stall, and the next attempt frequently
  /// answers.
  timeout,

  /// The connection itself failed (`SocketException` / TLS). **Retryable**:
  /// a Wi-Fi roam or a relay restart looks exactly like this and is over in
  /// well under a second.
  network,

  /// HTTP 404 — this server has no such route. **Not retryable**: it is an old
  /// server, and it will be an old server on the next attempt too.
  notFound,

  /// HTTP 401 / 403 — this pairing's token was rejected. **Not retryable**:
  /// the server answered, it just answered 「不认识你」 ("I don't know you").
  /// Retrying would be an authentication-failure hammer, not a recovery.
  unauthorized,

  /// Any other non-200. **Not retryable under the current ruling**, even for a
  /// 503 that plausibly would clear: the rule is 「只重试 timeout 与 network」
  /// ("retry only timeout and network"), and widening it is a decision to take
  /// deliberately rather than by inference at this line.
  serverError,

  /// A 200 whose body could not be believed — not JSON, `ok != true`, or
  /// `pc_online` not a bool. **Not retryable**: the same server will render the
  /// same body.
  malformed,

  /// The request could never be issued, or the attempt threw something no arm
  /// above names — RV-89's `ws://` `ArgumentError` (an **Error**, not an
  /// Exception) is the known member. **Not retryable**: it is deterministic,
  /// and it is a defect on our side rather than a condition on the network's.
  unexpected;

  /// 🔴 The whole point of the enum, in one place. **Two members, and the
  /// default is `false`** — a member added later is not retryable until someone
  /// writes it down here, which is the safe direction: forgetting to retry
  /// costs one poll, forgetting NOT to retry costs a hammer on a server that
  /// already said no.
  bool get retryable =>
      this == PcPresenceMiss.timeout || this == PcPresenceMiss.network;
}

/// The result of one presence question-and-answer. [pcId] is the server's own
/// echo of 「我答的是哪台」 ("which one I'm answering for"), `null` = the
/// question never got answered.
class PcPresenceReading {
  const PcPresenceReading({
    required this.presence,
    this.pcId,
    this.miss,
    this.absentReason,
  });

  /// A question that went unanswered, carrying WHY. The presence is
  /// [PcPresence.unknown] by construction — there is no way to build one of
  /// these that claims a measurement it does not have.
  const PcPresenceReading.unanswered(PcPresenceMiss this.miss)
    : presence = PcPresence.unknown,
      pcId = null,
      absentReason = null;

  final PcPresence presence;

  /// Which PC (`pc_id`) the server says it is answering for. The caller checks
  /// it against the one it has stored —
  /// 🔴 this is the instance-list page's side of the 「绝不许串号」 ("never
  /// cross-wire ids") iron rule: **if the answer doesn't match, it doesn't
  /// count as an answer.**
  final String? pcId;

  /// 🔴 Why this question went unanswered, `null` when it WAS answered.
  ///
  /// ⚠️ Read by the retry layer only. It must never reach the UI: the user's
  /// sentence for every member is the same 「不知道」 ("don't know"), and a
  /// screen that named the class would be inviting the reader to act on a
  /// distinction that changes nothing they can do.
  ///
  /// ⚠️ `null` on [unknown] itself is deliberate and load-bearing: a test
  /// double that returns the bare constant is saying 「没问到」 with no claim
  /// about why, and [PcPresenceMiss.retryable] is only consulted when a class
  /// was actually named ⇒ an unclassified miss is never retried. That keeps
  /// every pre-existing fake behaving exactly as it did.
  final PcPresenceMiss? miss;

  /// 🔴 The server's own answer to 「它为什么不在」 ("why is it not there"),
  /// straight off the wire (`pc_absent_reason`, presence-routes.ts). `null`
  /// whenever the server did not say — which is every online response, every
  /// LAN sidecar, every old relay, and any reason string this build does not
  /// recognise.
  ///
  /// ⚠️ It is **not** a second opinion about [presence]: the server only
  /// includes it when it has already said `pc_online:false`, and this field
  /// alone can never make a row absent. A reason with no absence attached is
  /// carried and then ignored, exactly as it should be.
  final PcAbsentReason? absentReason;

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
      //
      // 🔴 The VALUE is still unknown for all three; only the reason differs,
      // and the reason is read exclusively by the retry layer. Each of these is
      // a case where the server ANSWERED, which is why none of them is
      // retryable — see [PcPresenceMiss].
      await res.drain<void>().timeout(timeout);
      return PcPresenceReading.unanswered(switch (res.statusCode) {
        404 => PcPresenceMiss.notFound,
        401 || 403 => PcPresenceMiss.unauthorized,
        _ => PcPresenceMiss.serverError,
      });
    }
    final String body =
        await res.transform(utf8.decoder).join().timeout(timeout);
    final Object? decoded = jsonDecode(body);
    if (decoded is! Map<String, Object?> || decoded['ok'] != true) {
      return const PcPresenceReading.unanswered(PcPresenceMiss.malformed);
    }
    final Object? online = decoded['pc_online'];
    // 🔴 Field missing / wrong type ⇒ unknown. **Never backfill it with a
    // value that merely looks plausible** — a guessed bool is type-identical
    // to a real measurement, which is exactly the shape of this repo's V2-15.
    if (online is! bool) {
      return const PcPresenceReading.unanswered(PcPresenceMiss.malformed);
    }
    final Object? pcId = decoded['pc_id'];
    return PcPresenceReading(
      presence: online ? PcPresence.online : PcPresence.offline,
      pcId: pcId is String && pcId.isNotEmpty ? pcId : null,
      // 🔴 Read at the same moment, off the same response, as the presence it
      // qualifies — never asked for separately. `pc_absent_reason` is OMITTED
      // (not null) when nothing was recorded, and an unrecognised string parses
      // to null, so both flavours of 「没说」 ("didn't say") arrive here as the
      // same absence of a claim. [PcAbsentReason.parse] owns that rule; this
      // line must never grow a second copy of it.
      absentReason: PcAbsentReason.parse(decoded['pc_absent_reason']),
    );
    // 🔴 The arms below narrow the ONE `on Object` this function used to have.
    // They change no outcome — every one of them still returns
    // [PcPresence.unknown] — they only name which failure it was, and `on
    // Object` stays last so RV-89's shape (an **Error**, not an Exception)
    // cannot escape past a list of Exception types.
  } on TimeoutException {
    return const PcPresenceReading.unanswered(PcPresenceMiss.timeout);
  } on SocketException {
    return const PcPresenceReading.unanswered(PcPresenceMiss.network);
  } on TlsException {
    // `HandshakeException` extends this, so a pin mismatch lands here too. It
    // is classed **network** and therefore retried, which is deliberate: a
    // genuine mismatch fails identically on every attempt and costs one extra
    // round trip, while the far commoner cause of a TLS fault on this path is
    // a relay restart mid-handshake.
    return const PcPresenceReading.unanswered(PcPresenceMiss.network);
  } on HttpException {
    return const PcPresenceReading.unanswered(PcPresenceMiss.network);
  } on FormatException {
    // `jsonDecode` on a body that is not JSON.
    return const PcPresenceReading.unanswered(PcPresenceMiss.malformed);
  } on Object {
    return const PcPresenceReading.unanswered(PcPresenceMiss.unexpected);
  } finally {
    client.close(force: true);
  }
}

// ── bounded retry, within ONE poll cycle ────────────────────────────────────
//
// 🔴 THE DEFECT THIS CLOSES. One transient miss used to stick. On the instance
// list it stuck **until the user pulled to refresh** (`refreshReachability` has
// no timer of its own — the only callers are initState, return-from-chat,
// return-from-background and the pull gesture), so a single 3-second stall left
// a row reading 「中继可达 · 电脑是否在线未知」 ("relay reachable · PC status
// unknown") next to a computer that was on the whole time. That is owner's
// original RV-98 complaint arriving through a second door.
//
// 🔴 WHY A RETRY AND NOT A LONGER TIMEOUT. They are not interchangeable. A
// longer timeout makes the row wait longer for the SAME stalled connection; a
// second attempt opens a NEW one, which is what actually recovers from a Wi-Fi
// roam or a relay restart. And the failure classes differ: extending the budget
// does nothing at all for a `SocketException` that returned in 12 ms.
//
// 🔴 WHY ONE HELPER AND NOT ONE PER CALLER. The two askers already exist for a
// documented reason (doc 15 §1.4: the session domain holds stronger evidence
// and must not share the list domain's table) — but that is an argument about
// the ANSWER, not about the asking. This repo has paid for a duplicated
// mechanism before: two copies of one rule is how it ended up holding two
// different PC names. The two callers differ only in three numbers, so the
// three numbers are the parameters and the mechanism is written once.

/// One asker's budget for a single poll cycle. A named triple rather than three
/// loose constants, so 「这条路愿意等多久」 ("how long is this path willing to
/// wait") has one place to read and one place to change.
class PcPresenceRetryBudget {
  const PcPresenceRetryBudget({
    required this.attempts,
    required this.perAttemptTimeout,
    required this.backoff,
  });

  /// Total attempts, INCLUDING the first. 1 = today's behaviour, no retry.
  final int attempts;

  /// Budget for each individual attempt — deliberately not a whole-cycle
  /// budget: a per-attempt clock is what makes 「换一条新连接」 ("open a fresh
  /// connection") possible at all.
  final Duration perAttemptTimeout;

  /// The pause BEFORE attempt i+2, i.e. `backoff[0]` sits between attempt 1 and
  /// attempt 2. Length is `attempts - 1`; a written-out list rather than a
  /// growth formula, because the worst case has to be readable by adding the
  /// numbers up rather than by simulating a loop.
  final List<Duration> backoff;

  /// Worst case for one cycle, for the comments and the tests that pin it. Pure
  /// arithmetic over the fields — never a second, hand-maintained number.
  Duration get worstCase =>
      perAttemptTimeout * attempts +
      backoff.fold<Duration>(Duration.zero, (Duration a, Duration b) => a + b);
}

/// 🔴 The INSTANCE LIST's budget. Generous on purpose: this path is
/// manual-refresh, the row is already painting 检测中 ("checking…") for the
/// whole wait, and there is no next tick coming to correct a wrong answer —
/// so the wait is honest, visible, and the only chance this cycle gets.
/// Worst case ≈ 10.2 s.
///
/// ⚠️ `perAttemptTimeout` is NOT read from here in production: the caller
/// passes `ConnectionsController.probeTimeout`, which is the same 3 s and stays
/// injectable. The value here is the declared default and what the tests pin.
const PcPresenceRetryBudget kInstanceListPresenceBudget = PcPresenceRetryBudget(
  attempts: 3,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[Duration(milliseconds: 300), Duration(milliseconds: 900)],
);

/// 🔴 The IN-SESSION poll's budget. Tight on purpose, and the constraint is
/// arithmetic rather than taste: this runs on `kIdlePcPresencePollInterval`
/// (10 s, an owner ruling that must not be "optimised"), so a cycle that can
/// outlast a tick would leave polls overlapping. Worst case = 3 × 2 + 0.5 =
/// 6.5 s, which leaves 35 % headroom.
///
/// ⚠️ It is also the CHEAPER path to be wrong on: a miss here is corrected by
/// the next tick 10 seconds later, which is exactly the correction the instance
/// list does not have.
///
/// ⚠️ `perAttemptTimeout` is NOT read from here in production — SAME shape as
/// [kInstanceListPresenceBudget] above: the caller passes
/// `PttSession.presencePollTimeout`, which is the same 3 s and stays
/// injectable. The value here is the declared intent and what the tests pin;
/// the field is what production and the tests actually dial with.
/// 🔴 It said 2.5 s until 2026-08-16, and that half-second gap was the whole
/// defect: the field became a knob that changed nothing, which this repo holds
/// to be worse than no knob at all. Two spellings of one number is the drift
/// this comment block exists to stop, so if one moves the other moves with it —
/// `ptt_presence_poll_test.dart` pins that the FIELD is what reaches the reader.
const PcPresenceRetryBudget kSessionPollPresenceBudget = PcPresenceRetryBudget(
  attempts: 2,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[Duration(milliseconds: 500)],
);

/// Ask once, and ask again only when asking again could change the answer.
///
/// Returns the first ANSWERED reading. When the budget runs out — or the miss
/// says another attempt is pointless — the result is [PcPresence.unknown]
/// exactly as before this function existed: **retry is an attempt to get an
/// answer, never a licence to invent one**.
///
/// 🔴 THREE THINGS THAT ARE NEVER RETRIED, each for its own reason:
///   ① a definite `online`/`offline` — that is a MEASUREMENT. Re-asking would
///      delay a true answer the caller already holds and add load for nothing;
///   ② a miss whose class is not [PcPresenceMiss.retryable] — the server
///      answered, it just answered 「no」;
///   ③ a miss with NO class at all (`miss == null`) — an injected reader that
///      did not classify. Unclassified means 「我们不知道再问一次有没有用」
///      ("we don't know whether asking again would help"), and the safe reading
///      of that is 「不要再问」 ("don't ask again").
///
/// [reader] is the same seam [PcPresenceReader] has always been; null routes to
/// the production [httpPcPresenceRead] carrying [pin]. That split lives here
/// now instead of being written out at each call site — it was already two
/// copies of one ternary.
/// 🔴 A stable stand-in for 「问的是哪个地址」 ("which address was asked"), for
/// the diagnostic trail. First 12 hex of sha256 over the ORIGIN only — no path,
/// no query, and the token never comes near it.
///
/// ⚠️ It is a **correlator, not a secret**, and saying so is the point: a LAN
/// address has few enough possibilities that anyone determined could grind it
/// back out. What it actually buys is that the trail — which leaves the phone
/// when the user uploads it — never *contains* an address, while two lines
/// about the same computer can still be recognised as being about the same
/// computer. In this repo addresses are treated as user content
/// (`verify/lint/no-lan-ip.mjs` exists for exactly that), so 「不打印」 ("do not
/// print it") is the rule and this is how the line stays useful anyway.
String presenceEndpointFingerprint(Uri url) {
  final String origin = '${url.scheme}://${url.host}:${url.port}';
  return sha256.convert(utf8.encode(origin)).toString().substring(0, 12);
}

Future<PcPresenceReading> readPcPresenceRetrying(
  Uri url,
  String token, {
  required PcPresenceRetryBudget budget,
  PcPresenceReader? reader,
  String? pin,
}) async {
  assert(budget.attempts >= 1, 'a budget that never asks is not a budget');
  final Stopwatch elapsed = Stopwatch()..start();
  int used = 0;
  PcPresenceReading reading = PcPresenceReading.unknown;
  for (int i = 0; i < budget.attempts; i++) {
    used = i + 1;
    try {
      reading = reader != null
          ? await reader(url, token, budget.perAttemptTimeout)
          : await httpPcPresenceRead(
              url,
              token,
              budget.perAttemptTimeout,
              pin: pin,
            );
    } on Object {
      // Only an injected reader can get here — [httpPcPresenceRead] resolves
      // every throw itself. Catching Object (not Exception) is RV-89's shape;
      // the class is `unexpected`, which is not retryable, so a throwing double
      // behaves exactly as it did before this loop existed.
      reading = const PcPresenceReading.unanswered(PcPresenceMiss.unexpected);
    }
    if (reading.presence != PcPresence.unknown) {
      return reading; // ① answered — nothing to report
    }
    final PcPresenceMiss? miss = reading.miss;
    if (miss == null || !miss.retryable) break; // ②③
    if (i + 1 >= budget.attempts) break; // budget spent
    await Future<void>.delayed(budget.backoff[i]);
  }
  elapsed.stop();
  // 🔴 ONE line, on the FINAL settle to 「不知道」 ("don't know") — never per
  // attempt. Per-attempt lines would put three entries in a 400-line ring
  // buffer for one poll cycle, and on the instance list that is once per
  // pairing per 15 s: the trail would push out the delivery edges it exists to
  // preserve, and it would do it fastest on exactly the flaky network where
  // someone is about to ask for it.
  //
  // 🔴 WHAT THIS LINE BUYS. Before it, a field report of 「它显示未知」 ("it
  // showed unknown") was completely unattributable: we could not tell a
  // rejected token from a stalled relay from an old server, and every one of
  // those has a different fix. These four fields are the smallest set that
  // makes the NEXT occurrence diagnosable.
  //
  // ⚠️ WHAT IS DELIBERATELY NOT IN IT: the endpoint (hashed — addresses are
  // user content in this repo), the token, the PC's name or id. The trail is
  // uploaded to the PC on request, so everything written here leaves the phone
  // — diag_log.dart's header lists that rule and this line obeys it.
  diag('presence.unknown', <String, Object?>{
    // 🔴 The field the line exists for. Without it every settle reads the same
    // and the log answers 「问不到」 ("couldn't get an answer") — which the user
    // already told us. WHICH kind of not-getting-an-answer is the whole
    // question.
    'miss': reading.miss?.name ?? 'unclassified',
    'attempts': used,
    'elapsed_ms': elapsed.elapsedMilliseconds,
    'endpoint_h': presenceEndpointFingerprint(url),
  });
  return reading;
}
