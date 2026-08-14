// FB-3 Plan A acceptance — the visible contract of 「three rows above the
// talk key」(owner 2026-08-06 rulings D1/D2).
//
// Design = docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md §3;
// demo = docs/ui-design/2026-08-06-fb3-fb8-demo.html;
// ruling = docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md D1/D2.
//
// ⚠️ Ruling #4 (2026-08-11, contract=docs/ui-design/2026-08-11-ai-pills-edit-mode-
// and-floating-confirm.md）rewrote two of this file's cases: 「three pills
// present but greyed」turned red per the design and became 「the toolbar
// never carries any ai.task.*」, and 「toolbar width ledger」became 「the
// labelled/compact boundary inside the card」. The edit card's own
// acceptance lives in edit_card_floating_test.dart.
//
// ── Reverse control (measured red, then restored) ──────────────────────────
// Temporarily put FB-3 D1's `AiActionRow(compact: true, …)` back into
// `compose_band.dart`'s `_toolbar` (enabled: false — even the most harmless
// 「present-but-greyed」 revival must be bitten)
// ⇒ 「the toolbar never hosts the three AI pills」fails on the spot, verbatim:
//
//   Expected: no matching candidates
//     Actual: _KeyWidgetFinder:<Found 1 widget with key [<'ai.task.draft_polish'>]: [
//               InkWell-[<'ai.task.draft_polish'>],
//             ]>
//    Which: means one was found but none were expected
//   the draft_polish pill appeared on the tree outside edit mode ⇒ someone
//   moved the three pills back onto the toolbar
//
// Restored and re-greened; leftover string `REVERSE-CONTROL` grep=0.
//
// 🔴 These cases run on a **real ChatController**, not fake callbacks. The
// reason is the law this repo stood in 0.2.51: a widget-only case stays green
// after the production wire is deleted. So every assertion enters from the
// `ChatFlowPage` end; ripping the wire must go red — this round's reverse
// control is recorded at the head of `fb8_confirm_card_test.dart`.
//
// ⚠️ Directionality of the Ahem font (copied from the 0.2.53 draft):
// flutter_test uses a placeholder font where every glyph is a full-em square.
// **「not clipped under Ahem」⇒「will not be clipped on a real device」holds**
// (the conservative direction); **the converse does not**. So every 「it
// fits」 assertion below is done on zh copy — CJK glyphs are already near
// full-em, so Ahem and a real font differ little; Latin copy under Ahem is
// inflated to about twice the width, and using it to argue 「it does not
// fit」 would be a false red.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppSettingsController;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/ai_action_row.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/compose_band.dart'
    show ComposeBand, kComposeControlKeys, kComposeTouchTarget;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _segRealtime = find.byKey(const ValueKey<String>('compose.mode.realtime'));
final Finder _segTranslate = find.byKey(const ValueKey<String>('compose.mode.translate'));
final Finder _segOrganize = find.byKey(const ValueKey<String>('compose.mode.organize'));
// 🔴 T-2 (0.2.63, owner Q3㋐): row 2's idle cell is **no longer a TextField**,
// so every place in this file that used `compose.field` as evidence that
// 「the buffer row is here」 now uses the preview strip.
// ⚠️ This is not pointing the assertion at 「something similar」: at the
// **page** layer today `compose.field` has only two homes (S4's floating
// card, T-3's expanded surface), and neither is idle row 2 —
// keep asserting it and you are asserting a finder that is **always 0**
// under these cases' premises; that assertion goes red first, then after
// flipping to findsNothing it becomes a tautology. The preview strip's
// own three faces live in compose_preview_strip_test.dart.
final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));
final Finder _hint = find.byKey(const ValueKey<String>('compose.modeSwitchHint'));
final Finder _enterKey =
    find.byKey(const ValueKey<String>('compose.ctrl.enter'));

Finder _aiPill(ComposeTask t) =>
    find.byKey(ValueKey<String>('ai.task.${t.wire}'));

