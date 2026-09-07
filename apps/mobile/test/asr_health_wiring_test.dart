// Card AW-1b — proving `AsrHealthTracker` (asr_health.dart) is actually wired
// onto the real event sources, not just callable in isolation
// (asr_health_test.dart already covers the pure logic with a fake clock).
//
// ── WHY A REAL SttStream + A REAL FSM, THROUGH ptt_inbound.dart ────────────
// The rig below is the same shape `autostop_reason_wire_test.dart` and
// `ptt_up_final_race_test.dart` already use: real `PttSession` (real
// `SttStream`, real `FlowmicStateMachine`, real `ptt_inbound.dart` dispatch),
// real `ChatController` (so `wireAsrHealth` actually runs), and ONLY the
// socket + platform recorder are doubles. Every frame below travels the
// PRODUCTION path from "the server said X" to `c.asrHealth.value` — the seam
// this card exists to prove, not a second copy of asr_health_test.dart's
// direct-call tests.
//
// ── WHY `clock` INSTEAD OF REAL WALL-CLOCK WAITS ────────────────────────────
// `chat_asr_health_wire.dart` reads `clock.now()` (package:clock), which
// `fakeAsync`'s zone overrides — see that file's own comment on
// `_asrHealthNowMs`. That is what lets this file drive the tracker's real
// thresholds (up to 9 s) in a test that finishes instantly instead of
// spending real wall-clock seconds waiting on them.

import 'dart:async';
import 'dart:typed_data' show Uint8List;

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/asr_health.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show PairEntry;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// The real orchestration hub (`ChatController`, which runs `wireAsrHealth`
/// in its constructor) + the real data layer (`PttSession`), with only the
/// socket and the platform recorder doubled — same posture as
/// `autostop_reason_wire_test.dart`'s `_Rig`.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport()..connectSucceeds = true;
    r.recorder = FakeAudioRecorder();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: r.recorder),
    );
    r.store = newTestStore();
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    return r;
  }

  Future<void> pair() async {
    transport.defaultAck = <String, Object?>{
      'token': 'tok-aw1b0123456789abcdefghijklmnop',
      'pairing_id': 'pair-aw1b',
      'pc_name': 'AW-1b PC',
    };
    final PairResult r = await session.pair(
      PairEntry.parse('4242'),
      endpoint: 'ws://127.0.0.1:41880',
    );
    expect(r.ok, isTrue, reason: 'harness pair failed: ${r.error}');
  }

  void dispose() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

