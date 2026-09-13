// Card APPLINK-2 — an incoming pairing URL is ANSWERED, and answered from
// cold as well as while the app is running.
//
// WHAT THIS FILE IS FOR. APPLINK-1 told both operating systems that this app
// owns `https://flowmic.app/go/pair`, and nothing in the Dart tree listened:
// the app's only `app_links` subscription is built inside the sign-in sheet
// and recognises only the `flowmic://login` hand-back. Once the association
// files are published, a person scanning the pairing QR would have watched the
// OS open FlowMic while FlowMic did nothing.
//
// 🔴 EVERY ASSERTION BELOW IS ABOUT WHAT IS ON SCREEN OR ON THE WIRE — the
// chat page appearing, the settings page still being there, `mobile:pair`
// having been emitted or not. None of them reads a flag off the router: a flag
// would be green for an implementation that decides correctly and then does
// nothing with the decision, which is the class of bug this card is repairing.
//
// ── REVERSE CONTROLS ─────────────────────────────────────────────────────
// Four were run against the real code; the verbatim red is in this card's
// report. Each one names the ASYMMETRY it proves, because a control that goes
// red everywhere proves only that the file is wired to something.
//   ① delete `router.drainInitialLink()` from `_attachPairLinkRouterRouted`
//      → 「a cold launch」 RED (`Found 0 widgets with text "CHAT"`) while
//      「already running」 stays GREEN. That asymmetry IS the bug this card
//      exists to prevent: the stream half is the one everybody writes, and it
//      hides the missing launch-argument half completely.
//   ② make `decidePairLink` ignore `captureInFlight` → 「mid-recording」 RED
//      (`Found 0 widgets with text "SETTINGS"` — the person was yanked off
//      their own recording) while 「an unrelated screen」 stays GREEN.
//   ③ make `classifyIncomingLink` answer `pairing` for a login link →
//      「a login link is not ours to act on」 RED (a SnackBar appears).
//      🔴 THIS CONTROL FAILED TO FAIL ON ITS FIRST RUN, and that was worth
//      more than a red would have been: the rule was DEFENDED TWICE. With the
//      classifier broken the login URL still reached `addByCode`,
//      `PairEntry.parse` threw, and no frame left the device — so 「no
//      mobile:pair」 and 「no CHAT」 were both still green. What was NOT green
//      in reality was the person's screen: they were told 「配对码无效」 about
//      a link that is not a pairing code. The assertion that pins the routing
//      (`findsNothing` on SnackBar) was added because of this.
//   ④ delete `_retryHeldPairLinkRouted` from `_enterChat`'s tail → 「a second
//      link while a session is up」 RED (`Expected: <2> Actual: <1>`) while
//      「an unrelated screen」, which returns through `whenComplete` instead,
//      stays GREEN — the two return edges are separately pinned.
// A fifth was attempted and PASSED, so it measured nothing: deleting a
// post-frame deferral inside `_retryHeldPairLinkRouted`. The deferral was
// therefore deleted rather than kept behind a confident comment nothing tests.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/link/incoming_link.dart';
import 'package:flowmic/src/link/pair_link_router.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/scan_payload.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The link the desktop's QR carries. Built from the app's own prefix constant
/// rather than retyped, so moving the host cannot leave this test asserting
/// about a URL the product no longer emits.
final Uri kPairUri = Uri.parse(
  '$kPairLinkPrefixHttps?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone',
);

/// The console's sign-in hand-back — a different question, a different owner.
final Uri kLoginUri = Uri.parse('flowmic://login?t=nonce-abcdef');

/// A fake link source that can deliver BOTH halves independently, which is the
/// whole point: a rig that can only push on the stream cannot tell a working
/// cold start from a missing one.
class _FakeIncomingLinks implements IncomingLinks {
  _FakeIncomingLinks({this.launchedWith});

  /// What `getInitialLink()` answers — i.e. the app was started BY this URL.
  final Uri? launchedWith;

  final StreamController<Uri> _ctl = StreamController<Uri>.broadcast();

  /// Deliver a link to an app that is already running.
  void deliver(Uri uri) => _ctl.add(uri);

  @override
  Stream<Uri> get stream => _ctl.stream;

  @override
  Future<Uri?> initialLink() async => launchedWith;

  void close() => _ctl.close();
}

