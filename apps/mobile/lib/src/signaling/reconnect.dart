// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (reconnect ladder 1→2→4→8→16→30 s;
//     5 s stability threshold before backoff resets; on the connected rising
//     edge that FOLLOWS a drop: re-emit mobile:reconnect once per span and,
//     once its ack lands, replay the 30 s ring buffer; AUTH_TOKEN_INVALID →
//     stop the storm)
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-04M (replay order)
//   packages/protocol/src/constants.ts AUDIO_DEFAULTS (backoff / grace)
//   13-LESSONS-LEARNED §2 (F-2130 flap guard, F-2124 rejoin-once)
//
// ReconnectCoordinator owns the connection-level reconnect policy. socket.io's
// built-in reconnect is disabled in SocketCore so the policy lives here in one
// explicit ladder. On a successful reconnect it re-joins the room and THEN
// replays the mobile ring buffer (via `bufferedChunksProvider`) so the server —
// whose audio session outlives the socket for a 30 s grace (GA-04) — resumes
// losslessly. Replaying before the rejoin ack (the pre-GA-04M order) fed a
// room-less socket, so every buffered frame was dropped server-side.
//
// Ported from legacy signaling/reconnect.dart. Replay uses AudioEmitter (the
// FlowMicEvents.audioChunk constant), never a literal event name.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../audio/audio_emitter.dart';
import 'http_endpoint.dart' show secureDialUrl;
import 'socket_core.dart';

typedef BufferedChunksProvider = List<Map<String, Object?>> Function();

/// Invoked once per reconnect span on the `connected` rising edge that FOLLOWS
/// a drop (never on the initial cold connect). The composition root supplies a
/// callback that re-emits `mobile:reconnect` with the stored token so the
/// server re-establishes roomUuid for this socket — without it the socket is
/// "connected-but-dead" (room-less) and audio is dropped server-side.
///
/// The returned future must complete only once that ack has round-tripped: the
/// ring-buffer replay is chained onto it (GA-04M).
typedef RejoinCallback = Future<void> Function();

/// Predicate deciding whether a given disconnected/error status warrants a
/// reconnect attempt. The composition root returns false on an
/// AUTH_TOKEN_INVALID handshake reject so a dead token does not trigger an
/// infinite reconnect storm. Defaults to always-reconnect.
typedef ReconnectPredicate = bool Function();

/// B4-15 — asked before each rung: 「这个地址还是最好的那个吗」("is this address
/// still the best one").
///
/// A PC with several NICs is reachable at different addresses from different
/// networks, and the ladder without this can only ever re-dial the ONE address
/// pairing happened to record — so a phone whose route changed re-tries a dead
/// host forever while the same PC answers next door.
///
/// Contract, and it is narrow on purpose:
///   · return `null` (or [current], or empty) ⇒ nothing changes, and that is the
///     default for every caller that does not supply one;
///   · a non-null answer REPLACES the ladder's url, so it must name the SAME
///     machine. The resolver owns that guarantee — see
///     `PttSession._resolveReconnectUrl`, which refuses unless [current] is one
///     of the pairing's own recorded candidates (never allow crosstalk — 绝不许串号).
typedef DialUrlResolver = Future<String?> Function(String current);

class ReconnectCoordinator {
  ReconnectCoordinator({
    required this.transport,
    required this.bufferedChunksProvider,
    this.initialBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    this.maxAttempts = 0,
    this.stableThreshold = const Duration(seconds: 5),
    ReconnectPredicate? shouldReconnect,
    RejoinCallback? onReconnected,
    this.dialUrlResolver,
    String? url,
    String? token,
    String? pinFingerprint,
  }) : _shouldReconnect = shouldReconnect ?? _alwaysReconnect,
       _onReconnected = onReconnected,
       _url = url,
       _token = token,
       _pin = pinFingerprint;

  static bool _alwaysReconnect() => true;

  final SocketTransport transport;
  final BufferedChunksProvider bufferedChunksProvider;
  final Duration initialBackoff;
  final Duration maxBackoff;
  final int maxAttempts;

  /// How long a `connected` edge must SURVIVE before the backoff counter is
  /// reset to 0. A flapping link never clears this window, so its `_attempt`
  /// keeps climbing toward [maxBackoff] instead of snapping back to the 1 s
  /// rung — the mobile stops storming reconnects.
  final Duration stableThreshold;

  final ReconnectPredicate _shouldReconnect;
  final RejoinCallback? _onReconnected;

