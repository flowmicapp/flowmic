// Defect D-2 (round-four device drill, 2026-09-06) — THE PER-SITTING CEILING
// IS ENFORCED ON THE LOCAL CLOCK, WITH OR WITHOUT A LINK.
//
// EVIDENCE:
//   .local/session-2026-09-06-durability-drill-r4/06-DEFECTS.md D-2
//   B-3/diag-final.log 13:37:28.611 `audio.continuous.cap_stale
//   session=disconnected` — the 30-minute ceiling fired, was discarded because
//   the FSM had moved to `disconnected` (CR-3 keeps the microphone open through
//   a link death, so those two facts disagree by design), and the recording ran
//   5m44s further until it was stopped by hand.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.B② (the phone enforces, the server issues the number), card CR-6
//   apps/mobile/lib/src/ptt/ptt_continuous.dart (`stopForContinuousCap`)
//
// ── WHY THE NEGATIVE HALF NEEDS A POSITIVE CONTROL NEXT TO IT ───────────────
//
// 「the ceiling stopped it while offline」 and 「the ceiling stops it at all」 are
// two claims, and a rig that could only produce the first would pass on a build
// whose timer never armed. So the same recording is driven to the same ceiling
// twice — once with the link up and once with it dead — and both are asserted
// to end in the same place. The only thing allowed to differ is the WORD the
// journal carries, which is the one thing that should.
//
// Real PttSession + real FSM + real AudioCapture + real spill + real store on
// disk, same chain as `ptt_continuous_link_loss_test.dart`; only the socket and
// the OS recorder are doubles, and real time is used for the same reason that
// file gives (retention writes are real file I/O and never complete inside a
// FakeAsync zone).

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
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

