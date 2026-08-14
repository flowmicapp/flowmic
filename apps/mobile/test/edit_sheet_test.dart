// PA-4 acceptance — the ONE edit surface: the bottom sheet (Plan A′ contract
// §2 SUP-5/SUP-6/SUP-7, §4 A2/A6, §5-1/§5-2, PA-4 accept list).
//
// This file replaces edit_card_floating_test.dart, edit_card_fullscreen_test
// .dart and expanded_compose_test.dart (all deleted with the surfaces they
// pinned). Every guarantee of theirs that SURVIVES the design is re-pinned
// here on the sheet: same controller (text + caret + external moves), D4's
// split (auto-open never focuses / tap-open focuses in one step), close
// gestures, the height ratios, the geometry inverse (the sheet now COVERS the
// PTT bar — the exact opposite of the card-era assertion, by design), and the
// AI trio's placement. fb8_confirm_card_test.dart keeps the delivery/discard
// semantics on the same keys.
//
// ── Reverse control (run red, then reverted — quoted in the WP7 report) ─────
// Making `_collapseSheetRouted` clear the buffer turns the collapse round-trip
// case red:
//   Expected: '收起前写好的草稿'
//     Actual: ''
//
// 🔴 All widget cases run on the REAL ChatFlowPage + REAL ChatController
// (0.2.51 law). The PTT-chain caveats of the deleted files apply unchanged.

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
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/ai_action_row.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));
final Finder _header = find.byKey(const ValueKey<String>('compose.card.header'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));
final Finder _scrim = find.byKey(const ValueKey<String>('compose.sheet.scrim'));
final Finder _collapse =
    find.byKey(const ValueKey<String>('compose.sheet.collapse'));
final Finder _deliver =
    find.byKey(const ValueKey<String>('compose.card.deliver'));
final Finder _discard =
    find.byKey(const ValueKey<String>('compose.card.discard'));
final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _previewTap =
    find.byKey(const ValueKey<String>('compose.preview.tap'));
final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));
final Finder _plus = find.byKey(const ValueKey<String>('compose.plus'));
final Finder _keysGroup =
    find.byKey(const ValueKey<String>('compose.keys.group'));

Finder _aiPill(ComposeTask t) =>
    find.byKey(ValueKey<String>('ai.task.${t.wire}'));

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
  double width = 360,
  double height = 780,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
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

