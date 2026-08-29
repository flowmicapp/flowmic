// SPEC-REF:
//   docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md (owner: the
//     phone's settings cloud card shows the plan tier AND a two-way quota
//     gauge — minutes from the left, context tokens from the right)
//   apps/server-core/src/http/console-routes.ts ③ (GET /api/cloud/summary —
//     Bearer auth, `{plan, quota:{stt,llm,month}, devices}`)
//   CLAUDE.md red line: one value answers one question / a parsed field with no
//     consumer is a façade
//
// The WIRE half of the phone's quota read-out: where to ask, how to ask, and
// what an answer has to look like before we believe it. The STATE half (when to
// ask, what to keep) is `cloud_summary_controller.dart`; the PICTURE is
// `ui/quota_gauge.dart`. Three files because they answer three questions, the
// same split `pc_presence_probe.dart` / `pc_presence.dart` already uses.
//
// 🔴 THIS PARSES EXACTLY WHAT SOMETHING CONSUMES AND NOT ONE FIELD MORE. The
// body also carries `plan`, `devices` and `quota.month`; none of them has a
// consumer on this phone, so none of them is read here. A field parsed
// 「because it was in the response」 is a capability with no consumer — this
// repo's headline defect class — and the cheapest place to not create one is
// the parser.
//
// ⚠️ 2026-08-29 — THE SCOPE OF THIS FILE WIDENED BY EXACTLY ONE FIELD, and the
// sentence above was reworded to say so honestly rather than left describing a
// file it no longer described. It used to read 「exactly what the GAUGE draws」,
// because the gauge was the only consumer. `continuous_minutes` is read for a
// different consumer — the per-session ceiling card CR-6 enforces — so the rule
// is now stated as 「what something consumes」. The rule did not move; the set
// of consumers did.
//
// ⚠️ `used_in` (input tokens) is deliberately NOT read either. The server's own
// QuotaView header records why the two exist: `used` is the ENFORCED number and
// `used_in` is a reference meter that is never charged against `limit`. A gauge
// that filled from `used_in` would be measuring something nobody is enforcing.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../diag/diag_log.dart' show diag;
import '../signaling/http_endpoint.dart' show httpEndpointUri;

/// One metered dimension as the server reports it: how much is spent, and the
/// ceiling it is spent against. **Both numbers, or no meter** — see
/// [parseCloudSummary].
///
/// 🔴 THERE IS NO 「UNLIMITED」 FACE, AND THAT IS A DELIBERATE NARROWING OF THE
/// RULING'S OWN WORDING. Owner's line reads 「`limit` 为 null（豁免/∞）⇒ 该侧
/// 文字「不限」」 — and its parenthesis names the premise: ∞ crossing the wire
/// as `null`. **The server retired that premise on 2026-08-07** and says so
/// verbatim in the field's own contract (`billing/billing-service.ts`,
/// `QuotaView`: 「nothing here reaches the wire as `null` any more, and a
/// `null` that does show up means we failed to compute it」). An exempt account
/// gets the MAX tier's finite ceiling like everybody else.
/// ⇒ A `null` limit can now only mean 「we failed to read it」, so printing
/// 「unlimited」 for one would put a boundless claim under a live gate — the
/// exact R11 defect the 2026-08-07 ruling was issued to remove. That side of
/// the gauge is ABSENT instead. The desktop card decided this the same way and
/// for the same reason (`apps/desktop/src/lib/cloud-account.ts`, `quotaGauge`).
///
/// ⚠️ If a meter is ever genuinely unbounded again, it needs a POSITIVE signal
/// on the wire. An empty field cannot tell 「no ceiling」 from 「no answer」, and
/// that is what got us here.
class CloudMeter {
  const CloudMeter({required this.used, required this.limit});

  /// Spent so far this billing month. Never negative in practice; a negative
  /// number would still be carried through rather than clamped here, because
  /// clamping in the parser is how a broken server becomes invisible. The
  /// LAYOUT clamps (see `quota_gauge.dart`), and it clamps for drawing only.
  final double used;

  /// The ceiling this month's spend is measured against.
  final double limit;
}

/// The one thing this card reads out of `/api/cloud/summary`.
///
/// 🔴 EACH SIDE IS INDEPENDENTLY NULLABLE. A side that could not be read is a
/// MISSING END OF THE GAUGE — never a zero-length bar, which would read as
/// 「you have used none of it」, an answer we do not have.
class CloudSummary {
  const CloudSummary({
    required this.minutes,
    required this.tokens,
    this.continuousMinutes,
  });

  /// `quota.stt` — speech minutes. The LEFT half of the gauge, or null when it
  /// could not be read.
  final CloudMeter? minutes;

  /// `quota.llm` — context tokens, the ENFORCED (output) meter. The RIGHT half,
  /// or null when it could not be read.
  final CloudMeter? tokens;

