// REQ-12-02 (owner 2026-08-12) — one-tap clear history on the transcript
// screen, placed with the settings button.
//
// 🔴 This file measures three things, and the third is where this card is
// easiest to do for nothing:
//   ① drawn only when a callback is present; not drawn when absent (must not
//      appear as a button that does nothing when tapped);
//   ② it sits on **row 2**, and does not eat the 202.5px name budget of row 1
//      (the 0.2.51 ledger must not be reopened);
//   ③ **`main.dart` really does pass the callback down** — this one can only
//      be a source assertion, for the same reason as
//      `chat_history_source_wiring_test.dart` word for word: the parameter is
//      optional, and every widget test passes one itself, so **the line
//      missed at the composition root is invisible to every widget test**.
//      Anti-façade: a capability is wired but has no production caller.
//
// ⚠️ This file deliberately **does not test "does a tap actually delete"**.
// This button deletes nothing; it only opens `showStatsClearSheet` — delete
// semantics and criteria live under that sheet's own ledger (16 册 §6.2,
// 15 册 G-21, and the D7 paragraph in that file: "preview and delete must be
// the same predicate"). Re-asserting delete here would copy a delete contract
// onto a second entry, and copying is the shape that has already failed on
// this path.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

const ValueKey<String> _clearKey = ValueKey<String>('chat.clearHistory');
const ValueKey<String> _gearKey = ValueKey<String>('chat.settings');

ChatController _controller(FakeSocketTransport transport) {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
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

Future<ChatController> _pump(
  WidgetTester tester, {
  VoidCallback? onClearHistory,
}) async {
  // Narrow screen, not the default 800x600: this row's width problem only
  // exists at phone width.
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final ChatController controller = _controller(transport);
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
  });
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: controller,
        onOpenSettings: () {},
        onClearHistory: onClearHistory,
      ),
    ),
  );
  await tester.pump();
  return controller;
}

void main() {
  testWidgets('when the callback is absent this button does not exist at all', (WidgetTester tester) async {
    await _pump(tester);
    expect(find.byKey(_clearKey), findsNothing);
    // Positive control: the gear is still there. Without this, "cannot find
    // the clear key" could also mean the whole top bar never rendered, and
    // then this assertion is blind as a regression.
    expect(find.byKey(_gearKey), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('when a callback is present it appears, is tappable, and fires exactly once', (WidgetTester tester) async {
    int taps = 0;
    await _pump(tester, onClearHistory: () => taps += 1);
    expect(find.byKey(_clearKey), findsOneWidget);
    await tester.tap(find.byKey(_clearKey));
    await tester.pump();
    expect(taps, 1);
    // It is nested in a tappable card (the top bar itself has a gesture);
    // the inner gesture must win — otherwise tapping "clear" would also
    // fire something else. Same precedent as the comment in
    // cloud_signout_row.dart.
    expect(tester.takeException(), isNull);
  });

  testWidgets('touch target is the same size as the gear (40dp); two adjacent controls must not feel different',
      (WidgetTester tester) async {
    await _pump(tester, onClearHistory: () {});
    final Size clear = tester.getSize(find.byKey(_clearKey));
    final Size gear = tester.getSize(find.byKey(_gearKey));
    expect(clear.width, 40);
    expect(clear.height, 40);
    expect(clear, gear);
  });

  testWidgets('🔴 it lands on row 2 — the machine name on row 1 must not lose a single pixel to it',
      (WidgetTester tester) async {
    // 0.2.51 ledger: 360dp narrow screen has 332px usable, three 40dp
    // targets take 120, and `dev-pc-a` needs 202.5px ⇒ a single row cannot
    // hold a fourth thing. That is why the gear sank to row 2 that year.
    // If this card's new cell lands back on row 1, that ledger is reopened
    // on the spot. The criterion is not "the name fits" (that is a promise
    // we cannot give; a 19-character name will still ellipsize), it is
    // **with or without this button, the width left for the name on row 1
    // is exactly the same**.
    //
    // 🔴 What is measured is **that cell** (`chat.deviceNameTap`, the
    // `Expanded` that holds the name), not the width `Text` itself paints.
    // The first version measured `Text`, and that is **always equal to the
    // intrinsic width** — a short name never fills the available space ⇒
    // squeezing 40px into the row does not move it either.
    // **A reverse control proved this on the spot: stuffing a 40dp box into
    // row 1, that version stayed all-green.** An assertion that is always
    // true is worse than no assertion; it will sit there forever wearing
    // "green".
    final Finder slotFinder =
        find.byKey(const ValueKey<String>('chat.deviceNameTap'));

    await _pump(tester, onClearHistory: null);
    final double without = tester.getSize(slotFinder).width;

    await _pump(tester, onClearHistory: () {});
    final double with_ = tester.getSize(slotFinder).width;

    expect(with_, without,
        reason: 'this button ate row-1 width ⇒ it was placed on the wrong row');
    expect(without, greaterThan(100),
        reason: 'row 1 left no space for the name at all; the line above is spinning');
  });

  test('🔴 main.dart really does pass onClearHistory to ChatFlowPage', () {
    // Same reason as chat_history_source_wiring_test.dart, and the same
    // trap: **strip comments before searching**. If you search the raw
    // source, commenting that line out still leaves this assertion green
    // — a guard that reads comments as code is not a guard.
    final File main = File('lib/main.dart');
    expect(main.existsSync(), isTrue,
        reason: 'run from apps/mobile; this test reads the composition root');
    final String src = main
        .readAsLinesSync()
        .where((String l) => !l.trimLeft().startsWith('//'))
        .join('\n');

    final int chat = src.indexOf('ChatFlowPage(');
    expect(chat, isNot(-1));
    final String args = src.substring(chat, chat + 1400);
    expect(args.contains('onClearHistory:'), isTrue,
        reason: 'composition root did not pass it ⇒ the transcript page has no such button at all, and every widget test passes one itself, so none of them would go red');
    // And it must open **that** sheet: building a second inventory would
    // make the "stats say N / export N / clear then zero" guarantee fail
    // in place on the new entry (the settings page writes "the same
    // inventory instance" at the original site).
    expect(args.contains('showStatsClearSheet'), isTrue);
    expect(args.contains('inventory: _inventory'), isTrue,
        reason: 'must be the same instance the settings page uses, must not create a new one');
  });
}
