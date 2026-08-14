// T-6 acceptance (0.2.63) — after organize/translate/polish **succeeds**, the
// original must be restorable.
//
// Ruling = docs/decisions/2026-08-13-owner-0263-design-rulings.md §2 addendum #5
// (「还有一个是下方的整理/翻译/润色点击后要能恢复，不然就找不到原文了」)
// ＋ §3 row 5 (status check: `_originalBuffer` **restores only on failure**,
// no entry point after success).
//
// 🔴 This file guards three things; the second is the entire difficulty of this card:
//   ① After success there is something to restore (previously only failure path F-3 had it);
//   ② **Successive transforms do not nest** — after organize → translate, 「恢复原文」
//      gives back the **very first** text, not the organize product. The reverse
//      control (wiring restore to the snapshot from "before the last run") is at
//      the end of this file; it really went red, and the red output is copied
//      into that case's comment;
//   ③ **Failure path F-3 is byte-identical** — failure still restores the
//      "pre-operation buffer", and failure does **not** clear the restore entry
//      (the text after a failure is often itself an AI product; the original is
//      still the only thing you cannot get back to).
//
// Lifecycle (boundaries set this round; each has a source comment in the code):
//   · Used once, then gone (the buffer is already the original; offering another
//     「恢复原文」 would be answering a question the screen already shows);
//   · Discard / switch mode / empty the field ⇒ clear (that draft is gone; the
//     original is no longer anyone's original);
//   · **Delivery succeeds** ⇒ clear (the original rode the frame with the
//     delivery, see T-7; after that, looking up the original means looking at
//     the row, not the button);
//   · Ordinary edits ⇒ **do not clear** (editing the AI result is exactly why
//     this entry point exists).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final Finder _restore =
    find.byKey(const ValueKey<String>('compose.card.restoreOriginal'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));

