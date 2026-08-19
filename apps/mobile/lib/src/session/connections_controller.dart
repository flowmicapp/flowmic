// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §1 (nav: paired → ConnectionsPage connection
//     list, launch does not auto-connect — Option B), §4 (pairing entry: 4-digit
//     code / QR; MobileSession persisted in token_storage)
//   docs/ui-design/demo/mobile.html frame 1 (instance list: paired PC + cloud
//     instance)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R23-1 (entering the 4-digit code is
//     mandatory; connect goes through the existing
//     socket_core / mobile_reconnect_flow; token goes through R3-1 token_storage)
//   CLAUDE.md red line: no silent failures
//
// The instance-list controller: reads the remembered PC pairings from the shared
// PttSession's token_storage (persisted, most-recent first), and drives the two
// entry paths — tap a remembered PC (mobile:reconnect by token) and add a new
// pairing (4-digit short_code → mobile:pair). Every failure is surfaced loudly
// via [lastError]; a rejected pair NEVER produces a fake connected state. The
// cloud-instance entry is presentation-only here (the page opens the reused login
// sheet); server-side cloud admission is LIVE (WP-R4-1/2 — the login sheet drives
// the real mobile:login → JWT → cloud_instance pairing flow).

import 'package:flutter/foundation.dart';

import '../auth/login_controller.dart';
import '../auth/saas_endpoint.dart';
import '../auth/token_storage.dart';
import '../diag/diag_log.dart' show diag;
import '../ptt/ptt_session.dart';
import '../signaling/http_endpoint.dart';
// 🔴 L-② — the SIGNALING layer owns the fact 「这次重连被拒了，服务器说的是什么、
// 还剩多少毫秒」("this reconnect was refused — what did the server say, and how
// many milliseconds are left") and owns the encode/decode pair for it; this
// controller only
// forwards it. Same reason `app_strings.dart` imports `decodeCandidateFailure`
// rather than re-parsing: one format, one reading.
import '../signaling/mobile_reconnect_flow.dart'
    show ReconnectRefusal, encodeHoldOut;
import '../signaling/wire_payloads.dart';
import 'instance_probe.dart';
import 'pc_presence.dart';
import 'pc_presence_probe.dart';

// 🔴 The 800-line gate (`verify/lint/file-size.mjs` SRC_MAX=800) — the presence
// half (「这一行背后那台电脑在不在」/ "is the computer behind this row there") was
// moved character-for-character over there before this round added to it. Same
// library, so `_pruneStaleProbeKeys` below still reaches `_presence`.
part 'connections_presence.dart';
// 🔴 The same gate, the other half: the 2026-08-18 reach work (retry, miss
// classification, hysteresis, the forensic line) pushed this file to 830, so
// 「这个地址够不着吗」 moved out beside 「那台电脑在不在」. Same library, so
// `refreshReachability` and `_pruneStaleProbeKeys` below still reach both tables.
part 'connections_reach.dart';

/// Normalize a user-typed PC address into a socket.io-dialable http(s) URL.
/// Accepts `host:port`, `http(s)://…`, and `ws(s)://…` (mapped to http(s)).
///
/// 🔴 RV-97 — the body used to be a SECOND copy of that mapping (the first being
/// `instance_probe.healthUri`), and the two http funnels that had NO copy are
/// what shipped the bug. One rule, one place: [httpBaseOf]. This function keeps
/// its name because it answers a different question with the same rule — 「拨号
/// 时用哪个 URL」("which URL to use when dialing") rather than 「请求某条 HTTP
/// 路由时用哪个 URL」("which URL to use when requesting some HTTP route") — and unlike
/// `httpEndpointUri` it must PRESERVE any path the address carried.
String normalizePairEndpoint(String raw) => httpBaseOf(raw);

/// Compact dial target for the instance row (RV-54). Pure host[:port] — no
/// scheme — so a LAN IP and a relay domain stay visually distinct without a
/// live probe. Empty when the endpoint cannot be parsed.
String dialHostLabel(String endpoint) {
  final String normalized = normalizePairEndpoint(endpoint);
  if (normalized.isEmpty) return '';
  final Uri? uri = Uri.tryParse(normalized);
  if (uri == null || uri.host.isEmpty) return normalized;
  if (uri.hasPort && uri.port != 80 && uri.port != 443) {
    return '${uri.host}:${uri.port}';
  }
  return uri.host;
}

