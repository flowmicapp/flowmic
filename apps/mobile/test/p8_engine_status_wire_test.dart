// P-8 —— **is the production path really wired**.
//
// 🔴 Why this file must exist (the 0.2.51 ledger): the 14 cases in
// `local_engine_status_test.dart` are all green, and if you delete the entire
// `case FlowMicEvents.sttEngineStatus:` block in `ptt_inbound.dart`, **not one
// of them goes red** — they drive the store itself, not the path the product
// walks. Likewise `diagnostics_engine_section_test.dart` mounts that widget
// directly; it is blind to "did the sheet actually read the store in".
//
// So this file walks the **real chain**: a real `PttSession` + a real dispatch
// loop + a real sheet. The only stand-in is the socket transport
// (`FakeSocketTransport`), because what we need is the fact "the server sent a
// frame", and on a real device that arrives on that socket.
//
// ⚠️ This chain previously had a **structural silence**: `stt:engine-status`
// has always been on the 54-event whitelist, the server has always sent it, and
// the phone side's `_onIncomingRouted` `default: break;` has always dropped it.
// An event "eaten by default" does not error, does not enter the log, and has
// no symbol to grep — this is exactly CLAUDE.md anti-façade ①'s "the fault has
// no new symbol to grep, only an empty value".

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/local_engine_status.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/connection_diagnostics_sheet.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

const AppStrings kZh = AppStringsZh();
const String kEndpoint = 'ws://192.168.1.5:41879';
const String kPcId = 'pc_abc';

/// The frame the server `orchestrator-core` sends when it successfully starts the engine, verbatim same shape.
const Map<String, Object?> kReadyFrame = <String, Object?>{
  'provider': 'funasr-ws',
  'status': 'ready',
};

