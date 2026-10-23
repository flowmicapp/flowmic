// CARD-UI (owner 2026-10-14) — a transcript card's meta on the chat page.
// Line 1 = delivery state · PC instance (the PC instance is the only item
// that gives way); line 2 = time · duration and character count · polish
// state, then the row's other facts (failure code, 「Resent 23:59」). The
// selection tick, mode badge, Resend, edited mark and star are optional:
// whole, on whichever line has room, Resend / edited as an icon only when
// neither line holds the word. The rule (docs/strategy/2026-10-14-card-meta-
// two-lines-rule.md, checked by support/meta_fit_probe.dart): no fact is ever
// hidden, cut or ellipsized; up to text size 1.15 the five facts also stay on
// their two lines, unwrapped.
//
// ── What is mounted ─────────────────────────────────────────────────────────
// The production `ChatMessageTile` with the arguments the chat page passes
// (`chat_flow_scroll.dart` `ChatMessageTile(`: polish mark, favourite, inline
// resend, selection), inside the production `TextScaleScope`, in a list with
// the chat page's 14 dp side padding. The history page's card is checked by
// mounting the real `HistoryPage` (history_card_meta_fit_test.dart). A
// ChatFlowPage-level mount of this matrix is NOT done here (the polish mark,
// favourites and selection are controller state); said rather than implied.
//
// ── Matrix ──────────────────────────────────────────────────────────────────
// 9 UI locales × app text size {1.0, 1.15, 1.3} × width {360, 393, 412} dp ×
// every delivery face × polish mark {none + all six} × time stamp {today,
// earlier this year, a past year} × extras {none; edited + favourite +
// re-sent outside selection mode (mode badge, Resend, edited, star all
// compete); the same in selection mode}, with the widest count/duration a row
// shows ("59:59 · 1000 …"). A polish mark never meets a past year's stamp:
// the marks live only in the running chat controller (`chat_controller_state.
// dart` `_polishBadges`, cleared in `chat_transient_banner_timers.dart`), so a
// marked row is from this session — "earlier this year" covers a session
// that crossed midnight. Every gate runs the dominating cell (360 dp at 1.15,
// why in support/meta_fit_rows.dart `kMetaFullMatrix`); FLOWMIC_META_MATRIX=
// full runs it all (flutter.yml step "Card meta full matrix", nightly).
//
// ── Ruler ───────────────────────────────────────────────────────────────────
// Every locale paints in real Roboto (support/real_latin_font.dart), with the
// glyphs Roboto lacks taken from support/square_fallback_font.dart: Han, Kana
// and Hangul at exactly 1 em, emoji and symbols at 1.375 em (wider than the
// phone emoji faces). ⚠️ One direction only: a pass proves Roboto + those
// widths. iOS draws Latin in SF, a few percent wider; not measured here.
//
// ── Residual ────────────────────────────────────────────────────────────────
// Up to 1.15 a card that needs a third line (an optional item or a
// non-listed fact found no room) is pinned in [_kResidualPath]; a pinned card
// that starts fitting, or a new one, turns this file red. At 1.3 a third line
// is allowed and not pinned: the checks there are "no fact hidden, cut or
// ellipsized; nothing past the card edge".
//
// ── Reverse controls (each measured red, then restored; RC-REVERT grep=0) ───
// Same command each time, naming this file and one cell (`--plain-name`):
//   · facts that miss their lines hidden instead of moved (drop
//     `put(c, 2)` after `p.factsMoved++` in chat_message_meta_layout.dart),
//     2026-10-15 → `de 360dp xlarge` `+0 -1`: `de/360/xlarge/refused/-/
//     pastYear/marks: a fact is not painted`, `… "Erneut 2025/12/28 23:59"
//     not painted whole`;
//   · 2026-10-14, the earlier layout: polish mark without its short wording
//     → `de/360/xlarge/injected/notApplied/today/plain/line2: a fact does not
//     fit`; no compaction search → `en/360/large/failed/notApplied/today/
//     extras/optional: does not fit and is not pinned`; ruler without the
//     fallback face → `…/deferredNotInjected/noModel/today/extras/optional:
//     pinned but fits now` (the ruler is load-bearing).

import 'dart:io';

