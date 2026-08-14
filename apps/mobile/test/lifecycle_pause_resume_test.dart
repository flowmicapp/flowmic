// R6 P0-R5 + card F1 acceptance — the app-lifecycle → session pause/resume bridge.
// Before this seam, nothing implemented WidgetsBindingObserver, so background /
// lock-screen left capture running or dropped it silently (08 §B-3 never stop silently).
//
// 🔴 card F1 / owner ruling ①:「电脑应该认为手机是『暂停』（还在配对，只是胶囊收起）」.
// That moved TWO things:
//  ① WHICH EDGES COUNT. Only [AppLifecycleState.paused] is a background. The
//     SDK's own enum doc (bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher
//     .dart) is the judge, and it is explicit on both halves:
//       · `inactive` — 「a system dialog, another view… It will also be inactive
//         when the notification window shade is down, or the application switcher
//         is visible」 ⇒ the microphone-permission dialog (card U2's
//         `Permission.microphone.request()`), the shade and the app switcher are
//         ALL inactive. Counting them collapses the PC capsule for a dialog the
//         user opened one second ago — the flicker this card exists to prevent.
//       · `hidden` — 「a transition to this state is synthesized before the
//         [paused] state is entered when coming from [inactive], AND before the
//         [inactive] state is entered when coming from [paused]」 ⇒ it fires on
//         the way BACK too. Counting it means re-pausing during the return.
//       · `paused` — 「The application is not currently visible to the user」.
//         That is the whole definition of "switched to background" and nothing else is.
//  ② WHAT THE PHONE SENDS WHEN IDLE. Backgrounding while nothing is recording
//     used to send NOTHING (both PttSession guards were whole-method no-ops), so
//     the PC could not tell "the phone paused" from "the phone is still talking". The wire event is
//     now emitted on the lifecycle edge itself; only the RECORDER work stays
//     behind the recorder-state guard.
//
// Two layers, deliberately split (lead review refactor — the original single testWidgets
// drove a REAL PttSession inside the widget-test FakeAsync zone and deadlocked:
// a directly-awaited real async chain never completes there):
//  1. widget layer — AppLifecycleBridge maps lifecycle edges to the injected
//     callbacks (counters; the callbacks complete synchronously so the FakeAsync
//     zone never blocks);
//  2. session layer — plain test() (real async, same harness pattern as
//     chat_controller_test) proves what a REAL PttSession puts on the wire.
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §3 / §B-3.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/ui/app_lifecycle_bridge.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

