// 🔴 Card F3 (0.3.0) — the two USER-VISIBLE SENTENCES this card changed, asserted
// on the RENDERED RESULT.
//
// The card's criterion: 「any acceptance of 「can the user read this sentence」
// must assert on the rendered result (intrinsic width vs actual box,
// didExceedMaxLines), never on Text.data」. The rule and
// the measurement technique come from `inject_verdict_note_test.dart` (card M6-1),
// where a status line that was CORRECT read as 「INJ…」 on a real tablet.
//
// The two sentences:
//   ① `entryReprocessSub` — REWORDED by this card. It used to describe a local
//      rewrite; it now promises 「结果作为新的一条发到电脑」, which is the whole
//      product change and is the longest string in that sheet in every language.
//      A promise the user reads only half of is worse than the old short one.
//   ② `reprocessBusy` — NEW by this card (defect ①). It exists because 「这条重跑不了」
//      and 「等上一次跑完」 send the user to different actions; if it renders
//      truncated, the distinction it was created to make is gone again.
//
// 🔴 WHAT THE TWO SLOTS CAN ACTUALLY FAIL AS IS NOT THE SAME, AND THIS FILE SAYS
// SO RATHER THAN COPYING M6-1's ASSERTION SHAPE ONTO BOTH:
//   · the menu row's sub-line (`entry_context_menu.dart` `_row`) carries NO
//     `maxLines`, so `didExceedMaxLines` there is VACUOUSLY false and asserting
//     it alone would be a new façade — an assertion that looks like proof and is
//     not. Its real failure mode is the one that file's own comment records: the
//     English string 「overflow[s] by ~103 px on a 580 px sheet」 when the `Flexible`
//     is gone, which `flutter_test` reports as a RenderFlex overflow and fails
//     the test on. ⇒ what is asserted here is that the sentence WRAPPED (its box
//     really is more than one line tall for the languages that need it) and that
//     it stayed inside the sheet.
//   · the toast is a SnackBar and the same is true of it, so the assertion there
//     is that the sentence is on screen at all — the defect it guards is 「tapped
//     and nothing happened」, i.e. the copy never being shown, not the copy being trimmed.
//
// ⚠️ FORWARD CONTROL: 「was not clipped」 is trivially true for a short sentence, so the
// wrap assertion is made only where the text is genuinely under pressure, and
// the test FAILS if no language is — otherwise this file would be blind to a
// regression that shortens the sentence instead of fixing the layout.
//
// 🔴 THIS FILE DOES NOT MEASURE REAL-DEVICE PIXELS. `flutter_test` uses the Ahem
// placeholder font — every glyph is a full em square — so a line of 411dp holds
// far fewer characters than a real font would. That makes the budget CONSERVATIVE
// (fits under Ahem ⇒ fits on a real phone) and the implication runs one way only:
// nothing here may be used to argue that some sentence 「exactly fits」.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// The narrowest phone this project targets (the card M6-1 measurement width).
const Size kPhone = Size(411 * 3, 890 * 3);

/// `entry_context_menu.dart` renders the sub-line at this size; the wrap test
/// needs it to know what 「one line」 is.
const double kSubFontSize = 10;

/// How wide this text would be with nothing constraining it. Compared against
/// the box it actually got, this is what says whether the layout is under any
/// pressure at all.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

TimelineEntry _row() {
  final DateTime now = DateTime.utc(2026, 8, 5, 11, 0);
  return TimelineEntry(
    id: 'loc_f3_copy',
    clientId: 'c-f3-copy',
    mode: FlowMode.translate,
    delivery: Delivery.inject,
    // Rerun is offered only when there are ORIGINAL words to re-run.
    sourceText: '你好世界',
    outputText: 'hello world',
    status: EntryStatus.injected,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    createdAt: now,
    updatedAt: now,
  );
}

