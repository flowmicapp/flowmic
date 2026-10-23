// STORE SCREENSHOT RIG — THIS IS NOT A TEST AND NOT PART OF THE APP.
//
// A standalone entrypoint that runs on an iOS Simulator and walks the REAL
// pages (ChatFlowPage, ConnectionsPage, SettingsPage, DataFlowDisclosurePage,
// FirstRunOnboardingPage) through a list of named scenes, seeded with clean
// sample data over the same test doubles the widget tests use
// (test/support/di.dart + fakes.dart). Nothing in lib/ is modified or
// overridden: every word on screen is the product's own copy, in English.
//
// Why an entrypoint and not an integration test: `package:integration_test` was
// removed from pubspec on 2026-08-28 because it broke the Android release
// build (see the comment in pubspec.yaml). A plain `flutter run -t` target
// needs no extra dependency.
//
// How it is driven (host side = scripts/store-shots/ios-store-shots.sh):
//   flutter run -d <sim> -t test/store_shots/store_shots_app.dart
// For each scene the app builds the page, lets it settle, prints
// `STORESHOT:<name>` and holds the frame for [_kHold]; the host script watches
// the log and runs `xcrun simctl io <sim> screenshot` when the marker appears
// (so the status bar override is in the picture). `STORESHOT_DONE` ends the run.
//
// The filename has no `_test` suffix on purpose (same convention as
// test/wp8_parity_shots.dart): `flutter test` must never discover it.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/saas_endpoint.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/mcp/mcp_scope.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/data_flow_disclosure_page.dart';
import 'package:flowmic/src/ui/onboarding/first_run_onboarding_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:shared_preferences/shared_preferences.dart';

import '../support/cloud_summary_fakes.dart';
import '../support/di.dart';
import '../support/fakes.dart';
import '../support/mic_permission_fakes.dart';
import '../support/portable_fakes.dart';
import '../support/settings_fakes.dart';
import '../support/update_fakes.dart';

/// How long a finished frame stays on screen after its marker is printed.
const Duration _kHold = Duration(seconds: 5);

/// How long a freshly mounted scene gets before anything is driven on it.
const Duration _kSettle = Duration(milliseconds: 2500);

// ── sample data (clean: no real people, accounts, hosts or window titles) ──
const String _kPcName = 'Work laptop';
const String _kFocusApp = 'Editor';
/// The focused window's title on the computer. Deliberately NOT "Notes": rows
/// read "Work laptop → <title>", and Notes is the name of our own phone-only
/// feature.
const String _kWindowTitle = 'Weekly update';
const String _kSampleEmail = 'alex@example.com';
const String _kVersion = '0.3.107';

const String _kLiveDraft =
    'Let\'s start with a quick recap of last week\'s numbers, then';

// ─────────────────────────────────────────────────────────────────────────────

final ValueNotifier<Widget> _stage =
    ValueNotifier<Widget>(const ColoredBox(color: Colors.white));

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // In-memory prefs: nothing this rig does survives the run or touches the
  // simulator's real app container.
  SharedPreferences.setMockInitialValues(<String, Object>{});
  FlowMicTheme.brightness.value = Brightness.light;
  runApp(ValueListenableBuilder<Widget>(
    valueListenable: _stage,
    builder: (BuildContext context, Widget w, _) => w,
  ));
  const String only = String.fromEnvironment('STORE_SHOTS_ONLY');
  for (final _Scene scene in _scenes) {
    if (only.isNotEmpty && !only.split(',').contains(scene.name)) continue;
    try {
      final Widget page = await scene.build();
      FlowMicTheme.brightness.value = Brightness.light;
      _stage.value = KeyedSubtree(key: UniqueKey(), child: page);
      await Future<void>.delayed(_kSettle);
      if (scene.drive != null) {
        await scene.drive!();
        await Future<void>.delayed(const Duration(milliseconds: 1500));
      }
      // ignore: avoid_print
      print('STORESHOT:${scene.name}');
      await Future<void>.delayed(_kHold);
      _feeder?.cancel();
      _feeder = null;
    } catch (e, st) {
      // ignore: avoid_print
      print('STORESHOT_FAIL:${scene.name} $e\n$st');
    }
  }
  // ignore: avoid_print
  print('STORESHOT_DONE');
}