  /// Card CR-6 — the longest SINGLE continuous recording this account may run,
  /// in minutes (`PLAN_LIMITS.continuous_minutes`; free 10, pro/max 30, owner
  /// 2026-08-29). Top-level in the body, beside `quota` rather than inside it.
  ///
  /// 🔴 IT ANSWERS A DIFFERENT QUESTION FROM [minutes] AND THE TWO MUST NEVER
  /// BE MERGED. `quota.stt` is 「how much of this month is left」; this is 「how
  /// long one sitting may be」. Free is 20 minutes a month against a 10-minute
  /// ceiling — i.e. two sittings — so a single blended figure would be wrong in
  /// both directions at once. Owner's own wording keeps them apart:
  /// 「最多 X 分钟，还剩 X 分钟」.
  ///
  /// 🔴 `null` MEANS 「WE COULD NOT READ IT」 AND NOTHING ELSE — never
  /// 「unlimited」, never a default. A continuous recording may not START
  /// without this number: its whole shape is a bounded sitting, the retained-
  /// audio budget was sized against the 30-minute worst case
  /// (`RetainedAudioStore.kDefaultCapBytes`), and beginning an unbounded one
  /// would spend a budget nobody checked. Unavailable-and-retryable is the
  /// honest failure; unbounded is not.
  final int? continuousMinutes;
}

/// The summary URL for a cloud endpoint.
///
/// Through the repo's ONE canonical [httpEndpointUri], never a second copy of
/// the `ws→http` rule — RV-89/RV-97's root cause was that the same rule had
/// several implementations and the places without one were exactly the places
/// that broke. This is the fifth http funnel and it asks that function.
Uri cloudSummaryUri(String endpoint) =>
    httpEndpointUri(endpoint, '/api/cloud/summary');

/// A believable summary out of a decoded JSON body, or `null`.
///
/// 🔴 `null` MEANS 「WE COULD NOT BELIEVE THIS」 AND NEVER 「ZERO」. A missing
/// `quota`, a `used_min` that is a string, an old server answering something
/// else entirely — all land here, and all of them must produce **no gauge**
/// rather than a gauge reading 0/0. A guessed number is byte-identical to a
/// measured one once it is on screen, which is the shape this repo keeps
/// paying for.
///
/// ⚠️ ONE UNREADABLE SIDE IS NOT A DEAD SUMMARY — it is a one-ended gauge. Only
/// 「neither end could be read」 produces `null` here, because an empty track
/// under two empty labels is a control that answers nothing. Mirrors the
/// desktop's `quotaGauge` decision for decision.
///
/// **Pure** — no I/O, no logging, no clock. Every branch is unit-testable
/// without a socket.
CloudSummary? parseCloudSummary(Object? decoded) {
  if (decoded is! Map) return null;
  final Object? quota = decoded['quota'];
  if (quota is! Map) return null;
  final CloudMeter? minutes = _meter(quota['stt'], used: 'used_min', limit: 'limit_min');
  final CloudMeter? tokens = _meter(quota['llm'], used: 'used', limit: 'limit');
  if (minutes == null && tokens == null) return null;
  return CloudSummary(
    minutes: minutes,
    tokens: tokens,
    // 🔴 Read INDEPENDENTLY of the two meters and allowed to be absent on its
    // own. It is a different question with a different consumer, so an old
    // server that answers the gauge but not this field must still produce a
    // gauge — and a phone that can draw a gauge must not conclude it may start
    // an unbounded recording.
    //
    // Positive integers only. A 0 or a negative would describe a feature that
    // cannot be used, which is not a thing this field is allowed to say by
    // accident; if a ceiling of zero is ever a real product state it needs to
    // arrive as its own signal rather than as arithmetic nobody chose.
    continuousMinutes: _positiveInt(decoded['continuous_minutes']),
  );
}

/// One `{used…, limit…}` object. `null` — i.e. 「this end of the gauge is not
/// drawn」 — when the object is absent, is not an object, or **either** number
/// is not a number.
///
/// 🔴 THE TWO FIELDS ARE TREATED ALIKE, and that is the 2026-08-07 correction.
/// A missing `limit` used to be readable as 「unlimited」; it no longer can be
/// (see [CloudMeter]), so a ceiling we could not read leaves nothing truthful
/// to draw — exactly like a spend we could not read. Two absences, one honest
/// answer: no bar.
/// A whole positive number, or null. `null` is 「absent or not believable」 —
/// the same rule the meters use, for the same reason.
int? _positiveInt(Object? v) {
  if (v is! num) return null;
  if (!v.isFinite) return null;
  final int n = v.round();
  return n > 0 ? n : null;
}

