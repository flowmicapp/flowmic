// 🔴 P0 (owner 2026-09-01) — 「pairing must succeed ONCE, the first time」, and
// 「the QR dissolving on the PC and the phone's 'connected' message must
// correspond to the same fact」.
//
// SPEC-REF:
//   lib/src/session/pairing_success_notice.dart   (arm → settled ack → raise)
//   lib/src/signaling/node_follow.dart            (settledAtHomeNode, the fact)
//   lib/src/session/chat_outbox_host.dart         (onRoomJoinedRouted,
//                                                  armPairingSuccessRouted)
//   lib/src/ui/connections_page.dart `_enterChat` → `onDeliberateEntry`
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// `mobile:pair` is writer-only, so on a multi-node relay the phone pairs on the
// WRITER while its PC may live on a replica. The phone then follows its PC —
// fire-and-forget — so the confirmation was raised, and the chat page opened,
// while the socket was still in a room the PC would never join. 「Connected to
// the PC」 was on screen next to a 「PC is offline」 chip, and `mirrorToPc` was
// dropping every audio frame with no error, no refusal and no log.
//
// ── HOW THIS FILE IS SPLIT, AND WHY BOTH HALVES ARE REQUIRED ────────────────
// The first group drives the notice in isolation: its budget, its one-shot
// nature, and 「an expired ticket is the same as an unarmed one」.
// The second group MOUNTS THE REAL SCREEN and drives the production chain
// (`session.noteRoomJoined` → `ChatController._onRoomJoined` →
// `onRoomJoinedRouted` → the notice → `ChatFlowPage`'s toast), because this
// deliverable is 「what the user sees」 and a green model test is half a sentence
// (WP2 §1-3: that is exactly how CR-7/CR-8 shipped and were not on the device).
//
// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-01, marker REVERSE-CONTROL-A) ──
// `armDeliberateEntry`'s gate was replaced by `if (true)` — i.e. the funnel
// raises again, which is the behaviour this card removes. Verbatim:
//
//   the one-shot ticket 🔴 NOT at the PC's node ⇒ nothing is shown while the
//   hop is pending [E]
//     Expected: null
//       Actual: <1>
//
//   on the transcription page 🔴 a cross-node pairing shows NOTHING … [E]
//     Expected: no matching candidates
//       Actual: _DescendantWidgetFinder:<Found 1 widget with text
//               "已连接到电脑，可以开始说话了" descending from widget with type
//               "PairingSuccessToast">
//
// Four of the seven model cases and one of the four screen cases went red.
// Restored; `grep -rn REVERSE-CONTROL-A apps/mobile/lib apps/mobile/test` = 0;
// re-greened 11/11.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pairing_success_notice.dart';
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppSettingsController;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/pairing_success_toast.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthFor;
import 'support/mic_permission_fakes.dart';

const double kPhoneDp = 411;
const AppStrings _zh = AppStringsZh();

Finder _toast() => find.descendant(
      of: find.byType(PairingSuccessToast),
      matching: find.text(_zh.pairingSuccessBanner),
    );

// ── group 1: the ticket, in isolation ───────────────────────────────────────

PairingSuccessNotice _notice(List<String> log, {Duration? budget}) =>
    PairingSuccessNotice(
      onChanged: () => log.add('changed'),
      // The real one calls into the platform haptics channel, which a plain
      // `test` has no binding for. Not a friendly no-op standing in for
      // production behaviour — the production default is still the real one.
      haptic: () async {},
      settleBudget: budget ?? kPairingSuccessSettleBudget,
    );