import 'package:flowmic/src/session/polish_badge.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flowmic/src/ui/time_label.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/meta_fit_probe.dart';
import 'support/meta_fit_rows.dart';
import 'support/real_latin_font.dart';
import 'support/square_fallback_font.dart';

const String _kResidualPath = 'test/fixtures/chat_message_meta_residual.txt';

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
            '# CARD-UI: chat-page cards that need a third meta line at app\n'
            '# text size <= 1.15. Written by chat_message_meta_fit_test.dart\n'
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
        testWidgets('chat card meta: ${locale.name} ${width.toInt()}dp '
            '${rung.name}', (WidgetTester tester) async {
          tester.view.physicalSize = Size(width, 600000);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          tester.platformDispatcher.textScaleFactorTestValue = 1.0;
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          final AppSettingsController settings = await metaSettings(
            locale,
            rung,
          );
          addTearDown(settings.dispose);
          final bool strict = rung != AppTextScale.xxlarge;

          final AppStrings s = AppStrings.of(locale);
          final DateTime now = DateTime.now();
          final List<Widget> tiles = <Widget>[];
          final List<MetaExpectation> wants = <MetaExpectation>[];
          final Set<DeliveryFace> faces = <DeliveryFace>{};
          for (final MetaRow row in metaRows(now)) {
            final DeliveryFace face = deliveryFaceOf(
              row.build(createdAt: now, edited: false),
              queued: row.queued,
              owed: row.owed,
            );
            faces.add(face);
            for (final PolishBadge? badge in <PolishBadge?>[
              null,
              ...PolishBadge.values,
            ]) {
              for (final MetaStamp stamp in MetaStamp.values) {
                if (badge != null && stamp == MetaStamp.pastYear) continue;
                for (final MetaExtras extras in MetaExtras.values) {
                  final DateTime at = stamp.at(now);
                  final DateTime? resentAt = extras.edited ? at : null;
                  final TimelineEntry entry = row.build(
                    createdAt: at,
                    edited: extras.edited,
                    resentAt: resentAt,
                  );
                  final String key =
                      '${locale.name}/${width.toInt()}/${rung.name}/'
                      '${face.name}/${badge?.name ?? '-'}/${stamp.name}/'
                      '${extras.name}';
                  wants.add(
                    MetaExpectation(
                      key: key,
                      fullTexts: <List<String>>[
                        <String>[timelineTimeLabel(entry.createdAt)],
                        <String>[metaMetricsText(entry, s)],
                        <String>[deliveryFaceMeta(face, s).label],
                        if (badge != null)
                          <String>[badge.label(s), badge.shortLabel(s)],
                        if (resentAt != null)
                          <String>[
                            s.resentAtLabel(timelineTimeLabel(resentAt)),
                          ],
                      ],
                      pcText: kMetaPc,
                    ),
                  );
                  tiles.add(
                    KeyedSubtree(
                      key: ValueKey<String>(key),
                      child: ChatMessageTile(
                        entry: entry,
                        strings: s,
                        queued: row.queued,
              owed: row.owed,
                        canResendImage: false,
                        onRetry: (_) {},
                        polishSkippedLabel: badge?.label(s),
                        polishSkippedShortLabel: badge?.shortLabel(s),
                        polishNeedsAction: badge?.needsUserFix ?? false,
                        isFavorite: extras.favourite,
                        selected: extras.selection,
                        onSelectToggle: extras.selection ? () {} : null,
                      ),
                    ),
                  );
                }
              }
            }
          }
          // Every face is covered — a fixture that drifts to another face
          // would otherwise silently shrink the matrix.
          expect(faces, DeliveryFace.values.toSet());

          await tester.pumpWidget(
            metaApp(
              settings,
              Scaffold(
                // The chat list's padding (chat_flow_scroll.dart); a Column,
                // not a lazy ListView, so every tile is built.
                body: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
                  child: Column(
                    children: <Widget>[
                      for (final Widget t in tiles) ...<Widget>[
                        t,
                        const SizedBox(height: 10),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull, reason: 'no layout errors');

          final List<String> failures = <String>[];
          final String prefix = '${locale.name}/${width.toInt()}/${rung.name}/';
          runPrefixes.add(prefix);
          final Map<String, Element> cards = keyedCards(
            tester.binding.rootElement!,
          );
          for (final MetaExpectation want in wants) {
            final MetaProbe p = probeMetaCell(
              cards[want.key]!,
              want,
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
