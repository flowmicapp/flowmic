// STORE-LISTING SCREENSHOT RIG — THIS IS NOT A TEST.
//
// Renders the REAL mobile pages with clean, invented sample data and writes
// one PNG per (device profile x scene) for the store listings (Play tablet 7"
// and 10", App Store iPhone 6.9" and iPad 13"). Run explicitly:
//
//     flutter test test/store_shots.dart
//
// No `_test` suffix on purpose (same reason as wp8_parity_shots.dart: a
// file-writing screenshot job must not join everybody's suite run).
//
// Rules this rig obeys (docs/strategy/2026-08-19-store-listing-metadata-draft.md
// section 3): the phone UI is the subject; every word on screen is what the
// product renders for that state (strings come from AppStrings, locale = en);
// sample content is invented (computer "Work Laptop", target app
// "Text Editor"), never a real PC name, account or timeline.
//
// Font substrate: flutter_test renders Ahem by default. This rig loads the
// app's FontManifest (Material icons) and Roboto from the Flutter SDK's own
// material_fonts cache under the family `Roboto` (what Material's Typography
// names on Android), plus host CJK/Korean faces as fallback for the native
// language names in the settings list. Shadows are re-enabled per frame.
//
// Profiles (see _profiles): Play phone 1080x1920 (360x640dp), Play 7"
// 1080x1920 and 10" 1440x2560 (9:16, the
// only portrait ratio Play accepts for large screens), App Store iPhone 6.9"
// 1320x2868 and iPad 13" 2064x2752. English UI and English spoken language;
// light theme; text-size tier at its default (factor 1.00).
//
// Output: FLOWMIC_STORE_SHOT_DIR, else <repo>/scratch/store-shots (ignored).
// PNGs come out RGBA straight from the engine (the 7" frame is one pixel
// taller than 1920 because 1066.7dp x 1.8 rounds up); flattening to RGB and
// the final crop are a post-processing step outside this file — Play and the
// App Store both reject alpha.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/link/pair_link_router.dart' show IncomingLinks;
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart' show TimelineStorageKind;
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:url_launcher/url_launcher.dart' show LaunchMode;
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flowmic/src/ui/compose_band.dart' show SendPolicyChip;
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flowmic/src/ui/mode_chip.dart'
    show ModeSegmentedControl, kModeOrder;
import 'package:mobile_scanner/mobile_scanner.dart' show MobileScannerPlatform;
import 'package:flowmic/src/ui/data_flow_disclosure_page.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flowmic/src/ui/onboarding/first_run_onboarding_page.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart'
    show RenderParagraph, RenderRepaintBoundary;
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';
import 'support/mobile_scanner_fake.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

const Key _rootKey = ValueKey<String>('store.shot.root');
final List<String> _log = <String>[];

// ── device profiles ─────────────────────────────────────────────────────────

class _Profile {
  const _Profile(this.id, this.physW, this.physH, this.dpr,
      {required this.padTop, required this.padBottom, required this.platform});
  final String id;
  final int physW;
  final int physH;
  final double dpr;
  final double padTop; // logical
  final double padBottom; // logical
  final TargetPlatform platform;
}

const List<_Profile> _profiles = <_Profile>[
  // Play phone: 1080x1920 at density 3 ⇒ 360 x 640 dp — the narrowest
  // common Android width, so this is where row 1 of the dock is tightest.
  _Profile('play-phone', 1080, 1920, 3.0,
      padTop: 24, padBottom: 16, platform: TargetPlatform.android),
  // Play 7" tablet: 9:16, 1080x1920 at 1.8 ⇒ 600 x 1066.7 dp.
  _Profile('play-tablet-7', 1080, 1920, 1.8,
      padTop: 24, padBottom: 24, platform: TargetPlatform.android),
  // Play 10" tablet: 9:16, 1440x2560 at 1.8 ⇒ 800 x 1422.2 dp.
  _Profile('play-tablet-10', 1440, 2560, 1.8,
      padTop: 24, padBottom: 24, platform: TargetPlatform.android),
  // App Store iPhone 6.9": 1320x2868 at 3 ⇒ 440 x 956 pt.
  _Profile('appstore-iphone-6.9', 1320, 2868, 3.0,
      padTop: 62, padBottom: 34, platform: TargetPlatform.iOS),
  // App Store iPad 13": 2064x2752 at 2 ⇒ 1032 x 1376 pt.
  _Profile('appstore-ipad-13', 2064, 2752, 2.0,
      padTop: 24, padBottom: 20, platform: TargetPlatform.iOS),
];