/// The preview tap plus the frame the post-frame focus lands on.
Future<void> _openFromPreview(WidgetTester tester) async {
  await tester.tap(_previewTap);
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('🔴 SUP-5 (a): a manual finalize AUTO-OPENS the sheet — voice '
      'header, NO keyboard (D4) — and the sheet COVERS dock and PTT (A6, the '
      'inverse of the card-era assertion)', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    expect(_sheet, findsNothing);
    final Rect pttBefore = tester.getRect(find.byType(PttBar));

    // The finalize's observable half: the buffer grows while the sheet is
    // closed, under manual (the sheet header's argument for why this edge IS
    // the finalize).
    p.controller.setBuffer('刚刚说的一句话');
    await tester.pump();

    expect(_sheet, findsOneWidget);
    expect(
      tester.widget<Text>(_header).data,
      _zh.composeCardHeader,
      reason: 'a voice-originated draft must wear the 「已转录」 header (§5-2)',
    );
    expect(
      tester.testTextInput.isVisible,
      isFalse,
      reason: '🔴 auto-open raised the keyboard — D4: only an explicit tap focuses',
    );

    // A6 — the sheet covers the PTT bar: the bar is still on the tree
    // underneath, and the sheet's rect contains it.
    final Rect sheet = tester.getRect(_sheet);
    final Rect ptt = tester.getRect(find.byType(PttBar));
    expect(ptt, pttBefore, reason: 'covered ≠ pushed away: PttBar\'s own box does not move');
    expect(sheet.bottom, greaterThanOrEqualTo(ptt.bottom - 0.5));
    expect(
      sheet.top,
      lessThan(ptt.top),
      reason: '🔴 the sheet did not cover PTT — A6\'s whole point '
          '(the speak key exits while editing) did not happen',
    );
    // …and the scrim above the dock is what makes the covered PTT unreachable.
    expect(_scrim, findsOneWidget);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 SUP-5 (b): preview tap opens WITH focus in one step, and an '
      'empty open wears the TYPED header (mock ⑫)', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester, policy: SendPolicy.direct);
    expect(_sheet, findsNothing);

    await _openFromPreview(tester);
    expect(_sheet, findsOneWidget);
    expect(
      tester.widget<Text>(_header).data,
      _zh.composeSheetHeaderTyped,
      reason: 'an empty sheet is a typing start, it must not call itself 「已转录」',
    );
    final TextField f = tester.widget<TextField>(_field);
    expect(
      f.focusNode?.hasFocus,
      isTrue,
      reason: '🔴 opened but not focused ⇒ Q3㋐\'s "one step" was made into two',
    );
    expect(tester.testTextInput.isVisible, isTrue);
    expect(f.autofocus, isFalse, reason: 'D4: focus comes from this tap, not autofocus');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 same controller: typing lands in the buffer, the caret '
      'stays put, and an EXTERNAL move lands back in the field', (
    WidgetTester tester,
  ) async {
    // The two reverse-control shapes the deleted expanded_compose_test
    // documented (a per-build controller kills the caret; a second live one
    // kills the external move) both stay covered by this pair of assertions.
    final _Page p = await _pumpPage(tester, policy: SendPolicy.direct);
    p.controller.setBuffer('点开前就有的草稿');
    await tester.pump();
    await _openFromPreview(tester);
    expect(tester.widget<TextField>(_field).controller!.text, '点开前就有的草稿');

    await tester.enterText(_field, '我在编辑面里改过了');
    await tester.pump();
    expect(p.controller.buffer, '我在编辑面里改过了');
    expect(
      tester.widget<TextField>(_field).controller!.selection.baseOffset,
      '我在编辑面里改过了'.length,
      reason: '🔴 the caret is not where the user just finished typing ⇒ '
          'this surface swaps the controller on every rebuild',
    );

    p.controller.setBuffer('AI 整理之后的结果');
    await tester.pump();
    expect(
      tester.widget<TextField>(_field).controller!.text,
      'AI 整理之后的结果',
      reason: '🔴 the outside changed the buffer but the surface still shows '
          'the old text ⇒ there is a second TextEditingController',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 collapse round-trip: 收起 keeps the buffer byte-identical, '
      'the preview shows it, and re-tapping reopens the SAME text', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('收起前写好的草稿');
    await tester.pump();
    expect(_sheet, findsOneWidget);
    // No ✕ anywhere in the sheet: the collapse control is a chevron/「收起」,
    // and the only discard is the footer button (SUP-1's mis-touch argument).
    expect(
      find.descendant(of: _sheet, matching: find.byIcon(Icons.close)),
      findsNothing,
      reason: '🔴 an ✕ appeared on the edit surface — the '
          '"looks like the same name, opposite consequence" debt went from two parties to three',
    );

    await tester.tap(_collapse);
    await tester.pump();
    expect(_sheet, findsNothing);
    expect(
      p.controller.buffer,
      '收起前写好的草稿',
      reason: '🔴 collapse took the draft with it ⇒ it became a third ✕ '
          '(SUP-5: collapse NEVER touches the buffer)',
    );
    // A2: the collapsed state is the FULL idle dock with the draft in the
    // preview — where SUP-1's key access lives.
    expect(_preview, findsOneWidget);
    expect(find.textContaining('收起前写好的草稿'), findsOneWidget);
    expect(_keysGroup, findsOneWidget, reason: 'SUP-1: the keys are one collapse away');
    expect(_policy, findsOneWidget, reason: 'SUP-6: the chip is one collapse away');
    expect(_plus, findsOneWidget);

    await _openFromPreview(tester);
    expect(_sheet, findsOneWidget);
    expect(
      tester.widget<TextField>(_field).controller!.text,
      '收起前写好的草稿',
      reason: '🔴 the reopened text is not the one from before collapse ⇒ '
          'the round-trip lost the content',
    );
    // The draft came from a voice finalize; the reopened sheet keeps that
    // provenance (§5-2 — a collapse is not a re-authoring).
    expect(tester.widget<Text>(_header).data, _zh.composeCardHeader);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 close gestures: scrim tap and system back both collapse '
      'WITHOUT touching the buffer, and back does NOT leave the page', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('点外面也不许丢');
    await tester.pump();
    expect(_sheet, findsOneWidget);

    // Scrim tap — aim at the timeline area far above the sheet.
    await tester.tapAt(tester.getRect(_scrim).topCenter.translate(0, 30));
    await tester.pump();
    expect(_sheet, findsNothing);
    expect(p.controller.buffer, '点外面也不许丢');

    // Reopen, then system back: the sheet is a modal overlay — it collapses FIRST,
    // before the page's own back sequence.
    await _openFromPreview(tester);
    expect(_sheet, findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(_sheet, findsNothing, reason: 'the back key did not collapse the edit surface first');
    expect(
      find.byType(ChatFlowPage),
      findsOneWidget,
      reason: '🔴 the back key popped the whole page / the whole App — '
          'the edit surface was not inserted into the existing sequence',
    );
    expect(p.controller.buffer, '点外面也不许丢');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('mode switch closes the sheet (the red line already cleared '
      'the buffer, and a sheet over a foreign mode edits nothing)', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('切模式会清掉的');
    await tester.pump();
    expect(_sheet, findsOneWidget);

    p.controller.setMode(FlowMode.organize);
    await tester.pump();
    expect(_sheet, findsNothing, reason: 'mode switch is one of the close gestures the contract names');
    expect(p.controller.buffer, isEmpty, reason: '08 §2 red line: switching mode clears the buffer');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 SUP-7: pills for a TYPED draft under DIRECT policy, and no '
      'dead pills on an empty sheet', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester, policy: SendPolicy.direct);
    await _openFromPreview(tester);
    // Empty sheet: no pills at all (ai-pills §3: no greyed dead controls).
    for (final ComposeTask t in kAiComposeTasks) {
      expect(_aiPill(t), findsNothing, reason: 'dead pills hanging on an empty draft');
    }

    await tester.enterText(_field, 'a typed draft under direct');
    await tester.pump();
    for (final ComposeTask t in kAiComposeTasks) {
      expect(
        find.descendant(of: _sheet, matching: _aiPill(t)),
        findsOneWidget,
        reason: '🔴 SUP-7: a typed draft under direct is a stable buffer, '
            'the three pills should be present (${t.wire})',
      );
    }
    // The standing caption is printed (labelled) or carried by the caption
    // line (compact) — either way the sentence exists in the sheet.
    expect(
      find.descendant(of: _sheet, matching: find.textContaining('作用于缓冲')),
      findsOneWidget,
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 SUP-6: `+` and the policy chip are NOT in the sheet — and '
      'ARE one collapse away', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('进编辑面');
    await tester.pump();
    expect(_sheet, findsOneWidget);
    expect(
      find.descendant(of: _sheet, matching: _plus),
      findsNothing,
      reason: 'SUP-6: `+` is not inside the edit surface',
    );
    expect(
      find.descendant(of: _sheet, matching: _policy),
      findsNothing,
      reason: 'SUP-6: the policy chip is not inside the edit surface',
    );

    await tester.tap(_collapse);
    await tester.pump();
    expect(_plus, findsOneWidget, reason: 'one collapse later `+` is in the idle dock');
    expect(_policy, findsOneWidget);
    expect(p.controller.buffer, '进编辑面');
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('deliver: exactly ONE inject:request frame, and the sheet '
      'closes; discard: local only, zero control:key frames', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('要投递的内容');
    await tester.pump();
    expect(p.injects, isEmpty);

    await tester.tap(_deliver);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(p.injects, hasLength(1), reason: '🔴 the footer deliver did not send anything out');
    expect(_sheet, findsNothing, reason: 'after deliver the edit surface should collapse');
    // The real delivery arms the RCA-v3 20s watch + the outbox 45s watchdog.
    await tester.pump(const Duration(seconds: 46));

    p.controller.setBuffer('不要了的草稿');
    await tester.pump();
    expect(_sheet, findsOneWidget);
    await tester.tap(_discard);
    await tester.pump();
    expect(p.controller.buffer, isEmpty);
    expect(_sheet, findsNothing);
    expect(
      p.controlKeys,
      isEmpty,
      reason: '🔴 [丢弃] sent a control:key on the wire — discard ≠ clear-screen',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 height ratios (PA-4 accept): a long draft fills ≥75% of the '
      'page, a one-line draft stays under 40%', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    final Size page = tester.getSize(find.byType(ChatFlowPage));

    p.controller.setBuffer('一行字');
    await tester.pump();
    final Rect short = tester.getRect(_sheet);
    expect(
      short.height,
      lessThan(0.4 * page.height),
      reason: '🔴 a one-line draft forced the surface large — '
          '"take as much of the screen as possible" is a ceiling matter, not a floor matter',
    );

    // ×50 ≈ 1000+ chars: enough that the FIELD is the binding constraint and
    // the sheet is pushed to its §5-1 ceiling (a shorter draft leaves the
    // sheet honestly content-sized below it — measured, 20× stopped at 135).
    p.controller.setBuffer('这是一段很长的草稿内容需要占据尽量多的屏幕' * 50);
    await tester.pump();
    final Rect long = tester.getRect(_sheet);
    expect(
      long.height,
      greaterThanOrEqualTo(0.75 * page.height),
      reason: '🔴 a long draft\'s edit surface did not take 3/4 of the page height '
          '(contract PA-4 accept)',
    );
    // The ceiling is the §5-1 top inset, not some line count.
    expect(long.top, greaterThanOrEqualTo(96 - 0.5));
    expect(long.top, lessThanOrEqualTo(96 + 0.5));
    p.controller.session.debugStopIdlePresencePoll();
  });
}
