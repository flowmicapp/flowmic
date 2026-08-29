// NR-4-P1 (c) acceptance — an external buffer move must not steal the caret.
//
// SPEC-REF: docs/strategy/2026-08-27-next-release-feature-and-optimization-
//   ledger.md §4 row c (「编辑中光标被抢」) + §4 P1 ②.
//
// THE MEASURED DEFECT: `_syncComposeTextRouted` rebuilt the field's value with
// `TextSelection.collapsed(offset: buffer.length)` for EVERY writer that was
// not the user's own echo. A new utterance folding in mid-edit, an AI result,
// 「restore original」 — each of them yanked the caret to the end of the box
// while the user was typing in the middle of it, and the next keystroke landed
// somewhere the user did not put it.
//
// 🔴 WHAT THIS FILE ASSERTS AND WHY IT IS THE SELECTION, NOT THE TEXT. Every
// pre-existing case in edit_sheet_test.dart passes on both implementations:
// they assert the field's TEXT, and the text was never wrong. The whole defect
// lives in one field of `TextEditingValue` that nothing was looking at.
//
// 🔴 ALL CASES RUN ON THE REAL ChatFlowPage + REAL ChatController (0.2.51 law).
//
// ── REVERSE CONTROL (ACTUALLY run red on 2026-08-27, then reverted; residual
//    grep 0, file re-greened) ──────────────────────────────────────────────────
// The focus/append guard in `_syncComposeTextRouted` removed, i.e. back to an
// unconditional collapse-to-end:
//   「a fold while the user is mid-edit leaves the caret exactly where it was」
//     Expected: <2>   Actual: <11>     (caret teleported past the fold)
//   「a fold does not collapse a live SELECTION either」
//     Expected: <2>   Actual: <11>     (range collapsed to the end)
//   → 2 red / 3 green. The two 「caret goes to the end」 cases stay green on
//     BOTH implementations, and that is why they are kept here rather than
//     dropped as redundant: they pin the half of the behaviour this card
//     deliberately did NOT change, so a later 「preserve the caret everywhere」
//     patch goes red instead of shipping an invented caret position.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final Finder _field = find.byKey(const ValueKey<String>('compose.field'));
final Finder _previewTap =
    find.byKey(const ValueKey<String>('compose.preview.tap'));

TextEditingController _fieldController(WidgetTester tester) =>
    tester.widget<TextField>(_field).controller!;

