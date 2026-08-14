// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §1-2 (transport / handshake / schema_ver)
//   docs/rebuild/08-MOBILE-SPEC.md §4 (socket_io_client: websocket-only,
//     autoConnect:false, reconnection:false self-managed, forceNew:true,
//     auth {schema_ver, token}; 12 s handshake completer)
//   13-LESSONS-LEARNED §2 N4 (ws-only can silently hang → 12 s timeout),
//     §3 D3 (event whitelist is generated, not a hand list)
//
// SocketCore wraps a socket.io client lifecycle behind a narrow
// [SocketTransport] interface so the state machine / reconnect coordinator are
// decoupled from `socket_io_client`, and tests inject a fake adapter that
// drives events deterministically without a real socket.
//
// Ported from legacy signaling/socket_core.dart. The event whitelist check and
// the handshake schema_ver now come from the GENERATED protocol surface
// (FlowMicEvents / FlowMicProtocol) — no hand-mirrored list or integer.

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:meta/meta.dart';
import 'package:socket_io_client/socket_io_client.dart' as sio;

import '../../generated/flowmic_events.g.dart';
import '../../generated/flowmic_protocol.g.dart';
import '../diag/diag_log.dart';
import 'album_away.dart';
import 'http_endpoint.dart' show isSecureEndpoint;
import 'lan_pinning.dart';

enum SocketStatus { disconnected, connecting, connected, reconnecting, error }

@immutable
class EventEnvelope {
  final String name;
  final Object? data;
  const EventEnvelope(this.name, this.data);
  @override
  String toString() => 'EventEnvelope($name, $data)';
}

/// Narrow surface SocketCore needs from any underlying socket adapter. The
/// production adapter wraps `socket_io_client.Socket`; tests inject a fake.
abstract class SocketAdapter {
  void connect();
  void disconnect();
  void onConnect(void Function() cb);
  void onDisconnect(void Function(dynamic reason) cb);
  void onConnectError(void Function(dynamic err) cb);
  void onReconnectAttempt(void Function(int attempt) cb);
  void onReconnect(void Function(int attempt) cb);
  void onAny(void Function(String event, List<dynamic> args) cb);
  void emit(String event, Object? data);
  void emitWithAck(String event, Object? data, void Function(dynamic resp) ack);
  void dispose();
}

/// D2LAN-B3 — what the LAST dial's transport actually turned out to be.
///
/// 🔴 IT IS A MEASUREMENT, NOT A SETTING. The sidecar's one port answers plain
/// AND TLS (apps/server-core/src/lan-tls/dual-listener.ts), so 「服务器开了
/// TLS」("the server has TLS enabled") is true of the server and says nothing about this connection; that file
/// names `req.socket.encrypted` — the connection's own property — as the only
/// honest answer on its side. [pinnedTls] here is written from inside the TLS
/// callback of the socket we are holding, which is the same fact read from the
/// other end of the same TCP connection.
enum LinkEncryption {
  /// Nothing has been dialled, or the dial died before we learned anything.
  /// Renders as NOTHING — never as 「未加密」("unencrypted"), which would be a claim.
  unknown,

  /// The dial URL was not a TLS one, so no handshake happened.
  plain,

  /// A certificate was presented and matched this pairing's pin.
  pinnedTls,
}

abstract class SocketTransport {
  Stream<SocketStatus> get status;
  SocketStatus get currentStatus;
  Stream<EventEnvelope> get incoming;

  /// D2LAN-B3 — see [LinkEncryption]. Default `unknown` so a transport that
  /// cannot observe a handshake (every test double) says nothing rather than
  /// answering for one.
  LinkEncryption get lastLinkEncryption => LinkEncryption.unknown;

  /// D2LAN-B3 — did the last dial fail because the peer's public key was not the
  /// pinned one? Read RIGHT AFTER an awaited [connect] threw, like
  /// [lastConnectError]: it is the part of the failure that a `SocketException`
  /// and a `HandshakeException` cannot be told apart by, and reporting them alike
  /// is the silent degradation design §3-5 named.
  bool get lastDialPinMismatch => false;

  /// Last connect_error message from socket.io. When the handshake fails
  /// (e.g. AUTH_TOKEN_INVALID from auth middleware), reconnect flows read this
  /// to distinguish a token reject from a transient timeout.
  String? get lastConnectError => null;

  /// Open the socket.io handshake. [token] is the mobile pairing/reconnect token
  /// (auth.token); [jwt] is the SaaS account bearer (auth.jwt) used to admit a
  /// cloud instance — the two are distinct handshake fields and never aliased.
  ///
  /// [pinFingerprint] (D2LAN-B3) is this pairing's pinned SPKI fingerprint.
  /// Supplying it REQUIRES [url] to be a TLS one — see [SocketCore.connect] for
  /// why that is a refusal rather than a silent upgrade or a silent drop.
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  });
  Future<void> disconnect();
  void emit(String event, Object? payload);
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  });
}

