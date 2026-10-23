// The "+" panel's send bar at the app's default and LARGEST text sizes, in all
// nine languages, on the two narrowest phones the product claims (320 and
// 360 dp).
//
// THE LAYOUT UNDER TEST (plus_panel_send_bar.dart): one row when the count,
// the chip and the send button fit at their natural widths; otherwise the bar
// wraps (count + chip on the first row, send right-aligned below). Nothing is
// squeezed and nothing is clipped, so every cell below must pass whichever
// shape the bar chose, and reading (6) pins which shape it should have chosen.
//
// SPEC-REF: CLAUDE.md [D-15] (assert on the rendered box, not `Text.data`);
// the 2026-10-09 "PC -> computer" copy pass made `plusSelectionSend` longer in
// fr / es / de, which is what asked for this instrument.
//
// WHAT THE SEND LABEL CAN DO WRONG, and which reading catches it:
//   * It has no `maxLines` and sits in a fixed 32 dp button, so a label that
//     does not fit does not ellipsise and does not throw: it WRAPS and its
//     second line is painted outside the button. `didExceedMaxLines` is
//     always false there (support/legibility.dart explains why), so the
//     readings used are the geometric ones: the paragraph's unwrapped width
//     must fit the box it was given (`neededWidthOf`), and the label's rect
//     must lie inside the button's rect.
//   * The send bar is a `Row` whose non-flex children can be pushed past the
//     screen edge by an over-long neighbour: rects are checked against the
//     screen, and the "with times" chip (the other child of the bar when a
//     recording is ticked - the tightest state) against the send button.
//   * Reachable: one real tap on the button must reach `onSendSelection`.
//
// THE RULER: Latin and Cyrillic are measured in REAL Roboto (Ahem's square
// glyphs inflate them ~1.8x, which would answer a different question); CJK
// keeps Ahem's full-em square, which is already the honest ruler for it.
// Real dp (pixel ratio 3); the text size comes through the app's own
// [TextScaleScope] on top of a system scale of 1.0, as main.dart applies it.
//
// NOTE: the mount is [PlusPanel] directly in a Scaffold body (the sibling
// plus_panel_send_with_times_test.dart does the same); production shows it in
// a modal bottom sheet, whose width on a phone is the screen width.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/legibility.dart' show expectLegible, neededWidthOf;

const String kArt = 'a0-1788000000000000';
final DateTime _t0 = DateTime.utc(2026, 9, 22, 9);
const String _kLatinFamily = 'FlowMicTestRoboto';

const Key kSend = ValueKey<String>('plus.selection.send');
const Key kChip = ValueKey<String>('plus.selection.withTimes');
const Key kBar = ValueKey<String>('plus.selection.bar');

bool _realFace(AppLocale l) =>
    l.script == LocaleScript.latn || l.script == LocaleScript.cyrl;

