// Card AW-1 — pure ASR-leg health tracker (docs/strategy/2026-08-27
// -project-status-log.md §A8 / §A10). This tracker has no production wiring
// yet (that is AW-1b); these tests drive it directly with a fake clock so
// they exercise the same threshold logic a real caller will eventually feed.
//
// §A8's own rule shapes every case below: byte stall, digital silence, "no
// first result", and "no progress" are FOUR SEPARATE signals that must never
// collapse into one sentence. Each test names which one signal it is
// isolating and asserts the other three stay clear.
//
// REVERSE CONTROL is at the bottom (two of them, both actually run): the
// sound-activity gate, and one threshold comparison. CLAUDE.md's rule is that
// a negative assertion is worthless unless someone has actually seen it fail.
//
// ── WHY VOICE ACTIVITY AND NOT "a nonzero byte" ─────────────────────────────
// `noFirstResult`/`noProgress` used to unlock on any nonzero PCM sample. A
// live microphone's noise floor makes essentially every delivery nonzero, so
// the gate was satisfied by an empty room: a user holding PTT and thinking for
// five seconds was told "still waiting for a transcription" at T1 and given
// the escalated sentence at T2, on a completely healthy path. The gate is now
// amplitude at/above `soundFloorDbfs`, sustained for
// `soundActivityMinDuration`, fed off the same dBFS meter the level bar draws.
// The two cases that pin it are `quiet room …` and `speech-level amplitude …`
// in the noFirstResult group below.