/// The pair ack a server sends when it accepts the code.
Map<String, Object?> _pairAck() => <String, Object?>{
  'pairing_id': 'p-link',
  'mobile_token': 'fm_${'2' * 64}',
  'pc_id': 'pc-link',
  'pc_instance_id': 'inst-link',
  'pc_name': 'Linked PC',
  'room_uuid': 'room-link',
  'pc_online': true,
  'role': 'active',
};

Future<HealthReading> _probeUnreachable(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

class _Rig {
  _Rig(this.widget, this.transport, this.links, this.session);
  final Widget widget;
  final FakeSocketTransport transport;
  final _FakeIncomingLinks links;
  final PttSession session;
}

Future<_Rig> _rig({Uri? launchedWith}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final FakeSocketTransport t = FakeSocketTransport()
    ..connectSucceeds = true
    ..defaultAck = _pairAck();
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: InMemoryTokenStorage(),
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _probeUnreachable,
    presenceReader: _presenceUnknown,
  );
  final _FakeIncomingLinks links = _FakeIncomingLinks(launchedWith: launchedWith);
  return _Rig(
    MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
        updateListenable: ValueNotifier<bool>(false),
        hasUpdate: () => false,
        incomingLinks: links,
      ),
    ),
    t,
    links,
    session,
  );
}

/// Did a pair frame actually leave the device? The 「nothing happened」 tests
/// need this as well as the screen: an implementation that pairs in the
/// background and simply does not navigate would look identical on screen.
bool _pairEmitted(FakeSocketTransport t) =>
    t.emittedNames.contains('mobile:pair');

/// A real `pair()` arms PttSession's presence-poll Timer, and the binding
/// checks for pending timers the INSTANT the tree is torn down — before any
/// `addTearDown` could run, which is why this is the last line of a test body
/// rather than a teardown. Same escape hatch, and the same reasoning, as
/// chat_back_policy_test.dart and its siblings; it touches no FSM edge and no
/// socket status, so nothing else reacts to it.
void _releaseTimers(_Rig r) => r.session.debugStopIdlePresencePoll();

