// T-0 — the banned-word guard on the PTT processing-face wording.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-a law 2
//     (STT has already ended by the time this face shows; borrowing an
//      STT-stage word here blames the wrong stage and points the user at
//      the wrong fix — "speak louder/closer" for what is actually LLM
//      reorder latency)
//   docs/strategy/2026-08-13-0263-design-task-book.md §2-6 card T-0
//
// ── WHY A GUARD TEST AND NOT A COMMENT ───────────────────────────────────────
// Same shape as link_loss_copy_guard_test.dart: the ban's natural failure
// mode is a later, well-meaning copy edit that reaches for
// "识别中"/"Transcribing" again — it reads perfectly naturally as a label for
// a spinner. A comment on the string cannot go red; this file can.
//
// 🔴 0.2.53 law: the assertion runs against the RENDERED PttBar in the
// PROCESSING visual state, not a raw `AppStrings.pttProcessing` string that
// was never laid out — see inject_verdict_note_test.dart's file header for
// why that distinction matters (a `Text.data` assertion on an unrendered
// string passed 1259/1259 while the actual screen showed three letters).
// Here the risk is different (no ellipsis truncation on this short label) —
// what a widget-level assertion buys is proof that `ptt_bar.dart` is still
// actually wired to `AppStrings.pttProcessing` for this face, not just that
// the getter itself avoids the banned words.
//
// 🔴 REVERSE CONTROL — actually executed (2026-08-13, this card): with
// `pttProcessing`'s zh value reverted to the old `'识别中…'` in
// recording_strings.dart, the zh case in the loop below failed with:
//
//   Expected: false
//     Actual: <true>
//   zh processing face still says something containing 「识别」— that names
//   the wrong stage: STT has already ended by the time this face shows
//   (15 册 §2.0-a law 2), so it must never claim to still be recognising
//   speech
//
// Reverted after recording; see the delivery report for the full captured
// output. Residual marker search after restore: grep=0 for "识别中" in
// recording_strings.dart's pttProcessing getter.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Per-language STT-stage lexemes the PROCESSING face must never borrow (15
/// 册 §2.0-a law 2). Substring match; en is checked case-insensitively so it
/// also catches Transcribe / Transcribed / Transcription, not just the exact
/// "Transcribing" that used to be here.
///
/// 🔴 Nine-locale expansion (2026-08-14): this table originally had only four
/// entries, and the reader was `_bannedStageWords[locale]!` — after adding five
/// locales that `!` is a **null-assertion crash** for every new language, not a
/// missed test. The table is filled out to nine and rewritten as an exhaustive
/// `switch`: adding a language to a Map would not fail to compile (it would
/// only blow up at runtime, or worse — if someone later swapped `!` for
/// `?? const []`, the new language would be **silently exempt from the check**).
///
/// ⚠️ The banned words for each locale are not looked up in a dictionary; they
/// are **read out of that locale's own `liveTranscribing`** (that sentence is
/// the only one in the product that **should** name the STT stage):
/// en 'Transcribing' / fr 'Transcription' / es 'Transcribiendo' /
/// de 'Transkription' / ja '文字起こし中' / ko '전사 중' / ru 'Распознавание' /
/// zh-CN '转录中' / zh-TW '轉錄中'. What is banned is therefore the word this
/// locale actually uses, not a word a translator would never write — the latter
/// is an assertion that is always true.
List<String> _bannedStageWords(AppLocale locale) => switch (locale) {
  AppLocale.zh => <String>['识别', '转录'],
  // Traditional Chinese needs both: 「辨識」 is the Taiwanese word for
  // recognition, 「轉錄」 is the word zh-TW's own `liveTranscribing` uses.
  AppLocale.zhTw => <String>['辨識', '轉錄'],
  AppLocale.en => <String>['transcrib'],
  // One prefix 'transcri' covers Transcription / transcrire / Transcribiendo /
  // transcripción — the Latin-three share this root.
  AppLocale.fr => <String>['transcri'],
  AppLocale.es => <String>['transcri'],
  AppLocale.de => <String>['transkri'],
  AppLocale.ja => <String>['文字起こし'],
  AppLocale.ko => <String>['전사'],
  // Russian needs two: 'распозна' is the word its `liveTranscribing` uses
  // (Распознавание), 'транскри' is the synonymous loanword, the one a
  // translator is most likely to switch to.
  AppLocale.ru => <String>['распозна', 'транскри'],
};

