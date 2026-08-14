// 🔴 WP5 review annex §4-1 close-out — **render** criteria for three
// user-visible copy strings (0.2.53 law).
//
// SPEC-REF: docs/strategy/2026-08-13-wp5-review-annex.md §4-1 ledger item 1
//   (`controlRowClearNote` (en 78 chars, lands in a maxLines:3 + ellipsis
//   card, lengthened this round) / `keyClearHint` / `aiRestoreOriginal`
//   (then **zero content assertions**, driven only by `ValueKey`) — three
//   strings **missing a render assertion**). Annex §2-2 already sat down
//   that the return-report sentence "two rescued copy strings were given
//   render assertions" is false: what was actually asserted was
//   `Text.data`, and only zh was tested.
//
// Law = CLAUDE.md 0.2.53 paragraph: **any acceptance of "can the user
// read this sentence" must land the assertion on the rendered result
// (didExceedMaxLines / geometry), never on `Text.data`.** That round's
// 1259 all-green with only three letters on screen (`INJ…`) was exactly
// because the assertion walked around clipping to read `Text.data`.
//
// This file and the two existing sites have a **clear split, deliberately
// not merged**:
//   · `control_key_history_test.dart:99` / `compose_band_widget_test.dart:635`
//     assert **what the sentence says** (R11: is it lying) — they still
//     own that half;
//   · this file asserts **how many characters of the sentence remain on
//     screen** (0.2.53: can the user read it), plus four-language content
//     (those two sites are zh-only, one corner of annex §4-10
//     "en/ja/ko copy has zero coverage").
//
// ⚠️ Ahem ruler (0.2.53 draft; same sentence as
// `compose_preview_strip_test.dart`'s header): flutter_test uses a
// placeholder font, every glyph a full-em square. **"not clipped under
// Ahem" ⇒ "will not be clipped on a real device" holds** (conservative
// direction), **the converse does not**. So the 360dp cases only assert
// on CJK copy; Latin (en) is widened to the ruler width — that is a
// product of the font, not product slack,
// **do not use any case in this file to argue "this sentence just fits
// on a real 360dp device"**.
//
// ⚠️ Measured at the **default type-size step** (`AppTextScale.large` =
// ×1.00, app_settings.dart:115) and system scale 1.0. Layout after the
// user turns system type size up is outside this file's proving scope —
// that is `FlowMicTextScaler`'s multiply layer, another card.
//
// ── Reverse controls: each of the four assertions **really went red**
//    (measured on this machine, copied verbatim below; all restored,
//    this file re-greened 15/15 after restore, `git status` left only
//    this new file, leftover-string grep=0) ──────
// A (✕-row note · clipping): temporarily lengthen zh `controlRowClearNote`
//     past three lines ⇒ `Expected: false / Actual: <true>`.
// B-1 (✕ long-press hint · wiring): replace `s.keyClearHint` at
//     `compose_band.dart:440` with `s.keyBackspaceHint` ⇒
//     `Found 0 widgets with text
//     "清除 · 清空电脑端文字（不影响本机草稿）"`.
// B-2 (✕ long-press hint · readable): stuff a 100-character unbreakable
//     token into the zh sentence ⇒
//     `Expected: a value less than or equal to <328.0> / Actual: <1368.0>`.
//     🔴 **The same token stayed green under the ruler I first wrote
//     ("the box lands on screen")** — that ruler has been replaced; the
//     reason sits at group B.
// C-1 (restore original · readable): temporarily lengthen zh
//     `aiRestoreOriginal` ⇒
//     `Expected: a value less than or equal to <350.0> / Actual: <652.5>`.
//     🔴 **`didExceedMaxLines` was still false under the same
//     lengthening** (that cell's constraint has no upper bound), so
//     group C does not use group A's ruler — reason sits at group C.
// C-2 (restore original · four-language wiring): pin `_strings` at
//     `chat_flow_page.dart:218` to zh ⇒
//     `Expected: 'Restore original' / Actual: '恢复原文'`.
//
// 🔴 Correction (same round, next commit): **C-2 above was copied wrong
// in the commit message that introduced this file** — that message wrote
// `Actual` as `'restored-original-zh'`, and the machine printed
// `'恢复原文'`. The commit message cannot be changed (this repo forbids
// `--amend`), so the correction lands here.
// ⚠️ What is worth keeping is not the typo, it is the shape: **a
// "verbatim transcript" that nobody re-ran is no different from
// secondhand**, and it is more dangerous than secondhand — it comes
// with the credibility of "I have seen the original" (same origin as
// the CLAUDE.md line about "a number stamped [measured] that did not
// stamp the machine name").

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_control_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flowmic/src/ui/ptt_bar.dart' show PttVisual;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/locale_terms.dart';
import 'support/legibility.dart' show ahemWidthBudget;

