// HoldToTalkSurface — swipe-up cancel must NOT send.
//
// Crossing −60dp ARMS the cancel zone; release (or OS pointer-cancel) while
// armed discards. Sliding back below the threshold disarms, and that release
// sends. Accept is a 500 ms timer on pointer-down — movement does not abort
// it — so press-and-immediately-slide can still cancel.
//
// Reverse control: restore `_accepted` as a precondition of `_syncCancelZone`
// and the early-move case below goes red (`sent == true`).

import 'package:flowmic/src/ui/hold_to_talk_surface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host({
  required Future<void> Function() onAccepted,
  required Future<void> Function() onRelease,
  required Future<void> Function() onSwipeCancel,
  ValueChanged<bool>? onCancelZoneChanged,
}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: SizedBox(
        width: 200,
        height: 80,
        child: HoldToTalkSurface(
          enabled: true,
          onAccepted: onAccepted,
          onRelease: onRelease,
          onSwipeCancel: onSwipeCancel,
          onCancelZoneChanged: onCancelZoneChanged,
          child: const ColoredBox(
            color: Color(0xFF4F46E5),
            child: SizedBox.expand(),
          ),
        ),
      ),
    ),
  ),
);

Future<TestGesture> _pressAndHold(WidgetTester tester) async {
  final TestGesture g = await tester.startGesture(
    tester.getCenter(find.byType(HoldToTalkSurface)),
  );
  await tester.pump(HoldToTalkSurface.acceptHold);
  await tester.pump();
  return g;
}

void main() {
  testWidgets('release after an accepted hold sends, and does not cancel', (
    WidgetTester tester,
  ) async {
    bool accepted = false;
    bool sent = false;
    bool cancelled = false;
    await tester.pumpWidget(
      _host(
        onAccepted: () async => accepted = true,
        onRelease: () async => sent = true,
        onSwipeCancel: () async => cancelled = true,
      ),
    );
    final TestGesture g = await _pressAndHold(tester);
    expect(accepted, isTrue);
    await g.up();
    await tester.pump();
    expect(sent, isTrue);
    expect(cancelled, isFalse);
  });

  testWidgets('swipe-up past 60dp arms; release in the zone cancels, does NOT send', (
    WidgetTester tester,
  ) async {
    bool sent = false;
    bool cancelled = false;
    final List<bool> zone = <bool>[];
    await tester.pumpWidget(
      _host(
        onAccepted: () async {},
        onRelease: () async => sent = true,
        onSwipeCancel: () async => cancelled = true,
        onCancelZoneChanged: zone.add,
      ),
    );
    final TestGesture g = await _pressAndHold(tester);
    await g.moveBy(const Offset(0, -100));
    await tester.pump();
    expect(cancelled, isFalse, reason: 'crossing the line arms, it does not discard');
    expect(zone, <bool>[true]);
    await g.up();
    await tester.pump();
    expect(cancelled, isTrue);
    expect(sent, isFalse, reason: 'a cancelled hold must not send');
  });

  testWidgets('slide back below the threshold disarms; that release SENDS', (
    WidgetTester tester,
  ) async {
    bool sent = false;
    bool cancelled = false;
    final List<bool> zone = <bool>[];
    await tester.pumpWidget(
      _host(
        onAccepted: () async {},
        onRelease: () async => sent = true,
        onSwipeCancel: () async => cancelled = true,
        onCancelZoneChanged: zone.add,
      ),
    );
    final TestGesture g = await _pressAndHold(tester);
    await g.moveBy(const Offset(0, -100));
    await tester.pump();
    await g.moveBy(const Offset(0, 100));
    await tester.pump();
    expect(zone, <bool>[true, false]);
    await g.up();
    await tester.pump();
    expect(sent, isTrue, reason: 'leaving the zone restores send-on-release');
    expect(cancelled, isFalse);
  });

  testWidgets('OS pointer-cancel after an accepted hold RELEASES (keeps words)',
      (WidgetTester tester) async {
    bool sent = false;
    bool cancelled = false;
    await tester.pumpWidget(
      _host(
        onAccepted: () async {},
        onRelease: () async => sent = true,
        onSwipeCancel: () async => cancelled = true,
      ),
    );
    final TestGesture g = await _pressAndHold(tester);
    await g.cancel();
    await tester.pump();
    expect(cancelled, isFalse);
    expect(sent, isTrue, reason: 'OS steal must not throw the utterance away');
  });

  testWidgets('swipe-up THEN pointer-cancel still does not send', (
    WidgetTester tester,
  ) async {
    bool sent = false;
    bool cancelled = false;
    await tester.pumpWidget(
      _host(
        onAccepted: () async {},
        onRelease: () async => sent = true,
        onSwipeCancel: () async => cancelled = true,
      ),
    );
    final TestGesture g = await _pressAndHold(tester);
    await g.moveBy(const Offset(0, -100));
    await tester.pump();
    expect(cancelled, isFalse);
    await g.cancel();
    await tester.pump();
    expect(cancelled, isTrue);
    expect(sent, isFalse);
  });

  testWidgets(
    '🔴 early-move: swipe past 60dp BEFORE accept, then accept, then release — cancels, does not send',
    (WidgetTester tester) async {
      bool accepted = false;
      bool sent = false;
      bool cancelled = false;
      final List<bool> zone = <bool>[];
      await tester.pumpWidget(
        _host(
          onAccepted: () async => accepted = true,
          onRelease: () async => sent = true,
          onSwipeCancel: () async => cancelled = true,
          onCancelZoneChanged: zone.add,
        ),
      );
      final TestGesture g = await tester.startGesture(
        tester.getCenter(find.byType(HoldToTalkSurface)),
      );
      await g.moveBy(const Offset(0, -100));
      await tester.pump();
      expect(accepted, isFalse, reason: 'harness: accept timer has not fired');
      await tester.pump(HoldToTalkSurface.acceptHold);
      await tester.pump();
      expect(accepted, isTrue, reason: 'movement must not abort the accept timer');
      expect(zone, contains(true), reason: 'zone must be armed before release');
      expect(cancelled, isFalse, reason: 'still holding — discard waits for release');
      await g.up();
      await tester.pump();
      expect(cancelled, isTrue);
      expect(sent, isFalse, reason: '🔴 early swipe then accept then release sent');
    },
  );
}
