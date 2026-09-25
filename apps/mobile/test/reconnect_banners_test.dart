// Cards NR-96-E1 and NR-96-E2 — the phone's own reconnecting, said out loud on
// the chat page's banner slot.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-reconnect-visibility-design.md §1.1 B1 / B3,
//     §3.1 rules 1 and 4, §4 cards E1 / E2, §5.1
//   apps/mobile/lib/src/session/hold_out_retry.dart (`noteLostAck`, the bound)
//   apps/mobile/lib/src/ptt/ptt_reconnect_ack.dart (`_noteHoldOut`, the writer)
//   apps/mobile/lib/src/signaling/reconnect.dart (`scheduledAttempt`)
//
// ── E1: WHAT USED TO HAPPEN ─────────────────────────────────────────────────
// `mobile:reconnect` went unanswered, the phone re-asked on a bounded ladder
// (2 / 4 / 8 / 16 s), and when the bound was spent it stopped — in silence.
// The socket was up, so the link banner said nothing either, while every frame
// bounced off the room. That is the R2 shape: giving up without a word.
//
// ⚠️ The loop is driven through the REAL writer: acks come back non-Map, which
// is exactly what `runMobileReconnect` reads as 「nobody answered」 and hands to
// `_noteHoldOut` with a null code (mobile_reconnect_flow.dart). The first ask is
// the notice's own button path (`retryUnansweredReconnect`) because that is a
// public production entry that starts a fresh episode; every ask after it is
// the hold-out timer's.
//
// ── E2 ─────────────────────────────────────────────────────────────────────
// The link banner while the phone's socket ladder climbs, with the rung. The
// production ladder is unbounded (`maxAttempts` 0) ⇒ 「attempt n」; the bounded
// form is proven with a ladder built bounded, on the same page.
//
// Texts are compared against the GETTERS: the values are DEV placeholders
// until the copy lane writes them (D-47).

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/hold_out_retry.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/di.dart';
import 'support/fakes.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

/// What `runMobileReconnect` receives when the ack never came: not a Map.
const String _noAnswer = 'no-answer';

int _asks(FakeSocketTransport t) =>
    t.emitted.where((EventEnvelope e) => e.name == 'mobile:reconnect').length;

Finder _banner(String message) => find.descendant(
      of: find.byType(BannerSlot),
      matching: find.text(message),
    );

/// Push-to-talk-free page on the fake socket, with a bounded or unbounded
/// ladder. [maxAttempts] 0 is production's value.
class _LadderRig {
  _LadderRig({int maxAttempts = 0}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      reconnect: ReconnectCoordinator(
        transport: transport,
        bufferedChunksProvider: () => const <Map<String, Object?>>[],
        maxAttempts: maxAttempts,
        url: 'ws://127.0.0.1:41999',
        token: 'tok-nr96-e2-000000000000000000',
      ),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: SessionOwnerProbe(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  Future<void> dispose() async {
    await session.reconnect.stop();
    await controller.dispose();
    store.dispose();
    await session.dispose();
  }
}

Future<void> _mountPage(WidgetTester tester, ChatController c) async {
  tester.view.physicalSize = const Size(800, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: c)));
  await tester.pump();
}

/// Drop the socket and let the ladder climb to rung [rung] (each rung's dial
/// fails at once on the fake, which schedules the next).
Future<void> _climbTo(WidgetTester tester, _LadderRig r, int rung) async {
  r.transport.connectSucceeds = false;
  r.session.reconnect.start();
  r.transport.pushStatus(SocketStatus.disconnected);
  await tester.pump();
  // Rung k fires 2^(k-1) s after it was scheduled (1 → 2 → 4 …).
  for (int k = 1; k < rung; k++) {
    await tester.pump(Duration(seconds: 1 << (k - 1)));
  }
  await tester.pump();
}