class _Scene {
  const _Scene(this.name, this.build, {this.drive});
  final String name;
  final Future<Widget> Function() build;
  final Future<void> Function()? drive;
}

// ── shared harness ──────────────────────────────────────────────────────────

/// A signed-in account with a neutral sample address (never a real user).
Future<LoginController> _signedIn(PttSession session) async {
  final LoginController login = newTestLogin(
    transport: session.transport,
    accountStore: InMemoryAccountStore(const CloudAccount(
      jwt: 'sample.jwt.token',
      email: _kSampleEmail,
      id: 'user-sample-1',
    )),
  );
  await login.hydrate();
  return login;
}

Future<AppSettingsController> _englishSettings() async {
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController s = AppSettingsController(prefs: prefs);
  await s.load();
  s.setLocale(AppLocale.en);
  // An English-speaking user: the spoken language matches the interface.
  s.setSpokenLang('en');
  return s;
}

/// main.dart's production MaterialApp shape: same ThemeData, same `builder:`
/// layers (TextScaleScope + McpScope), no debug banner.
Widget _app(AppSettingsController settings, Widget home) => MaterialApp(
      title: 'FlowMic',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.light,
        scaffoldBackgroundColor: FlowMicColors.canvas,
        colorSchemeSeed: FlowMicColors.brandDeep,
        useMaterial3: true,
        pageTransitionsTheme: const PageTransitionsTheme(
          builders: <TargetPlatform, PageTransitionsBuilder>{
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          },
        ),
      ),
      builder: (BuildContext context, Widget? page) => TextScaleScope(
        appSettings: settings,
        child: McpScope(
          service: McpService(store: null),
          settings: settings,
          child: page!,
        ),
      ),
      home: home,
    );

MobileSession _pairing() => const MobileSession(
      token: 'tok-sample-abcdefghijklmnopqrstuvwxyz012',
      endpoint: 'ws://192.168.1.23:41999',
      channel: 'standalone',
      pcInstanceId: 'inst-sample-1',
      pairingId: 'pair-sample-1',
      pcId: 'pc-sample-0001',
      pcMachineUid: 'machine-sample-0001',
      pcName: _kPcName,
    );

/// The Notes pairing: what `ConnectionsController.enterCloud` persists after a
/// signed-in `mobile:pair {cloud_instance:true}` (channel 'saas').
MobileSession _notesPairing() => MobileSession(
      token: 'tok-sample-notes-abcdefghijklmnopqrstuv',
      endpoint: resolveSaasEndpoint(),
      channel: 'saas',
      pcInstanceId: 'inst-sample-notes',
      pairingId: 'pair-sample-notes',
      pcId: 'pc-sample-notes',
      pcMachineUid: 'machine-sample-notes',
      pcName: 'Notes',
    );

/// Session owner probe — the chat list narrows to the CONNECTED instance, so
/// seeded rows are stamped through the same probe production uses.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _ChatRig {
  _ChatRig(this.transport, this.recorder, this.controller, this.destination);
  final FakeSocketTransport transport;
  final FakeAudioRecorder recorder;
  final ChatController controller;
  final DestinationController destination;
}

_ChatRig? _lastChat;
Timer? _feeder;