CloudMeter? _meter(Object? node, {required String used, required String limit}) {
  if (node is! Map) return null;
  final Object? u = node[used];
  final Object? l = node[limit];
  if (u is! num || l is! num) return null;
  return CloudMeter(used: u.toDouble(), limit: l.toDouble());
}

/// Test seam. Production is [httpCloudSummaryFetch]; a unit test supplies its
/// own and never touches the network.
///
/// ⚠️ There is no friendly default anywhere in this file (13 册 §7 F1 ②): the
/// controller either dials for real or is handed one of these.
typedef CloudSummaryFetcher =
    Future<CloudSummary?> Function(Uri url, String bearer, Duration timeout);

/// How long one summary read is allowed to take, end to end.
///
/// Short on purpose. Nothing waits on this: the card renders complete without
/// the gauge, and a slow answer that arrives after the user has left the screen
/// is thrown away by the controller. A generous budget would buy nothing and
/// hold a connection open on a phone.
const Duration kCloudSummaryTimeout = Duration(seconds: 6);

/// The production read: one GET with a Bearer token.
///
/// 🔴 EVERY FAILURE IS `null`, AND THAT IS NOT A SWALLOWED FAILURE. Owner's
/// ruling for this card is that the quota read degrades silently — no banner,
/// no error row, just no gauge — because the settings card's real job (account,
/// tier, entering Notes) does not depend on it and must not be interrupted by
/// it. What keeps that from being a silent failure in the banned sense is the
/// diagnostic line below: every miss says which kind it was, in the trail the
/// user can upload.
///
/// ⚠️ ONE DEADLINE FOR THE WHOLE ATTEMPT, not one per stage — the correction
/// `httpPcPresenceRead` had to make on 2026-08-17, applied here from the start:
/// a `.timeout()` on each of connect / send / read would let a 6 s budget bound
/// an 18 s attempt.
///
/// ⚠️ Catches `Object`, not `Exception`: the thing that bit this repo on the
/// http path was RV-89's `ArgumentError` — an **Error** — thrown by `getUrl` on
/// a `ws://` URL.
Future<CloudSummary?> httpCloudSummaryFetch(
  Uri url,
  String bearer,
  Duration timeout,
) async {
  final HttpClient client = HttpClient()..connectionTimeout = timeout;
  final DateTime deadline = DateTime.now().add(timeout);
  Duration left() {
    final Duration remaining = deadline.difference(DateTime.now());
    return remaining > Duration.zero ? remaining : const Duration(milliseconds: 1);
  }

  String miss = 'unexpected';
  int? code;
  CloudSummary? out;
  try {
    final HttpClientRequest req = await client.getUrl(url).timeout(left());
    req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
    final HttpClientResponse res = await req.close().timeout(left());
    if (res.statusCode != 200) {
      // 🔴 401/403 IS NOT ESCALATED HERE. An expired bearer is already handled
      // by the one layer entitled to act on it (`LoginController
      // .handleAuthExpired`, driven by the socket's auth watchdog). A second
      // opinion minted off a quota read would be a second authority over the
      // session — and this one has the least evidence of any of them.
      miss = switch (res.statusCode) {
        401 || 403 => 'unauthorized',
        404 => 'notFound',
        _ => 'status',
      };
      code = res.statusCode;
      unawaited(res.drain<void>().catchError((Object _) {}));
    } else {
      final String body = await res.transform(utf8.decoder).join().timeout(left());
      out = parseCloudSummary(jsonDecode(body) as Object?);
      if (out == null) miss = 'malformed';
    }
  } on TimeoutException {
    miss = 'timeout';
  } on SocketException catch (e) {
    miss = 'network';
    // The OS code only. The exception's `message` spells the HOST, and the
    // trail leaves the phone (diag_log.dart's rule).
    code = e.osError?.errorCode;
  } on TlsException {
    miss = 'tls';
  } on HttpException {
    miss = 'http';
  } on FormatException {
    miss = 'malformed';
  } on Object {
    miss = 'unexpected';
  } finally {
    client.close(force: true);
  }
  // 🔴 ONE line, and ONLY on a miss. A success writes nothing: the gauge on
  // screen IS the evidence that it worked, and a line per settings visit would
  // push delivery edges out of a 400-line ring buffer.
  //
  // ⚠️ Nothing here names the endpoint, the account or the numbers — `miss` is
  // a fixed vocabulary and `code` is an integer. This is what keeps 「degrade
  // silently on screen」 from being a silent failure: the answer is 「no gauge」
  // to the user and 「this kind of miss」 in the trail they can upload.
  if (out == null) {
    final Map<String, Object?> line = <String, Object?>{'miss': miss};
    // Written as a statement rather than a collection-`if` so the line carries
    // `code` only when there IS one: a `'code': null` entry in the trail reads
    // as 「we looked and there was none」, which is a different claim.
    if (code != null) line['code'] = code;
    diag('cloud.summary.miss', line);
  }
  return out;
}
