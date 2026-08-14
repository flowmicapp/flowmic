// WP8 ACCEPTANCE RIG — THIS IS NOT A TEST.
//
// It renders the REAL ChatFlowPage in a list of named states and writes a PNG
// per state. It asserts almost nothing: the only `expect`s here are PRE-STATE
// guards ("the drive actually landed, so the frame I am about to photograph is
// the frame I claim it is"). Nothing here defends a design decision — the
// visual judgement is the coordinator's, made by putting these PNGs beside the
// Plan A′ mock (docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md
// §4, and the boards in docs/FlowMic 转录页三方案交付/).
//
// 🔴 THE FILENAME HAS NO `_test` SUFFIX ON PURPOSE. `flutter test` discovers
// `*_test.dart`; this file is invoked EXPLICITLY:
//
//     flutter test test/wp8_parity_shots.dart
//
// Adding the suffix would put a slow, file-writing, screenshot-producing job
// into everybody's suite run, and a rig that writes 16 PNGs on every `flutter
// test` is a rig that gets deleted.
//
// ── WHERE THE DRIVES COME FROM ──────────────────────────────────────────────
// Every state below is reached through a sequence LIFTED from an existing
// acceptance test, not invented here — a rig that photographs a state the
// product cannot actually be in is worse than no rig:
//   dock_faces_test.dart      `_pumpPage` (FakeSocketTransport + newTestSession
//                              + giveSessionAPairedIdentity + ChatController +
//                              pushStatus(connected)); the policy-flash tap.
//   sheet_faces_test.dart     the A-07 append drive (SheetAppendButton.onDown
//                              driven directly + a pushed stt:interim) and the
//                              A-08 applied face (startAiCompose + compose:done
//                              echoing the emitted request_id).
//   edit_sheet_test.dart      manual-finalize auto-open (setBuffer) and the
//                              typed-header open (preview tap + two pumps).
//   speaking_face_test.dart   `PttBar.onDown` driven unawaited + pumps.
//   ptt_caption_test.dart     the record-only (`destination.setRecordOnly`) and
//                              disconnected (`connected: false`) states.
//
// ⚠️ TEARDOWN. Any case that leaves a LIVE CAPTURE running must tear down
// SYNCHRONOUSLY (`unawaited(controller.dispose())`) — awaiting dispose() with a
// capture open is unresolvable inside testWidgets' FakeAsync zone and the
// symptom is a hang, not an error. That scar is documented at
// sheet_faces_test.dart:145 and speaking_face_test.dart:128; this file obeys it
// rather than re-earning it.
//
// ⚠️ EACH FRAME IS ITS OWN `testWidgets`. A rig where one broken drive sinks
// the other fifteen photographs is a rig that produces nothing on the day it is
// needed most. The PNG is written BEFORE any wind-down, so even a case that
// dies in teardown still leaves its frame on disk.
//
// ── THE TWO THINGS THAT MAKE THE PIXELS MEAN ANYTHING ───────────────────────
// (1) REAL FONTS. `flutter_test`'s default font is Ahem — every glyph is a
//     solid filled em square. A screenshot rig running under Ahem photographs
//     black boxes and tells you nothing about a design whose whole subject is
//     type. `setUpAll` loads (a) everything in the app's own FontManifest
//     (this is what gets MaterialIcons rendering as icons instead of tofu) and
//     (b) Segoe UI + SimHei from C:\Windows\Fonts, BOTH under the family
//     `Roboto`, because that is the family Material's Typography actually names
//     on the Android target the tests run as. The first case is a PROBE that
//     measures whether that worked and prints the numbers — see `_fontReport`.
// (2) REAL SHADOWS. `flutter_test` sets `debugDisableShadows = true`, which
//     paints every BoxShadow as a hard un-blurred rectangle. The dock's top
//     line, the sheet's upward lift and the segment's 1dp lift are all shadow
//     decisions in the contract, so the rig turns it back off.
//
// The MaterialApp wrapper mirrors main.dart's production ThemeData (brightness
// + `scaffoldBackgroundColor: FlowMicColors.canvas` + `colorSchemeSeed:
// FlowMicColors.brandDeep` + M3) rather than the bare `MaterialApp(home: …)`
// the mechanics tests use. For a MECHANICS test the bare wrapper is right (less
// to go wrong); for a PHOTOGRAPH it would be a second theme nobody ships.
//
// Output: scratch/wp8-parity/*.png at the repo root (override with
// FLOWMIC_WP8_SHOT_DIR). Everything is captured at pixelRatio 3 from a
// RepaintBoundary wrapped around the whole app, at 360x780 logical — except
// `atab-idle`, which is 560 wide because that is where the dock re-columns.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart' show md5;
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart' show SessionState;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
// `ComposeTask` / `kAiComposeTasks` arrive with chat_flow_page.dart's own
// exports — importing ai_action_row.dart directly is flagged unused.
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const Key _rootKey = ValueKey<String>('wp8.shot.root');