String get _outDirPath {
  final String? o = Platform.environment['FLOWMIC_STORE_SHOT_DIR'];
  if (o != null && o.isNotEmpty) return o;
  return '${Directory.current.path}/../../scratch/store-shots';
}

// ── fonts ───────────────────────────────────────────────────────────────────

const String _kLatin = 'Roboto';
const String _kCjk = 'StoreRigCJK';
const String _kKr = 'StoreRigKR';
const String _kSym = 'StoreRigSym';

Future<void> _loadManifestFonts() async {
  final String raw = await rootBundle.loadString('FontManifest.json');
  for (final dynamic entry in json.decode(raw) as List<dynamic>) {
    final Map<String, dynamic> font =
        (entry as Map<Object?, Object?>).cast<String, dynamic>();
    final String declared = font['family'] as String;
    final String family =
        declared.startsWith('packages/') ? declared.split('/').last : declared;
    final FontLoader loader = FontLoader(family);
    for (final dynamic f in font['fonts'] as List<dynamic>) {
      loader.addFont(
          rootBundle.load((f as Map<Object?, Object?>)['asset']! as String));
    }
    await loader.load();
    _log.add('font: bundle family "$family"');
  }
}

Future<void> _loadFile(String family, List<String> paths) async {
  final FontLoader loader = FontLoader(family);
  int n = 0;
  for (final String p in paths) {
    final File f = File(p);
    if (!f.existsSync()) {
      _log.add('font: MISSING $p');
      continue;
    }
    final Uint8List b = await f.readAsBytes();
    loader.addFont(Future<ByteData>.value(
        ByteData.view(b.buffer, b.offsetInBytes, b.length)));
    n++;
  }
  await loader.load();
  _log.add('font: family "$family" ← $n file(s)');
}

String get _materialFontsDir {
  final String? root = Platform.environment['FLUTTER_ROOT'];
  if (root != null && root.isNotEmpty) {
    return '$root/bin/cache/artifacts/material_fonts';
  }
  // flutter_tester lives under <root>/bin/cache/artifacts/engine/...
  final String exe = Platform.resolvedExecutable.replaceAll(r'\', '/');
  final int at = exe.indexOf('/bin/cache/');
  if (at > 0) return '${exe.substring(0, at)}/bin/cache/artifacts/material_fonts';
  throw StateError('cannot locate the Flutter SDK material_fonts cache');
}

Future<void> _loadFonts() async {
  await _loadManifestFonts();
  final String m = _materialFontsDir;
  await _loadFile(_kLatin, <String>[
    '$m/roboto-regular.ttf',
    '$m/roboto-medium.ttf',
    '$m/roboto-bold.ttf',
    '$m/roboto-light.ttf',
    '$m/roboto-italic.ttf',
    '$m/roboto-black.ttf',
    '$m/roboto-thin.ttf',
  ]);
  await _loadFile(_kCjk, <String>[r'C:\Windows\Fonts\Deng.ttf']);
  await _loadFile(_kKr, <String>[r'C:\Windows\Fonts\malgun.ttf']);
  await _loadFile(_kSym, <String>[r'C:\Windows\Fonts\seguisym.ttf']);
}

ThemeData _theme(Brightness b) => ThemeData(
      brightness: b,
      scaffoldBackgroundColor: FlowMicColors.canvas,
      colorSchemeSeed: FlowMicColors.brandDeep,
      useMaterial3: true,
      fontFamily: _kLatin,
      fontFamilyFallback: const <String>[_kCjk, _kKr, _kSym],
    );

// ── harness ─────────────────────────────────────────────────────────────────

void _applyProfile(WidgetTester tester, _Profile p) {
  tester.view.physicalSize = Size(p.physW.toDouble(), p.physH.toDouble());
  tester.view.devicePixelRatio = p.dpr;
  final FakeViewPadding pad =
      FakeViewPadding(top: p.padTop * p.dpr, bottom: p.padBottom * p.dpr);
  tester.view.padding = pad;
  tester.view.viewPadding = pad;
  addTearDown(tester.view.reset);
}

Future<void> _settleish(WidgetTester tester, {int frames = 6}) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

Widget _app(Widget home, {Brightness b = Brightness.light}) => RepaintBoundary(
      key: _rootKey,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: _theme(b),
        home: home,
      ),
    );

