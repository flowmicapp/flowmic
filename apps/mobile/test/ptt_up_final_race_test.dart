// 0.3.43 Q5-② — A FAST stt:final MUST NOT BE REFUSED BY OUR OWN ORDERING.
//
// Ruling:
//   docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q5-②
// Contract: docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md §1.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
// `PttSession.pttUp()` emits `audio:stop` and then had `await audio.stop()`
// BEFORE `fsm.onPttUp()`. That await is real work — retain the unsent tail
// (disk) plus detach the platform recorder — and the server is already
// transcribing, because the stop frame left one line earlier. A terminal
// `stt:final` arriving inside that window met an FSM still in RECORDING, and
// `onSttFinal` refuses anything that is not PROCESSING
// (`_refuse('sttFinal', 'requires session=processing')`).
//
// The final was therefore DROPPED, the 15 s processing net had never been armed
// (arming is `onPttUp`'s job), and the user was eventually shown 「没等到结果」
// ("no result came back") — a banner blaming the link for a transcript that had
// arrived and that we discarded. R11: a status word with no failure anywhere
// underneath it.
//
// ── WHY THE TEST LOOKS LIKE THIS ─────────────────────────────────────────────
// A Dart `async` body runs SYNCHRONOUSLY up to its first `await`. So calling
// `pttUp()` without awaiting it, and pushing the final on the very next line,
// lands the frame exactly in the gap:
//   · old order — the first await is `audio.stop()`, so the body suspends
//     BEFORE `fsm.onPttUp()` and the final meets RECORDING ⇒ refused;
//   · new order — `fsm.onPttUp()` has already run, so the final meets
//     PROCESSING ⇒ accepted.
// No fake clock, no injected delay: the race is reproduced by the language's
// own scheduling rule, which is the same rule production runs under.
//
// ── REVERSE CONTROL (it really went red) ─────────────────────────────────────
// Swapping the two lines in `pttUp()` back (`await audio.stop();` then
// `fsm.onPttUp();`) and re-running THIS file, on dev-pc-a:
//
//   00:03 +0 -1: a terminal stt:final arriving during audio.stop() is honoured [E]
//     Expected: SessionState:<SessionState.justDone>
//       Actual: SessionState:<SessionState.recording>
//   00:03 +1 -1: Some tests failed.
//
// — i.e. the final was refused and the utterance never left RECORDING.
//
// ⚠️ THE F-2223 CASE BELOW STAYED GREEN THROUGH THAT SWAP (the `+1`), which is
// exactly what it is here to say: the wire order is not what this change
// touched, so it cannot be the thing that proves the change. Restored, both
// green.
//
// ⚠️ F-2223 IS NOT TOUCHED BY ANY OF THIS, and it is checked here as well as in
// ptt_session_test.dart: the residual sub-chunk is still emitted first and
// `audio:stop` second, both ahead of everything that moved. No emit changed
// position — only the FSM edge did.
//
// ⚠️ THE ONE SIDE EFFECT, STATED RATHER THAN DISCOVERED LATER:
// `_onCapturedChunk` drops chunks while the session is not RECORDING, so a full
// 200 ms chunk completing DURING `audio.stop()` is now discarded instead of
// emitted. That window is already past `audio:stop` on the wire (it always
// was), the sub-200 ms tail F-2223 exists for has been taken and emitted above
// it, and `audio.stop()` clears the accumulator regardless — so what actually
// changes is that a post-stop chunk can no longer reach the server AFTER the
// stop frame it is supposed to precede.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

void main() {
  // The same fixture ptt_session_test.dart builds, for the same reasons — see
  // its setUp for why the health probe is answered here rather than left to
  // whatever is listening on the developer's box (RV-89).
  late FakeSocketTransport t;
  late FakeAudioRecorder rec;
  late PttSession session;

  setUp(() {
    t = FakeSocketTransport()..connectSucceeds = true;
    rec = FakeAudioRecorder();
    session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: rec),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
      micPermission: newTestMicPermission(),
    );
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
  });

  tearDown(() => session.dispose());

  Future<void> pair() async {
    t.defaultAck = <String, Object?>{
      'token': 'tok-abcdefghijklmnopqrstuvwxyz012345',
      'pairing_id': 'pair-race',
      'pc_name': 'Race PC',
    };
    final PairResult r = await session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://127.0.0.1:41879',
    );
    expect(r.ok, isTrue, reason: 'harness pair failed: ${r.error}');
  }

  test('a terminal stt:final arriving during audio.stop() is honoured', () async {
    await pair();
    expect(await session.pttDown(), isTrue);
    expect(session.fsm.session, SessionState.recording);

    // Deliberately NOT awaited — see the header. This suspends inside pttUp at
    // its first await, which is `audio.stop()`.
    final Future<void> up = session.pttUp();

    // The transcript comes back while the recorder is still being torn down.
    t.pushIncoming('stt:final', <String, Object?>{
      'text': '你好世界',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });

    // 🔴 THE ASSERTION: the FSM took the final instead of refusing it. JUST_DONE
    // is only reachable through `onSttFinal`, so this cannot be satisfied by
    // anything except the final actually landing.
    expect(session.fsm.session, SessionState.justDone);
    expect(session.segments.joined, '你好世界');

    await up;
  });

  test('F-2223 ordering is unchanged: residual chunk, then audio:stop', () async {
    // The constraint this change had to respect. Kept HERE as well as in
    // ptt_session_test.dart on purpose: that file owns the full chain, this one
    // owns the reordering — and a reorder that quietly moved an emit would show
    // up here, beside the reason it was allowed.
    await pair();
    expect(await session.pttDown(), isTrue);
    // A sub-chunk tail (< 6400 B) so `takeResidualChunk` has something to pop.
    rec.feed(makePcm(3200));
    await pumpEventQueue();

    await session.pttUp();

    final List<String> names = t.emittedNames;
    expect(names.contains('audio:chunk'), isTrue);
    expect(
      names.lastIndexOf('audio:chunk'),
      lessThan(names.indexOf('audio:stop')),
    );
    expect(names.last, 'audio:stop');
  });
}
