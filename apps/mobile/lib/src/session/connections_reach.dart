// Part of connections_controller.dart — the REACH half: 「这个服务器地址够不着
// 吗」("is this server address unreachable"), list-scope.
//
// SPEC-REF:
//   session/instance_probe.dart (the transport surface + [HealthMiss] +
//     [readHealthRetrying] + the measured table on the pooled probe client)
//   session/pc_presence.dart ([instanceLivenessFaceOf] — where this verdict
//     becomes a word)
//   session/connections_presence.dart (the twin split, and the argument for it)
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// connections_controller.dart crossed `verify/lint/file-size.mjs`'s SRC_MAX=800
// when the 2026-08-18 reach work landed (830). Splitting under the gate rather
// than at it is this repo's standing rule, and deleting comments to fit would
// throw away the evidence that is most of what these blocks are.
//
// 🔴 **The cut follows 「which question it answers」, not line count** — the same
// blade connections_presence.dart used, applied to the other half. What moved
// here is the whole of one question: the two tables that hold the answer
// ([_reach] / [_channel]), the in-flight set that keeps it from being asked
// twice, the hysteresis counter, the three readers the page calls, and the sole
// writer. What stayed behind is `refreshReachability` (it fans out to BOTH
// questions) and `_pruneStaleProbeKeys` (it prunes both) — deliberately not
// dragged along, for the reason stated over there: they are about the LIST, not
// about reachability, and moving them would make this file answer two questions
// again.
//
// ⚠️ **Do not read this split as an architectural statement.**
// `ConnectionsController` is still one object with one lifetime; only the
// declaration site moved.
//
// 🔴 DIFF DISCIPLINE: every member below was moved **character-for-character**
// out of connections_controller.dart, comments included. The only change is the
// one this shape always needs: a mixin cannot see the host class's other fields,
// so the two collaborators the moved bodies read — `_healthRead` and
// `probeTimeout` — are declared here as abstract getters and satisfied by the
// fields still declared over there. **Any difference beyond that is a bug.**
part of 'connections_controller.dart';