Future<Widget> _chatPage({
  FlowMode mode = FlowMode.realtime,
  List<_Row>? rows,
  bool notes = false,
}) async {
  final AppSettingsController settings = await _englishSettings();
  final FakeSocketTransport transport = FakeSocketTransport();
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: recorder),
  );
  session.applyPairedIdentity(notes ? _notesPairing() : _pairing());
  session.serverChannel.value =
      notes ? ServerChannel.cloudRelay : ServerChannel.lan;
  final TimelineStore store = newTestStore(owner: _SessionOwner(session));
  final DestinationController destination = DestinationController();
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: destination,
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    appSettings: settings,
  );
  await controller.loadSendPolicy();
  if (notes) {
    // connections_page.dart's `_enterChat` funnel does exactly this for the
    // Notes pairing before pushing the chat page.
    destination.configureFixed(fixedRecordOnly: true);
  } else {
    destination.onFocusApp(_kFocusApp);
  }
  if (mode != FlowMode.realtime) controller.setMode(mode);

  int i = 0;
  for (final _Row r in rows ?? _chatRows) {
    final String cid = 'sample-${i++}';
    store.buildFromUtterance(
      clientId: cid,
      mode: FlowMode.realtime,
      delivery: r.inject ? Delivery.inject : Delivery.none,
      text: r.text,
      durationMs: r.durationMs,
    );
    if (r.inject) {
      store.applyInjectResult(
        correlationId: cid,
        ok: true,
        target: InjectTarget(
          windowTitle: _kWindowTitle,
          processName: _kFocusApp,
          injectedAt: DateTime.now().toUtc().toIso8601String(),
        ),
        pcName: _kPcName,
      );
    }
  }
  transport.pushStatus(SocketStatus.connected);
  _lastChat = _ChatRig(transport, recorder, controller, destination);
  return _app(
    settings,
    ChatFlowPage(
      controller: controller,
      appSettings: settings,
      // main_page_builders.dart passes `_connections.activePairingDisplayName`
      // here; for this rig's one pairing that is its pcName.
      deviceNameOverride: notes ? null : _kPcName,
      isCloudInstance: notes,
      isSignedIn: () => true,
    ),
  );
}

class _Row {
  const _Row(this.text, {this.inject = true, this.durationMs});
  final String text;
  final bool inject;
  final int? durationMs;
}

/// iPad 13" portrait leaves half the timeline empty with four rows; the host
/// script sets this for the tablet run so the page carries a realistic history.
const bool _kTall = bool.fromEnvironment('STORE_SHOTS_TALL');

const List<_Row> _kEarlierRows = <_Row>[
  _Row('Agenda for tomorrow: budget review first, then the hiring plan.',
      durationMs: 4100),
  _Row('Please add the customer quotes from last week to the shared doc.',
      durationMs: 3800),
  _Row('The build is green again, so we can start testing the new onboarding '
      'flow this afternoon.',
      durationMs: 5900),
  _Row('Let us keep the meeting to twenty minutes and take questions in the '
      'chat.',
      durationMs: 4400),
];

const List<_Row> _kEarlierNotes = <_Row>[
  _Row('Book to look up later: the one about city gardens.',
      inject: false, durationMs: 3600),
  _Row('Water the plants on Thursday and Sunday.',
      inject: false, durationMs: 2700),
  _Row('Gift idea for the anniversary: a weekend cooking class.',
      inject: false, durationMs: 3300),
];

List<_Row> get _chatRows =>
    <_Row>[if (_kTall) ..._kEarlierRows, ..._kDefaultRows];

const List<_Row> _kDefaultRows = <_Row>[
  _Row('Morning everyone, quick update on the launch checklist before standup.',
      durationMs: 4200),
  _Row(
      'Can we move the design review to Thursday afternoon? I need one more '
      'day to finish the prototype.',
      durationMs: 6400),
  _Row(
      'Reminder for the release notes: mention the new offline mode and the '
      'faster sync.',
      durationMs: 5100),
  _Row(
      'Thanks for the feedback. I will update the slides and send them over '
      'before lunch.',
      durationMs: 4700),
];

// ── element-tree helpers (no flutter_test on a running app) ────────────────

Iterable<Element> _elements() sync* {
  final Element? root = WidgetsBinding.instance.rootElement;
  if (root == null) return;
  final List<Element> stack = <Element>[root];
  while (stack.isNotEmpty) {
    final Element e = stack.removeLast();
    yield e;
    e.visitChildren(stack.add);
  }
}

