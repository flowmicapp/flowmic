// 🔴 Card fix-015 — a PICTURE row that settles on `INJECT_SECURE_INPUT_ACTIVE`
// (63) or `INJECT_NO_ACCESSIBILITY` (64).
//
// ── WHAT WAS ACTUALLY WRONG (measured on this tree before the change) ───────
//
// The card was opened against 「no button and no explanation」. Probed first, and
// only the first half held. A picture row on 63 rendered:
//
//     ⤓ 已投递 · 未注入        → dev-pc-a        图片
//     电脑正处在系统的安全输入状态（比如密码框），这时系统不接收模拟按键。到电脑上离开密码框，再重发。
//
// i.e. `entry.reasonNote.*` WAS there ([_reasonNoteFor] was never gated on
// `isImage`) — but its last clause tells the user to 重发, and this row carries
// no 重发 control: 63/64 are in `kPcInjectionVerdictCodes`, `outboxSettle`
// settles the item terminal, so `resendableImageEntryIds` no longer holds it and
// `canResendImage` is false. The PC has nothing either — `TimelinePage.vue`
// `rowCanReinject` = `e.entry_type !== 'image' && …`.
//
// ⇒ The defect was not silence, it was **an imperative naming a control that
// exists on neither end** — the exact thing `error-codes.ts` already ruled out
// for this situation at `INJECT_DEFERRED_NOT_AUTOINJECTED`: 「state the fact, add
// no imperative the product cannot honour」. On a TEXT row the same sentence is
// correct (the face is in `retryableFace`, the button renders), which is why the
// fix keys on the ROW SHAPE, never on the code.
//
// ── HOW THIS FILE MEASURES ─────────────────────────────────────────────────
//
// 🔴 Assertions land on the RENDERED result, not `Text.data`, for the reason
// `inject_verdict_note_test.dart`'s header records: 0.2.53 shipped with 1259
// green tests while the screen showed three letters, because the test that
// covered it asserted the widget's own data and stepped around the clipping.
// So: intrinsic width vs. the actual box (a positive control that the sentence
// is genuinely under layout pressure) plus `RenderParagraph.didExceedMaxLines`
// (the negative one — did the user lose the end of it).
//
// 🔴 The Ahem placeholder font makes every glyph a full em, so the character
// budget here is CONSERVATIVE IN ONE DIRECTION ONLY: not clipped under Ahem ⇒
// not clipped with a real font. The converse does not hold, and nothing in this
// file may be used to argue 「it fits on a real device」.
//
// ── REVERSE CONTROL, ACTUALLY RUN (2026-08-10, this tree) ──────────────────
//
// `_reasonNoteFor`'s picture branch was disabled (`if (false && entry.isImage
// && …)`) and this file went 9 pass / 4 fail. The failure text IS the defect,
// verbatim:
//
//     Expected: '…图片已经送到电脑并留在电脑的时间线上，只是这一行没有再粘贴一次的入口。…'
//       Actual: '电脑正处在系统的安全输入状态（比如密码框），这时系统不接收模拟按键。到电脑上离开密码框，再重发。'
//     按钮不在的时候，不许再叫用户去按它
//
// Restored; the file is 13/13 green and `grep REVERSE-CONTROL` finds nothing in
// this card's two production files.
//
// ── WHAT THIS FILE CANNOT PROVE ────────────────────────────────────────────
//
// Both codes are raised by macOS preflight (`inject/preflight.rs`
// `synthetic_input_verdict`, reached from `pipeline.rs`
// `synthetic_input_preflight()` on BOTH the text and the image path). This runs
// on the host test VM with a hand-built row, so it proves the MAPPING and the
// LAYOUT — never that the real macOS path produces these codes.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/locale_terms.dart';
import 'support/legibility.dart' show ahemWidthAtLeast;

const AppStrings _zh = AppStringsZh();

