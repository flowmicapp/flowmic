// RC-I copy landing (AGY job 4, 2026-09-24): the record-only sentences,
// rendered in all nine locales on a 360 dp phone (D-15).
//
// WHY THIS FILE EXISTS: `record_only_no_pc_copy_test.dart` proves the ROW picks
// the record-only sentence on the mounted chat page, but only in zh and on
// `Text.data`; `nr96_nr89_copy_render_test.dart` measures the long-press sheet
// at 360 dp only for a PAIRED row (the PC sub-lines). Neither measures the four
// RC-I keys in nine locales:
//   · entryRetranslateSubRecord / entryReorganizeSubRecord — the sub-lines of
//     the light record's long-press sheet (`entry_context_menu.dart`, picked by
//     `EntryNeverSent.neverSent`);
//   · utteranceComposeErrorRecord__7 with its `$why` — the red banner raised by
//     `buildChatBanners` (`banner_queue.dart`) when a never-sent utterance's AI
//     step fails, filled from aiErrorCodeRecord__2 (`LLM_INVALID_MODEL`,
//     `aiErrorCodeFor`) and from one other reason, `COMPOSE_OUTPUT_REJECTED`
//     (aiErrorCode__9, the longest code sentence that names no PC).
//
// THE RULER is the one `nr96_nr89_copy_render_test.dart` uses:
// `support/legibility.dart` `ahemWidthBudget` + `expectLegible`. Strings are
// read from the getters, never quoted, so this file holds for whatever wording
// the copy pipeline lands next.

import 'package:flowmic/src/session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart' show ConnectionState;
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart' show ahemWidthBudget, expectLegible, neededWidthOf;

Finder _textOf(String text) => find.byWidgetPredicate((Widget w) => w is Text && w.data == text);

/// Painted, legible, and nothing overflowed. Returns whether the sentence had
/// to wrap, and prints one line per sentence.
bool _expectRendered(WidgetTester tester, Finder f, String want, String why) {
  expect(f, findsOneWidget, reason: '$why: not on screen');
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  expect(p.text.toPlainText(), want, reason: why);
  expectLegible(tester, f, reason: why);
  expect(tester.takeException(), isNull, reason: '$why: overflow');
  final double need = neededWidthOf(p);
  final bool pressured = need > p.size.width;
  // ignore: avoid_print
  print('RENDER $why box=${p.size.width.toStringAsFixed(0)} need=${need.toStringAsFixed(0)}'
      '${pressured ? ' WRAPPED' : ''}');
  return pressured;
}

void main() {
  // ── ① the light record's long-press sheet ──────────────────────────────────
  group('light-record long-press sheet, nine locales, 360 dp', () {
    final DateTime now = DateTime.utc(2026, 9, 24, 16);
    // A light-record row: cloud instance, nothing delivered (the two tests
    // `EntryNeverSent.neverSent` makes).
    final TimelineEntry row = TimelineEntry(
      id: 'loc_record_copy',
      clientId: 'c-record-copy',
      mode: FlowMode.translate,
      delivery: Delivery.none,
      sourceText: '你好世界',
      outputText: 'hello world',
      processMode: 'translate',
      status: EntryStatus.noted,
      origin: 'cloud',
      entryType: TimelineEntry.kTranscript,
      createdAt: now,
      updatedAt: now,
    );
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: both record sub-lines render whole', (WidgetTester tester) async {
        tester.view.physicalSize = Size(ahemWidthBudget(locale) * 3, 1400 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (BuildContext context) => Center(
                  child: TextButton(
                    onPressed: () => showEntryContextMenu(context, row, strings: s, translateTarget: 'ja'),
                    child: const Text('open'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '${locale.name}: the sheet overflowed');

        final String target = s.translateTargetLabel('ja');
        final String retranslate = s.entryRetranslateSubRecord(target);
        _expectRendered(tester, _textOf(retranslate), retranslate, '${locale.name} entryRetranslateSubRecord');
        _expectRendered(
          tester,
          _textOf(s.entryReorganizeSubRecord),
          s.entryReorganizeSubRecord,
          '${locale.name} entryReorganizeSubRecord',
        );
        // Positive control: the sheet picked the record branch, not the PC one.
        expect(_textOf(s.entryRetranslateSub(target)), findsNothing, reason: '${locale.name}: PC sub-line shown');
        expect(_textOf(s.entryReorganizeSub), findsNothing, reason: '${locale.name}: PC sub-line shown');
      });
    }
  });

  // ── ② the red banner for a never-sent utterance whose AI step failed ────────
  group('record-only compose-failure banner, nine locales, 360 dp', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: the banner renders whole with two reasons', (WidgetTester tester) async {
        final double width = ahemWidthBudget(locale);
        await tester.binding.setSurfaceSize(Size(width, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final AppStrings s = AppStrings.of(locale);
        int wrapped = 0;
        for (final String code in <String>['LLM_INVALID_MODEL', 'COMPOSE_OUTPUT_REJECTED']) {
          final AiComposeOutcome outcome = AiComposeOutcome(reason: AiComposeFailure.serverError, code: code);
          final BannerQueue q = buildChatBanners(
            connection: ConnectionState.connected,
            autoStopped: false,
            strings: s,
            utteranceFailure: outcome,
            utteranceFailureNeverSent: true,
            onDismissUtteranceFailure: () {},
          );
          final String want = s.utteranceComposeError(outcome, neverSent: true);
          final String why = s.aiErrorCodeFor(code, neverSent: true);
          expect(q.top?.message, want, reason: '${locale.name} $code: production picked another sentence');
          expect(want, contains(why), reason: '${locale.name} $code: the reason is not in the banner');
          expect(want, isNot(s.utteranceComposeError(outcome, neverSent: false)),
              reason: '${locale.name} $code: record frame equals the PC frame');
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topCenter,
                  child: BannerSlot(queue: q, strings: s),
                ),
              ),
            ),
          );
          if (_expectRendered(tester, _textOf(want), want, '${locale.name} $code')) wrapped++;
        }
        // Positive control: a frame plus a reason is long enough that at least
        // one of the two must wrap at 360 dp; if neither did, the legibility
        // assertions above were never under load.
        expect(wrapped, greaterThan(0), reason: '${locale.name}: no banner was under pressure, this case is blind');
      });
    }
  });
}