  /// B4-15 — optional per-rung address chooser. `null` (the default, and what
  /// every existing harness constructs) means the ladder re-dials [url] exactly
  /// as it always has.
  final DialUrlResolver? dialUrlResolver;

  String? _url;
  String? _token;

  /// D2LAN-B3 — this pairing's pinned SPKI fingerprint, or null when the pairing
  /// is not pinned (every relay pairing, every pre-D2-LAN row, every sidecar
  /// serving plain).
  ///
  /// 🔴 WHY THE LADDER NEEDS ITS OWN COPY, and what it cost not to have one.
  /// `pair()` / `resumePairing()` each dial ONCE, with the pin, and then hand the
  /// address to this class — which re-dialled it for the rest of the session with
  /// no pin at all. On a pinned pairing that is not 「稍微弱一点」("a little bit
  /// weaker"), it is a dial
  /// that CANNOT SUCCEED: without a pin `SocketCore.connect` installs no
  /// `webSocketConnector`, socket_io_client falls through to
  /// `io.WebSocket.connect` with no `customClient`, and the self-signed sidecar
  /// certificate is rejected by the system trust store — `HandshakeException`,
  /// every rung, forever. The user's only way back was to re-tap the PC by hand
  /// (`resumePairing`, which does pass it).
  ///
  /// ⚠️ It is a SEPARATE field from [_token] and not derived from it: the token
  /// says 「我是谁」("who I am") and the pin says 「你是谁」("who you are").
  /// Clearing one must not clear the
  /// other, which is why [configure] carries `replacePin` alongside
  /// `replaceToken` instead of one flag for both.
  String? _pin;
  StreamSubscription<SocketStatus>? _sub;
  Timer? _timer;
  Timer? _stableTimer;

  int _attempt = 0;
  bool _running = false;
  bool _rejoinInFlight = false;
  bool _droppedSinceConnect = false;

  /// Previous published status, so a `connecting` edge can be read for what it
  /// is: coming down from `connected` means our socket was REPLACED, while
  /// coming up from `disconnected` is just an ordinary dial. See [_onStatus].
  SocketStatus? _lastSeen;

  /// Replay log for tests: each entry is the chunk payload re-emitted.
  final List<Map<String, Object?>> replayed = [];

  /// True while the coordinator is actively trying to bring the connection back
  /// (a reconnect attempt is pending or in flight). The network-status
  /// indicator reads this for the yellow "reconnecting" state.
  final ValueNotifier<bool> reconnecting = ValueNotifier<bool>(false);

  int get attempts => _attempt;
  bool get isRunning => _running;
  String? get token => _token;
  String? get url => _url;

  /// D2LAN-B3 — `replacePin` is the same 「null 是一个答案」("null is itself an
  /// answer") discipline `replaceToken` already carries, and it is load-bearing
  /// in the UNPINNED direction: a session that pairs a LAN PC (pinned) and then
  /// a relay instance (never pinned) must LOSE the pin, or the ladder would
  /// re-dial the relay holding the previous PC's key — the exact
  /// 「上一台机器的钥匙拿来对这一台」("using the previous machine's key against
  /// this one") failure `clearConnectedInstance` clears `_lanPin` to avoid.
  void configure({
    String? url,
    String? token,
    bool replaceToken = false,
    String? pinFingerprint,
    bool replacePin = false,
  }) {
    if (url != null) _url = url;
    if (replaceToken || token != null) _token = token;
    if (replacePin || pinFingerprint != null) _pin = pinFingerprint;
  }

  void start() {
    if (_running) return;
    _running = true;
    _attempt = 0;
    _droppedSinceConnect = false;
    // Seed from the transport instead of `null`: we very often attach to a link
    // that is ALREADY up. `PttSession.resumePairing` connects first and starts
    // the coordinator second, so a `null` seed makes the first edge we observe
    // unreadable — and the one that matters most (connected → connecting, i.e.
    // 「我们的 socket 被换掉了」("our socket got swapped out")) would be mistaken
    // for an ordinary cold dial,
    // leaving the new socket connected-but-room-less. Asking the transport what
    // it is doing right now costs nothing and is never a guess.
    _lastSeen = transport.currentStatus;
    _sub = transport.status.listen(_onStatus);
  }

  Future<void> stop() async {
    _running = false;
    _timer?.cancel();
    _timer = null;
    _stableTimer?.cancel();
    _stableTimer = null;
    reconnecting.value = false;
    final StreamSubscription<SocketStatus>? subscription = _sub;
    _sub = null;
    await subscription?.cancel();
  }

