// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (reconnect ladder 1→2→4→8→16→30 s)
//   signaling/reconnect.dart ([ReconnectCoordinator.kickNow] — the only consumer)
//
// 🔴 THE HOLE THIS CLOSES (owner, 2026-08-18: 「断完之后，然后需要退出之后再进来
// 才能连接起来」 / "after it drops you have to back out and come in again before
// it will connect").
//
// The ladder is a pure TIMER. It notices a drop, then waits out 1→2→4→8→16→30 s,
// and **nothing in this app has ever told it that the world changed**. Leave a
// lift, come off a bad Wi-Fi onto cellular, turn airplane mode off — the phone
// knows within milliseconds and the ladder finds out up to 30 seconds later. Add
// the drop-detection window in front of it (socket.io's `pingInterval` 10 s +
// `pingTimeout` 20 s) and the worst case before the first automatic dial is
// about a minute. Backing out to the instance list and tapping the row dials
// immediately — which is exactly why that became the user's recovery ritual.
//
// ⚠️ **WHAT THIS CAN AND CANNOT ANSWER, and the difference is the whole design.**
// The platform answers 「这台手机挂着一个网络接口吗」 ("does this phone have a
// network interface attached"). It does **not** answer 「够得着我们吗」 ("can it
// reach us") — a captive portal, a Wi-Fi with no upstream and a working LTE link
// are the same value here. So this port is a **HINT TO TRY NOW**, never a claim
// that the link is up, and the only thing it is allowed to do is move a dial
// earlier. Everything downstream still decides for itself
// ([ReconnectCoordinator.kickNow] re-checks `_running` and the live socket
// status at fire time, and a dial that fails simply re-enters the ladder).
// Treating this as evidence of connectivity would be the R11 shape — a status
// word with no fact behind it.

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';

import '../diag/diag_log.dart' show diag;

/// 「手机的网络刚回来」 as a stream of bare edges.
///
/// Deliberately `Stream<void>`: the CONSUMER has no use for which interface it
/// is, and handing it one would invite a second reader to make a decision this
/// signal cannot support (see the ⚠️ above).
abstract class NetworkWatch {
  /// Fires once per transition from 「一个接口都没有」 ("no interface at all") to
  /// 「有了」 ("there is one"). Never fires on a wifi↔cellular swap where both
  /// ends have connectivity — that produces no new opportunity to dial that the
  /// socket's own drop detection will not already produce.
  Stream<void> get returned;

  Future<void> dispose();
}

/// The production watch, over `connectivity_plus`.
///
/// ⚠️ WHY A PLUGIN AT ALL, when this repo counts every dependency. The two
/// alternatives were both worse: polling would be traffic we manufactured for
/// ourselves (the argument `_dropLink` and `_stopPresencePoll` already make),
/// and a hand-rolled platform channel would be two native implementations to
/// carry for a callback both platforms already publish. `connectivity_plus` is
/// the plugin that publishes exactly that callback and nothing else.
class ConnectivityNetworkWatch implements NetworkWatch {
  /// [source] exists so the EDGE RULE below is driven by tests through the real
  /// code rather than re-implemented in a fake. Production passes nothing and
  /// gets the plugin's own stream; a test hands in a controller. It is the
  /// platform stream, not a `Connectivity` instance, because that is the whole
  /// of what this class consumes — taking the bigger object would let a future
  /// edit reach for something this design says it must not use.
  ConnectivityNetworkWatch({Stream<List<ConnectivityResult>>? source})
    : _source = source {
    _subscribe();
  }

  final Stream<List<ConnectivityResult>>? _source;
  final StreamController<void> _ctl = StreamController<void>.broadcast();
  StreamSubscription<List<ConnectivityResult>>? _sub;

  /// 🔴 Seeded pessimistically on purpose. If the first platform event says
  /// 「有网」 ("there is a network") we must NOT read that as an edge — the app
  /// usually launches with a network already attached, and firing on it would
  /// hand the ladder a kick every cold start for no reason. Only a transition
  /// OUT of `none` counts.
  bool _had = true;

  void _subscribe() {
    try {
      _sub = (_source ?? Connectivity().onConnectivityChanged).listen(
        _onChange,
        // A platform stream that errors must not take the ladder down with it:
        // this is an optimisation, and the ladder's timer is the thing that has
        // to keep working. Recorded rather than swallowed.
        onError: (Object e) =>
            diag('net.watch.error', <String, Object?>{'err': e.toString()}),
      );
    } on Object catch (e) {
      // No plugin registered (unit tests, and any platform that does not ship
      // one). The port then simply never fires — which degrades to exactly the
      // behaviour this app had before this file existed, and says so out loud
      // instead of pretending it is watching.
      diag('net.watch.unavailable', <String, Object?>{'err': e.toString()});
    }
  }

  void _onChange(List<ConnectivityResult> results) {
    final bool has = results.any((ConnectivityResult r) => r != ConnectivityResult.none);
    final bool wasDown = !_had;
    _had = has;
    if (!has || !wasDown) return;
    diag('net.watch.returned', const <String, Object?>{});
    if (!_ctl.isClosed) _ctl.add(null);
  }

  @override
  Stream<void> get returned => _ctl.stream;

  @override
  Future<void> dispose() async {
    await _sub?.cancel();
    _sub = null;
    await _ctl.close();
  }
}
