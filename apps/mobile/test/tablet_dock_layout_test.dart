// WP8 VF-8 — the tablet dock (mock frame A-TAB), measured.
//
// SOURCES:
//   docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html, frame
//     A-TAB「平板竖屏 · 闲时」:
//       `<div class="dock" style="flex-direction:row;gap:12px;
//                                 align-items:stretch;padding:12px 20px 16px">`
//       `  <div style="flex:1;max-width:430px;margin:0 auto;…gap:9px">`  ← speak
//       `  <div class="keys" style="flex-direction:column;width:92px;flex:none">`
//     and its caption: 「说话/输入列限宽居中落在双手拇指间；电脑键组独立成右列
//     （握持时右手边缘最易达），不再与说话条抢横排」.
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §2「Tablet
//     ≥560dp」 — REQUIRED this round; the owner reviews on the tablet.
//
// ── WHY THESE ASSERTIONS ARE MEASUREMENTS, NOT PARAMETER READS ───────────────
// Every number below comes off `tester.getRect`, never off a widget's fields. A
// `maxWidth: 430` that some ancestor overrides, or a `width: 92` inside a Row
// that has already run out of room, both read perfectly in the widget tree and
// are both wrong on screen. The owner's acceptance is a side-by-side against
// the board, so the criterion has to be where the boxes actually landed.
//
// ── REVERSE CONTROL (run, seen red, reverted) ───────────────────────────────
// Dropping the `maxWidth: kDockTabletSpeakMaxWidth` ConstrainedBox from
// `_dockTabletRouted` turns the 800dp case red at the CENTRING line:
//
//   Expected: a value greater than <0>
//     Actual: <0.0>
//      Which: is not a value greater than <0>
//   🔴 there is no slack at all ⇒ the speak column filled its Expanded, which
//   is what a missing 430 ceiling looks like
//
// — a speak column that fills its Expanded has no slack left to be centred in,
// so the ceiling and the centring are one fact measured two ways. Reverted;
// residual marker search after restore: `REVERSE-CONTROL-VF8` has 0 hits under
// `lib/` — the only occurrence in the repo is this sentence naming it.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart' show ControlKeyKind;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final Finder _dock = find.byKey(const ValueKey<String>('compose.dock'));
final Finder _group = find.byKey(const ValueKey<String>('compose.keys.group'));
final Finder _groupLabel =
    find.byKey(const ValueKey<String>('compose.keys.groupLabel'));
final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _bar = find.byKey(const ValueKey<String>('ptt.bar'));
final Finder _caption = find.byKey(const ValueKey<String>('ptt.caption'));
final Finder _policy = find.byKey(const ValueKey<String>('compose.policy'));

Finder _key(ControlKeyKind k) =>
    find.byKey(ValueKey<String>('compose.ctrl.${k.name}'));