/// Default factory: builds a real socket wrapped in [_RealSocketAdapter].
/// Tests override to return a fake.
typedef SocketAdapterFactory =
    SocketAdapter Function(String url, Map<String, dynamic> options);

SocketAdapter _defaultFactory(String url, Map<String, dynamic> options) {
  final s = sio.io(url, options);
  return _RealSocketAdapter(s);
}

/// Thrown when the socket.io handshake fails (connect_error, or a disconnect
/// during the connecting window). Surfaces a typed error so callers can
/// distinguish handshake failure from a later runtime disconnect.
class SocketHandshakeException implements Exception {
  SocketHandshakeException(this.message);
  final String message;
  @override
  String toString() => 'SocketHandshakeException: $message';
}

class SocketCore implements SocketTransport {
  SocketCore({SocketAdapterFactory? adapterFactory})
    : _factory = adapterFactory ?? _defaultFactory;

  final SocketAdapterFactory _factory;
  SocketAdapter? _adapter;

  // sync: true so transitions and incoming events are observable immediately by
  // tests + state-machine wiring (no microtask gap).
  final _statusCtl = StreamController<SocketStatus>.broadcast(sync: true);
  final _eventCtl = StreamController<EventEnvelope>.broadcast(sync: true);

  SocketStatus _status = SocketStatus.disconnected;
  String? _lastConnectError;
  LinkEncryption _linkEncryption = LinkEncryption.unknown;
  bool _lastDialPinMismatch = false;

  @override
  LinkEncryption get lastLinkEncryption => _linkEncryption;

  @override
  bool get lastDialPinMismatch => _lastDialPinMismatch;

  @override
  SocketStatus get currentStatus => _status;

  @override
  String? get lastConnectError => _lastConnectError;

  @override
  Stream<SocketStatus> get status => _statusCtl.stream;

  @override
  Stream<EventEnvelope> get incoming => _eventCtl.stream;

