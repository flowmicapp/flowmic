// 🔴 Card M6-1 (0.2.53) — the source is a real-device photograph, not a deduction.
//
// 0.2.52, tablet TB335ZC, the `INJECT_SELF_WINDOW_NO_INPUT` row read:
//
//     ⤓ 13:39 ● 已投递 · 未注入 · INJ… 重发 → H… 1 字
//
// The status word is **correct** (the PC itself answered the inject stretch),
// and "by what right we say so" was layout-clipped to **three letters**.
// CLAUDE.md R11 requires every status word to be able to answer "by what
// right" — an unreadable answer equals no answer.
//
// 🔴 This card's real lesson is on the test side, not the implementation side:
// **this family of defects is invisible to the existing suite by nature.**
// `cloud_image_error_copy_test.dart` itself writes at the original site
// "Text widget's own data, not the rendered/clipped glyphs, so this still
// matches even though the row's Flexible+ellipsis would visually truncate a
// sentence this long" — i.e. **it knew it would be clipped, then asserted
// around the clipping**. The assertion measures `Text.data`; the user reads
// the glyphs left after layout; the two were never the same thing.
// ⇒ **Rule: any acceptance of "can the user read this sentence" must land
//   the assertion on the render result** (intrinsic width vs. the actual box,
//   `didExceedMaxLines`), never on `Text.data`. The two-row header card
//   (`chat_header_name_not_starved_widget_test.dart`) uses the same technique.
//
// ⚠️ Every case carries a positive control: while asserting "this sentence
//   was not clipped", also assert it **really is long enough to create
//   pressure** (intrinsic width > one-line width ⇒ it must wrap to fit).
//   Without the latter, "not clipped" may just be because the sentence was
//   short to begin with, and then this test is blind to the regression.
//
// 🔴 **This file does not measure real-device pixels; know where the gap is**:
//   `flutter_test` uses the Ahem placeholder font; every glyph is a **full-em
//   square** ⇒ a 411dp line holds only 411/11.5 ≈ 35 characters; a real font
//   (Chinese ≈ 34, Latin ≈ 70+) is much looser. So the character budget here
//   is **conservative**: unclipped under Ahem ⇒ necessarily unclipped on a
//   real device; the converse does not hold.
//   ⚠️ Therefore **do not** use this file the other way to argue "a given
//   sentence fits exactly on a real device" — it only answers the "will it
//   be clipped" direction. On ship day it was looked at again on a real
//   device (0.2.53 tablet photograph).

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

/// The one owner hit on a real device (the 61 code newly added in 0.2.48; the
/// phone side had no copy for it before).
const String kSelfWindow = 'INJECT_SELF_WINDOW_NO_INPUT';
const String kFocusLost = 'INJECT_FOCUS_LOST';

/// MAC-05 (owner 2026-08-07 approved 63/64). Both are `mode:'cached'`.
const String kSecureInput = 'INJECT_SECURE_INPUT_ACTIVE';
const String kNoAx = 'INJECT_NO_ACCESSIBILITY';

/// The eight inject-stretch codes, one by one.
const List<String> kInjectCodes = <String>[
  kFocusLost,
  kSelfWindow,
  'INJECT_TARGET_INVALID',
  'INJECT_SENDINPUT_FAIL',
  'INJECT_CLIPBOARD_FAIL',
  'INJECT_IMAGE_UNSUPPORTED',
  kSecureInput,
  kNoAx,
];

/// Codes that walk the `mode:'cached'` bucket (the rest the server maps to
/// failed).
bool _isCachedCode(String code) =>
    code == kFocusLost ||
    code == kSelfWindow ||
    code == kSecureInput ||
    code == kNoAx;