void main() {
  group('the one-shot ticket', () {
    test('🔴 already at the PC\'s node ⇒ raised IN THE SAME TURN, which is '
        'byte-for-byte today on every single-node deployment', () {
      final List<String> log = <String>[];
      final PairingSuccessNotice n = _notice(log);
      addTearDown(n.dispose);

      expect(n.ticket, isNull, reason: 'positive control: nothing up yet');
      n.armDeliberateEntry(atHomeNodeNow: true);
      // No pump, no delay, no ack: the assertion is the SYNCHRONY. An
      // implementation that always waited for the next settled ack would leave
      // this null and would still pass a test written with an `await`.
      expect(n.ticket, 1);
      expect(n.pendingSettle, isFalse, reason: 'nothing to wait for');
      expect(log, <String>['changed']);
    });

    test('🔴 NOT at the PC\'s node ⇒ nothing is shown while the hop is pending',
        () {
      final List<String> log = <String>[];
      final PairingSuccessNotice n = _notice(log);
      addTearDown(n.dispose);

      n.armDeliberateEntry(atHomeNodeNow: false);
      expect(n.ticket, isNull,
          reason: 'this is the defect: the confirmation used to appear here, '
              'while the socket was still on the writer and the PC was in '
              'another node\'s room');
      expect(n.pendingSettle, isTrue);
      expect(log, isEmpty, reason: 'nothing changed on screen');
    });

    test('an ack that is STILL not settled does not release it', () {
      final PairingSuccessNotice n = _notice(<String>[]);
      addTearDown(n.dispose);
      n.armDeliberateEntry(atHomeNodeNow: false);
      // The hop's own reconnect can land on a third node, or the PC can have
      // moved again between the two acks.
      n.noteJoinAtHomeNode(false);
      expect(n.ticket, isNull);
      expect(n.pendingSettle, isTrue, reason: 'still waiting, not given up');
    });

    test('the first settled ack releases it', () {
      final PairingSuccessNotice n = _notice(<String>[]);
      addTearDown(n.dispose);
      n.armDeliberateEntry(atHomeNodeNow: false);
      n.noteJoinAtHomeNode(true);
      expect(n.ticket, 1);
      expect(n.pendingSettle, isFalse, reason: 'the budget must be released too');
    });

    test('🔴 the budget expires UNRAISED, and a later rejoin cannot resurrect it',
        () {
      fakeAsync((FakeAsync async) {
        final PairingSuccessNotice n = _notice(<String>[],
            budget: const Duration(seconds: 10));
        addTearDown(n.dispose);
        n.armDeliberateEntry(atHomeNodeNow: false);

        async.elapse(const Duration(seconds: 9));
        expect(n.pendingSettle, isTrue, reason: 'positive control: still armed '
            'just before the budget, so the expiry below is the budget and not '
            'a typo in the elapse');

        async.elapse(const Duration(seconds: 2));
        expect(n.pendingSettle, isFalse);
        expect(n.ticket, isNull, reason: 'nothing is shown late');

        // The ladder rejoins for the rest of the session — every flap, every
        // hold-out recheck. None of them may put a confirmation on screen.
        n.noteJoinAtHomeNode(true);
        n.noteJoinAtHomeNode(true);
        expect(n.ticket, isNull,
            reason: 'an expired ticket must be indistinguishable from one that '
                'was never armed — this is the 0.3.27 「36 out of 36」 rule');
      });
    });

    test('🔴 an UNARMED notice ignores settled acks entirely — the rule the '
        'card was built on', () {
      final PairingSuccessNotice n = _notice(<String>[]);
      addTearDown(n.dispose);
      for (int i = 0; i < 20; i++) {
        n.noteJoinAtHomeNode(true);
      }
      expect(n.ticket, isNull);
    });

    test('a second deliberate entry gets its own full budget, never the '
        'remainder of the first', () {
      fakeAsync((FakeAsync async) {
        final PairingSuccessNotice n =
            _notice(<String>[], budget: const Duration(seconds: 10));
        addTearDown(n.dispose);
        n.armDeliberateEntry(atHomeNodeNow: false);
        async.elapse(const Duration(seconds: 9));
        n.armDeliberateEntry(atHomeNodeNow: false);
        async.elapse(const Duration(seconds: 5));
        expect(n.pendingSettle, isTrue,
            reason: 'the second arm inherited the first one\'s remaining 1 s');
        async.elapse(const Duration(seconds: 6));
        expect(n.pendingSettle, isFalse);
      });
    });
  });

  // ── group 2: the real screen, driven through the production chain ─────────

  group('on the transcription page', () {
    testWidgets('🔴 a cross-node pairing shows NOTHING until the phone has '
        'reached its PC\'s node, then shows the confirmation',
        (WidgetTester tester) async {
      final _Rig r = await _pump(tester);

      // ① The pair ack came from the WRITER while the PC lives on a replica.
      // This is what `PttSession.pair` does with `settledAtHomeNode(ack)`.
      r.session.noteRoomJoined(atHomeNode: false);
      // ② The connections page's deliberate-entry funnel — the exact call
      // main.dart wires to `onDeliberateEntry`.
      armPairingSuccessRouted(r.controller);
      await tester.pump();
      await tester.pump();
      expect(_toast(), findsNothing,
          reason: '🔴 THE DEFECT: 「Connected to the PC」 while the socket is '
              'still in a room the PC will never join');
      expect(find.byType(ChatFlowPage), findsOneWidget,
          reason: 'positive control: the page IS open — the ticket is what is '
              'held back, never the navigation');

      // ③ The hop landed: the phone re-admitted on the PC's own node.
      r.session.noteRoomJoined(atHomeNode: true);
      await tester.pump();
      expect(_toast(), findsOneWidget,
          reason: 'the confirmation must arrive when the fact does');
      await _letItFade(tester);
    });

    testWidgets('a single-node pairing shows it immediately, in the same frame',
        (WidgetTester tester) async {
      final _Rig r = await _pump(tester);
      // A single-node ack carries neither node field ⇒ settled ⇒ true.
      r.session.noteRoomJoined(atHomeNode: true);
      armPairingSuccessRouted(r.controller);
      await tester.pump();
      expect(_toast(), findsOneWidget);
      await _letItFade(tester);
    });

    testWidgets('🔴 REVERSE CONTROL — the ladder\'s own rejoins still raise '
        'nothing when the user did not ask', (WidgetTester tester) async {
      final _Rig r = await _pump(tester);
      // No arm: this is a network flap, not an entry.
      r.session.noteRoomJoined(atHomeNode: false);
      r.session.noteRoomJoined(atHomeNode: true);
      r.session.noteRoomJoined(atHomeNode: true);
      await tester.pump();
      expect(r.session.roomJoins.value, 3,
          reason: 'positive control: the edges really fired');
      expect(_toast(), findsNothing);
    });

    testWidgets('🔴 the budget expires on screen: nothing is shown, and the '
        'page keeps working', (WidgetTester tester) async {
      final _Rig r = await _pump(tester);
      r.session.noteRoomJoined(atHomeNode: false);
      armPairingSuccessRouted(r.controller);
      await tester.pump();

      await tester.pump(kPairingSuccessSettleBudget +
          const Duration(seconds: 1));
      await tester.pump();
      expect(_toast(), findsNothing);

      // And the settled ack that arrives too late changes nothing.
      r.session.noteRoomJoined(atHomeNode: true);
      await tester.pump();
      expect(_toast(), findsNothing,
          reason: 'a confirmation 11 s after the scan answers a question the '
              'user stopped asking');
      expect(find.byType(ChatFlowPage), findsOneWidget);
    });
  });
}