  void _setStatus(SocketStatus s) {
    if (_status == s) return;
    _status = s;
    _statusCtl.add(s);
  }

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    // Already connected/connecting: tear down and reconnect cleanly.
    // _teardown() is a no-op when there is no live adapter.
    //
    // 🔴 `superseded: true` IS THE WHOLE POINT (2026-08-03, capsule flicker F-5).
    // Publishing `disconnected` here made this teardown indistinguishable from a
    // real link loss, and ReconnectCoordinator reads exactly that signal to decide
    // 「没人在拉链路，我得拨号」("nobody is holding the link up, I need to
    // dial") — so every dial announced a drop, which armed the
    // next rung, whose dial announced another drop. 1→2→4→8 s, then the 5 s
    // stability window reset the counter and it started over, forever. Real-device
    // 2026-08-03: 72 join/leave cycles, the PC capsule surfacing and retreating
    // with each one. One value was answering two questions
    // (「链路没了」("the link is gone") vs 「我们正在换一个 socket」("we're
    // swapping in a new socket")), this repo's #1 bug shape.
    // 🔴 D2LAN-B3 — A PIN THAT CANNOT BE ENFORCED IS A REFUSAL, NOT A WARNING.
    //
    // The two tempting alternatives are both worse than throwing. Silently
    // dialling plain would leave a session that BELIEVES it is pinned talking in
    // the clear, and the diagnostics badge would say 「已加密 · 已验证」
    // ("encrypted · verified") about a
    // connection anybody can read — a status word with no fact behind it (R11).
    // Silently upgrading the URL here would move the decision away from the one
    // place that owns it (`pairDialCandidates` / the stored endpoint) and give
    // 「拨哪个地址」("which address to dial") a second author. Reaching this line at all is a wiring bug,
    // and it should die on the developer's machine.
    if (pinFingerprint != null && !isSecureEndpoint(url)) {
      throw SocketHandshakeException(
        'refusing to dial $url with a pinned key: a pin on a plain URL '
        'can never be checked',
      );
    }
    await _teardown(superseded: true);
    _lastConnectError = null;
    _lastDialPinMismatch = false;
    // Not `unknown`: we have already decided what this dial is. A secure URL
    // moves to `pinnedTls` only when the connector says a certificate matched.
    _linkEncryption = isSecureEndpoint(url)
        ? LinkEncryption.unknown
        : LinkEncryption.plain;
    // schema_ver always present; token only when we have one (register/pair
    // flows connect before a token exists); jwt only when admitting a cloud
    // instance (SaaS account bearer — a bad/expired jwt does NOT reject the
    // handshake, it leaves the socket unauthenticated so an identity op fails
    // loud: AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED).
    final auth = <String, dynamic>{'schema_ver': FlowMicProtocol.schemaVersion};
    if (token != null) auth['token'] = token;
    if (jwt != null) auth['jwt'] = jwt;
    final opts = <String, dynamic>{
      'transports': ['websocket'],
      'autoConnect': false,
      'reconnection': false, // ReconnectCoordinator owns reconnect policy.
      // forceNew: socket_io_client caches a Manager per scheme://host:port; a
      // rapid reconnect reused a half-closed Manager and the new handshake
      // neither connected nor errored → connect() hung forever. forceNew
      // guarantees a clean engine every connect.
      'forceNew': true,
      'auth': auth,
      // D2LAN-B3 — the pinning seam, installed ONLY on a pinned secure dial.
      //
      // ⚠️ THE CONDITION IS LOAD-BEARING TWICE. Without it every test's fake
      // adapter would be handed a connector it has no use for (the `_factory`
      // seam is what the whole suite drives), and a `ws://` dial would carry a
      // pin nothing can check. With it, an unpinned dial builds byte-for-byte
      // the options map this file has always built.
      //
      // `setWebSocketConnector`'s option key, spelled out rather than built
      // through `OptionBuilder`: this file passes a raw Map (it always has), and
      // the builder would have to re-state every key above.
      // ⚠️ NOT `httpClientAdapter` — deprecated in socket_io_client 3.1.6 and
      // removed in 4.0.0.
      if (pinFingerprint != null)
        'webSocketConnector': pinnedWebSocketConnector(
          pin: pinFingerprint,
          onOutcome: (LanPinOutcome outcome, String? observed) {
            _lastDialPinMismatch = outcome == LanPinOutcome.mismatched;
            if (outcome == LanPinOutcome.verified) {
              _linkEncryption = LinkEncryption.pinnedTls;
            }
            diag('lan.pin', <String, Object?>{
              'outcome': outcome.name,
              // The pin itself is NOT logged: it is public, but printing both
              // sides invites someone to "fix" a mismatch by copying the
              // observed value over the stored one, which is the attack.
              'observed_matches': outcome == LanPinOutcome.verified,
            });
          },
        ),
    };
    final adapter = _factory(url, opts);
    _adapter = adapter;
    // connect() AWAITS the real socket.io handshake instead of returning
    // fire-and-forget. Resolves on `connected`, rejects on `error`/`disconnect`
    // during the connecting window.
    final Completer<void> handshake = Completer<void>();
    void resolveIfOpen(void Function() fn) {
      if (_adapter == adapter && !handshake.isCompleted) fn();
    }

