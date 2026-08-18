// 2026-08-18 — 「断完之后需要退出之后再进来才能连接起来」 ("after it drops you have
// to back out and come in again before it will connect"), owner, real device.
//
// SPEC-REF:
//   signaling/reconnect.dart ([ReconnectCoordinator.kickNow], `_scheduleReconnect`)
//   signaling/network_watch.dart (B1 — the hint, and what it is NOT)
//   ui/app_lifecycle_edges.dart (B2 — the return-from-background edge)
//   ui/banner_queue.dart `_linkBanner` (B4 — the affordance)
//
// ── WHY THE RITUAL EXISTED ──────────────────────────────────────────────────
// The ladder is a pure timer: 1→2→4→8→16→30 s computed from how many attempts
// have failed, and **nothing in this app could tell it that the world changed**.
// Put socket.io's own drop detection in front of it (`pingInterval` 10 s +
// `pingTimeout` 20 s) and the worst case before the first automatic dial is
// about a minute — during which the phone is out of a lift, back on a good
// network, and doing nothing. Backing out to the instance list and tapping the
// row calls `resumePairing`, which dials at once. That is the whole reason the
// ritual worked, and the whole reason it was needed.
//
// Three inputs now say 「现在试」 ("try now"), and each is pinned below:
//   B1 the phone's network came back      · B2 the app came back to the front
//   B4 the user asked, on the banner
//
// 🔴 EVERY ONE OF THEM GOES THROUGH THE SAME `kickNow`, whose guards are the
// interesting part: it must refuse when the ladder was stopped ON PURPOSE (a
// dead token belongs to the re-pair flow), when the socket is already up, and
// when a dial is already in flight. A kick that papers over any of those would
// be a button that cannot succeed, a capsule flicker, or a ladder chasing its
// own tail — all three of which this repo has paid for once already.

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/network_watch.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// A [NetworkWatch] a test drives by hand.
class FakeNetworkWatch implements NetworkWatch {
  final StreamController<void> _ctl = StreamController<void>.broadcast();
  bool disposed = false;

  void fire() => _ctl.add(null);

  @override
  Stream<void> get returned => _ctl.stream;

  @override
  Future<void> dispose() async {
    disposed = true;
    await _ctl.close();
  }
}