import 'package:flowmic/src/session/asr_health.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AsrHealthTracker — byte stall vs silence vs digital-zero (§A8)', () {
    test('byte stall NEVER fires before the first byte — that window is the '
        'recorder warming up, and "never opened" is AudioCapture\'s watchdog\'s '
        'fact, not this one\'s', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.tick(1000);
      expect(tracker.value.byteStall, isFalse,
          reason: 'one full window has passed with no byte, but no byte has '
              'EVER arrived — this is the recorder starting up');
      tracker.tick(60000);
      expect(tracker.value.byteStall, isFalse,
          reason: 'and it stays false however long we wait: a recorder that '
              'never opens is reported by AudioCapture.kDeadCaptureAfter, not '
              'by a stall claim this tracker cannot back');
      expect(tracker.value.digitalSilence, isFalse);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none);
      expect(tracker.value.noProgress, isFalse);
    });

    test('byte stall fires when bytes WERE flowing and then stopped, and only '
        'that signal', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(100, 6400, allZero: false);
      tracker.tick(1099);
      expect(tracker.value.byteStall, isFalse, reason: 'not past the window yet');
      tracker.tick(1100);
      expect(tracker.value.byteStall, isTrue);
      expect(tracker.value.digitalSilence, isFalse,
          reason: 'bytes stopping is not the same fact as zero-valued bytes');
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'noFirstResult is gated on VOICE ACTIVITY; no amplitude '
              'reading ever crossed the floor, so it must not fire here');
      expect(tracker.value.noProgress, isFalse);
    });

    test('nonzero bytes arriving clears byte stall even in a quiet room', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(500, 6400, allZero: false);
      tracker.tick(1400); // 900ms since last byte — under the 1000ms window
      expect(tracker.value.byteStall, isFalse);
      expect(tracker.value.digitalSilence, isFalse);
    });

    test('digital silence fires when bytes keep arriving but are all zero, '
        'and is distinct from byte stall', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 5000),
        digitalSilenceWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: true);
      tracker.tick(999);
      expect(tracker.value.digitalSilence, isFalse, reason: 'not past window yet');
      tracker.bytesArrived(999, 6400, allZero: true);
      tracker.tick(1000);
      expect(tracker.value.digitalSilence, isTrue);
      expect(tracker.value.byteStall, isFalse,
          reason: 'bytes ARE arriving — this is a content fact, not an '
              'absence-of-bytes fact');
    });

    test('a single nonzero delivery clears an in-progress digital-silence span', () {
      final tracker = AsrHealthTracker(
        digitalSilenceWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: true);
      tracker.bytesArrived(500, 6400, allZero: false);
      tracker.tick(1500);
      expect(tracker.value.digitalSilence, isFalse,
          reason: 'the all-zero span was interrupted by a nonzero chunk');
    });
  });

  group('AsrHealthTracker — noFirstResult vs VAD-quiet-room (§A8 P2-7 推论)', () {
    test('quiet room: a live mic at its noise floor for 12 s with no interim '
        'raises NOTHING — the nonzero bytes it delivers are not speech', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 1500),
        noFirstResultT1: const Duration(milliseconds: 4000),
        noFirstResultT2: const Duration(milliseconds: 9000),
        soundFloorDbfs: -45.0,
      );
      tracker.recordingStarted(0);
      // 200ms chunks, exactly what AudioCapture delivers: bytes keep arriving
      // (so byteStall stays clear, correctly) and every one of them is
      // NONZERO — room tone, -60 dBFS, well under the -45 floor.
      for (int t = 200; t <= 12000; t += 200) {
        tracker.bytesArrived(t, 6400, allZero: false);
        tracker.amplitudeObserved(t, -60.0);
      }
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'nobody spoke. There is nothing to transcribe, so "still '
              'waiting for a transcription" would be a claim the tracker '
              'cannot back — this is the 5-seconds-of-thinking case');
      expect(tracker.value.noProgress, isFalse);
      expect(tracker.value.byteStall, isFalse,
          reason: 'bytes never stopped');
      expect(tracker.value.digitalSilence, isFalse,
          reason: 'the samples were not zero — room tone is not digital '
              'silence');
    });

    test('speech-level amplitude for 12 s with no interim DOES fire: level1 at '
        'T1, level2 at T2', () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 4000),
        noFirstResultT2: const Duration(milliseconds: 9000),
        soundFloorDbfs: -45.0,
      );
      tracker.recordingStarted(0);
      for (int t = 200; t <= 3800; t += 200) {
        tracker.bytesArrived(t, 6400, allZero: false);
        tracker.amplitudeObserved(t, -20.0);
      }
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'somebody is speaking, but T1 has not elapsed yet');
      tracker.amplitudeObserved(4000, -20.0);
      expect(tracker.value.noFirstResult, AsrHealthLevel.level1);
      for (int t = 4200; t <= 12000; t += 200) {
        tracker.bytesArrived(t, 6400, allZero: false);
        tracker.amplitudeObserved(t, -20.0);
      }
      expect(tracker.value.noFirstResult, AsrHealthLevel.level2);
    });

    test('one loud transient is NOT sound activity — the level must be '
        'sustained for soundActivityMinDuration', () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 1000),
        soundFloorDbfs: -45.0,
        soundActivityMinDuration: const Duration(milliseconds: 300),
      );
      tracker.recordingStarted(0);
      tracker.amplitudeObserved(100, -10.0); // a door slam
      tracker.amplitudeObserved(300, -70.0); // back under the floor
      tracker.tick(5000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'the above-floor run lasted 200ms, under the 300ms minimum');
      // Two consecutive above-floor chunks DO clear the minimum.
      tracker.amplitudeObserved(5200, -20.0);
      tracker.amplitudeObserved(5500, -20.0);
      tracker.tick(6500);
      expect(tracker.value.noFirstResult, AsrHealthLevel.level1);
    });

    test('a truly dead mic (zero bytes) never raises noFirstResult', () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 4000),
      );
      tracker.recordingStarted(0);
      tracker.tick(10000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none);
      expect(tracker.value.byteStall, isFalse,
          reason: 'no byte ever arrived, so nothing stalled — AudioCapture\'s '
              'dead-capture watchdog owns that fact');
    });

    test('an interim landing clears noFirstResult permanently for this utterance', () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(100, 6400, allZero: false);
      tracker.amplitudeObserved(100, -20.0);
      tracker.amplitudeObserved(500, -20.0);
      tracker.tick(2000);
      expect(tracker.value.noFirstResult, isNot(AsrHealthLevel.none));
      tracker.interimArrived(2100);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none);
      tracker.tick(9000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'the first result already arrived; this signal cannot re-fire');
    });
  });

  group('AsrHealthTracker — noProgress independent of noFirstResult', () {
    test('noProgress never fires before any interim/final has arrived', () {
      final tracker = AsrHealthTracker(
        noProgressWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      tracker.amplitudeObserved(0, -20.0);
      tracker.amplitudeObserved(400, -20.0);
      tracker.tick(5000);
      expect(tracker.value.noProgress, isFalse,
          reason: 'there has been no progress to stall FROM yet — that state '
              'is noFirstResult\'s to report, not noProgress\'s');
    });

    test('noProgress fires when the last interim goes stale while sound '
        'keeps arriving', () {
      final tracker = AsrHealthTracker(
        noProgressWindow: const Duration(milliseconds: 2000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      // Sound the whole way through — the amplitude meter runs at one reading
      // per chunk in production, so a room that is still making noise keeps
      // feeding this. Somebody IS still talking and nothing is coming back.
      for (int t = 0; t <= 2500; t += 200) {
        tracker.amplitudeObserved(t, -20.0);
      }
      tracker.interimArrived(500);
      tracker.bytesArrived(2000, 6400, allZero: false);
      tracker.amplitudeObserved(2499, -20.0);
      expect(tracker.value.noProgress, isFalse);
      tracker.amplitudeObserved(2500, -20.0);
      expect(tracker.value.noProgress, isTrue);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'a first result DID arrive — this is a stall-after-progress, '
              'not a no-first-result case; the two must not be conflated');
    });

    test('🔴 a deliberate pause is NOT no-progress — the gate asks for RECENT '
        'sound, not a latch', () {
      // The defect this pins: the gate used to be a latch that never cleared
      // inside a recording, so somebody who spoke, got their interim and then
      // stopped to think was told six seconds later that no new words had come
      // back. Nothing new had been said. The engine cannot fall behind on
      // audio it was never given, and a warning that fires on correct product
      // behaviour is the sentence R11 forbids.
      final tracker = AsrHealthTracker(
        noProgressWindow: const Duration(milliseconds: 2000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      tracker.amplitudeObserved(0, -20.0);
      tracker.amplitudeObserved(400, -20.0);
      tracker.interimArrived(500);
      // …and then the room goes quiet. Bytes still arrive (a live mic always
      // delivers) and the meter still reads, but below the floor.
      for (int t = 600; t <= 6000; t += 200) {
        tracker.bytesArrived(t, 6400, allZero: false);
        tracker.amplitudeObserved(t, -70.0);
      }
      expect(tracker.value.noProgress, isFalse,
          reason: 'no sound has reached the microphone for 5.6s; there is '
              'nothing for the engine to be behind on');

      // Speak again, and the signal becomes answerable once the sound has run
      // long enough to count and the interim is still stale.
      for (int t = 6200; t <= 6800; t += 200) {
        tracker.amplitudeObserved(t, -20.0);
      }
      expect(tracker.value.noProgress, isTrue,
          reason: 'sound is back and the last interim is 6.3s old — now the '
              'engine really is behind');
    });

    test('a fresh interim clears noProgress', () {
      final tracker = AsrHealthTracker(
        noProgressWindow: const Duration(milliseconds: 1000),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      for (int t = 0; t <= 1500; t += 200) {
        tracker.amplitudeObserved(t, -20.0);
      }
      tracker.interimArrived(0);
      tracker.tick(1500);
      expect(tracker.value.noProgress, isTrue);
      tracker.interimArrived(1600);
      expect(tracker.value.noProgress, isFalse);
    });
  });

  group('AsrHealthTracker — terminal / retryable errors', () {
    test('terminal error is visible IMMEDIATELY, even while still recording, '
        'and is not latched away', () {
      final tracker = AsrHealthTracker();
      tracker.recordingStarted(0);
      expect(tracker.value.terminalError, isNull);
      tracker.terminalError(50, code: 'STT_CONFIG_MISSING', message: 'boom');
      expect(tracker.value.terminalError,
          const AsrTerminalError(code: 'STT_CONFIG_MISSING', message: 'boom'));
    });

    test('retryable error increments a counter and never sets terminalError', () {
      final tracker = AsrHealthTracker();
      tracker.recordingStarted(0);
      tracker.retryableError(10, code: 'ENGINE_RECONNECTING');
      tracker.retryableError(20, code: 'ENGINE_RECONNECTING');
      expect(tracker.value.retryableBounces, 2);
      expect(tracker.value.terminalError, isNull,
          reason: 'a bounce that eventually recovers must not read as fatal');
    });
  });

  group('AsrHealthTracker — clears on recordingEnded', () {
    test('every signal clears when the recording ends', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 100000),
        digitalSilenceWindow: const Duration(milliseconds: 100),
        noFirstResultT1: const Duration(milliseconds: 100),
        noProgressWindow: const Duration(milliseconds: 100),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: true);
      tracker.terminalError(50, code: 'X');
      tracker.retryableError(60, code: 'Y');
      tracker.tick(500);
      // Sanity: something is actually set before we assert it clears.
      expect(tracker.value.digitalSilence, isTrue);
      expect(tracker.value.terminalError, isNotNull);
      expect(tracker.value.retryableBounces, greaterThan(0));

      tracker.recordingEnded(600);
      expect(tracker.value, AsrHealthSnapshot.clear);

      // And a stale tick after the recording ended must not resurrect anything.
      tracker.tick(100000);
      expect(tracker.value, AsrHealthSnapshot.clear);
    });

    test('a fresh recordingStarted also wipes signals left by a previous utterance', () {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 100),
      );
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      tracker.tick(200);
      expect(tracker.value.byteStall, isTrue);
      tracker.terminalError(200, code: 'X');

      tracker.recordingStarted(1000);
      expect(tracker.value, AsrHealthSnapshot.clear,
          reason: 'the previous utterance\'s fault must not leak into the next');
    });
  });

  group('AsrHealthTracker — sound-activity evidence does not leak', () {
    test('the latch clears on recordingEnded and on a fresh recordingStarted',
        () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 1000),
        soundFloorDbfs: -45.0,
      );
      tracker.recordingStarted(0);
      tracker.amplitudeObserved(0, -20.0);
      tracker.amplitudeObserved(400, -20.0);
      tracker.tick(2000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.level1,
          reason: 'sanity: somebody spoke in the FIRST utterance');

      tracker.recordingEnded(2100);
      tracker.recordingStarted(3000);
      tracker.bytesArrived(3000, 6400, allZero: false);
      tracker.tick(9000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none,
          reason: 'the previous utterance\'s speech is not evidence that '
              'anybody has spoken into THIS one');
    });

    test('amplitude readings outside a recording are ignored entirely', () {
      final tracker = AsrHealthTracker(
        noFirstResultT1: const Duration(milliseconds: 1000),
      );
      tracker.amplitudeObserved(0, -10.0);
      tracker.amplitudeObserved(500, -10.0);
      tracker.recordingStarted(1000);
      tracker.bytesArrived(1000, 6400, allZero: false);
      tracker.tick(5000);
      expect(tracker.value.noFirstResult, AsrHealthLevel.none);
    });
  });

  group('AsrHealthTracker — ValueListenable / stream parity', () {
    test('value and the stream form emit the same snapshots', () async {
      final tracker = AsrHealthTracker(
        byteStallWindow: const Duration(milliseconds: 100),
      );
      final emitted = <AsrHealthSnapshot>[];
      final sub = tracker.stream.listen(emitted.add);
      tracker.recordingStarted(0);
      tracker.bytesArrived(0, 6400, allZero: false);
      tracker.tick(200);
      await Future<void>.delayed(Duration.zero);
      expect(emitted, isNotEmpty);
      expect(emitted.last, tracker.value);
      await sub.cancel();
    });
  });
}