/// On a real device this cell's width is a 360dp screen minus the
/// timeline list's own 14dp left/right
/// (`EdgeInsets.fromLTRB(14, 8, 14, 14)` at `chat_flow_scroll.dart:76`).
/// The ruler must include it: without this layer, what is measured is a
/// width that does not exist in the product.
const double kListSidePadding = 14;

TimelineEntry _clearEntry() => TimelineEntry(
  id: 'loc_dev_k1-1',
  clientId: 'k1-1',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kControl,
  controlKind: 'clear',
  createdAt: DateTime.utc(2026, 8, 12, 10),
  updatedAt: DateTime.utc(2026, 8, 12, 10),
);

final Finder _note =
    find.byKey(const ValueKey<String>('entry.control.clearNote.loc_dev_k1-1'));

/// The real tile, in the real width — do not stand up a "looks like it"
/// widget (0.2.51 law: a case that only measures a stand-in stays green
/// after the production wiring is swapped).
Future<void> _pumpClearNoteTile(
  WidgetTester tester, {
  required AppLocale locale,
  required double width,
}) async {
  tester.view.physicalSize = Size(width * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.symmetric(horizontal: kListSidePadding),
          child: Align(
            alignment: Alignment.topCenter,
            child: ChatControlTile(
              entry: _clearEntry(),
              strings: AppStrings.of(locale),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// `didExceedMaxLines == false` alone proves nothing: text that was
/// **never laid out** also reports false. So every measurement first
/// passes this positive control.
void _assertReallyLaidOut(WidgetTester tester, Finder text, String what) {
  expect(text, findsOneWidget, reason: '$what was never painted at all');
  final Size size = tester.getSize(text);
  expect(
    size.height,
    greaterThan(0),
    reason: '$what\'s box height is 0 ⇒ the "not clipped" below proved nothing',
  );
  expect(size.width, greaterThan(0), reason: '$what\'s box width is 0');
}

void main() {
  // ══ Group A: `controlRowClearNote` —— the note on the ✕ row ═══════════════
  // Render site = `chat_control_tile.dart:102-111` (`maxLines: 3` +
  // ellipsis, fontSize 11). The annex named this cell: this round T-1
  // rewrote it and **lengthened** it (en went from a short sentence to 78
  // chars), and the only then-existing guard asserted `Text.data`.
  group('A: the ✕-row note is still fully readable after render (0.2.53 law)', () {
    for (final AppLocale locale in <AppLocale>[
      AppLocale.zh,
      AppLocale.ja,
      AppLocale.ko,
    ]) {
      testWidgets('🔴 ${locale.name}: at 360dp real-device width, three lines hold this note', (
        WidgetTester tester,
      ) async {
        // ⚠️ Only the three CJK languages are asserted at 360dp: those
        // scripts' glyphs are already near a full em ⇒ Ahem and a real
        // font point the same way here. en is exaggerated to about twice
        // as wide under Ahem; asserting it at 360dp is a false red (same
        // reason as compose_preview_strip_test.dart:240), it takes the
        // case below.
        await _pumpClearNoteTile(tester, locale: locale, width: 360);
        final AppStrings s = AppStrings.of(locale);
        _assertReallyLaidOut(tester, _note, '${locale.name} ✕-row note');
        // Four-language content: this cell previously had a zh assertion
        // only (the other half of annex §4-10).
        expect(tester.widget<Text>(_note).data, s.controlRowClearNote);
        expect(
          tester.renderObject<RenderParagraph>(_note).didExceedMaxLines,
          isFalse,
          reason: '🔴 ${locale.name}: 「${s.controlRowClearNote}」 was clipped by ellipsis — '
              'and this sentence\'s entire meaning is answering "is my draft gone", '
              'clipping the second half clips exactly that answer (0.2.53 shape)',
        );
        expect(tester.takeException(), isNull, reason: 'this cell overflowed at 360dp');
      });
    }

    testWidgets('🔴 en: has an unclipped layout at the ruler width', (WidgetTester tester) async {
      // ⚠️ 520 is not a product width, it is the **ruler width** (the
      // Ahem discipline in the header): the 78-character en sentence is
      // 78 full-em squares under Ahem, about half that in real Latin.
      // So this case asks "does en itself have an unclipped layout",
      // **not** "does en fit in 360dp" — this repo cannot give the
      // latter under the Ahem ruler.
      await _pumpClearNoteTile(tester, locale: AppLocale.en, width: 520);
      final AppStrings s = AppStrings.of(AppLocale.en);
      _assertReallyLaidOut(tester, _note, 'en ✕-row note');
      expect(tester.widget<Text>(_note).data, s.controlRowClearNote);
      expect(
        tester.renderObject<RenderParagraph>(_note).didExceedMaxLines,
        isFalse,
        reason: '🔴 en: 「${s.controlRowClearNote}」 does not even fit in maxLines:3 — '
            'the sentence itself is too long, not a width problem',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('🔴 reverse control (live guard): narrow the ruler to 300dp and the en sentence clips immediately', (
      WidgetTester tester,
    ) async {
      // 🔴 This is not an acceptance that "the product must work at 200dp"
      // — it is the **guard** of the cases above: a
      // `didExceedMaxLines == false` that is false at every width is
      // forever green, and a forever-green assertion is the same as not
      // existing (0.2.51: "a reverse control pointed the wrong way is
      // worse than none"). Here the same cell and the same sentence go
      // into a box that cannot hold them, proving this ruler actually
      // rings.
      //
      // ⚠️ en is not an arbitrary pick: **the zh sentence cannot be
      // clipped at any reasonable width** (20 characters, three 300dp
      // lines hold 66 — the first version of this case used zh, measured
      // `Expected: true / Actual: <false>`, that was not a product
      // verdict, it was this ruler picking the wrong subject). en is the
      // only one of the four languages that approaches capacity (78
      // chars); it is this cell's real boundary.
      await _pumpClearNoteTile(tester, locale: AppLocale.en, width: 300);
      _assertReallyLaidOut(tester, _note, '✕-row note under the narrow ruler');
      expect(
        tester.renderObject<RenderParagraph>(_note).didExceedMaxLines,
        isTrue,
        reason: '🔴 three 300dp lines somehow held 78 characters ⇒ the ruler above is not measuring clipping',
      );
    });
  });

  // ══ Group B: `keyClearHint` —— the explanation that pops on long-press of ✕ ══
  // Render site = `compose_band.dart:440` (into `Tooltip.message`,
  // concatenated with the key name as 「$label · $hint」). It is **the
  // only sentence the user can read before pressing ✕**.
  group('B: the ✕ long-press hint really pops in all four languages, and not a character is cut', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('🔴 ${locale.name}: long-press ✕ ⇒ what appears on screen is this sentence', (
        WidgetTester tester,
      ) async {
        // Nine-language expansion (2026-08-14): width is decided by
        // **this language's script**, no longer hard-coded 360. The
        // hard-coded-360 version produced a wall of false reds on
        // de/fr/es/ru — same reason, verbatim, as group C's
        // `en ? 640 : 360` ternary; see the `ahemWidthBudget` comment in
        // `support/legibility.dart`.
        final double width = ahemWidthBudget(locale);
        tester.view.physicalSize = Size(width * 3, 780 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ComposeBand(
                buffer: '',
                strings: s,
                enabled: true,
                visual: PttVisual.idle,
                onExpand: () {},
                onControlKey: (_) => true,
              ),
            ),
          ),
        );
        await tester.longPress(
          find.byKey(const ValueKey<String>('compose.ctrl.clear')),
        );
        await tester.pump();

        // The criterion lands on **the glyphs actually painted on the
        // overlay**, not the `Tooltip.message` property — between that
        // and "the user read it" there is still a show (the M3 case only
        // verified the ⌫ key; ✕ previously had only a zh
        // `textContaining`).
        final String expected = '${s.keyClear} · ${s.keyClearHint}';
        final Finder shown = find.text(expected);
        _assertReallyLaidOut(tester, shown, '${locale.name} ✕ long-press hint');

        // 🔴 The ruler here **was swapped once, and the reason must stay**
        // (measured while this file was written):
        // ① cannot use `didExceedMaxLines` — Flutter's `Tooltip` does not
        //    set `maxLines` on its own `Text`, that value is **constantly
        //    false** on this path;
        // ② cannot use "this text's box lands on screen" — that is what I
        //    wrote first, then temporarily replaced the zh sentence with
        //    a 100-character **unbreakable** token to falsify it, **and
        //    it stayed green** (the overlay gives `Text` a bounded width
        //    constraint, the box does not overflow, what overflows is
        //    the glyphs inside the box). Both are "forever green, and
        //    structurally incapable of going red" assertions — worse
        //    than no assertion (0.2.51 law: a reverse control pointed
        //    the wrong way writes the defect as the acceptance).
        // ⇒ Switch to the **only** condition that can make freely-
        //    wrapping text lose characters: the longest unbreakable run
        //    does not fit the box. The same reverse control (100-char
        //    token) went red immediately under this ruler; verbatim in
        //    the commit message.
        final RenderParagraph p = tester.renderObject<RenderParagraph>(shown);
        expect(
          p.getMinIntrinsicWidth(double.infinity),
          lessThanOrEqualTo(p.size.width),
          reason: '${locale.name}: this hint has an unbreakable run wider than the overlay ⇒ '
              'it will be cut on screen, and this is the only explanation the user can read before pressing ✕',
        );
        expect(tester.takeException(), isNull);
      });
    }

    test('🔴 each language is a real translation, and each still answers "the draft is unaffected"', () {
      // The content criterion (R11's half) was previously zh-only:
      // `compose_band_widget_test.dart:635` asserts the Chinese string.
      // The other languages promise the same thing, and would equally
      // become a lie if the coupling were split.
      final Set<String> hints = <String>{
        for (final AppLocale l in AppLocale.values) AppStrings.of(l).keyClearHint,
      };
      // 🔴 The criterion is `AppLocale.values.length`, not a hard-coded
      // number. A hard-coded `4` would go red the day nine languages
      // landed, and what went red would **not** be the thing it guards
      // (copy-paste), it would be "someone added a language" — an
      // assertion that goes red on itself, and the next person will just
      // bump the number.
      // ⚠️ It still guards the same thing, and **has not been relaxed**:
      // `values.length` strings falling into a Set still leave
      // `values.length` ⇒ pairwise distinct. zh and zhTw are this case's
      // narrowest cell now (「清空电脑端文字」/「清空電腦端文字」); copy-
      // pasting one goes red.
      expect(
        hints,
        hasLength(AppLocale.values.length),
        reason: 'i18n: one language forgot to translate and copied another',
      );
      for (final AppLocale l in AppLocale.values) {
        final String hint = AppStrings.of(l).keyClearHint;
        expect(hint, isNotEmpty, reason: '${l.name}: not a single explanation before ✕ is pressed');
        // Every language must mention the local-draft half — that is the
        // only thing this sentence newly added after owner supplement #3
        // split the coupling, and the answer the user most wants right
        // now.
        //
        // Exhaustive switch, no `_ =>` fallback: adding a language must
        // stop here, for a human to answer "what is the word for 『草稿』
        // in this language". Giving it a default = looking for English
        // 'draft' in a Russian sentence, **not finding it goes red
        // (noisy, good)**, but the same-family negative assertions would
        // **silently pass**.
        final String draftWord = switch (l) {
          AppLocale.zh => '草稿',
          AppLocale.zhTw => '草稿',
          AppLocale.en => 'draft',
          AppLocale.fr => 'brouillon',
          AppLocale.es => 'borrador',
          AppLocale.de => 'Entwurf',
          AppLocale.ja => '下書き',
          AppLocale.ko => '초안',
          AppLocale.ru => 'черновик',
        };
        expect(hint, contains(draftWord), reason: '${l.name}: this hint no longer answers '
            '"will my draft be gone", and that is the entire difference between ✕ and the floating-card ✕');
      }
    });
  });

  // ══ Group C: `aiRestoreOriginal` —— the 「恢复原文」 button on the floating card ══
  // Render site = `chat_flow_edit_card.dart:322-347`. Annex, verbatim:
  // **zero content assertions** (the T-6 case only drove it with
  // `ValueKey('compose.card.restoreOriginal')`) ⇒ what characters are
  // printed on this button, whether the four languages print the right
  // ones, and whether they print them in full, previously had no guard.
  group('C: the characters printed on the 「恢复原文」 button (four languages × render)', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('🔴 ${locale.name}: the button on the card prints this language\'s 「恢复原文」, and is not clipped', (
        WidgetTester tester,
      ) async {
        // ⚠️ Latin / Cyrillic take a wider ruler, same reason as group A
        // and compose_preview_strip_test.dart:257: under Ahem the
        // **whole card** (three AI pills + count + discard) English
        // labels are exaggerated to about twice as wide, measured at
        // 360dp throwing
        // `A RenderFlex overflowed by 146 pixels on the right` — that is
        // a product of the ruler, not a product defect (pill layout is
        // guarded by T-6's own case). Treating it as red writes a false
        // red into the acceptance (0.2.52 §3 law's shape).
        //
        // 🔴 Nine-language expansion (2026-08-14): this originally wrote
        // `locale == AppLocale.en ? 640 : 360`. **The spirit of that
        // criterion is right, the form is bad** — it hung "this is a
        // script Ahem will exaggerate" on a hard-coded language name.
        // The moment de / fr / es / ru arrived, all four fell into the
        // 360 branch and produced a wall of false reds; and "widen the
        // threshold until it stops going red" = delete this test. The
        // budget is now computed from **this language's script**
        // (`ahemWidthBudget` in `support/legibility.dart`),
        // **adding a language does not change a single character of this
        // line**.
        //
        // ⚠️ en's number went from 640 to 648 (360 × 1.8). What changed
        // is **where it comes from**: 640 was hand-picked, 648 is
        // computed as "how many Ahem px a 360dp real-device screen is
        // worth under a Latin script".
        final double width = ahemWidthBudget(locale);
        tester.view.physicalSize = Size(width * 3, 780 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        SharedPreferences.setMockInitialValues(<String, Object>{});
        final SharedPreferences prefs = await SharedPreferences.getInstance();
        final AppSettingsController settings =
            AppSettingsController(prefs: prefs);
        await settings.load();
        settings.setLocale(locale);

        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = newTestSession(
          transport: transport,
          audio: AudioCapture(recorder: FakeAudioRecorder()),
          stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
        );
        giveSessionAPairedIdentity(session);
        final ChatController controller = ChatController(
          outboxStore: newTestOutboxStore(),
          outboxBlobs: newTestOutboxBlobs(),
          session: session,
          store: newTestStore(),
          destination: DestinationController(),
          syncGate: TimelineSyncGate(transport: transport),
          // manual is half of `composeEditHold` — without loading it the floating card never appears.
          localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
        );
        addTearDown(() async {
          await controller.dispose();
          controller.destination.dispose();
          controller.store.dispose();
          await controller.session.dispose();
          await transport.close();
        });
        await controller.loadSendPolicy();
        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(
            home: ChatFlowPage(controller: controller, appSettings: settings),
          ),
        );
        controller.setBuffer('原来那段话');
        await tester.pump();

        // Walk the real path to earn the restore entry (one successful
        // transform), do not just plant a button.
        // ⚠️ Deliberately use `tester.pump()` not `pumpEventQueue()`: the
        // latter never completes in testWidgets' FakeAsync zone (the scar
        // at ai_restore_original_test.dart:248).
        expect(controller.startAiCompose(ComposeTask.organize), isNull);
        await tester.pump();
        transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
          'output_text': '整理之后的话',
          'request_id': Map<String, Object?>.from(
            transport.emittedWhere(FlowMicEvents.composeStart).last.data!
                as Map,
          )['request_id']! as String,
        });
        await tester.pump();

        final AppStrings s = AppStrings.of(locale);
        final Finder label = find.byKey(
          const ValueKey<String>('compose.card.restoreOriginal.label'),
        );
        _assertReallyLaidOut(tester, label, '${locale.name} 「恢复原文」 button');
        // ① Content: this cell previously had not a single content
        // assertion — it prints **this language's** word.
        expect(
          tester.widget<Text>(label).data,
          s.aiRestoreOriginal,
          reason: '🔴 ${locale.name}: the button does not print this language\'s 「恢复原文」'
              ' (page locale comes from AppSettings, the string from AppStrings — '
              'one crossed wiring is a Chinese button on an English UI)',
        );
        // ② Render. 🔴 **This cell's ruler is not the same as group A's,
        // and that is the one thing this group must remember** (measured
        // while writing, not inferred from reading code): this label
        // lives in `Row(mainAxisSize: min)` ← `Align` ⇒ it receives an
        // **unbounded** width constraint ⇒ the `maxLines: 1` + ellipsis
        // it writes **never fire**, `didExceedMaxLines` is constantly
        // false. Temporarily lengthening the zh word to 40 characters to
        // falsify it produced
        // `A RenderFlex overflowed by 320 pixels on the right`,
        // **and that didExceedMaxLines assertion stayed green**.
        // ⇒ The same law (0.2.53) needs a different ruler in a different
        // box: this cell's failure shape is not "clipped to Restore
        // ori…", it is **the whole button squeezed off the card**.
        final double cardRight = tester
            .getRect(find.byKey(const ValueKey<String>('compose.card')))
            .right;
        expect(
          tester.getRect(label).right,
          lessThanOrEqualTo(cardRight),
          reason: '🔴 ${locale.name}: 「${s.aiRestoreOriginal}」 was squeezed off the right of the floating card — '
              'the user sees a button they cannot finish reading, and 「恢复」 vs 「恢复原文」 '
              'are two different promises on this card',
        );
        // ③ That hint is the **only exit that says which stretch we go
        // back to** (tooltip + a11y, same sentence).
        expect(
          tester.widget<Tooltip>(
            find.ancestor(
              of: find.byKey(
                const ValueKey<String>('compose.card.restoreOriginal'),
              ),
              matching: find.byType(Tooltip),
            ),
          ).message,
          s.aiRestoreOriginalHint,
          reason: '${locale.name}: the long-press hint is not this language\'s sentence',
        );
        expect(tester.takeException(), isNull);
        controller.session.debugStopIdlePresencePoll();
      });
    }

    test('🔴 「恢复原文」 and its hint are pairwise distinct in every language (the i18n copy-paste failure)', () {
      // Nine-language expansion (2026-08-14): `hasLength(4)` replaced with
      // a named criterion; see the `expectPerLocaleDistinct` comment in
      // `support/locale_terms.dart`.
      // measured: these two sentences are distinct across all nine
      // languages ⇒ no mayShare needed.
      expectPerLocaleDistinct(
        (AppStrings s) => s.aiRestoreOriginal,
        what: 'aiRestoreOriginal',
      );
      expectPerLocaleDistinct(
        (AppStrings s) => s.aiRestoreOriginalHint,
        what: 'aiRestoreOriginalHint',
      );
    });
  });
}