Future<ChatController> _pumpPage(
  WidgetTester tester, {
  required double width,
  required double height,
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
    localPrefs: InMemoryLocalPrefs(),
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
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

/// The three structural facts that make a dock 「the tablet one」, asserted
/// together so a case cannot pass by accident on a layout that only got one of
/// them right.
void _expectTwoColumn(WidgetTester tester, {required double width}) {
  final Rect dock = tester.getRect(_dock);
  final Rect group = tester.getRect(_group);
  final Rect bar = tester.getRect(_bar);

  expect(dock.width, width, reason: 'the harness did not get the width it asked for');

  // ① `width:92px;flex:none`, hard against the dock's right padding edge.
  expect(
    group.width,
    kDockTabletKeyColumnWidth,
    reason: 'the key column is not 92dp — A-TAB pins it',
  );
  expect(
    group.right,
    closeTo(dock.right - 20, 0.5),
    reason: 'the key column is not against the dock\'s right padding edge '
        '(A-TAB: 「握持时右手边缘最易达」)',
  );

  // ② The speak key is BESIDE the keys, not above them: a full-band bar would
  //    satisfy every colour assertion in the suite and still be the phone dock.
  expect(
    bar.right,
    lessThanOrEqualTo(group.left),
    reason: 'the speak key overlaps the key column ⇒ they are not two columns',
  );
  expect(
    bar.width,
    lessThanOrEqualTo(kDockTabletSpeakMaxWidth),
    reason: 'the speak column blew past its 430dp ceiling',
  );

  // ③ The column really is a COLUMN of four keys — taller than the speak key
  //    beside it, not a squashed row that happens to sit on the right.
  //    ⚠️ Not an `align-items:stretch` assertion: that A-TAB value is the one
  //    this implementation does not take literally (see `_pcKeyColumn`'s note
  //    in compose_band.dart — `IntrinsicHeight` predicted the sibling's height
  //    2.0dp short and overflowed). Both columns size to their own content;
  //    this one is the taller, exactly as in the frame.
  expect(
    group.height,
    greaterThan(bar.height),
    reason: 'the key column is not taller than the speak key ⇒ the four keys '
        'did not stack',
  );
}

void main() {
  testWidgets('🔴 A-TAB @560dp: the idle dock is TWO columns — 92dp keys on the '
      'right, the speak column limited and centred beside them', (
    WidgetTester tester,
  ) async {
    final ChatController controller =
        await _pumpPage(tester, width: 560, height: 780);

    _expectTwoColumn(tester, width: 560);

    // The four keys STACK: same x band, strictly increasing y, and each one
    // still clears the 44dp ruler the phone group is held to.
    final Rect first = tester.getRect(_key(kComposeControlKeys.first));
    double previousBottom = -1;
    for (final ControlKeyKind k in kComposeControlKeys) {
      final Rect r = tester.getRect(_key(k));
      expect(r.left, closeTo(first.left, 0.5), reason: '${k.name} left drifted');
      expect(r.width, closeTo(first.width, 0.5), reason: '${k.name} width');
      expect(
        r.height,
        greaterThanOrEqualTo(kComposeTouchTarget),
        reason: '${k.name} fell under the 44dp ruler in the column',
      );
      expect(
        r.top,
        greaterThan(previousBottom),
        reason: '${k.name} is not below the key before it — the column is not '
            'stacked in `kComposeControlKeys` order',
      );
      previousBottom = r.bottom;
    }

    // The edge label moved to the TOP and turned horizontal
    // (`writing-mode:horizontal-tb`). Measured by SHAPE, because that is the
    // difference: the phone stacks two CJK glyphs (tall + narrow), the tablet
    // writes them across (wide + short).
    final Rect label = tester.getRect(_groupLabel);
    expect(
      label.width,
      greaterThan(label.height),
      reason: 'the 电脑 label is still stacked vertically in the key COLUMN',
    );
    expect(
      label.bottom,
      lessThanOrEqualTo(first.top),
      reason: 'the edge label is not above the first key',
    );

    // The speak column carries all four of its rows, in order.
    expect(_policy, findsOneWidget);
    expect(_preview, findsOneWidget);
    expect(tester.getRect(_policy).bottom, lessThanOrEqualTo(tester.getRect(_preview).top));
    expect(tester.getRect(_preview).bottom, lessThanOrEqualTo(tester.getRect(_bar).top));
    // 🔴 The caption STAYS on the tablet. A-TAB's frame elides it, but it is
    // state copy from the (unchanged) mechanics contract — 「松开即投递到电脑
    // 光标」 vs 「松开后只保存在手机」 — and a dock that answers "what happens
    // when I let go this time" only on phones is answering it wrong on tablets.
    expect(
      _caption,
      findsOneWidget,
      reason: '🔴 the tablet dock dropped the PTT caption',
    );
    expect(tester.getRect(_bar).bottom, lessThanOrEqualTo(tester.getRect(_caption).top));

    expect(tester.takeException(), isNull, reason: 'the tablet dock overflowed');
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 @559dp — one dp under the threshold is BYTE-FOR-BYTE the '
      'phone dock', (WidgetTester tester) async {
    // The breakpoint is only worth having if the other side of it is untouched.
    // 559 is chosen deliberately: an off-by-one in the comparison (`>` instead
    // of `>=`, or a stale constant) shows up here and nowhere else.
    final ChatController controller =
        await _pumpPage(tester, width: 559, height: 780);

    expect(
      find.byType(ComposeBand),
      findsOneWidget,
      reason: 'a second band appeared ⇒ the dock re-columned below 560dp',
    );

    final Rect group = tester.getRect(_group);
    final Rect preview = tester.getRect(_preview);
    final Rect bar = tester.getRect(_bar);

    // Stacked, not side by side.
    expect(
      group.top,
      greaterThanOrEqualTo(preview.bottom),
      reason: 'the key group left row 2\'s column',
    );
    expect(
      group.width,
      greaterThan(kDockTabletKeyColumnWidth),
      reason: 'the key group shrank to the tablet column width at 559dp',
    );
    // The bar spans the whole band, and the keys are under it — not beside.
    expect(bar.width, closeTo(group.width, 0.5));
    expect(bar.top, greaterThanOrEqualTo(group.bottom));

    // The edge label is back to its stacked-glyph shape.
    final Rect label = tester.getRect(_groupLabel);
    expect(
      label.height,
      greaterThan(label.width),
      reason: 'the phone dock lost the vertical 电脑 edge label',
    );

    expect(tester.takeException(), isNull);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 A-TAB @800×600 (landscape-ish): same structure, and the 430 '
      'ceiling actually bites — the speak column is CENTRED in the slack', (
    WidgetTester tester,
  ) async {
    // 🔴 THE REVERSE CONTROL LANDS HERE, and it needs this width rather than
    // 560: at 560 the Expanded is only 416dp wide, so the 430 ceiling is not
    // reached and there is no slack for centring to be visible in. A case that
    // could only ever be run at 560 would pass with the ConstrainedBox deleted.
    final ChatController controller =
        await _pumpPage(tester, width: 800, height: 600);

    final Rect dock = tester.getRect(_dock);
    final Rect group = tester.getRect(_group);
    final Rect bar = tester.getRect(_bar);

    // ⚠️ The CENTRING goes first, before the shared structural block below.
    // Order matters for a reason that is not style: `_expectTwoColumn` also
    // asserts the 430 ceiling, and `expect` aborts the case on the first
    // failure — so with it first, the reverse control (ceiling deleted) would
    // only ever show the ceiling line and this case's own subject would never
    // be exercised. Put the thing the case is NAMED for where it can fail.
    //
    // `margin:0 auto`: equal slack on both sides of the speak column. Expressed
    // as the two GAPS rather than as a centre coordinate, so it does not have
    // to restate the dock's padding or the column gap as numbers.
    final double leftSlack = bar.left - (dock.left + 20);
    final double rightSlack = (group.left - kDockTabletColumnGap) - bar.right;
    expect(
      leftSlack,
      greaterThan(0),
      reason: '🔴 there is no slack at all ⇒ the speak column filled its '
          'Expanded, which is what a missing 430 ceiling looks like',
    );
    expect(
      leftSlack,
      closeTo(rightSlack, 0.5),
      reason: '🔴 the speak column is not centred in the space beside the key '
          'column (left $leftSlack vs right $rightSlack)',
    );
    expect(
      bar.width,
      kDockTabletSpeakMaxWidth,
      reason: '🔴 `max-width:430px` is not holding — at 800dp the Expanded '
          'offers far more, so this is the width where the ceiling is the only '
          'thing deciding the answer',
    );

    _expectTwoColumn(tester, width: 800);

    expect(_caption, findsOneWidget);
    expect(tester.takeException(), isNull);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 scope fence: at tablet width, RECORDING still renders the '
      'phone dock (A3 "do only one main thing at a time")', (WidgetTester tester) async {
    // The card re-columns the IDLE arrangement only, and the reason is not
    // caution: during recording the whole band leaves the tree, so the right
    // column would be an empty 92dp gutter next to a speak key that the mock
    // draws full width. There is no A-TAB frame for any non-idle face.
    final ChatController controller =
        await _pumpPage(tester, width: 800, height: 600);
    controller.session.fsm.onPttDown();
    await tester.pump();
    expect(controller.isRecording, isTrue, reason: 'harness did not reach RECORDING');

    expect(
      _group,
      findsNothing,
      reason: '🔴 the key column survived into RECORDING — the tablet branch '
          'is not obeying composeIdleRowsVisible',
    );
    expect(_preview, findsNothing);

    final Rect dock = tester.getRect(_dock);
    final Rect bar = tester.getRect(_bar);
    expect(
      bar.width,
      closeTo(dock.width - 24, 0.5),
      reason: '🔴 the recording bar is not full-width — it is still sitting in '
          'a 430dp speak column with nothing beside it. (24 = the PHONE dock\'s '
          'horizontal padding, which is the other half of this assertion: the '
          'padding must fall back too.)',
    );

    expect(tester.takeException(), isNull);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 REQ-14-01: record-only at tablet width does NOT two-column — '
      'there is no key column to put on the right', (WidgetTester tester) async {
    final ChatController controller =
        await _pumpPage(tester, width: 800, height: 600);
    controller.destination.setRecordOnly();
    await tester.pump();

    expect(_group, findsNothing, reason: 'record-only still drew the PC key column');
    expect(_preview, findsOneWidget);

    final Rect dock = tester.getRect(_dock);
    final Rect bar = tester.getRect(_bar);
    expect(
      bar.width,
      closeTo(dock.width - 24, 0.5),
      reason: 'record-only still two-columned an empty key gutter. '
          '(24 = the phone dock\'s horizontal padding.)',
    );

    expect(tester.takeException(), isNull);
    controller.session.debugStopIdlePresencePoll();
  });
}