final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));
final Finder _previewTap =
    find.byKey(const ValueKey<String>('compose.preview.tap'));
final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));

/// Lines printed at the end of the run so the operator can read what the rig
/// actually managed to do (fonts loaded, frames written, frames degraded).
final List<String> _log = <String>[];

/// png digest → the frame that wrote it. See the duplicate detector in [_shoot].
final Map<String, String> _digests = <String, String>{};

// ── output directory ────────────────────────────────────────────────────────
// `flutter test` runs with cwd = the package root (apps/mobile), so the repo
// root is two levels up. Resolved once, created recursively.
String get _outDirPath {
  final String? override = Platform.environment['FLOWMIC_WP8_SHOT_DIR'];
  if (override != null && override.isNotEmpty) return override;
  return '${Directory.current.path}/../../scratch/wp8-parity';
}

Directory get _outDir => Directory(_outDirPath);

// ─────────────────────────────────────────────────────────────────────────────
// FONTS
// ─────────────────────────────────────────────────────────────────────────────

/// Load every font the app itself declares (FontManifest.json), which is how
/// MaterialIcons gets registered — without this, every `Icon` in the dock is a
/// tofu box and the ⚙/＋/⌫ glyphs in the frames are meaningless.
///
/// The `packages/x/y` → `y` rewrite is the same one golden_toolkit does: the
/// manifest names a package-scoped family, the widgets name the bare one.
Future<void> _loadManifestFonts() async {
  try {
    final String raw = await rootBundle.loadString('FontManifest.json');
    final List<dynamic> manifest = json.decode(raw) as List<dynamic>;
    for (final dynamic entry in manifest) {
      final Map<String, dynamic> font =
          (entry as Map<Object?, Object?>).cast<String, dynamic>();
      final String declared = font['family'] as String;
      final String family = declared.startsWith('packages/')
          ? declared.split('/').last
          : declared;
      final FontLoader loader = FontLoader(family);
      for (final dynamic f in font['fonts'] as List<dynamic>) {
        final String asset =
            (f as Map<Object?, Object?>)['asset']! as String;
        loader.addFont(rootBundle.load(asset));
      }
      await loader.load();
      _log.add('font: bundle family "$family" loaded');
    }
  } catch (e) {
    _log.add('font: FontManifest load FAILED ($e) — icons will be tofu');
  }
}

/// The family name every widget on this page resolves to. Material's
/// Typography names `Roboto` on the Android target `flutter test` runs as, and
/// nothing in lib/ overrides `fontFamily`, so this is the ONE name that has to
/// carry a real face.
const String _kLatinFamily = 'Roboto';

/// The CJK face, registered under its OWN family and reached through
/// `fontFamilyFallback`.
///
/// 🔴 MEASURED, first run of this rig: putting BOTH blobs into one
/// `FontLoader('Roboto')` does NOT make CJK work. The probe below rendered 「中」
/// and 「国」 byte-identically, i.e. both were still Ahem squares — a family with
/// several typefaces is matched by WEIGHT/STYLE, not by glyph coverage, so the
/// Latin face simply won and the CJK blob was never consulted. Per-glyph
/// fallback across faces is what `fontFamilyFallback` is, and it has to be on
/// the TextStyle, which is why the theme below sets it rather than the loader.
const String _kCjkFamily = 'FlowMicRigCJK';

/// Dingbats and arrows. 🔴 NOT decoration: the deliver button's `➤` (U+27A4)
/// and the timeline capsules' `⤓`/`📥` are TYPOGRAPHIC GLYPHS the contract
/// names by codepoint (sheet_faces_test pins 「投递 ➤」 as a face, not copy), and
/// neither Segoe UI nor SimHei covers them — the first fonted run of this rig
/// photographed them as tofu boxes on the two controls the coordinator is
/// comparing hardest.
const String _kSymbolFamily = 'FlowMicRigSymbol';

/// Colour emoji, for the pictographic half of the same problem.
const String _kEmojiFamily = 'FlowMicRigEmoji';