    adapter.onConnect(() {
      debugPrint('[flowmic.socket] connect url=$url');
      resolveIfOpen(() {
        _setStatus(SocketStatus.connected);
        handshake.complete();
      });
    });
    adapter.onDisconnect((reason) {
      debugPrint('[flowmic.socket] disconnect reason=$reason status=$_status');
      if (_adapter != adapter) return; // stale-adapter guard
      // RV-60: two disconnects that look the same on the wire must NOT look the
      // same in the trail. `kind` is the discriminant — album window open ⇒
      // expected (EMUI killed idle TCP while the picker held the foreground);
      // otherwise unexpected. Collapsing them is this repo's #1 bug shape.
      final bool expected = AlbumAway.instance.isOpen;
      diag('socket.drop', <String, Object?>{
        'kind': expected ? 'expected_album_away' : 'unexpected',
        'io_reason': reason?.toString() ?? 'null',
        'status_was': _status.name,
      });
      if (_status != SocketStatus.disconnected) {
        _setStatus(SocketStatus.disconnected);
      }
      resolveIfOpen(() {
        handshake.completeError(
          SocketHandshakeException('disconnect during handshake: $reason'),
        );
      });
    });
    adapter.onConnectError((err) {
      debugPrint('[flowmic.socket] connect_error err=${err?.toString()}');
      if (_adapter != adapter) return; // stale-adapter guard
      _lastConnectError = err?.toString();
      _setStatus(SocketStatus.error);
      resolveIfOpen(() {
        handshake.completeError(
          SocketHandshakeException(err?.toString() ?? 'connect_error'),
        );
      });
    });
    adapter.onReconnectAttempt((_) {
      debugPrint('[flowmic.socket] reconnect_attempt');
      if (_adapter != adapter) return;
      _setStatus(SocketStatus.reconnecting);
    });
    adapter.onReconnect((_) {
      debugPrint('[flowmic.socket] reconnect ok');
      if (_adapter != adapter) return;
      _setStatus(SocketStatus.connected);
    });
    adapter.onAny((evt, args) {
      if (_adapter != adapter) return; // Ignore events from a replaced socket.
      final data = args.isEmpty ? null : args.first;
      _eventCtl.add(EventEnvelope(evt, data));
    });
    _setStatus(SocketStatus.connecting);
    adapter.connect();
    // Bound the wait — if neither connect nor error fires (a wedged engine),
    // reject after 12 s instead of hanging forever (which would latch the
    // caller's _connecting guard and silence all subsequent taps).
    await handshake.future.timeout(
      const Duration(seconds: 12),
      onTimeout: () => throw SocketHandshakeException('handshake timed out'),
    );
  }

  @override
  Future<void> disconnect() => _teardown(superseded: false);

  /// Drop the live adapter. [superseded] says WHICH of the two facts this is,
  /// and they are not the same fact:
  ///
  ///   · `false` — the caller wants the link DOWN. Publish `disconnected`: the
  ///     reconnect ladder must hear it, because nobody else is going to dial.
  ///   · `true` — [connect] is replacing this adapter with a fresh one right now.
  ///     Publish `connecting` instead. Everyone who only asks 「连上了吗」("is it connected") still
  ///     reads false, but the ladder learns the thing it actually needs to know:
  ///     **a dial is already in flight, do not start a second one.**
  ///
  /// ⚠️ `connecting` is published rather than nothing at all so no observer can
  /// ever see `currentStatus == connected` while `_adapter` is null — that window
  /// would let [compose_gate] green-light a send into a socket that no longer
  /// exists. [connect] re-publishes `connecting` a few lines later; `_setStatus`
  /// de-dupes it.
  Future<void> _teardown({required bool superseded}) async {
    final a = _adapter;
    _adapter = null;
    if (a == null) return;
    a.disconnect();
    a.dispose();
    _setStatus(
      superseded ? SocketStatus.connecting : SocketStatus.disconnected,
    );
  }

  void _assertKnown(String event) {
    if (!FlowMicEvents.isKnown(event)) {
      throw ArgumentError.value(
        event,
        'event',
        'unknown protocol event (must appear in packages/protocol/src/events.ts)',
      );
    }
  }

  @override
  void emit(String event, Object? payload) {
    _assertKnown(event);
    final a = _adapter;
    if (a == null) {
      throw StateError('SocketCore.emit($event) before connect()');
    }
    a.emit(event, payload);
  }

  @override
  Future<R> emitWithAck<R>(
    String event,
    Object? payload, {
    Duration timeout = const Duration(seconds: 3),
  }) {
    _assertKnown(event);
    final a = _adapter;
    if (a == null) {
      return Future.error(
        StateError('SocketCore.emitWithAck($event) before connect()'),
      );
    }
    final completer = Completer<R>();
    Timer? timer;
    timer = Timer(timeout, () {
      if (!completer.isCompleted) {
        completer.completeError(TimeoutException('ack timeout for $event'));
      }
    });
    a.emitWithAck(event, payload, (resp) {
      timer?.cancel();
      if (!completer.isCompleted) {
        completer.complete(resp as R);
      }
    });
    return completer.future;
  }

  Future<void> close() async {
    await disconnect();
    await _statusCtl.close();
    await _eventCtl.close();
  }
}

/// Adapter wrapping the real `socket_io_client.Socket`. Kept tiny — all
/// reconnect / state policy lives in SocketCore + ReconnectCoordinator.
class _RealSocketAdapter implements SocketAdapter {
  _RealSocketAdapter(this._s);
  final sio.Socket _s;

  @override
  void connect() => _s.connect();

  @override
  void disconnect() => _s.disconnect();

  @override
  void dispose() => _s.dispose();

  @override
  void onConnect(void Function() cb) {
    _s.onConnect((_) => cb());
  }

  @override
  void onDisconnect(void Function(dynamic) cb) {
    _s.onDisconnect((reason) => cb(reason));
  }

  @override
  void onConnectError(void Function(dynamic) cb) {
    _s.onConnectError((err) => cb(err));
  }

  @override
  void onReconnectAttempt(void Function(int) cb) {
    _s.io.on('reconnect_attempt', (n) => cb(n is int ? n : 0));
  }

  @override
  void onReconnect(void Function(int) cb) {
    _s.io.on('reconnect', (n) => cb(n is int ? n : 0));
  }

  @override
  void onAny(void Function(String, List<dynamic>) cb) {
    _s.onAny((evt, data) {
      final args = data is List ? data : [data];
      cb(evt, args);
    });
  }

  @override
  void emit(String event, Object? data) => _s.emit(event, data);

  @override
  void emitWithAck(String event, Object? data, void Function(dynamic) ack) {
    _s.emitWithAck(event, data, ack: ack);
  }
}