void main() {
  group('AppLifecycleBridge (widget layer)', () {
    /// Pumps [states] through the observer and returns (background, foreground)
    /// call counts — every edge case below is one sequence and two numbers.
    Future<(int, int)> run(WidgetTester tester, List<AppLifecycleState> states) async {
      int background = 0;
      int foreground = 0;
      await tester.pumpWidget(
        AppLifecycleBridge(
          onBackground: () {
            background += 1;
            return Future<void>.value();
          },
          onForeground: () {
            foreground += 1;
            return Future<void>.value();
          },
          child: const SizedBox(),
        ),
      );
      for (final AppLifecycleState s in states) {
        tester.binding.handleAppLifecycleStateChanged(s);
        await tester.pump();
      }
      return (background, foreground);
    }

    testWidgets('the real Android away-and-back chain is exactly ONE pause and ONE resume',
        (WidgetTester tester) async {
      // Away: inactive → hidden → paused. Back: hidden → inactive → resumed.
      // `hidden` appears on BOTH legs (SDK doc, quoted in the file header) — the
      // pre-F1 mapping fired onBackground FOUR times across this one round trip,
      // twice of them while the app was coming back.
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]);
      expect(bg, 1);
      expect(fg, 1);
    });

    testWidgets('🔴 a microphone-permission dialog does NOT count as background',
        (WidgetTester tester) async {
      // card U2 landed `Permission.microphone.request()` on first PTT. The Android
      // dialog is a system dialog over a still-visible activity ⇒ `inactive`,
      // never `paused` (SDK doc). If this ever fires, the PC capsule collapses
      // while the user is looking at OUR permission prompt.
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]);
      expect(bg, 0);
      // …and the return edge is silent too: a resume nobody paused would surface
      // a capsule the PC user had dismissed.
      expect(fg, 0);
    });

    testWidgets('the notification shade / app switcher / control centre are inert',
        (WidgetTester tester) async {
      // Same shape as the dialog, listed separately because these are the three
      // the SDK names by hand and they are the ones users hit constantly.
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.inactive, // shade down
        AppLifecycleState.resumed,
        AppLifecycleState.inactive, // app switcher
        AppLifecycleState.resumed,
        AppLifecycleState.inactive, // control centre (iOS)
        AppLifecycleState.resumed,
      ]);
      expect(bg, 0);
      expect(fg, 0);
    });

    testWidgets('hidden alone never counts (it also fires on the way back)',
        (WidgetTester tester) async {
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.hidden,
        AppLifecycleState.resumed,
      ]);
      expect(bg, 0);
      expect(fg, 0);
    });

    testWidgets('a repeated paused edge is idempotent; detached fires neither',
        (WidgetTester tester) async {
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.paused,
        AppLifecycleState.paused,
        AppLifecycleState.detached,
      ]);
      expect(bg, 1);
      expect(fg, 0);
    });

    testWidgets('two full round trips pair up 2:2', (WidgetTester tester) async {
      final (int bg, int fg) = await run(tester, <AppLifecycleState>[
        AppLifecycleState.paused,
        AppLifecycleState.resumed,
        AppLifecycleState.paused,
        AppLifecycleState.resumed,
      ]);
      expect(bg, 2);
      expect(fg, 2);
    });

    testWidgets('observer unregisters on dispose (no callbacks after teardown)',
        (WidgetTester tester) async {
      int calls = 0;
      await tester.pumpWidget(
        AppLifecycleBridge(
          onBackground: () {
            calls += 1;
            return Future<void>.value();
          },
          onForeground: () {
            calls += 1;
            return Future<void>.value();
          },
          child: const SizedBox(),
        ),
      );
      await tester.pumpWidget(const SizedBox()); // bridge disposed
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(calls, 0);
    });
  });

  group('PttSession pause/resume on the wire (session layer, real async)', () {
    test('🔴 card F1 — backgrounding while IDLE still tells the PC "paused"', () async {
      // The owner ruling's actual scenario: the user is paired, is not saying
      // anything, and switches windows. Pre-F1 this emitted NOTHING — the PC had
      // no way to distinguish it from "the phone is still there", so the capsule stayed up.
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      transport.pushStatus(SocketStatus.connected);
      await pumpEventQueue();

      await session.pauseCapture(reason: 'background');
      expect(transport.emittedWhere(FlowMicEvents.audioPause), hasLength(1));
      expect(
        (transport.emittedWhere(FlowMicEvents.audioPause).single.data
            as Map<String, Object?>)['reason'],
        'background',
      );

      await session.resumeCapture();
      expect(transport.emittedWhere(FlowMicEvents.audioResume), hasLength(1));

      await session.dispose();
      await transport.close();
    });

    test('recording → background pauses the RECORDER too, and resume restores it', () async {
      // The half that already worked and must keep working: an in-flight
      // utterance stops feeding the engine, and seq stays monotonic (08 §3).
      final FakeSocketTransport transport = FakeSocketTransport();
      final AudioCapture audio = AudioCapture(recorder: FakeAudioRecorder());
      final PttSession session = newTestSession(transport: transport, audio: audio);
      transport.pushStatus(SocketStatus.connected);
      await pumpEventQueue();
      expect(await session.pttDown(), isTrue);
      expect(audio.currentState, RecorderState.recording);

      await session.pauseCapture(reason: 'background');
      expect(audio.currentState, RecorderState.paused);
      expect(transport.emittedWhere(FlowMicEvents.audioPause), hasLength(1));

      await session.resumeCapture();
      expect(audio.currentState, RecorderState.recording);
      expect(transport.emittedWhere(FlowMicEvents.audioResume), hasLength(1));

      await session.dispose();
      await transport.close();
    });
  });
}
