// CARD-UI (owner 2026-10-14) — the HISTORY card, on the real history page:
// line 1 = mode · delivery state · PC instance (the attribution chip), line 2
// = time · duration and count · edited, then the row's other facts (failure
// code, 「Resent 23:59」). The rule and the ruler are described in
// chat_message_meta_fit_test.dart's header; here the PC chip is also never
// hidden (owner 2026-07-27 requirement ①: with two PCs a failed row must say
// which PC) — it ellipsizes to a minimum and otherwise moves to the next
// line. This file mounts the production `HistoryPage` (anti-façade ⑥: the
// screen that shows the card) over a store holding one row per delivery face
// × time stamp {today, earlier this year, a past year} × marks {none; edited
// and re-sent}, in 9 locales × text size {1.0, 1.15, 1.3} × width {360, 393,
// 412} dp. The history page shows no polish mark, no favourite star and no
// inline resend (`history_page.dart` `ChatMessageTile(` passes none of them);
// its selection tick is checked on the tile matrix.
//
// Every gate runs 360 dp at 1.15 only; FLOWMIC_META_MATRIX=full runs all of
// it (support/meta_fit_rows.dart `kMetaFullMatrix`). Cards that need a third
// line at <= 1.15 are pinned in [_kResidualPath].
//
// The chip ellipsizes in the MIDDLE and keeps the name's end (default
// Windows names, 「DESKTOP-7F3K2QX」, differ only there); the probe asserts
// what it paints ends with the name's last characters.
//
// Reverse controls (measured red, then restored; RC-REVERT grep=0):
//   · 2026-10-15, the chip back to an end-ellipsized `Text` →
//     `de 360dp xlarge` `+0 -1`: `PC chip does not keep the end of the name`;
//   · 2026-10-15, the chip allowed to vanish again (`keep: false` in
//     chat_message_tile.dart) → `de 360dp xlarge` `+0 -1`: `de/360/xlarge/
//     refused/today/plain: PC instance hidden on the history page`;
//   · 2026-10-14, the PC region's minimum back at 12 px → `+51 -30` with `A
//     RenderFlex overflowed by 0.423 pixels on the right.`

import 'dart:io';

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart'
    show TimelineStorageKind;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/history_page.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/time_label.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/meta_fit_probe.dart';
import 'support/meta_fit_rows.dart';
import 'support/real_latin_font.dart';
import 'support/square_fallback_font.dart';

const String _kResidualPath = 'test/fixtures/history_card_meta_residual.txt';