void main() {
  group('E1 — mobile:reconnect unanswered past its bound', () {
    testWidgets('🔴 four re-asks go unanswered ⇒ the notice, with the '
        'reconnect action', (WidgetTester tester) async {
      final ArticleRig r = ArticleRig();
      addTearDown(r.dispose);
      await mountLightRecordScreen(tester, r);
      r.session.reconnect.configure(token: 'tok-nr96-e1-000000000000000000');
      r.transport.ackQueue.addAll(<Object?>[
        for (int i = 0; i <= HoldOutRetry.lostAckWaits.length; i++) _noAnswer,
      ]);
      expect(_banner(_zh.reconnectAckLostNotice), findsNothing);

      unawaited(r.session.retryUnansweredReconnect());
      await tester.pump();
      expect(_asks(r.transport), 1, reason: 'positive control: the ask left');

      // Every re-ask but the last: the phone is still trying, nothing to say.
      const List<Duration> waits = HoldOutRetry.lostAckWaits;
      for (int i = 0; i < waits.length - 1; i++) {
        await tester.pump(waits[i]);
      }
      await tester.pump();
      expect(_asks(r.transport), waits.length);
      expect(_banner(_zh.reconnectAckLostNotice), findsNothing,
          reason: 'still inside the bound: it will ask again on its own');

      await tester.pump(waits.last);
      await tester.pump();
      expect(_asks(r.transport), waits.length + 1,
          reason: 'the original ask plus one per rung');
      expect(_banner(_zh.reconnectAckLostNotice), findsOneWidget,
          reason: 'the bound is spent and nothing will ask again: silence here '
              'is R2');
      expect(_banner(_zh.reconnectNowAction), findsOneWidget,
          reason: 'the user is handed the one thing that can still work');

      // EVENT-type: it hides itself once read, like every past-event banner.
      await tester.pump(const Duration(seconds: 5));
      expect(_banner(_zh.reconnectAckLostNotice), findsNothing);
      expect(r.session.reconnectAckLost.value, 0);
    });

    testWidgets('dismissible: ✕ takes it away; the action asks afresh',
        (WidgetTester tester) async {
      final ArticleRig r = ArticleRig();
      addTearDown(r.dispose);
      await mountLightRecordScreen(tester, r);
      r.session.reconnect.configure(token: 'tok-nr96-e1-000000000000000000');
      r.transport.ackQueue.addAll(<Object?>[
        for (int i = 0; i <= HoldOutRetry.lostAckWaits.length; i++) _noAnswer,
      ]);
      unawaited(r.session.retryUnansweredReconnect());
      for (final Duration w in HoldOutRetry.lostAckWaits) {
        await tester.pump();
        await tester.pump(w);
      }
      await tester.pump();
      expect(_banner(_zh.reconnectAckLostNotice), findsOneWidget);

      await tester.tap(find.descendant(
        of: find.byType(BannerSlot),
        matching: find.byIcon(Icons.close),
      ));
      await tester.pump();
      expect(_banner(_zh.reconnectAckLostNotice), findsNothing);

      // The action is a NEW episode: one ask now, and when that one is lost
      // too the bounded re-asks start over instead of giving up at once.
      r.transport.ackQueue.add(_noAnswer);
      final int before = _asks(r.transport);
      unawaited(r.session.retryUnansweredReconnect());
      await tester.pump();
      expect(_asks(r.transport), before + 1);
      expect(r.session.reconnectAckLost.value, 0,
          reason: 'a streak the action did not reset would be spent already, '
              'and the notice would come straight back');
      expect(r.session.holdOutArmed, isTrue,
          reason: 'the first re-ask of the new episode is scheduled');
      r.session.cancelHoldOutRetry();
    });
  });

  group('E2 — the link banner carries the rung', () {
    testWidgets('🔴 unbounded ladder (production) ⇒ 「attempt n」, n moves',
        (WidgetTester tester) async {
      final _LadderRig r = _LadderRig();
      addTearDown(r.dispose);
      await _mountPage(tester, r.controller);

      await _climbTo(tester, r, 1);
      expect(_banner(_zh.bannerReconnectingN(1)), findsOneWidget);
      await _climbTo(tester, r, 2);
      expect(_banner(_zh.bannerReconnectingN(2)), findsOneWidget,
          reason: 'the number is the rung being tried now');
      expect(_banner(_zh.bannerReconnecting), findsNothing);

      unawaited(r.session.reconnect.stop()); // not awaited: its cancel never resolves in the fake zone
      r.transport.pushStatus(SocketStatus.connected);
      await tester.pump();
      expect(_banner(_zh.bannerReconnectingN(2)), findsNothing,
          reason: 'connected ⇒ the link row is gone (its own success edge)');
    });

    testWidgets('🔴 bounded ladder ⇒ 「attempt n of N」', (WidgetTester tester) async {
      final _LadderRig r = _LadderRig(maxAttempts: 5);
      addTearDown(r.dispose);
      await _mountPage(tester, r.controller);

      await _climbTo(tester, r, 2);
      expect(_banner(_zh.bannerReconnectingNOf(2, 5)), findsOneWidget);
      unawaited(r.session.reconnect.stop()); // not awaited: its cancel never resolves in the fake zone
      r.transport.pushStatus(SocketStatus.connected);
      await tester.pump();
    });

    test('no rung known ⇒ the sentence this row always had, byte for byte', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.reconnecting,
        autoStopped: false,
        strings: _zh,
        ladderReconnecting: true,
      );
      expect(q.top?.message, _zh.bannerReconnecting);
    });
  });
}
