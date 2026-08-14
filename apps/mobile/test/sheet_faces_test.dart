// WP8 VF-4 — the UNIFIED EDIT SHEET's face is the mock's, value by value, in
// BOTH themes.
//
// SOURCES (in this order, both are the spec):
//   1. docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html — frames
//      A-06 (手动 · 大编辑面), A-07 (追加中), A-08 (AI 三枚 + 恢复原文),
//      A-D3 (深色大编辑面), and the CSS rules `.sheet` / `.hdl` / `.shh` /
//      `.bdy` / `.aic` / `.aib` / `.apnd` / `.ftr` / `.gbtn` / `.pbtn`.
//   2. docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §0 D5/D6,
//      §1 (palette), §2 (Edit sheet).
//
// 🔴 WHY THIS FILE EXISTS AT ALL. dock_tokens_test.dart already pins the
// PALETTE; it says nothing about who reads it. The owner rejected WP7 for what
// the SCREEN looked like, and a sheet that kept every legacy colour would pass
// that file and every mechanics test in the suite. These cases assert on the
// RENDERED widgets — the fill actually in the sheet's BoxDecoration, the
// decoration that is actually absent around the body, the string actually on
// the deliver button.
//
// ── Reverse controls (both run, both seen RED, both reverted) ────────────────
// (a) Put the pre-WP8 box back around the body field (surface2 fill + line
//     border + r12 in ComposeBufferField):
//       Expected: no matching candidates
//         Actual: _WidgetTypeFinder:<Found 1 widget with type "DecoratedBox">
//       Which: means none were expected, but one was found
//     …plus the sibling case:
//       Expected: null
//         Actual: BoxDecoration(color: Color(0xff191b22), …)
// (b) Make the applied-✓ mark survive a restore tap (drop the
//     `restorableOriginal == null` / buffer-moved test from _SheetAiRowState):
//       Expected: no matching candidates
//         Actual: _TextWidgetFinder:<Found 1 widget with text "润色 ✓">
//       Which: means one was found but none were expected
//     (the applied pill still reads 「润色 ✓」 after 「恢复原文」)
// (c) Bill the pills' glyph slot unconditionally again — the over-bill that
//     made the 360dp sheet render icon-only pills:
//       Expected: <328.75>
//         Actual: <311.75>          ← the bill == paint case, and
//       Expected: exactly one matching candidate
//         Actual: _DescendantWidgetFinder:<Found 0 widgets with text "润色"
//                 descending from widgets with key [<'compose.card'>]: []>
//       Which: means none were found but one was expected
//     …in all three 360dp state cases at once.
// All three quoted verbatim in the VF-4 report; all reverted and re-greened.
//
// SEAM: assigning `FlowMicTheme.brightness.value` is the documented legal test
// seam (tokens.dart's [FlowMicTheme] doc), same shape dock_tokens_test.dart
// uses. Default is dark, so every case states the theme it wants.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/ai_action_row.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/compose_band.dart' show ComposeBufferField;
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));
final Finder _deliver =
    find.byKey(const ValueKey<String>('compose.card.deliver'));
final Finder _discard =
    find.byKey(const ValueKey<String>('compose.card.discard'));
final Finder _collapse =
    find.byKey(const ValueKey<String>('compose.sheet.collapse'));
final Finder _restore =
    find.byKey(const ValueKey<String>('compose.card.restoreOriginal'));
final Finder _restoreLabel =
    find.byKey(const ValueKey<String>('compose.card.restoreOriginal.label'));

Finder _aiPill(ComposeTask t) =>
    find.byKey(ValueKey<String>('ai.task.${t.wire}'));

/// A-08's applied mark on [t]'s pill. The face is 「润色 ✓」 in TWO runs (the ✓
/// is a layout glyph with its own gap, like the deliver button's ➤), so the
/// mark is found per-run rather than as one concatenated string.
Finder _appliedMark(ComposeTask t) =>
    find.descendant(of: _aiPill(t), matching: find.text('✓'));