/// A host whose only job is to open the real sheet through its real entry point
/// (`showEntryContextMenu`) — the sheet's own class is private, and reaching
/// past the entry point would let this file pass on a widget the app never
/// builds.
Widget _menuHost(TimelineEntry entry, AppStrings strings) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (BuildContext context) => Center(
        child: TextButton(
          onPressed: () => showEntryContextMenu(context, entry, strings: strings),
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

/// The page narrows history to the instance this phone is talking to, so the
/// seeded row must be OWNED by the paired session or it renders nowhere.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

Future<ChatController> _controller(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-f3-copy-0000000000000000000000',
    'pc_id': 'pc-f3-copy',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-f3-copy',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(owner: _SessionOwner(session)),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
  );
}

void main() {
  // ── ① the rewritten explanation inside the menu ────────────────────────────
  testWidgets('🔴 card F3: the rerun explanation reads in full in all four languages on a 411dp phone', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = kPhone;
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    // Which languages the sentence is too long for on one line. Collected rather
    // than asserted per-locale because it is a property of the STRING, and the
    // Chinese one legitimately fits — demanding pressure everywhere would make
    // the test fail for a translation being concise.
    final List<AppLocale> pressured = <AppLocale>[];

    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      await tester.pumpWidget(_menuHost(_row(), s));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The action's own NAME first — it is what the user is choosing.
      expect(find.text(s.entryReprocess), findsOneWidget, reason: '$locale');
      // …then the sentence this card rewrote. 「作为新的一条发到电脑」 is the
      // product change; reading half of it is reading a different promise.
      final Finder sub = find.text(s.entryReprocessSub);
      expect(sub, findsOneWidget, reason: '$locale entryReprocessSub did not render');

      final Text w = tester.widget<Text>(sub);
      final Size box = tester.getSize(sub);
      // It stayed inside the phone. (A RenderFlex overflow would already have
      // failed the test — `flutter_test` turns the yellow stripes into an
      // exception — so this is the belt to that pair of braces.)
      expect(box.width, lessThanOrEqualTo(411.0), reason: '$locale overflowed the screen');
      // Nothing was trimmed with an ellipsis.
      expect(_clipped(tester, sub), isFalse, reason: '$locale was eaten by an ellipsis');

      if (_intrinsicWidth(w) > box.width) {
        pressured.add(locale);
        // 🔴 THE ASSERTION THAT ACTUALLY BITES: it did not fit on one line, so
        // it must have WRAPPED. A layout that dropped the wrap would report the
        // same single-line height while the tail of the sentence was gone.
        expect(
          box.height,
          greaterThan(kSubFontSize * 1.5),
          reason: '$locale did not fit yet occupied only one line — where did the second half go',
        );
      }

      // Close the sheet before the next locale: a stacked route would measure
      // the previous language's box.
      Navigator.of(tester.element(find.text('open'))).pop();
      await tester.pumpAndSettle();
    }

    // Positive control: at least one language really is long enough to be at risk. If
    // none were, every assertion above would be vacuous and this file would be
    // blind to the regression it exists for.
    expect(
      pressured,
      isNotEmpty,
      reason: 'no language\'s sentence is long enough to need a wrap — this test is blind to the regression',
    );
  });

  // ── ② defect ①'s new copy, through the real page ───────────────────────────
  testWidgets(
    '🔴 card F3 defect ①: double-tap — the busy toast is really RENDERED, and it is the '
    'right sentence',
    (WidgetTester tester) async {
      tester.view.physicalSize = kPhone;
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = await _controller(transport);
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        controller.store.dispose();
        await controller.session.dispose();
        await transport.close();
      });
      transport.pushStatus(SocketStatus.connected);
      controller.setMode(FlowMode.translate);
      // Seeded through the store's own builder rather than the PTT chain: this
      // test is about copy on screen, and awaiting the real chain inside a
      // FakeAsync zone deadlocks (the scar this repo already wears).
      final TimelineEntry seeded = controller.store.buildFromUtterance(
        clientId: 'c-f3-toast',
        mode: FlowMode.translate,
        delivery: Delivery.inject,
        text: '你好世界',
      );
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(AppLocale.zh);
      Future<void> pressRerun() async {
        await tester.longPress(find.text(seeded.displayText).first);
        await tester.pumpAndSettle();
        await tester.tap(find.text(s.entryReprocess));
        await tester.pumpAndSettle();
      }

      // First press: accepted, so NOTHING is said — a toast here would train the
      // user to ignore the one that matters.
      await pressRerun();
      expect(controller.isProcessingUtterance, isTrue, reason: 'setup: running');
      expect(find.text(s.reprocessBusy), findsNothing);
      expect(find.text(s.reprocessUnavailable), findsNothing);

      // Second press, with the first still in flight.
      await pressRerun();
      final Finder toast = find.text(s.reprocessBusy);
      expect(toast, findsOneWidget, reason: 'refused yet did not tell the user = silent failure');
      expect(_clipped(tester, toast), isFalse, reason: 'this sentence was eaten by an ellipsis');
      expect(
        tester.getSize(toast).width,
        lessThanOrEqualTo(411.0),
        reason: 'the banner overflowed the screen',
      );
      // 🔴 …and it is the RIGHT sentence: 「这条重跑不了」 would send the user to
      // change the mode, which is not their problem.
      expect(find.text(s.reprocessUnavailable), findsNothing);

      // Let the accepted run reach its terminal, through the real page. Two
      // things fall out of this and both are the card: the FIRST press's result
      // is not lost (defect ① again, this time end-to-end rather than at the
      // controller), and rerun really starts a new row rather than rewriting the old one.
      final Map<String, Object?> start = Map<String, Object?>.from(
        transport.emittedWhere(FlowMicEvents.composeStart).last.data! as Map,
      );
      transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
        'output_text': 'HELLO WORLD',
        'request_id': start['request_id'],
      });
      await tester.pumpAndSettle();
      expect(controller.store.entries, hasLength(2));
      expect(controller.store.findById(seeded.id)!.outputText, '你好世界');

      // Window C-5 escape hatch, reason identical word-for-word to
      // `chat_stick_bottom_widget_test.dart`:
      // a REAL `pair()` correctly arms a periodic Timer, and `flutter_test`
      // checks for pending timers BEFORE `addTearDown`'s async dispose runs.
      // ⚠️ This is the ONLY timer released by hand here — the 45 s compose
      // watchdog above is released by the run REACHING ITS TERMINAL, which is
      // the behaviour under test rather than a courtesy to the harness.
      controller.session.debugStopIdlePresencePoll();
    },
  );

  // ── ③ defect ①'s second leak: the watchdog was not released when the controller was torn down ──
  testWidgets(
    '🔴 card F3 defect ① (second leak): a torn-down controller releases the utterance '
    'watchdog',
    (WidgetTester tester) async {
      // HOW THIS FAILS WITHOUT THE FIX, and why the assertion is the harness
      // itself rather than an `expect`: `AutomatedTestWidgetsFlutterBinding`
      // fails a test if ANY Timer is still pending when the widget tree is torn
      // down. `utteranceCompose.dispose()` had no production caller, so a
      // controller disposed mid-run left its 45 s watchdog armed — and that
      // timer, when it fired, called `abort` → `ucFailed` → `notifyUi` on a
      // disposed ChangeNotifier. The revert of that one line prints this test's
      // red as 「A Timer is still pending even after the widget tree was
      // disposed」 with `UtteranceComposeController.start` in the stack, which is
      // the leak named at its own creation site.
      //
      // ⚠️ The run is left IN FLIGHT deliberately — that is the whole premise.
      // Nothing here answers the compose:start.
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = await _controller(transport);
      bool disposed = false;
      addTearDown(() async {
        if (!disposed) await controller.dispose();
        controller.destination.dispose();
        controller.store.dispose();
        await controller.session.dispose();
        await transport.close();
      });
      transport.pushStatus(SocketStatus.connected);
      controller.setMode(FlowMode.translate);
      final TimelineEntry seeded = controller.store.buildFromUtterance(
        clientId: 'c-f3-leak',
        mode: FlowMode.translate,
        delivery: Delivery.inject,
        text: '你好世界',
      );
      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pumpAndSettle();

      expect(controller.reprocessEntry(seeded), isNull, reason: 'setup: it started');
      expect(controller.isProcessingUtterance, isTrue);

      // The teardown the app never does but every page exit does: dispose the
      // controller while a run is still outstanding. Done IN THE BODY, because
      // `addTearDown` runs AFTER the pending-timer check.
      //
      // ⚠️ NOT awaited, and that is not laziness. `disposeRouted` ends in a run
      // of `await sub.cancel()`s that never complete inside a `testWidgets`
      // FakeAsync zone — awaiting it here hangs the test for the full 10-minute
      // harness timeout (measured). Every `dispose()` on a collaborator,
      // including the one this test is about, is SYNCHRONOUS and runs before the
      // first await, so the timer is released by the time the next pump returns.
      controller.session.debugStopIdlePresencePoll();
      disposed = true;
      unawaited(controller.dispose());
      await tester.pump();
    },
  );
}
