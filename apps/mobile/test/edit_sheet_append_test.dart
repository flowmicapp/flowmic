// PA-5 acceptance — the in-sheet hold-to-append (Plan A′ contract §2 SUP-5's
// A7 row, §5-1 append button, PA-5 accept list, mock ⑥/⑦).
//
// 🔴 The append MUST be the SAME gesture chain as the main PTT bar — one
// acceptance edge (`_pttDownRouted` with the fold pin), one FSM, one cancel
// path. The 「one gesture chain」 assertions below are the ones the required
// reverse control turns red (route the button around pttDown ⇒ the FSM never
// records while the sheet claims A7).
//
// ── Reverse control (run red, then reverted — quoted in the WP7 report) ─────
// Replacing the button's onDown closure with one that sets the A7 flag
// without calling `_pttDownRouted` turns the first case red:
//   Expected: true
//     Actual: <false>
//   🔴 append 按下去而 FSM 没在录 —— 出现了第二条录音入口
//
// ⚠️ PTT driving discipline (the scars expanded_compose_test.dart documented,
// inherited verbatim): the button's PRODUCTION onDown is invoked directly
// (`unawaited(btn.onDown())`) — a real accepted long-press drags the async
// chain into FakeAsync and deadlocks; teardown is SYNCHRONOUS because a live
// capture makes the dispose awaits unresolvable.

import 'dart:async';

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
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/recording_panel.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/locale_terms.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));
final Finder _header = find.byKey(const ValueKey<String>('compose.card.header'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));
final Finder _live = find.byKey(const ValueKey<String>('compose.sheet.live'));
final Finder _deliver =
    find.byKey(const ValueKey<String>('compose.card.deliver'));
final Finder _appendLabel =
    find.byKey(const ValueKey<String>('compose.sheet.append.label'));

class _Page {
  _Page(this.transport, this.controller);
  final FakeSocketTransport transport;
  final ChatController controller;

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
}