void main() {
  late FakeSocketTransport transport;
  late PttSession session;

  setUp(() {
    transport = FakeSocketTransport()..connectSucceeds = true;
    session = PttSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
      micPermission: newTestMicPermission(),
    );
    // RV-89 precedent: this fixture must not let a real server that happens to
    // be listening on the dev machine answer the channel for it.
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
    session.reconnect.configure(url: kEndpoint);
    session.applyPairedIdentity(
      const MobileSession(token: 'tok', endpoint: kEndpoint, pcId: kPcId),
    );
    session.serverChannel.value = ServerChannel.lan;
  });

  tearDown(() => session.dispose());

  test('① one stt:engine-status frame arrives from the socket ⇒ the store really gained an observation', () {
    expect(
      session.engineStatus.readFor(
        channelIsLan: true,
        endpoint: kEndpoint,
        pcId: kPcId,
      ),
      isNull,
      reason: 'positive control: must be empty before send, otherwise the case below may be vacuously true',
    );

    transport.pushIncoming('stt:engine-status', kReadyFrame);

    final LocalEngineObservation? o = session.engineStatus.readFor(
      channelIsLan: true,
      endpoint: kEndpoint,
      pcId: kPcId,
    );
    expect(o, isNotNull, reason: 'the dispatch loop did not catch this frame');
    expect(o!.provider, 'funasr-ws');
    expect(o.outcome, LocalEngineOutcome.ready);
  });

  test('② the triple is taken at **the moment the frame arrives**, not filled in when the sheet opens', () {
    // 🔴 This case pins an easy-to-get-wrong implementation: filling those three
    // from "who is connected now" inside the sheet. That answers a different
    // question — the observation belongs to the PC **at the moment it arrived**.
    // Here we swap identity after the frame; the observation must then be
    // unreadable; if the implementation is "derive it at open time", it would
    // instead be readable.
    transport.pushIncoming('stt:engine-status', kReadyFrame);
    session.applyPairedIdentity(
      const MobileSession(token: 'tok', endpoint: kEndpoint, pcId: 'pc_other'),
    );
    expect(
      session.engineStatus.readFor(
        channelIsLan: true,
        endpoint: kEndpoint,
        pcId: 'pc_other',
      ),
      isNull,
    );
  });

  test('③ a frame received on the cloud leg must not be read by the local channel', () {
    session.serverChannel.value = ServerChannel.cloudRelay;
    transport.pushIncoming('stt:engine-status', kReadyFrame);
    expect(
      session.engineStatus.readFor(
        channelIsLan: true,
        endpoint: kEndpoint,
        pcId: kPcId,
      ),
      isNull,
    );
  });

  testWidgets('④ real sheet: local channel + an observation ⇒ those three rows really painted', (
    WidgetTester tester,
  ) async {
    transport.pushIncoming('stt:engine-status', kReadyFrame);
    await _openSheet(tester, session);

    expect(find.text(kZh.diagEngineSection), findsOneWidget);
    expect(find.text('${kZh.diagEngineStt} · funasr-ws'), findsOneWidget);
    expect(find.text(kZh.diagEngineConnected), findsOneWidget);
    expect(find.text(kZh.diagEngineNoObservation), findsNothing);
  });

  testWidgets('⑤ real sheet: local channel + no observation ⇒ it says 「还没有可说的」', (
    WidgetTester tester,
  ) async {
    await _openSheet(tester, session);
    expect(find.text(kZh.diagEngineSection), findsOneWidget);
    expect(find.text(kZh.diagEngineNoObservation), findsOneWidget);
    expect(find.text(kZh.diagEngineConnected), findsNothing);
  });

  // owner limited P-8 to the local channel. On the cloud leg the subject of
  // this section does not exist at all, so the correct answer is **say
  // nothing**, not a sentence about someone else's engine.
  // ⚠️ One `testWidgets` per band rather than a loop: a modal bottom sheet has
  // no back button, and `pageBack()` inside a loop throws on the spot (measured
  // `Found 0 widgets with type "CupertinoNavigationBarBackButton"`). Writing
  // them apart also lets the failure message name which band it is.
  for (final ServerChannel? ch in <ServerChannel?>[
    ServerChannel.cloudRelay,
    null,
  ]) {
    testWidgets('⑥ real sheet: channel=$ch ⇒ the whole section is not painted', (WidgetTester tester) async {
      session.serverChannel.value = ServerChannel.lan;
      transport.pushIncoming('stt:engine-status', kReadyFrame);
      session.serverChannel.value = ch;
      await _openSheet(tester, session);
      expect(find.text(kZh.diagEngineSection), findsNothing);
      expect(
        find.text(kZh.diagEngineNoObservation),
        findsNothing,
        reason: 'not painted ≠ painting a sentence that says "don\'t know"',
      );
    });
  }

  testWidgets('⑧ the fullest screen × 360×640 short screen: not one row may be clipped outside the box', (
    WidgetTester tester,
  ) async {
    // 🔴 Same origin as a measured red: after adding the 「本地引擎」 section,
    // the sheet's `Column` reported `A RenderFlex overflowed by 31 pixels on
    // the bottom.`. Overflow and ellipsis are the same class of failure —
    // **content the user cannot read** — and worse: it does not even give an
    // ellipsis. The fix is to make the sheet scrollable (see the long comment
    // at the original site in connection_diagnostics_sheet.dart).
    //
    // This case pins that fix, and deliberately picks the **worst screen**:
    // every gated row is given a real value, the screen is 360×640 (the narrow
    // screen this repo's copy measurements have always used). Without it,
    // anyone who later adds another row to this sheet will silently lose the
    // bottom rows on some short-screen phone.
    tester.view.physicalSize = const Size(1080, 1920);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    transport.setLastConnectError('xhr poll error');
    session.connectedDeviceName.value = 'dev-pc-a';
    transport.pushIncoming('stt:engine-status', kReadyFrame);
    await _openSheet(tester, session);

    // Positive control: this really is "the fullest screen", not "no overflow
    // because a few rows were not painted".
    expect(find.text(kZh.diagEngineSection), findsOneWidget);
    expect(find.text(kZh.diagEndpoint), findsOneWidget);
    expect(find.text(kZh.diagDevice), findsOneWidget);
    expect(find.text(kZh.diagLastError), findsOneWidget);
    expect(
      tester.takeException(),
      isNull,
      reason: 'RenderFlex overflow ⇒ the bottom rows do not exist at all on a real device',
    );
  });

  group('⑦ engine status words must not collide with the connection-status words on the top row', () {
    // 🔴 Origin: case ④ in this file went red on the first run —
    // `Found 2 widgets with text "已连接"`. The first version wrote `ready` as
    // 「已连接」, and `connConnected` in `cloud_strings.dart` is **verbatim the
    // same** in all four languages, and it is painted on the same sheet's top
    // 「状态」 row.
    // ⇒ two 「已连接」 on the same screen each answer a different question; the
    // user cannot tell which sentence is about which thing.
    //
    // This assertion stays here because a **render test can never catch it**:
    // a screen that only mounts the engine section has only one word, so the
    // collision is structurally invisible. It also must not rely on someone
    // remembering — the top-row copy is maintained by someone else; the day it
    // changes back, we are the ones who collide.
    for (final AppLocale loc in <AppLocale>[
      AppLocale.zh,
      AppLocale.en,
      AppLocale.ja,
      AppLocale.ko,
    ]) {
      test('$loc: the three engine status words and the five connection status words are pairwise distinct', () {
        final AppStrings s = AppStrings(loc);
        final List<String> engine = <String>[
          s.diagEngineConnected,
          s.diagEngineReconnecting,
          s.diagEngineConnectFailed,
        ];
        final List<String> link = <String>[
          s.connConnected,
          s.connecting,
          s.recLinkDegraded,
          s.connError,
          s.notConnected,
        ];
        for (final String e in engine) {
          expect(
            link,
            isNot(contains(e)),
            reason: '"$e" is also a link-status word ⇒ two places on the same screen each answer a different question',
          );
        }
      });
    }
  });
}

/// Open the **real** sheet (not mounting the section by itself).
Future<void> _openSheet(WidgetTester tester, PttSession session) async {
  final DestinationController destination = DestinationController();
  addTearDown(destination.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (BuildContext ctx) => TextButton(
            onPressed: () => showConnectionDiagnostics(
              ctx,
              connection: ConnectionState.connected,
              session: session,
              destination: destination,
              strings: kZh,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}