Future<void> _shoot(WidgetTester tester, _Profile p, String scene) async {
  await _settleish(tester);
  final RenderRepaintBoundary boundary =
      tester.renderObject<RenderRepaintBoundary>(find.byKey(_rootKey));
  await tester.runAsync(() async {
    final ui.Image image = await boundary.toImage(pixelRatio: p.dpr);
    final ByteData? png =
        await image.toByteData(format: ui.ImageByteFormat.png);
    final Directory dir = Directory('$_outDirPath/${p.id}');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    final File out = File('${dir.path}/$scene.png');
    await out.writeAsBytes(png!.buffer.asUint8List(), flush: true);
    _log.add('shot: ${p.id}/$scene.png ${image.width}x${image.height}');
    image.dispose();
  });
}

void _frame(String name, Future<void> Function(WidgetTester, _Profile) body) {
  for (final _Profile p in _profiles) {
    testWidgets('$name @ ${p.id}', (WidgetTester tester) async {
      debugDisableShadows = false;
      debugDefaultTargetPlatformOverride = p.platform;
      try {
        _applyProfile(tester, p);
        await body(tester, p);
      } finally {
        debugDisableShadows = true;
        debugDefaultTargetPlatformOverride = null;
      }
    });
  }
}

Future<AppSettingsController> _settings() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController s = AppSettingsController(prefs: prefs);
  await s.load();
  s.setLocale(AppLocale.en);
  // English UI and English spoken language (the listing is en-US).
  s.setSpokenLang('en');
  return s;
}

// ── sample content (invented) ───────────────────────────────────────────────

const String _kPcName = 'Work Laptop';
const String _kTargetApp = 'Text Editor';
const String _kTargetWindow = 'Weekly update';

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._s);
  final PttSession _s;
  @override
  String? get instanceId => _s.connectedInstanceId;
  @override
  String? get instanceName => _s.pcDisplayName;
}

/// The instance the rows were spoken to — what the chat page stamps through
/// the connected session (see _SessionOwner); the history page reads it back.
class _FixedOwner implements InstanceOwnerProbe {
  const _FixedOwner();
  @override
  String? get instanceId => 'inst-store-1';
  @override
  String? get instanceName => _kPcName;
}

class _NoLinks implements IncomingLinks {
  @override
  Stream<Uri> get stream => const Stream<Uri>.empty();
  @override
  Future<Uri?> initialLink() async => null;
}

class _ChatRig {
  _ChatRig(this.transport, this.recorder, this.controller, this.store);
  final FakeSocketTransport transport;
  final FakeAudioRecorder recorder;
  final ChatController controller;
  final TimelineStore store;
}

MobileSession _pairing() => const MobileSession(
      token: 'tok-store-shot-000000000000000000000',
      endpoint: 'http://192.168.1.20:41879',
      channel: 'standalone',
      pcInstanceId: 'inst-store-1',
      pairingId: 'pair-store-1',
      pcId: 'pc-store-0001',
      pcMachineUid: 'machine-store-0001',
      pcName: _kPcName,
    );

class _Row {
  const _Row(this.text,
      {this.mode = FlowMode.realtime, this.durationMs, this.sourceLang});
  final String text;
  final FlowMode mode;
  final int? durationMs;
  final String? sourceLang;
}

