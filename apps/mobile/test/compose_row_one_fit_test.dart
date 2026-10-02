// Row 1 and the PC key group at the most common Android width — measured on the
// REAL chat screen, in every UI locale; Latin and Cyrillic under a REAL font.
//
// ── The defect (device, 2026-09-30, HUAWEI ELE-AL00, 360dp, system font 1.0,
//    the app's own text size at xlarge — its settings row reads 125%) ──────
// ① The mode segments read 「Re… / Tra… / Or…」: row 1 was a Row whose non-flex
//   policy chip ("Direct send ⇄") is laid out FIRST, so it took its full width
//   and the three mode words got what was left; and inside the pill the three
//   segments had EQUAL flex shares, so a long word was clipped whenever it was
//   wider than a third, even with room overall.
// ② The PC key group's edge label printed 「P」 over 「C」: the vertical CJK stack
//   was chosen on the label's LENGTH (≤ 2), and 「PC」 is two characters too.
// Fix = `_modePolicyRowRouted` (chat_flow_composer.dart) bills both sides and
// lets the chip give way; `ModeSegmentedControl` shares its room by each
// word's width; `_groupLabel` (compose_band.dart) stacks only CJK.
//
// ── The ruler, and what it cannot prove ─────────────────────────────────────
// `flutter_test` paints with a square test face (every glyph one em wide). For
// 「is a Latin word clipped」 that face answers nothing: it inflates Latin to
// ~2× its real width, so EN could never fit and a correct product would read
// red. So `setUpAll` loads Roboto (the Dart SDK's bundled DevTools assets,
// with Flutter's optional material_fonts cache as a fallback) under its own
// family. The latn / cyrl locales (the product's `AppLocale.script`) paint in it.
// ⚠️ The CJK locales deliberately do NOT: Roboto has no Han / kana / Hangul, and
// with it as the family those glyphs measured 4.4dp at 10sp (Roboto's notdef
// box, not a fallback — probed while writing this file), so a CJK word would
// read about half its real width, the unsafe direction. zh / zh-TW / ja / ko
// keep the square face instead: CJK faces are em-square designs, so the square
// is the conservative reading (square not clipping ⇒ device not clipping; the
// converse is false), and the Latin 「PC」 inside ja / ko is inflated, which is
// also the conservative side. Each case checks its own ruler before measuring.
// ⚠️ The phone is NOT Roboto: EMUI ships its own system face. The row measures
// itself with the font it actually paints in (`naturalWidth` helpers, through
// the same TextPainter the paragraph uses), so a wider device face moves the
// row to its next arrangement rather than into an ellipsis — but THIS file
// proves that only for Roboto. Each case prints its `slack` so the tight
// cells are visible (de at the default rung has ~4dp).
// ✅ The key captions (Clear / Backspace / …) ARE asserted here (2026-09-30,
// the quick-key card): `keysClipped` must be empty in every cell — a word
// that outgrows its quarter of the group WRAPS to a second line inside its
// key (compose_band.dart `_controlButton`) instead of being cut. Which ruler
// a cell's green relies on: latn / cyrl words are measured under Roboto (a
// real face); Han / Kana / Hangul words under the conservative square —
// em-square glyphs, so 「square not clipping ⇒ device not clipping」 holds.
// ⚠️ Latin words inside the square cells — zh-TW's 「Backspace」 — are INFLATED
// ~2× there: they wrap to two lines in this harness where a device font keeps
// one line (the conservative side); a red in those cells would be a ruler
// artifact, not a device verdict.
//
// ── Reverse control (measured red, then restored) ───────────────────────────
// With the three behaviours put back as they were (the chip always full and
// laid out first, equal flex shares, the stack chosen on length alone) and the
// measuring helpers left in place so this file still compiles, the same
// command — `flutter test test/compose_row_one_fit_test.dart` — read
// `+10 -35: Some tests failed.`; e.g. at the DEFAULT rung:
//   ROW1 large en: modesClipped=Realtime|Translate|Organize pcLines=2 …
//   ROW1 large de: modesClipped=Echtzeit|Übersetzen|Organisieren pcLines=2 …
//   ROW1 large ja: modesClipped=リアルタイム pcLines=2 …
// Restored ⇒ `+45: All tests passed!`; leftover marker `RC-REVERT` grep=0.
//
// ── Reverse control, quick-key card (2026-09-30, measured red, restored) ────
// With only the key label put back to one line (`maxLines: 1`, marker
// `RC-REVERT quickkey`; the keysClipped assertion above left in place so the
// file still compiles), the same command — `flutter test
// test/compose_row_one_fit_test.dart` — read `+32 -13: Some tests failed.`,
// the 13 reds each naming their own cell and word:
//   keysClipped ja medium/large/xlarge/xxlarge: バックスペース
//   keysClipped fr xlarge/xxlarge: Retour arrière
//   keysClipped de xxlarge: Rückgängig
//   keysClipped ko xxlarge: 백스페이스 | 실행 취소
//   keysClipped zhTw small/medium/large/xlarge/xxlarge: Backspace
// Restored ⇒ `+45: All tests passed!`; leftover marker `RC-REVERT quickkey`
// grep=0.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppSettingsController, AppTextScale, LocaleScript;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/mode_chip.dart'
    show ModeSegmentedControl, kModeOrder;
