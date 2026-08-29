// Card CR-9 — the pre-flight sheet (demo cells B-1 / B-2).
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/continuous_start_sheet.dart
//   task unit §5-2 (three things must be said, and the fourth case may not be
//     left to the user's arithmetic), §6 C1c
//
// Everything here drives the REAL sheet through a real Navigator, because two of
// its guarantees are navigation facts — 「every way out except the go-ahead is a
// no」 and 「it refuses to open without a ceiling」 — and neither can be seen from
// the widget in isolation.

import 'package:flowmic/src/audio/continuous_offer.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

ContinuousOffer _offer({int? cap = 30, double usedMin = 88, double limitMin = 900, bool noMeter = false}) =>
    continuousOffer(
      recordOnly: true,
      mode: FlowMode.realtime,
      linkUp: true,
      summary: CloudSummary(
        minutes: noMeter ? null : CloudMeter(used: usedMin, limit: limitMin),
        tokens: const CloudMeter(used: 1, limit: 20000000),
        continuousMinutes: cap,
      ),
    );

/// Opens the sheet on first frame and records what it answered.
class _Host extends StatefulWidget {
  const _Host({required this.offer, required this.answers, this.locale = AppLocale.zh});
  final ContinuousOffer offer;
  final List<bool> answers;
  final AppLocale locale;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (BuildContext ctx) => Center(
          child: GestureDetector(
            key: const ValueKey<String>('open'),
            behavior: HitTestBehavior.opaque,
            onTap: () async {
              widget.answers.add(await askToStartContinuous(
                ctx,
                offer: widget.offer,
                strings: AppStrings.of(widget.locale),
              ));
            },
            child: const SizedBox(width: 200, height: 80),
          ),
        ),
      ),
    ),
  );
}

Future<List<bool>> _open(
  WidgetTester tester,
  ContinuousOffer offer, {
  AppLocale locale = AppLocale.zh,
}) async {
  final List<bool> answers = <bool>[];
  await tester.pumpWidget(_Host(offer: offer, answers: answers, locale: locale));
  await tester.tap(find.byKey(const ValueKey<String>('open')));
  await tester.pumpAndSettle();
  return answers;
}

/// The text INSIDE a keyed line.
///
/// 🔴 The key sits on the line's container (icon + sentence), not on its `Text`,
/// so `tester.widget<Text>(find.byKey(k))` throws — which it did, loudly, on the
/// first run of this file. Loud is the lucky case: a ruler aimed one node away
/// from its subject usually returns something plausible instead of failing.
Finder _label(Key k) =>
    find.descendant(of: find.byKey(k), matching: find.byType(Text));

String _text(WidgetTester tester, Key k) => tester.widget<Text>(_label(k)).data!;