void main() {
  // The haptic gate in `wireAsrHealth` calls `FlowMicHaptics.asrHealthWarning`
  // (a `flutter/services.dart` MethodChannel) the moment ANY snapshot in this
  // file goes non-normal — every test below exercises exactly such a
  // transition, so the platform-channel binding has to exist even though
  // this file never mounts a widget.
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── 反 façade evidence (one production caller per input) ─────────────────
  // grep -n "h\.\(recordingStarted\|bytesArrived\|amplitudeObserved\|interimArrived\|finalArrived\|terminalError\|retryableError\|recordingEnded\|tick\)(" \
  //   lib/src/session/chat_asr_health_wire.dart
  // → exactly one call site per method, each inside its own `.listen`/
  //   `Timer.periodic` closure. This test drives every one of those
  //   production sources and reads the effect back off `c.asrHealth.value`.
  // The OUTPUT half of that evidence lives in chat_asr_health_wire.dart's own
  // header block and in live_draft_tile_render_test.dart (one rendered
  // sentence per snapshot field, minus the diag-only bounce counter).

  test('bytesArrived: AudioCapture.chunks reaches the tracker and clears '
      'byteStall — the ticker (not a second poller) is what ages it back on',
      () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      expect(r.session.fsm.session.toString(), contains('recording'));

      // 🔴 THE HOLE THIS CASE USED TO PIN SHUT. A SUB-CHUNK feed (below
      // AudioCapture's 6400-byte chunk boundary): enough to satisfy
      // AudioCapture's OWN dead-capture watchdog (kDeadCaptureAfter=1500ms,
      // one-shot, gated on `_platformBytes > 0`, so it stands down), but never
      // enough to complete a chunk — so NO CapturedChunk reaches
      // `AudioCapture.chunks`. 64 bytes then silence, for the whole recording.
      //
      // This assertion used to read `byteStall isFalse` and it was WRONG in
      // the way 0.2.52 names: a negative assertion nobody would be told about
      // if it were mistaken, written next to a true premise ("nothing has
      // reached the tracker") and a false conclusion ("so nothing is wrong").
      // The microphone had opened and then gone quiet, one watchdog had
      // already stood down, the other had never armed, and the live row said
      // 「Transcribing」 for the entire recording with nothing on the device
      // contradicting it.
      r.recorder.feed(Uint8List(64));
      async.flushMicrotasks();

      // The delivery itself is the first byte (`AudioCapture.platformBytes`),
      // so the window starts here and nothing renews it.
      expect(r.controller.asrHealth.value.byteStall, isFalse,
          reason: 'a byte just landed — a stall inside the window would be a '
              'claim the tracker cannot back either');
      async.elapse(const Duration(milliseconds: 2100));
      expect(r.controller.asrHealth.value.byteStall, isTrue,
          reason: 'a recorder that delivered 64 bytes and stopped IS stalled; '
              'a feed that only sees completed 200ms chunks can never say so');

      // Back to false the moment a delivery lands again — the signal ages, it
      // does not latch.
      r.recorder.feed(Uint8List(64));
      async.flushMicrotasks();
      expect(r.controller.asrHealth.value.byteStall, isFalse);

      // Now feed real bytes through the PRODUCTION AudioCapture pipeline
      // (fake recorder -> AudioCapture._onPcm -> chunks stream) and let the
      // wiring's listener run.
      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();
      expect(r.controller.asrHealth.value.byteStall, isFalse);

      // NOW bytes have flowed and stopped — that is the stall this signal
      // owns, and the TICKER (armed on the recordingStarted edge) is what
      // ages it, proving `wireAsrHealth`'s FSM listener actually started the
      // periodic tick rather than merely running `recordingStarted` once.
      // 2100ms, not 1600: the byte landed BETWEEN two 500ms ticks, so the
      // first tick whose delta clears the 1500ms window is up to one full
      // period later. A test that budgets exactly the window measures the
      // tick phase, not the signal.
      async.elapse(const Duration(milliseconds: 2100));
      expect(r.controller.asrHealth.value.byteStall, isTrue,
          reason: 'the 500ms ticker must have called tick() at least once '
              'past the 1500ms byteStallWindow');

      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();
      expect(r.controller.asrHealth.value.byteStall, isFalse,
          reason: 'bytesArrived must have reached the tracker synchronously '
              'with the chunk, not merely on the next tick');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('amplitudeObserved: AudioCapture.amplitudeDb is what unlocks '
      'noFirstResult — room tone does not, sound above the floor does', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();

      // Room tone through the PRODUCTION path: real chunks, real
      // `_amplitudeDbFor` RMS, nonzero samples the whole way. `amplitude: 40`
      // measures about -63 dBFS, comfortably under the tracker's -45 floor.
      for (int i = 0; i < 60; i++) {
        r.recorder.feed(makePcm(6400, amplitude: 40));
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 200));
      }
      expect(r.controller.asrHealth.value.noFirstResult, AsrHealthLevel.none,
          reason: 'twelve seconds of a quiet room with no interim: nobody '
              'spoke, so there is nothing to be waiting for. A nonzero-byte '
              'gate would have escalated to level2 here — that was the bug');
      expect(r.controller.asrHealth.value.byteStall, isFalse,
          reason: 'bytes never stopped arriving');

      // Same rig, same silence of the engine — but now somebody speaks
      // (default amplitude 8000, about -17 dBFS).
      for (int i = 0; i < 60; i++) {
        r.recorder.feed(makePcm(6400));
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 200));
      }
      expect(r.controller.asrHealth.value.noFirstResult, AsrHealthLevel.level2,
          reason: 'twelve seconds of speech with nothing coming back IS the '
              'fault this signal exists for');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('interimArrived: SttStream.interims reaches the tracker and holds off '
      'noFirstResult past its own threshold', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      // Keep bytes flowing so byteStall never masks the signal under test,
      // and keep them at speech level for long enough to clear the tracker's
      // sound-activity minimum — otherwise this test would pass for the
      // WRONG reason (the gate never opening, rather than the interim
      // landing).
      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();
      async.elapse(const Duration(milliseconds: 400));
      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();

      r.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
        'text': 'partial',
        'confidence': 0.4,
        'language': 'en',
        'segment_idx': 0,
      });
      async.flushMicrotasks();

      // Past BOTH noFirstResultT1 (4000ms) and T2 (9000ms, the tracker's own
      // default constructor values): if the interim had not reached the
      // tracker, noFirstResult would now read level2. It must stay `none`.
      async.elapse(const Duration(seconds: 10));
      expect(r.controller.asrHealth.value.noFirstResult, AsrHealthLevel.none,
          reason: 'interimArrived must have reached the tracker and cleared '
              'the no-first-result gate before either threshold fired');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('finalArrived (soft segment): SttStream.finals reaches the tracker the '
      'SAME way an interim does, without ending the recording', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      // Speech level, sustained past soundActivityMinDuration — same reason
      // as the interim test above.
      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();
      async.elapse(const Duration(milliseconds: 400));
      r.recorder.feed(makePcm(6400));
      async.flushMicrotasks();

      // is_segment:true — a SOFT final, which per ptt_inbound.dart does NOT
      // call fsm.onSttFinal() and so does not end the recording. Only its
      // wiring into the tracker is under test here.
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': 'one segment',
        'confidence': 0.9,
        'language': 'en',
        'segment_idx': 0,
        'is_segment': true,
        'duration_ms': 900,
      });
      async.flushMicrotasks();
      expect(r.session.fsm.session.toString(), contains('recording'),
          reason: 'a soft-segment final must not end the recording — this '
              'test is isolating finalArrived, not onSttFinal');

      async.elapse(const Duration(seconds: 10));
      expect(r.controller.asrHealth.value.noFirstResult, AsrHealthLevel.none,
          reason: 'finalArrived must have reached the tracker exactly as '
              'interimArrived does');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('terminalError: FlowmicStateMachine.sttErrorImmediate reaches the '
      'tracker IMMEDIATELY (no threshold, no wait)', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      expect(r.controller.asrHealth.value.terminalError, isNull);

      r.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'retryable': false,
        'code': 'STT_CONFIG_MISSING',
        'message': 'sherpa-local open failed',
      });
      async.flushMicrotasks();

      final AsrTerminalError? err = r.controller.asrHealth.value.terminalError;
      expect(err, isNotNull);
      expect(err!.code, 'STT_CONFIG_MISSING');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('retryableError: FlowmicStateMachine.sttRetryableErrors reaches the '
      'tracker as a counter, never sets terminalError, and never touches the '
      'FSM (capture continues unchanged)', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      unawaited(r.pair());
      async.flushMicrotasks();
      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      expect(r.controller.asrHealth.value.retryableBounces, 0);

      r.transport.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'retryable': true,
        'code': 'STT_NETWORK_DROP',
        'message': 'reconnecting',
      });
      async.flushMicrotasks();

      expect(r.controller.asrHealth.value.retryableBounces, 1);
      expect(r.controller.asrHealth.value.terminalError, isNull,
          reason: 'a retryable bounce must never be reported as terminal');
      expect(r.session.fsm.session.toString(), contains('recording'),
          reason: 'onSttRetryableError is a pure observer — the FSM does not '
              'move because of it');

      unawaited(r.session.pttUp());
      async.elapse(const Duration(seconds: 2));
    });
  });

  test('recordingStarted/recordingEnded: the ticker is created on the '
      'recording edge and torn down on the way out — no leaked periodic '
      'timer', () {
    fakeAsync((FakeAsync async) {
      final _Rig r = _Rig.create();
      addTearDown(r.dispose);

      // The 500ms period is `wireAsrHealth`'s own constant — a different
      // periodic timer with a different period (heartbeat, presence poll,
      // RecordingTelemetry's 200ms tick, …) is a real production timer that
      // is simply not this card's ticker, so this predicate is scoped to the
      // ONE duration AW-1b actually uses rather than a raw total count.
      bool hasAsrTicker() => async.pendingTimers.any(
            (FakeTimer t) =>
                t.isPeriodic && t.duration == const Duration(milliseconds: 500),
          );

      unawaited(r.pair());
      async.flushMicrotasks();
      expect(hasAsrTicker(), isFalse,
          reason: 'no recording is in progress yet — nothing should be '
              'ticking');

      unawaited(r.session.pttDown());
      async.flushMicrotasks();
      expect(hasAsrTicker(), isTrue,
          reason: 'recordingStarted must have armed the 500ms ticker');

      unawaited(r.session.pttUp());
      // A terminal final closes RECORDING -> JUST_DONE synchronously off the
      // wire, same as ptt_up_final_race_test.dart's rig.
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': 'done',
        'confidence': 0.9,
        'language': 'en',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 500,
      });
      async.flushMicrotasks();
      expect(r.session.fsm.session.toString(), isNot(contains('recording')));
      expect(hasAsrTicker(), isFalse,
          reason: 'recordingEnded must have cancelled the ticker — no timer '
              'may be left running once the recording is over');

      async.elapse(const Duration(seconds: 2));
    });
  });

  // ── REVERSE CONTROL ────────────────────────────────────────────────────
  // Disconnect ONE hook — the interim listener in `wireAsrHealth` — and show
  // this file's own interim test goes red, then restore it and show it green
  // again. Quoted verbatim below; see chat_asr_health_wire.dart for the one
  // line that was commented out to produce it.
  //
  // RED (interim subscription commented out in chat_asr_health_wire.dart):
  //   00:00 +0 -1: interimArrived: SttStream.interims reaches the tracker and
  //     holds off noFirstResult past its own threshold [E]
  //     interimArrived must have reached the tracker and cleared the
  //     no-first-result gate before either threshold fired
  //     Expected: AsrHealthLevel:<AsrHealthLevel.none>
  //       Actual: AsrHealthLevel:<AsrHealthLevel.level2>
  //     Which: is not an AsrHealthLevel:<AsrHealthLevel.none>
  //
  // GREEN (restored, this file re-run in full):
  //   00:00 +6: All tests passed!
}
