// rc-phone-fixes (real device, 2026-11-07) — 「Discard unsent content?」 → Discard
// must discard. Contract: doc 17 §1, the note under the swipe table.
//
// The defect: back with text in the box, the dialog, Discard: the page left and the
// same sentence was back in the box on return. The button only popped; the buffer
// lives on ChatController, which outlives the route. Observed once with a dropped
// link, so the first case here is the plain one with no link trouble at all: it
// answers whether the link was ever part of it (it was not). The link-drop case now
// never reaches this dialog, because that Deliver empties the box:
// deliver_link_down_box_test.dart.
//
// ⇒ The deliverable is what the box shows when the user comes back, so these push
// the real page, go through the real dialog, leave, and push it again.
//
// Reverse controls (2026-11-07, this file only; each measured red, then restored
// and rerun green, same command):
//   · `s.controller.discardBuffer()` removed from `_attemptBackRouted` → the plain,
//     the header ← and the spoken cases red, first at 「Found 1 widget with text
//     "a draft I do not want"」 after coming back: the defect as reported;
//   · `discard != true` dropped, so Cancel discards too → the Cancel case red,
//     「Found 0 widgets with type "ChatFlowPage"」: the page left and took the text.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _draft = 'a draft I do not want';

Future<ChatController> _controller(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-discard-00000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-discard',
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
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
  );
}

/// In addTearDown, not the test body: these await on a real clock, and inside the
/// fake-clock body they never return (the run simply hangs).
void _tearDown(ChatController c) => addTearDown(() async {
  await c.dispose();
  c.destination.dispose();
  c.store.dispose();
  await c.session.dispose();
});

/// Production's shape: the chat page is a route pushed over a home, and the
/// controller stays alive underneath it.
Widget _app(ChatController c, void Function() onLeave) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (BuildContext context) => TextButton(
        onPressed: () => Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => ChatFlowPage(controller: c, onBack: onLeave),
          ),
        ),
        child: const Text('open'),
      ),
    ),
  ),
);

/// ChatFlowPage falls back to zh without appSettings.
final AppStrings _s = AppStrings.of(AppLocale.zh);

Future<void> _open(WidgetTester tester) async {
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  expect(find.byType(ChatFlowPage), findsOneWidget);
}

/// The system back: `maybePop` consults the page's PopScope, which is exactly what
/// Android's back and the iOS swipe do.
Future<void> _systemBack(WidgetTester tester) async {
  final NavigatorState nav = tester.state(find.byType(Navigator).last);
  await nav.maybePop();
  await tester.pumpAndSettle();
}

Future<void> _pressInDialog(WidgetTester tester, String button) async {
  expect(find.text(_s.discardUnsentConfirm), findsOneWidget, reason: 'the dialog is up');
  await tester.tap(find.widgetWithText(TextButton, button));
  await tester.pumpAndSettle();
}

/// What the box shows: the compose strip paints the buffer as text on the page.
Finder get _boxText => find.descendant(
  of: find.byType(ChatFlowPage),
  matching: find.text(_draft),
);

void main() {
  testWidgets(
    '🔴 plain text, nothing wrong with the link: Discard, leave, come back, the box is empty',
    (WidgetTester tester) async {
      int leaves = 0;
      final ChatController c = await _controller(FakeSocketTransport());
      _tearDown(c);
      await tester.pumpWidget(_app(c, () => leaves++));
      await _open(tester);
      c.setBuffer(_draft);
      await tester.pump();
      expect(_boxText, findsOneWidget, reason: 'positive control: the finder sees the box');

      await _systemBack(tester);
      await _pressInDialog(tester, _s.discardUnsentAction);

      expect(find.byType(ChatFlowPage), findsNothing, reason: 'Discard still leaves');
      expect(leaves, 1, reason: 'the leave cleanup runs once, as before');

      await _open(tester);
      expect(_boxText, findsNothing, reason: 'the words the user discarded are back');
      expect(c.buffer, isEmpty);

      // G-15①: quieted here, the binding checks timers before addTearDown runs.

      c.session.debugStopIdlePresencePoll();
    },
  );

  testWidgets('the header ← takes the same path', (WidgetTester tester) async {
    final ChatController c = await _controller(FakeSocketTransport());
      _tearDown(c);
    await tester.pumpWidget(_app(c, () {}));
    await _open(tester);
    c.setBuffer(_draft);
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey<String>('chat.back')));
    await tester.pumpAndSettle();
    await _pressInDialog(tester, _s.discardUnsentAction);

    await _open(tester);
    expect(_boxText, findsNothing);

    // G-15①: quieted here, the binding checks timers before addTearDown runs.

    c.session.debugStopIdlePresencePoll();
  });

  testWidgets('Cancel touches nothing: still on the page, the words still in the box', (
    WidgetTester tester,
  ) async {
    final ChatController c = await _controller(FakeSocketTransport());
      _tearDown(c);
    await tester.pumpWidget(_app(c, () {}));
    await _open(tester);
    c.setBuffer(_draft);
    await tester.pump();

    await _systemBack(tester);
    await _pressInDialog(tester, _s.cancel);

    expect(find.byType(ChatFlowPage), findsOneWidget);
    expect(_boxText, findsOneWidget);
    expect(c.buffer, _draft);

    // G-15①: quieted here, the binding checks timers before addTearDown runs.

    c.session.debugStopIdlePresencePoll();
  });

  testWidgets(
    'a spoken draft: the row it came from stays, settled 📥 noted, the same as the '
    'edit sheet\'s Discard',
    (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      _tearDown(c);
      await tester.pumpWidget(_app(c, () {}));
      await _open(tester);
      // The real manual-policy utterance: the row is built and its words fold into
      // the box. runAsync, because the ptt chain awaits real timers.
      await tester.runAsync(() async {
        await c.loadSendPolicy();
        c.session.fsm.onJustDoneTimeout();
        await c.pttDown();
        await c.pttUp();
        transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': _draft,
          'confidence': 0.95,
          'language': 'en',
          'segment_idx': 0,
          'is_segment': false,
          'duration_ms': 1200,
        });
        await pumpEventQueue();
      });
      await tester.pump();
      expect(c.buffer, _draft, reason: 'premise: the words reached the box');
      final String rowId = c.store.entries.single.id;
      expect(c.store.findById(rowId)!.status, isNot(EntryStatus.noted),
          reason: 'premise: the row has not been settled yet');

      // A manual spoken draft opens the edit sheet by itself, and back collapses
      // the sheet first (PA-4); the second back asks.
      await _systemBack(tester);
      expect(find.text(_s.discardUnsentConfirm), findsNothing, reason: 'premise: sheet first');
      await _systemBack(tester);
      await _pressInDialog(tester, _s.discardUnsentAction);

      expect(c.buffer, isEmpty);
      expect(c.store.findById(rowId), isNotNull, reason: 'the record is the substrate');
      expect(c.store.findById(rowId)!.status, EntryStatus.noted,
          reason: 'nothing was delivered, and the row says so');
      // The state machine's just-done timer, armed by that final on the fake clock.
      await tester.pump(const Duration(seconds: 2));

      // G-15①: quieted here, the binding checks timers before addTearDown runs.

      c.session.debugStopIdlePresencePoll();
    },
  );
}