/// Outcome of an add/connect action so the page can branch (navigate on success,
/// surface [error] on failure) without re-reading controller state.
class ConnectOutcome {
  const ConnectOutcome.ok()
    : success = true,
      error = null;
  const ConnectOutcome.failed(this.error) : success = false;
  final bool success;
  final String? error;
}

class ConnectionsController extends ChangeNotifier
    with ConnectionsPresenceHost, ConnectionsReachHost {
  ConnectionsController({
    required this.session,
    required this.login,
    String? saasEndpoint,
    this.onPaired,
    HealthReader? healthReader,
    PcPresenceReader? presenceReader,
    this.probeTimeout = const Duration(seconds: 3),
  }) : saasEndpoint = saasEndpoint ?? resolveSaasEndpoint(),
       _healthRead = healthReader ?? httpHealthRead,
       _presenceRead = presenceReader;

  /// GA-11 (lead's ruling on the worker's escalation): fired after a pairing
  /// SUCCEEDS. The settings snapshot rides the connected rising edge, but a
  /// FIRST pairing authenticates mid-connection — the edge has already passed
  /// and its settings:list came back AUTH_TOKEN_INVALID. Without this the
  /// freshly-installed phone shows a blank scenario card until the next
  /// reconnect, which is precisely the silent inconsistency GA-11 exists to
  /// remove. It is not a second rising edge: it is the moment identity appears.
  /// `hydrate()` is idempotent, so a redundant call costs one ack.
  final void Function()? onPaired;

  final PttSession session;

  /// The cloud-account controller — the source of the SaaS JWT that admits a
  /// cloud instance (and the fail-loud re-login target when it expires).
  final LoginController login;

  /// The effective SaaS endpoint (--dart-define override or the protocol
  /// default). Injectable so tests dial a fake host.
  final String saasEndpoint;

  List<MobileSession> _pairings = <MobileSession>[];
  List<MobileSession> get pairings => List<MobileSession>.unmodifiable(_pairings);

  bool _loading = true;
  bool get loading => _loading;

  bool _busy = false;
  /// A connect/pair round-trip is in flight (disables list taps).
  bool get busy => _busy;

  String? _lastError;
  /// Fail-loud error code from the last connect/pair attempt (null when clean).
  String? get lastError => _lastError;

  // ── connecting / reachability (owner 2026-07-27) ─────────────────────────
  // ① 「点了没反应就一直点」("tapping with no visible response makes people keep
  //    tapping"): [busy] already blocked the second tap, but silently.
  //    The list now names WHICH row is dialling, so the wait is visible.
  // ② the resting list showed nothing about whether a PC is even up. It now shows
  //    a MEASURED reachability per endpoint (see instance_probe.dart).

  /// v0.2.3 — the probe now reads BOTH facts off the one response: reachability
  /// (the dot) and `mode` (the channel chip). Reading them from one request is
  /// the only way the two can never disagree about the same server.
  ///
  /// `@override` because [ConnectionsReachHost] declares it as an abstract
  /// getter — the same shape `probeTimeout` / `_presenceRead` already have for
  /// [ConnectionsPresenceHost]. The field stays HERE, with the constructor that
  /// takes it; only the code that reads it moved.
  @override
  final HealthReader _healthRead;

  /// 🔴 RV-98 — the SECOND question the resting list asks, over its own request:
  /// `GET /api/pc/presence` (pc_presence_probe.dart). owner 2026-08-01:「要能正确
  /// 显示 PC 端是否在线」("it must correctly show whether the PC side is online").
  ///
  /// ⚠️ Deliberately NOT folded into [_healthRead]. They are two questions with
  /// two different subjects — 「这个服务器地址够不着吗」("is this server address
  /// unreachable") vs 「我配对的那台电脑在不
  /// 在」("is the computer I'm paired with there or not") — and volume 15 §1.4
  /// exists because merging them is exactly what shipped the
  /// bug owner reported (the relay's health was being painted as the PC's
  /// presence). One response answering both would put them back in one value.
  ///
  /// ⚠️ D2LAN-B3 made it NULLABLE, and null is the production value: the probe
  /// has to hand `httpPcPresenceRead` THAT ROW'S pin, which is a named argument
  /// this typedef does not carry — and widening the typedef would have
  /// invalidated every test double implementing it. Null means 「走生产实现，
  /// 带上这一行自己的 pin」("go through the production implementation, carrying
  /// this row's own pin"), never 「不探测」("don't probe").
  ///
  /// ⚠️ Declared here and consumed in connections_presence.dart, which sees it
  /// through the abstract getter [ConnectionsPresenceHost._presenceRead] this
  /// field satisfies.
  @override
  final PcPresenceReader? _presenceRead;

  /// Per-probe budget. 3 s is long enough for a LAN RTT and short enough that a
  /// dead address does not hold the row at 检测中("checking…") while the user
  /// stares at it.
  @override
  final Duration probeTimeout;


  // 🔴 RV-98's `_presence` / `_presenceProbing` moved to
  // connections_presence.dart (same library) — see the part directive above.

  String? _connectingKey;

  /// [keyFor] of the row whose connect is in flight — null when idle. The page
  /// renders 连接中…("connecting…") on exactly this row.
  String? get connectingKey => _connectingKey;

  /// Stable per-row key. [MobileSession.connectionIdentity] throws when a legacy
  /// row has neither instance id nor token; the endpoint is a fine fallback for a
  /// purely visual key.
  static String keyFor(MobileSession pairing) {
    try {
      return pairing.connectionIdentity;
    } on StateError {
      return 'endpoint:${pairing.endpoint}';
    }
  }

  /// The dashed 「云端实例」("cloud instance") entry card, which has no
  /// MobileSession yet.
  static const String cloudEntryKey = 'cloud-entry';

  /// Probe every listed endpoint, the cloud relay included, in parallel. Deduped
  /// by normalized endpoint (two pairings on one host are one request) and
  /// re-entrant-safe: an endpoint already in flight is not probed twice.
  ///
  /// RV-98 — and, alongside it, one `GET /api/pc/presence` PER PAIRING. The two
  /// run concurrently rather than in sequence: they are independent questions,
  /// and when the address is unreachable the face never consults presence anyway
  /// (`instanceLivenessFaceOf` answers `unreachable` first).
  Future<void> refreshReachability() async {
    final Set<String> targets = <String>{
      for (final MobileSession p in _pairings) normalizePairEndpoint(p.endpoint),
      // 🔴 The default relay address is probed FOR THE DASHED ENTRY CARD, and
      // only while that card exists. GA-33 retires it the moment a saas pairing
      // row appears (`connections_page.dart`: the card renders under
      // `!pairings.any(channel == 'saas')`), and the row reads ITS OWN stored
      // endpoint — which is not necessarily this one.
      //
      // Measured on the tablet, 2026-08-19 (0.3.9 handoff §7-2): a phone paired
      // to the cloud before the domain moved showed that row red and offline
      // while `reach.probe` reported the DEFAULT endpoint answering 28/28. Two
      // addresses, one of which nothing on screen was reading — a request every
      // 15 s whose answer had no reader, which is the mirror image of the
      // façade shape this repo hunts (a value nobody produces vs. an answer
      // nobody consumes).
      if (!_pairings.any((MobileSession p) => p.channel == 'saas'))
        normalizePairEndpoint(saasEndpoint),
    }..removeWhere((String e) => e.isEmpty);

    final List<Future<void>> jobs = <Future<void>>[];
    for (final String endpoint in targets) {
      if (!_probing.add(endpoint)) continue; // already being probed
      // 🔴 KEEP THE LAST ANSWER WHILE THE NEXT ONE IS IN FLIGHT. This line used
      // to be an unconditional `= InstanceReach.checking`, and once the list
      // grew a 15 s re-poll (2026-08-16) that turned into a permanent flicker:
      // every row dropped to 检测中("checking…") four times a minute and stayed
      // there for the length of a probe — **measured p50 1.14 s on the relay
      // path** (tablet TB335ZC, 2026-08-18), i.e. ~8 % of the time the page was
      // showing 「we are asking」 instead of the answer it already had.
      //
      // ⚠️ This is NOT the 「keep a stale online」 mistake `_presence`'s doc
      // bans, and the difference is which event clears it: a FAILED probe still
      // overwrites this the moment it lands (`_probeOne` writes every verdict,
      // never skips), so no answer outlives the round that disproved it. What is
      // preserved is only the interval between 「we started asking again」 and
      // 「the new answer arrived」 — during which the previous measurement, all
      // of 15 s old, is the best true thing we can say.
      _reach.putIfAbsent(endpoint, () => InstanceReach.checking);
      jobs.add(_probeOne(endpoint));
    }
    for (final MobileSession p in _pairings) {
      // owner 2026-08-01's exception: 「云端轻记录这个默认实例只需要能连接云端中继服务器
      // 就行。」("the default cloud light-record instance just needs to be able
      // to connect to the cloud relay server — that's enough.") ⇒ that row is
      // **never asked at all**. This is structural, not a comment that says
      // "ask it, then ignore the answer": that virtual PC row never enters a
      // room, a real probe would always come back false, and owner said it
      // should not be bound by this constraint.
      if (instanceTargetOf(p) != InstanceTarget.pc) continue;
      final String key = keyFor(p);
      // 🔴 Invalidate the previous answer for a row that CANNOT BE ASKED — and
      // only for that row.
      //
      // This used to be an unconditional `_presence.remove(key)` placed above
      // both `continue`s, and its comment gave the right reason for the wrong
      // scope: 「a row that was not re-measured this round must never keep last
      // round's `online` on screen」. The row that is ABOUT to be asked is not
      // that row. Wiping it too meant every PC row fell to
      // 「中继可达 · 电脑是否在线未知」("relay reachable · PC status unknown")
      // at the top of every 15 s tick and climbed back out when the answer
      // landed — up to 10.2 s later in the worst case
      // ([kInstanceListPresenceBudget]). That amber sentence is the one owner
      // reported on 2026-08-17, and it was manufactured here.
      //
      // ⚠️ Nothing stale survives a completed probe: `_probePresenceOne` writes
      // its result unconditionally, `unknown` included. The only value kept is
      // the one belonging to a question currently being re-asked.
      if (p.token.isEmpty || p.endpoint.isEmpty) {
        _presence.remove(key); // no credential to present ⇒ cannot be asked
        continue;
      }
      // Already in flight from an earlier tick ⇒ keep what we have; the probe
      // that is running owns this key and will overwrite it.
      if (!_presenceProbing.add(key)) continue;
      jobs.add(_probePresenceOne(p, key));
    }
    if (jobs.isEmpty) return;
    notifyListeners(); // paint 检测中("checking…") before the first answer lands
    await Future.wait(jobs);
  }

  // 🔴 RV-98's sole writer `_probePresenceOne` moved to
  // connections_presence.dart (same library) — see the part directive above.

  /// Consecutive rounds in which this endpoint produced NO ANSWER (a retryable
  /// miss, after the in-cycle retries were already spent).
  ///
  /// 🔴 Reset by any ANSWER, including an unwelcome one: a 502 and a captive
  /// portal are measurements, and a measurement never waits for a second
  /// opinion. This counter is about 「问不到」("could not get an answer"), never

  /// Identity of the pairing the user most recently entered (connect / add /
  /// cloud). Re-resolved against [_pairings] so a later [setAlias] + [load]
  /// refreshes the display label without touching session ack fields.
  String? _activePairingIdentity;

  /// The remembered PC the user is currently in (chat). Null before the first
  /// successful enter, or when that pairing was forgotten.
  MobileSession? get activePairing {
    final String? id = _activePairingIdentity;
    if (id == null) return null;
    for (final MobileSession p in _pairings) {
      try {
        if (p.connectionIdentity == id) return p;
      } on StateError {
        continue;
      }
    }
    return null;
  }

  /// v0.2.6 — is the pairing the user is currently IN the virtual light-record
  /// (云端轻记录) cloud instance, as opposed to a real PC?
  ///
  /// owner 2026-07-29:「云端中继和云端轻记录这两个实例是不一样的」("the cloud relay
  /// and the cloud light-record are two different instances"). They are, and
  /// nothing was asking this question — the chat header and the destination
  /// scope were both reading `DestinationController.isFixed`, which answers
  /// 「目的地开关锁没锁」("is the destination toggle locked or not"). That is a
  /// consequence of the answer, not the answer,
  /// and it survives across sessions: enter the light-record (云端轻记录)
  /// instance once, then pair a real PC
  /// by code, and the lock is still on — the header prints light-record
  /// (云端轻记录) and every
  /// utterance is delivered as record-only (仅记录) to a PC that was perfectly
  /// able to receive
  /// it.
  ///
  /// `channel == 'saas'` is the honest source: it is set at pairing time from
  /// `PairEntry.cloud` and means EXACTLY 「this peer is the virtual cloud
  /// instance」. (Distinct from 「reached over the cloud relay」, which is a
  /// transport question the /api/health probe answers — conflating those two was
  /// the v0.2.3 channel-chip bug, and this is the same pair of questions one
  /// layer down.)
  ///
  /// `false` when there is no active pairing: a PC is the safe default, because
  /// the failure mode of guessing 「仅记录」("record only") is silently not delivering.
  bool get activePairingIsCloudInstance => activePairing?.channel == 'saas';

  /// Local list/header label for [activePairing] via [pairingDisplayName]
  /// (alias → device name → fallback). Null when no active pairing — chat
  /// keeps using the session ack name.
  String? get activePairingDisplayName {
    final MobileSession? p = activePairing;
    if (p == null) return null;
    return pairingDisplayName(p);
  }

  void _rememberActive(MobileSession pairing) {
    try {
      _activePairingIdentity = pairing.connectionIdentity;
    } on StateError {
      _activePairingIdentity = null;
    }
  }

  /// Load the remembered pairings from token_storage (most-recent first).
  Future<void> load() async {
    _pairings = await session.tokenStorage.readPairings();
    _pruneStaleProbeKeys();
    _loading = false;
    notifyListeners();
  }

  /// Drop reach/channel cache entries for endpoints that are no longer listed.
  /// A forgotten pairing must not keep lending its last-known chip to a ghost.
  void _pruneStaleProbeKeys() {
    final Set<String> live = <String>{
      for (final MobileSession p in _pairings) normalizePairEndpoint(p.endpoint),
      normalizePairEndpoint(saasEndpoint),
    }..removeWhere((String e) => e.isEmpty);
    _reach.removeWhere((String k, InstanceReach _) => !live.contains(k));
    _channel.removeWhere((String k, ServerChannel _) => !live.contains(k));
    // Same rule for the hysteresis counter: a forgotten endpoint must not lend
    // its miss streak to an address re-added later, which would turn that new
    // row red on its FIRST unanswered round.
    _reachMisses.removeWhere((String k, int _) => !live.contains(k));
    // (the presence prune below drops the absence REASON with it, because the
    // two live in one map value — see [ConnectionsPresenceHost._presence])
    // RV-98 — same rule, PAIRING-keyed (see [_presence]): a forgotten pairing
    // must not leave a presence answer behind for a row key that could be minted
    // again by a re-pair to the same PC.
    final Set<String> liveRows = <String>{
      for (final MobileSession p in _pairings) keyFor(p),
    };
    _presence.removeWhere((String k, PcPresenceRow _) => !liveRows.contains(k));
  }

  /// Leave the room the user just backed out of (owner 2026-07-27).
  ///
  /// Stops the reconnect ladder FIRST, then drops the socket — in the other
  /// order the ladder immediately re-dials and the phone rejoins the room it was
  /// told to leave, which would leave the PC's capsule floating for a phone that
  /// is no longer in a session. The stored pairing is untouched: this ends the
  /// SESSION, not the pairing, so the list entry stays tappable.
  Future<void> leaveRoom() async {
    await _dropLink();
    session.paired.value = false;
    // V2-06a-1: drop the instance identity with the room. Keeping it would let
    // the next instance's utterances be stamped with this one's owner.
    session.clearConnectedInstance();
  }

  /// A2 (owner 2026-08-11, cloud logout must allow switching accounts) — the
  /// ONE cloud sign-out entry the devices page drives. It wraps — not replaces —
  /// [LoginController.logout], which stays the single account-clearing verb;
  /// this adds the two session-scope facts logout() cannot reach from where it
  /// lives (it holds only the transport + account store):
  ///
  ///  1. A live CLOUD session must not keep speaking as the account that just
  ///     signed out (R11: after 「退出」("sign out") nothing on this phone may still hold
  ///     that identity). If the active pairing is the cloud instance
  ///     (`channel == 'saas'`), the room/ladder/socket are torn down first via
  ///     [leaveRoom]. A standalone (LAN) active pairing is DELIBERATELY left
  ///     running — the owner ruling scopes this to the cloud account only.
  ///
  ///  2. The remembered cloud-instance pairing rows are PURGED from token
  ///     storage. Their `mobile_token` was minted by `admitCloudInstance(...)`
  ///     under the account that just signed out, and `resumePairing` dials by
  ///     token alone (no JWT on that handshake) — so a kept row would let this
  ///     phone, or the NEXT account on this phone, tap 「云端实例」("cloud instance") and re-enter
  ///     the OLD account's cloud session with no login at all. That is the
  ///     stale-identity leak this method exists to close.
  ///
  /// ⚠️ Scope is `channel == 'saas'` rows ONLY (today that marks exactly the
  /// cloud-instance solo session — see MobilePairPayload.cloudInstance).
  /// Standalone/LAN pairings answer to the PC's own pairing table, not to this
  /// phone's cloud account, and the ruling explicitly leaves them alone.
  ///
  /// ⚠️ DELIBERATELY NOT called from [LoginController.handleAuthExpired]: an
  /// EXPIRED credential is not a sign-out decision, and the desktop applies the
  /// same split (socket/pairing.rs — only a deliberate action or a dead token
  /// clears a pairing credential; a lapsed 7-day key keeps it).
  Future<void> signOutCloud() async {
    if (activePairing?.channel == 'saas') {
      await leaveRoom();
    }
    await login.logout();
    final List<MobileSession> remembered =
        await session.tokenStorage.readPairings();
    for (final MobileSession p in remembered) {
      if (p.channel == 'saas') {
        await session.tokenStorage.removePairing(p);
      }
    }
    await load();
  }

  /// Stop everything that could dial, THEN drop the socket. Every arm that ends
  /// a connection — [leaveRoom] and each failure arm below — goes through here.
  ///
  /// 49-2/49-3: leaving this screen stops the timer. Without this line, a phone
  /// that's locked out at the door keeps sending a `mobile:reconnect` once a
  /// minute behind a screen nobody is watching — traffic we generated ourselves.
  ///
  /// 🔴 F8② — and the SAME is true of a connect attempt that FAILED, which is
  /// why this stopped being three lines inside [leaveRoom]. By the time a
  /// refusal arrives the ladder is already live: `PttSession.resumePairing`
  /// calls `reconnect.start()` on the line directly above the
  /// `_emitMobileReconnect` whose ack refuses us. So `transport.disconnect()`
  /// on its own is not a teardown — it is a TRIGGER: it publishes
  /// `disconnected`, which is exactly the ladder's cue to climb
  /// (`reconnect.dart` `_onStatus` → `_scheduleReconnect`, 1→2→4→…→30 s), and
  /// the first rung that connects re-joins the room. Nothing on the instance
  /// list would ever say so — `connections_page.dart:121-131` toasts the error
  /// and stops; no one listens for `session.paired` turning true again — so the
  /// phone silently takes the PC back (capsule surfaces, a second phone gets
  /// `PC_BUSY`) minutes after its owner gave up and walked away.
  ///
  /// 🔴 THE ORDER IS PART OF THE FIX, and it is the order [leaveRoom] already
  /// had: stop the ladder BEFORE dropping the socket. In the other order the
  /// drop is observed by a ladder that is still listening.
  ///
  /// ⚠️ The two timers remain two timers. [PttSession.cancelHoldOutRetry]
  /// answers 「什么时候再问一次」("when to ask again") (any server-given budget)
  /// and the ladder answers
  /// 「链路断了谁去拨号」("who dials when the link drops"); they are stopped side
  /// by side here because ending an
  /// attempt ends both questions — NOT because they are one question. Keeping
  /// them separate is the whole point of `session/hold_out_retry.dart` (see its
  /// file header: conflating them is what 49-3 was).
  Future<void> _dropLink() async {
    session.cancelHoldOutRetry();
    await session.reconnect.stop();
    await session.transport.disconnect();
  }

  void clearError() {
    if (_lastError == null) return;
    _lastError = null;
    notifyListeners();
  }

  /// Tap a remembered PC → connect + mobile:reconnect by its stored token. On a
  /// refusal we reload the list (the flow may have purged the pairing) and
  /// surface **the server's own code**.
  ///
  /// 🔴 L-② (2026-08-02) — this doc used to read 「on a rejected/dead token the
  /// reconnect flow already purged the local session」 and the body below acted on
  /// it by hard-coding `'AUTH_TOKEN_INVALID'`. **Both halves were false.** Only an
  /// `AUTH_TOKEN_INVALID` reject purges (`mobile_reconnect_flow.dart:79`); a
  /// hold-out (`PAIR_RELEASED` — the PC pressed disconnect (断开) moments ago)
  /// keeps the token
  /// on purpose, and the fabricated code turned that into 「登录已失效，请重新配对」
  /// ("your login has expired, please re-pair")
  /// — telling the user to redo a pairing that is perfectly fine when the only
  /// useful action was to wait out a window the server had already measured for
  /// them. The server anticipated this by name: `mobile.handler.ts:214-215` says
  /// it emits `PAIR_RELEASED` precisely because the phone 「would DELETE the
  /// pairing on AUTH_TOKEN_INVALID」.
  ///
  /// ⇒ CLAUDE.md anti-façade ④ in its purest form: a comment that justified the
  /// line under it, and was itself the thing a reviewer had to check. It is
  /// rewritten rather than deleted so the next reader learns what it cost.
  Future<ConnectOutcome> connectTo(MobileSession pairing) async {
    if (_busy) return const ConnectOutcome.failed('BUSY');
    _busy = true;
    _connectingKey = keyFor(pairing);
    _lastError = null;
    notifyListeners();
    bool ok = false;
    try {
      ok = await session.resumePairing(pairing);
    } finally {
      _busy = false;
      _connectingKey = null;
    }
    if (!ok) {
      // Tear down any half-open socket so the list is a clean resting state —
      // and, since `resumePairing` armed the ladder before the ack that just
      // refused us, everything that would dial on its own. See [_dropLink].
      await _dropLink();
      // 🔴 L-② — the server's OWN answer, with the hold-out budget packed in
      // (`encodeHoldOut`). Read here, synchronously after the awaited call, which
      // is the only moment it is about THIS attempt.
      //
      // Null when we never got an ack (timeout / dead endpoint / empty token):
      // `pairError(null)` gives a generic, honest "failed — try again" sentence
      // (no fabricated cause, see its default arm) and that IS the honest answer
      // — 「我们没问到」("we didn't get an answer") must not borrow a sentence from
      // 「服务器说了 X」("the server said X").
      final ReconnectRefusal? refusal = session.lastReconnectRefusal;
      final String? code = refusal == null
          ? null
          : encodeHoldOut(refusal.code, refusal.retryAfterMs);
      _lastError = (code == null || code.isEmpty) ? null : code;
      await load(); // an AUTH_TOKEN_INVALID purge may have dropped this pairing
      return ConnectOutcome.failed(_lastError);
    }
    _rememberActive(pairing);
    await load(); // move-to-front refresh
    return const ConnectOutcome.ok();
  }

  /// Enter the cloud instance (WP-R4-2 ②): requires a logged-in account. Dials
  /// the SaaS endpoint carrying the JWT handshake and emits
  /// mobile:pair {cloud_instance:true}; the ack is persisted as a MobileSession
  /// with channel:'saas' (reusing the standard token_storage + reconnect chain).
  /// Fail-loud: not logged in → NOT_LOGGED_IN (the page drives to login first);
  /// an expired/invalid JWT clears the account and returns the honest code so
  /// the user is driven back to login (never a fake cloud session).
  Future<ConnectOutcome> enterCloud() async {
    if (_busy) return const ConnectOutcome.failed('BUSY');
    final String? jwt = login.jwt;
    if (jwt == null || jwt.isEmpty) {
      _lastError = 'NOT_LOGGED_IN';
      notifyListeners();
      return const ConnectOutcome.failed('NOT_LOGGED_IN');
    }

    _busy = true;
    _connectingKey = cloudEntryKey;
    _lastError = null;
    notifyListeners();
    PairResult result;
    try {
      result = await session.pair(
        PairEntry.cloud(endpoint: saasEndpoint),
        endpoint: saasEndpoint,
        jwt: jwt,
      );
    } finally {
      _busy = false;
      _connectingKey = null;
    }
    if (!result.ok) {
      // ⚠️ Unlike [connectTo], `PttSession.pair` starts the ladder only AFTER a
      // successful ack, so today there is usually nothing here to stop. It goes
      // through [_dropLink] anyway because 「一次失败的连接不留任何还在拨号的
      // 东西」("a failed connection attempt leaves nothing still dialing behind")
      // is a property of this arm, not of whichever caller armed what.
      await _dropLink();
      final String? err = result.error;
      // A stale/expired bearer: clear it and drive back to login (fail-loud).
      if (err == LoginErrorCodes.tokenExpired ||
          err == LoginErrorCodes.tokenInvalid) {
        login.handleAuthExpired(code: err!);
      }
      _lastError = err;
      notifyListeners();
      return ConnectOutcome.failed(err);
    }
    final MobileSession? saved = result.session;
    if (saved != null) _rememberActive(saved);
    onPaired?.call();
    await load();
    return const ConnectOutcome.ok();
  }

  /// Add a new pairing: dial [rawEndpoint] and mobile:pair with the 4-digit
  /// [code]. Fail-loud — a bad code / unreachable PC returns the server's error
  /// code, never a fabricated success. On success the ack is persisted by
  /// PttSession.pair (token_storage) and the list reloads.
  ///
  /// 0.2.66 — [pcid] is the relay's 9-digit address for the target PC, supplied
  /// by the manual sheet when the typed address is the relay (design §7). It is
  /// forwarded VERBATIM: this layer does not validate it and does not withhold
  /// the frame over it. Local validation belongs to the sheet (which knows
  /// whether it even showed the field) and the verdict belongs to the server —
  /// a second, quieter judge here is how a user on a self-hosted relay would
  /// get locked out by our own guess.
  Future<ConnectOutcome> addByCode({
    required String rawEndpoint,
    required String code,
    String? pcid,
  }) async {
    if (_busy) return const ConnectOutcome.failed('BUSY');
    final String endpoint = normalizePairEndpoint(rawEndpoint);
    final String trimmedCode = code.trim();

    PairEntry entry;
    try {
      // A pasted flowmic:// link carries its own endpoint; a bare 4-digit code
      // uses the typed address.
      entry = PairEntry.parse(trimmedCode, pcid: pcid);
    } on FormatException {
      _lastError = 'PAIR_INVALID_CODE';
      notifyListeners();
      return const ConnectOutcome.failed('PAIR_INVALID_CODE');
    }
    final String dial = entry.endpoint ?? endpoint;
    if (dial.isEmpty) {
      _lastError = 'NO_ENDPOINT';
      notifyListeners();
      return const ConnectOutcome.failed('NO_ENDPOINT');
    }

    _busy = true;
    _lastError = null;
    notifyListeners();
    PairResult result;
    try {
      result = await session.pair(entry, endpoint: dial);
    } finally {
      _busy = false;
    }
    if (!result.ok) {
      await _dropLink(); // same reason as [enterCloud]'s failure arm
      _lastError = result.error;
      notifyListeners();
      return ConnectOutcome.failed(result.error);
    }
    final MobileSession? saved = result.session;
    if (saved != null) _rememberActive(saved);
    onPaired?.call();
    await load();
    return const ConnectOutcome.ok();
  }

  /// Whether the LAST [remove] managed to tell the server. `false` means the
  /// entry is gone from this phone but the PC still lists it — a fact the page
  /// states rather than swallows.
  bool get lastRemoveReachedServer => _lastRemoveReachedServer;
  bool _lastRemoveReachedServer = true;

  /// Forget a remembered PC (swipe-to-delete).
  ///
  /// v0.2.3 — this now also RETIRES the pairing on the server (`mobile:unpair`).
  /// owner 2026-07-29: 「此前删除的连接实例没有真正删除」("previously, deleting a
  /// connection instance didn't really delete it"), and that was literally
  /// true — deleting here dropped the local token and nothing else, so the PC's
  /// device page kept listing phones the user believed they had removed. There
  /// was no verb in the protocol that could remove one.
  ///
  /// The local removal happens WHATEVER the server says. The user asked for this
  /// entry to go; refusing because a machine is unreachable would make a dead PC
  /// impossible to clean up. But an unreachable server means the row survives
  /// over there, and [lastRemoveReachedServer] carries that so the page can say
  /// so — 「没做成的事不许说成做成了」("you must never claim something succeeded
  /// when it didn't") applies to a deletion as much as a delivery.
  Future<void> remove(MobileSession pairing) async {
    _lastRemoveReachedServer = await _retireOnServer(pairing);
    await session.tokenStorage.removePairing(pairing);
    await load();
  }

  /// Best-effort `mobile:unpair` on [pairing]'s own endpoint, using ITS token —
  /// the server authorises by the socket's identity, so the row it deletes is
  /// exactly this one. Returns whether the server acknowledged.
  Future<bool> _retireOnServer(MobileSession pairing) async {
    if (pairing.endpoint.isEmpty || pairing.token.isEmpty) return false;
    try {
      return await session.retirePairing(pairing);
    } on Object {
      return false; // unreachable IS the answer; never a swallowed exception
    }
  }

  /// Set (or clear, when [alias] is null/blank) the local display alias for a
  /// remembered PC, then reload so the instance list reflects it immediately.
  /// [load] already [notifyListeners] — chat header listeners see the new label.
  Future<void> setAlias(MobileSession pairing, String? alias) async {
    await session.tokenStorage.setPairingAlias(pairing, alias);
    await load();
  }
}