void main() {
  group('what an incoming URL means', () {
    test('the two shapes of our pairing link are ours', () {
      expect(classifyIncomingLink(kPairUri), IncomingLinkKind.pairing);
      expect(
        classifyIncomingLink(
          Uri.parse('flowmic://pair?endpoint=ws://1.2.3.4:9&code=1234'),
        ),
        IncomingLinkKind.pairing,
      );
    });

    test('the sign-in hand-back is named, not lumped in with the unknown', () {
      // 🔴 The distinction is the point. If it collapsed into `unrecognised`,
      // the router would be declining it by accident rather than by decision,
      // and the next person could not tell 「someone else owns this」 from
      // 「nobody understands this」.
      expect(classifyIncomingLink(kLoginUri), IncomingLinkKind.browserLogin);
    });

    test('a foreign URL on our own host is not a pairing link', () {
      // The host alone must never be the test: `https://` plus our domain is
      // not the same claim as our pairing path.
      expect(
        classifyIncomingLink(Uri.parse('https://flowmic.app/help')),
        IncomingLinkKind.unrecognised,
      );
      expect(
        classifyIncomingLink(Uri.parse('https://example.com/pair?code=1234')),
        IncomingLinkKind.unrecognised,
      );
      // DOM-1 — the pre-2026-09-08 shapes. `go.flowmic.app` is a hostname this
      // product decided not to take, and `/pair` on the apex is the path the
      // client had before it moved under `/go/`. Both can still be printed by
      // an older desktop build. Neither is our link now, and answering
      // `unrecognised` is what sends the user to update the PC rather than
      // leaving two accepted origins alive for good.
      expect(
        classifyIncomingLink(Uri.parse('https://go.flowmic.app/pair?code=1234')),
        IncomingLinkKind.unrecognised,
      );
      expect(
        classifyIncomingLink(Uri.parse('https://flowmic.app/pair?code=1234')),
        IncomingLinkKind.unrecognised,
      );
      // DOM-1 — `www.` is a different host to both operating systems, and only
      // the apex is declared. Nothing routes this to the app; the classifier
      // must not pretend otherwise.
      expect(
        classifyIncomingLink(Uri.parse('https://www.flowmic.app/go/pair?code=1234')),
        IncomingLinkKind.unrecognised,
      );
    });
  });

  group('when a pairing link may be acted on', () {
    PairLinkSituation at({
      bool current = true,
      bool capture = false,
      bool pairing = false,
    }) => PairLinkSituation(
      instanceListIsCurrent: current,
      captureInFlight: capture,
      pairingInFlight: pairing,
    );

    test('on the instance list with nothing running: pair', () {
      expect(decidePairLink(at()), PairLinkAction.pairNow);
    });

    test('another screen on top: come back to the list first', () {
      expect(
        decidePairLink(at(current: false)),
        PairLinkAction.returnToInstanceList,
      );
    });

    test('a capture is open: hold, wherever we are', () {
      // 🔴 BOTH rows. The second is the one that matters: even on the instance
      // list, a long recording is running and pairing dials another computer.
      expect(decidePairLink(at(current: false, capture: true)),
          PairLinkAction.hold);
      expect(decidePairLink(at(capture: true)), PairLinkAction.hold);
    });

    test('a pair attempt is already on the wire: hold', () {
      // `addByCode`'s 'BUSY' arm sets NO error, so a second attempt would be
      // refused with nothing to show for it.
      expect(decidePairLink(at(pairing: true)), PairLinkAction.hold);
    });
  });

  group('the app answers the link', () {
    testWidgets('already running: the pairing runs and the chat page opens',
        (WidgetTester tester) async {
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      expect(find.text('CHAT'), findsNothing);

      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();

      expect(find.text('CHAT'), findsOneWidget,
          reason: 'a scanned pairing link must reach the same funnel the '
              '「add device」 button reaches');
      expect(_pairEmitted(r.transport), isTrue);
      _releaseTimers(r);
    });

    testWidgets('a cold launch: the URL the process was STARTED with is answered',
        (WidgetTester tester) async {
      // 🔴 THE ASYMMETRY THIS FILE EXISTS FOR. Nothing is ever pushed on the
      // stream here; the only delivery is `getInitialLink()`. An
      // implementation that subscribes and forgets to drain passes the test
      // above and fails this one — which on a real phone reads as 「it works
      // when the app is open and does nothing from cold」.
      final _Rig r = await _rig(launchedWith: kPairUri);
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();

      expect(find.text('CHAT'), findsOneWidget);
      expect(_pairEmitted(r.transport), isTrue);
      _releaseTimers(r);
    });

    testWidgets('a login link is not ours to act on', (WidgetTester tester) async {
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();

      r.links.deliver(kLoginUri);
      await tester.pumpAndSettle();

      // Two listeners, two questions: this one leaves the sign-in hand-back to
      // `BrowserLoginController` and does not guess.
      expect(_pairEmitted(r.transport), isFalse);
      expect(find.text('CHAT'), findsNothing);
      // 🔴 AND NOTHING IS SAID ABOUT IT EITHER — this line is the one that
      // actually pins the routing, and it was added because the two above did
      // NOT. Reverse control ③ (classify a login link as pairing) left them
      // both green: the URL went to `addByCode`, `PairEntry.parse` threw, and
      // no frame ever reached the wire. The rule was defended twice, and the
      // half that failed was invisible — except to the person, who was told
      // 「配对码无效」 about a link that is not a pairing code at all.
      expect(find.byType(SnackBar), findsNothing);
      expect(find.text('配对码无效'), findsNothing);
      // POSITIVE CONTROL — the same rig DOES act on a pairing link, so the
      // zero above is a decision and not a dead delivery path.
      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();
      expect(_pairEmitted(r.transport), isTrue);
      _releaseTimers(r);
    });

    testWidgets('an unrelated screen on top: the app comes back and pairs',
        (WidgetTester tester) async {
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('connections.settings')));
      await tester.pumpAndSettle();
      expect(find.text('SETTINGS'), findsOneWidget);

      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();

      // What the person sees: the settings page closes by itself — the same
      // movement their own back gesture makes — and the pairing happens.
      expect(find.text('SETTINGS'), findsNothing);
      expect(find.text('CHAT'), findsOneWidget);
      expect(_pairEmitted(r.transport), isTrue);
      _releaseTimers(r);
    });

    testWidgets('mid-recording: nothing moves, and the link is not lost',
        (WidgetTester tester) async {
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('connections.settings')));
      await tester.pumpAndSettle();

      // A capture is open. (SETTINGS stands in for any screen stacked over the
      // list; what makes this case different is the microphone, not the page.)
      r.transport.pushStatus(SocketStatus.connected);
      r.session.fsm.onPttDown();
      expect(r.session.fsm.session, SessionState.recording,
          reason: 'the scenario has to actually be set up, or every assertion '
              'below is about nothing');

      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();

      // 🔴 The person is exactly where they were, still recording.
      expect(find.text('SETTINGS'), findsOneWidget);
      expect(find.text('CHAT'), findsNothing);
      expect(_pairEmitted(r.transport), isFalse,
          reason: 'pairing dials another computer and would tear down the '
              'socket this utterance is riding');

      // They end the capture and come back on their own. The link was HELD,
      // not dropped.
      //
      // ⚠️ `onPttCancel` rather than `onPttUp`: BOTH leave SessionState.recording
      // (which is the only thing the router reads), and only this one avoids
      // arming the 15 s PROCESSING watchdog this test would then leak. The
      // assertion below is on the fact the router actually consults, not on
      // which edge produced it.
      r.session.fsm.onPttCancel();
      expect(r.session.fsm.session, isNot(SessionState.recording));
      await tester.pumpAndSettle();
      Navigator.of(tester.element(find.text('SETTINGS'))).pop();
      await tester.pumpAndSettle();

      expect(find.text('CHAT'), findsOneWidget,
          reason: 'held is not ignored: the first safe moment is acted on');
      expect(_pairEmitted(r.transport), isTrue);
      _releaseTimers(r);
    });

    testWidgets(
        'a second link while a session is up waits for the chat page to close',
        (WidgetTester tester) async {
      // 🔴 THE PRODUCTION RETURN EDGE. The settings case above closes through
      // `whenComplete`; THIS one closes through `_enterChat`'s tail, which is
      // the only path that also runs `leaveRoom()` — and it is the path a real
      // person takes, because a capture can only be open from the chat page.
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();
      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();
      expect(find.text('CHAT'), findsOneWidget);

      // In a session, recording, when a second computer's QR arrives.
      r.transport.pushStatus(SocketStatus.connected);
      r.session.fsm.onPttDown();
      expect(r.session.fsm.session, SessionState.recording);
      final int pairsBefore =
          r.transport.emittedNames.where((String n) => n == 'mobile:pair').length;

      r.links.deliver(
        Uri.parse('$kPairLinkPrefixHttps?endpoint=ws://10.0.0.9:41879&code=5678'),
      );
      await tester.pumpAndSettle();

      expect(find.text('CHAT'), findsOneWidget,
          reason: 'the session the person is recording into is untouched');
      expect(
        r.transport.emittedNames.where((String n) => n == 'mobile:pair').length,
        pairsBefore,
        reason: 'no second dial while the microphone is open',
      );

      // They stop and back out of the chat page, exactly as they would.
      r.session.fsm.onPttCancel();
      await tester.pumpAndSettle();
      // ⚠️ `runAsync` is load-bearing, not decoration. Backing out of the chat
      // page runs `leaveRoom()`, whose ladder teardown awaits real stream
      // cancellations; inside `testWidgets`' fake clock those futures never
      // complete, and the tail — the very line this test is here to exercise —
      // is simply never reached. Measured: the teardown's own print landed
      // AFTER the test body had finished.
      await tester.runAsync(() async {
        Navigator.of(tester.element(find.text('CHAT'))).pop();
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pumpAndSettle();

      expect(
        r.transport.emittedNames.where((String n) => n == 'mobile:pair').length,
        pairsBefore + 1,
        reason: 'the held link is answered on the way back, not forgotten',
      );
      _releaseTimers(r);
    });

    testWidgets('a code the server refuses says so, and never fakes success',
        (WidgetTester tester) async {
      final _Rig r = await _rig();
      addTearDown(r.links.close);
      r.transport.defaultAck = <String, Object?>{'error': 'PAIR_INVALID_CODE'};
      await tester.pumpWidget(r.widget);
      await tester.pumpAndSettle();

      r.links.deliver(kPairUri);
      await tester.pumpAndSettle();

      // The mapped sentence this page already owns — no new copy at the edge,
      // and no chat page for a pairing that did not happen.
      expect(find.text('配对码无效'), findsOneWidget);
      expect(find.text('CHAT'), findsNothing);
    });
  });
}
