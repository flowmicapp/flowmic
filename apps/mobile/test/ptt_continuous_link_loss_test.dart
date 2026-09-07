// Card CR-3 — A CONTINUOUS RECORDING KEEPS ITS MICROPHONE THROUGH A LINK DEATH.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §8-bis card CR-3
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//   apps/mobile/lib/src/ptt/ptt_link_loss.dart (the edge under test)
//   apps/mobile/lib/src/audio/continuous_recording.dart (the flag)
//
// ── WHAT MAKES THIS FILE WORTH ITS LENGTH ────────────────────────────────────
//
// The change is four lines of behaviour, and every one of its failure modes is
// SILENT:
//   · fail to keep the mic  ⇒ a 30-minute meeting ends at minute 4 and the user
//     finds out afterwards;
//   · keep it when there is no retention layer ⇒ the mic runs, the 30 s ring
//     evicts, and the words cease to exist — the exact hole SEG-2 closed;
//   · leave the flag set ⇒ the NEXT ordinary press inherits a microphone that
//     nothing will ever stop.
//
// None of the three raises anything. So each gets its own test, and the third
// gets one even though no production code sets the flag twice yet — the whole
// point of binding it to the recorder's stream was to make that impossible, and
// an invariant nobody asserts is a comment.
//
// Real PttSession + real FSM + real AudioCapture + real spill + real store on
// disk; only the socket and the OS recorder are doubles. Real time, not
// fakeAsync, for the same reason ptt_link_loss_test.dart gives: retention
// writes are real file I/O and never complete inside a FakeAsync zone.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const Duration _grace = Duration(milliseconds: 80);
const Duration _pastGrace = Duration(milliseconds: 250);

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;
  late FakeSocketTransport transport;
  late FakeAudioRecorder recorder;
  late AudioCapture capture;
  late PttSession session;
  late List<String> stopReasons;

  /// Builds the whole production chain. [withRetention] false is the degraded
  /// build `retained_audio_boot.dart` produces when the store cannot be opened
  /// — the case test ③ exists for.
  Future<void> build({bool withRetention = true}) async {
    DiagLog.instance.clear();
    tmp = await Directory.systemTemp.createTemp('flowmic-cr3-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    capture = AudioCapture(
      recorder: recorder,
      spill: withRetention ? spill : null,
    );
    session = newTestSession(
      transport: transport,
      audio: capture,
      stateMachine: FlowmicStateMachine(sessionDropGrace: _grace),
      heartbeatInterval: const Duration(milliseconds: 40),
    );
    stopReasons = <String>[];
    session.autoStopped.listen(stopReasons.add);
    transport.pushStatus(SocketStatus.connected);
  }

  tearDown(() async {
    await session.dispose();
    await transport.close();
    // `stopForLinkLoss` queues its retention writes with `unawaited`, so on
    // Windows the directory below is still held open when a test ends by
    // stopping. Draining is the fix, not a try/catch around the delete: a
    // swallowed teardown error is how a real I/O failure would hide.
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  });

  Future<void> recordSomeAudio() async {
    expect(await session.pttDown(), isTrue,
        reason: 'positive control: the production chain entered RECORDING');
    recorder.feed(makePcm(kChunkBytes));
    recorder.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);
  }

  /// The auto-clear rides a broadcast stream, so it lands one microtask after
  /// the recorder stops. See `ContinuousRecording.isActive` for why that lag is
  /// unobservable in production — here we simply let the turn run.
  Future<void> settle() => Future<void>.delayed(Duration.zero);

  Future<void> killTheLink() async {
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
  }

  test('🔴 ① continuous + retention: the grace expires and the microphone is '
      'STILL RECORDING', () async {
    await build();
    session.continuous.begin();
    await recordSomeAudio();
    final int framesBeforeDrop = transport.emitted.length;

    await killTheLink();

    // The card, in one line. Everything below says why we believe it.
    expect(capture.currentState, RecorderState.recording,
        reason: 'an ordinary press stops here; a continuous session does not');
    // Retention is ARMED — this is what makes keeping the mic an improvement
    // rather than the pre-SEG-2 hole. Evictions from here go to disk.
    expect(spill.uplinkUp, isFalse);
    // The user was NOT told the recording ended, because it did not.
    expect(stopReasons, isEmpty,
        reason: 'a stop notice here would be a false statement about a '
            'recording that is still running');
    // Still nothing on the wire: the link is dead either way.
    expect(transport.emitted.length, framesBeforeDrop);
    expect(transport.emittedWhere('audio:stop'), isEmpty);
    // The trail names WHICH branch ran — the two are indistinguishable from
    // the outside otherwise, and this is the line a real-device forensic reads.
    final List<String> log = DiagLog.instance.snapshot();
    expect(log.where((String l) => l.contains('continuous_kept_open')),
        hasLength(1));
    expect(log.where((String l) => l.contains('audio.link_loss.stopped')),
        isEmpty);
  });

  test('🔴 ② the face is licensed only while all of it is true', () async {
    await build();
    session.continuous.begin();
    await recordSomeAudio();
    expect(session.continuousCapturingOffline, isFalse,
        reason: 'the link is still UP — nothing offline to announce');

    await killTheLink();
    expect(session.continuousCapturingOffline, isTrue);

    // …and it stops being true the moment the recording does, which is what
    // makes the banner a STATE-type fact that self-clears instead of a notice
    // somebody has to remember to take down.
    await session.pttUp();
    await settle();
    expect(session.continuousCapturingOffline, isFalse);
  });

  test('🔴 ②b THE STOP BUTTON STILL WORKS after the link died — this is the '
      'assertion that found the defect', () async {
    // Keeping the microphone open made `pttUp` unreachable: it opens with
    // `if (fsm.session != recording) return;` and the grace expiry had already
    // moved the session to `disconnected`. The recorder ran until the app was
    // killed, which is the very failure this card is supposed to remove.
    await build();
    session.continuous.begin();
    await recordSomeAudio();
    await killTheLink();
    expect(capture.currentState, RecorderState.recording,
        reason: 'positive control: we are in the state under test');

    await session.pttUp(); // the user presses stop
    await settle();

    expect(capture.currentState, RecorderState.stopped,
        reason: 'the user asked for it to end, so it ends');
    expect(session.continuous.isActive, isFalse);
    // And they are TOLD, on the same chain every other ending uses — a
    // recording that ends without saying so is the silent half of the red line.
    expect(stopReasons, hasLength(1));
    expect(
      DiagLog.instance
          .snapshot()
          .where((String l) => l.contains('continuous.stopped_offline')),
      hasLength(1),
    );
    // Nothing on the wire: there is still no link to say it on.
    expect(transport.emittedWhere('audio:stop'), isEmpty);
  });

  test('🔴 ③ THE HONESTY GATE: continuous with NO retention layer falls back '
      'to stopping — a mic with nowhere to write is worse than no mic',
      () async {
    await build(withRetention: false);
    session.continuous.begin();
    await recordSomeAudio();

    await killTheLink();

    expect(capture.currentState, RecorderState.stopped,
        reason: 'without a spill the ring just evicts and the words cease to '
            'exist (this file header, and ptt_link_loss.dart\'s); the old '
            'behaviour at least TELLS the user');
    expect(stopReasons, hasLength(1),
        reason: 'and it goes up the ordinary notice chain');
    expect(session.continuousCapturingOffline, isFalse,
        reason: 'nothing may claim the audio is kept on this phone');
    final List<String> log = DiagLog.instance.snapshot();
    expect(log.where((String l) => l.contains('continuous_no_retention')),
        hasLength(1),
        reason: 'the fallback is announced, never silent');
    expect(log.where((String l) => l.contains('audio.link_loss.stopped')),
        hasLength(1));
  });

  test('🔴 ④ an ORDINARY press is byte-for-byte what it was — the flag is the '
      'only thing that changes behaviour', () async {
    await build();
    // continuous.begin() deliberately NOT called.
    await recordSomeAudio();

    await killTheLink();

    expect(capture.currentState, RecorderState.stopped);
    expect(stopReasons, hasLength(1));
    expect(
      DiagLog.instance
          .snapshot()
          .where((String l) => l.contains('audio.link_loss.stopped')),
      hasLength(1),
    );
  });

  test('🔴 ⑤ the flag cannot strand into the next press', () async {
    await build();
    session.continuous.begin();
    await recordSomeAudio();
    // Ended with cancel rather than release purely so the FSM lands back in
    // IDLE and a second press is possible: `pttUp` leaves it in PROCESSING
    // waiting for an stt:final no fake is going to send. The flag's clearing
    // path is identical (both reach `RecorderState.stopped`).
    await session.pttCancel();
    await settle();
    expect(session.continuous.isActive, isFalse,
        reason: 'cleared by the recorder reaching stopped, not by anyone '
            'remembering to clear it');

    // A perfectly ordinary press now. If the flag had stranded, this recording
    // would keep a microphone open that nothing is ever going to stop.
    await recordSomeAudio();
    await killTheLink();
    expect(capture.currentState, RecorderState.stopped);
  });
}
