// FM-002 — Settings' 「Enter Notes」 button did nothing a person could use.
//
// The button called `destination.configureFixed(fixedRecordOnly: !fixed)` and
// popped. Signed out and unpaired it returned to the device list and stopped
// there, while the device list's own Notes card, under the same conditions,
// opens the sign-in sheet. Signed in it opened no session either, and the flag
// it flipped is rewritten from the pairing by the next session entry
// (connections_page.dart `_enterChat`) — yet the label then read 「Exit Notes」
// about a session that did not exist.
//
// The screen that is the deliverable is SETTINGS, reached the way a person
// reaches it from the device list: the gear (`connections.settings`). So this
// file mounts the REAL ConnectionsPage and the REAL SettingsPage, wired the way
// main.dart wires them (`settingsPageBuilder: () => _buildSettings(
// SettingsNotesAction.enter)`), and taps through both.
//
// Reverse control (FM-002): restore the old onTap body in settings_page.dart
// (`destination.configureFixed(fixedRecordOnly: !fixed); maybePop()`) and the
// sign-in sheet never appears — this file goes red.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

const String _saas = 'https://saas.test:443';

MobileSession _cloudRow() => MobileSession(
  token: 'fm_${'0' * 64}',
  endpoint: _saas,
  channel: 'saas',
  pcName: 'FlowMic Cloud',
  pairingId: 'p-cloud',
  pcInstanceId: 'flowmic-cloud-instance',
);

class _Rig {
  late final Widget widget;
  late final Widget Function(SettingsNotesAction) settingsFor;
  late final LoginController login;
  late final FakeSocketTransport transport;
  late final DestinationController destination;
  late final PttSession session;
}

Future<_Rig> _rig({MobileSession? seed}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.en);
  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  if (seed != null) await storage.addOrUpdatePairing(seed);
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  final LoginController login = LoginController(
    transport: t,
    accountStore: InMemoryAccountStore(),
    saasEndpoint: _saas,
  );
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    saasEndpoint: _saas,
    healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    presenceReader: (Uri u, String tok, Duration d) async => PcPresenceReading.unknown,
  );
  final ScenarioCardController scenario =
      ScenarioCardController(cache: InMemoryScenarioCardCache());
  await scenario.load();
  final DestinationController destination = DestinationController();

  // The same arguments main_page_builders.dart `_buildSettings` hands over,
  // with the test doubles every other SettingsPage test uses.
  Widget settingsFor(SettingsNotesAction action) => SettingsPage(
    notesAction: action,
    scenario: scenario,
    appSettings: appSettings,
    login: login,
    destination: destination,
    session: session,
    portable: newTestPortableController(),
    prefs: newTestPrefsController(),
    backup: newTestSettingsBackup(),
    inventory: newTestInventory(
      rows: const <TimelineEntry>[],
      images: InMemoryOutboxBlobStore(),
    ),
    timeline: newTestStore(),
    version: const FixedAppVersion('0.0.0-test'),
    update: newTestUpdateController(),
    cloudSummary: newTestCloudSummary(login: login),
  );

  return _Rig()
    ..login = login
    ..transport = t
    ..destination = destination
    ..settingsFor = settingsFor
    ..session = session
    ..widget = MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: destination,
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        // main.dart's device-list wiring.
        settingsPageBuilder: () => settingsFor(SettingsNotesAction.enter),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
        updateListenable: ValueNotifier<bool>(false),
        hasUpdate: () => false,
      ),
    );
}

void _tallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// The sign-in sheet's own control (the key light_record_signin_reachable_test
/// uses for the same reason: a copy edit must not make this stop testing).
final Finder _loginSheet = find.byKey(const ValueKey<String>('login.browser.start'));
final Finder _gear = find.byKey(const ValueKey<String>('connections.settings'));
final Finder _cta = find.byKey(const ValueKey<String>('settings.notes.cta'));

Future<void> _openSettingsAndTapNotes(WidgetTester tester) async {
  await tester.tap(_gear);
  await tester.pumpAndSettle();
  expect(find.byType(SettingsPage), findsOneWidget, reason: 'the gear opened the real Settings');
  await tester.ensureVisible(_cta);
  await tester.tap(_cta);
  await tester.pumpAndSettle();
}