T? _findWidget<T extends Widget>() {
  for (final Element e in _elements()) {
    if (e.widget is T) return e.widget as T;
  }
  return null;
}

bool _hasText(String needle) {
  for (final Element e in _elements()) {
    final Widget w = e.widget;
    if (w is Text && (w.data ?? w.textSpan?.toPlainText() ?? '') == needle) {
      return true;
    }
  }
  return false;
}

Element? _textElement(String needle) {
  for (final Element e in _elements()) {
    final Widget w = e.widget;
    if (w is Text && (w.data ?? w.textSpan?.toPlainText() ?? '') == needle) {
      return e;
    }
  }
  return null;
}

/// Scroll the page's main list until [needle] is built, then bring it near the
/// top. Lazy lists only build what is near the viewport, hence the stepping.
Future<void> _scrollTo(String needle,
    {double alignment = 0.05, double backoff = 0}) async {
  ScrollableState? scrollable;
  for (final Element e in _elements()) {
    if (e is StatefulElement && e.state is ScrollableState) {
      scrollable = e.state as ScrollableState;
      break;
    }
  }
  if (scrollable == null) throw StateError('no scrollable');
  final ScrollPosition pos = scrollable.position;
  while (!_hasText(needle) && pos.pixels < pos.maxScrollExtent) {
    pos.jumpTo((pos.pixels + 500).clamp(0, pos.maxScrollExtent));
    await Future<void>.delayed(const Duration(milliseconds: 120));
  }
  final Element? target = _textElement(needle);
  if (target == null) throw StateError('"$needle" never built');
  await Scrollable.ensureVisible(target, alignment: alignment);
  if (backoff > 0) pos.jumpTo((pos.pixels - backoff).clamp(0, pos.maxScrollExtent));
}

// ── drives ──────────────────────────────────────────────────────────────────

/// Press the PTT bar through the page's OWN production callback (the same
/// drive speaking_face_test uses), then feed real PCM so the level meter has
/// measured samples, then push an interim the way the server would.
Future<void> _driveRecording() async {
  final _ChatRig rig = _lastChat!;
  final PttBar? bar = _findWidget<PttBar>();
  if (bar == null || bar.onDown == null) {
    throw StateError('PttBar not found');
  }
  unawaited(bar.onDown!());
  await Future<void>.delayed(const Duration(milliseconds: 600));
  if (!rig.controller.isRecording) {
    throw StateError('PTT press was refused; no recording face');
  }
  // Keep audio flowing for the rest of the scene: a recorder that goes quiet
  // is (correctly) flagged by the page as a stalled recorder.
  const List<int> amps = <int>[
    3000, 9000, 16000, 22000, 12000, 6000, 18000, 25000, 9000, 14000, 20000, 7000
  ];
  int k = 0;
  _feeder?.cancel();
  _feeder = Timer.periodic(const Duration(milliseconds: 200), (_) {
    rig.recorder.feed(makePcm(kChunkBytes, amplitude: amps[k++ % amps.length]));
  });
  await Future<void>.delayed(const Duration(milliseconds: 1200));
  rig.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
    'text': _kLiveDraft,
    'confidence': 0.9,
    'language': 'en',
    'segment_idx': 0,
  });
}

// ── other pages ─────────────────────────────────────────────────────────────

Future<Widget> _disclosurePage() async {
  final AppSettingsController settings = await _englishSettings();
  return _app(settings, DataFlowDisclosurePage(appSettings: settings));
}

