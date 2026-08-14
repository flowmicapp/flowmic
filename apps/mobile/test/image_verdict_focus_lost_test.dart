// 🔴 The fix-015 follow-up — a PICTURE row that settles on `INJECT_FOCUS_LOST`.
//
// ⚠️ NO CARD NUMBER ON PURPOSE. This is the open account recorded as item ④ of
// `docs/strategy/2026-08-10-lan-window-task-book.md` §9 收尾清单 (「`INJECT_FOCUS_LOST`
// 在图片行上与 63/64 同形（`fix-015` 明账、行为未动、边界有测试钉住）」), not a numbered
// card. `fix-021` was drafted into these comments and taken back out: that number
// already belongs to `fix-021-img1-store-failure-code` in the same task book, and
// one symbol with two referents is the collision CLAUDE.md keeps paying for (the
// `F-3` clash, the two ②'s). Referred to by what it is, so it stays greppable
// either way.
//
// ── WHAT WAS WRONG (the shape card fix-015 named and left open) ─────────────
//
// fix-015 fixed `INJECT_SECURE_INPUT_ACTIVE` (63) and `INJECT_NO_ACCESSIBILITY`
// (64) and wrote down, in its own table's doc and in an assertion in
// `image_verdict_affordance_test.dart` group ③, that `INJECT_FOCUS_LOST` has the
// SAME shape and was deliberately left alone. This card closes it. Measured on
// this tree before the change, a picture row on `INJECT_FOCUS_LOST` rendered:
//
//     ⤓ 已投递 · 未注入        → dev-pc-a        图片
//     电脑上没有找到可以输入的地方。到电脑上点进输入框再重发。
//
// The last clause names 重发, and this row has no 重发:
//   · PHONE — `INJECT_FOCUS_LOST` ∈ `kPcInjectionVerdictCodes` ⇒ `outboxSettle`
//     settles the item terminal ⇒ it leaves `OutboxPendingView
//     .resendableImageEntryIds` ⇒ `canResendImage` false ⇒ no button;
//   · PC — `TimelinePage.vue` `rowCanReinject` = `e.entry_type !== 'image' &&
//     canReinject(e.status)` ⇒ a picture row renders no 重新注入 either.
// ⇒ 「copy promises an action that does not exist」, the thing `error-codes.ts` already ruled against at
// `INJECT_DEFERRED_NOT_AUTOINJECTED`: 「state the fact, add no imperative the
// product cannot honour」. On a TEXT row that same sentence is TRUE, which is why
// the fix keys on the ROW SHAPE — `_reasonNoteFor`'s `hasResendAffordance`, the
// very boolean that draws the button — and never on the code.
//
// ── WHAT THIS FILE MEASURES, AND WHY IT MEASURES IT THAT WAY ───────────────
//
// 🔴 Assertions land on the RENDERED result, never on `Text.data` alone, for the
// reason `inject_verdict_note_test.dart` records: 0.2.53 shipped with 1259 green
// tests while the screen showed three letters, because the covering test asserted
// the widget's own data and stepped around the clipping. So: intrinsic width vs.
// the actual box (a POSITIVE control that the sentence is genuinely under layout
// pressure — without it, 「not clipped」 could just mean the sample was short) plus
// `RenderParagraph.didExceedMaxLines` (the negative one — did the user lose the
// end of it).
//
// 🔴 The premises are asserted against the MECHANISM, not against this author's
// belief about it: group ⓪ asks `isPcInjectionVerdictCode` and
// `isTransientInjectionVerdictCode` directly. If somebody later rules this code
// transient (fix-018's dimension) or takes it out of the authorship set, the queue
// item stops settling terminal, the button becomes real — and these tests say so
// instead of quietly continuing to pass on a sentence that has gone false.
//
// 🔴 The Ahem placeholder font makes every glyph a full em, so the character
// budget here is CONSERVATIVE IN ONE DIRECTION ONLY: not clipped under Ahem ⇒ not
// clipped with a real font. The converse does not hold, and nothing in this file
// may be used to argue 「it fits on a real device」.
//
// ── REVERSE CONTROL, ACTUALLY RUN (2026-08-10, this tree) ──────────────────
//
// The `INJECT_FOCUS_LOST` case label in `AppStrings.imageInjectVerdictNote` was
// renamed so the code falls through to `default: null` — the exact pre-card
// behaviour. This file went **4 pass / 9 fail** (and the two files together, 16
// pass / 10 fail: fix-015's flipped group-③ assertion is the tenth).
//
// The failure that IS the defect, verbatim, from group ③:
//
//     Expected: <null>
//       Actual: '电脑上没有找到可以输入的地方。到电脑上点进输入框再重发。'
//     按钮不在的时候，不许再叫用户去按它
//
// ⚠️ READ THE `Actual` LINE, NOT THE `Expected` ONE. 「Expected: <null>」 is an
// artifact of the control method: the expectation is computed by calling the very
// function that was disabled, so its side collapses to null. The load-bearing half
// is `Actual` — a picture row with NO 重发 button rendering a sentence that ends
// 「…再重发。」. That is the whole card, printed by the test.
//
// The positive control (c) also earned its place, in the same run:
//
//     Expected: a value greater than <329.0>
//       Actual: <322.0>
//     样本太短，这个测试对回归是瞎的
//
// i.e. the generic sentence is SHORTER than its box ⇒ under the old copy this row
// was not under layout pressure at all, so a bare 「not clipped」 assertion would have
// been green for a reason having nothing to do with the product.
//
// ⚠️ Group ②'s own 「reverse control: squeeze it into the meta row」 case also went red under this control,
// and that one is NOISE — it dereferences the disabled string. It proves the
// measurement can go red (its job); it is not evidence about this card.
//
// Restored; the file is 13/13 green and `grep REVERSE-CONTROL` finds nothing in
// this card's production files.
//
// ── WHAT THIS FILE CANNOT PROVE ────────────────────────────────────────────
//
// The code is raised by `inject/pipeline.rs` `stage1_focus` (「Stage 1, shared by
// the text and image paths」) in two arms — no locked/live target HWND, or
// `SetForegroundWindow` returned FALSE. This runs on the host test VM with a
// hand-built row, so it proves the MAPPING and the LAYOUT, never that a real PC
// produces this code on a real picture.