TimelineEntry _entry({
  required EntryStatus status,
  bool cachedByVerdict = false,
  String? failureReason,
  String text = '这是一句真机上会出现的转录',
}) {
  final DateTime now = DateTime.utc(2026, 8, 3, 13, 39);
  return TimelineEntry(
    id: 'loc_verdict',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: text,
    status: status,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: failureReason,
    cachedByVerdict: cachedByVerdict,
    // The real-device row also hung a destination and a window name — they
    // are exactly the cells that squeezed the reason out. Without them is
    // inviting the culprit off the crime scene.
    pcName: 'dev-pc-a',
    injectTarget: const InjectTarget(
      windowTitle: '无标题 - 记事本',
      processName: 'Notepad',
      injectedAt: '2026-08-03T05:39:08Z',
    ),
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, {AppStrings strings = _zh}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: false,
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

/// How wide this text wants to be **under no constraint**. Compare with the
/// actual box and you know whether it was ellipsized.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// After render, did this text overflow its own `maxLines` (＝ the user sees
/// an ellipsis).
bool _clipped(WidgetTester tester, Finder f) {
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  return p.didExceedMaxLines;
}

void main() {
  // ── ① Pure mapping: each of the eight codes has one four-locale human
  //    sentence; an unrecognized code must not invent one ───────────────────
  group('① injectVerdictNote — per-code human sentence', () {
    test('all eight inject-stretch codes are non-empty in four locales, and pairwise distinct', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final Set<String> seen = <String>{};
        for (final String code in kInjectCodes) {
          final String? note = s.injectVerdictNote(code);
          expect(note, isNotNull, reason: '$locale/$code');
          expect(note, isNotEmpty, reason: '$locale/$code');
          // One sentence holding for two codes = another "one value answering
          // two questions".
          expect(
            seen.add(note!),
            isTrue,
            reason: '$locale/$code said the same sentence as some earlier code',
          );
        }
      }
    });

    test('🔴 "cannot get a window" and "focus is on our own window" must be said differently', () {
      // error_codes.rs explicitly forbids these two situations from sharing
      // a code (pipeline_tests.rs `stage0_runs_before_stage1_…` has a
      // positive control for it). Codes split but sentences the same equals
      // merging them again on the user's side.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(
          s.injectVerdictNote(kFocusLost),
          isNot(s.injectVerdictNote(kSelfWindow)),
          reason: '$locale',
        );
      }
    });

    test('🔴 MAC-05 · 63 and 64 must give **opposite** actions, in all four locales', () {
      // 🔴 This case is the only mechanical carrier in code of owner
      // 2026-08-07's table. Owner split these two situations into two codes
      // because their **actions are opposite**: 63 is fine once you leave
      // the password field; 64 will never be fine without going to system
      // settings. Synthesizing one sentence, or two sentences saying the
      // same thing, equals merging on the user's side the two things owner
      // just split (15-book §2.5e-4: the various causes of the same status
      // share `mode`, but must never share a code — and must never share a
      // sentence).
      //
      // ⚠️ **It cannot replace the queue half**: the copy tells the user
      // what to do; it does not decide what the queue does. The "63 is
      // retryable" half of owner's table **has no implementation; it was
      // stopped and reported**, see the long comment on
      // `INJECT_NO_ACCESSIBILITY` in
      // `packages/protocol/src/inject-verdict-authorship.ts`.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String? secure = s.injectVerdictNote(kSecureInput);
        final String? noAx = s.injectVerdictNote(kNoAx);
        expect(secure, isNotNull, reason: '$locale');
        expect(noAx, isNotNull, reason: '$locale');
        expect(secure, isNot(noAx), reason: '$locale: the two were given the same sentence');
        // 64 must point at **where to go change it** — saying only the cause
        // equals writing a solvable problem as unsolvable. The criterion is
        // each language's local name for the "Accessibility" system-settings
        // item.
        // Nine-locale expansion (2026-08-14): moved to
        // support/locale_terms.dart, shared with the picture variant in
        // image_verdict_affordance_test.dart (byte-identical copy until today).
        final String axTerm = accessibilityTerm(locale);
        expect(noAx, contains(axTerm), reason: '$locale: 64 did not say where to go authorize');
        // Reverse control: 63 **must not** send the person to system
        // settings — there is nothing there that it needs.
        expect(
          secure!.contains(axTerm),
          isFalse,
          reason: '$locale: 63 sent the user to a place that cannot change it',
        );
      }
    });

    test('an unrecognized code returns null —— fall back to the bare identifier, do not invent a sentence', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[
          'LINK_DOWN',
          'PC_BUSY',
          'INJECT_NO_RESULT',
          'INJECT_PC_MISMATCH',
          '',
        ]) {
          expect(s.injectVerdictNote(code), isNull, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ② Measurement: this sentence must read in full on the narrowest phone ─
  group('② render measurement —— asserting the painted glyphs, not Text.data', () {
    testWidgets('🔴 the own-window sentence is not eaten by an ellipsis on a 411dp phone', (
      WidgetTester tester,
    ) async {
      // Phone width, not the default 800x600: this defect only holds on a
      // narrow screen.
      tester.view.physicalSize = const Size(411 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: kSelfWindow,
          ),
        ),
      );

      final Finder note = find.byKey(
        const ValueKey<String>('entry.reasonNote.loc_verdict'),
      );
      expect(note, findsOneWidget, reason: 'this row must be able to say why');

      // Positive control: it **really is** too long for one line — otherwise
      // "not clipped" proves nothing.
      final Text w = tester.widget<Text>(note);
      final double oneLine = tester.getSize(note).width;
      expect(
        _intrinsicWidth(w),
        greaterThan(oneLine),
        reason: 'sample too short, this test is blind to the regression',
      );

      // Negative assertion: after wrapping it fits, no overflow of maxLines.
      expect(_clipped(tester, note), isFalse, reason: 'this sentence was eaten by an ellipsis');

      // What the user reads is the whole sentence, not the first three
      // letters of the identifier.
      expect(find.textContaining(kSelfWindow), findsNothing);
      expect(
        (tester.widget<Text>(note).data ?? ''),
        _zh.injectVerdictNote(kSelfWindow),
      );
    });

    testWidgets('🔴 MAC-05 · the 64 sentence is not eaten by an ellipsis on a 411dp phone', (
      WidgetTester tester,
    ) async {
      // 🔴 **Why 64 gets its own case, rather than leaning on the eight-code
      // loop below**: it is **the only failure on the whole chain the user
      // can fix themselves**, and its human sentence must say the whole path
      // 「系统设置 ▸ 隐私与安全性 ▸ 辅助功能」 ⇒ it is the longest sentence on this
      // table, and the one most easily clipped. And once it is clipped, what
      // gets clipped is exactly **that path itself** — the leftover half-
      // sentence will only say "no permission", writing a solvable problem
      // as unsolvable.
      //
      // ⚠️ Using 411dp (rather than the 600dp of the eight-code loop) is
      // deliberate: that one was widened for the English capsule's width
      // under Ahem; this one wants the answer for **Chinese on the
      // narrowest real device**.
      tester.view.physicalSize = const Size(411 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: kNoAx,
          ),
        ),
      );

      final Finder note = find.byKey(
        const ValueKey<String>('entry.reasonNote.loc_verdict'),
      );
      expect(note, findsOneWidget, reason: 'this row must be able to say why');

      // Positive control: this sentence **really is** too long for one line
      // — otherwise "not clipped" proves nothing.
      final Text w = tester.widget<Text>(note);
      final double oneLine = tester.getSize(note).width;
      expect(
        _intrinsicWidth(w),
        greaterThan(oneLine),
        reason: 'sample too short, this test is blind to the regression',
      );

      // 🔴 The assertion lands on the **render result** (`didExceedMaxLines`),
      // not `Text.data`. 0.2.53's lesson: asserting `Text.data` 1259 tests
      // were all green, and the screen showed three letters.
      expect(_clipped(tester, note), isFalse, reason: 'this sentence was eaten by an ellipsis');

      // What the user reads is the whole human sentence, not that 23-
      // character bare identifier.
      expect(find.textContaining(kNoAx), findsNothing);
      // And **that path** must really have been painted — that is the reason
      // this sentence exists.
      expect(
        (tester.widget<Text>(note).data ?? ''),
        contains('辅助功能'),
        reason: 'a half-sentence with the path clipped equals writing a solvable problem as unsolvable',
      );
    });

    testWidgets('🔴 reverse control: stuffing this sentence back into the meta row clips it —— the defect reproduced in the test', (
      WidgetTester tester,
    ) async {
      // This is not measuring product code; it is **proving this test is
      // capable of going red**: put the same sentence into the width it had
      // on the real device (inside the meta row, fighting badge / time /
      // capsule / resend / source / char-count), it necessarily overflows.
      // The number is the order of magnitude from the real-device
      // screenshot: the whole row is 411dp; after subtracting those six
      // cells the reason has only a few tens of dp left.
      tester.view.physicalSize = const Size(411 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const double kMetaRowLeftover = 56;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: kMetaRowLeftover,
              child: Text(
                _zh.injectVerdictNote(kSelfWindow)!,
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
        reason: 'even this does not go red, so the measuring method itself is broken',
      );
    });

    testWidgets('all eight codes render the whole sentence in four locales and none are clipped', (WidgetTester tester) async {
      // ⚠️ This one is **deliberately** wider than the one above (600 not
      // 411), and the reason is a product of Ahem not of the product: the
      // English status capsule `Delivered · not injected` is 24 glyphs, and
      // under full-em squares that is already 24×11 ≈ 264dp; plus badge /
      // time / resend the meta row overflows on 411dp outright. In a real
      // font the same capsule is about 130dp (on the real-device photograph
      // it shared a row with all the cells and did not overflow).
      // 🔴 After widening to 600 this assertion is **still stricter than a
      // real device**: Ahem@600 one line ≈ 52 characters, real font@411 one
      // line ≈ 70 characters ⇒ if it passes here, a real device necessarily
      // passes.
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        // 🔴 Nine-locale expansion (2026-08-14): width is now computed from
        // **this locale's text** (`ahemWidthAtLeast`, see
        // `support/legibility.dart`). The explanation above that "the
        // English capsule needs 264dp under Ahem" is the same thing
        // `SCRIPT_WIDTH_FACTOR` says — back then only one language needed
        // it, so it was folded into a constant; the moment fr/es/de/ru
        // arrived that constant was immediately not enough (measured
        // `AppLocale.fr … 被省略号吃了`).
        // The old number is kept as a **floor**: CJK / kana / hangul did
        // not get one pixel narrower.
        tester.view.physicalSize =
            Size(ahemWidthAtLeast(600, 411, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        for (final String code in kInjectCodes) {
          // FOCUS_LOST / SELF_WINDOW are cached; the other four are not
          // cached ⇒ the server maps them to failed. Walk both buckets,
          // because the human sentence is keyed by **code**, not by face.
          final bool isCached = _isCachedCode(code);
          await tester.pumpWidget(
            _tile(
              _entry(
                status: isCached ? EntryStatus.cached : EntryStatus.failed,
                cachedByVerdict: isCached,
                failureReason: code,
              ),
              strings: s,
            ),
          );
          final Finder note = find.byKey(
            const ValueKey<String>('entry.reasonNote.loc_verdict'),
          );
          expect(note, findsOneWidget, reason: '$locale/$code');
          expect(
            _clipped(tester, note),
            isFalse,
            reason: '$locale/$code was eaten by an ellipsis',
          );
          expect(find.textContaining(code), findsNothing, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ③ Unrecognized codes: behavior unchanged by one character (the bare
  //    code is still on the meta row) ───────────────────────────────────────
  group('③ unrecognized codes —— existing behavior must not be changed by this card', () {
    testWidgets('failed + LINK_DOWN still prints the bare identifier, and does not grow a reason row', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(_entry(status: EntryStatus.failed, failureReason: 'LINK_DOWN')),
      );
      expect(find.textContaining('LINK_DOWN'), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.reasonNote.loc_verdict')),
        findsNothing,
        reason: 'a code with no human sentence must not grow a whole row out of nowhere',
      );
    });

    testWidgets('the injected face still says not one word', (WidgetTester tester) async {
      await tester.pumpWidget(
        _tile(_entry(status: EntryStatus.injected, failureReason: kSelfWindow)),
      );
      expect(
        find.byKey(const ValueKey<String>('entry.reasonNote.loc_verdict')),
        findsNothing,
      );
    });
  });
}
