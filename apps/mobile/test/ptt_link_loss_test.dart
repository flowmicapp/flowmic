// SEG-2 — THE DEAD-RECORDING EDGE, through the real wiring.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R3
//     (trigger = the FSM's 3 s drop grace expiring while the mic is live;
//      the session layer, never the FSM, stops the capture), §2-R4 (local
//     judgement, local notice, zero protocol)
//   apps/mobile/lib/src/ptt/ptt_link_loss.dart (the edge under test)
//
// ── THE MEASURED HOLE THIS PINS SHUT (design §1-3) ───────────────────────────
// Before SEG-2: grace expiry → `_resetSession()` → a later `pttUp()` returned
// on `fsm.session != recording` — nothing stopped the recorder, nothing
// retained, nothing said. These tests drive the REAL PttSession + REAL FSM +
// REAL AudioCapture + REAL spill + REAL store (a temp dir on disk); only the
// socket and the OS recorder are doubles.
//
// Real time, not fakeAsync — the retention writes are real file I/O, which
// never completes inside a FakeAsync zone. The FSM's grace and the heartbeat
// are shrunk instead (both are constructor-injectable durations).

import 'dart:async';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

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

  setUp(() async {
    DiagLog.instance.clear();
    tmp = await Directory.systemTemp.createTemp('flowmic-linkloss-edge-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    capture = AudioCapture(recorder: recorder, spill: spill);
    session = newTestSession(
      transport: transport,
      audio: capture,
      stateMachine: FlowmicStateMachine(sessionDropGrace: _grace),
      heartbeatInterval: const Duration(milliseconds: 40),
    );
    stopReasons = <String>[];
    session.autoStopped.listen(stopReasons.add);
    // Drive the FSM to CONNECTED + IDLE the way production does — off the
    // transport status stream, not by poking the FSM.
    transport.pushStatus(SocketStatus.connected);
  });

  tearDown(() async {
    await session.dispose();
    await transport.close();
    await store.dispose();
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  Future<void> recordSomeAudio() async {
    expect(await session.pttDown(), isTrue,
        reason: 'positive control: the production chain entered RECORDING');
    recorder.feed(makePcm(kChunkBytes));
    recorder.feed(makePcm(kChunkBytes));
    recorder.feed(makePcm(1000)); // a residual partial past the last boundary
    await Future<void>.delayed(Duration.zero);
  }

  test('🔴 the hole: grace expiry while recording now stops the mic, retains '
      'the audio, says so locally — and puts NOTHING on the wire', () async {
    await recordSomeAudio();
    final int framesBeforeDrop = transport.emitted.length;

    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);

    // ① the microphone is OFF (before SEG-2 it ran on forever).
    expect(capture.currentState, RecorderState.stopped);
    // ② the audio is on disk — ring content + residual, byte-accounted.
    await spill.flush();
    int retained = 0;
    for (final int seg in await spill.pendingSegments()) {
      retained += (await spill.readSegment(seg))!.length;
    }
    expect(retained, 2 * kChunkBytes + 1000);
    // ③ the notice went up the SAME chain the wire auto-stop rides, with the
    // retention-claiming local reason (a live spill really took the tail).
    expect(stopReasons, <String>[kLocalStopReasonLinkLossKept]);
    // ④ NOTHING went on the wire after the drop: no audio:stop, no residual
    // chunk, no heartbeat. (The fake throws on a dead emit, so a frame could
    // not have been recorded anyway — the load-bearing half is that no
    // audio:stop exists at all: the trigger must not route through pttUp.)
    expect(transport.emitted.length, framesBeforeDrop);
    expect(transport.emittedWhere('audio:stop'), isEmpty,
        reason: 'the link is dead; an audio:stop frame would be a lie and '
            'pttUp\'s wire half must not run on this edge');
    // ⑤ the trail: the edge wrote its diag line.
    expect(
      DiagLog.instance.snapshot().where(
          (String l) => l.contains('audio.link_loss.stopped')),
      hasLength(1),
    );
  });

  test('a later pttUp() on the already-stopped capture is a safe no-op',
      () async {
    await recordSomeAudio();
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
    final int frames = transport.emitted.length;

    await session.pttUp(); // the release finally lands, long after the death

    expect(capture.currentState, RecorderState.stopped);
    expect(transport.emitted.length, frames, reason: 'no frame, no throw');
    expect(session.fsm.session, SessionState.disconnected);
    // And a cancel gesture is equally inert.
    await session.pttCancel();
    expect(transport.emitted.length, frames);
  });

  test('the heartbeat timer really died with the recording — a reconnect '
      'does not resurrect it', () async {
    await recordSomeAudio();
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
    final int beatsAtDeath = transport.emittedWhere('heartbeat').length;

    transport.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(const Duration(milliseconds: 200)); // 5 ticks

    expect(transport.emittedWhere('heartbeat').length, beatsAtDeath,
        reason: 'pttUp — the normal stopper — never runs for this utterance; '
            'without the trigger stopping it, the timer would beat again the '
            'moment the socket returned, for a session that no longer exists');
  });

  test('exactly once: further dead edges after the stop say nothing more',
      () async {
    await recordSomeAudio();
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
    transport.pushStatus(SocketStatus.error);
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(stopReasons, hasLength(1));
  });

  test('without a spill the mic still stops but the notice refuses the '
      'retention claim (the honest half only)', () async {
    // A second, spill-less rig — the degraded boot (store failed to open).
    final FakeSocketTransport t2 = FakeSocketTransport();
    final FakeAudioRecorder r2 = FakeAudioRecorder();
    final AudioCapture bare = AudioCapture(recorder: r2);
    final PttSession s2 = newTestSession(
      transport: t2,
      audio: bare,
      stateMachine: FlowmicStateMachine(sessionDropGrace: _grace),
    );
    final List<String> reasons2 = <String>[];
    s2.autoStopped.listen(reasons2.add);
    t2.pushStatus(SocketStatus.connected);
    expect(await s2.pttDown(), isTrue);
    r2.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);

    t2.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);

    expect(bare.currentState, RecorderState.stopped);
    expect(reasons2, <String>[kLocalStopReasonLinkLoss],
        reason: '「已录的音频保留在这台手机上」 with no retention layer would be '
            'the unbacked promise 15 册 §2.0-b bans');
    await s2.dispose();
    await t2.close();
  });

  test('a release DURING the grace window takes the normal stop() path and '
      'the local notice stays silent (the gate, pinned)', () async {
    await recordSomeAudio();
    transport.pushStatus(SocketStatus.disconnected);
    // Still inside the grace: the FSM holds RECORDING, so pttUp proceeds —
    // the residual + audio:stop wire halves fail harmlessly on the dead fake,
    // and stop() retains the tail (uplink is down).
    await session.pttUp();
    expect(capture.currentState, RecorderState.stopped);
    await Future<void>.delayed(_pastGrace); // the grace now expires anyway
    expect(stopReasons, isEmpty,
        reason: 'the capture was already down when the grace fired — the '
            'recorder-state gate must not double-report a recording the user '
            'themselves ended');
    await spill.flush();
    expect(await spill.pendingSegments(), isNotEmpty,
        reason: 'stop()\'s own retention (verb ①) covered this path');
  });
}