// ── harness ─────────────────────────────────────────────────────────────────

/// Let the confirmation end the way it does in the product — the reconciler's
/// own window — rather than leaving its timer armed.
///
/// ⚠️ Not tidiness: `AutomatedTestWidgetsFlutterBinding` fails a test that ends
/// with a pending timer, and it does so with 「A Timer is still pending」 rather
/// than with anything about this feature. Asserting it is GONE afterwards also
/// keeps the ticket's own lifetime honest: this is an event, not a state.
Future<void> _letItFade(WidgetTester tester) async {
  await tester.pump(kBannerAutoHideAfter + const Duration(milliseconds: 50));
  await tester.pump();
  expect(_toast(), findsNothing, reason: 'the confirmation must end by itself');
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = PttSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      tokenStorage: InMemoryTokenStorage(),
      micPermission: newTestMicPermission(),
    );
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  void teardown() {
    debugCancelBannerAutoHideTimers(controller);
    unawaited(controller.dispose());
    destination.dispose();
    store.dispose();
  }
}

Future<_Rig> _pump(WidgetTester tester,
    {AppLocale locale = AppLocale.zh}) async {
  tester.view.physicalSize =
      Size(ahemWidthFor(kPhoneDp, locale) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final _Rig r = _Rig();
  addTearDown(r.teardown);
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController appSettings =
      AppSettingsController(prefs: await SharedPreferences.getInstance())
        ..setLocale(locale);
  await tester.pumpWidget(MaterialApp(
      home: ChatFlowPage(controller: r.controller, appSettings: appSettings)));
  await tester.pump();
  return r;
}