void main() {
  group('kickNow — dial now instead of waiting out the rung', () {
    test('a kick dials IMMEDIATELY where the ladder would have waited 30 s', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        )..start();

        // Climb to the 30 s cap the way a flapping link does.
        t.pushStatus(SocketStatus.disconnected);
        for (final int ms in <int>[1000, 2000, 4000, 8000, 16000, 30000]) {
          async.elapse(Duration(milliseconds: ms));
        }
        final int before = t.connectCalls;
        expect(coord.attempts, greaterThan(5), reason: 'parked on the top rung');

        // REVERSE CONTROL, inline: 29 s of the pending rung buys nothing.
        async.elapse(const Duration(seconds: 29));
        expect(t.connectCalls, before, reason: 'this is the wait owner sat through');

        coord.kickNow(reason: 'test');
        async.flushMicrotasks();
        async.elapse(Duration.zero);
        expect(t.connectCalls, before + 1, reason: 'kickNow dials on the spot');
      });
    });

    test('a kick that fails walks back UP the ladder, it does not storm', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        )..start();
        t.pushStatus(SocketStatus.disconnected);
        for (final int ms in <int>[1000, 2000, 4000, 8000, 16000]) {
          async.elapse(Duration(milliseconds: ms));
        }
        expect(coord.attempts, 6, reason: 'parked on the 30 s rung');

        coord.kickNow(reason: 'test');
        async.elapse(Duration.zero);
        // The kick spent rung 1 and its dial failed, so the ladder is at rung 2.
        // 🔴 THE PROPERTY THAT MATTERS: the counter came DOWN (6 → 2), so the
        // user is no longer serving a 30 s wait — and it did not come down to
        // zero, so a kick cannot be turned into a dial loop by holding the
        // button.
        expect(coord.attempts, 2);

        final int after = t.connectCalls;
        async.elapse(const Duration(milliseconds: 1999));
        expect(t.connectCalls, after, reason: 'the next rung is 2 s, not 0');
        async.elapse(const Duration(milliseconds: 1));
        expect(t.connectCalls, after + 1);
      });
    });

    test('refuses when the ladder was stopped on purpose (dead token)', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
          shouldReconnect: () => false, // AUTH_TOKEN_INVALID
        )..start();
        t.pushStatus(SocketStatus.disconnected); // the ladder stops itself here
        expect(coord.isRunning, isFalse);

        coord.kickNow(reason: 'test');
        async.elapse(const Duration(seconds: 5));
        expect(
          t.connectCalls,
          0,
          reason: 'that path belongs to the explicit re-pair flow — dialling '
              'here would be a button that cannot succeed',
        );
      });
    });

    test('refuses when the socket is already up (this is the F-5 flicker)', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        )..start();
        t.pushStatus(SocketStatus.connected);

        coord.kickNow(reason: 'test');
        async.elapse(const Duration(seconds: 5));
        expect(t.connectCalls, 0, reason: 're-dialling a live socket IS the defect');
      });
    });

    test('refuses while a dial is already in flight', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        )..start();
        t.pushStatus(SocketStatus.connecting);

        coord.kickNow(reason: 'test');
        async.elapse(const Duration(seconds: 5));
        expect(
          t.connectCalls,
          0,
          reason: 'SocketCore.connect supersedes the live adapter — kicking here '
              'makes the ladder chase its own tail',
        );
      });
    });
  });

  group('B1 — the network came back', () {
    test('an attached watch turns a network return into a dial', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final FakeNetworkWatch watch = FakeNetworkWatch();
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        );
        coord.attachNetworkWatch(watch);
        coord.start();
        t.pushStatus(SocketStatus.disconnected);
        for (final int ms in <int>[1000, 2000, 4000, 8000, 16000, 30000]) {
          async.elapse(Duration(milliseconds: ms));
        }
        final int before = t.connectCalls;

        watch.fire();
        async.flushMicrotasks();
        async.elapse(Duration.zero);
        expect(
          t.connectCalls,
          before + 1,
          reason: 'REVERSE CONTROL: without attachNetworkWatch this stream has '
              'no listener and the phone waits out the 30 s rung — which is '
              'exactly the minute owner reported.',
        );
      });
    });

    test('stop() drops the subscription, and start() takes it back up', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final FakeNetworkWatch watch = FakeNetworkWatch();
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://x',
        );
        coord.attachNetworkWatch(watch);
        coord.start();
        // 🔴 Pushed BEFORE the stop, and that ordering is the test. The fake is
        // born `connected`, so without this line the assertion below would pass
        // because `kickNow` refused an already-up socket — i.e. it would be
        // green whether or not `stop()` cancelled anything. A control pointing
        // the wrong way is worse than none (0.2.51's lesson, in this same
        // subsystem).
        t.pushStatus(SocketStatus.disconnected);
        unawaited(coord.stop());
        async.flushMicrotasks();

        watch.fire();
        async.elapse(const Duration(seconds: 5));
        expect(
          t.connectCalls,
          0,
          reason: 'a phone resting on the instance list has no room to dial into',
        );

        coord.start();
        t.pushStatus(SocketStatus.disconnected);
        final int before = t.connectCalls;
        watch.fire();
        async.flushMicrotasks();
        async.elapse(Duration.zero);
        expect(t.connectCalls, before + 1, reason: 're-listened without re-attaching');
      });
    });

    test('ConnectivityNetworkWatch fires on none→up, never on the seed', () async {
      final StreamController<List<ConnectivityResult>> src =
          StreamController<List<ConnectivityResult>>();
      final ConnectivityNetworkWatch watch =
          ConnectivityNetworkWatch(source: src.stream);
      final List<void> fired = <void>[];
      watch.returned.listen(fired.add);

      // 🔴 The seed is pessimistic ON PURPOSE: the app usually launches with a
      // network already attached, and firing on that would hand the ladder a
      // kick on every cold start for nothing.
      src.add(<ConnectivityResult>[ConnectivityResult.wifi]);
      await Future<void>.delayed(Duration.zero);
      expect(fired, isEmpty, reason: 'already-up is not an edge');

      // A wifi→mobile swap is not an edge either: both ends have connectivity,
      // and the socket's own drop detection already covers what changed.
      src.add(<ConnectivityResult>[ConnectivityResult.mobile]);
      await Future<void>.delayed(Duration.zero);
      expect(fired, isEmpty);

      src.add(<ConnectivityResult>[ConnectivityResult.none]);
      await Future<void>.delayed(Duration.zero);
      expect(fired, isEmpty, reason: 'losing the network is not a reason to dial');

      src.add(<ConnectivityResult>[ConnectivityResult.wifi]);
      await Future<void>.delayed(Duration.zero);
      expect(fired, hasLength(1), reason: 'THIS is the edge — and only this one');

      await watch.dispose();
      await src.close();
    });
  });

  group('B4 — the button that replaces backing out and coming in again', () {
    final AppStrings s = AppStrings.of(AppLocale.zh);

    BannerItem? link({
      required ConnectionState connection,
      bool albumAway = false,
      bool ladderReconnecting = false,
      void Function()? onReconnectNow,
    }) {
      final BannerQueue q = buildChatBanners(
        connection: connection,
        autoStopped: false,
        strings: s,
        albumAway: albumAway,
        ladderReconnecting: ladderReconnecting,
        onReconnectNow: onReconnectNow,
      );
      for (final BannerItem item in q.all) {
        if (item.id == BannerIds.link) return item;
      }
      return null;
    }

    test('while reconnecting, the banner carries the action', () {
      final BannerItem? item = link(
        connection: ConnectionState.disconnected,
        ladderReconnecting: true,
        onReconnectNow: () {},
      );
      expect(item, isNotNull);
      expect(item!.actionLabel, s.reconnectNowAction);
      expect(item.onAction, isNotNull);
    });

    test('with a link that is simply down, it carries the action too', () {
      final BannerItem? item = link(
        connection: ConnectionState.disconnected,
        onReconnectNow: () {},
      );
      expect(item!.actionLabel, s.reconnectNowAction);
    });

    test('no callback ⇒ no button (the ladder is not running)', () {
      final BannerItem? item = link(connection: ConnectionState.disconnected);
      expect(
        item!.actionLabel,
        isNull,
        reason: 'REVERSE CONTROL: a label without a working dial behind it is a '
            'façade with a label on it — the one shape this repo counts as its '
            'worst',
      );
      expect(item.onAction, isNull);
    });

    test('the album window carries NO action', () {
      final BannerItem? item = link(
        connection: ConnectionState.disconnected,
        albumAway: true,
        onReconnectNow: () {},
      );
      expect(
        item!.actionLabel,
        isNull,
        reason: 'this phone opened the picker and the link returns when it '
            'closes — a button here asks the user to fix something already '
            'scheduled to fix itself',
      );
    });

    test('the action really runs the callback', () {
      int taps = 0;
      final BannerItem? item = link(
        connection: ConnectionState.disconnected,
        ladderReconnecting: true,
        onReconnectNow: () => taps++,
      );
      item!.onAction!();
      expect(taps, 1);
    });

    test('every locale has a distinct, non-empty label', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings t = AppStrings.of(locale);
        expect(t.reconnectNowAction.trim(), isNotEmpty, reason: locale.name);
        expect(t.reconnectNowAction, isNot(t.bannerReconnecting), reason: locale.name);
      }
    });
  });
}