Widget _host(AppStrings s) =>
    MaterialApp(home: Scaffold(body: PttBar(visual: PttVisual.processing, strings: s)));

/// The bar's one label Text, located by the bar's own stable key
/// (`ptt_bar.dart:310`) rather than by string — a string-based finder would
/// just re-assert the getter exists somewhere on screen, not prove THIS bar,
/// in THIS visual state, is the thing showing it.
Finder _label() => find.descendant(
  of: find.byKey(const ValueKey<String>('ptt.bar')),
  matching: find.byType(Text),
);

void main() {
  group('T-0 — processing face never borrows an STT-stage word', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets(
        '$locale: the RENDERED processing label carries none of the banned '
        'words',
        (WidgetTester tester) async {
          final AppStrings s = AppStrings.of(locale);
          await tester.pumpWidget(_host(s));

          final Finder textFinder = _label();
          expect(textFinder, findsOneWidget, reason: '$locale');

          final Text rendered = tester.widget<Text>(textFinder);
          final String onScreen = (rendered.data ?? '').toLowerCase();
          expect(onScreen, isNotEmpty, reason: '$locale');

          for (final String banned in _bannedStageWords(locale)) {
            expect(
              onScreen.contains(banned.toLowerCase()),
              isFalse,
              reason:
                  '$locale processing face still says something containing '
                  '「$banned」— that names the wrong stage: STT has already '
                  'ended by the time this face shows (15 册 §2.0-a law 2), '
                  'so it must never claim to still be recognising speech',
            );
          }

          // Round-trip: what is painted really is AppStrings.pttProcessing —
          // not some other string that happens to also dodge the ban list.
          expect(rendered.data, s.pttProcessing, reason: '$locale');
        },
      );
    }

    testWidgets(
      'four locales stay mutually distinct on screen — none silently fell '
      "back to another language's copy",
      (WidgetTester tester) async {
        final Set<String> seenOnScreen = <String>{};
        for (final AppLocale locale in AppLocale.values) {
          await tester.pumpWidget(_host(AppStrings.of(locale)));
          final String data = tester.widget<Text>(_label()).data ?? '';
          expect(
            seenOnScreen.add(data),
            isTrue,
            reason: "$locale rendered a prior locale's copy verbatim: "
                '"$data"',
          );
        }
      },
    );

    testWidgets(
      'MUST NOT: PttVisual enum / FSM / amber styling changed by this card '
      '— processing still refuses a PTT-down and keeps its amber fill',
      (WidgetTester tester) async {
        int downs = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: PttBar(
                visual: PttVisual.processing,
                onDown: () async {
                  downs++;
                  return true;
                },
              ),
            ),
          ),
        );
        await tester.longPress(find.byKey(const ValueKey<String>('ptt.bar')));
        await tester.pump();
        expect(downs, 0, reason: 'processing must still be a busy/refusing FSM face');

        final Container bar = tester.widget<Container>(
          find.byKey(const ValueKey<String>('ptt.bar')),
        );
        // WP8 VF-2 retuned the amber to the mock's `.ptt.amb{background:
        // #D97706}` — asserted through the TOKEN, not a re-typed hex, so the
        // next value change has to go through `FlowMicDockColors` (where
        // dock_tokens_test.dart pins it against the mock) instead of through
        // two files that must be kept in step by hand.
        // ⚠️ What this case guards is unchanged: a WORDING card must not move
        // the fill. The literal it was written against (0xFFFBBF24) belonged to
        // the pre-mock palette.
        expect(
          (bar.decoration! as BoxDecoration).color,
          FlowMicDockColors.processing,
          reason: 'amber fill must be untouched by a wording-only card',
        );
      },
    );
  });
}