Future<_Page> _pumpPage(
  WidgetTester tester, {
  SendPolicy policy = SendPolicy.direct,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
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
    localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
  );
  // 🔴 SYNCHRONOUS teardown — a live capture makes the awaits inside
  // dispose() unresolvable in FakeAsync (speaking_face_test.dart, the
  // liveCapture doc of the deleted expanded_compose_test.dart).
  addTearDown(() {
    unawaited(controller.dispose());
    controller.destination.dispose();
    controller.store.dispose();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return _Page(transport, controller);
}

/// Open the sheet by preview tap and type a starting draft.
Future<void> _openAndType(WidgetTester tester, String draft) async {
  await tester.tap(find.byKey(const ValueKey<String>('compose.preview.tap')));
  await tester.pump();
  await tester.pump();
  await tester.enterText(_field, draft);
  await tester.pump();
}

/// The production accepted-edge, driven directly (see file header).
Future<void> _pressAppend(WidgetTester tester) async {
  final SheetAppendButton btn =
      tester.widget<SheetAppendButton>(find.byType(SheetAppendButton));
  unawaited(btn.onDown());
  await tester.pump();
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('🔴 one gesture chain + fold pin: an append under DIRECT policy '
      'records through the REAL FSM and folds into the draft — nothing is '
      'delivered', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    await _openAndType(tester, '打好的前半段');
    expect(_sheet, findsOneWidget);
    expect(tester.widget<Text>(_appendLabel).data, _zh.appendHold);

    await _pressAppend(tester);

    // 🔴 The 「one gesture chain」 assertion — the reverse control's target:
    // the button went through the SAME acceptance edge, so the REAL FSM is
    // recording. A second entry point (own recorder, own flag) leaves the
    // FSM idle while the sheet claims A7.
    expect(
      p.controller.isRecording,
      isTrue,
      reason: '🔴 append 按下去而 FSM 没在录 —— 出现了第二条录音入口',
    );
    // The fold pin: this utterance's snapshot is manual even though the
    // page's policy is direct — release must fold, not deliver.
    expect(p.controller.activeSendPolicy, SendPolicy.manual);
    expect(p.controller.sendPolicy, SendPolicy.direct,
        reason: 'positive control: what is pinned is the snapshot, not the user\'s policy setting');

    // A7 faces: sheet stays, appending header, release wording, in-sheet
    // strip (descendant-scoped: the covered dock renders its own strip too).
    expect(_sheet, findsOneWidget, reason: 'A7: the edit face must not collapse while appending');
    expect(tester.widget<Text>(_header).data, _zh.composeSheetHeaderAppending);
    expect(tester.widget<Text>(_appendLabel).data, _zh.appendRelease);
    expect(
      find.descendant(of: _sheet, matching: find.byType(RecordingPanel)),
      findsOneWidget,
      reason: 'A7: the in-sheet amplitude/timer strip must be present (reuse PA-3\'s same constructor)',
    );
    // The collapse control is gone for the hold's duration.
    expect(
      find.byKey(const ValueKey<String>('compose.sheet.collapse')),
      findsNothing,
    );

    // Footer inert while appending: a deliver tap moves nothing.
    await tester.tap(_deliver, warnIfMissed: false);
    await tester.pump();
    expect(p.injects, isEmpty, reason: 'A7: the footer must be inert while appending (mock ⑦ de-ranked)');

    // Live words land in the sheet's highlight view — the SECOND named
    // liveText render site.
    p.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': '正在说的新句',
      'confidence': 0.6,
      'language': 'zh',
      'segment_idx': 0,
    });
    await tester.pump();
    await tester.pump();
    expect(_live, findsOneWidget);
    expect(_field, findsNothing, reason: 'while appending, the body is a read-only draft+live view');
    final Text rich = tester.widget<Text>(
      find.descendant(of: _live, matching: find.byType(Text)),
    );
    final String plain = rich.textSpan!.toPlainText();
    expect(plain, contains('打好的前半段'));
    expect(
      plain,
      contains('正在说的新句'),
      reason: '🔴 live words did not appear in the edit face — while appending, '
          'the timeline\'s live-draft row is behind the scrim and the user sees nothing',
    );

    // Release → the terminal final folds into the SAME draft, space-joined.
    // ⚠️ Two-step release, both halves measured in THIS file's first runs:
    // `session.pttUp()`'s SYNCHRONOUS prelude stops the wire heartbeat (its
    // periodic timer otherwise trips the binding's pending-timer check at
    // teardown), but its `await audio.stop()` never settles inside FakeAsync
    // — the FSM sat in RECORDING through a 2s pump — so the fsm edge is
    // driven directly (recording_panel_widget_test.dart's established FSM
    // walk; a late duplicate onPttUp is guarded — state_machine.dart:291).
    // The one-gesture-chain guarantee is already proven at the DOWN edge.
    unawaited(p.controller.session.pttUp());
    await tester.pump();
    p.controller.session.fsm.onPttUp();
    await tester.pump();
    await tester.pump();
    p.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '追加的整句',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));

    expect(
      p.controller.buffer,
      '打好的前半段 追加的整句',
      reason: '🔴 the append did not fold into the same draft (FB-8 §3-3 space-join append semantics)',
    );
    expect(p.injects, isEmpty, reason: '🔴 under direct policy the append was delivered immediately — '
        'the fold pin did not take, and the user\'s 「append」 became 「send it」');
    // The A7 face has ended: field back, editable, append button at rest.
    expect(_field, findsOneWidget);
    expect(_live, findsNothing);
    expect(tester.widget<Text>(_appendLabel).data, _zh.appendHold);
    expect(p.controller.isRecording, isFalse);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 cancel is append-scoped: a swipe-up discard leaves the '
      'pre-append draft byte-identical', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    await _openAndType(tester, '不能被取消动到的草稿');
    await _pressAppend(tester);
    expect(p.controller.isRecording, isTrue, reason: 'precondition: this press was accepted');

    p.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': '说了一半不要了',
      'confidence': 0.5,
      'language': 'zh',
      'segment_idx': 0,
    });
    await tester.pump();

    unawaited(p.controller.pttCancel());
    await tester.pump();
    await tester.pump();

    expect(p.controller.isRecording, isFalse, reason: 'cancel did not return the FSM to idle');
    expect(
      p.controller.buffer,
      '不能被取消动到的草稿',
      reason: '🔴 cancel must drop only the appended segment, never the pre-append draft',
    );
    expect(_sheet, findsOneWidget, reason: 'after cancel the edit face is still up (the draft is still waiting)');
    expect(_field, findsOneWidget);
    expect(tester.widget<Text>(_appendLabel).data, _zh.appendHold);
    p.controller.session.debugStopIdlePresencePoll();
  });

  // ── PA-6: the append copy is rendered, four locales ───────────────────────
  for (final AppLocale locale in AppLocale.values) {
    testWidgets('🔴 PA-6 ${locale.name}: appendHold/appendRelease render '
        'un-clipped at the measuring width', (WidgetTester tester) async {
      final AppStrings s = AppStrings.of(locale);
      for (final String copy in <String>[s.appendHold, s.appendRelease]) {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 640,
                child: Text(
                  copy,
                  key: const ValueKey<String>('append.copy'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5),
                ),
              ),
            ),
          ),
        );
        expect(
          tester
              .renderObject<RenderParagraph>(
                find.byKey(const ValueKey<String>('append.copy')),
              )
              .didExceedMaxLines,
          isFalse,
          reason: '${locale.name}:「$copy」was clipped at the measuring width',
        );
      }
    });
  }

  test('🔴 PA-6: append copy is a DISTINCT translation per locale', () {
    // Nine-locale expansion (2026-08-14): `hasLength(4)` replaced by a named
    // criterion — see the comment on `expectPerLocaleDistinct` in
    // `support/locale_terms.dart`.
    expectPerLocaleDistinct(
      (AppStrings s) => s.appendHold,
      what: 'appendHold',
      // Simplified/Traditional same shape: the four characters 「按住 追加」 are
      // written the same in both glyph sets ([measured]; 43 such collisions
      // across the whole zh/zhTw table). Named, not relaxed.
      mayShare: const <Set<AppLocale>>[<AppLocale>{AppLocale.zh, AppLocale.zhTw}],
    );
    expectPerLocaleDistinct(
      (AppStrings s) => s.appendRelease,
      what: 'appendRelease',
    );
    expectPerLocaleDistinct(
      (AppStrings s) => s.composeSheetHeaderTyped,
      what: 'composeSheetHeaderTyped',
    );
    expectPerLocaleDistinct(
      (AppStrings s) => s.composeSheetHeaderAppending,
      what: 'composeSheetHeaderAppending',
    );
  });

  testWidgets('keyboard dismiss during append hold does not drop the button',
      (WidgetTester tester) async {
    // Open the sheet with the field focused, raise the IME inset, then put a
    // finger on 「按住 追加」. The lock must keep the button's Y stable when the
    // inset collapses — otherwise the finger is no longer on the control.
    final _Page p = await _pumpPage(tester);
    await _openAndType(tester, '键盘上的草稿');
    tester.view.viewInsets = FakeViewPadding(
      bottom: 280 * tester.view.devicePixelRatio,
    );
    await tester.pump();

    final Finder btn = find.byKey(
      const ValueKey<String>('compose.sheet.appendBtn'),
    );
    final double yBefore = tester.getTopLeft(btn).dy;

    final TestGesture g = await tester.startGesture(tester.getCenter(btn));
    await tester.pump();
    tester.view.viewInsets = FakeViewPadding.zero;
    await tester.pump();

    final double yAfter = tester.getTopLeft(btn).dy;
    expect(
      (yAfter - yBefore).abs(),
      lessThan(24),
      reason: 'append button jumped ${yAfter - yBefore}dp when the keyboard '
          'dismissed — the finger is no longer on the control',
    );
    await g.up();
    await tester.pump();
    p.controller.session.debugStopIdlePresencePoll();
  });
}