Future<ChatController> _pumpPage(WidgetTester tester) async {
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
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
  );
  addTearDown(() async {
    controller.session.debugStopIdlePresencePoll();
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
  return controller;
}

/// Open the sheet the ONE way that focuses (trigger (b)), then put the caret
/// where a user editing in the middle of a draft would have it.
///
/// The selection is written straight onto the field's own controller rather
/// than simulated with taps: `tester.tap` inside a TextField resolves to a
/// character offset through the text layout, which under the Ahem test font
/// answers a question about glyph widths instead of about this card.
Future<void> _openFocusedWithCaretAt(WidgetTester tester, int offset) async {
  await tester.tap(_previewTap);
  await tester.pump();
  await tester.pump();
  final TextEditingController c = _fieldController(tester);
  expect(
    tester.widget<TextField>(_field).focusNode?.hasFocus,
    isTrue,
    reason: 'harness precondition: the guard under test is focus-gated',
  );
  c.selection = TextSelection.collapsed(offset: offset);
  await tester.pump();
}

void main() {
  testWidgets(
      '🔴 a fold while the user is mid-edit leaves the caret exactly where it '
      'was', (WidgetTester tester) async {
    final ChatController controller = await _pumpPage(tester);
    controller.setBuffer('开会时间');
    await tester.pump();
    // Caret between 「开会」 and 「时间」 — the user is fixing a word in the
    // middle, which is the only place this defect can be seen at all.
    await _openFocusedWithCaretAt(tester, 2);

    // A new utterance folds in. `_foldIntoBuffer`'s real shape: always
    // appended, single space (NR-4-P1 (h)).
    controller.setBuffer('开会时间 改到下午三点');
    await tester.pump();

    final TextEditingController f = _fieldController(tester);
    expect(f.text, '开会时间 改到下午三点', reason: 'the fold must still land');
    expect(
      f.selection.baseOffset,
      2,
      reason: '🔴 the caret was dragged to the end of the box while the user '
          'was typing in the middle of it — the next keystroke lands in the '
          'wrong word and nothing on screen says why (ledger §4 row c)',
    );
    expect(f.selection.extentOffset, 2);
  });

  testWidgets('🔴 a fold does not collapse a live SELECTION either', (
    WidgetTester tester,
  ) async {
    // A collapsed caret and a range are two different losses: the range is a
    // word the user was about to replace. Preserving the offset but dropping
    // the range would pass the case above and still destroy the edit.
    final ChatController controller = await _pumpPage(tester);
    controller.setBuffer('开会时间');
    await tester.pump();
    await tester.tap(_previewTap);
    await tester.pump();
    await tester.pump();
    _fieldController(tester).selection =
        const TextSelection(baseOffset: 0, extentOffset: 2);
    await tester.pump();

    controller.setBuffer('开会时间 改到下午三点');
    await tester.pump();

    final TextSelection s = _fieldController(tester).selection;
    expect(s.baseOffset, 0);
    expect(
      s.extentOffset,
      2,
      reason: '🔴 the user had two characters selected and the fold threw the '
          'selection away',
    );
  });

  testWidgets(
      'a WHOLESALE replacement (AI result / restore-original) still puts the '
      'caret at the end — there is no anchor to keep', (
    WidgetTester tester,
  ) async {
    // 🔴 THE HALF THIS CARD DELIBERATELY DID NOT CHANGE. Offset k in the old
    // string has no successor in a rewritten one, so 「preserving」 it would be
    // a position invented by us and handed to the user as their own.
    final ChatController controller = await _pumpPage(tester);
    controller.setBuffer('开会时间');
    await tester.pump();
    await _openFocusedWithCaretAt(tester, 2);

    controller.setBuffer('The meeting has been moved to 3pm.');
    await tester.pump();

    final TextEditingController f = _fieldController(tester);
    expect(f.text, 'The meeting has been moved to 3pm.');
    expect(
      f.selection.baseOffset,
      'The meeting has been moved to 3pm.'.length,
      reason: 'a replaced text has no stable caret anchor — end of text is the '
          'only honest resting place',
    );
  });

  testWidgets('with NO focus, an append still collapses to the end', (
    WidgetTester tester,
  ) async {
    // The auto-open path (D4: a sheet that opens by itself must not raise the
    // keyboard) lands here every single time, so this is the COMMON case, not
    // an edge one. No focus ⇒ no caret to protect ⇒ end of text is where the
    // next tap wants to start.
    final ChatController controller = await _pumpPage(tester);
    controller.setBuffer('第一句');
    await tester.pump();
    expect(
      tester.widget<TextField>(_field).focusNode?.hasFocus,
      isFalse,
      reason: 'harness precondition: D4 auto-open does not focus',
    );
    _fieldController(tester).selection =
        const TextSelection.collapsed(offset: 1);
    await tester.pump();

    controller.setBuffer('第一句 第二句');
    await tester.pump();

    expect(
      _fieldController(tester).selection.baseOffset,
      '第一句 第二句'.length,
    );
  });

  testWidgets('a -1 selection cannot reach the guard from this surface, and '
      'the fold still lands without throwing', (WidgetTester tester) async {
    // 🔴 THIS CASE IS NOT WHAT IT WAS FIRST WRITTEN AS, and the correction is
    // the point. It was 「an out-of-range selection falls back to the end」,
    // driving the fresh-controller default `TextSelection(-1, -1)` in and
    // expecting the collapse-to-end arm. It failed —
    //     Expected: <11>   Actual: <4>
    // — because a FOCUSED editable NORMALISES its selection: by the time the
    // controller notification arrives, -1/-1 has already become a valid
    // collapsed offset at the end of the old text (4), the guard takes the
    // preserve arm, and 4 is still in range of the longer string. The
    // assertion was measuring the framework, not the branch it named.
    //
    // ⇒ WHAT IS TRUE, WRITTEN DOWN INSTEAD OF ASSERTED FALSELY: the
    // `isValid` / range half of the guard in `_syncComposeTextRouted` is
    // DEFENSIVE and is not reachable through the real page. It stays because
    // its premise (`current.text` is a prefix of `buffer`) is a fact about
    // another expression, and a future writer can break that without touching
    // this line. What this case can honestly pin is the outcome: the fold
    // lands, nothing throws, and the caret is somewhere in range.
    final ChatController controller = await _pumpPage(tester);
    controller.setBuffer('开会时间');
    await tester.pump();
    await tester.tap(_previewTap);
    await tester.pump();
    await tester.pump();
    _fieldController(tester).selection =
        const TextSelection(baseOffset: -1, extentOffset: -1);
    await tester.pump();

    controller.setBuffer('开会时间 改到下午三点');
    await tester.pump();

    expect(tester.takeException(), isNull);
    final TextEditingController f = _fieldController(tester);
    expect(f.text, '开会时间 改到下午三点');
    expect(f.selection.baseOffset, inInclusiveRange(0, f.text.length));
  });
}