const List<_Row> _kChatRows = <_Row>[
  _Row('Morning! Here is where the launch checklist stands.', durationMs: 3400),
  _Row('Hi team, quick update on the launch checklist before tomorrow\'s call.',
      durationMs: 5200),
  _Row('Agenda for Friday: design review, budget check, and next steps for '
      'the beta.',
      mode: FlowMode.organize, durationMs: 9800),
  _Row('The new onboarding screens are done and ready for review.',
      durationMs: 4100),
  _Row('Can we move the client call to 3 pm on Thursday?',
      mode: FlowMode.translate, durationMs: 4700, sourceLang: 'es'),
  _Row('Please send me your notes by Thursday so I can merge them into one doc.',
      durationMs: 5600),
];

/// Tall canvases (tablets) get a few earlier rows so the timeline reads like
/// a morning of use instead of three rows floating at the bottom.
const List<_Row> _kEarlierRows = <_Row>[
  _Row('Remind me to book the meeting room for the demo.', durationMs: 3100),
  _Row('Draft reply: thanks for the feedback, I will share the updated slides '
      'this afternoon.',
      durationMs: 6900),
  _Row('Shopping list for the offsite: coffee, snacks, name badges and '
      'extension cords.',
      mode: FlowMode.organize, durationMs: 7200),
  _Row('The budget spreadsheet is up to date as of this morning.',
      durationMs: 3900),
];

List<_Row> _rowsFor(_Profile p) =>
    p.physH / p.dpr > 1000 ? <_Row>[..._kEarlierRows, ..._kChatRows] : _kChatRows;

TimelineStore _seedStore(TimelineStore store, List<_Row> rows, String prefix) {
  for (int i = 0; i < rows.length; i++) {
    final _Row r = rows[i];
    final String cid = '$prefix-$i';
    store.buildFromUtterance(
      clientId: cid,
      mode: r.mode,
      delivery: Delivery.inject,
      text: r.text,
      durationMs: r.durationMs,
      sourceLang: r.sourceLang,
    );
    store.applyInjectResult(
      correlationId: cid,
      ok: true,
      pcName: _kPcName,
      target: InjectTarget(
        windowTitle: _kTargetWindow,
        processName: _kTargetApp,
        injectedAt: DateTime.now().toUtc().toIso8601String(),
      ),
    );
  }
  return store;
}

Future<_ChatRig> _pumpChat(
  WidgetTester tester, {
  List<_Row> rows = _kChatRows,
  bool syncTeardown = false,
  SendPolicy policy = SendPolicy.direct,
}) async {
  FlowMicTheme.brightness.value = Brightness.light;
  addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  final AppSettingsController appSettings = await _settings();

  final FakeSocketTransport transport = FakeSocketTransport();
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: recorder),
  );
  session.applyPairedIdentity(_pairing());
  final TimelineStore store = newTestStore(owner: _SessionOwner(session));
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
  );
  if (syncTeardown) {
    addTearDown(() {
      unawaited(controller.dispose());
      controller.destination.dispose();
      store.dispose();
    });
  } else {
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      store.dispose();
      await session.dispose();
      await transport.close();
    });
  }
  await controller.loadSendPolicy();

  _seedStore(store, rows, 'store-row');


  transport.pushStatus(SocketStatus.connected);
  // What the probe (ptt_channel_probe.dart) writes after a LAN health check.
  session.serverChannel.value = ServerChannel.lan;
  // main_page_builders.dart `_buildChat` passes these; the header needs the
  // pairing's display name (deviceNameOverride) and a back handler to paint
  // the same header production paints.
  await tester.pumpWidget(_app(ChatFlowPage(
    controller: controller,
    appSettings: appSettings,
    deviceNameOverride: _kPcName,
    onBack: () {},
    onOpenSettings: () {},
    isSignedIn: () => true,
  )));
  await _settleish(tester);
  transport.pushIncoming(FlowMicEvents.focusState, <String, Object?>{
    'window_title': _kTargetWindow,
    'process_name': _kTargetApp,
  });
  await _settleish(tester);
  return _ChatRig(transport, recorder, controller, store);
}

Future<void> _holdPtt(WidgetTester tester, _ChatRig rig) async {
  final PttBar bar = tester.widget<PttBar>(find.byType(PttBar));
  unawaited(bar.onDown!());
  await tester.pump();
  await tester.pump();
  expect(rig.controller.isRecording, isTrue, reason: 'pre-state: PTT refused');
}

