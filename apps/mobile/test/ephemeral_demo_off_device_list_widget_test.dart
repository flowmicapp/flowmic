// owner 2026-09-17 — the ephemeral site-demo session is NOT on the device
// list, and the chat screen SAYS it is temporary. Both are claims about what a
// screen shows, so both are asserted on the mounted screen, not on a model
// (CLAUDE.md anti-façade ⑥: the deliverable is 「what the user sees on X」, so
// X is what gets mounted).
//
//   · ConnectionsPage, real controllers over a fake socket: a demo pair through
//     the SAME `addByCode` funnel the scan sheet calls leaves the list without
//     that row. The positive control is the persistent `/go/pair` form of the
//     same query and the same ack — it DOES put 「FlowMic Web」 on the list, so
//     the negative finder is proven to see rows.
//   · ChatFlowPage over a session that paired ephemerally: the standing note is
//     rendered under the header, with the copy the strings table carries; the
//     persistent control renders no such line.
//
// Reverse control (run by hand, 2026-09-17): removing the `if (!ephemeral)`
// guard around `tokenStorage.addOrUpdatePairing` in ptt/ptt_pair.dart makes
// the first case fail on `find.text('FlowMic Web')` with
// `Expected: no matching candidates / Actual: exactly one matching candidate`.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _query =
    'endpoint=wss://relay.flowmic.app&code=4831&channel=saas&pcid=930582147&v=1';
const String _demoLink = 'https://flowmic.app/go/zh-cn/demo?$_query';
const String _pairLink = 'https://flowmic.app/go/pair?$_query';
const String _pcName = 'FlowMic Web';

Map<String, Object?> _ack() => <String, Object?>{
      'ok': true,
      'token': 'demo-token-000000000000000000000000',
      'pc_id': 'pc-demo-1',
      'pc_instance_id': 'inst-demo-1',
      'pc_name': _pcName,
    };

Future<HealthReading> _probeUnreachable(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

class _Rig {
  _Rig(this.widget, this.session, this.connections, this.strings);
  final Widget widget;
  final PttSession session;
  final ConnectionsController connections;
  final AppStrings strings;
}

Future<_Rig> _listRig(FakeSocketTransport t) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: InMemoryTokenStorage(),
    retireTransport: () => FakeSocketTransport(),
  );
  // No real network from the channel probe.
  session.healthReader = _probeUnreachable;
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _probeUnreachable,
    presenceReader: _presenceUnknown,
  );
  final Widget widget = MaterialApp(
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
    ),
  );
  return _Rig(widget, session, connections, AppStrings.of(AppLocale.zh));
}

/// The scan sheet's own call (add_pairing_sheet.dart `_submitScanned`): the
/// link is the code, the address field is empty.
Future<void> _scanInto(WidgetTester tester, _Rig rig, String link) async {
  await tester.runAsync(() async {
    final ConnectOutcome o =
        await rig.connections.addByCode(rawEndpoint: '', code: link);
    expect(o.success, isTrue, reason: o.error);
    await rig.connections.load();
  });
  // The REAL pair() armed the idle presence poll (a periodic Timer); this test
  // is about the list, not the poll, and `pumpAndSettle` cannot settle over a
  // periodic timer — same escape hatch ptt_presence_poll.dart documents.
  rig.session.debugStopIdlePresencePoll();
  await tester.pump();
}

void main() {
  testWidgets('the device list does NOT show the demo peer after an ephemeral pair; the same ack via /go/pair DOES (control)',
      (WidgetTester tester) async {
    // ── ephemeral ──
    final FakeSocketTransport t1 = FakeSocketTransport()..connectSucceeds = true;
    final _Rig demo = await _listRig(t1);
    addTearDown(() async {
      demo.session.debugStopIdlePresencePoll();
      await demo.session.dispose();
    });
    await tester.pumpWidget(demo.widget);
    await tester.pumpAndSettle();
    t1.ackQueue.add(_ack());
    await _scanInto(tester, demo, _demoLink);

    expect(demo.session.ephemeralSession.value, isTrue, reason: 'the pair went through the ephemeral arm');
    expect(find.text(_pcName), findsNothing, reason: 'an ephemeral peer on the device list is the defect');
    expect(find.text(demo.strings.noInstances), findsOneWidget, reason: 'the list is still the empty list');
    expect(demo.connections.pairings, isEmpty);

    // ── control ──
    final FakeSocketTransport t2 = FakeSocketTransport()..connectSucceeds = true;
    final _Rig persistent = await _listRig(t2);
    addTearDown(() async {
      persistent.session.debugStopIdlePresencePoll();
      await persistent.session.dispose();
    });
    await tester.pumpWidget(persistent.widget);
    // Not `pumpAndSettle`: the first rig's session is still alive under the
    // tear-down (a real pair leaves a ticking cooldown clock behind it), and
    // settle would wait on it forever. Two bounded pumps are enough for the
    // list to leave its loading state.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    t2.ackQueue.add(_ack());
    await _scanInto(tester, persistent, _pairLink);

    expect(persistent.session.ephemeralSession.value, isFalse);
    expect(find.text(_pcName), findsOneWidget, reason: 'the control proves the finder sees a row that IS on the list');
    expect(find.text(persistent.strings.noInstances), findsNothing);
  });

  testWidgets('the chat header carries the 「temporary」 note for an ephemeral session, and not otherwise',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(411 * 3, 890 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    Future<ChatController> paired(String link) async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      final PttSession session = newTestSession(
        transport: t,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      session.healthReader = _probeUnreachable;
      t.ackQueue.add(_ack());
      expect((await session.pair(PairEntry.parse(link), endpoint: 'wss://relay.flowmic.app')).ok, isTrue);
      final ChatController c = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: newTestStore(),
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: t),
        localPrefs: InMemoryLocalPrefs(),
      );
      addTearDown(() async {
        session.debugStopIdlePresencePoll();
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
      });
      return c;
    }

    final AppStrings s = AppStrings.of(AppLocale.zh);
    final Finder note = find.byKey(const ValueKey<String>('chat.ephemeralNote'));

    // ── ephemeral: the note is rendered, with the table's own sentence ──
    final ChatController demo = await tester.runAsync(() => paired(_demoLink)) as ChatController;
    await tester.pumpWidget(MaterialApp(
      home: ChatFlowPage(controller: demo, appSettings: null),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(note, findsOneWidget, reason: 'the user must be told this one is temporary');
    final Text rendered = tester.widget<Text>(note);
    expect(rendered.data, s.ephemeralSessionNote);
    expect(rendered.maxLines, isNull, reason: 'the whole sentence wraps; no ellipsis budget (0.2.53)');
    expect(find.text(_pcName), findsOneWidget, reason: 'the header names the demo page from the ack');

    // ── control: a persistent pairing shows no such line ──
    final ChatController persistent = await tester.runAsync(() => paired(_pairLink)) as ChatController;
    await tester.pumpWidget(MaterialApp(
      home: ChatFlowPage(controller: persistent, appSettings: null),
    ));
    await tester.pump();
    expect(note, findsNothing, reason: '「no note」 is the statement for a remembered PC');
  });
}