/// Short enough to run, long enough that the ceiling cannot fire before the
/// link is killed. The production number is thirty minutes; nothing here reads
/// it, which is the point — [PttSession.beginContinuous] takes the ceiling as
/// an argument precisely so it is never re-derived on this phone.
const Duration _cap = Duration(milliseconds: 400);
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
  late int warnings;

  Future<void> build() async {
    DiagLog.instance.clear();
    tmp = await Directory.systemTemp.createTemp('flowmic-d2-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    // The JOURNAL face, so the manifest this ending writes can be read back —
    // the reason word is the only externally visible difference between the two
    // endings under test.
    spill = RetainedAudioSpill(store: store, retainFromFirstFrame: true);
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
    warnings = 0;
    session.autoStopped.listen(stopReasons.add);
    transport.pushStatus(SocketStatus.connected);
  }

  tearDown(() async {
    await session.dispose();
    await transport.close();
    await spill.dispose(); // drains flush + journalFlush + republish
    await store.dispose();
    await removeTempDir(tmp);
  });

  /// Starts the sitting the way the entry does (`_startContinuousRouted`):
  /// arm the ceiling first, then press.
  Future<void> startSitting() async {
    session.beginContinuous(cap: _cap, onWarning: () => warnings += 1);
    expect(await session.pttDown(), isTrue,
        reason: 'positive control: the production chain entered RECORDING');
    recorder.feed(makePcm(kChunkBytes));
    recorder.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);
  }

  Future<void> killTheLink() async {
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
  }

  /// Past the ceiling, plus a turn for the stop's queued journal work.
  Future<void> reachTheCeiling() async {
    await Future<void>.delayed(_cap);
    await Future<void>.delayed(const Duration(milliseconds: 60));
    await spill.journalFlush();
    await pumpEventQueue();
  }

  Future<Map<String, Object?>> manifestOf(String id) async => jsonDecode(
        await File('${tmp.path}${Platform.pathSeparator}'
                '$id${RetainedAudioJournal.manifestSuffix}')
            .readAsString(),
      ) as Map<String, Object?>;

  test('🔴 ① THE DEFECT: the link dies mid-sitting and the ceiling STILL ends '
      'the recording', () async {
    await build();
    await startSitting();
    final String? id = spill.currentRecordingId;
    expect(id, isNotNull, reason: 'positive control: a journal is open');

    await killTheLink();
    // Positive control on the state under test: this is D-1's state, and it is
    // the only one in which the old `fsm.session != recording` guard fired.
    expect(capture.currentState, RecorderState.recording,
        reason: 'CR-3 keeps the microphone open — that is what makes the FSM '
            'and the recorder disagree here');
    expect(session.continuousStillCapturing, isTrue);

    await reachTheCeiling();

    expect(capture.currentState, RecorderState.stopped,
        reason: 'the account ceiling is a hard ceiling; a dead link may not '
            'raise it');
    expect(session.continuous.isActive, isFalse);
    expect(session.capTimer.isArmed, isFalse,
        reason: 'C8 — every exit lets go of all three verbs');
    // And the user is TOLD, with the CEILING's own sentence: after this one,
    // pressing again works, which is the opposite of what a link-loss or a
    // quota sentence would lead them to do (W8-4).
    expect(stopReasons, <String>[kLocalStopReasonContinuousCap]);

    final Map<String, Object?> m = await manifestOf(id!);
    expect(m['interruptReason'], JournalInterrupt.capReached,
        reason: 'the ending is filed under the ceiling, not under the drop '
            'that happened twenty minutes earlier');
    // The bytes are KEPT. A ceiling is not a fault and nothing here deletes.
    expect(m['cancelled'], isFalse);
    expect(
      await File('${tmp.path}${Platform.pathSeparator}'
              '$id${RetainedAudioJournal.pcmSuffix}')
          .length(),
      2 * kChunkBytes,
    );
    // The trail names WHICH branch ran; `cap_stale` is the defect's own line
    // and must not appear.
    final List<String> log = DiagLog.instance.snapshot();
    expect(log.where((String l) => l.contains('cap_reached_offline')),
        hasLength(1));
    expect(log.where((String l) => l.contains('cap_stale')), isEmpty);
  });

  test('🔴 ② POSITIVE CONTROL: connected, the same ceiling ends the same '
      'recording', () async {
    await build();
    await startSitting();

    await reachTheCeiling();

    expect(capture.currentState, RecorderState.stopped);
    expect(session.continuous.isActive, isFalse);
    expect(stopReasons, <String>[kLocalStopReasonContinuousCap],
        reason: 'one sentence, whatever the link was doing — the user is not '
            'told two different things about the same ceiling');
    // The ONLINE path is the ordinary release and stays so: it says `audio:stop`
    // on a live wire, which the offline one must never do.
    expect(transport.emittedWhere('audio:stop'), hasLength(1));
    final List<String> log = DiagLog.instance.snapshot();
    expect(log.where((String l) => l.contains('cap_reached_offline')), isEmpty,
        reason: 'the offline branch is for the offline case only');
    expect(log.where((String l) => l.contains('audio.continuous.cap_reached')),
        hasLength(1));
  });

  test('🔴 ③ `cap_stale` SURVIVES for the case it was written for: the user '
      'already stopped', () async {
    await build();
    await startSitting();
    await session.pttUp(); // the user stops, well before the ceiling
    await Future<void>.delayed(Duration.zero);
    expect(session.continuousStillCapturing, isFalse);
    stopReasons.clear();

    // Nothing armed is left, so nothing can fire — but the guard must also be
    // right if a stray timer ever did: announcing a ceiling nobody reached is
    // the fabricated state this branch exists to refuse.
    await session.stopForContinuousCap();

    expect(stopReasons, isEmpty,
        reason: 'no ceiling was reached, so no ceiling is announced');
    expect(
      DiagLog.instance.snapshot().where((String l) => l.contains('cap_stale')),
      hasLength(1),
      reason: 'and the refusal is named, never silent',
    );
  });

  test('🔴 ④ a BACKGROUNDED (paused) recorder is still stopped by the ceiling',
      () async {
    // The app being in the background parks the recorder; the wall clock does
    // not stop. Refusing to enforce here would defer the ceiling until the
    // phone happened to be in the foreground — the same deferral D-2 is about,
    // arriving through a second door.
    await build();
    await startSitting();
    await killTheLink();
    await capture.pause();
    expect(capture.currentState, RecorderState.paused,
        reason: 'positive control: we are in the state under test');

    await reachTheCeiling();

    expect(capture.currentState, RecorderState.stopped);
    expect(stopReasons, <String>[kLocalStopReasonContinuousCap]);
  });
}