/// Every host font the frames need, one family each.
Future<void> _loadHostFonts() async {
  // TTF only — FontLoader rejects TrueType COLLECTIONS (.ttc), which rules out
  // msyh.ttc / simsun.ttc. simhei / Deng / simkai are plain .ttf.
  const Map<String, List<String>> wanted = <String, List<String>>{
    _kLatinFamily: <String>[
      r'C:\Windows\Fonts\segoeui.ttf',
      r'C:\Windows\Fonts\arial.ttf',
    ],
    _kCjkFamily: <String>[
      r'C:\Windows\Fonts\simhei.ttf',
      r'C:\Windows\Fonts\Deng.ttf',
      r'C:\Windows\Fonts\simkai.ttf',
    ],
    _kSymbolFamily: <String>[r'C:\Windows\Fonts\seguisym.ttf'],
    _kEmojiFamily: <String>[r'C:\Windows\Fonts\seguiemj.ttf'],
  };

  for (final MapEntry<String, List<String>> e in wanted.entries) {
    for (final String path in e.value) {
      final File f = File(path);
      if (!f.existsSync()) continue;
      try {
        final Uint8List bytes = await f.readAsBytes();
        final FontLoader loader = FontLoader(e.key);
        loader.addFont(
          Future<ByteData>.value(
            ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.length),
          ),
        );
        await loader.load();
        _log.add('font: "$path" (${bytes.length} bytes) → family "${e.key}"');
        break; // first hit per family is enough
      } catch (err) {
        _log.add('font: "$path" FAILED ($err)');
      }
    }
  }
}

/// The production ThemeData (main.dart) plus the two font names the rig had to
/// add. The font pair is a RENDERING-SUBSTRATE concern, not a design one: the
/// shipped app inherits the device's real system fonts, and `flutter test` has
/// none, so naming them here is how the frame gets the type the device has —
/// not a second theme somebody has to keep in sync.
ThemeData _rigTheme(Brightness brightness) => ThemeData(
      brightness: brightness,
      scaffoldBackgroundColor: FlowMicColors.canvas,
      colorSchemeSeed: FlowMicColors.brandDeep,
      useMaterial3: true,
      fontFamily: _kLatinFamily,
      // Order matters: CJK first (it is the bulk of the copy), then the symbol
      // face, then colour emoji.
      fontFamilyFallback: const <String>[
        _kCjkFamily,
        _kSymbolFamily,
        _kEmojiFamily,
      ],
    );

// ─────────────────────────────────────────────────────────────────────────────
// HARNESS
// ─────────────────────────────────────────────────────────────────────────────

/// Session owner probe — the chat list narrows to the CONNECTED instance, so
/// seeded rows have to be stamped through the same probe production uses or the
/// timeline photographs empty (speaking_face_test.dart:82).
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Rig {
  _Rig(this.transport, this.recorder, this.controller);
  final FakeSocketTransport transport;
  final FakeAudioRecorder recorder;
  final ChatController controller;

  /// The request_id of the newest compose:start, so a pushed compose:done is
  /// answering the run that actually started (sheet_faces_test's `transform`).
  String get lastComposeRequestId => Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.composeStart).last.data!
            as Map<Object?, Object?>,
      )['request_id']! as String;
}

/// The real page + the real controller (0.2.51 law), wrapped in the production
/// ThemeData and a RepaintBoundary the camera can point at.
///
/// [syncTeardown] must be true for any case that leaves a live capture running.
Future<_Rig> _pumpPage(
  WidgetTester tester, {
  required Brightness theme,
  double width = 360,
  double height = 780,
  SendPolicy policy = SendPolicy.direct,
  bool connected = true,
  bool syncTeardown = false,
  int seedRows = 3,
}) async {
  // The dock palette resolves at BUILD time and nothing on this page listens to
  // the notifier, so the theme has to be set BEFORE the first pump — flipping
  // it over a built tree reads back whatever the first pump baked in
  // (dock_faces_test.dart:417).
  FlowMicTheme.brightness.value = theme;
  addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);

  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: recorder),
  );
  giveSessionAPairedIdentity(session);
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

  // A few rows so the frame shows a timeline rather than the empty state — the
  // dock/sheet is the subject, but a dock floating over an empty page is not
  // what the mock draws.
  const List<String> seeds = <String>[
    '把这段话直接发到电脑上的输入框里',
    '记得下周一之前把回归用例补齐',
    '这次改动只动了移动端的排版，没有碰协议',
  ];
  for (int i = 0; i < seedRows && i < seeds.length; i++) {
    store.buildFromUtterance(
      clientId: 'wp8-seed-$i',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: seeds[i],
    );
  }

  if (connected) transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _rootKey,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: _rigTheme(theme),
        home: ChatFlowPage(controller: controller),
      ),
    ),
  );
  await _settleish(tester);
  return _Rig(transport, recorder, controller);
}

/// Bounded pumping — NEVER `pumpAndSettle`.
///
/// The PTT bar's idle pulse repeats forever, so `pumpAndSettle` on this page
/// times out rather than settling (dock_faces_test.dart:389 leaves the ticker
/// parked for the same reason). Four 16ms frames is enough for layout, the
/// post-frame callbacks the page schedules, and any stream microtasks.
Future<void> _settleish(WidgetTester tester, {int frames = 4}) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE
// ─────────────────────────────────────────────────────────────────────────────

