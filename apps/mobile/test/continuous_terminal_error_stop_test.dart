// Card RC-3 (MAIN addition, 2026-09-24) — a TERMINAL `stt:error` ends a long
// recording's capture, on the screen the recording is made on.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.2 (the microphone
//     ran on for 4:41 after the relay said the session was over)
//   apps/mobile/lib/src/ptt/ptt_continuous.dart `wireContinuousTerminalErrorStop`
//
// A terminal error (a bad key, an exhausted balance, the engine's own
// permanent refusal) cannot be fixed by retrying, so the relay is right to end
// transcription. What was wrong is the phone: nothing in the continuous path
// listened, the latch waited for a release a long recording never has, and the
// timer and the 「recording」 bar stayed up over a microphone whose words were
// going nowhere.
//
// Asserted on ChatFlowPage (⑥): the bar goes, the timer stops, the named
// reason is on screen, and the rows already said are still there. The reverse
// control is a RETRYABLE error on the same rig: the recording goes on.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart' show RecorderState;
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart' show articleMembersOf;
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';
import 'support/fakes.dart' show makePcm;

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const String _code = 'STT_ENGINE_AUTH_FAIL';

Future<(ArticleRig, String)> _recordingWithTwoRows(WidgetTester tester) async {
  final ArticleRig r = ArticleRig();
  addTearDown(() => tester.runAsync(r.dispose));
  late final String id;
  await tester.runAsync(() async {
    id = await r.startRecording();
    r.recorder.feed(makePcm(6400 * 5));
    await pumpEventQueue();
    await r.say('第一段已经成行', 0, isSegment: true);
    await r.say('第二段也成行了', 1, isSegment: true);
  });
  await mountLightRecordScreen(tester, r);
  expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget,
      reason: 'positive control: the long recording is on screen');
  return (r, id);
}

void _error(ArticleRig r, {required bool retryable}) =>
    r.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
      'code': _code,
      'message': 'engine refused the credentials',
      'retryable': retryable,
    });

void main() {
  testWidgets(
      '🔴 a terminal stt:error stops the long recording: bar gone, timer '
      'frozen, the named reason shown, the rows kept', (WidgetTester tester) async {
    final (ArticleRig r, String id) = await _recordingWithTwoRows(tester);

    await tester.runAsync(() async {
      _error(r, retryable: false);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // The capture is over, through the user's own stop.
    expect(r.session.audio.currentState, RecorderState.stopped);
    expect(r.session.continuous.isActive, isFalse);
    expect(r.transport.emittedNames, contains(FlowMicEvents.audioStop),
        reason: 'the ordinary stop: the tail and audio:stop went out');
    expect(find.byKey(ContinuousLiveKeys.bar), findsNothing);
    // The timer froze.
    final Duration frozen = r.controller.recording.elapsed;
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 600)));
    expect(r.controller.recording.elapsed, frozen);
    // The engine's own reason, in the sentence that code already has.
    expect(
      find.text(_zh.sttStallBannerMessage(
          const SttStall(SttStallReason.engineError, code: _code))),
      findsOneWidget,
    );
    // What was said is still there, as the recording it belongs to.
    expect(articleMembersOf(r.store, id), hasLength(2));
    expect(find.byType(ChatArticleTile), findsOneWidget);
    // The stall banner is event-type: let its auto-hide timer run out.
    await tester.pump(const Duration(seconds: 5));
    debugCancelAsrHealthTicker(r.controller);
  });

  testWidgets(
      'reverse control: a RETRYABLE stt:error leaves the long recording '
      'running', (WidgetTester tester) async {
    final (ArticleRig r, String _) = await _recordingWithTwoRows(tester);

    await tester.runAsync(() async {
      _error(r, retryable: true);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();

    expect(r.session.audio.currentState, RecorderState.recording);
    expect(r.session.continuous.isActive, isTrue);
    expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget);

    await tester.runAsync(() async {
      await r.controller.pttUp();
      r.session.endContinuous();
    });
    debugCancelAsrHealthTicker(r.controller);
  });
}
