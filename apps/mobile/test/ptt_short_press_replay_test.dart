// 0.3.43 Q5-① — A SHORT PRESS MUST NOT STICK IN 「转录中」.
//
// Ruling:
//   docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q5-①
// Contract (both corrected in the same round, docs BEFORE code):
//   docs/rebuild/08-MOBILE-SPEC.md §2 — the dated correction block that retires
//     「PTT down (≤50ms, 同步边)」;
//   docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md §1 — the RECORDING exits
//     row now names the replay.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
// `PttBar._handleDown` is a long await: the accept edge fires at 300 ms
// ([HoldToTalkSurface.acceptHold]) and the handler then waits on the permission
// gate plus the native recorder open — MEASURED at ~2 s on the owner's tablet.
// Press for a second and let go and the release lands INSIDE that window, where
// `_handleUp` opened with `if (!_active) return;`. The release was dropped on
// the floor; the FSM entered RECORDING a moment later with nothing left to take
// it out but the server's 5-minute cap or a link drop.
//
// The swipe-cancel path was always right in the same window (`_cancelled` is set
// BEFORE the identical guard and replayed after the await). ONE window, TWO
// gestures, TWO treatments — and only one of them was written down anywhere.
//
// ── REVERSE CONTROL (it really went red) ─────────────────────────────────────
// Removing the two-line replay from `ptt_bar.dart` (the `_releasedDuringActivation`
// write in `_handleUp`, and the `await _handleUp()` at the end of `_handleDown`)
// and re-running THIS file, on dev-pc-a:
//
//   00:00 +0 -1: a release inside the activation window is replayed as a normal
//                release [E]
//     Expected: <1>
//       Actual: <0>
//     #4  main.<anonymous closure> (…/ptt_short_press_replay_test.dart:106:7)
//     (`ups`, i.e. the utterance was never released — the stuck RECORDING itself)
//
//   00:00 +0 -2: the replay survives the whole short-press gesture end to end [E]
//     Expected: <1>
//       Actual: <0>
//     #4  main.<anonymous closure> (…/ptt_short_press_replay_test.dart:140:5)
//
//   00:00 +3 -2: Some tests failed.
//
// ⚠️ THE OTHER THREE STAYED GREEN, and that is the point of having them: the
// swipe-cancel case, the refused-press case and the re-press case all describe
// what must NOT happen, so they are green both with and without the fix. Only
// the two positive cases can tell the difference — which is why the reverse
// control had to be run rather than reasoned about.
//
// Restored afterwards from a byte copy; `git grep _releasedDuringActivation`
// is non-empty again and the experiment left no residue.

import 'dart:async';

import 'package:flowmic/src/ui/hold_to_talk_surface.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

final Finder _bar = find.byKey(const ValueKey<String>('ptt.bar'));