Future<void> _feed(WidgetTester tester, _ChatRig rig, List<int> amps) async {
  for (final int a in amps) {
    rig.recorder.feed(makePcm(kChunkBytes, amplitude: a));
    await tester.pump();
  }
  await tester.pump(const Duration(milliseconds: 250));
}

// ── dock row-1 ruler (idle frame) ───────────────────────────────────────────

/// Prints what the idle frame's dock row 1 actually painted: each mode word's
/// painted width against the width it needs (RenderParagraph, the D-15
/// criterion), whether the send-policy chip is the full or the glyph-only
/// face and on which line, and the PC key-group label's line count. A ruler
/// under THIS rig's fonts (Roboto from the Flutter SDK), not a device's.
void _measureRowOne(WidgetTester tester, _Profile p) {
  final AppStrings strings = AppStrings.of(AppLocale.en);
  final Finder policy = find.byKey(const ValueKey<String>('compose.policy'));
  final Finder control = find.byType(ModeSegmentedControl);
  final List<String> modes = <String>[];
  for (final FlowMode m in kModeOrder) {
    final Finder text = find.descendant(
      of: find.byKey(ValueKey<String>('compose.mode.${m.name}')),
      matching: find.byType(RichText),
    );
    final RenderParagraph para = tester.renderObject<RenderParagraph>(text);
    modes.add('${strings.modeLabel(m)} '
        '${para.size.width.toStringAsFixed(1)}/'
        '${para.getMaxIntrinsicWidth(double.infinity).toStringAsFixed(1)}dp'
        '${para.didExceedMaxLines ? ' CLIPPED' : ''}');
  }
  final RenderParagraph chipText = tester.renderObject<RenderParagraph>(
      find.descendant(of: policy, matching: find.byType(RichText)));
  final Rect chip = tester.getRect(policy);
  final Rect seg = tester.getRect(control);
  final double bill = ModeSegmentedControl.naturalWidth(
      tester.element(control), strings, FlowMode.realtime);
  final double full =
      SendPolicyChip.naturalWidth(tester.element(control), strings);
  final bool sameLine = (chip.center.dy - seg.center.dy).abs() < 8;
  final Finder label =
      find.byKey(const ValueKey<String>('compose.keys.groupLabel'));
  String pc = 'absent';
  if (label.evaluate().isNotEmpty) {
    final RenderParagraph lp = tester.renderObject<RenderParagraph>(
        find.descendant(of: label, matching: find.byType(RichText)).first);
    final String t = lp.text.toPlainText();
    final int lines = lp
        .getBoxesForSelection(TextSelection(baseOffset: 0, extentOffset: t.length))
        .map((TextBox b) => b.top.round())
        .toSet()
        .length;
    pc = '"$t" lines=$lines';
  }
  _log.add('ROW1 ${p.id}: width=${(p.physW / p.dpr).toStringAsFixed(1)}dp '
      'modes=[${modes.join(', ')}] '
      'segmentsBill=${bill.toStringAsFixed(1)}dp '
      'segmentsBox=${seg.left.toStringAsFixed(1)}..${seg.right.toStringAsFixed(1)} '
      'chip="${chipText.text.toPlainText()}" '
      '${chipText.text.toPlainText() == '⇄' ? 'glyph-only' : 'full'}/'
      '${sameLine ? 'same line' : 'own line'} '
      'chipBox=${chip.left.toStringAsFixed(1)}..${chip.right.toStringAsFixed(1)} '
      'fullChipBill=${full.toStringAsFixed(1)}dp '
      'pcLabel=$pc');
}

// ── connections page ─────────────────────────────────────────────────────