class _Page {
  _Page(this.transport, this.controller);
  final FakeSocketTransport transport;
  final ChatController controller;

  /// One complete SUCCESSFUL transform, driven through the production wire.
  ///
  /// ⚠️ `tester.pump()` rather than `pumpEventQueue()` — the latter never
  /// completes inside testWidgets' FakeAsync zone (the scar documented at
  /// ai_restore_original_test.dart:248).
  Future<void> transform(
    WidgetTester tester,
    ComposeTask task,
    String output,
  ) async {
    expect(
      controller.startAiCompose(task),
      isNull,
      reason: 'precondition: this run actually started (otherwise what follows measures air)',
    );
    await tester.pump();
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.composeStart).last.data! as Map,
      )['request_id']! as String,
    });
    await tester.pump();
  }
}

/// The real page + the real controller (0.2.51 law), with an open sheet over a
/// voice-shaped draft — the A-06 state every case below starts from.
Future<_Page> _pumpSheet(
  WidgetTester tester, {
  required Brightness theme,
  String draft = '一段草稿',
  double width = 420,
  double height = 800,
  bool liveCapture = false,
}) async {
  FlowMicTheme.brightness.value = theme;
  addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);

  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

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
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
  );
  // 🔴 [liveCapture] ⇒ SYNCHRONOUS teardown. A case that leaves a capture
  // running makes the awaits inside `dispose()` unresolvable in FakeAsync, and
  // the symptom is not an error — it is a ten-minute hang (measured while
  // writing the A-07 case below; the same scar is documented at
  // edit_sheet_append_test.dart:91 and speaking_face_test.dart).
  if (liveCapture) {
    addTearDown(() {
      unawaited(controller.dispose());
      controller.destination.dispose();
      controller.store.dispose();
    });
  } else {
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
      await session.dispose();
      await transport.close();
    });
  }
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  // A manual finalize auto-opens the sheet (SUP-5 (a)).
  controller.setBuffer(draft);
  await tester.pump();
  expect(_sheet, findsOneWidget, reason: 'precondition: the edit sheet did not open; what follows measures air');
  return _Page(transport, controller);
}

BoxDecoration _decorationOf(WidgetTester tester, Finder f) {
  final Container box = tester.widget<Container>(
    find.descendant(of: f, matching: find.byType(Container)).first,
  );
  return box.decoration! as BoxDecoration;
}