/// MAC-05, owner 2026-08-07. Both ride `mode:'cached'`.
const String kSecureInput = 'INJECT_SECURE_INPUT_ACTIVE';
const String kNoAx = 'INJECT_NO_ACCESSIBILITY';

/// Same family, same `mode:'cached'`, same terminal settle — and DELIBERATELY
/// NOT covered by this card. Present as a control: it must keep the generic
/// sentence, byte for byte.
///
/// ✅ Correction (card fix-015 wrap-up, 2026-08-10) — **the boundary moved, so this control flipped.**
/// Original kept: it is the record of why the flip is a decision and not a
/// regression. The fix-015 follow-up gave this code the picture sentence too, and the two
/// assertions that pinned the old boundary (①'s null list, ③'s control case) went RED
/// on that change — which is precisely what a written-down scope boundary is for.
/// Full coverage now lives in `image_verdict_focus_lost_test.dart`; what stays
/// here is the flip itself, so this file's own story stays readable.
const String kFocusLost = 'INJECT_FOCUS_LOST';

const ValueKey<String> kNoteKey = ValueKey<String>('entry.reasonNote.loc_img');
const ValueKey<String> kResendKey = ValueKey<String>('entry.resend.loc_img');

TimelineEntry _row({
  required String code,
  required bool isImage,
  String id = 'loc_img',
}) {
  final DateTime now = DateTime.utc(2026, 8, 10, 13, 39);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: isImage ? '🖼 PNG · 214 KB' : '这是一句真机上会出现的转录',
    // 63/64 arrive with `mode:'cached'` ⇒ `applyInjectResult` settles the row
    // cached + cachedByVerdict ⇒ `deliveryFaceOf` → deliveredNotInjected.
    status: EntryStatus.cached,
    origin: 'paired',
    entryType: isImage ? TimelineEntry.kImage : TimelineEntry.kTranscript,
    failureReason: code,
    cachedByVerdict: true,
    // The destination chip is one of the six cells that squeezed the reason into
    // 「INJ…」 in 0.2.52 — dropping it would remove the culprit from the scene.
    pcName: 'dev-pc-a',
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(
  TimelineEntry e, {
  AppStrings strings = _zh,
  bool canResendImage = false,
  void Function(TimelineEntry entry)? onRetry,
}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: false,
      canResendImage: canResendImage,
      onRetry: onRetry ?? (TimelineEntry _) {},
    ),
  ),
);

/// How wide one unconstrained line of this text wants to be. Compared with the
/// box it actually got, it says whether the sentence is under pressure at all.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// Did the RENDERED paragraph overflow its own `maxLines` (⇒ the user sees an
/// ellipsis and loses the tail)?
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

