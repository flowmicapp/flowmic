// FB-8 acceptance — manual send: after transcription, stay editable then
// deliver (owner 2026-08-06 ruling D4).
//
// Design draft=docs/ui-design/2026-08-06-fb8-manual-send-edit-flow.md §3/§5;
// demo=docs/ui-design/2026-08-06-fb3-fb8-demo.html `confirmCard()`;
// ruling=docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md D4.
//
// 🔴 FB-8 §2's stance is "do not invent a new mechanism; promote the existing
// buffer into a transcription confirm card", so **not one** case in this
// family is verifying a new delivery capability: delivery still walks
// `sendBuffer`, discard still walks `_clearBuffer`, the stay-state is still
// the existing "pending delivery" family. They verify **presentation and
// wiring**.
//
// ── Reverse control (measured red, then restored) ──────────────────────────
// Widget-only cases have zero proving power on "is the wiring still there"
// (0.2.51 rule). So this round ripped each of the two production wirings
// once, measured red:
//
// ① Rip `&& !s.controller.isAiComposing` off ComposeBand in
//    `chat_flow_composer.dart` (the W2.5-1 landmine; `ChatController.canSend`'s
//    docs name it as the line a W5b re-layout is most likely to drop silently)
//    ⇒ "while AI is streaming into the buffer, the field must not permit
//    editing" fails on the spot, character for character:
//
//      Expected: false
//        Actual: <true>
//      🔴 AI is writing into the buffer, and the field is editable — the
//         user's edits will be overwritten character by character, and ➤
//         will send a sentence that is not finished
//
// ② Change the card's [丢弃] `onTap: widget.onDiscard` to
//    `onTap: () => widget.onControlKey(ControlKeyKind.clear)`
//    (i.e. "discard" mis-wired as the remote ✕) ⇒ "discard must not touch
//    the PC" fails on the spot, character for character:
//
//      Expected: empty
//        Actual: [EventEnvelope:EventEnvelope(control:key, {kind: clear})]
//      🔴 [丢弃] sent control:key on the wire — the user only wanted to throw
//         away their own draft, and instead also cleared the content of the
//         PC's focused window. The two things have similar names and opposite
//         consequences
//
//    ⚠️ ② is deliberately done on the `compose_buffer_row.dart` end, not the
//    composer end: writing `ControlKeyKind` in the composer **will not
//    compile** (that type is not on chat_flow_page.dart's import surface),
//    and "does not compile" is a "build failure" not a "test going red" —
//    it does not prove this case can bite this defect. The mis-wire must
//    happen at a place that can really compile, run, and fool everyone, or
//    the reverse control does not count.
//
// Both places have been restored and re-greened; leftover-string grep=0.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart'
    show EventEnvelope, SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _card = find.byKey(const ValueKey<String>('compose.card'));
final Finder _cardHeader =
    find.byKey(const ValueKey<String>('compose.card.header'));
final Finder _deliver =
    find.byKey(const ValueKey<String>('compose.card.deliver'));
final Finder _discard =
    find.byKey(const ValueKey<String>('compose.card.discard'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));
// T-2: the idle-state cell of row 2 (not the TextField) — see the comment on
// this file's direct-mode regression case.
final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _plus = find.byKey(const ValueKey<String>('compose.plus'));
final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));

class _Page {
  _Page(this.transport, this.controller);
  final FakeSocketTransport transport;
  final ChatController controller;

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
  List<EventEnvelope> get controlKeys =>
      transport.emittedWhere(FlowMicEvents.controlKey);
}