  /// Fire the rejoin callback at most once per in-flight span, THEN replay the
  /// ring buffer. If a rapid flap re-enters before the prior re-join future
  /// resolves, skip — otherwise stacked callbacks emit `mobile:reconnect`
  /// repeatedly while a single ack is still pending.
  ///
  /// GA-04M — the ORDER is the whole point. The server only (re)establishes this
  /// socket's auth + roomUuid inside its `mobile:reconnect` handler, so buffered
  /// chunks emitted before that ack land on a room-less socket and are dropped
  /// server-side without a trace. The rejoin future completes when the ack has
  /// round-tripped (mobile_reconnect_flow awaits it with a 5 s timeout), so
  /// replaying in its continuation is the earliest moment a chunk has a host.
  /// A rejected rejoin does not throw — it completes false — so the ladder's
  /// next rung retries; the ring buffer holds 30 s and nothing is discarded.
  void _fireRejoin() {
    final RejoinCallback? rejoin = _onReconnected;
    if (rejoin == null) {
      // No rejoin configured (the socket never left a room, or a unit harness):
      // there is no ack to wait for, so the ordering constraint is vacuous.
      _replayBuffered();
      return;
    }
    if (_rejoinInFlight) return;
    _rejoinInFlight = true;
    unawaited(
      rejoin()
          .then((_) => _replayBuffered())
          .catchError((Object _) {})
          .whenComplete(() => _rejoinInFlight = false),
    );
  }

  void _onStatus(SocketStatus s) {
    if (!_running) return;
    final SocketStatus? prev = _lastSeen;
    _lastSeen = s;
    if (s == SocketStatus.connecting || s == SocketStatus.reconnecting) {
      // 🔴 2026-08-03 (F-5, capsule flicker / 胶囊闪动) — 「有人正在把链路拉
      // 起来」("someone is in the process of bringing the link back up"), this
      // is NOT a disconnect.
      // Two facts follow from a connected → connecting edge, and only one of them
      // used to be acted on correctly:
      //   · the old socket is gone, so the NEXT connected edge lands on a
      //     room-less socket and must re-join (the server only (re)sets roomUuid
      //     inside its mobile:reconnect handler) ⇒ arm _droppedSinceConnect;
      //   · a dial is ALREADY in flight ⇒ scheduling a rung here would make the
      //     ladder chase its own tail. That is precisely what it did: see the
      //     comment atop SocketCore.connect().
      if (prev == SocketStatus.connected) {
        _droppedSinceConnect = true;
        _stableTimer?.cancel();
        _stableTimer = null;
      }
      return;
    }
    if (s == SocketStatus.connected) {
      // Do NOT reset the backoff counter on the raw `connected` edge — a
      // flapping link that connects then instantly re-drops would otherwise
      // keep snapping back to the 1 s rung and storm reconnects. Defer the
      // reset behind a stability window.
      _stableTimer?.cancel();
      _stableTimer = null;
      if (_attempt > 0) {
        _stableTimer = Timer(stableThreshold, () {
          _stableTimer = null;
          _attempt = 0;
        });
      }
      reconnecting.value = false;
      // The server only (re)sets roomUuid inside its mobile:reconnect/pair
      // handlers — never in the handshake middleware. So on a reconnect rising
      // edge (one that follows a drop, not the cold connect) we must re-join
      // the room or the socket is connected-but-dead. Fire once per span; the
      // ring-buffer replay runs INSIDE that callback, after the ack (GA-04M).
      // A cold connect replays nothing: there is no server session to resume,
      // and re-pushing a stale buffer into a brand-new pairing would be a lie.
      if (_droppedSinceConnect) {
        _droppedSinceConnect = false;
        _fireRejoin();
      }
      return;
    }
    if (s == SocketStatus.disconnected || s == SocketStatus.error) {
      _stableTimer?.cancel();
      _stableTimer = null;
      _droppedSinceConnect = true;
      // A dead-token handshake reject (AUTH_TOKEN_INVALID) must NOT trigger
      // auto-reconnect — that path is owned by the explicit re-pair flow.
      if (!_shouldReconnect()) {
        _running = false;
        reconnecting.value = false;
        return;
      }
      _scheduleReconnect();
    }
  }