void main() {
  testWidgets('B-1: all three facts are on screen, and none of them is implied', (
    WidgetTester tester,
  ) async {
    await _open(tester, _offer());

    expect(find.byKey(ContinuousSheetKeys.sheet), findsOneWidget);
    expect(_text(tester, ContinuousSheetKeys.cap), contains('30'));
    expect(_text(tester, ContinuousSheetKeys.left), contains('812'));
    expect(find.byKey(ContinuousSheetKeys.noCancel), findsOneWidget);
    expect(find.byKey(ContinuousSheetKeys.earlyStop), findsNothing,
        reason: 'this account has 812 minutes against a 30-minute ceiling — '
            'nothing is going to cut it short');
    expect(_text(tester, ContinuousSheetKeys.start),
        AppStrings.of(AppLocale.zh).continuousSheetStart);
  });

  testWidgets('🔴 B-2: the subtraction is done FOR the user, and the button '
      'label changes with it', (WidgetTester tester) async {
    // FREE after one full sitting: 20 a month, 10 a sitting, 6 left.
    await _open(tester, _offer(cap: 10, usedMin: 14, limitMin: 20));

    expect(find.byKey(ContinuousSheetKeys.earlyStop), findsOneWidget);
    expect(_text(tester, ContinuousSheetKeys.earlyStop), contains('6'),
        reason: 'two numbers on screen and a user left to subtract them is a '
            'user who finds out afterwards');
    expect(_text(tester, ContinuousSheetKeys.cap), contains('10'),
        reason: 'the ceiling is still stated — it is what applies next time');
    expect(_text(tester, ContinuousSheetKeys.start),
        AppStrings.of(AppLocale.zh).continuousSheetStartAnyway,
        reason: 'a button still reading 「开始录」 under a warning reads as though '
            'the warning were decoration');
  });

  testWidgets('🔴 §5-2: an unreadable balance removes the LINE, it does not '
      'become a zero', (WidgetTester tester) async {
    await _open(tester, _offer(noMeter: true));

    expect(find.byKey(ContinuousSheetKeys.cap), findsOneWidget,
        reason: 'the ceiling is still exactly true and still said');
    expect(find.byKey(ContinuousSheetKeys.left), findsNothing);
    expect(find.byKey(ContinuousSheetKeys.earlyStop), findsNothing,
        reason: 'a balance we could not read cannot warn about anything');
    expect(_text(tester, ContinuousSheetKeys.start),
        AppStrings.of(AppLocale.zh).continuousSheetStart);
  });

  group('🔴 every way out except the go-ahead is a NO', () {
    testWidgets('the go-ahead answers true', (WidgetTester tester) async {
      final List<bool> answers = await _open(tester, _offer());
      await tester.tap(find.byKey(ContinuousSheetKeys.start));
      await tester.pumpAndSettle();
      expect(answers, <bool>[true]);
    });

    testWidgets('cancel answers false', (WidgetTester tester) async {
      final List<bool> answers = await _open(tester, _offer());
      await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
      await tester.pumpAndSettle();
      expect(answers, <bool>[false]);
    });

    testWidgets('a scrim tap answers false — a dismissal is never consent', (
      WidgetTester tester,
    ) async {
      final List<bool> answers = await _open(tester, _offer());
      // Above the sheet, on the barrier.
      await tester.tapAt(const Offset(400, 40));
      await tester.pumpAndSettle();
      expect(answers, <bool>[false]);
      expect(find.byKey(ContinuousSheetKeys.sheet), findsNothing);
    });
  });

  testWidgets('🔴 it refuses to open without a ceiling', (WidgetTester tester) async {
    // Callers cannot reach this (`ContinuousOffer.enabled` is false without a
    // ceiling); the assertion is what keeps 「cannot」 from becoming 「did」. A
    // sheet that opened here would have to invent either the sentence or the
    // timer.
    final List<bool> answers = await _open(tester, _offer(cap: null));
    expect(find.byKey(ContinuousSheetKeys.sheet), findsNothing);
    expect(answers, <bool>[false]);
  });

  testWidgets('🔴 the no-cancel line does not promise 「一篇」 — CR-7 does not '
      'exist yet', (WidgetTester tester) async {
    // 🔴 A DELIBERATE DEVIATION FROM THE APPROVED DEMO, HELD IN PLACE BY THIS
    // TEST. B-1's drawn copy reads 「说过的话都会留在这一篇里」. The article data
    // model is card CR-7 and is not built: until it is, a continuous recording
    // settles into ordinary light-record rows, so 「this one piece」 would be a
    // promise with no mechanism — the same class 15 册 §2.0-b bans, and the same
    // reason CR-3's offline banner says 「audio kept on this phone」 rather than
    // 「will be transcribed later」.
    //
    // ⚠️ WHEN CR-7 LANDS THIS CASE MUST BE RE-JUDGED, NOT DELETED — criterion
    // C11's rule for its sibling guard. The words become sayable on the day the
    // piece exists; this file is where somebody notices that.
    // ⚠️ THE SHEET MUST BE CLOSED BETWEEN LOCALES. Pumping a fresh host over a
    // live modal route leaves the barrier in place, the 「open」 tap lands on it
    // instead, and the assertions then read whatever the previous iteration
    // left behind — which is how this loop first failed. Every iteration ends
    // with cancel, exactly like the clipping case below.
    const List<String> banned = <String>[
      // zh / ja — the article noun in the demo's own B-1 copy.
      '这一篇', '一篇', '篇里', '一つの記事',
      // latin-script equivalents, matched case-insensitively.
      'piece', 'article', 'pièce', 'stück', 'artículo', 'статья', '한 편',
    ];
    for (final AppLocale locale in AppLocale.values) {
      await _open(tester, _offer(), locale: locale);
      final String s = _text(tester, ContinuousSheetKeys.noCancel).toLowerCase();
      for (final String word in banned) {
        expect(s, isNot(contains(word.toLowerCase())), reason: '$locale: $word');
      }
      await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
      await tester.pumpAndSettle();
    }
  });

  testWidgets('no briefed line is clipped, in any of the nine locales', (
    WidgetTester tester,
  ) async {
    // Ahem again: conservative in ONE direction only (see
    // continuous_entry_row_test.dart). Not clipped here ⇒ not clipped on a real
    // device; the converse does not hold.
    //
    // ⚠️ AND THE WIDTH IS NOT THE PHONE'S. Material caps a modal bottom sheet at
    // 640dp, so each half-width button here gets ~287dp — about 20 Ahem glyphs,
    // which lands within a few characters of what a real 14sp face fits in the
    // ~147dp button of a 360dp phone. That correspondence is a coincidence of
    // two roughly-2× errors cancelling, so it is written down rather than
    // relied on quietly: this case is a useful sanity bound, NOT a measurement
    // of the phone. It has already earned its keep once — 「Empezar de todos
    // modos」 (22 characters) failed here and would not have fitted a phone
    // either; it is 「Empezar igual」 now.
    for (final AppLocale locale in AppLocale.values) {
      await _open(tester, _offer(cap: 10, usedMin: 14, limitMin: 20), locale: locale);
      for (final Key k in <Key>[
        ContinuousSheetKeys.cap,
        ContinuousSheetKeys.left,
        ContinuousSheetKeys.earlyStop,
        ContinuousSheetKeys.noCancel,
        ContinuousSheetKeys.start,
        ContinuousSheetKeys.cancel,
      ]) {
        expect(
          tester.renderObject<RenderParagraph>(_label(k)).didExceedMaxLines,
          isFalse,
          reason: '$locale / $k was cut off',
        );
      }
      await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
      await tester.pumpAndSettle();
    }
  });
}