/// Photograph the whole app and write `<name>` into the output directory.
///
/// `toImage` + file IO both need a REAL async zone, hence `runAsync`; the pumps
/// that produced the frame happened outside it, which is the required order.
Future<void> _shoot(WidgetTester tester, String name, {String? note}) async {
  // 🔴 MEASURED (second run of this rig): a03/a04/a05 came out BYTE-IDENTICAL
  // — three different states, one photograph. `toImage` composites the layer
  // tree as of the last PAINTED frame, and two of those cases had changed
  // state without pumping one: a05's wait loop breaks on the first check, so
  // when the release chain had already landed it captured the frame before the
  // transition. Photographing after a state change requires a frame, and the
  // camera is the right place to guarantee it — asking every caller to
  // remember is how the rig ends up lying about which state it shot.
  await _settleish(tester);
  final RenderRepaintBoundary boundary =
      tester.renderObject<RenderRepaintBoundary>(find.byKey(_rootKey));
  await tester.runAsync(() async {
    final ui.Image image = await boundary.toImage(pixelRatio: 3);
    final ByteData? png = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    final Directory dir = _outDir;
    if (!dir.existsSync()) dir.createSync(recursive: true);
    final File out = File('${dir.path}/$name');
    await out.writeAsBytes(png!.buffer.asUint8List(), flush: true);
    final int kb = out.lengthSync() ~/ 1024;
    // 🔴 DUPLICATE DETECTOR — the mechanism that would have caught the stale
    // frame above by itself. Two states that photograph byte-identically means
    // one of the two drives did not reach the screen, and that is silent
    // otherwise: the file exists, it is a plausible size, and it is a picture
    // of the wrong thing.
    final String digest = md5.convert(png.buffer.asUint8List()).toString();
    final String? twin = _digests[digest];
    if (twin != null) {
      _log.add('🔴 shot: $name is BYTE-IDENTICAL to $twin — one of the two '
          'drives never reached the screen');
    }
    _digests[digest] = name;
    _log.add('shot: $name — ${image.width}x${image.height}px, ${kb}KB'
        '${note == null ? '' : ' — $note'}');
    // ignore: avoid_print
    print('[wp8-shot] $name (${kb}KB) → ${out.path}'
        '${note == null ? '' : '  [$note]'}');
  });
}

/// Rasterise an arbitrary widget on a blank surface and return its PNG bytes —
/// used ONLY by the font probe.
Future<Uint8List> _rasterize(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: _rootKey,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        // The SAME theme the frames use — a probe run under a different font
        // stack would measure something no photograph is taken under.
        theme: _rigTheme(Brightness.light),
        home: Scaffold(
          backgroundColor: const Color(0xFFFFFFFF),
          body: Center(child: child),
        ),
      ),
    ),
  );
  await tester.pump();
  final RenderRepaintBoundary boundary =
      tester.renderObject<RenderRepaintBoundary>(find.byKey(_rootKey));
  late Uint8List bytes;
  await tester.runAsync(() async {
    final ui.Image image = await boundary.toImage();
    final ByteData? data =
        await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    bytes = data!.buffer.asUint8List();
  });
  return bytes;
}

/// `testWidgets` with REAL shadows.
///
/// 🔴 MEASURED, first run of this rig: `flutter_test` paints every BoxShadow as
/// a hard un-blurred rectangle (`debugDisableShadows = true`), and the dock's
/// lift, the sheet's upward lift and the active segment's 1dp lift are all
/// shadow decisions the contract names — so a rig that leaves it on
/// photographs the wrong picture. But the framework ALSO asserts, at the end of
/// every test body and BEFORE any `addTearDown` runs, that no painting debug
/// variable was left changed. Flipping it in `setUpAll` therefore fails all
/// sixteen cases after the PNG is written. The flag has to be restored inside
/// the body, which is what this wrapper is: set → run → restore, in a `finally`
/// so a failed drive still leaves the invariant intact.
void _frame(String name, Future<void> Function(WidgetTester) body) {
  testWidgets(name, (WidgetTester tester) async {
    debugDisableShadows = false;
    try {
      await body(tester);
    } finally {
      debugDisableShadows = true;
    }
  });
}