/// DevTools ships Roboto with the Dart SDK on every host platform; the
/// optional material_fonts artifact is the fallback. Missing fonts fail
/// loudly rather than measuring Latin under Ahem (same lookup as
/// compose_row_one_fit_test.dart).
List<File> _robotoFonts() {
  final List<String> caches = <String>[
    File(Platform.resolvedExecutable).parent.parent.parent.parent.path,
    if (Platform.environment['FLUTTER_ROOT'] case final String root)
      <String>[root, 'bin', 'cache'].join(Platform.pathSeparator),
  ];
  final List<List<File>> candidates = <List<File>>[
    for (final String cache in caches) ...<List<File>>[
      <File>[
        for (final String w in <String>['Regular', 'Medium', 'Bold'])
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
              'Roboto-$w.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
      <File>[
        for (final String w in <String>['regular', 'medium', 'bold'])
          File(
            <String>[
              cache,
              'artifacts',
              'material_fonts',
              'roboto-$w.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
    ],
  ];
  for (final List<File> fonts in candidates) {
    if (fonts.every((File f) => f.existsSync())) return fonts;
  }
  throw StateError(
    'Roboto regular/medium/bold not found in the SDK cache: '
    '${candidates.expand((List<File> f) => f).map((File f) => f.path)}',
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

TimelineEntry _member(String id, String text, int offsetMs, int ms) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      articleId: kArt,
      articleOffsetMs: offsetMs,
      durationMs: ms,
      createdAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
      updatedAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
    );

final TimelineEntry _head = TimelineEntry(
  id: 'loc_$kArt',
  clientId: kArt,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: 'x',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kArticle,
  articleId: kArt,
  origin: 'cloud',
  durationMs: 115_000,
  segmentsCount: 3,
  createdAt: _t0,
  updatedAt: _t0,
);

Future<void> _mountAndTick(
  WidgetTester tester, {
  required AppLocale locale,
  required double widthDp,
  required AppTextScale scale,
  required List<String> sent,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController settings = AppSettingsController(
    prefs: await SharedPreferences.getInstance(),
  );
  await settings.load();
  settings.setTextScale(scale);

  final TimelinePersistence store = InMemoryTimelinePersistence();
  await store.saveAll(<TimelineEntry>[
    _head,
    _member('s1', 'a', 0, 45_000),
    _member('s2', 'b', 45_000, 30_000),
    _member('s3', 'c', 75_000, 40_000),
  ]);

  tester.view.physicalSize = Size(widthDp * 3, 800 * 3);
  tester.view.devicePixelRatio = 3.0;
  tester.platformDispatcher.textScaleFactorTestValue = 1.0;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

  await tester.pumpWidget(
    MaterialApp(
      theme: _realFace(locale) ? ThemeData(fontFamily: _kLatinFamily) : null,
      builder: (BuildContext context, Widget? page) =>
          TextScaleScope(appSettings: settings, child: page!),
      home: Scaffold(
        body: PlusPanel(
          favorites: FavoritesStore(prefs: InMemoryLocalPrefs()),
          strings: AppStrings.of(locale),
          buffer: '',
          noPcTarget: false,
          onSend: (_) {},
          onFeedback: (_) {},
          lightRecords: LightRecordQuery(persistence: store),
          isSignedIn: () => true,
          onSendSelection:
              ({
                required String? text,
                required List<TimelineEntry> images,
                required List<TimelineEntry> sourceRows,
              }) async => sent.add(text ?? ''),
          imageSendable: (TimelineEntry e) async => false,
          prefs: InMemoryLocalPrefs(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey<String>('plus.tab.notes')));
  for (int i = 0; i < 6; i++) {
    await tester.pump();
  }
  await tester.tap(
    find.byKey(ValueKey<String>('plus.notes.openArticle.${_head.id}')),
  );
  await tester.pump();
}

void main() {
  setUpAll(_loadRoboto);

  for (final AppTextScale scale in <AppTextScale>[
    AppTextScale.large,
    AppTextScale.xxlarge,
  ]) {
    for (final double widthDp in <double>[320, 360]) {
      group('send bar at ${widthDp.toInt()} dp, text size ${scale.name} '
          '(${(scale.factor * 100).round()}%)', () {
        for (final AppLocale locale in AppLocale.values) {
          testWidgets(locale.name, (WidgetTester tester) async {
            final List<String> sent = <String>[];
            await _mountAndTick(
              tester,
              locale: locale,
              widthDp: widthDp,
              scale: scale,
              sent: sent,
            );
            final AppStrings s = AppStrings.of(locale);
            final String cell =
                '${locale.name} @ ${widthDp.toInt()}dp ${scale.name}';

            // Positive controls: the bar, the send button and the chip are all
            // really up, and the scale really is 1.30 (a bar that never mounted
            // or a scale that never applied would pass every reading below).
            expect(find.byKey(kBar), findsOneWidget, reason: '$cell: bar up');
            expect(find.byKey(kSend), findsOneWidget);
            expect(
              find.byKey(kChip),
              findsOneWidget,
              reason: '$cell: the chip is the tightest state of the bar',
            );
            final MediaQueryData mq = MediaQuery.of(
              tester.element(find.byKey(kSend)),
            );
            expect(
              mq.textScaler.scale(10),
              closeTo(10 * scale.factor, 0.01),
              reason: '$cell: the text size must really reach the bar',
            );

            final Finder labelFinder = find.descendant(
              of: find.byKey(kSend),
              matching: find.byType(RichText),
            );
            final RenderParagraph label = tester.renderObject(labelFinder);
            expect(label.text.toPlainText(), s.plusSelectionSend);

            // Scan first, assert after: the printed line is the per-cell reading,
            // so a red run names every locale and by how much, not just the first.
            final Rect scanSend = tester.getRect(find.byKey(kSend));
            final Rect scanChip = tester.getRect(find.byKey(kChip));
            // ignore: avoid_print
            print(
              'FITSCAN $cell label=${neededWidthOf(label).toStringAsFixed(1)}/'
              '${label.size.width.toStringAsFixed(1)} '
              'send=${scanSend.left.toStringAsFixed(1)}..'
              '${scanSend.right.toStringAsFixed(1)} '
              'chip=${scanChip.left.toStringAsFixed(1)}..'
              '${scanChip.right.toStringAsFixed(1)} '
              'screen=${widthDp.toInt()}',
            );

            // (1) not wrapped, not squeezed: the unwrapped width fits the box.
            expect(
              neededWidthOf(label),
              lessThanOrEqualTo(label.size.width + 0.5),
              reason:
                  '$cell: "${s.plusSelectionSend}" needs '
                  '${neededWidthOf(label).toStringAsFixed(1)}px but got '
                  '${label.size.width.toStringAsFixed(1)}px - it wraps',
            );
            expect(label.didExceedMaxLines, isFalse);

            // (2) the label sits inside its button.
            final Rect button = tester.getRect(find.byKey(kSend));
            final Rect text = tester.getRect(labelFinder);
            expect(
              text.left,
              greaterThanOrEqualTo(button.left - 0.5),
              reason: '$cell: label starts outside its button',
            );
            expect(
              text.right,
              lessThanOrEqualTo(button.right + 0.5),
              reason:
                  '$cell: label ends outside its button '
                  '(by ${(text.right - button.right).toStringAsFixed(1)}px)',
            );
            expect(text.top, greaterThanOrEqualTo(button.top - 0.5));
            expect(
              text.bottom,
              lessThanOrEqualTo(button.bottom + 0.5),
              reason:
                  '$cell: label taller than its button '
                  '(${text.height.toStringAsFixed(1)} in '
                  '${button.height.toStringAsFixed(1)})',
            );

            // (3) buttons on screen, and not on top of each other.
            final Rect chip = tester.getRect(find.byKey(kChip));
            for (final (String, Rect) b in <(String, Rect)>[
              ('send', button),
              ('chip', chip),
            ]) {
              expect(
                b.$2.left,
                greaterThanOrEqualTo(-0.5),
                reason: '$cell: ${b.$1} off the left edge',
              );
              expect(
                b.$2.right,
                lessThanOrEqualTo(widthDp + 0.5),
                reason:
                    '$cell: ${b.$1} off the right edge '
                    '(by ${(b.$2.right - widthDp).toStringAsFixed(1)}px)',
              );
            }
            final Rect countRect = tester.getRect(
              find
                  .descendant(
                    of: find.byKey(kBar),
                    matching: find.byType(RichText),
                  )
                  .first,
            );
            expect(
              chip.deflate(0.5).overlaps(button.deflate(0.5)),
              isFalse,
              reason: '$cell: the chip overlaps the send button',
            );
            for (final (String, Rect) b in <(String, Rect)>[
              ('send', button),
              ('chip', chip),
            ]) {
              expect(
                countRect.deflate(0.5).overlaps(b.$2.deflate(0.5)),
                isFalse,
                reason: '$cell: the "N ticked" line overlaps the ${b.$1}',
              );
            }
            expect(
              countRect.right,
              lessThanOrEqualTo(widthDp + 0.5),
              reason: '$cell: the "N ticked" line runs off the right edge',
            );

            // (3b) the chip's own label is not ellipsised either.
            final RenderParagraph chipLabel = tester.renderObject(
              find.byKey(
                const ValueKey<String>('plus.selection.withTimes.label'),
              ),
            );
            expect(
              neededWidthOf(chipLabel),
              lessThanOrEqualTo(chipLabel.size.width + 0.5),
              reason:
                  '$cell: "${s.selectionSendWithTimes}" needs '
                  '${neededWidthOf(chipLabel).toStringAsFixed(1)}px but got '
                  '${chipLabel.size.width.toStringAsFixed(1)}px - it is cut',
            );

            // (4) the count text beside them keeps a readable box, and nothing
            // overflowed anywhere.
            expectLegible(
              tester,
              find
                  .descendant(
                    of: find.byKey(kBar),
                    matching: find.byType(RichText),
                  )
                  .first,
              reason: '$cell: the "N ticked" line',
            );
            expect(tester.takeException(), isNull, reason: '$cell: overflow');

            // (6) the shape: one row exactly when the three fit at their
            // natural widths (the bar's own gaps are 10 + 8 with the chip up),
            // and a wrapped bar puts the send button wholly below the chip.
            final RenderParagraph count = tester.renderObject(
              find
                  .descendant(
                    of: find.byKey(kBar),
                    matching: find.byType(RichText),
                  )
                  .first,
            );
            final double barWidth = tester.getRect(find.byKey(kBar)).width;
            final double oneRowNeed =
                neededWidthOf(count) + 10 + chip.width + 8 + button.width;
            if (oneRowNeed <= barWidth - 0.5) {
              expect(
                button.center.dy,
                closeTo(chip.center.dy, 0.5),
                reason:
                    '$cell: everything fits one row '
                    '(${oneRowNeed.toStringAsFixed(1)} of '
                    '${barWidth.toStringAsFixed(1)}) - keep it',
              );
            } else if (oneRowNeed > barWidth + 0.5) {
              expect(
                button.top,
                greaterThanOrEqualTo(chip.bottom - 0.5),
                reason:
                    '$cell: one row needs ${oneRowNeed.toStringAsFixed(1)} '
                    'of ${barWidth.toStringAsFixed(1)} - the send button must wrap '
                    'below',
              );
            }

            // (5) reachable: one real tap reaches the sender.
            await tester.tap(find.byKey(kSend));
            await tester.pumpAndSettle();
            expect(sent, hasLength(1), reason: '$cell: the tap did not land');
          });
        }
      });
    }
  }
}