/// The list domain's reach half. Mixed into [ConnectionsController]; not usable
/// on its own, and deliberately not general — 「这个地址够不着吗」 is a different
/// question from 「那台电脑在不在」 ([ConnectionsPresenceHost]), and volume 15
/// §1.4 exists because merging them is what shipped the bug owner reported.
mixin ConnectionsReachHost on ChangeNotifier {
  /// Supplied by [ConnectionsController]: the injectable health reader.
  HealthReader get _healthRead;

  /// Supplied by [ConnectionsController]: the per-probe budget.
  Duration get probeTimeout;

  final Map<String, InstanceReach> _reach = <String, InstanceReach>{};
  /// v0.2.3 / RV-54 — last SUCCESSFUL `/api/health.mode` per endpoint.
  ///
  /// Write: only a successful probe that named a known mode.
  /// Keep on failure: 「这次没问到」("didn't get an answer this time") is not
  /// 「它变了」("it changed").
  /// Prune: [load] drops keys for endpoints no longer in the pairing list.
  /// Stale on screen: the page MUST render this as 「上次…」("last time…") when the
  /// row is not
  /// online — painting it as the live chip would say 「现在」("now") for a past fact.
  /// Absent = never measured this process lifetime (in-memory only).
  final Map<String, ServerChannel> _channel = <String, ServerChannel>{};
  final Set<String> _probing = <String>{};

  /// What the last probe said about [endpoint]. `unknown` until one has run —
  /// callers must render that as「未知」("unknown"), never as online.
  InstanceReach reachOf(String endpoint) =>
      _reach[normalizePairEndpoint(endpoint)] ?? InstanceReach.unknown;

  /// Last successful channel measurement for [endpoint], or `null` when none
  /// has landed yet. Callers that paint a LIVE chip must also check [reachOf]
  /// — this value alone is a past fact when the row is offline (RV-54).
  ServerChannel? channelOf(String endpoint) =>
      _channel[normalizePairEndpoint(endpoint)];

  /// Channel to show as 「now」: only when the row is currently online AND we
  /// have a measurement. Distinct from [channelOf] on purpose — conflating them
  /// is how 「上次」("last time") got painted as the live chip.
  ServerChannel? liveChannelOf(String endpoint) {
    final String key = normalizePairEndpoint(endpoint);
    if (_reach[key] != InstanceReach.online) return null;
    return _channel[key];
  }

  /// Consecutive rounds in which this endpoint produced NO ANSWER (a retryable
  /// miss, after the in-cycle retries were already spent).
  ///
  /// 🔴 Reset by any ANSWER, including an unwelcome one: a 502 and a captive
  /// portal are measurements, and a measurement never waits for a second
  /// opinion. This counter is about 「问不到」("could not get an answer"), never
  /// about 「它说不行」("it said no") — folding those two together is what put
  /// a red 「离线」("offline") under a relay that was serving.
  final Map<String, int> _reachMisses = <String, int>{};

  /// The ONE place a [HealthReading] becomes a word on the screen, and the sole
  /// writer of [_reachMisses].
  ///
  /// ⚠️ An UNCLASSIFIED miss (`miss == null`) is a definite `offline`, not a
  /// hesitation. Same rule as [readHealthRetrying]'s ③: a reader that did not
  /// say why is asserting a verdict, not reporting a difficulty — and every
  /// injected fake in the suite is exactly that, so their rows keep the face
  /// they have always had.
  InstanceReach _reachVerdict(String endpoint, HealthReading reading) {
    if (reading.ok) {
      _reachMisses.remove(endpoint);
      return InstanceReach.online;
    }
    final HealthMiss? miss = reading.miss;
    if (miss == null || !miss.retryable) {
      _reachMisses.remove(endpoint);
      return InstanceReach.offline;
    }
    final int inARow = (_reachMisses[endpoint] ?? 0) + 1;
    _reachMisses[endpoint] = inARow;
    return inARow >= kReachMissesBeforeOffline
        ? InstanceReach.offline
        : InstanceReach.unanswered;
  }

  Future<void> _probeOne(String endpoint) async {
    HealthReading reading;
    // 🔴 The stopwatch is the thing 0.3.9's on-device pass found MISSING from
    // the line below (handoff §7-3): with `miss` alone, card C4 could be
    // answered down to 「什么类别的失败」 ("what class of failure") and no
    // further — while the measurement that actually pinned the root cause was a
    // DURATION (p95 3.37 s against a 3 s budget). A probe that answers in 2.9 s
    // and one that answers in 0.2 s are both `ok=true` and are not the same
    // health.
    //
    // ⚠️ It times THIS WHOLE CALL — every retry inside the budget included —
    // because that is what the row's user waited for. A per-attempt number
    // would be a different question, and nothing on screen asks it.
    final Stopwatch elapsed = Stopwatch()..start();
    try {
      // 🔴 Bounded retry WITHIN this one cycle, the same shape the presence
      // probe next door has had since 2026-08-16 — and this is the half that
      // never got it, while being the half the row's verdict is decided by
      // (`instanceLivenessFaceOf` switches on `reach` FIRST). One lost SYN used
      // to be the whole answer.
      reading = await readHealthRetrying(
        healthUri(endpoint),
        budget: HealthRetryBudget(
          attempts: kInstanceListReachBudget.attempts,
          // ⚠️ NOT the budget constant's own 3 s: [probeTimeout] is this
          // controller's injectable per-probe budget and is the same 3 s. Two
          // spellings of one number is the drift this repo keeps paying for —
          // the constant declares the intent, this field is what production and
          // the tests actually dial with. (Identical wording, and identical
          // reasoning, to `_probePresenceOne`.)
          perAttemptTimeout: probeTimeout,
          backoff: kInstanceListReachBudget.backoff,
        ),
        reader: _healthRead,
      );
    } on Exception {
      reading = HealthReading.offline; // unreachable IS the answer, not a swallow
    } finally {
      _probing.remove(endpoint);
    }
    final InstanceReach verdict = _reachVerdict(endpoint, reading);
    // 🔴 THE FORENSIC LINE THIS PATH NEVER HAD. Before it, `grep diag(
    // instance_probe.dart connections_controller.dart connections_presence.dart`
    // returned **0** — so when a row said 「离线」("offline"), the phone's own
    // uploaded diagnostics could not say whether that was a timeout, a TLS
    // failure, a 502 or a captive portal. Card C4 (owner 2026-08-17, 「探针在外网
    // 为什么问不到」/ "why the probe cannot get an answer on the public internet")
    // stayed open for exactly that reason: not that nobody looked, but that
    // there was nothing to look at.
    //
    // ⚠️ Host only, never the full endpoint — this line is meant to be readable
    // in a diagnostics upload, and the path/token space of an endpoint is not
    // needed to answer the question it exists for.
    diag('reach.probe', <String, Object?>{
      'host': Uri.tryParse(endpoint)?.host ?? '',
      'ok': reading.ok,
      'miss': reading.miss?.name,
      'misses_in_a_row': _reachMisses[endpoint] ?? 0,
      'verdict': verdict.name,
      'ms': elapsed.elapsedMilliseconds,
    });
    _reach[endpoint] = verdict;
    // Only a SUCCESSFUL read may set the channel. A failed probe leaves the last
    // known value alone rather than erasing it — 「这次没问到」("didn't get an
    // answer this time") is not 「它变了」("it changed").
    final ServerChannel? channel = reading.channel;
    if (reading.ok && channel != null) {
      _channel[endpoint] = channel;
    }
    notifyListeners();
  }
}