void _handset(WidgetTester tester, {double width = 411}) {
  tester.view.physicalSize = Size(width * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

void main() {
  // ── ① The table: two codes, two sentences, four languages ────────────────
  group('① imageInjectVerdictNote — per-code human sentences', () {
    test('63 and 64 are non-empty in every locale, and differ from each other', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String? secure = s.imageInjectVerdictNote(kSecureInput);
        final String? noAx = s.imageInjectVerdictNote(kNoAx);
        expect(secure, isNotNull, reason: '$locale/63');
        expect(secure, isNotEmpty, reason: '$locale/63');
        expect(noAx, isNotNull, reason: '$locale/64');
        expect(noAx, isNotEmpty, reason: '$locale/64');
        // One sentence true of both codes = the one-value-two-questions shape
        // the owner minted two codes to avoid.
        expect(secure, isNot(noAx), reason: '$locale: both codes were given the same sentence');
      }
    });

    test('🔴 63 and 64 name **opposite** actions, in every locale', () {
      // Mirrors the pinned assertion in inject_verdict_note_test.dart, applied
      // to the picture variant: 64 must name WHERE to grant the permission (it
      // is the one failure on this path a user can fix themselves), and 63 must
      // NOT send them to a settings pane that cannot change anything for it.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        // Nine-locale expansion (2026-08-14): the four-entry table that used to
        // sit here moved to support/locale_terms.dart, shared with
        // inject_verdict_note_test.dart, which carried a byte-identical copy.
        final String axTerm = accessibilityTerm(locale);
        expect(
          s.imageInjectVerdictNote(kNoAx),
          contains(axTerm),
          reason: '$locale: 64 did not say where to grant the permission',
        );
        expect(
          s.imageInjectVerdictNote(kSecureInput)!.contains(axTerm),
          isFalse,
          reason: '$locale: 63 sent the user to a place that cannot change this',
        );
      }
    });

    test('🔴 neither sentence may contain an imperative like 「重发／重新注入」 — this row has no such control', () {
      // The defect itself, as an assertion. The generic sentences for these two
      // codes end with exactly these words, which is correct on a text row and
      // false on a picture row.
      const List<String> forbidden = <String>[
        '重发',
        '重新注入',
        'resend',
        're-inject',
        'reinject',
        '再送',
        '再送信',
        '다시 보내',
        '다시 주입',
      ];
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[kSecureInput, kNoAx]) {
          final String note = s.imageInjectVerdictNote(code)!;
          for (final String word in forbidden) {
            expect(
              note.toLowerCase().contains(word.toLowerCase()),
              isFalse,
              reason: '$locale/$code contains 「$word」, but this row has no such control',
            );
          }
        }
      }
    });

    test('🔴 no injection-leg word may be read as 「没送到」', () {
      // Delivery ≠ injection (docs/rebuild/15 §2.0). Both verdicts ride `mode:'cached'`:
      // the frame WAS in the PC's process when it was judged. The pill already
      // says 已投递; the sentence must not contradict it.
      // Nine-locale expansion (2026-08-14): four-entry Map ⇒ exhaustive switch.
      // The old `reachedThePc[locale]` returned null for the five new locales,
      // and `contains(null)` **does not crash** — it becomes
      // `Expected: contains <null>`, a red nobody can read.
      // ⚠️ The ru probe in THIS file is 「в ленте ПК」 (prepositional), while
      // the sentence in `image_verdict_focus_lost_test.dart` is 「попало в ленту ПК」
      // (accusative) — **Russian nouns decline, and substring match does not**.
      // The two sites deliberately do not share one constant: sharing would
      // force a shorter common substring, which would weaken the probe down to
      // 「ПК」, a word that appears everywhere.
      String reachedThePc(AppLocale locale) => switch (locale) {
        AppLocale.zh => '已经送到电脑',
        AppLocale.zhTw => '已經送到電腦',
        AppLocale.en => 'reached the PC',
        AppLocale.fr => 'a atteint la chronologie du PC',
        AppLocale.es => 'Llegó a la cronología del PC',
        AppLocale.de => 'erreichte den Verlauf des PC',
        AppLocale.ja => 'パソコンに届いて',
        AppLocale.ko => 'PC에 도착',
        AppLocale.ru => 'в ленте ПК',
      };
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[kSecureInput, kNoAx]) {
          expect(
            s.imageInjectVerdictNote(code),
            contains(reachedThePc(locale)),
            reason: '$locale/$code did not make clear that this item reached the PC',
          );
        }
      }
    });

    test('every other code returns null — existing behaviour unchanged, byte for byte', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[
          // The fix-015 wrap-up card took `kFocusLost` off this list (it now
          // has the picture sentence). Every remaining name still falls back
          // to the generic sentence / the bare identifier.
          'INJECT_SELF_WINDOW_NO_INPUT',
          'INJECT_IMAGE_UNSUPPORTED',
          'INJECT_PC_MISMATCH',
          'LINK_DOWN',
          '',
        ]) {
          expect(s.imageInjectVerdictNote(code), isNull, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ② The rendered row: measured, not read off Text.data ─────────────────
  group('② render measurement — asserts the painted glyphs', () {
    for (final String code in <String>[kSecureInput, kNoAx]) {
      testWidgets('🔴 $code picture row at 411dp can say why, and is not eaten by the ellipsis', (
        WidgetTester tester,
      ) async {
        _handset(tester);
        await tester.pumpWidget(_tile(_row(code: code, isImage: true)));

        // (a) The row is in the state this card is about: no 重发 control.
        expect(
          find.byKey(kResendKey),
          findsNothing,
          reason: 'precondition failed: this row has a resend button, so this is not the defect under test',
        );

        // (b) It says something at all.
        final Finder note = find.byKey(kNoteKey);
        expect(note, findsOneWidget, reason: 'this row must be able to say why');

        // (c) Positive control — the sentence is genuinely long enough to be
        //     under layout pressure. Without this, 「not clipped」 could just mean the
        //     sample was short, and the test would be blind to the regression.
        final Text w = tester.widget<Text>(note);
        expect(
          _intrinsicWidth(w),
          greaterThan(tester.getSize(note).width),
          reason: 'sample too short — this test is blind to the regression',
        );

        // (d) The measurement that matters: nothing was lost to the ellipsis.
        expect(_clipped(tester, note), isFalse, reason: 'this sentence was eaten by the ellipsis');

        // (e) It is the PICTURE sentence, not the generic one, and not the raw
        //     identifier.
        expect(find.textContaining(code), findsNothing);
        expect(w.data, _zh.imageInjectVerdictNote(code));
      });
    }

    testWidgets('🔴 the grant path inside the 64 sentence must actually be painted', (WidgetTester tester) async {
      // The whole value of 64 is that the user can fix it. A sentence clipped
      // before 「辅助功能」 turns a solvable problem back into an unsolvable one,
      // so the term is asserted ON THE RENDERED paragraph having survived (d).
      _handset(tester);
      await tester.pumpWidget(_tile(_row(code: kNoAx, isImage: true)));
      final Finder note = find.byKey(kNoteKey);
      expect(_clipped(tester, note), isFalse);
      expect(
        tester.widget<Text>(note).data,
        contains('辅助功能'),
        reason: 'a half-sentence with the path clipped is the same as writing a solvable problem as unsolvable',
      );
    });

    testWidgets('two codes × every locale × picture row: each renders the full sentence and none is clipped', (
      WidgetTester tester,
    ) async {
      // 600dp rather than 411 for the same reason the neighbouring file's
      // four-locale loop uses it: under Ahem every glyph is a full em, so the
      // English status pill alone eats ~264dp of the meta row. Still stricter
      // than a real handset (Ahem@600 ≈ 50 chars a line, a real font@411 ≈ 70).
      for (final AppLocale locale in AppLocale.values) {
        // 🔴 Nine-locale expansion (2026-08-14): width is now computed from
        // **this locale's own text** (`ahemWidthAtLeast`, see
        // `support/legibility.dart`). The explanation above that
        // 「the English pill takes 264dp under Ahem」 is the same fact
        // `SCRIPT_WIDTH_FACTOR` names — back then only one language needed it,
        // so it was folded into a constant; the moment fr/es/de/ru arrived,
        // that constant was immediately too small (measured
        // `AppLocale.fr … 被省略号吃了`).
        // The old number stays as a **floor**: CJK / kana / hangul did not
        // get a single pixel narrower.
        _handset(tester, width: ahemWidthAtLeast(600, 411, locale));
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[kSecureInput, kNoAx]) {
          await tester.pumpWidget(
            _tile(_row(code: code, isImage: true), strings: s),
          );
          final Finder note = find.byKey(kNoteKey);
          expect(note, findsOneWidget, reason: '$locale/$code');
          expect(
            _clipped(tester, note),
            isFalse,
            reason: '$locale/$code was eaten by the ellipsis',
          );
          expect(
            tester.widget<Text>(note).data,
            s.imageInjectVerdictNote(code),
            reason: '$locale/$code painted something other than the picture sentence',
          );
        }
      }
    });

    testWidgets('🔴 reverse control: stuffing the same sentence into the meta-row leftover width clips it', (
      WidgetTester tester,
    ) async {
      // Not testing product code — proving this measurement CAN go red. Same
      // sentence, the width the meta row actually leaves after six chips.
      _handset(tester);
      const double kMetaRowLeftover = 56;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: kMetaRowLeftover,
              child: Text(
                _zh.imageInjectVerdictNote(kNoAx)!,
                key: const ValueKey<String>('squeezed'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      );
      expect(
        _clipped(tester, find.byKey(const ValueKey<String>('squeezed'))),
        isTrue,
        reason: 'if even this does not go red, the measurement itself is broken',
      );
    });
  });

  // ── ③ The coupling: the sentence follows the affordance, not the code ────
  group('③ copy and control share one source — one boolean, one answer', () {
    testWidgets('🔴 with the resend button, the generic sentence (containing 「重发」); without it, the picture sentence', (
      WidgetTester tester,
    ) async {
      // This is the assertion that survives card fix-018 giving 63 a bounded
      // retry: on that day the item goes back into `resendableImageEntryIds`,
      // the button becomes real, and the generic imperative becomes true again —
      // with no edit to the tile. A test keyed on the CODE would have to be
      // rewritten; this one just keeps passing.
      _handset(tester);

      await tester.pumpWidget(
        _tile(_row(code: kSecureInput, isImage: true), canResendImage: true),
      );
      expect(find.byKey(kResendKey), findsOneWidget, reason: 'precondition: the button is present');
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.injectVerdictNote(kSecureInput),
        reason: 'when the button is present, the generic sentence (「…再重发」) is the true one',
      );

      await tester.pumpWidget(
        _tile(_row(code: kSecureInput, isImage: true), canResendImage: false),
      );
      expect(find.byKey(kResendKey), findsNothing, reason: 'precondition: the button is absent');
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.imageInjectVerdictNote(kSecureInput),
        reason: 'when the button is absent, do not tell the user to press it',
      );
    });

    testWidgets('text row unchanged, byte for byte — the fix is the row shape, not the code', (WidgetTester tester) async {
      _handset(tester);
      for (final String code in <String>[kSecureInput, kNoAx]) {
        await tester.pumpWidget(_tile(_row(code: code, isImage: false)));
        expect(
          find.byKey(kResendKey),
          findsOneWidget,
          reason: '$code: the text row\'s deliveredNotInjected face already carries resend',
        );
        expect(
          tester.widget<Text>(find.byKey(kNoteKey)).data,
          _zh.injectVerdictNote(code),
          reason: '$code: the text row must still be the generic sentence',
        );
      }
    });

    testWidgets('✅ INJECT_FOCUS_LOST closed by the fix-015 wrap-up card — the moment the boundary moved', (
      WidgetTester tester,
    ) async {
      // 🔴 THIS TEST USED TO ASSERT THE OPPOSITE, and that is the point worth
      // keeping. It read 「刻意没扩大到 INJECT_FOCUS_LOST —— 同形，另一张卡」 and pinned
      // the generic sentence byte for byte, so that the scope boundary was a
      // FACT rather than an omission nobody noticed. The fix-015 follow-up closed the
      // boundary; this assertion went red on that change and was flipped
      // deliberately — it did not rot quietly, which is the entire value a
      // written-down boundary buys.
      //
      // Kept here rather than deleted (the full coverage lives in
      // `image_verdict_focus_lost_test.dart`): a boundary that moves should leave
      // a mark at the place it was declared, or the next reader of this file's
      // header believes 63/64 are still the only two.
      _handset(tester);
      await tester.pumpWidget(_tile(_row(code: kFocusLost, isImage: true)));
      expect(find.byKey(kResendKey), findsNothing);
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.imageInjectVerdictNote(kFocusLost),
        reason: 'the third same-shape code now also takes the picture sentence',
      );
    });
  });
}