import 'package:flowmic/src/session/outbox_inject_authorship.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'support/legibility.dart' show ahemWidthAtLeast;

const AppStrings _zh = AppStringsZh();

const String kFocusLost = 'INJECT_FOCUS_LOST';

/// The two codes fix-015 already answered. Present as CONTRAST: this card's
/// sentence has to be a third answer, not a copy of either.
const String kSecureInput = 'INJECT_SECURE_INPUT_ACTIVE';
const String kNoAx = 'INJECT_NO_ACCESSIBILITY';

const ValueKey<String> kNoteKey = ValueKey<String>('entry.reasonNote.loc_img');
const ValueKey<String> kResendKey = ValueKey<String>('entry.resend.loc_img');

TimelineEntry _row({required bool isImage, String code = kFocusLost}) {
  final DateTime now = DateTime.utc(2026, 8, 10, 13, 39);
  return TimelineEntry(
    id: 'loc_img',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: isImage ? '🖼 PNG · 214 KB' : '这是一句真机上会出现的转录',
    // `stage1_focus` answers with `InjectMode::Cached` on both of its arms ⇒
    // `applyInjectResult` settles the row cached + cachedByVerdict ⇒
    // `deliveryFaceOf` → deliveredNotInjected.
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
}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: false,
      canResendImage: canResendImage,
      onRetry: (TimelineEntry _) {},
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
  // ── ⓪ The premises, asked of the mechanism rather than assumed ────────────
  group('⓪ premises — ask the mechanism, not the author\'s memory', () {
    test('🔴 this code settles the queue item terminal ⇒ a picture row will not have a resend button', () {
      // The whole sentence rests on this. `isPcInjectionVerdictCode` true ⇒
      // `outboxSettle` settles delivered/terminal ⇒ the item leaves
      // `OutboxPendingView.resendableImageEntryIds` ⇒ `canResendImage` false.
      // Take the code out of that set and the button comes back — at which point
      // the picture sentence would be the wrong one, and this line says so first.
      expect(isPcInjectionVerdictCode(kFocusLost), isTrue);
    });

    test('🔴 nobody has ruled it transient ⇒ this sentence must not promise it will clear itself', () {
      // 63 may say 「这是暂时的」 because owner ruled it transient and
      // `transientVerdictEarnsAnotherAttempt` honours that with a bounded retry.
      // Nothing re-sends THIS frame on its own, so the same shape here would be a
      // wait with no mechanism — the F-1 red line. Pinned to the predicate, so
      // the day somebody does rule it transient this assertion is the reminder
      // that the copy has to change with it.
      expect(isTransientInjectionVerdictCode(kFocusLost), isFalse);
      expect(isTransientInjectionVerdictCode(kSecureInput), isTrue);
    });
  });

  // ── ① The table: a third sentence, in four languages ──────────────────────
  group('① imageInjectVerdictNote(INJECT_FOCUS_LOST)', () {
    test('all four languages are non-empty, and none is the same sentence as 63/64', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String? note = s.imageInjectVerdictNote(kFocusLost);
        expect(note, isNotNull, reason: '$locale');
        expect(note, isNotEmpty, reason: '$locale');
        // 「没有找到可以输入的地方」 is a different cause from 「安全输入」 and from
        // 「没有权限」. One sentence covering more than one cause is the
        // one-value-two-questions shape the owner minted separate codes to avoid.
        expect(
          note,
          isNot(s.imageInjectVerdictNote(kSecureInput)),
          reason: '$locale: gave the same sentence as 63',
        );
        expect(
          note,
          isNot(s.imageInjectVerdictNote(kNoAx)),
          reason: '$locale: gave the same sentence as 64',
        );
        // And it is not just the generic one echoed back.
        expect(
          note,
          isNot(s.injectVerdictNote(kFocusLost)),
          reason: '$locale: the picture sentence IS the generic sentence',
        );
      }
    });

    test('🔴 must not contain an imperative like 「重发／重新注入」 — this row has no such control', () {
      // The defect itself, as an assertion. The generic sentence for this code
      // ends with exactly these words, which is correct on a text row and false
      // on a picture row.
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
        final String note = AppStrings.of(
          locale,
        ).imageInjectVerdictNote(kFocusLost)!;
        for (final String word in forbidden) {
          expect(
            note.toLowerCase().contains(word.toLowerCase()),
            isFalse,
            reason: '$locale contains 「$word」, and this row has no such control',
          );
        }
      }
    });

    test('🔴 not a single character may be read as 「没送到」', () {
      // delivery ≠ injection (docs/rebuild/15 §2.0). `stage1_focus` answers
      // `InjectMode::Cached`: the frame WAS in the PC's process when it was
      // judged, and `row_transit::mint_row` minted the row from the same
      // expression. The pill already says 已投递; the sentence must agree.
      // Nine-locale expansion (2026-08-14): four Maps ⇒ exhaustive switch (the
      // five new locales originally got null, and `contains(null)` does not
      // crash, it just goes red as `Expected: contains <null>`).
      // ⚠️ ru here is 「в ленту ПК」 (accusative, 「попало в ленту」), while the
      // sibling `image_verdict_affordance_test.dart` is 「в ленте ПК」
      // (prepositional, 「Оно в ленте」) — Russian noun case; substring match
      // does not decline, so the two probes differ and are deliberately not shared.
      String reachedThePc(AppLocale locale) => switch (locale) {
        AppLocale.zh => '已经送到电脑',
        AppLocale.zhTw => '已經送到電腦',
        AppLocale.en => 'reached the PC',
        AppLocale.fr => 'a atteint la chronologie du PC',
        AppLocale.es => 'Llegó a la cronología del PC',
        AppLocale.de => 'erreichte den Verlauf des PC',
        AppLocale.ja => 'パソコンに届いて',
        AppLocale.ko => 'PC에 도착',
        AppLocale.ru => 'в ленту ПК',
      };
      for (final AppLocale locale in AppLocale.values) {
        expect(
          AppStrings.of(locale).imageInjectVerdictNote(kFocusLost),
          contains(reachedThePc(locale)),
          reason: '$locale did not make clear that this item reached the PC',
        );
      }
    });

    test('🔴 must not promise it will clear itself (that is 63\'s line; see ⓪)', () {
      // Distinct from the forbidden-imperative test above: this one is about a
      // promise, not a control. 63's sentence ends 「这是暂时的…就不会再被挡下」 and
      // has a mechanism (`kTransientInjectionVerdictCodes`) behind it; this code
      // has none, so borrowing the wording would be a wait nothing honours.
      // Nine-locale expansion (2026-08-14): four Maps + `[locale]!` ⇒ exhaustive
      // switch (the five new locales originally crashed on a null assertion).
      // Each locale's words are taken from the wording **that locale's 63
      // sentence** actually uses to promise 「it will clear itself」
      // (fr「Le blocage cesse」/ es「El bloqueo cesa」/
      // de「Die Sperre endet」/ ru「Блок спадёт」/ zh-TW「這是暫時的」),
      // plus common stems for 「temporary/automatic」 in that language — what
      // is banned is the words a translator would actually write.
      List<String> selfClearing(AppLocale locale) => switch (locale) {
        AppLocale.zh => <String>['暂时', '自动'],
        AppLocale.zhTw => <String>['暫時', '自動'],
        AppLocale.en => <String>['temporar', 'clears', 'by itself'],
        AppLocale.fr => <String>['temporair', 'automatiq', 'cesse'],
        AppLocale.es => <String>['temporal', 'automátic', 'cesa'],
        AppLocale.de => <String>['vorüberge', 'temporär', 'automatisch', 'endet'],
        AppLocale.ja => <String>['一時的', '自動'],
        AppLocale.ko => <String>['일시적', '자동'],
        AppLocale.ru => <String>['временн', 'автоматич', 'спадёт'],
      };
      for (final AppLocale locale in AppLocale.values) {
        final String note = AppStrings.of(
          locale,
        ).imageInjectVerdictNote(kFocusLost)!.toLowerCase();
        for (final String word in selfClearing(locale)) {
          expect(
            note.contains(word.toLowerCase()),
            isFalse,
            reason: '「$word」 in $locale promised a thing no mechanism honours',
          );
        }
      }
      // Positive control for the negative assertion above: 63 DOES say it, so a
      // green here cannot mean the probe is blind.
      expect(_zh.imageInjectVerdictNote(kSecureInput), contains('暂时'));
    });
  });

  // ── ② The rendered row: measured, not read off Text.data ─────────────────
  group('② render measurement — asserting the glyphs that were drawn', () {
    testWidgets('🔴 at 411dp it can say why, and the ellipsis did not eat it', (WidgetTester tester) async {
      _handset(tester);
      await tester.pumpWidget(_tile(_row(isImage: true)));

      // (a) The row is in the state this card is about: no 重发 control.
      expect(
        find.byKey(kResendKey),
        findsNothing,
        reason: 'premise failed: this row has a resend button, so we are not measuring this defect',
      );

      // (b) It says something at all.
      final Finder note = find.byKey(kNoteKey);
      expect(note, findsOneWidget, reason: 'this row must be able to say why');

      // (c) Positive control — the sentence is genuinely under layout pressure.
      final Text w = tester.widget<Text>(note);
      expect(
        _intrinsicWidth(w),
        greaterThan(tester.getSize(note).width),
        reason: 'sample too short; this test is blind to the regression',
      );

      // (d) The measurement that matters: nothing was lost to the ellipsis.
      expect(_clipped(tester, note), isFalse, reason: 'the ellipsis ate this sentence');

      // (e) It is the PICTURE sentence — not the generic one, not the raw code.
      expect(find.textContaining(kFocusLost), findsNothing);
      expect(w.data, _zh.imageInjectVerdictNote(kFocusLost));
    });

    testWidgets('🔴 the clause 「到电脑上点进要输入的地方」 must actually have been drawn', (WidgetTester tester) async {
      // This clause is the only actionable half of the sentence. Clipped before
      // it, the row states a problem and offers nothing — which is the state the
      // card was opened against, arrived at by layout instead of by wording.
      _handset(tester);
      await tester.pumpWidget(_tile(_row(isImage: true)));
      final Finder note = find.byKey(kNoteKey);
      expect(_clipped(tester, note), isFalse);
      expect(
        tester.widget<Text>(note).data,
        contains('点进要输入的地方'),
        reason: 'the action half of the sentence was clipped; only a complaint remains',
      );
    });

    testWidgets('four languages × picture row: the full sentence renders and none is clipped', (WidgetTester tester) async {
      // 600dp rather than 411 for the same reason the neighbouring file's
      // four-locale loop uses it: under Ahem every glyph is a full em, so the
      // English status pill alone eats ~264dp of the meta row. Still stricter
      // than a real handset (Ahem@600 ≈ 50 chars a line, a real font@411 ≈ 70).
      for (final AppLocale locale in AppLocale.values) {
        // 🔴 Nine-locale expansion (2026-08-14): width is now computed from
        // **this locale's script** (`ahemWidthAtLeast`, see
        // `support/legibility.dart`). The 「English pill wants 264dp under Ahem」
        // in the paragraph above is the same fact `SCRIPT_WIDTH_FACTOR` names —
        // back then only one language needed it, so it was folded into a
        // constant; the moment fr/es/de/ru arrived that constant was not enough
        // (measured `AppLocale.fr … 被省略号吃了`).
        // The old number is kept as a **floor**: CJK / kana / hangul did not
        // get a single pixel narrower.
        _handset(tester, width: ahemWidthAtLeast(600, 411, locale));
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_tile(_row(isImage: true), strings: s));
        final Finder note = find.byKey(kNoteKey);
        expect(note, findsOneWidget, reason: '$locale');
        expect(_clipped(tester, note), isFalse, reason: '$locale was eaten by the ellipsis');
        expect(
          tester.widget<Text>(note).data,
          s.imageInjectVerdictNote(kFocusLost),
          reason: '$locale did not draw the picture sentence',
        );
      }
    });

    testWidgets('🔴 reverse control: the same sentence squeezed into the meta row\'s leftover width WILL clip', (
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
                _zh.imageInjectVerdictNote(kFocusLost)!,
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
  group('③ copy and control share a source — one boolean, one answer', () {
    testWidgets('🔴 with a resend button, say the generic sentence (contains「重发」); without, say the picture sentence', (
      WidgetTester tester,
    ) async {
      // The assertion group ③ of image_verdict_affordance_test.dart exists to
      // make: keyed on the AFFORDANCE, so it survives any future ruling that
      // hands this code a retry. A test keyed on the CODE would have to be
      // rewritten that day; this one just keeps passing.
      _handset(tester);

      await tester.pumpWidget(_tile(_row(isImage: true), canResendImage: true));
      expect(find.byKey(kResendKey), findsOneWidget, reason: 'premise: the button is present');
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.injectVerdictNote(kFocusLost),
        reason: 'when the button is present, the generic sentence (「…再重发」) is the true one',
      );

      await tester.pumpWidget(_tile(_row(isImage: true), canResendImage: false));
      expect(find.byKey(kResendKey), findsNothing, reason: 'premise: the button is absent');
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.imageInjectVerdictNote(kFocusLost),
        reason: 'when the button is absent, do not tell the user to press it',
      );
    });

    testWidgets('a text row did not change by a single character — the fix is the row\'s shape, not the code', (WidgetTester tester) async {
      _handset(tester);
      await tester.pumpWidget(_tile(_row(isImage: false)));
      expect(
        find.byKey(kResendKey),
        findsOneWidget,
        reason: 'a text row\'s deliveredNotInjected face already carries resend',
      );
      expect(
        tester.widget<Text>(find.byKey(kNoteKey)).data,
        _zh.injectVerdictNote(kFocusLost),
        reason: 'a text row must still be the generic sentence',
      );
    });

    testWidgets('63/64 picture rows did not change by a single character — this card only added a third', (WidgetTester tester) async {
      // fix-015's two sentences are the neighbours this one must not disturb.
      _handset(tester);
      for (final String code in <String>[kSecureInput, kNoAx]) {
        await tester.pumpWidget(_tile(_row(isImage: true, code: code)));
        expect(
          tester.widget<Text>(find.byKey(kNoteKey)).data,
          _zh.imageInjectVerdictNote(code),
          reason: '$code: this card changed it',
        );
      }
    });
  });
}