void main() {
  const AppStrings en = AppStringsEn();

  testWidgets('signed out, unpaired: Settings → Notes opens the sign-in sheet', (WidgetTester tester) async {
    _tallViewport(tester);
    final _Rig r = await _rig();
    await tester.pumpWidget(r.widget);
    await tester.pumpAndSettle();
    expect(r.login.isLoggedIn, isFalse, reason: 'positive control: signed out');

    await _openSettingsAndTapNotes(tester);

    expect(find.byType(SettingsPage), findsNothing, reason: 'Settings closed');
    expect(_loginSheet, findsOneWidget,
        reason: 'the same sheet the device list Notes card opens in this state');
    expect(r.transport.emittedNames, isNot(contains('mobile:pair')),
        reason: 'no account ⇒ nothing to enter with; nothing is dialled');
  });

  testWidgets('signed out with a remembered Notes row: Settings → Notes opens the sign-in sheet',
      (WidgetTester tester) async {
    _tallViewport(tester);
    final _Rig r = await _rig(seed: _cloudRow());
    await tester.pumpWidget(r.widget);
    await tester.pumpAndSettle();

    await _openSettingsAndTapNotes(tester);

    expect(_loginSheet, findsOneWidget);
  });

  testWidgets('signed in: Settings → Notes enters the Notes session; back on the list the label still says Enter',
      (WidgetTester tester) async {
    _tallViewport(tester);
    final _Rig r = await _rig();
    await tester.pumpWidget(r.widget);
    await tester.pumpAndSettle();
    r.transport.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'jwt-abc',
      'user': <String, Object?>{'id': 'u1', 'email': 'fang@example.com', 'plan': 'free'},
      'mode': 'saas',
    });
    await r.login.login(email: 'fang@example.com', password: 'secret12');
    expect(r.login.isLoggedIn, isTrue, reason: 'positive control: signed in');
    r.transport.ackQueue.add(<String, Object?>{
      'pairing_id': 'p-cloud',
      'mobile_token': 'fm_${'0' * 64}',
      'pc_id': 'pc-cloud',
      'pc_instance_id': 'flowmic-cloud-instance',
      'pc_name': 'FlowMic Cloud',
      'room_uuid': 'room-1',
      'pc_online': false,
      'role': 'active',
    });

    await _openSettingsAndTapNotes(tester);

    expect(r.transport.emittedNames, contains('mobile:pair'), reason: 'the cloud entry really dialled');
    expect(find.text('CHAT'), findsOneWidget, reason: 'the Notes session page is open');
    expect(r.destination.isFixed, isTrue, reason: 'scoped record-only by `_enterChat`, from the pairing');

    // Leave the session (the stand-in chat page has no ← of its own).
    tester.state<NavigatorState>(find.byType(Navigator)).pop();
    await tester.pumpAndSettle();
    expect(find.text('CHAT'), findsNothing);
    // POSITIVE CONTROL for the next assertion: the destination flag still
    // carries the left session's value — the old page read exactly this flag
    // and would now have printed 「Exit Notes」 on the device list.
    expect(r.destination.isFixed, isTrue);

    await tester.tap(_gear);
    await tester.pumpAndSettle();
    await tester.ensureVisible(_cta);
    expect(find.descendant(of: _cta, matching: find.text(en.enterCloudInstance)), findsOneWidget);
    expect(find.text(en.exitCloudInstance), findsNothing,
        reason: 'no Notes session is open here; the label must not claim one');

    // The real pair() armed the session's presence poll (ptt_presence_poll.dart
    // `debugStopIdlePresencePoll` says why a widget test must stop it itself).
    r.session.debugStopIdlePresencePoll();
  });

  // The chat host's half (main_page_builders.dart `onOpenSettings`) lives on
  // the app state and is not mounted here; what is pinned is the contract it
  // relies on: Settings pops with `leave` and builds no button for `none`.
  Future<Object?> pushSettings(WidgetTester tester, _Rig r, SettingsNotesAction action) async {
    Object? popped = 'never popped';
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (BuildContext context) => TextButton(
          onPressed: () async {
            popped = await Navigator.of(context).push<Object?>(
              MaterialPageRoute<Object?>(builder: (_) => r.settingsFor(action)),
            );
          },
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    if (action != SettingsNotesAction.none) {
      await tester.ensureVisible(_cta);
      expect(find.descendant(of: _cta, matching: find.text(en.exitCloudInstance)), findsOneWidget);
      await tester.tap(_cta);
      await tester.pumpAndSettle();
    }
    return popped;
  }

  testWidgets('inside a Notes session the button reads Exit and pops with `leave`',
      (WidgetTester tester) async {
    _tallViewport(tester);
    final _Rig r = await _rig();
    expect(await pushSettings(tester, r, SettingsNotesAction.leave), SettingsNotesAction.leave);
    expect(find.byType(SettingsPage), findsNothing);
  });

  testWidgets('a PC-session host (none) gets no Notes button at all', (WidgetTester tester) async {
    _tallViewport(tester);
    final _Rig r = await _rig();
    await pushSettings(tester, r, SettingsNotesAction.none);
    expect(find.byType(SettingsPage), findsOneWidget, reason: 'positive control: Settings is up');
    expect(find.byKey(const ValueKey<String>('settings.notes.sub')), findsOneWidget,
        reason: 'positive control: the Notes card itself is built');
    expect(_cta, findsNothing);
  });
}