// ── REVERSE CONTROL #1: THE VOICE-ACTIVITY GATE ──────────────────────────
//
// Removed the gate the way it stood before this fix — in asr_health.dart,
// `_recompute`'s noFirstResult condition changed from
//   `if (_sawSoundActivity && _lastInterimOrFinalAtMs == null) {`
// back to a nonzero-byte gate
//   `if (_lastByteAtMs != null && _lastInterimOrFinalAtMs == null) {`
// and reran this file. The quiet-room case is the one that must go red,
// because that is the whole finding: a healthy quiet path being reported as a
// fault.
//
// RED, before restoring (`flutter test --timeout 90s --reporter compact
// test/asr_health_test.dart`, actually run):
//
//   00:01 +5 -1: AsrHealthTracker — noFirstResult vs VAD-quiet-room (§A8 P2-7
//   推论) quiet room: a live mic at its noise floor for 12 s with no interim
//   raises NOTHING — the nonzero bytes it delivers are not speech [E]
//     Expected: AsrHealthLevel:<AsrHealthLevel.none>
//       Actual: AsrHealthLevel:<AsrHealthLevel.level2>
//     nobody spoke. There is nothing to transcribe, so "still waiting for a
//     transcription" would be a claim the tracker cannot back — this is the
//     5-seconds-of-thinking case
//   00:01 +16 -4: Some tests failed.
//
// (four red, not one: the other three are the sustained-duration case and the
// two evidence-does-not-leak cases — every assertion that depends on the gate
// measuring SPEECH rather than "a byte showed up".)
//
// Restored and reran — GREEN, actually run:
//
//   00:06 +20: All tests passed!
//
// ── REVERSE CONTROL #2 (manually run, evidence quoted, then restored) ─────
//
// Changed asr_health.dart's noFirstResult comparison from
//   `if (elapsed >= noFirstResultT1.inMilliseconds)`
// to
//   `if (elapsed > noFirstResultT1.inMilliseconds)`
// and reran this file.
//
// RED, before restoring (`flutter test --timeout 90s --reporter compact
// test/asr_health_test.dart`, actually run):
//
//   00:01 +5 -1: AsrHealthTracker — noFirstResult vs VAD-quiet-room (§A8 P2-7
//   推论) nonzero (VAD-quiet) bytes with no interim: silent before T1, fires
//   level1 at/after T1 [E]
//     Expected: AsrHealthLevel:<AsrHealthLevel.level1>
//     Actual: AsrHealthLevel:<AsrHealthLevel.none>
//     package:matcher  expect
//     test/asr_health_test.dart 109:7  main.<fn>.<fn>
//   00:01 +15 -1: Some tests failed.
//
// (the run then continues and fails 15 total, because every later test in
// the file still executes — the ONE assertion that actually depends on the
// broken comparison is the one at line 109, which is the point.)
//
// Restored the `>=` and reran — GREEN, actually run:
//
//   00:01 +16: All tests passed!
//
// `git diff --stat apps/mobile/lib/src/session/asr_health.dart` after
// restoring: empty — nothing was left behind.