class _Harness {
  _Harness({SendPolicy policy = SendPolicy.manual}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  void connect() => transport.pushStatus(SocketStatus.connected);

  String get _liveRequestId => Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.composeStart).last.data! as Map,
      )['request_id']! as String;

  void pushDone(String output) =>
      transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
        'output_text': output,
        'request_id': _liveRequestId,
      });

  void pushError(String code) =>
      transport.pushIncoming(FlowMicEvents.composeError, <String, Object?>{
        'code': code,
        'message': '',
        'request_id': _liveRequestId,
      });

  /// One complete successful transform over whatever is in the buffer.
  Future<void> transform(ComposeTask task, String output) async {
    expect(controller.startAiCompose(task), isNull,
        reason: 'precondition: this run actually started (otherwise what follows is testing air)');
    pushDone(output);
    await pumpEventQueue();
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('a restore is available only after a successful transform; restore gives back the pre-transform text', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('我说的原话');
    // Positive control: no transform yet ⇒ no restore entry (not "there is one but tapping it does nothing").
    expect(h.controller.restorableOriginal, isNull);
    expect(h.controller.restoreOriginal(), isFalse);

    await h.transform(ComposeTask.organize, '整理后的话');
    expect(h.controller.buffer, '整理后的话');
    expect(h.controller.restorableOriginal, '我说的原话');

    expect(h.controller.restoreOriginal(), isTrue);
    expect(h.controller.buffer, '我说的原话');
    // Used once, then gone.
    expect(h.controller.restorableOriginal, isNull);
    await h.dispose();
  });

  test('🔴 successive transforms do not nest: after organize → translate, restore gives back the very first text (not the organize product)',
      () async {
    // 🔴 Reverse control (really run this round, see file header ②): change the
    // `??=` in `_restorable ??= _originalBuffer` to `=` (i.e. "restore to
    // before the last run"), and this case goes red on the spot:
    //   Expected: '我说的原话'
    //     Actual: '整理后的话'
    // Restored, then green again. ⚠️ That implementation **will not** be caught
    // by the previous case (under a single transform the two are byte-identical);
    // this case is its only guard.
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('我说的原话');

    await h.transform(ComposeTask.organize, '整理后的话');
    expect(h.controller.restorableOriginal, '我说的原话');
    await h.transform(ComposeTask.translate, 'the organized sentence');
    expect(h.controller.buffer, 'the organized sentence');
    expect(
      h.controller.restorableOriginal,
      '我说的原话',
      reason: '🔴 the restore entry points at an intermediate product ⇒ 「恢复原文」 became "undo one step",'
          ' and the user tapped the second pill precisely because the first result was wrong',
    );

    h.controller.restoreOriginal();
    expect(h.controller.buffer, '我说的原话');
    await h.dispose();
  });

  test('🔴 failure path F-3 is byte-identical: failure still restores the pre-operation buffer and does not clear the restore entry', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('我说的原话');
    await h.transform(ComposeTask.organize, '整理后的话');

    // Second run fails ⇒ F-3: buffer returns to **pre-operation** (= the organize product), banner shows the reason.
    expect(h.controller.startAiCompose(ComposeTask.translate), isNull);
    h.pushError('LLM_TIMEOUT');
    await pumpEventQueue();
    expect(h.controller.buffer, '整理后的话', reason: 'F-3 "failure keeps the pre-operation buffer"');
    expect(h.controller.aiFailure, isNotNull, reason: 'no silent failure');
    // And "back to the very first" is still reachable — after a failure that
    // text is itself an AI product; the original is the only thing you cannot
    // get back to, and taking the entry away at that moment buries it forever.
    expect(h.controller.restorableOriginal, '我说的原话');

    // A run that never succeeded does **not** create a restore entry (otherwise "restore" would point at itself).
    h.controller.dismissAiFailure();
    final _Harness h2 = _Harness();
    h2.connect();
    h2.controller.setBuffer('从未成功过');
    expect(h2.controller.startAiCompose(ComposeTask.draftPolish), isNull);
    h2.pushError('LLM_AUTH');
    await pumpEventQueue();
    expect(h2.controller.buffer, '从未成功过');
    expect(h2.controller.restorableOriginal, isNull);
    await h.dispose();
    await h2.dispose();
  });

  test('lifecycle: discard / empty ⇒ retract; ordinary edit ⇒ do not retract', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('我说的原话');
    await h.transform(ComposeTask.organize, '整理后的话');

    // Ordinary edits must not take it away — "tweak the AI result" is exactly the person this entry serves.
    h.controller.setBuffer('整理后的话，我又改了一个字');
    expect(h.controller.restorableOriginal, '我说的原话');

    // Empty the field ⇒ card retracts (composeEditHold is false); that draft is gone.
    h.controller.setBuffer('');
    expect(h.controller.restorableOriginal, isNull);

    // Discard takes a different path (discardBuffer → _clearBuffer); prove it separately.
    h.controller.setBuffer('第二段草稿');
    await h.transform(ComposeTask.draftPolish, '润色后的第二段');
    expect(h.controller.restorableOriginal, '第二段草稿');
    h.controller.discardBuffer();
    expect(h.controller.restorableOriginal, isNull);
    await h.dispose();
  });

  test('🔴 delivery succeeds ⇒ restore entry leaves (the original is now answered by the row, see T-7)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('我说的原话');
    await h.transform(ComposeTask.organize, '整理后的话');
    expect(h.controller.restorableOriginal, '我说的原话');

    await h.controller.sendBuffer();
    await pumpEventQueue();
    expect(
      h.transport.emittedWhere(FlowMicEvents.injectRequest),
      hasLength(1),
      reason: 'precondition: this delivery actually went on the wire (otherwise what follows is the failure path)',
    );
    expect(h.controller.restorableOriginal, isNull);
    await h.dispose();
  });

  // ── Widget layer: the button is really on the card, really tappable, and tapping really swaps the text ──────────────────────
  testWidgets('🔴 card 「恢复原文」: not on the tree before a transform, tappable after, tap swaps the text back and the entry disappears', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(360 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final _Harness h = _Harness();
    addTearDown(h.dispose);
    // The manual policy is half of `composeEditHold` — without loading it, the card never appears.
    await h.controller.loadSendPolicy();
    h.connect();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: h.controller)),
    );
    h.controller.setBuffer('我说的原话');
    await tester.pump();
    // Positive control: the card is there, the three pills are there, but the restore entry is not (there is no original to go back to yet).
    expect(find.byKey(const ValueKey<String>('compose.card')), findsOneWidget);
    expect(_restore, findsNothing, reason: 'drawing a 「恢复原文」 with no transform yet = an empty promise');

    // ⚠️ The widget layer deliberately does not use `_Harness.transform`: its
    // `pumpEventQueue()` never completes inside a `testWidgets` FakeAsync zone
    // (a scar this repo already has; edit_card_floating_test.dart says the same
    // thing at the end). Here `tester.pump()` flushes microtasks and walks the
    // same real path.
    expect(h.controller.startAiCompose(ComposeTask.organize), isNull);
    await tester.pump();
    h.pushDone('整理后的话');
    await tester.pump();
    expect(h.controller.buffer, '整理后的话', reason: 'precondition: the transform actually landed on the buffer');
    expect(_restore, findsOneWidget);

    await tester.tap(_restore);
    await tester.pump();
    // The criterion lands on **what the field rendered**, not controller state
    // (0.2.51 rule: a case that only tests the controller stays green after the
    // wiring is deleted).
    expect(
      tester.widget<TextField>(_field).controller!.text,
      '我说的原话',
      reason: '🔴 tapped 「恢复原文」 but the field text did not swap back ⇒ the button is a façade',
    );
    expect(_restore, findsNothing, reason: 'used once, then gone');
    expect(tester.takeException(), isNull);
    h.controller.session.debugStopIdlePresencePoll();
  });
}