Future<ConnectionsController> _pumpConnections(WidgetTester tester) async {
  FlowMicTheme.brightness.value = Brightness.light;
  addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  final AppSettingsController appSettings = await _settings();
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_pairing().copyWith(
      lastConnectedAt: DateTime.now().subtract(const Duration(minutes: 3))));
  final FakeSocketTransport t = FakeSocketTransport();
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: (Uri u, Duration d) async =>
        const HealthReading(ok: true, channel: ServerChannel.lan),
    presenceReader: (Uri u, String tk, Duration d) async =>
        const PcPresenceReading(presence: PcPresence.online),
  );
  await tester.pumpWidget(_app(ConnectionsPage(
    connections: connections,
    appSettings: appSettings,
    login: login,
    destination: DestinationController(),
    chatPageBuilder: () => const SizedBox.shrink(),
    settingsPageBuilder: () => const SizedBox.shrink(),
    historyPageBuilder: () => const SizedBox.shrink(),
    updateListenable: ValueNotifier<bool>(false),
    hasUpdate: () => false,
    incomingLinks: _NoLinks(),
  )));
  for (int i = 0; i < 10; i++) {
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 100));
  }
  return connections;
}

// ── scenes ──────────────────────────────────────────────────────────────────

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await _loadFonts();
    Directory(_outDirPath).createSync(recursive: true);
  });

  tearDownAll(() {
    for (final String l in _log) {
      // ignore: avoid_print
      print('[store-shot] $l');
    }
  });

  _frame('01 recording', (WidgetTester tester, _Profile p) async {
    final _ChatRig rig =
        await _pumpChat(tester, rows: _rowsFor(p), syncTeardown: true);
    await _holdPtt(tester, rig);
    rig.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': 'Let\'s move the design review to Friday morning and',
      'confidence': 0.9,
      'language': 'en',
      'segment_idx': 0,
    });
    await tester.pump();
    // The elapsed readout is a real wall clock (recording_telemetry.dart);
    // let a few real seconds pass so the timer reads like a real take.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 4300)));
    await _feed(tester, rig, <int>[
      900, 4000, 12000, 20000, 8000, 2000, 15000, 25000, 5000, 18000, 3000,
      11000, 22000, 7000,
    ]);
    await _shoot(tester, p, '01-recording');
    unawaited(rig.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    rig.controller.session.debugStopIdlePresencePoll();
  });

  _frame('02 idle', (WidgetTester tester, _Profile p) async {
    final _ChatRig rig = await _pumpChat(tester, rows: _rowsFor(p));
    _measureRowOne(tester, p);
    await _shoot(tester, p, '02-idle');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  _frame('03 record only', (WidgetTester tester, _Profile p) async {
    final _ChatRig rig = await _pumpChat(tester, rows: _rowsFor(p));
    rig.controller.destination.setRecordOnly();
    await _settleish(tester);
    await _shoot(tester, p, '03-record-only');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  _frame('04 history', (WidgetTester tester, _Profile p) async {
    FlowMicTheme.brightness.value = Brightness.light;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
    final AppSettingsController appSettings = await _settings();
    final TimelineStore store =
        _seedStore(newTestStore(owner: const _FixedOwner()), _rowsFor(p), 'hist');
    addTearDown(store.dispose);
    await tester.pumpWidget(_app(HistoryPage(
      store: store,
      storageKind: TimelineStorageKind.sqlite,
      appSettings: appSettings,
    )));
    await _settleish(tester);
    await _shoot(tester, p, '04-history');
  });

  _frame('05 disclosure', (WidgetTester tester, _Profile p) async {
    FlowMicTheme.brightness.value = Brightness.light;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
    final AppSettingsController appSettings = await _settings();
    await tester.pumpWidget(_app(DataFlowDisclosurePage(
      appSettings: appSettings,
      urlLauncher: (Uri url, {required LaunchMode mode}) async => true,
    )));
    await _settleish(tester);
    await _shoot(tester, p, '05-disclosure');
  });

  _frame('06 connections', (WidgetTester tester, _Profile p) async {
    await _pumpConnections(tester);
    await _shoot(tester, p, '06-connections');
  });

  _frame('06b pairing sheet', (WidgetTester tester, _Profile p) async {
    MobileScannerPlatform.instance = FakeMobileScannerPlatform();
    final ConnectionsController connections = await _pumpConnections(tester);
    final AppStrings s = AppStrings.of(AppLocale.en);
    // What connections_page.dart `_add()` passes: the last pairing's address
    // (or the relay when there is none). The camera flow is the test double
    // (the production port never resolves under flutter_test); the shot is
    // the manual tab because a camera preview cannot be rendered here.
    unawaited(showAddPairingSheet(
      tester.element(find.byType(ConnectionsPage)),
      controller: connections,
      strings: s,
      initialEndpoint: _pairing().endpoint,
      cameraPermission: newTestCameraPermission(),
    ));
    await _settleish(tester, frames: 30);
    await tester.tap(find.text(s.pairTabManual));
    await _settleish(tester, frames: 30);
    await _shoot(tester, p, '06b-pairing');
  });

  _frame('07 settings', (WidgetTester tester, _Profile p) async {
    FlowMicTheme.brightness.value = Brightness.light;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
    final AppSettingsController appSettings = await _settings();
    final ScenarioCardController scenario =
        ScenarioCardController(cache: InMemoryScenarioCardCache());
    await scenario.load();
    final PttSession session = newTestSession(
      transport: FakeSocketTransport(),
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    final LoginController login = newTestLogin(transport: session.transport);
    // The STORE builds' updater flags (apps/mobile/Makefile): the Play build
    // has no FLOWMIC_SELF_UPDATE and no notify flag ⇒ "no in-app updater";
    // the App Store build is `--dart-define=FLOWMIC_UPDATE_NOTIFY=1` ⇒ the
    // notify-only card, shown after one successful check.
    final bool ios = p.platform == TargetPlatform.iOS;
    final UpdateController update = newTestUpdateController(
      version: const FixedAppVersion('0.3.102'),
      selfUpdateEnabled: false,
      notifyOnlyEnabled: ios,
      checker: ({required String? currentVersion}) async =>
          UpdateCheckResult(UpdateCheckOutcome.upToDate,
              latestVersion: '0.3.102',
              comparedAt: DateTime.now()
                  .subtract(const Duration(minutes: 2))),
    );
    await tester.runAsync(() async {
      await update.load();
      if (ios) await update.checkNow();
    });
    await tester.pumpWidget(_app(SettingsPage(
      notesAction: SettingsNotesAction.enter,
      scenario: scenario,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      session: session,
      portable: newTestPortableController(),
      prefs: newTestPrefsController(),
      backup: newTestSettingsBackup(),
      inventory: newTestInventory(
          rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
      timeline: newTestStore(),
      version: const FixedAppVersion('0.3.102'),
      update: update,
      cloudSummary: newTestCloudSummary(login: login),
    )));
    await _settleish(tester);
    // The shot is about the language rows (section 3 #7): bring the
    // preferences card to the top, leaving its section header in view.
    final Finder lang = find.text(AppStrings.of(AppLocale.en).uiLanguage);
    final ScrollableState main = tester
        .stateList<ScrollableState>(find.byType(Scrollable))
        .where((ScrollableState st) => st.position.axis == Axis.vertical)
        .reduce((ScrollableState a, ScrollableState b) =>
            a.position.maxScrollExtent >= b.position.maxScrollExtent ? a : b);
    for (int i = 0; i < 40 && lang.evaluate().isEmpty; i++) {
      main.position.jumpTo((main.position.pixels + 300)
          .clamp(0.0, main.position.maxScrollExtent));
      await tester.pump();
    }
    expect(lang, findsWidgets, reason: 'pre-state: language row never built');
    final BuildContext ctx = tester.element(lang.first);
    await tester.runAsync(() => Scrollable.ensureVisible(ctx));
    await tester.pump();
    main.position.jumpTo((main.position.pixels - 44)
        .clamp(0.0, main.position.maxScrollExtent));
    await _settleish(tester);
    await _shoot(tester, p, '07-settings');
  });

  _frame('08 onboarding', (WidgetTester tester, _Profile p) async {
    FlowMicTheme.brightness.value = Brightness.light;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
    final AppSettingsController appSettings = await _settings();
    await tester
        .pumpWidget(_app(FirstRunOnboardingPage(appSettings: appSettings)));
    await _settleish(tester, frames: 30);
    await _shoot(tester, p, '08-onboarding');
  });
}
