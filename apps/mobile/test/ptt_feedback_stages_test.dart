// P5 + P6 (0.3.1, owner 2026-08-15) — the press must ANSWER immediately, and a
// live face must not wear the dock's 「off」 grey.
//
//   P5: 「轻记录…说话的按钮默认是灰色的…看起来是不能用的状态」 — the noted face
//       was the mock's `.ptt.gry{#8B8996}`, the same grey vocabulary as the
//       genuinely dead face.
//   P5b (owner, same day): 「土黄色有边框的按钮看起来与整个 APP 的设计语言不一致」
//       — P5's answer had been an amber WASH plus a 1.5 px outline, i.e. the
//       app's chip/badge construction worn by the screen's primary action. The
//       noted face is now the SAME solid `pri`+`onPri` every other resting face
//       uses, and no face carries a border at all. Record-only identity lives
//       where ptt_bar.dart's face table says it lives: the label, the caption
//       and the header pill — never the fill.
//   P6: 「按下后要小2秒左右才会有反馈」 — measured chain: 500 ms accept window
//       with zero feedback, then the permission probe + a DUPLICATE in-capture
//       probe + the native recorder open, with colour/haptic/timer all gated
//       on the recorder being open. Now: 0 ms pressed tint on contact, the
//       accept window is 300 ms, the await window renders 「正在启动麦克风…」,
//       and a definitively-granted gate lets capture skip its duplicate probe.
//
// The 「starting microphone」 face deliberately claims ONLY starting — the
// recording face/timer still wait for the real capture start (R11: words
// spoken before the OS mic is open are lost, and a face that said 「recording」
// during that window would be a wrong status word with no failure anywhere).

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/ptt/mic_permission.dart';
import 'package:flowmic/src/ui/hold_to_talk_surface.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

BoxDecoration _barDecoration(WidgetTester tester) {
  final Container c = tester.widget<Container>(
    find.byKey(const ValueKey<String>('ptt.bar')),
  );
  return c.decoration! as BoxDecoration;
}

class _CountingRecorder extends FakeAudioRecorder {
  int permissionProbes = 0;

  @override
  Future<bool> hasPermission() {
    permissionProbes++;
    return super.hasPermission();
  }
}

void main() {
  group('P5b · the noted face speaks the dock\'s own vocabulary', () {
    testWidgets('solid pri fill, no border — the same construction as idle', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.noted)));
      final BoxDecoration noted = _barDecoration(tester);
      expect(noted.color, FlowMicDockColors.pri);
      // 🔴 The regression P5b exists to prevent: a hairline border is this
      // app's CHIP construction, and the screen's primary action must not
      // wear it. Asserted on the decoration, not on a token, because the
      // owner's complaint was about the rendered shape.
      expect(noted.border, isNull);

      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.disabled)));
      final BoxDecoration disabled = _barDecoration(tester);
      expect(disabled.color, FlowMicDockColors.chipbg);
      expect(disabled.border, isNull);

      // P5's finding still holds and is still pinned: a LIVE face must not wear
      // the dock's 「off」 grey, nor the armed-overlay grey.
      expect(noted.color, isNot(disabled.color));
      expect(noted.color, isNot(const Color(0xFF8B8996)));
    });

    testWidgets('no resting face carries a border', (WidgetTester tester) async {
      // Stated as a property of the whole face table rather than of the one
      // face that regressed — the next fill to be argued about should not be
      // able to re-import the chip outline either.
      for (final PttVisual v in PttVisual.values) {
        await tester.pumpWidget(_wrap(PttBar(visual: v)));
        expect(_barDecoration(tester).border, isNull, reason: 'face $v');
      }
    });
  });

  group('P6 · staged press feedback', () {
    testWidgets('contact tints the bar within one frame, release restores it', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.idle)));
      final Color resting = _barDecoration(tester).color!;

      final TestGesture g = await tester.startGesture(
        tester.getCenter(find.byKey(const ValueKey<String>('ptt.bar'))),
      );
      await tester.pump(); // ONE frame — this is the 0 ms acknowledgement.
      expect(_barDecoration(tester).color, isNot(resting));

      await g.up();
      await tester.pump();
      expect(_barDecoration(tester).color, resting);
    });

    testWidgets(
      'the accept edge shows 「starting microphone」 while the data layer opens, '
      'then clears',
      (WidgetTester tester) async {
        final Completer<bool> gate = Completer<bool>();
        await tester.pumpWidget(
          _wrap(PttBar(visual: PttVisual.idle, onDown: () => gate.future)),
        );

        final TestGesture g = await tester.startGesture(
          tester.getCenter(find.byKey(const ValueKey<String>('ptt.bar'))),
        );
        // Land exactly on the accept edge (the named constant, never a second
        // number).
        await tester.pump(HoldToTalkSurface.acceptHold);
        await tester.pump();
        expect(find.text('正在启动麦克风…'), findsOneWidget);
        // Not the recording sentence: this window is NOT recording (R11).
        expect(find.textContaining('松开 结束'), findsNothing);

        gate.complete(true);
        // Two pumps: the first lets the awaited continuation run its
        // setState, the second builds the frame that drops the label.
        await tester.pump();
        await tester.pump();
        expect(find.text('正在启动麦克风…'), findsNothing);

        await g.up();
        await tester.pump();
      },
    );

    test('the accept window is 300 ms — the latency budget owner bought', () {
      // A constant pin on purpose: bumping this back toward the old 500 ms
      // re-widens the dead window on EVERY hold, and nothing else red-flags
      // that (taps are still rejected either way).
      expect(HoldToTalkSurface.acceptHold, const Duration(milliseconds: 300));
    });
  });

  group('P6 · one permission probe per press, not two', () {
    test('a preflighted start skips the in-capture probe', () async {
      final _CountingRecorder rec = _CountingRecorder();
      final AudioCapture cap = AudioCapture(recorder: rec);
      await cap.start(permissionPreflighted: true);
      expect(rec.permissionProbes, 0);
      await cap.stop();

      // Positive control — the default path still probes (F-2063's gate is
      // untouched for every caller that did NOT just probe the OS itself).
      final _CountingRecorder rec2 = _CountingRecorder();
      final AudioCapture cap2 = AudioCapture(recorder: rec2);
      await cap2.start();
      expect(rec2.permissionProbes, 1);
      await cap2.stop();
    });

    test('the gate reports a definitive grant — and ONLY a definitive grant', () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(
        MicPermissionProbe.granted,
      );
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(),
      );
      expect(await flow.gateForPtt(), isTrue);
      expect(flow.lastGateSawGranted, isTrue);

      // `unavailable` also lets the press through, but must NOT claim a grant:
      // capture's own probe is the fallback that arm has always relied on.
      port.current = MicPermissionProbe.unavailable;
      expect(await flow.gateForPtt(), isTrue);
      expect(flow.lastGateSawGranted, isFalse);
    });
  });
}