bool _sameBytes(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (int i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVES
// ─────────────────────────────────────────────────────────────────────────────

/// Press and hold the PTT bar through the page's OWN production callback, the
/// way speaking_face_test does. Unawaited because an ACCEPTED press drags the
/// real async chain into FakeAsync.
Future<void> _holdPtt(WidgetTester tester, _Rig rig) async {
  final PttBar bar = tester.widget<PttBar>(find.byType(PttBar));
  unawaited(bar.onDown!());
  await tester.pump();
  await tester.pump();
  expect(
    rig.controller.isRecording,
    isTrue,
    reason: 'pre-state: the PTT press was refused, so there is no recording '
        'face to photograph',
  );
}

/// Feed real PCM so the amplitude meter has REAL samples. `makePcm`'s ramp is
/// deterministic, and `_amplitudeDbFor` is a pure RMS→dBFS function over it, so
/// the bar heights in the frame are measured, not drawn.
/// 🔴 THE TRAILING 250ms IS NOT PADDING. `RecordingTelemetry.addAmplitude`
/// deliberately does NOT request a repaint — its own doc says so — because the
/// 200ms elapsed-timer ticker already repaints the strip and the two share one
/// frame budget. So a rig that feeds twelve samples and shoots immediately
/// photographs floor bars while `amplitudeWindow` holds eight real readings:
/// the assertion passes and the picture is of a different state. That is
/// exactly what the second run of this rig produced.
///
/// ⚠️ Only the newest [kAmplitudeWindow] (=8) samples survive, and the strip
/// draws [RecordingPanel.kBars] (=12) bars — so the four LEFT-most bars stay at
/// the floor no matter how much is fed. That is the product's real face, not a
/// shortfall of the harness.
Future<void> _feedAmplitudes(
  WidgetTester tester,
  _Rig rig,
  List<int> amplitudes,
) async {
  for (final int amp in amplitudes) {
    rig.recorder.feed(makePcm(kChunkBytes, amplitude: amp));
    await tester.pump();
  }
  await tester.pump(const Duration(milliseconds: 250));
}

/// Open the sheet the way a preview tap does (tap + the frame the post-frame
/// focus lands on) — edit_sheet_test's `_openFromPreview`.
Future<void> _openFromPreview(WidgetTester tester) async {
  await tester.tap(_previewTap);
  await tester.pump();
  await tester.pump();
}

/// Is the tablet re-column actually in the tree right now? Read off the SOURCE
/// rather than imported as a symbol: another lane is editing these files while
/// this rig runs, and a rig that fails to COMPILE because a const was renamed
/// mid-edit produces zero frames instead of fifteen.
bool _tabletRecolumnPresent() {
  bool has(String path, String needle) {
    final File f = File(path);
    return f.existsSync() && f.readAsStringSync().contains(needle);
  }

  return has('lib/src/ui/compose_band.dart', 'kDockTabletMinWidth') &&
      has('lib/src/ui/chat_flow_composer.dart', 'kDockTabletMinWidth');
}

// ─────────────────────────────────────────────────────────────────────────────

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await _loadManifestFonts();
    await _loadHostFonts();
    _outDir.createSync(recursive: true);
    // ignore: avoid_print
    print('[wp8-shot] output dir: ${_outDir.absolute.path}');
  });

  tearDownAll(() {
    // ignore: avoid_print
    print('\n[wp8-shot] ── RUN LOG ─────────────────────────────────────');
    for (final String line in _log) {
      // ignore: avoid_print
      print('[wp8-shot] $line');
    }
  });

  // ── 00 · font probe ───────────────────────────────────────────────────────
  // Not a frame — a MEASUREMENT of whether the frames are worth looking at.
  // Under Ahem every glyph is the same filled em square, so two DIFFERENT
  // glyphs rasterise byte-identically; under a real face they cannot. That is
  // the whole test, and it works for CJK where a width comparison does not
  // (CJK faces are em-square too).
  testWidgets('00 font probe', (WidgetTester tester) async {
    TextStyle s(double px) => TextStyle(fontSize: px, color: Colors.black);

    final Uint8List latinA = await _rasterize(tester, Text('A', style: s(64)));
    final Uint8List latinB = await _rasterize(tester, Text('B', style: s(64)));
    final Uint8List cjk1 = await _rasterize(tester, Text('中', style: s(64)));
    final Uint8List cjk2 = await _rasterize(tester, Text('国', style: s(64)));
    // The two glyphs the contract names by codepoint: the deliver button's ➤
    // and the timeline capsule's ⤓. Two tofu boxes are identical boxes, so the
    // same distinctness trick answers 「did the symbol font take」.
    final Uint8List sym1 = await _rasterize(tester, Text('➤', style: s(64)));
    final Uint8List sym2 = await _rasterize(tester, Text('⤓', style: s(64)));
    final Uint8List emo1 = await _rasterize(tester, Text('📥', style: s(64)));
    final Uint8List emo2 = await _rasterize(tester, Text('📤', style: s(64)));
    final Uint8List icon1 = await _rasterize(
      tester,
      const Icon(Icons.add, size: 64, color: Colors.black),
    );
    final Uint8List icon2 = await _rasterize(
      tester,
      const Icon(Icons.settings, size: 64, color: Colors.black),
    );

    // Latin advance width is the second, independent signal: Ahem gives every
    // character exactly `fontSize`, so 10 narrow letters measure 200 under Ahem
    // and far less under any proportional face.
    //
    // ⚠️ THE FAMILY MUST BE NAMED HERE. First run of this rig printed
    // 「width = 200.0 (Ahem)」 in the same breath as 「latin glyphs distinct =
    // true」, and BOTH were correct: the widgets get their family from the
    // theme, while a bare `TextStyle(fontSize: 20)` handed straight to a
    // TextPainter has no family at all and falls to the engine default. The
    // probe was measuring a text style the page never uses.
    final TextPainter tp = TextPainter(
      text: const TextSpan(
        text: 'iiiiiiiiii',
        style: TextStyle(fontSize: 20, fontFamily: _kLatinFamily),
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    final bool latinReal = !_sameBytes(latinA, latinB);
    final bool cjkReal = !_sameBytes(cjk1, cjk2);
    final bool symReal = !_sameBytes(sym1, sym2);
    final bool emojiReal = !_sameBytes(emo1, emo2);
    final bool iconsReal = !_sameBytes(icon1, icon2);
    _log
      ..add('probe: latin glyphs distinct = $latinReal '
          '(false ⇒ Ahem boxes)')
      ..add('probe: CJK glyphs distinct = $cjkReal '
          '(false ⇒ Ahem boxes or identical tofu)')
      ..add('probe: symbol glyphs (➤ vs ⤓) distinct = $symReal')
      ..add('probe: emoji glyphs (📥 vs 📤) distinct = $emojiReal')
      ..add('probe: material icons distinct = $iconsReal')
      ..add('probe: width("iiiiiiiiii" @20sp) = ${tp.width.toStringAsFixed(1)} '
          '(200.0 ⇒ Ahem)');
    // ignore: avoid_print
    print('[wp8-shot] FONT PROBE latin=$latinReal cjk=$cjkReal sym=$symReal '
        'emoji=$emojiReal icons=$iconsReal '
        'width=${tp.width.toStringAsFixed(1)}');
  });

  // ── a01 · idle · direct ───────────────────────────────────────────────────
  _frame('a01 idle direct', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(tester, theme: Brightness.light);
    await _shoot(tester, 'a01-idle-direct.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a02 · idle · manual (steady state, no flash) ──────────────────────────
  // The policy comes from prefs rather than a tap, so this is the SETTLED
  // manual dock — the flash frame is a02b's job, and photographing them from
  // one drive would give one of the two the wrong face.
  _frame('a02 idle manual', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(
      tester,
      theme: Brightness.light,
      policy: SendPolicy.manual,
    );
    expect(rig.controller.sendPolicy, SendPolicy.manual, reason: 'pre-state');
    await _shoot(tester, 'a02-idle-manual.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a02b · the 800ms notice over the timeline edge ────────────────────────
  _frame('a02b manual flash', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(tester, theme: Brightness.light);
    expect(rig.controller.sendPolicy, SendPolicy.direct, reason: 'pre-state');
    await tester.tap(_policy);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      find.textContaining(_zh.sendPolicyManualHint),
      findsOneWidget,
      reason: 'pre-state: the notice is not up, so this frame would be a02 '
          'with extra steps',
    );
    await _shoot(tester, 'a02b-manual-flash.png',
        note: 'captured 100ms into the 800ms hold');
    // Walk the notice out so its own timers do not outlive the tree.
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump(const Duration(milliseconds: 300));
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a03 · speaking, with real amplitude ───────────────────────────────────
  _frame('a03 speaking', (WidgetTester tester) async {
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.light, syncTeardown: true);
    await _holdPtt(tester, rig);
    await _feedAmplitudes(tester, rig,
        <int>[150, 900, 4000, 12000, 20000, 8000, 2000, 15000, 25000, 5000, 18000, 3000]);
    expect(
      rig.controller.amplitudeWindow,
      isNotEmpty,
      reason: 'pre-state: no dBFS samples arrived, so the bars would be at the '
          'floor and this would be a04',
    );
    await _shoot(tester, 'a03-speaking.png',
        note: '${rig.controller.amplitudeWindow.length} real dBFS samples');
    unawaited(rig.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a04 · speaking with nothing to hear ───────────────────────────────────
  // ⚠️ DELIBERATE DEVIATION FROM 「no amplitude samples at all」. An EMPTY window
  // gives floor bars but NO silence sentence: `RecordingPanel._silent` is
  // `_hasSamples && every(≤ -55dB)`, so 「we have not measured anything yet」 and
  // 「we measured silence」 are different states and only the second one prints
  // recNoSound. Feeding sub-floor PCM photographs the state that has BOTH,
  // which is the one the mock's A-04 draws.
  _frame('a04 silence', (WidgetTester tester) async {
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.light, syncTeardown: true);
    await _holdPtt(tester, rig);
    await _feedAmplitudes(tester, rig, List<int>.filled(12, 40));
    final List<double> window = rig.controller.amplitudeWindow;
    expect(window, isNotEmpty, reason: 'pre-state');
    _log.add('a04: dBFS window = '
        '${window.map((double d) => d.toStringAsFixed(1)).join(", ")}');
    await _shoot(tester, 'a04-silence.png',
        note: 'sub-floor samples ⇒ floor bars + recNoSound');
    unawaited(rig.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a05 · processing ──────────────────────────────────────────────────────
  _frame('a05 processing', (WidgetTester tester) async {
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.light, syncTeardown: true);
    await _holdPtt(tester, rig);
    await _feedAmplitudes(tester, rig, <int>[9000, 14000, 6000]);
    // The production release edge — `ChatController.pttUp` → `session.pttUp` →
    // residual chunk + audio:stop + `fsm.onPttUp()` — run inside `runAsync` so
    // its tail (which sits behind `AudioCapture.stop()`) is not held by
    // FakeAsync. MEASURED: driven unawaited with 20 × 50ms pumps it never
    // reached PROCESSING at all, which is why this is not just `unawaited`.
    // The `.timeout` is the guard that keeps a stalled chain from turning the
    // whole rig into a hang.
    await tester.runAsync(() async {
      try {
        await rig.controller.pttUp().timeout(const Duration(seconds: 5));
      } catch (_) {
        // Swallowed on purpose: the fallback below is what reports it.
      }
    });
    for (int i = 0; i < 20; i++) {
      if (rig.controller.sessionState == SessionState.processing) break;
      await tester.pump(const Duration(milliseconds: 50));
    }
    String drive = 'full release chain (ChatController.pttUp, runAsync)';
    if (rig.controller.sessionState != SessionState.processing) {
      // Fallback, DECLARED rather than silent: the same FSM edge
      // `session.pttUp()` ends in, driven directly. It gives the right FACE
      // while skipping the audio teardown the release chain does first — which
      // is a difference this note exists to keep visible.
      rig.controller.session.fsm.onPttUp();
      await _settleish(tester);
      drive = 'FSM edge only (fsm.onPttUp) — the release chain did not settle';
      _log.add('a05: DEGRADED — $drive');
    }
    expect(
      rig.controller.sessionState,
      SessionState.processing,
      reason: 'pre-state: the FSM is not in PROCESSING — the amber bar is not '
          'what this frame shows',
    );
    await _shoot(tester, 'a05-processing.png', note: drive);
    rig.controller.session.debugStopIdlePresencePoll();
    // Let the 15s PROCESSING safety net fire (→ stall → idle) and its banner
    // auto-hide run out, so nothing is left armed behind the tree.
    await tester.pump(const Duration(seconds: 16));
    await tester.pump(const Duration(seconds: 6));
  });

  // ── a06 · voice draft, sheet auto-opened ──────────────────────────────────
  _frame('a06 sheet voice', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(
      tester,
      theme: Brightness.light,
      policy: SendPolicy.manual,
    );
    rig.controller.setBuffer(
      '今天下午的评审会我整理了三点：第一，登录流程的异常提示需要统一，'
      '现在同一个失败在两个页面上说的是两句话；第二，移动端埋点缺了两个'
      '关键事件，回归的时候看不出来是哪一步断的；第三，下周一之前要把'
      '回归用例补齐，尤其是断网重连那一组。',
    );
    await _settleish(tester);
    expect(_sheet, findsOneWidget, reason: 'pre-state: the sheet did not open');
    await _shoot(tester, 'a06-sheet-voice.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a07 · appending inside the sheet ──────────────────────────────────────
  _frame('a07 appending', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(
      tester,
      theme: Brightness.light,
      policy: SendPolicy.manual,
      syncTeardown: true,
    );
    rig.controller.setBuffer(
      '这一段是刚刚说完、已经落进缓冲的草稿，现在按住「追加」再补一句。',
    );
    await _settleish(tester);
    expect(_sheet, findsOneWidget, reason: 'pre-state');

    // The PRODUCTION accepted-edge, driven directly: a real long-press drags
    // the async PTT chain into FakeAsync (sheet_faces_test.dart:446).
    final SheetAppendButton btn =
        tester.widget<SheetAppendButton>(find.byType(SheetAppendButton));
    unawaited(btn.onDown());
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(rig.controller.isRecording, isTrue, reason: 'pre-state: the append '
        'press was refused');

    rig.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': '再补一句：这条要抄送给测试。',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
    });
    await tester.pump();
    await _feedAmplitudes(tester, rig, <int>[7000, 16000, 4000, 21000]);
    expect(
      find.byKey(const ValueKey<String>('compose.sheet.live')),
      findsOneWidget,
      reason: 'pre-state: the live append view is not up',
    );
    await _shoot(tester, 'a07-appending.png');
    unawaited(rig.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a08 · a transform applied ─────────────────────────────────────────────
  _frame('a08 applied', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(
      tester,
      theme: Brightness.light,
      policy: SendPolicy.manual,
    );
    rig.controller.setBuffer('评审会我整理了三点，回头我再发一遍给大家看看。');
    await _settleish(tester);
    expect(_sheet, findsOneWidget, reason: 'pre-state');

    expect(
      rig.controller.startAiCompose(ComposeTask.draftPolish),
      isNull,
      reason: 'pre-state: the compose run refused to start',
    );
    await tester.pump();
    const String polished = '本次评审共整理出三点结论，稍后我会再完整地同步给各位。';
    rig.transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': polished,
      'request_id': rig.lastComposeRequestId,
    });
    await _settleish(tester);
    // 🔴 The pre-state is asserted on the BUFFER, not on the string 「润色 ✓」.
    // MEASURED (first run): at the 360dp product width the AI row renders its
    // COMPACT face, where the label is not a bare `Text('润色 ✓')` — a finder
    // for that string fails while the transform has landed perfectly. A rig
    // that refuses to photograph a state because it could not find one
    // particular label is a rig that stops working the day the label moves,
    // which is exactly the round this rig exists for.
    expect(
      rig.controller.buffer,
      polished,
      reason: 'pre-state: the transform did not land in the buffer',
    );
    final bool labelled = find
        .text('${_zh.aiTaskLabel(ComposeTask.draftPolish)} ✓')
        .evaluate()
        .isNotEmpty;
    await _shoot(tester, 'a08-applied.png',
        note: labelled ? 'labelled pill face' : 'compact pill face @360dp');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a10 · link down ───────────────────────────────────────────────────────
  _frame('a10 disconnected', (WidgetTester tester) async {
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.light, connected: false);
    await _shoot(tester, 'a10-disconnected.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a11 · record-only destination ─────────────────────────────────────────
  _frame('a11 record only', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(tester, theme: Brightness.light);
    rig.controller.destination.setRecordOnly();
    await _settleish(tester);
    await _shoot(tester, 'a11-record-only.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── a12 · typed draft ─────────────────────────────────────────────────────
  _frame('a12 typed', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(tester, theme: Brightness.light);
    await _openFromPreview(tester);
    expect(_sheet, findsOneWidget, reason: 'pre-state: the preview tap did not '
        'open the sheet');
    await tester.enterText(_field, '改一下标题的措辞');
    await _settleish(tester);
    await _shoot(tester, 'a12-typed.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── dark ──────────────────────────────────────────────────────────────────
  _frame('ad1 idle direct dark', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(tester, theme: Brightness.dark);
    await _shoot(tester, 'ad1-idle-direct-dark.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  _frame('ad2 speaking dark', (WidgetTester tester) async {
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.dark, syncTeardown: true);
    await _holdPtt(tester, rig);
    await _feedAmplitudes(tester, rig,
        <int>[150, 900, 4000, 12000, 20000, 8000, 2000, 15000, 25000, 5000, 18000, 3000]);
    await _shoot(tester, 'ad2-speaking-dark.png');
    unawaited(rig.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    rig.controller.session.debugStopIdlePresencePoll();
  });

  _frame('ad3 sheet dark', (WidgetTester tester) async {
    final _Rig rig = await _pumpPage(
      tester,
      theme: Brightness.dark,
      policy: SendPolicy.manual,
    );
    rig.controller.setBuffer(
      '今天下午的评审会我整理了三点：第一，登录流程的异常提示需要统一，'
      '现在同一个失败在两个页面上说的是两句话；第二，移动端埋点缺了两个'
      '关键事件，回归的时候看不出来是哪一步断的；第三，下周一之前要把'
      '回归用例补齐，尤其是断网重连那一组。',
    );
    await _settleish(tester);
    expect(_sheet, findsOneWidget, reason: 'pre-state');
    await _shoot(tester, 'ad3-sheet-dark.png');
    rig.controller.session.debugStopIdlePresencePoll();
  });

  // ── atab · the tablet re-column, IF it is in the tree ─────────────────────
  _frame('atab idle (tablet)', (WidgetTester tester) async {
    if (!_tabletRecolumnPresent()) {
      _log.add('atab: SKIPPED — kDockTabletMinWidth is not in the tree');
      // ignore: avoid_print
      print('[wp8-shot] atab-idle SKIPPED (no tablet re-column in the tree)');
      return;
    }
    final _Rig rig =
        await _pumpPage(tester, theme: Brightness.light, width: 560);
    await _shoot(tester, 'atab-idle.png', note: '560dp logical');
    rig.controller.session.debugStopIdlePresencePoll();
  });
}