Future<Widget> _settingsPage() async {
  final AppSettingsController settings = await _englishSettings();
  final PttSession session = newTestSession(
    transport: FakeSocketTransport(),
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  final LoginController login = await _signedIn(session);
  final ScenarioCardController scenario =
      ScenarioCardController(cache: InMemoryScenarioCardCache());
  await scenario.load();
  return _app(
    settings,
    SettingsPage(
      notesAction: SettingsNotesAction.enter,
      scenario: scenario,
      appSettings: settings,
      login: login,
      destination: DestinationController(),
      session: session,
      portable: newTestPortableController(),
      prefs: newTestPrefsController(),
      backup: newTestSettingsBackup(),
      inventory: newTestInventory(
        rows: const <TimelineEntry>[],
        images: InMemoryOutboxBlobStore(),
      ),
      timeline: newTestStore(),
      version: const FixedAppVersion(_kVersion),
      update: newTestUpdateController(),
      cloudSummary: newTestCloudSummary(login: login),
    ),
  );
}

Future<HealthReading> _probeLan(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.lan);
Future<PcPresenceReading> _presenceOnline(Uri u, String t, Duration d) async =>
    const PcPresenceReading(presence: PcPresence.online);

Future<Widget> _connectionsPage() async {
  final AppSettingsController settings = await _englishSettings();
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_pairing());
  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    micPermission: newTestMicPermission(),
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = await _signedIn(session);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _probeLan,
    presenceReader: _presenceOnline,
  );
  return _app(
    settings,
    ConnectionsPage(
      connections: connections,
      appSettings: settings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const SizedBox.shrink(),
      settingsPageBuilder: () => const SizedBox.shrink(),
      historyPageBuilder: () => const SizedBox.shrink(),
      updateListenable: ValueNotifier<bool>(false),
      hasUpdate: () => false,
    ),
  );
}

Future<Widget> _onboardingPage() async {
  final AppSettingsController settings = await _englishSettings();
  return _app(settings, FirstRunOnboardingPage(appSettings: settings));
}

// ── the scene list (order = App Store order) ────────────────────────────────

Future<Widget> _chatDefault() => _chatPage();

Future<Widget> _notesTimeline() => _chatPage(notes: true, rows: <_Row>[
      if (_kTall) ..._kEarlierNotes,
      const _Row('Ideas for the weekend trip: book the cabin, check the ferry '
          'times, pack the camera.',
          inject: false, durationMs: 5600),
      const _Row('Grocery list: oat milk, lemons, coffee beans and something '
          'for Sunday dinner.',
          inject: false, durationMs: 4300),
      const _Row('Call the dentist on Monday to move the appointment to next '
          'week.',
          inject: false, durationMs: 3900),
      const _Row('Podcast idea: ask three friends how they plan a week without '
          'a calendar.',
          inject: false, durationMs: 5200),
    ]);

Future<Widget> _chatRecordOnly() => _chatPage(rows: <_Row>[
      if (_kTall) ..._kEarlierNotes,
      const _Row('Ideas for the weekend trip: book the cabin, check the ferry times, '
          'pack the camera.',
          inject: false, durationMs: 5600),
      const _Row('Grocery list: oat milk, lemons, coffee beans and something for '
          'Sunday dinner.',
          inject: false, durationMs: 4300),
      const _Row('Call the dentist on Monday to move the appointment to next week.',
          inject: false, durationMs: 3900),
    ]);

Future<void> _driveRecordOnly() async => _lastChat!.destination.setRecordOnly();

/// Bring the language block (interface language, then spoken language) to the
/// top, with its section header still in view.
Future<void> _driveSettingsLanguage() =>
    _scrollTo('Language', alignment: 0, backoff: 40);

const List<_Scene> _scenes = <_Scene>[
  _Scene('01-recording', _chatDefault, drive: _driveRecording),
  _Scene('02-notes', _notesTimeline),
  _Scene('03-delivered', _chatDefault),
  _Scene('04-record-only', _chatRecordOnly, drive: _driveRecordOnly),
  _Scene('05-devices', _connectionsPage),
  _Scene('06-where-words-go', _disclosurePage),
  _Scene('07-settings-language', _settingsPage, drive: _driveSettingsLanguage),
  _Scene('08-onboarding', _onboardingPage),
];