Future<_Page> _pumpPage(
  WidgetTester tester, {
  SendPolicy policy = SendPolicy.manual,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

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
    await session.dispose();
    await transport.close();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return _Page(transport, controller);
}

void main() {
  testWidgets('manual + buffer non-empty ⇒ the confirm card appears, and says "it has stopped now"', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    // No card when the buffer is empty — if nothing is waiting for you, there
    // should not be a card that says "waiting for you".
    expect(_card, findsNothing);

    p.controller.setBuffer('刚刚说的一句话');
    await tester.pump();
    expect(_card, findsOneWidget);
    // FB-8 §1's third real gap: the status semantics had never been spoken.
    expect(find.text(_zh.composeCardHeader), findsOneWidget);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('regression: in automatic (direct) mode the confirm card does not appear, behavior is character-for-character the same as today', (
    WidgetTester tester,
  ) async {
    // FB-8 §3 "deliberately not doing" ③. Without this one, this card could
    // quietly turn direct into "press once then send" too — that is swapping
    // the default policy, not adding a feature.
    final _Page p = await _pumpPage(tester, policy: SendPolicy.direct);
    p.controller.setBuffer('打出来的字');
    await tester.pump();
    expect(_card, findsNothing);
    // And the ordinary input row is still there (can enter, can send).
    // 🔴 T-2 (0.2.63) changed this row's **subject**: idle row 2 in direct
    // paints the preview strip, no longer `compose.field` (owner Q3㋐「不画 38px
    // 假输入框」). The assertion moved onto that cell, rather than becoming
    // `findsNothing` — the latter is a tautology under this case's premise,
    // and the "confirm card does not appear" regression would spin empty
    // along with it. The landing of the "can type" half also moved: now it
    // is tap the preview strip ⇒ the expanded surface
    // (expanded_compose_test.dart).
    expect(_preview, findsOneWidget);
    // PA-1 (SUP-2): the idle row has no send button any more — the preview
    // strip above is the row's whole face, and delivery lives in the edit
    // surface. "can enter" is the strip's tap (compose_preview_strip_test.dart).
    expect(find.byKey(const ValueKey<String>('compose.send')), findsNothing);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 D4: the card does not auto-raise the keyboard when it appears; tap then focus', (
    WidgetTester tester,
  ) async {
    // owner ruling D4, reason=auto-focus would interrupt continuous dictation
    // (finished one sentence and still want to say another). The criterion
    // lands on **whether the keyboard really rose** (`testTextInput.isVisible`),
    // not on the `TextField.autofocus` property — whether the property is
    // right and whether the user saw a keyboard are two different things.
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('第一句');
    await tester.pump();
    expect(_card, findsOneWidget);
    expect(
      tester.testTextInput.isVisible,
      isFalse,
      reason: '🔴 the card popped the keyboard the moment it appeared — continuous dictation would be interrupted (D4)',
    );

    // Tap the field on the card ⇒ only then does it focus.
    await tester.tap(_field);
    await tester.pump();
    expect(
      tester.testTextInput.isVisible,
      isTrue,
      reason: 'tapped the field but it did not focus ⇒ the user cannot edit at all, FB-8\'s "editable" is empty',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('the card-header sentence is fully readable at 360dp (0.2.53 rule: assert the render result)', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('一句话');
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the card overflowed at 360dp');

    final RenderParagraph para =
        tester.renderObject<RenderParagraph>(_cardHeader);
    expect(
      para.didExceedMaxLines,
      isFalse,
      reason: '🔴 the card header was clipped — 「${_zh.composeCardHeader}」 is '
          'exactly the only sentence FB-8 uses to answer "what state is this '
          'now", unread in full equals not said. (0.2.53 shipped exactly like '
          'this: asserting Text.data was all green, three letters on screen)',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('buffer field promoted: 16px / multi-line grows with content (pain point 5)', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('一句话');
    await tester.pump();
    final TextField tf = tester.widget<TextField>(_field);
    // 🔴 WP8 VF-4: this line previously pinned 14. **What it guards has not
    // changed; the number was swapped by a higher-ranking spec** — pain
    // point 5 asks "can this field carry the main stage", FB-8's answer at
    // the time was 14, the design draft `.bdy{font-size:16px;line-height:1.75}`
    // gives 16, and visual-fidelity contract §0's rule is **the design draft
    // wins over existing convention**. The direction is the same (larger),
    // so this is the same case changing its ruler, not changing what it
    // guards.
    expect(tf.style!.fontSize, 16, reason: 'a 13px field cannot carry FB-8\'s main stage');
    // 🔴 T-5 (0.2.63, owner supplement #4) — this line previously asserted
    // `maxLines == 5`.
    //
    // That 5 is a **ceiling**, and what this case guards is pain point 5:
    // "a 13px×3-line field looks like an accessory input" ⇒ the field must
    // be large, must grow with content, must not be a single-line input.
    // T-5 changed the ceiling from "five lines" to "the card's available
    // height" (design book §6-2 item 2), which is the **more** direction,
    // not a departure.
    //
    // ⚠️ So what changed is the assertion, not the guarantee it guards:
    // null ＝ "no line-count ceiling", the ceiling is now given by the
    // card's `Flexible` (the geometric criterion is in
    // edit_card_fullscreen_test.dart, which measures painted height, not
    // this property). **The only thing that must not happen is it becoming
    // single-line again**, so the `isNot(1)` below is this case's real red
    // line. ⚠️ 5 has not disappeared: it is still the default of
    // `ComposeBufferField.maxLines`, and the ordinary input row (row 2)
    // still takes it.
    expect(tf.maxLines, isNull, reason: 'the in-card field should no longer have a line-count ceiling (T-5)');
    expect(tf.maxLines, isNot(1), reason: '🔴 the field fell back to single-line ⇒ pain point 5 is back as-is');
    expect(tf.minLines, 1, reason: 'a short draft still starts from one line (does not expand the moment it opens)');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('[➤ 投递] walks the existing sendBuffer —— a frame really goes on the wire', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('要投递的内容');
    await tester.pump();
    expect(p.injects, isEmpty);

    await tester.tap(_deliver);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      p.injects,
      hasLength(1),
      reason: '🔴 the card\'s primary button did not send anything ⇒ this card is a façade',
    );
    // A **real** delivery winds two springs: RCA-v3's 20-second inject:result
    // watchdog (`ManualDelivery._armResultWatch`) and the queue's 45-second
    // item watchdog (`outboxArmItemWatch`). Walk both to the end, otherwise
    // the moment the test tree is torn down the binding reports a pending
    // timer — that is a side effect of this case really walking the
    // production path, not a defect. (It is also what proves this tap **is
    // not** fake: a façade button would not wind a spring.)
    await tester.pump(const Duration(seconds: 46));
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 [丢弃] only discards the local draft, never touches the PC (it is not the remote ✕)', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('不要了的草稿');
    await tester.pump();

    await tester.tap(_discard);
    await tester.pump();
    expect(p.controller.buffer, isEmpty);
    expect(_card, findsNothing, reason: 'after discard the card should fold away');
    expect(
      p.controlKeys,
      isEmpty,
      reason: '🔴 [丢弃] sent control:key on the wire — the user only wanted to throw '
          'away their own draft, and instead also cleared the content of the '
          'PC\'s focused window. The two things have similar names and opposite '
          'consequences',
    );
    expect(p.injects, isEmpty, reason: 'discard is not a delivery');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 PA-4: the sheet header carries NO ✕ — the old header-✕ '
      'discard is gone and nothing ✕-shaped replaced it (SUP-1)', (
    WidgetTester tester,
  ) async {
    // RED-BY-DESIGN REPLACEMENT (contract §7): the card-era case here pinned
    // "the header ✕ and [丢弃] are the same action". Plan A′ deletes that ✕
    // outright — a ✕ beside an editable draft is the named mis-touch risk —
    // so the pinned guarantee flips: no discardX key, no close icon, discard
    // ONLY in the footer (its own case above keeps that half green).
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('草稿');
    await tester.pump();
    expect(_card, findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('compose.card.discardX')),
      findsNothing,
      reason: '🔴 the header ✕ is back — the mis-touch surface SUP-1 named',
    );
    expect(
      find.descendant(of: _card, matching: find.byIcon(Icons.close)),
      findsNothing,
    );
    // Positive control: the footer discard still exists and still discards.
    expect(_discard, findsOneWidget);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 SUP-6: 「＋」 and the policy chip are not inside the edit surface —— reachable within one collapse', (
    WidgetTester tester,
  ) async {
    // RED-BY-DESIGN REPLACEMENT (contract §7): the card-era case pinned
    // 「卡内构件一件不减」(owner ruling #4 §3). SUP-6 supersedes it — the sheet
    // carries header/body/pills/append/footer only, and `+`/chip live one
    // collapse away in the idle dock. ⚠️ The assertions are DESCENDANT-scoped
    // on purpose: the dock keeps rendering UNDER the scrim, so an unscoped
    // findsOneWidget would stay green while the control sat unreachable — a
    // vacuous green is the 0.2.52 shape.
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('进编辑面');
    await tester.pump();
    expect(_card, findsOneWidget);
    expect(find.descendant(of: _card, matching: _plus), findsNothing);
    expect(find.descendant(of: _card, matching: _policy), findsNothing);

    await tester.tap(find.byKey(const ValueKey<String>('compose.sheet.collapse')));
    await tester.pump();
    expect(_card, findsNothing);
    expect(_plus, findsOneWidget, reason: 'after collapse `+` must really be in the idle dock');
    expect(_policy, findsOneWidget);
    expect(p.controller.buffer, '进编辑面', reason: 'collapse must not touch the buffer');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 W2.5-1 landmine: while AI is streaming into the buffer, the field must not permit editing', (
    WidgetTester tester,
  ) async {
    // `ChatController.canSend`'s docs name this risk character for character:
    // "W5b is about to rebuild the whole input area and a re-layout is exactly
    // the kind of change that silently drops a line like `&& !isAiComposing`".
    // This round is exactly that re-layout. The reverse control that ripped
    // that term, measured red, is ① in this file's header.
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('原始文本');
    await tester.pump();
    expect(tester.widget<TextField>(_field).enabled, isTrue);

    p.controller.startAiCompose(ComposeTask.draftPolish);
    await tester.pump();
    expect(
      p.controller.isAiComposing,
      isTrue,
      reason: 'premise did not hold: this run did not really start, so the assertion below is spinning empty',
    );
    expect(
      tester.widget<TextField>(_field).enabled,
      isFalse,
      reason: '🔴 AI is writing into the buffer, and the field is editable — the '
          'user\'s edits will be overwritten character by character, and ➤ '
          'will send a sentence that is not finished',
    );
    // Walk AiComposeController's 45-second timeout spring to the end (same
    // as above: the existence of this spring itself shows this run really
    // started), then walk the 4-second auto-hide spring of the banner that
    // rises after it times out (`reconcileBannerAutoHideRouted`) — one
    // spring lights the next, until all have been walked.
    await tester.pump(const Duration(seconds: 46));
    await tester.pump(const Duration(seconds: 5));
    p.controller.session.debugStopIdlePresencePoll();
  });

  // ── Controller layer: where those rows go after discard ──────────────────
  test('discard ⇒ rows that fed this buffer settle as 📥 noted, not hanging forever', () async {
    // FB-8 §3-5 "related rows settle as noted (status-quo mechanism)". This
    // one deliberately does not walk the widget layer: the real PTT chain is
    // async, and awaiting it inside testWidgets' FakeAsync zone deadlocks
    // (an existing scar in this repo; written in the header of
    // compose_send_policy_test.dart).
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    final TimelineStore store = newTestStore();
    final DestinationController destination = DestinationController();
    final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
    await controller.loadSendPolicy();
    transport.pushStatus(SocketStatus.connected);

    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '说了但没发的话',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();

    expect(controller.buffer, '说了但没发的话', reason: 'under manual the final folds into the buffer');
    expect(store.entries, hasLength(1));

    controller.discardBuffer();
    await pumpEventQueue();

    expect(controller.buffer, isEmpty);
    expect(
      store.entries.first.status,
      EntryStatus.noted,
      reason: '🔴 this sentence **was really spoken**, so the row must stay; but '
          'it was never delivered, so stopping at ⏳ is a lie the user will '
          'never get an answer to',
    );
    expect(
      transport.emittedWhere(FlowMicEvents.controlKey),
      isEmpty,
      reason: 'discardBuffer is a local action, not one frame may go on the wire',
    );

    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  });
}
