// owner 2026-08-19 — what happens AFTER the 10 s give-up window.
//
// The old behaviour: at 10 s the ladder was stopped and the page popped back to
// the instance list. 0.3.9's on-device pass (handoff §7-6) measured what that
// cost: B1 (network returned) and B4 (the banner's button) could only ever act
// inside those first 10 s, because after them there was no ladder left to kick
// and no page left to kick it from. Every outage longer than 10 s ended the same
// way — 「退出之后再进来才能连接起来」 ("you have to leave and come back in
// before it connects").
//
// The new behaviour, ruled the same day: stay on the page, spend
// `kLinkRetryBudget` dial attempts, and only then return to the
// list. Both halves are asserted here, and so is the case that must NOT wait for
// the budget at all (a ladder that was stopped on purpose).
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM chat_controller_test.dart's owner-②
// group: that group's harness never pairs, so its ladder is not running — with
// this change it reaches `sessionLost` through the *shortcut*, not through the
// budget. Left alone, it would have stayed green while the budget did nothing
// at all. It now says which path it takes (see its renamed test), and the budget
// itself is proven here on a harness whose ladder really is running.
//
// SPEC-REF:
//   docs/decisions/2026-08-19-owner-phase2-four-rulings.md (ruling 4)
//   docs/strategy/2026-08-18-039-connection-stability-window-handoff-report.md §7-6

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    store = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
      // Collapse the give-up window: this file is about what happens after it,
      // not about its length.
      sessionLostAfter: const Duration(milliseconds: 40),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  /// Pair for real so the reconnect ladder is RUNNING — without this the
  /// controller takes the stopped-ladder shortcut and the budget is never
  /// entered. The distinction is the whole point of this file.
  Future<void> pairAndConnect() async {
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-retry-000000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    await session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://192.0.2.5:41879',
    );
    transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    // The ladder must dial nothing on its own during these tests: every attempt
    // below is pushed by hand so the count under test is the count we drove.
    transport.connectSucceeds = false;
  }

  /// One failed dial: the ladder announces it is trying, then the dial dies.
  Future<void> failedAttempt() async {
    transport.pushStatus(SocketStatus.connecting);
    await pumpEventQueue();
    transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
  }

  Future<void> enterBudget() async {
    transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
    await Future<void>.delayed(const Duration(milliseconds: 80));
  }

  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
  }
}

void main() {
  test('the window expiring keeps the page and opens the budget', () async {
    final _Harness h = _Harness();
    await h.pairAndConnect();
    expect(h.session.reconnect.isRunning, isTrue,
        reason: 'the budget path only exists while a ladder is running');

    await h.enterBudget();

    expect(h.controller.linkRetry.spending, isTrue);
    expect(h.controller.sessionLost, isFalse,
        reason: 'the page must NOT leave at the window — that is the change');
    expect(h.session.reconnect.isRunning, isTrue,
        reason: 'and the ladder must still be dialling while it stays');
    await h.dispose();
  });

  test('three failed attempts spend the budget and then the page leaves',
      () async {
    final _Harness h = _Harness();
    await h.pairAndConnect();
    await h.enterBudget();

    for (int i = 1; i <= kLinkRetryBudget; i++) {
      await h.failedAttempt();
      if (i < kLinkRetryBudget) {
        expect(h.controller.sessionLost, isFalse,
            reason: 'attempt $i of $kLinkRetryBudget — still trying');
      }
    }

    expect(h.controller.linkRetry.attempts, kLinkRetryBudget);
    expect(h.controller.sessionLost, isTrue);
    expect(h.controller.linkRetry.spending, isFalse);
    expect(h.session.reconnect.isRunning, isFalse,
        reason: 'a ladder left running would dial a dead PC from behind the list');
    await h.dispose();
  });

  test('a link that comes back spends nothing — the budget describes ONE outage',
      () async {
    final _Harness h = _Harness();
    await h.pairAndConnect();
    await h.enterBudget();
    await h.failedAttempt();
    await h.failedAttempt();
    expect(h.controller.linkRetry.attempts, 2);

    h.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();

    expect(h.controller.linkRetry.spending, isFalse);
    expect(h.controller.linkRetry.attempts, 0);
    expect(h.controller.sessionLost, isFalse);
    await h.dispose();
  });

  test('re-entering with the SAME state is not an attempt', () async {
    // 🔴 The defect this pins: `_watchSessionLoss` is not an edge callback.
    // `onFsmChangeRouted` re-enters it for every snapshot (the session half
    // moves on its own) and `onAlbumAwayChangedRouted` re-enters it by hand.
    // Counting calls instead of transitions spends the whole budget inside a
    // single dial — the user is thrown out while one attempt is still in flight.
    final _Harness h = _Harness();
    await h.pairAndConnect();
    await h.enterBudget();

    h.transport.pushStatus(SocketStatus.connecting);
    await pumpEventQueue();
    for (int i = 0; i < 5; i++) {
      onAlbumAwayChangedRouted(h.controller);
      await pumpEventQueue();
    }

    expect(h.controller.linkRetry.attempts, 1,
        reason: 'five re-entries on one connecting edge are still one attempt');
    expect(h.controller.sessionLost, isFalse);
    await h.dispose();
  });

  test('a ladder that was stopped on purpose does not wait out the budget',
      () async {
    // The dead-token shape (`auth_expired_handler.dart` stops the ladder). Three
    // attempts nobody will ever make is a page that hangs, with a 「立即重连」
    // button that cannot succeed.
    final _Harness h = _Harness();
    // Push `connected` first and it is not ceremony: the state machine drops a
    // status equal to the one it already holds, so a harness that goes straight
    // to `disconnected` produces NO edge, the watch is never armed, and the test
    // would be measuring nothing. (The fake transport is born connected; the FSM
    // is not.)
    h.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    h.transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
    expect(h.session.reconnect.isRunning, isFalse);

    await Future<void>.delayed(const Duration(milliseconds: 80));

    expect(h.controller.sessionLost, isTrue);
    expect(h.controller.linkRetry.spending, isFalse);
    expect(h.controller.linkRetry.attempts, 0,
        reason: 'it never entered the budget at all');
    await h.dispose();
  });
}