void main() {
  setUpAll(() async {
    await loadRealLatinFace();
    await loadSquareFallbackFace();
  });

  final bool update =
      Platform.environment['FLOWMIC_UPDATE_META_RESIDUAL'] == '1';
  final File pinnedFile = File(_kResidualPath);
  final Set<String> previous = pinnedFile.existsSync()
      ? readPinned(pinnedFile.readAsStringSync())
      : <String>{};
  final Set<String> pinned = update ? <String>{} : previous;
  final Set<String> runPrefixes = <String>{};
  final List<String> seen = <String>[];
  final List<String> details = <String>[];
  tearDownAll(() {
    if (Platform.environment['FLOWMIC_META_DETAIL'] case final String path?) {
      File(path).writeAsStringSync(details.map((String d) => '$d\n').join());
    }
    if (!update) return;
    pinnedFile.writeAsStringSync(
      mergedResidual(
        header:
            '# CARD-UI: history-page cards that need a third meta line at app\n'
            '# text size <= 1.15. Written by history_card_meta_fit_test.dart\n'
            '# with FLOWMIC_UPDATE_META_RESIDUAL=1 (and FLOWMIC_META_MATRIX=full\n'
            '# for every cell); read the diff before committing.\n',
        previous: previous,
        runPrefixes: runPrefixes,
        seen: seen,
      ),
    );
  });

  for (final AppLocale locale in AppLocale.values) {
    for (final AppTextScale rung in kMetaRungs) {
      for (final double width in kMetaWidths) {
        testWidgets('history card meta: ${locale.name} ${width.toInt()}dp '
            '${rung.name}', (WidgetTester tester) async {
          tester.view.physicalSize = Size(width, 60000);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          tester.platformDispatcher.textScaleFactorTestValue = 1.0;
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          final AppSettingsController settings = await metaSettings(
            locale,
            rung,
          );
          addTearDown(settings.dispose);
          final AppStrings s = AppStrings.of(locale);
          final DateTime now = DateTime.now();
          final String prefix = '${locale.name}/${width.toInt()}/${rung.name}/';
          runPrefixes.add(prefix);
          final List<String> failures = <String>[];
          final Set<DeliveryFace> faces = <DeliveryFace>{};

          // Two stores of 33 rows: one store page holds 60
          // (`TimelineStore.pageSize`), and every row must be on the page.
          final bool strict = rung != AppTextScale.xxlarge;
          for (final bool edited in <bool>[false, true]) {
            final InMemoryTimelinePersistence persistence =
                InMemoryTimelinePersistence();
            final Map<String, MetaExpectation> wants =
                <String, MetaExpectation>{};
            for (final MetaRow row in metaRows(now)) {
              for (final MetaStamp stamp in MetaStamp.values) {
                final String id = '${row.id}-${stamp.name}-$edited';
                final DateTime at = stamp.at(now);
                final TimelineEntry entry = row.build(
                  id: id,
                  createdAt: at,
                  edited: edited,
                  resentAt: edited ? at : null,
                );
                final DeliveryFace face = deliveryFaceOf(entry, queued: false);
                faces.add(face);
                await persistence.upsert(entry);
                wants[id] = MetaExpectation(
                  key:
                      '$prefix${face.name}/${stamp.name}/'
                      '${edited ? 'edited' : 'plain'}',
                  fullTexts: <List<String>>[
                    <String>[timelineTimeLabel(entry.createdAt)],
                    <String>[metaMetricsText(entry, s)],
                    <String>[deliveryFaceMeta(face, s).label],
                    if (edited)
                      <String>[s.resentAtLabel(timelineTimeLabel(at))],
                  ],
                  pcText: kMetaPc,
                  pcAlwaysShown: true,
                );
              }
            }
            final TimelineStore store = newTestStore(persistence: persistence);
            await tester.runAsync(store.load);

            await tester.pumpWidget(
              metaApp(
                settings,
                HistoryPage(
                  store: store,
                  storageKind: TimelineStorageKind.sqlite,
                  appSettings: settings,
                ),
              ),
            );
            await tester.pump();
            expect(tester.takeException(), isNull, reason: 'no layout errors');

            final Map<String, Element> cards = tilesById(
              tester.binding.rootElement!,
            );
            // Positive control: the page built every row.
            expect(cards.keys.toSet(), wants.keys.toSet());
            for (final MapEntry<String, MetaExpectation> w in wants.entries) {
              final MetaProbe p = probeMetaCell(
                cards[w.key]!,
                w.value,
                strict: strict,
              );
              failures.addAll(p.failures);
              details.addAll(p.detail);
              for (final String cell in p.residual) {
                seen.add(cell);
                if (!update && !pinned.contains(cell)) {
                  failures.add('$cell: needs a third line and is not pinned');
                }
              }
            }
            await tester.pumpWidget(const SizedBox());
            store.dispose();
          }
          // Every face the history page can show: it passes `queued: false`
          // (history_page.dart, the "queued: false is the gap" note), so the
          // queued face is never drawn here. NR-279: nor is `noAnswerYet` —
          // the page also passes `owed: false` (same gap: no queue here).
          expect(
            faces,
            DeliveryFace.values.toSet()
              ..remove(DeliveryFace.queued)
              ..remove(DeliveryFace.noAnswerYet),
          );
          for (final String cell in pinned) {
            if (cell.startsWith(prefix) && !seen.contains(cell)) {
              failures.add('$cell: pinned but fits two lines now');
            }
          }
          expect(failures, isEmpty, reason: failures.join('\n'));
        });
      }
    }
  }
}
