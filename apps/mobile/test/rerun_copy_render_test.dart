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
// ⚠️ Correction (NR-89, 2026-09-23): sentence ① (`entryReprocessSub`) no longer
// exists. The one mode-bound row became two explicit rows — 「re-translate」
// (`entryRetranslate` / `entryRetranslateSub`, which names the target language
// through the rendered `translateTargetLabel`) and 「re-organize」
// (`entryReorganize` / `entryReorganizeSub`). Case ① now measures BOTH
// sub-lines under the same rules, and the NR-89 group at the bottom pins which
// rows appear, what they render and what a tap returns. Every string here is
// read from the catalogue getter, never quoted, so the cases hold for whatever
// wording the copy pipeline lands.
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

/// What the paragraph actually PAINTS (D-15: the rendered result, not
/// `Text.data`).
String _painted(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).text.toPlainText();

TimelineEntry _row({
  FlowMode mode = FlowMode.translate,
  String source = '你好世界',
  String output = 'hello world',
  String? processMode = 'translate',
}) {
  final DateTime now = DateTime.utc(2026, 8, 5, 11, 0);
  return TimelineEntry(
    id: 'loc_f3_copy',
    clientId: 'c-f3-copy',
    mode: mode,
    delivery: Delivery.inject,
    // Rerun is offered only when there are ORIGINAL words to re-run.
    sourceText: source,
    outputText: output,
    processMode: processMode,
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
/// builds. NR-89: [translateTarget] is passed through exactly as the chat page
/// passes it, and [onChosen] receives what the sheet returned.
Widget _menuHost(
  TimelineEntry entry,
  AppStrings strings, {
  String? translateTarget,
  bool sessionActions = true,
  void Function(EntryAction?)? onChosen,
}) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (BuildContext context) => Center(
        child: TextButton(
          onPressed: () async {
            final EntryAction? chosen = await showEntryContextMenu(
              context,
              entry,
              strings: strings,
              sessionActions: sessionActions,
              translateTarget: translateTarget,
            );
            onChosen?.call(chosen);
          },
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

/// NR-89: the target every case below aims at. Not the default (`en`), so a
/// sub-line that rendered a hard-coded or defaulted language would not match.
const String kTarget = 'ja';

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
  testWidgets('🔴 card F3 / NR-89: both re-run explanations read in full in every language on a 411dp phone', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = kPhone;
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    // Which (language, sentence) pairs are too long for one line. Collected rather
    // than asserted per-locale because it is a property of the STRING, and the
    // Chinese one legitimately fits — demanding pressure everywhere would make
    // the test fail for a translation being concise.
    final List<String> pressured = <String>[];

    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      await tester.pumpWidget(_menuHost(_row(), s, translateTarget: kTarget));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // NR-89: two rows, each with its own name and sub-line. The names first —
      // they are what the user is choosing.
      final Map<String, String> subs = <String, String>{
        'entryRetranslateSub': s.entryRetranslateSub(s.translateTargetLabel(kTarget)),
        'entryReorganizeSub': s.entryReorganizeSub,
      };
      for (final String name in <String>[s.entryRetranslate, s.entryReorganize]) {
        final Finder label = find.text(name);
        expect(label, findsOneWidget, reason: '$locale label did not render');
        expect(_painted(tester, label), name, reason: '$locale label');
      }

      for (final MapEntry<String, String> e in subs.entries) {
        // …then the sentences. 「作为新的一条发到电脑」 is the product change;
        // reading half of it is reading a different promise.
        final Finder sub = find.text(e.value);
        expect(sub, findsOneWidget, reason: '$locale ${e.key} did not render');
        expect(_painted(tester, sub), e.value, reason: '$locale ${e.key}');

        final Text w = tester.widget<Text>(sub);
        final Size box = tester.getSize(sub);
        // It stayed inside the phone. (A RenderFlex overflow would already have
        // failed the test — `flutter_test` turns the yellow stripes into an
        // exception — so this is the belt to that pair of braces.)
        expect(box.width, lessThanOrEqualTo(411.0), reason: '$locale ${e.key} overflowed the screen');
        // Nothing was trimmed with an ellipsis.
        expect(_clipped(tester, sub), isFalse, reason: '$locale ${e.key} was eaten by an ellipsis');

        if (_intrinsicWidth(w) > box.width) {
          pressured.add('$locale ${e.key}');
          // 🔴 THE ASSERTION THAT ACTUALLY BITES: it did not fit on one line, so
          // it must have WRAPPED. A layout that dropped the wrap would report the
          // same single-line height while the tail of the sentence was gone.
          expect(
            box.height,
            greaterThan(kSubFontSize * 1.5),
            reason: '$locale ${e.key} did not fit yet occupied only one line — where did the second half go',
          );
        }
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
        // NR-89: the page passes the controller's translate target, so the
        // re-translate row is there — a tap on it is the production wiring
        // (`chat_flow_entry_actions.dart`) end to end.
        await tester.tap(find.text(s.entryRetranslate));
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
      // ⚠️ The 45 s compose watchdog above is NOT released here — the run
      // REACHING ITS TERMINAL is what releases it, and that is the behaviour
      // under test rather than a courtesy to the harness.
      controller.session.debugStopIdlePresencePoll();

      // Card UX2-2's grace timer: the delivered utterance is legitimately still
      // pending (nothing answers `inject:result` here), so `DeliveryOutbox` is
      // legitimately holding a 5 s wake-up for the banner. It is released by
      // the SAME dispose the app performs on every page exit — done in the body
      // for the reason spelled out in the next test: `addTearDown` runs AFTER
      // the pending-timer check, and every collaborator `dispose()` inside
      // `disposeRouted` is synchronous and runs before its first await.
      disposed = true;
      unawaited(controller.dispose());
      await tester.pump();
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

      expect(controller.reprocessEntry(seeded, FlowMode.translate), isNull,
          reason: 'setup: it started');
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

  // ── (e) NR-89: two explicit rows instead of one mode-bound row ──────────────
  group('(e) NR-89 — re-translate / re-organize on the long-press sheet', () {
    Future<EntryAction?> openAndTap(
      WidgetTester tester,
      TimelineEntry entry,
      AppStrings s,
      String label,
    ) async {
      EntryAction? chosen;
      await tester.pumpWidget(
        _menuHost(entry, s, translateTarget: kTarget, onChosen: (EntryAction? a) => chosen = a),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
      return chosen;
    }

    testWidgets('both rows render on a realtime, a translated and an organized row, '
        'and each tap returns its own action', (WidgetTester tester) async {
      tester.view.physicalSize = kPhone;
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final AppStrings s = AppStrings.of(AppLocale.en);
      final Map<String, TimelineEntry> rows = <String, TimelineEntry>{
        // A realtime row has an original too (`buildFromUtterance` writes
        // `sourceText: text`) — which is why it can be re-run at all now.
        'realtime': _row(
          mode: FlowMode.realtime,
          source: '今天开会',
          output: '今天开会',
          processMode: null,
        ),
        'translate': _row(),
        'organize': _row(mode: FlowMode.organize, output: '你好，世界。', processMode: 'organize'),
      };
      for (final MapEntry<String, TimelineEntry> r in rows.entries) {
        await tester.pumpWidget(_menuHost(r.value, s, translateTarget: kTarget));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        final Finder retranslate = find.text(s.entryRetranslate);
        final Finder reorganize = find.text(s.entryReorganize);
        expect(retranslate, findsOneWidget, reason: '${r.key} row: re-translate');
        expect(reorganize, findsOneWidget, reason: '${r.key} row: re-organize');
        expect(_painted(tester, retranslate), s.entryRetranslate);
        expect(_painted(tester, reorganize), s.entryReorganize);
        // Laid out with a real box, not merely present in the tree.
        expect(tester.getSize(retranslate).height, greaterThan(0));
        expect(tester.getSize(reorganize).height, greaterThan(0));
        Navigator.of(tester.element(find.text('open'))).pop();
        await tester.pumpAndSettle();

        expect(await openAndTap(tester, r.value, s, s.entryRetranslate), EntryAction.retranslate,
            reason: '${r.key} row');
        expect(await openAndTap(tester, r.value, s, s.entryReorganize), EntryAction.reorganize,
            reason: '${r.key} row');
      }
    });

    testWidgets('the re-translate sub-line names the target the phone translates into', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = kPhone;
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_menuHost(_row(), s, translateTarget: kTarget));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        final Finder sub = find.text(s.entryRetranslateSub(s.translateTargetLabel(kTarget)));
        expect(sub, findsOneWidget, reason: '$locale');
        // The painted sentence carries the rendered target label (「→ 日本語」),
        // whatever wording surrounds it.
        expect(_painted(tester, sub), contains(s.translateTargetLabel(kTarget)), reason: '$locale');
        Navigator.of(tester.element(find.text('open'))).pop();
        await tester.pumpAndSettle();
      }
    });

    testWidgets('no translate target ⇒ no re-translate row; re-organize is still there', (
      WidgetTester tester,
    ) async {
      final AppStrings s = AppStrings.of(AppLocale.en);
      for (final String? target in <String?>[null, '']) {
        await tester.pumpWidget(_menuHost(_row(), s, translateTarget: target));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        // Positive control first: the sheet is open and the sibling row renders,
        // so the absence below is the gate, not a blind finder.
        expect(find.text(s.entryReorganize), findsOneWidget, reason: 'target=$target');
        expect(find.text(s.entryRetranslate), findsNothing, reason: 'target=$target');
        Navigator.of(tester.element(find.text('open'))).pop();
        await tester.pumpAndSettle();
      }
    });

    testWidgets('sessionActions:false withholds BOTH rows, even with a target', (
      WidgetTester tester,
    ) async {
      final AppStrings s = AppStrings.of(AppLocale.en);
      await tester.pumpWidget(
        _menuHost(_row(), s, translateTarget: kTarget, sessionActions: false),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(s.confirmDelete), findsOneWidget, reason: 'positive control: sheet is open');
      expect(find.text(s.entryRetranslate), findsNothing);
      expect(find.text(s.entryReorganize), findsNothing);
    });
  });
}