  Duration _backoffFor(int attempt) {
    // attempt is 1-based for the user-visible ladder.
    final ms = initialBackoff.inMilliseconds * (1 << (attempt - 1));
    final capped = ms > maxBackoff.inMilliseconds
        ? maxBackoff.inMilliseconds
        : ms;
    return Duration(milliseconds: capped);
  }

  void _scheduleReconnect() {
    if (_timer != null) return; // already pending
    if (_url == null) return; // nothing to reconnect to
    if (maxAttempts != 0 && _attempt >= maxAttempts) {
      _running = false;
      return;
    }
    _attempt += 1;
    reconnecting.value = true;
    final delay = _backoffFor(_attempt);
    debugPrint(
      '[flowmic.reconnect] schedule attempt=$_attempt delay=${delay.inMilliseconds}ms url=$_url',
    );
    _timer = Timer(delay, () {
      _timer = null;
      if (!_running) return;
      // B4-15: re-read `_url` rather than closing over it — `configure` may have
      // moved it while the backoff timer was pending.
      final String? target = _url;
      if (target == null || target.isEmpty) return;
      final DialUrlResolver? resolve = dialUrlResolver;
      // 🔴 NO RESOLVER ⇒ NOT ONE MICROTASK OF DIFFERENCE. Every existing harness
      // constructs this class without one and several assert on `connectCalls`
      // immediately after elapsing the backoff; putting an `await` in front of
      // the dial for them would be a timing change dressed as a feature.
      if (resolve == null) {
        _dial(target);
        return;
      }
      unawaited(_resolveThenDial(resolve, target));
    });
  }

  void _dial(String url) {
    final String? pin = _pin;
    // D2LAN-B3 — a pinned pairing dials under the key it pinned, on every rung,
    // exactly as `pair()` / `resumePairing()` do for their one dial.
    //
    // 🔴 THE UPGRADE IS A BELT, NOT A DECISION. Every address that can reach this
    // line on a pinned pairing is already `wss://`: `pairDialCandidates(pinned:
    // true)` upgrades the head and `expandCandidates` makes every alternate
    // inherit the scheme, and `resolveLadderUrl` may only ever return a member of
    // that same list. It is applied anyway because the failure direction without
    // it is the worst one available: `SocketCore.connect` REFUSES a pin on a
    // plain URL (correctly — 「a pin on a plain URL can never be checked」), the
    // refusal is thrown before any status is published, and `catchError` below
    // would swallow it — leaving the ladder armed, running, and never dialling
    // again. A wedged ladder is silent; a wrong scheme here is not.
    // `secureDialUrl` is a pass-through for an already-secure url, so on every
    // path that exists today this is byte-for-byte the old dial.
    final String target = pin == null ? url : secureDialUrl(url);
    unawaited(
      transport
          .connect(url: target, token: _token, pinFingerprint: pin)
          .catchError((Object _) {
            // connect() publishes SocketStatus.error which re-enters _onStatus
            // and schedules the next rung of the ladder.
          }),
    );
  }

  /// Ask [resolve] which address this rung should use, ADOPT the answer as the
  /// ladder's url (so the next rung — and everyone reading [url], e.g. the
  /// channel probe on the reconnected edge — is talking about the address
  /// actually dialled), then dial.
  Future<void> _resolveThenDial(DialUrlResolver resolve, String current) async {
    String dial = current;
    try {
      final String? next = await resolve(current);
      if (next != null && next.isNotEmpty && next != current) {
        _url = next;
        dial = next;
        debugPrint('[flowmic.reconnect] dial url moved $current → $next');
      }
    } on Object {
      // A resolver that throws must not stop the ladder: falling back to the
      // address we already had is exactly the pre-B4-15 behaviour.
    }
    if (!_running) return; // the resolver awaited; a stop() may have landed
    _dial(dial);
  }

  /// Re-emit the 30 s ring buffer as `audio:chunk` frames. GA-04M: no
  /// `audio:start` is re-sent — the server session survived the drop inside its
  /// grace window (06 §2 resumeFromGrace), so a second start would dispose the
  /// very session these chunks belong to and lose everything said before the
  /// drop. seq stays monotonic, so the server's SeqTracker de-dupes.
  void _replayBuffered() {
    final chunks = bufferedChunksProvider();
    for (final c in chunks) {
      try {
        AudioEmitter.emitReplayChunk(transport, c);
        replayed.add(c);
      } catch (_) {
        // Wire dropped mid-replay: leave the rest for the next reconnect — the
        // ring buffer holds 30 s.
        return;
      }
    }
  }
}
