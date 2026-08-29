// Card CR-3 — the 「this capture is continuous」 flag, in isolation.
//
// SPEC-REF: apps/mobile/lib/src/audio/continuous_recording.dart
//
// 🔴 WHAT THIS FILE IS GUARDING. The two failure directions are not symmetric,
// and only one of them is loud:
//
//   · stuck FALSE ⇒ a continuous recording stops on link loss. That is the
//     product as it shipped before this card. Degraded, honest, safe.
//   · stuck TRUE  ⇒ the next ORDINARY push-to-talk press keeps its microphone
//     open after the link dies, and nothing will ever stop it. Silent, and it
//     is the exact hole SEG-2 was written to close.
//
// So the clearing paths are the subject, not the setting.
//
// The end-to-end behaviour is `ptt_continuous_link_loss_test.dart`; this file
// drives the holder against a plain StreamController so the clearing rules can
// be stated one at a time.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart' show RecorderState;
import 'package:flowmic/src/audio/continuous_recording.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late StreamController<RecorderState> states;
  late ContinuousRecording cont;

  setUp(() {
    states = StreamController<RecorderState>.broadcast();
    cont = ContinuousRecording(recorderState: states.stream);
  });

  tearDown(() async {
    await cont.dispose();
    await states.close();
  });

  /// The clear rides a broadcast stream, so it lands one microtask later. See
  /// `ContinuousRecording.isActive` for why that is unobservable in production.
  Future<void> emit(RecorderState s) async {
    states.add(s);
    await Future<void>.delayed(Duration.zero);
  }

  test('starts inactive — ordinary push-to-talk is the default', () {
    expect(cont.isActive, isFalse);
  });

  test('🔴 arming BEFORE the recorder starts survives its own starting '
      'position', () async {
    // `begin()` is called by the entry, which runs before `start()`. The
    // recorder is sitting in `stopped` at that moment, so a holder that read
    // the CURRENT state instead of subscribing to TRANSITIONS would clear the
    // flag it had just been given.
    cont.begin();
    expect(cont.isActive, isTrue);
    await emit(RecorderState.recording);
    expect(cont.isActive, isTrue);
  });

  test('🔴 the recorder stopping clears it — every ending path goes through '
      'that transition', () async {
    cont.begin();
    await emit(RecorderState.recording);
    await emit(RecorderState.stopped);
    expect(cont.isActive, isFalse);
  });

  test('🔴 pausing does NOT clear it — a backgrounded app resumes the same '
      'session', () async {
    cont.begin();
    await emit(RecorderState.recording);
    await emit(RecorderState.paused);
    expect(cont.isActive, isTrue,
        reason: 'the user took a call; the recording is not over');
    await emit(RecorderState.recording);
    expect(cont.isActive, isTrue);
  });

  test('🔴 end() covers the path the stream cannot: start() threw', () async {
    // Permission refused, or the platform recorder failed to attach. No
    // `stopped` transition is ever emitted, so without this the flag would sit
    // true waiting for an ordinary press to inherit it.
    cont.begin();
    cont.end();
    expect(cont.isActive, isFalse);
    // …and the next recorder that does start is NOT continuous.
    await emit(RecorderState.recording);
    expect(cont.isActive, isFalse);
  });

  test('begin() is idempotent, end() is idempotent', () async {
    cont.begin();
    cont.begin();
    expect(cont.isActive, isTrue);
    cont.end();
    cont.end();
    expect(cont.isActive, isFalse);
  });

  test('a second session arms cleanly after the first cleared', () async {
    cont.begin();
    await emit(RecorderState.recording);
    await emit(RecorderState.stopped);
    cont.begin();
    await emit(RecorderState.recording);
    expect(cont.isActive, isTrue);
  });

  test('🔴 dispose forces it false rather than freezing it', () async {
    // After dispose the auto-clear is gone. Leaving the flag at whatever it
    // last was would hand a disposed session's answer to anyone still holding
    // a reference — false is the safe direction (it degrades to the old
    // product) and it is also the true one: nothing is recording.
    cont.begin();
    await emit(RecorderState.recording);
    await cont.dispose();
    expect(cont.isActive, isFalse);
  });

  test('dispose is idempotent and survives a closed stream', () async {
    cont.begin();
    await cont.dispose();
    await cont.dispose();
    expect(cont.isActive, isFalse);
  });
}