ChatController _controller(FakeSocketTransport transport) {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

/// 360dp — the common narrowest Android width. **Measuring this family at
/// the default 800×600 is the same as not measuring**: this round's width
/// ledger only holds on a narrow screen (the 0.2.51 header-bar lesson
/// applies verbatim).
Future<ChatController> _pumpNarrowPage(WidgetTester tester) =>
    _pumpPageAt(tester, width: 360);

/// The same harness parameterized by width — the labelled/compact boundary
/// case must be measured once at each of two widths (ruling #4 contract §5
/// table: the new ledger = the fits / does-not-fit boundary at the
/// **in-card** width).
Future<ChatController> _pumpPageAt(
  WidgetTester tester, {
  required double width,
  double height = 780,
  SendPolicy policy = SendPolicy.direct,
  AppLocale locale = AppLocale.zh,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(locale);
  addTearDown(appSettings.dispose);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(controller: controller, appSettings: appSettings),
    ),
  );
  await tester.pump();
  return controller;
}

/// How wide this text is when unconstrained (the same ruler as
/// chat_header_name_not_starved_widget_test).
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

void main() {
  testWidgets('D2 all three rows present, top-down  mode row → buffer row → toolbar', (
    WidgetTester tester,
  ) async {
    await _pumpNarrowPage(tester);

    // Row 1: all three modes present **at once** — the positive criterion
    // for pain-point 2 「cannot see them all」.
    expect(_segRealtime, findsOneWidget);
    expect(_segTranslate, findsOneWidget);
    expect(_segOrganize, findsOneWidget);
    // Row 2 / row 3.
    expect(_preview, findsOneWidget);
    expect(_enterKey, findsOneWidget);

    final double modeY = tester.getTopLeft(_segRealtime).dy;
    final double bufferY = tester.getTopLeft(_preview).dy;
    final double toolY = tester.getTopLeft(_enterKey).dy;
    expect(modeY, lessThan(bufferY), reason: 'the mode row must sit above the buffer row');
    expect(
      bufferY,
      lessThan(toolY),
      reason: '🔴 the buffer row must sit above the toolbar — this is the '
          'opposite of pre-0.2.5x; the whole point of Plan A is to put '
          '「your words are here」 in the cell immediately above the talk key',
    );
  });

  testWidgets('at 360dp the three rows do not overflow, and not one glyph of the three modes is clipped', (
    WidgetTester tester,
  ) async {
    await _pumpNarrowPage(tester);

    // ① Overflow stripes themselves are one shape of the defect.
    expect(tester.takeException(), isNull, reason: 'the compose area overflowed at 360dp');

    // ② Every segment's glyphs are painted in full. 0.2.53 law: the
    //    criterion lands on the **rendered result** (intrinsic width vs.
    //    the actual box), not on Text.data — that is exactly the shape of
    //    the defect where 1259 cases were all green and the screen showed
    //    three letters.
    for (final Finder seg in <Finder>[_segRealtime, _segTranslate, _segOrganize]) {
      final Finder textFinder = find.descendant(of: seg, matching: find.byType(Text));
      final Text t = tester.widget<Text>(textFinder);
      final double painted = tester.getSize(textFinder).width;
      final double needs = _intrinsicWidth(t);
      expect(
        painted,
        greaterThanOrEqualTo(needs - 0.5),
        reason: '「${t.data}」was squeezed to ${painted.toStringAsFixed(1)}px'
            ' (full paint needs ${needs.toStringAsFixed(1)}px)',
      );
    }
  });

  testWidgets('🔴 must not overflow at 320dp either (the first cut of this round collapsed at this width)', (
    WidgetTester tester,
  ) async {
    // The first cut of this round did the ledger at 360dp; at 320dp it
    // measured `A RenderFlex overflowed by 28 pixels on the right` — what
    // caught it was a case that already existed (the long machine-name
    // case in v204_touch_feedback_widget_test), not me.
    // This case **explicitly** pins that width on this card's own
    // acceptance surface: the next person who touches this row must not
    // again depend on 「the neighbor case happens to run through here」.
    tester.view.physicalSize = const Size(320 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
      await controller.session.dispose();
    });
    transport.pushStatus(SocketStatus.connected);
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the compose area overflowed at 320dp');

    // Positive control: not overflowing is **not** because nothing was
    // painted. The three mode segments, the buffer box, and the four
    // remote keys must all still be on the tree — otherwise 「no overflow」
    // is just because this screen is empty.
    expect(_segRealtime, findsOneWidget);
    expect(_segOrganize, findsOneWidget);
    expect(_preview, findsOneWidget);
    for (final ControlKeyKind k in kComposeControlKeys) {
      expect(find.byKey(ValueKey<String>('compose.ctrl.${k.name}')), findsOneWidget);
    }
    // Ruling #4 (2026-08-11): the three AI pills live only in the edit
    // card; under direct + empty buffer they **must not** appear anywhere
    // — the positive 「three pills present」 assertion moved into the edit
    // card's own tests (edit_card_floating_test.dart).
    for (final ComposeTask t in kAiComposeTasks) {
      expect(_aiPill(t), findsNothing);
    }
    controller.session.debugStopIdlePresencePoll();
  });

  // ── PA-1 (Plan A′) acceptance: deleted surface + 44dp ruler + no send
  // button, page half ──────────────────────────────────────────────────────
  // 🔴 Runs on a **real ChatFlowPage** (the law at the head of this file):
  // a widget-only case stays green after the production wire is deleted,
  // and these three cases answer exactly 「what does the user see on the
  // page」.
  for (final double width in <double>[360, 320]) {
    testWidgets('🔴 PA-1 @${width.toInt()}dp: punct group, chevron and send button are all absent; '
        'the four keys in the group ≥44dp; the whole page does not overflow', (WidgetTester tester) async {
      final ChatController controller = await _pumpPageAt(
        tester,
        width: width,
        height: width == 320 ? 640 : 780,
      );

      // ① Contract §9 ①: deleted clean. Reverse control = put the punct
      // group back into `_toolbar` ⇒ this case goes red.
      for (final ControlKeyKind k in <ControlKeyKind>[
        ControlKeyKind.punctComma,
        ControlKeyKind.punctQuestion,
        ControlKeyKind.punctExclamation,
        ControlKeyKind.punctEnumeration,
        ControlKeyKind.punctColon,
        ControlKeyKind.punctPeriod,
      ]) {
        expect(
          find.byKey(ValueKey<String>('compose.punct.${controlKeyGlyph(k)}')),
          findsNothing,
          reason: '${k.name}\'s button is back on the page (owner Q2㋐ whole-group deletion)',
        );
      }
      expect(
        find.byKey(const ValueKey<String>('compose.tools.toggle')),
        findsNothing,
        reason: 'the chevron is back on the page',
      );

      // ② 🔴 SUP-2: no send button on the idle dock — delivery lives in
      //    the edit-surface footer; the policy chip is the only toggle
      //    entry. REVERSE CONTROL for PA-1 (run red, then reverted):
      //    re-adding a 'compose.send' button to row 2 turns this line red by name.
      expect(
        find.byKey(const ValueKey<String>('compose.send')),
        findsNothing,
        reason: '🔴 the idle dock grew a send button again (SUP-2)',
      );

      // ③ Contract §5-1: the 44dp ruler. **Measure the rendered result**,
      //    do not read the constant in source.
      for (final ControlKeyKind k in kComposeControlKeys) {
        final Size s = tester.getSize(
          find.byKey(ValueKey<String>('compose.ctrl.${k.name}')),
        );
        expect(s.width, greaterThanOrEqualTo(44), reason: '${k.name} is too narrow');
        expect(s.height, greaterThanOrEqualTo(44), reason: '${k.name} is too short');
      }
      // SUP-8: `+` joined the same ruler (38 → 44).
      final Size plus =
          tester.getSize(find.byKey(const ValueKey<String>('compose.plus')));
      expect(plus.width, greaterThanOrEqualTo(44), reason: '+ is still stuck at 38');
      expect(plus.height, greaterThanOrEqualTo(44));

      // ③ Contract §9 ③: neither width overflows. 44dp is larger than
      //    the old 38/32, so this case is **not formalism** this round —
      //    it is the measured half of the 「do the ledger first, then
      //    touch the code」 account.
      expect(
        tester.takeException(),
        isNull,
        reason: 'the compose area overflowed at ${width.toInt()}dp',
      );

      // 🔴 Positive control: those findsNothing above are not because
      // this screen painted nothing.
      expect(_preview, findsOneWidget);
      expect(_enterKey, findsOneWidget);

      // ⑤ V2-03 owner ⑤「高频键放右边」— the **on-page** absolute
      // criterion; after PA-1 it lands on the key-group container
      // (equal split inside the group, ⏎ still in the rightmost cell;
      // in-group geometry is pinned by compose_band_widget_test.dart).
      final double bandRight =
          tester.getBottomRight(find.byType(ComposeBand)).dx;
      expect(
        tester
            .getTopRight(
              find.byKey(const ValueKey<String>('compose.keys.group')),
            )
            .dx,
        closeTo(bandRight, 0.5),
        reason: 'the key group is not flush with the band\'s right edge ⇒ '
            'that owner quote about the thumb arc is dead again',
      );

      controller.session.debugStopIdlePresencePoll();
    });
  }

  // ── PA-1: row 1 = mode segments + policy chip (SUP-3) ───────────────────
  testWidgets('🔴 SUP-3: the policy chip is on row 1 (above the preview strip); translate mode at 360dp '
      'does not overflow', (WidgetTester tester) async {
    final ChatController controller = await _pumpPageAt(tester, width: 360);
    expect(_policy, findsOneWidget);
    expect(
      tester.getBottomLeft(_policy).dy,
      lessThanOrEqualTo(tester.getTopLeft(_preview).dy + 0.5),
      reason: '🔴 the policy chip is not on row 1 — SUP-3\'s move did not happen',
    );
    // translate mode grows a direction chip on row 1 — the widest row 1
    // under zh.
    await tester.tap(_segTranslate);
    await tester.pumpAndSettle();
    expect(controller.mode, FlowMode.translate);
    expect(tester.takeException(), isNull, reason: 'translate row 1 overflowed at 360dp');
    expect(_policy, findsOneWidget);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('pain-point 2 fix: one tap reaches the third mode, and no confirm dialog pops', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpNarrowPage(tester);
    // Buffer non-empty — exactly the state the old implementation would
    // intercept and ask about.
    controller.setBuffer('还没发出去的话');
    await tester.pump();

    // ③ Organize: **one** tap gets there, without going through ②
    // translate.
    await tester.tap(_segOrganize);
    await tester.pumpAndSettle();
    expect(
      controller.mode,
      FlowMode.organize,
      reason: 'one-tap reach failed — back to 「tap twice to get to the third mode」',
    );
    // M4's confirm dialog (「切换并清空」) must not appear again: D1
    // explicitly cancelled it.
    expect(find.text('切换并清空'), findsNothing);
    expect(find.text('输入框里有未发送内容，切换模式会将其清空'), findsNothing);
    // 08 §2 red line was not touched by this simplification: switching
    // modes still clears the buffer.
    expect(controller.buffer, isEmpty);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('the confirm dialog\'s substitute is a hint bar already on screen **beforehand**, and it reads in full', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpNarrowPage(tester);
    // Empty buffer ⇒ nothing would be cleared ⇒ this sentence must not
    // be there (otherwise it becomes background noise).
    expect(_hint, findsNothing);

    controller.setBuffer('还没发出去的话');
    await tester.pump();
    expect(
      _hint,
      findsOneWidget,
      reason: '🔴 D1 cancelled the confirm dialog; the substitute must be '
          'readable **before** the destructive tap; without it, switching '
          'modes and clearing the buffer becomes a silent destruction',
    );

    // 0.2.53 law: whether this sentence can be read, the criterion is
    // on the rendered result.
    final Finder hintText =
        find.byKey(const ValueKey<String>('compose.modeSwitchHint.text'));
    final RenderParagraph p = tester.renderObject<RenderParagraph>(hintText);
    expect(
      p.didExceedMaxLines,
      isFalse,
      reason: 'the hint bar was clipped — 「${_zh.composeModeSwitchClearsHint}」the user cannot read in full',
    );
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('pain-point 1 fix (PA-1 shape): the policy chip is visible and tappable; the flash names the new state then '
      'leaves entirely', (WidgetTester tester) async {
    // SUP-2 killed the send button and its long-press, so the chip is the ONLY
    // toggle now — which is why this case also owns the V2-04 flash's page
    // half (MD-6: same 800ms mechanism, re-anchored under the chip's new
    // row-1 home).
    final ChatController controller = await _pumpNarrowPage(tester);
    expect(
      _policy,
      findsOneWidget,
      reason: 'the explicit policy chip is absent ⇒ manual/auto have no entry at all (after SUP-2 it is the only entry)',
    );
    expect(controller.sendPolicy, SendPolicy.direct);
    // The flash is identified by its HINT sentence (only the flash renders it;
    // the chip prints the bare label).
    expect(find.textContaining('说完先进输入框'), findsNothing);

    // Tap the chip to toggle — the wire is on the real controller.
    await tester.tap(_policy);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));
    expect(
      controller.sendPolicy,
      SendPolicy.manual,
      reason: '🔴 tapping the chip did nothing ⇒ 「the entry is invisible」was swapped for 「the entry is visible but dead」, which is worse',
    );
    // The flash names the state the switch moved TO, exactly once…
    expect(find.textContaining('说完先进输入框'), findsOneWidget);
    // …and is on screen (not clipped away above the dock or off the page).
    final Rect flash =
        tester.getRect(find.textContaining('说完先进输入框'));
    expect(flash.bottom, lessThanOrEqualTo(780));
    expect(flash.left, greaterThanOrEqualTo(0));

    // Past the 800ms hold + 200ms fade it leaves the tree entirely (V2-04:
    // the switch leaves no permanent UI behind).
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('说完先进输入框'), findsNothing);
    // …and the standing chip is untouched by the flash coming and going.
    expect(_policy, findsOneWidget);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 Ruling #4: the toolbar **never** hosts the three AI pills; height does not jump with buffer content', (
    WidgetTester tester,
  ) async {
    // FB-3 D1's 「present but greyed」was overturned wholesale by owner
    // ruling #4: the three pills appear only in the edit card (contract
    // §2 — 「the toolbar never hosts the three AI pills from now on」).
    // The guarantee this case keeps swapped from 「greyed, not gone」to
    // two harder ones: ① under direct (no edit mode) the tree has
    // **zero** `ai.task.*`; ② the toolbar's height and horizontal
    // position are **pixel-equal** in the empty / non-empty buffer
    // states — pain-point 3 (the compose area jumping with content) is
    // now structurally impossible, but structure can be put back by the
    // next person, so it still has to be tested.
    final ChatController controller = await _pumpNarrowPage(tester);

    // Empty buffer (direct default policy): not one pill allowed.
    for (final ComposeTask t in kAiComposeTasks) {
      expect(
        _aiPill(t),
        findsNothing,
        reason: 'the ${t.wire} pill appeared on the tree outside edit mode ⇒ someone moved the three pills back onto the toolbar',
      );
    }
    final double toolHeightEmpty = tester.getSize(_enterKey).height;
    final double toolTopEmpty = tester.getTopLeft(_enterKey).dy;
    final double toolLeftEmpty = tester.getTopLeft(_enterKey).dx;

    controller.setBuffer('有内容了');
    await tester.pump();
    // direct + non-empty buffer: still not edit mode (the predicate is
    // manual ∧ non-empty, contract §1)
    // ⇒ still zero pills.
    for (final ComposeTask t in kAiComposeTasks) {
      expect(_aiPill(t), findsNothing);
    }
    expect(
      tester.getSize(_enterKey).height,
      toolHeightEmpty,
      reason: 'toolbar height changed with buffer content ⇒ the layout is still jumping',
    );
    expect(tester.getTopLeft(_enterKey).dx, toolLeftEmpty);
    // ⚠️ Intentionally not comparing the Y coordinate: under direct, a
    // non-empty buffer grows the buffer hint bar (that is row 2's own
    // legitimate height growth, already in FB-3); the toolbar shifts
    // down as a whole but **its own geometry is unchanged** — comparing
    // dy would mis-report an existing, correct behavior as a jump.
    expect(
      toolTopEmpty,
      greaterThan(0),
      reason: 'positive control: the toolbar must actually be painted on screen, otherwise the equalities above are spinning',
    );
    controller.session.debugStopIdlePresencePoll();
  });

  // ── Width ledger (rewritten by ruling #4): the labelled/compact
  // boundary is measured at the **in-card** width ─────────────────────────
  testWidgets('🔴 the measured ledger: card wide enough ⇒ three pills carry text and aiRowNote prints; card too narrow ⇒ '
      'compact + a standalone caption row', (WidgetTester tester) async {
    // The old ledger (FB-3: does the toolbar fit) was voided when the
    // three pills left the toolbar. The new ledger (contract §5 table):
    // the boundary is measured by `AiActionRow.labelledRowFits` against
    // the **card's real inner width**. This test does not re-read that
    // function (implementation against implementation is tautology) —
    // it **independently recomputes** a needed width with TextPainter
    // and checks both ends against the rendered result: on a wide card
    // the labels really printed, on a narrow card it fell back to
    // compact and the caption row caught that sentence.
    //
    // ⚠️ Ahem ruler (file head): CJK glyphs are already near full-em ⇒
    // under zh copy Ahem and a real font are almost the same width,
    // 「it fits」at 500dp is **same-direction** for both fonts; 「it
    // does not fit」at 320dp likewise (zh need >300px against a 278px
    // inner width; a real font does not fit either). Intentionally
    // not deciding either side at 360dp: that is exactly the
    // transition band where Ahem and a real font may give opposite
    // verdicts.
    double textW(String s, double size, FontWeight w) {
      final TextPainter p = TextPainter(
        text: TextSpan(text: s, style: TextStyle(fontSize: size, fontWeight: w)),
        textDirection: TextDirection.ltr,
        maxLines: 1,
      )..layout();
      return p.width;
    }

    double need = 0;
    for (final ComposeTask t in kAiComposeTasks) {
      // 12(left pad) + 12(icon) + 5(gap) + label + 12(right pad) + 7(pill gap).
      need += 24 + 12 + 5 + textW(_zh.aiTaskLabel(t), 12, FontWeight.w600) + 7;
    }
    need += textW(_zh.aiRowNote, 10.5, FontWeight.normal);

    // ① 500dp: PA-4's edit surface is a full-width sheet — inner width
    // = 500 - 2(left/right border) - 32(padding).
    final ChatController wide = await _pumpPageAt(
      tester,
      width: 500,
      policy: SendPolicy.manual,
    );
    wide.setBuffer('这句话要整理一下');
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the edit surface overflowed at 500dp');
    final Finder card = find.byKey(const ValueKey<String>('compose.card'));
    expect(card, findsOneWidget);
    final double innerWide = tester.getSize(card).width - 2 - 32;
    expect(
      need,
      lessThanOrEqualTo(innerWide),
      reason: 'independently recomputed need ${need.toStringAsFixed(1)}px should fit the inner width '
          '${innerWide.toStringAsFixed(1)}px — otherwise asserting labelled below is asserting the wrong direction',
    );
    for (final ComposeTask t in kAiComposeTasks) {
      expect(
        find.descendant(of: card, matching: find.text(_zh.aiTaskLabel(t))),
        findsOneWidget,
        reason: '🔴 in-card width ${innerWide.toStringAsFixed(1)}px clearly fits'
            ' (need ${need.toStringAsFixed(1)}px), yet 「${_zh.aiTaskLabel(t)}」did not print'
            ' — 「prefer having the words」(ruling #4 item 2) was not delivered',
      );
    }
    // The labelled branch carries aiRowNote (applies to the buffer ·
    // does not inject) — the sentence the ruling explicitly forbade
    // the layout from losing; the criterion is on the rendered result.
    final Finder noteWide =
        find.descendant(of: card, matching: find.text(_zh.aiRowNote));
    expect(noteWide, findsOneWidget);
    final RenderParagraph notePara = tester.renderObject<RenderParagraph>(noteWide);
    expect(
      notePara.didExceedMaxLines,
      isFalse,
      reason: '🔴「${_zh.aiRowNote}」was clipped — it printed, but the user cannot read it in full, which equals not printing',
    );
    wide.session.debugStopIdlePresencePoll();

    // ② 320dp: sheet inner width = 320 - 2 - 32 = 286 < zh need ⇒ must
    //    fall back to compact, and the caption row catches that sentence.
    await tester.pumpWidget(const SizedBox());
    final ChatController narrow = await _pumpPageAt(
      tester,
      width: 320,
      height: 640,
      policy: SendPolicy.manual,
    );
    narrow.setBuffer('这句话要整理一下');
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the edit surface overflowed at 320dp');
    final double innerNarrow = tester.getSize(card).width - 2 - 32;
    expect(
      need,
      greaterThan(innerNarrow),
      reason: 'premise failed: zh need ${need.toStringAsFixed(1)}px somehow fits '
          '${innerNarrow.toStringAsFixed(1)}px ⇒ asserting compact below is asserting the wrong direction',
    );
    for (final ComposeTask t in kAiComposeTasks) {
      expect(_aiPill(t), findsOneWidget, reason: 'compact still has to paint the pills');
      expect(
        find.descendant(of: card, matching: find.text(_zh.aiTaskLabel(t))),
        findsNothing,
        reason: 'the compact branch does not print labels (if it did, it should be judged labelled, and the ledger says it does not fit)',
      );
    }
    final Finder caption =
        find.byKey(const ValueKey<String>('compose.card.aiNote'));
    expect(
      caption,
      findsOneWidget,
      reason: '🔴 under compact the card must have a separate caption row to catch 「${_zh.aiRowNote}」'
          ' (contract §3 — the copy in the Tooltip is invisible to the user)',
    );
    expect(tester.widget<Text>(caption).data, _zh.aiRowNote);
    expect(
      tester.renderObject<RenderParagraph>(caption).didExceedMaxLines,
      isFalse,
      reason: 'the caption row itself was clipped',
    );
    narrow.session.debugStopIdlePresencePoll();
  });

  testWidgets('mode segments are ≥44dp tall (dock touch ruler)', (
    WidgetTester tester,
  ) async {
    final ChatController c = await _pumpNarrowPage(tester);
    final Size size = tester.getSize(_segRealtime);
    expect(
      size.height,
      greaterThanOrEqualTo(kComposeTouchTarget),
      reason: 'mode hit box ${size.height} < $kComposeTouchTarget',
    );
    c.session.debugStopIdlePresencePoll();
  });

  testWidgets('EN mode+policy stay on ONE line at 360dp', (
    WidgetTester tester,
  ) async {
    // Ahem makes EN words ~2× true width, so this does NOT claim the labels
    // paint in full — only that the policy chip did not wrap onto a second
    // run (the Wrap bug). Reverse control: restore Wrap in
    // `_modePolicyRowRouted` → policy.dy jumps ~20dp and this goes red.
    final ChatController c =
        await _pumpPageAt(tester, width: 360, locale: AppLocale.en);
    expect(tester.takeException(), isNull);
    final double modeY = tester.getCenter(_segRealtime).dy;
    final double policyY = tester.getCenter(_policy).dy;
    expect(
      (policyY - modeY).abs(),
      lessThan(8),
      reason: 'EN policy chip wrapped off the mode row '
          '(modeY=$modeY policyY=$policyY)',
    );
    c.session.debugStopIdlePresencePoll();
  });
}