/// Lay a LABELLED [AiActionRow] out unconstrained and return what it paints.
Future<double> _paintedRowWidth(
  WidgetTester tester, {
  ComposeTask? applied,
  ComposeTask? running,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: IntrinsicWidth(
            child: AiActionRow(
              key: const ValueKey<String>('measure.row'),
              strings: _zh,
              enabled: true,
              runningTask: running,
              appliedTask: applied,
              onTask: (ComposeTask _) {},
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return tester
      .getSize(find.byKey(const ValueKey<String>('measure.row')))
      .width;
}

void main() {
  // ── The width account: 360dp is where the owner reviews, and it regressed ──
  //
  // 🔴 THE BUG THIS GROUP EXISTS FOR (WP8 parity walk): the sheet rendered
  // ICON-ONLY pills at 360dp in every state, while the mock draws the labelled
  // ones. Root cause was in the MEASUREMENT, not the paint —
  // `labelledRowWidth` billed a glyph slot for a state the row was not in.
  // Measured, at a 360dp page (sheet inner width 326.0):
  //     before  bill 326.5   vs   painted resting row 311.75   ⇒ compact by 0.5dp
  //     after   bill 311.75  ==   painted resting row 311.75   ⇒ labelled
  // The old bill was ALSO wrong in the other direction — it modelled neither
  // the pills' 1dp borders (−2dp each) nor the ambient `letterSpacing: 0.25`
  // (−0.5dp per label, −2.75dp on the caption) — so it was over-billing and
  // under-billing at once, which is why no existing test caught it.
  group('the labelled row fits 360dp, and the bill is what the row paints', () {
    testWidgets('🔴 bill == paint, resting AND applied — the guarantee the '
        'regression violated', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: Brightness.light, width: 360);
      final BuildContext ctx = tester.element(_sheet);
      final double billRest = AiActionRow.labelledRowWidth(ctx, _zh);
      final double billApplied = AiActionRow.labelledRowWidth(
        ctx,
        _zh,
        appliedTask: ComposeTask.draftPolish,
      );
      p.controller.session.debugStopIdlePresencePoll();

      expect(
        await _paintedRowWidth(tester),
        billRest,
        reason: '🔴 labelledRowWidth is not equal to the width this row actually paints — that is not a '
            '「measurement」, that is a guess, and the 360dp icon pills are the product of it guessing 0.5dp wrong',
      );
      expect(
        await _paintedRowWidth(tester, applied: ComposeTask.draftPolish),
        billApplied,
        reason: '🔴 the applied-state bill does not match the painted width',
      );
      // …and the applied state costs at most one glyph slot, so A-08 can never
      // be pushed to compact by the ✓ itself.
      expect(billApplied - billRest, lessThanOrEqualTo(17));
    });

    for (final ({String name, bool typed, bool appending}) c
        in <({String name, bool typed, bool appending})>[
      (name: 'A-06 voice', typed: false, appending: false),
      (name: 'A-12 typed', typed: true, appending: false),
      (name: 'A-07 appending', typed: false, appending: true),
    ]) {
      testWidgets('🔴 360dp zh · ${c.name}: the sheet renders the LABELLED '
          'pills, not three icon circles', (WidgetTester tester) async {
        final _Page p = await _pumpSheet(
          tester,
          theme: Brightness.light,
          width: 360,
          liveCapture: c.appending,
        );
        if (c.typed) {
          await tester.tap(_collapse);
          await tester.pump();
          await tester.tap(
            find.byKey(const ValueKey<String>('compose.preview.tap')),
          );
          await tester.pump();
          await tester.pump();
        }
        if (c.appending) {
          final SheetAppendButton btn =
              tester.widget<SheetAppendButton>(find.byType(SheetAppendButton));
          unawaited(btn.onDown());
          await tester.pump();
          await tester.pump();
          await tester.pump();
          expect(p.controller.isRecording, isTrue, reason: 'precondition: this press was accepted');
        }
        for (final ComposeTask task in kAiComposeTasks) {
          expect(
            find.descendant(of: _sheet, matching: find.text(_zh.aiTaskLabel(task))),
            findsOneWidget,
            reason: '🔴 「${_zh.aiTaskLabel(task)}」 was not printed at 360dp — the mock at the same '
                'width draws labelled pills (contract §0 D6); this cell falling back to compact is the face '
                'this round was rejected for',
          );
        }
        for (final IconData icon in <IconData>[
          Icons.auto_awesome,
          Icons.segment,
          Icons.translate,
        ]) {
          expect(
            find.descendant(of: _sheet, matching: find.byIcon(icon)),
            findsNothing,
            reason: '🔴 compact icon pills appeared at 360dp',
          );
        }
        if (c.appending) {
          unawaited(p.controller.pttCancel());
          await tester.pump();
          await tester.pump();
        }
        p.controller.session.debugStopIdlePresencePoll();
      });
    }

    testWidgets('🔴 A-08 applied at 360dp: the pill keeps its WORDS + ✓ '
        '(the ✓ is a layout run, so the finder is per-run)', (
      WidgetTester tester,
    ) async {
      // ⚠️ MEASURING-STICK NOTE, and it is the reason this case runs at 364dp
      // rather than 360 — stated with the numbers rather than hidden:
      // flutter_test's font advances EVERY glyph a full em, including ASCII.
      // The caption 「作用于缓冲 · 不注入」 holds three non-CJK characters (two
      // spaces + `·`); under that font it measures 118.25dp, and the case below
      // measures how much of that is the two spaces alone. With a real font
      // those two spaces are ~3dp each instead of 10.5, i.e. the caption is
      // ~14dp narrower and the applied row (bill 328.5) clears 360dp's 326.0
      // budget with room to spare. Asserting 「fits at 360」 under this font
      // would be asserting a property of the RULER (0.2.53's law: 「不许拿它
      // 论证『真机上正好放得下』」), and asserting 「does not fit」 would write the
      // ruler's artifact into the spec. So the RENDER is pinned one notch wider,
      // and the account that decides 360 on a real device is pinned above.
      final _Page p = await _pumpSheet(
        tester,
        theme: Brightness.light,
        width: 364,
      );
      await p.transform(tester, ComposeTask.draftPolish, '润色之后的话');
      expect(
        find.descendant(
          of: _aiPill(ComposeTask.draftPolish),
          matching: find.text(_zh.aiTaskLabel(ComposeTask.draftPolish)),
        ),
        findsOneWidget,
        reason: '🔴 the A-08 pill fell back to an icon — the mock draws 「润色 ✓」',
      );
      expect(
        find.descendant(
          of: _aiPill(ComposeTask.draftPolish),
          matching: find.text('✓'),
        ),
        findsOneWidget,
      );
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 the ruler itself: two ASCII spaces cost a full em each '
        'under the test font — that is the 360dp applied-state gap', (
      WidgetTester tester,
    ) async {
      // A measurement, not a claim. Without this the note above is exactly the
      // kind of 「断言别处行为的注释」 anti-façade ④ bans.
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      double tw(String s) {
        final TextPainter tp = TextPainter(
          text: TextSpan(text: s, style: const TextStyle(fontSize: 10.5)),
          textDirection: TextDirection.ltr,
          maxLines: 1,
        )..layout();
        return tp.width;
      }

      final double withSpaces = tw(_zh.aiRowNote);
      final double withoutSpaces = tw(_zh.aiRowNote.replaceAll(' ', ''));
      expect(
        withSpaces - withoutSpaces,
        21.0,
        reason: 'the two spaces cost 21dp under this ruler (a real font is about 6–7dp)',
      );
    });
  });

  for (final Brightness theme in <Brightness>[
    Brightness.light,
    Brightness.dark,
  ]) {
    final String t = theme == Brightness.light ? 'light' : 'dark';

    testWidgets('🔴 $t — the sheet itself: panel fill, line hairline on three '
        'sides, and the mock\'s upward lift', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);
      final BoxDecoration d =
          tester.widget<Container>(_sheet).decoration! as BoxDecoration;
      expect(
        d.color,
        FlowMicDockColors.panel,
        reason: '🔴 $t: the edit-sheet fill is not the mock\'s `--panel` — what WP7 was rejected for '
            'was exactly 「copying this repo\'s existing convention」',
      );
      expect((d.border! as Border).top.color, FlowMicDockColors.line);
      expect((d.border! as Border).bottom, BorderSide.none, reason: '`.sheet` '
          'has border-bottom:none — the bottom edge is off-screen; drawing a line there is a horizontal seam');
      expect(
        d.borderRadius,
        const BorderRadius.vertical(top: Radius.circular(22)),
      );
      // `0 -10px 30px` — the OFFSET's sign is the assertion that matters: a
      // bottom-anchored surface lifts toward the content above it, and the
      // token it used to be derived from pushes DOWN.
      expect(d.boxShadow, FlowMicDockColors.sheetShadow);
      expect(d.boxShadow!.single.offset.dy, lessThan(0));
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 $t — D5, THE HEADLINE: the body is NAKED. No box exists '
        'between the field and the sheet panel', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);

      // ① Rendered-structure guard: a filled/bordered wrapper IS a DecoratedBox
      // in the render tree. Scoped to boxes that are BOTH inside
      // [ComposeBufferField] AND ancestors of the field — i.e. exactly the
      // wrapper, excluding the sheet's own (legitimate) decoration outside it
      // and any DecoratedBox the TextField builds beneath it.
      final Finder boxesAroundBody = find.descendant(
        of: find.byType(ComposeBufferField),
        matching: find.ancestor(of: _field, matching: find.byType(DecoratedBox)),
      );
      expect(
        boxesAroundBody,
        findsNothing,
        reason: '🔴 $t: another box grew around the body — contract §0 D5「Sheet body = text '
            'inside a gray rounded box」 is exactly the line the owner rejected WP7 on',
      );
      // ② Positive control for ① — the finder is not simply blind: the SHEET's
      // own decoration is a DecoratedBox, and it is found.
      expect(
        find.descendant(of: _sheet, matching: find.byType(DecoratedBox)),
        findsWidgets,
        reason: 'positive control: this finder itself must be able to see boxes, otherwise the 「zero」 above means it is blind',
      );
      // ③ The wrapper survives (for the 38dp floor + T-5 alignment) and carries
      // no decoration at all.
      final Container wrapper = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(ComposeBufferField),
              matching: find.ancestor(of: _field, matching: find.byType(Container)),
            )
            .first,
      );
      expect(wrapper.decoration, isNull);
      expect(wrapper.constraints, const BoxConstraints(minHeight: 38));

      // ④ …and the text that sits on the bare panel is the mock's `.bdy`.
      final TextField tf = tester.widget<TextField>(_field);
      expect(tf.style!.fontSize, 16);
      expect(tf.style!.height, 1.75);
      expect(tf.style!.color, FlowMicDockColors.ink);
      expect(tf.cursorColor, FlowMicDockColors.pri);
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 $t — AI pills wear `.aib`: page-bg fill, 1dp line border, '
        'ink label, and no leading icon', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);
      for (final ComposeTask task in kAiComposeTasks) {
        final BoxDecoration d = _decorationOf(tester, _aiPill(task));
        expect(
          d.color,
          FlowMicDockColors.bg,
          reason: '🔴 $t: ${task.wire} pill fill is not the page background — contract §0 D6',
        );
        expect((d.border! as Border).top.color, FlowMicDockColors.line);
        final Text label = tester.widget<Text>(
          find.descendant(of: _aiPill(task), matching: find.byType(Text)),
        );
        expect(label.data, _zh.aiTaskLabel(task));
        expect(label.style!.color, FlowMicDockColors.ink);
        expect(label.style!.fontSize, 12.5);
        expect(
          label.style!.fontWeight,
          isNull,
          reason: '`.aib` has no font-weight — that 600 is this repo\'s convention, not the mock\'s',
        );
      }
      // The icons the contract's D6 row names are gone from the labelled face.
      for (final IconData icon in <IconData>[
        Icons.auto_awesome,
        Icons.segment,
        Icons.translate,
      ]) {
        expect(
          find.descendant(of: _sheet, matching: find.byIcon(icon)),
          findsNothing,
          reason: '🔴 $t: the iconed pills came back (D6)',
        );
      }
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 $t — the footer pair: 丢弃 has NO fill, 投递 is pri + onPri '
        '+ the ➤ glyph', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);

      final BoxDecoration discard = _decorationOf(tester, _discard);
      expect(
        discard.color,
        isNull,
        reason: '🔴 $t: `.gbtn` declares 「no background」 — filling a panel colour would only make the two buttons '
            'look like the same kind of thing (A-06 original: different shape, different colour)',
      );
      expect((discard.border! as Border).top.color, FlowMicDockColors.line);
      final Text discardLabel = tester.widget<Text>(
        find.descendant(of: _discard, matching: find.byType(Text)).first,
      );
      expect(discardLabel.style!.color, FlowMicDockColors.sub);
      expect(discardLabel.style!.fontSize, 14);

      final BoxDecoration deliver = _decorationOf(tester, _deliver);
      expect(deliver.color, FlowMicDockColors.pri);
      expect((deliver.border! as Border).top.color, FlowMicDockColors.pri);
      final List<Text> deliverTexts = tester
          .widgetList<Text>(find.descendant(of: _deliver, matching: find.byType(Text)))
          .toList();
      expect(deliverTexts.first.data, _zh.composeCardDeliver);
      expect(
        deliverTexts.first.style!.color,
        FlowMicDockColors.onPri,
        reason: '🔴 $t: the primary button\'s text colour is not onPri — the dark mock hard-codes #131318, '
            'while `FlowMicColors.onBrandInk` is white in both themes',
      );
      expect(deliverTexts.first.style!.fontSize, 15);
      expect(deliverTexts.first.style!.fontWeight, FontWeight.w700);
      expect(
        deliverTexts.last.data,
        '➤',
        reason: '🔴 $t: the ➤ of `投递 ➤` is gone (Icons.send is the one it replaced)',
      );
      expect(deliverTexts.last.style!.color, FlowMicDockColors.onPri);
      // The glyph is a FACE, not copy: the string table still holds the label
      // alone (copy freeze).
      expect(_zh.composeCardDeliver.contains('➤'), isFalse);
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 $t — restore strip: teal tokens, r10, and the action is '
        'bold + UNDERLINED with no leading icon', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);
      await p.transform(tester, ComposeTask.draftPolish, '润色之后的话');
      expect(_restore, findsOneWidget, reason: 'precondition: the restore entry must be present after a successful transform');

      final Container strip = tester.widget<Container>(
        find
            .descendant(
              of: _sheet,
              matching: find.ancestor(of: _restore, matching: find.byType(Container)),
            )
            .first,
      );
      final BoxDecoration d = strip.decoration! as BoxDecoration;
      expect(d.color, FlowMicDockColors.restoreBg);
      expect((d.border! as Border).top.color, FlowMicDockColors.restoreBorder);
      expect(d.borderRadius, BorderRadius.circular(10));
      expect(strip.padding, const EdgeInsets.symmetric(horizontal: 11, vertical: 7));

      final Text label = tester.widget<Text>(_restoreLabel);
      expect(label.data, _zh.aiRestoreOriginal);
      expect(label.style!.color, FlowMicDockColors.restoreText);
      expect(label.style!.fontSize, 12);
      expect(label.style!.fontWeight, FontWeight.w700);
      expect(
        label.style!.decoration,
        TextDecoration.underline,
        reason: '🔴 $t: A-08 uses an underline to mark 「these words are tappable」, and nothing else '
            'on this strip is doing that job (the icon was deleted per the mock)',
      );
      expect(
        find.descendant(of: _sheet, matching: find.byIcon(Icons.undo)),
        findsNothing,
        reason: '🔴 $t: A-08\'s strip has no icon',
      );
      p.controller.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 $t — A-08 applied face: the transform that ran wears pri + '
        'onPri + ✓, the other two stay neutral', (WidgetTester tester) async {
      final _Page p = await _pumpSheet(tester, theme: theme);
      await p.transform(tester, ComposeTask.draftPolish, '润色之后的话');

      final BoxDecoration applied =
          _decorationOf(tester, _aiPill(ComposeTask.draftPolish));
      expect(applied.color, FlowMicDockColors.pri);
      expect((applied.border! as Border).top.color, FlowMicDockColors.pri);
      // 「润色 ✓」 is TWO runs — the ✓ is a layout glyph with an explicit gap,
      // exactly like the deliver button's ➤, so a font's idea of how wide a
      // space is cannot move the pill (that font-dependence is what pushed the
      // 360dp row into compact; see the width-account group above).
      final List<Text> appliedRuns = tester
          .widgetList<Text>(
            find.descendant(
              of: _aiPill(ComposeTask.draftPolish),
              matching: find.byType(Text),
            ),
          )
          .toList();
      expect(
        appliedRuns.map((Text t) => t.data).toList(),
        <String>[_zh.aiTaskLabel(ComposeTask.draftPolish), '✓'],
        reason: '🔴 $t: the A-08 pill reads 「润色 ✓」 — ✓ is a layout glyph, not copy',
      );
      expect(appliedRuns.first.style!.color, FlowMicDockColors.onPri);
      expect(appliedRuns.last.style!.color, FlowMicDockColors.onPri);
      // The reverse half: the other two pills must not change by a single character.
      for (final ComposeTask other in <ComposeTask>[
        ComposeTask.organize,
        ComposeTask.translate,
      ]) {
        expect(_decorationOf(tester, _aiPill(other)).color, FlowMicDockColors.bg);
        expect(
          tester
              .widget<Text>(
                find.descendant(of: _aiPill(other), matching: find.byType(Text)),
              )
              .data,
          _zh.aiTaskLabel(other),
        );
      }
      p.controller.session.debugStopIdlePresencePoll();
    });
  }

  // ── A-07: the in-sheet append window ──────────────────────────────────────
  testWidgets('🔴 A-07 — while appending: the live view is NAKED too, the '
      'highlight is the mock\'s wash, and the pills row is dimmed, inert AND '
      'caption-less', (WidgetTester tester) async {
    final _Page p = await _pumpSheet(
      tester,
      theme: Brightness.light,
      liveCapture: true,
    );
    // Pre-state: the caption IS printed when the pills are pressable — without
    // this the assertion below cannot tell 「hidden」 from 「never there」.
    expect(
      find.descendant(of: _sheet, matching: find.text(_zh.aiRowNote)),
      findsOneWidget,
      reason: 'positive control: the idle sentence 「作用于缓冲 · 不注入」 must be present',
    );

    // The PRODUCTION accepted-edge, driven directly (a real long-press drags
    // the async PTT chain into FakeAsync — the documented deadlock).
    final SheetAppendButton btn =
        tester.widget<SheetAppendButton>(find.byType(SheetAppendButton));
    unawaited(btn.onDown());
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(p.controller.isRecording, isTrue, reason: 'precondition: this press was accepted');

    p.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': '追加的这一句',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
    });
    await tester.pump();

    // ① The live view swapped in, and it is as bare as the field it replaced.
    final Finder live = find.byKey(const ValueKey<String>('compose.sheet.live'));
    expect(live, findsOneWidget);
    expect(_field, findsNothing);
    expect(
      tester.widget<Container>(live).decoration,
      isNull,
      reason: '🔴 the append view still carries a box — it swaps places with the body field; a different face equals 「the box changed」',
    );
    final Text rich = tester.widget<Text>(
      find.descendant(of: live, matching: find.byType(Text)).first,
    );
    // ⚠️ The paragraph style lives on the Text widget, NOT on the root span —
    // `Text.rich(span, style: …)` splits them, and reading `textSpan.style`
    // here returns null (measured while writing this case).
    expect(rich.style!.fontSize, 16);
    expect(rich.style!.height, 1.75);
    expect(rich.style!.color, FlowMicDockColors.ink);
    final TextSpan highlight =
        (rich.textSpan! as TextSpan).children!.last as TextSpan;
    expect(highlight.text!.contains('追加的这一句'), isTrue);
    expect(highlight.style!.backgroundColor, FlowMicDockColors.appendHighlight);

    // ② The pills row: .4 opacity, pointer-inert, and NO caption (A-07 drops
    // the caption span from `.aic`).
    final Opacity dim = tester.widget<Opacity>(
      find
          .ancestor(
            of: _aiPill(ComposeTask.draftPolish),
            matching: find.byType(Opacity),
          )
          .first,
    );
    expect(dim.opacity, 0.4);
    expect(
      tester
          .widget<IgnorePointer>(
            find
                .ancestor(
                  of: _aiPill(ComposeTask.draftPolish),
                  matching: find.byType(IgnorePointer),
                )
                .first,
          )
          .ignoring,
      isTrue,
      reason: '🔴 only the opacity was turned down and taps were not blocked — that is decorative 「de-ranking」',
    );
    expect(
      find.descendant(of: _sheet, matching: find.text(_zh.aiRowNote)),
      findsNothing,
      reason: '🔴 A-07\'s `.aic` has no such caption — a button that cannot be pressed does not need a sentence '
          'explaining where it acts; it comes back on release',
    );

    // Wind the append back down so the FSM's own watchdogs do not outlive the
    // tree (the same shape edit_sheet_append_test.dart's cancel case uses).
    unawaited(p.controller.pttCancel());
    await tester.pump();
    await tester.pump();
    expect(
      find.descendant(of: _sheet, matching: find.text(_zh.aiRowNote)),
      findsOneWidget,
      reason: '🔴 after release that sentence did not come back — hiding became 「spent」',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  // ── The applied mark's LIFECYCLE (theme-independent) ───────────────────────
  testWidgets('🔴 the applied ✓ dies on 「恢复原文」 — the buffer is the original '
      'again, so a pill claiming a transform would be describing nothing', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpSheet(tester, theme: Brightness.light);
    await p.transform(tester, ComposeTask.draftPolish, '润色之后的话');
    expect(
      _appliedMark(ComposeTask.draftPolish),
      findsOneWidget,
      reason: 'precondition: the ✓ must first have actually appeared',
    );

    await tester.tap(_restore);
    await tester.pump();
    expect(
      tester.widget<TextField>(_field).controller!.text,
      '一段草稿',
      reason: 'precondition: restore actually put the text back (otherwise what follows measures a restore that never happened)',
    );
    expect(
      _appliedMark(ComposeTask.draftPolish),
      findsNothing,
      reason: '🔴 after restore-original the pill is still lit with ✓ — the on-screen text is the original, and the pill says it is the polish product',
    );
    expect(
      find.text(_zh.aiTaskLabel(ComposeTask.draftPolish)),
      findsOneWidget,
      reason: 'the pill itself is of course still there; it just went back to the neutral face',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 the applied ✓ dies on a user edit — one keystroke and the '
      'buffer is no longer what that run returned', (WidgetTester tester) async {
    final _Page p = await _pumpSheet(tester, theme: Brightness.light);
    await p.transform(tester, ComposeTask.organize, '整理之后的话');
    expect(
      _appliedMark(ComposeTask.organize),
      findsOneWidget,
    );

    await tester.enterText(_field, '整理之后的话，我又改了一个字');
    await tester.pump();
    expect(
      _appliedMark(ComposeTask.organize),
      findsNothing,
      reason: '🔴 after the user edited the text the pill still claims 「this is the organize product」',
    );
    // …and the restore entry is deliberately NOT taken away by an edit (T-6's
    // own rule) — the two lifetimes are different on purpose, which is why the
    // mark cannot simply be derived from `restorableOriginal`.
    expect(_restore, findsOneWidget);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 a FAILED run leaves no ✓ — the mark means 「this is what you '
      'are looking at」, and a failure restored the previous text', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpSheet(tester, theme: Brightness.light);
    expect(p.controller.startAiCompose(ComposeTask.translate), isNull);
    await tester.pump();
    p.transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
      'code': 'LLM_TIMEOUT',
      'message': '',
      'request_id': Map<String, Object?>.from(
        p.transport.emittedWhere(FlowMicEvents.composeStart).last.data! as Map,
      )['request_id']! as String,
    });
    await tester.pump();
    expect(p.controller.aiFailure, isNotNull, reason: 'precondition: this run really failed');
    expect(
      _appliedMark(ComposeTask.translate),
      findsNothing,
      reason: '🔴 a failed run also stamped the mark — that is the mirror failure of 「no silent failure」: '
          'saying a thing that was not done was done',
    );
    p.controller.session.debugStopIdlePresencePoll();
    // A REAL failure raises a banner, and the banner arms its own ~4s auto-hide
    // (`reconcileBannerAutoHideRouted`). Walking it out is the proof this case
    // went down the production failure path rather than a mocked one.
    await tester.pump(const Duration(seconds: 5));
  });
}