import 'package:flowmic/src/ui/text_scale_scope.dart' show TextScaleScope;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';

final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));
final Finder _groupLabel = find.byKey(
  const ValueKey<String>('compose.keys.groupLabel'),
);

Finder _segment(FlowMode m) =>
    find.byKey(ValueKey<String>('compose.mode.${m.name}'));

/// Roboto, registered under a name nothing else asks for — so only the cases
/// that opt in through their theme paint in it (see the header's ruler note).
const String _kLatinFamily = 'FlowMicTestRoboto';

/// Latin and Cyrillic have a real face here; everything else keeps the square.
bool _realFace(AppLocale l) =>
    l.script == LocaleScript.latn || l.script == LocaleScript.cyrl;

/// DevTools ships real Roboto faces with the Dart SDK on every host platform;
/// material_fonts is an optional Flutter artifact, absent on some CI runners.
/// Find the SDK cache from the tester or FLUTTER_ROOT and require all three
/// faces. Missing fonts fail loudly rather than measuring Latin under Ahem.
List<File> _robotoFonts() {
  final List<String> caches = <String>[
    File(Platform.resolvedExecutable).parent.parent.parent.parent.path,
    if (Platform.environment['FLUTTER_ROOT'] case final String root)
      <String>[root, 'bin', 'cache'].join(Platform.pathSeparator),
  ];
  final List<List<File>> candidates = <List<File>>[
    for (final String cache in caches) ...<List<File>>[
      <File>[
        for (final String weight in <String>['Regular', 'Medium', 'Bold'])
          File(
            <String>[
              cache,
              'dart-sdk',
              'bin',
              'resources',
              'devtools',
              'assets',
              'fonts',
              'Roboto',
              'Roboto-$weight.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
      <File>[
        for (final String weight in <String>['regular', 'medium', 'bold'])
          File(
            <String>[
              cache,
              'artifacts',
              'material_fonts',
              'roboto-$weight.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
    ],
  ];
  for (final List<File> fonts in candidates) {
    if (fonts.every((File font) => font.existsSync())) {
      return fonts;
    }
  }
  throw StateError(
    'Roboto regular, medium and bold are required to measure real Latin '
    'glyphs; no complete font set found in the SDK. Checked:\n'
    '${candidates.expand((List<File> fonts) => fonts).map((File f) => f.path).join('\n')}',
  );
}

Future<void> _loadRoboto() async {
  final FontLoader loader = FontLoader(_kLatinFamily);
  for (final File font in _robotoFonts()) {
    final Uint8List bytes = font.readAsBytesSync();
    loader.addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
  }
  await loader.load();
}

/// The same harness as compose_three_row_layout_test.dart's `_pumpPageAt`: the
/// REAL ChatFlowPage on a REAL ChatController, so what is measured is the
/// screen the user sees, not a hand-built row.
///
/// 🔴 The text size comes through the app's OWN ladder ([AppTextScale], set on
/// the same [AppSettingsController] and multiplied in by the production
/// [TextScaleScope] exactly as main.dart's `builder:` does), on top of a system
/// scale of 1.0 — the device's setting when the defect was photographed
/// (the app at xlarge, which its settings row shows as 125%).
Future<ChatController> _pumpChat(
  WidgetTester tester, {
  required AppLocale locale,
  required AppTextScale rung,
  double width = 360,
  double height = 800,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = 1.0;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(locale);
  appSettings.setTextScale(rung);
  addTearDown(appSettings.dispose);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(
      // A font substitution only — the rendering substrate, not a design
      // choice (the shipped app paints in the device's system face).
      theme: _realFace(locale) ? ThemeData(fontFamily: _kLatinFamily) : null,
      builder: (BuildContext context, Widget? page) =>
          TextScaleScope(appSettings: appSettings, child: page!),
      home: ChatFlowPage(controller: controller, appSettings: appSettings),
    ),
  );
  await tester.pump();
  return controller;
}

/// Every glyph under [of] sits on one line: the tops of all their boxes agree.
/// Read off the laid-out paragraphs, so a label split over two Texts (the
/// stacked face) and a label that wrapped inside one Text are both caught.
Set<double> _lineTops(WidgetTester tester, Finder of) {
  final Set<double> tops = <double>{};
  for (final Element e
      in find
          .descendant(of: of, matching: find.byType(RichText), matchRoot: true)
          .evaluate()) {
    final RenderParagraph p = e.renderObject! as RenderParagraph;
    final int len = p.text.toPlainText().length;
    for (final TextBox b in p.getBoxesForSelection(
      TextSelection(baseOffset: 0, extentOffset: len),
    )) {
      tops.add(p.localToGlobal(Offset(0, b.top)).dy.roundToDouble());
    }
  }
  return tops;
}

/// Which labels the design lets stack: Han / kana / Hangul only (the zh mocks'
/// vertical label). Stated here as the test's own expectation.
bool _allCjk(String s) => s.runes.every(
  (int r) =>
      (r >= 0x3040 && r <= 0x30FF) ||
      (r >= 0x3400 && r <= 0x4DBF) ||
      (r >= 0x4E00 && r <= 0x9FFF) ||
      (r >= 0xAC00 && r <= 0xD7AF) ||
      (r >= 0xF900 && r <= 0xFAFF),
);

String? _clippedText(WidgetTester tester, Finder f) {
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  return p.didExceedMaxLines ? p.text.toPlainText() : null;
}

void main() {
  setUpAll(_loadRoboto);

  // Both lists are the product's own registries, never hand lists.
  for (final AppTextScale rung in AppTextScale.values) {
    for (final AppLocale locale in AppLocale.values) {
      final String cell = '${rung.name} ${locale.name}';
      testWidgets(
        '360dp $cell: every mode word paints in full, the policy chip is '
        'whole and on screen, and the PC label is on one line',
        (WidgetTester tester) async {
          final ChatController c = await _pumpChat(
            tester,
            locale: locale,
            rung: rung,
          );
          final AppStrings strings = AppStrings.of(locale);

          // ── the ruler first: is this case painting in the face it claims? ──
          final TextStyle ambient = DefaultTextStyle.of(
            tester.element(_segment(FlowMode.realtime)),
          ).style;
          double at10(String glyph) => (TextPainter(
            text: TextSpan(
              text: glyph,
              // Letter spacing off: the text theme's 0.25 would sit on top of
              // the glyph and blur the reading.
              style: ambient.copyWith(fontSize: 10, letterSpacing: 0),
            ),
            textDirection: TextDirection.ltr,
          )..layout()).width;
          if (_realFace(locale)) {
            expect(
              at10('i'),
              lessThan(5),
              reason:
                  '$cell: 「i」 is not narrow — still the square face, so '
                  'a Latin width here would prove nothing',
            );
          } else {
            expect(
              at10('实'),
              closeTo(10, 0.01),
              reason:
                  '$cell: a CJK glyph is not one em — the conservative '
                  'square is not what is measuring',
            );
          }

          // ── scan first, assert after: the printed line is the per-cell
          //    defect list, before and after the fix alike ──────────────────
          Finder modeText(FlowMode m) =>
              find.descendant(of: _segment(m), matching: find.byType(RichText));
          final List<String> clippedModes = <String>[
            for (final FlowMode m in kModeOrder)
              if (_clippedText(tester, modeText(m)) case final String t) t,
          ];
          final String label = strings.pcKeysGroupLabel;
          final Set<double> tops = _lineTops(tester, _groupLabel);
          final Finder chipText = find.descendant(
            of: _policy,
            matching: find.byType(RichText),
          );
          final Rect chip = tester.getRect(_policy);
          final double segY = tester.getCenter(_segment(FlowMode.realtime)).dy;
          final String face =
              tester
                      .renderObject<RenderParagraph>(chipText)
                      .text
                      .toPlainText() ==
                  '⇄'
              ? 'glyph-only'
              : 'full';
          final String line = (chip.center.dy - segY).abs() < 8
              ? 'same line'
              : 'own line';
          final List<String> clippedKeys = <String>[
            for (final String k in <String>[
              'clear',
              'backspace',
              'undo',
              'enter',
            ])
              if (_clippedText(
                    tester,
                    find.byKey(ValueKey<String>('compose.ctrl.$k.label')),
                  )
                  case final String t)
                t,
          ];
          final Finder control = find.byType(ModeSegmentedControl);
          final double bill = ModeSegmentedControl.naturalWidth(
            tester.element(control),
            strings,
            c.mode,
          );
          // How much room the chosen arrangement has left over — the 「tight」
          // column of the card report. Same line: the gap between what the
          // segments need and the chip; own line: the row minus the segments.
          final double segLeft = tester.getTopLeft(control).dx;
          final double slack = line == 'same line'
              ? chip.left - 8 - (segLeft + bill)
              : (360 - 12) - (segLeft + bill);
          // ignore: avoid_print
          print(
            'ROW1 $cell: modesClipped='
            '${clippedModes.isEmpty ? '-' : clippedModes.join('|')} '
            'pcLines=${tops.length} chip=$face/$line '
            'slack=${slack.toStringAsFixed(1)}dp '
            'keysClipped=${clippedKeys.isEmpty ? '-' : clippedKeys.join('|')}',
          );

          expect(tester.takeException(), isNull, reason: '$cell: overflow');

          // ── ⓪ the quick-key words: never cut, in any cell ────────────────
          // This card's subject. The printed line above keeps the per-cell
          // record; this makes a clipped word fail ITS cell by name. Which
          // ruler each green relies on is stated in the header note: Roboto
          // for latn / cyrl words, the conservative square for Han / Kana /
          // Hangul, and Latin inside the square cells (zh-TW's Backspace)
          // only ever reads green here — under the square it wraps where a
          // device font would keep one line.
          expect(
            clippedKeys,
            isEmpty,
            reason:
                'keysClipped ${locale.name} ${rung.name}: '
                '${clippedKeys.join(' | ')}',
          );

          // ── ① the three mode words ────────────────────────────────────────
          for (final FlowMode m in kModeOrder) {
            final RenderParagraph p = tester.renderObject<RenderParagraph>(
              modeText(m),
            );
            expectLegible(tester, modeText(m), reason: cell);
            expect(
              p.size.width,
              greaterThanOrEqualTo(neededWidthOf(p) - 0.5),
              reason:
                  '$cell: 「${strings.modeLabel(m)}」 painted '
                  '${p.size.width.toStringAsFixed(1)} of '
                  '${neededWidthOf(p).toStringAsFixed(1)}dp',
            );
          }

          // Paint vs bill: the row's decision is only as good as
          // `naturalWidth`, so pin that it equals what the laid-out control
          // itself says it needs (the AiActionRow.labelledRowWidth idiom).
          // ⚠️ Not the control's painted SIZE: its pill is a Container with
          // `alignment:`, so it stretches to whatever the row hands it.
          final double needs = tester
              .renderObject<RenderBox>(control)
              .getMaxIntrinsicWidth(double.infinity);
          expect(
            (needs - bill).abs(),
            lessThan(0.5),
            reason:
                '$cell: naturalWidth $bill vs the control\'s own '
                'intrinsic width $needs',
          );

          // ── the policy chip: whole, on screen ─────────────────────────────
          expectLegible(tester, chipText, reason: cell);
          expect(chip.right, lessThanOrEqualTo(360 - 12 + 0.5), reason: cell);
          expect(chip.width, greaterThanOrEqualTo(44 - 0.5), reason: cell);

          // 0.2.65's promise, moved here from compose_three_row_layout_test.dart
          // (it could only hold under Ahem by clipping the words): EN keeps
          // row 1 on ONE line up to the default rung — the chip gives its
          // word before the row gives a line.
          if (locale == AppLocale.en && rung.factor <= 1.0) {
            expect(line, 'same line', reason: '$cell: chip left row 1');
          }

          // ── ② the PC label ────────────────────────────────────────────────
          expect(
            tops.length,
            // The zh mocks' vertical stack is one glyph per line by design,
            // but `_groupLabel` (compose_band.dart) only stacks a label of at
            // most two glyphs. NR-140 made the ja / ko labels 4 / 3 glyphs
            // (パソコン, 컴퓨터); those paint on one line, which is what this
            // case exists to hold.
            (_allCjk(label) && label.characters.length <= 2)
                ? label.characters.length
                : 1,
            reason: '$cell: 「$label」 printed on ${tops.length} lines',
          );
          c.session.debugStopIdlePresencePoll();
        },
      );
    }
  }
}