void main() {
  testWidgets(
    'a release inside the activation window is replayed as a normal release',
    (WidgetTester tester) async {
      // The gate stands in for the ~2 s permission-plus-recorder-open chain:
      // completing it by hand is what makes the window a controlled variable
      // rather than a race the test happens to win.
      final Completer<bool> gate = Completer<bool>();
      int ups = 0;
      int cancels = 0;

      await tester.pumpWidget(
        _wrap(
          PttBar(
            visual: PttVisual.idle,
            onDown: () => gate.future,
            onUp: () async => ups++,
            onCancel: () async => cancels++,
          ),
        ),
      );

      final TestGesture g = await tester.startGesture(tester.getCenter(_bar));
      // Land exactly on the accept edge — the named constant, never a second
      // number.
      await tester.pump(HoldToTalkSurface.acceptHold);
      await tester.pump();
      // Pre-condition, stated so a green result cannot come from the window not
      // being open: the bar is in its 「starting microphone」 face, i.e. the
      // accept edge fired and the data layer has NOT come back.
      expect(find.text('正在启动麦克风…'), findsOneWidget);

      // The short press: the finger leaves while the microphone is still
      // opening. This is the frame the old code threw away.
      await g.up();
      await tester.pump();
      expect(
        ups,
        0,
        reason: 'nothing can be released before the down edge has resolved',
      );

      // The recorder finally opens.
      gate.complete(true);
      await tester.pump();
      await tester.pump();

      // 🔴 THE ASSERTION. Not 「_active is false」 and not a rendered face: what
      // the FSM needs is the CALL, because `onUp` is the only thing that ever
      // reaches `PttSession.pttUp()` and moves RECORDING → PROCESSING. Asserting
      // the face would have passed against the broken code.
      expect(ups, 1);
      // And it is a release, not a discard: a short press keeps its words.
      expect(cancels, 0);
    },
  );

  testWidgets('the replay survives the whole short-press gesture end to end', (
    WidgetTester tester,
  ) async {
    // The same fact through the real gesture pipeline with a real delay instead
    // of a hand-held completer — a 1 s hold against a 2 s open, i.e. the owner's
    // own report. Kept as a SECOND case rather than replacing the first: this
    // one proves the window is reachable by an ordinary press, the first one
    // proves what happens at its edges.
    int ups = 0;
    await tester.pumpWidget(
      _wrap(
        PttBar(
          visual: PttVisual.idle,
          onDown: () async {
            await Future<void>.delayed(const Duration(seconds: 2));
            return true;
          },
          onUp: () async => ups++,
        ),
      ),
    );

    final TestGesture g = await tester.startGesture(tester.getCenter(_bar));
    await tester.pump(const Duration(seconds: 1)); // hold for one second
    await g.up();
    await tester.pump(const Duration(seconds: 3)); // let the mic finish opening
    await tester.pump();

    expect(ups, 1);
  });

  testWidgets('a swipe-cancel inside the window still discards — and the '
      'release replay does not fire behind it', (WidgetTester tester) async {
    // 🔴 REVERSE-DIRECTION CONTROL. The fix lives one line away from the
    // cancel fork it was modelled on, so the cheapest way to get it wrong is to
    // replay a release for a hold the user threw away — a swipe-up that SENDS
    // is worse than the bug being fixed.
    final Completer<bool> gate = Completer<bool>();
    int ups = 0;
    int cancels = 0;

    await tester.pumpWidget(
      _wrap(
        PttBar(
          visual: PttVisual.idle,
          onDown: () => gate.future,
          onUp: () async => ups++,
          onCancel: () async => cancels++,
        ),
      ),
    );

    final Offset start = tester.getCenter(_bar);
    final TestGesture g = await tester.startGesture(start);
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    // Past the 60 dp cancel threshold, then release there.
    await g.moveTo(start - const Offset(0, HoldToTalkSurface.cancelThreshold + 20));
    await tester.pump();
    await g.up();
    await tester.pump();

    gate.complete(true);
    await tester.pump();
    await tester.pump();

    expect(cancels, 1);
    expect(ups, 0);
  });

  testWidgets('a refused press replays into nothing', (
    WidgetTester tester,
  ) async {
    // The third arm of `_handleUp`'s new fork: the gate said no, so there is no
    // utterance and no release to honour. Without this case the flag could be
    // implemented as 「always replay」 and every case above would still be green.
    final Completer<bool> gate = Completer<bool>();
    int ups = 0;

    await tester.pumpWidget(
      _wrap(
        PttBar(
          visual: PttVisual.idle,
          onDown: () => gate.future,
          onUp: () async => ups++,
        ),
      ),
    );

    final TestGesture g = await tester.startGesture(tester.getCenter(_bar));
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    await g.up();
    await tester.pump();

    gate.complete(false); // permission denied / recorder refused
    await tester.pump();
    await tester.pump();

    expect(ups, 0);
  });

  testWidgets('a re-press inside the window cannot eat the first press\'s '
      'release', (WidgetTester tester) async {
    // 🔴 THE DOUBLE-FIRE GUARD. Release-then-re-press inside the ~2 s window
    // used to open a SECOND `_handleDown` beside the first; with the replay flag
    // in place, that second activation's reset would have swallowed the first
    // press's recorded release — re-creating the stuck RECORDING inside a
    // narrower window, which is the worst kind of regression: the same symptom
    // with a harder repro.
    final Completer<bool> gate = Completer<bool>();
    int downs = 0;
    int ups = 0;

    await tester.pumpWidget(
      _wrap(
        PttBar(
          visual: PttVisual.idle,
          onDown: () {
            downs++;
            return gate.future;
          },
          onUp: () async => ups++,
        ),
      ),
    );

    final TestGesture g1 = await tester.startGesture(tester.getCenter(_bar));
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    await g1.up(); // release inside the window — recorded for replay
    await tester.pump();

    final TestGesture g2 = await tester.startGesture(tester.getCenter(_bar));
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();

    // One activation at a time: the second press finds one in flight and is
    // ignored, so the data layer is never re-entered mid-open.
    expect(downs, 1);

    gate.complete(true);
    await tester.pump();
    await tester.pump();
    await g2.up();
    await tester.pump();

    // Exactly one release reached the session — the first press's, replayed.
    // Not zero (the bug) and not two (a double send).
    expect(ups, 1);
  });
}
