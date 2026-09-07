// Defect D-3 (round-four device drill, 2026-09-06) — A SECOND 「START
// RECORDING」 WHILE ONE IS RUNNING MUST BE REFUSED, NOT SERVED INTO THE FIRST
// RECORDING'S JOURNAL.
//
// EVIDENCE:
//   .local/session-2026-09-06-durability-drill-r4/06-DEFECTS.md D-3,
//   B-3/verdict.md 13:42:42 / 13:43:12
// With the orphaned recording of D-1 still live, the entry was pressed again.
// The UI drew a fresh sitting ("29:42 left", "0 done") — and no new journal was
// created: the only file stayed `a0-…-r….pcm` and went on being appended to,
// 38,912,000 -> 40,115,200 B across the "new" session. Stop then closed the
// ORIGINAL article. Every offset computed for the second recording is wrong,
// and nothing afterwards can tell the two apart.
//
// ── 🔴 WHY `AudioCapture.start()` IS NOT THE PLACE TO FIX IT ────────────────
//
// Its early return on a live recorder is CORRECT — it is what stops a double
// press from tearing down a running microphone. What was wrong is that a caller
// could believe it had started a recording when it had not. So the refusal is
// made where the belief is formed (`PttSession.beginContinuous` returns null),
// and `start()` gains a loud line for the day that stops holding.
//
// SPEC-REF:
//   apps/mobile/lib/src/ptt/ptt_continuous.dart (`beginContinuous`)
//   apps/mobile/lib/src/audio/audio_capture.dart (`start`, and the journal's
//     one-recording-one-journal rule in audio_capture_journal.dart)

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

const Duration _cap = Duration(minutes: 30);
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

  setUp(() async {
    DiagLog.instance.clear();
    tmp = await Directory.systemTemp.createTemp('flowmic-d3-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
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
    transport.pushStatus(SocketStatus.connected);
  });

  tearDown(() async {
    await session.dispose();
    await transport.close();
    await spill.dispose(); // drains flush + journalFlush + republish
    await store.dispose();
    await removeTempDir(tmp);
  });

  Future<String> startSitting() async {
    final String? id =
        session.beginContinuous(cap: _cap, onWarning: () {});
    expect(id, isNotNull, reason: 'positive control: the FIRST one is allowed');
    expect(await session.pttDown(), isTrue);
    recorder.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);
    return id!;
  }

  /// Every `.pcm` the journal has opened, whatever its recording id.
  List<String> pcmFiles() => tmp
      .listSync()
      .map((FileSystemEntity e) => e.path)
      .where((String p) => p.endsWith('.pcm'))
      .toList();

  test('🔴 ① a second beginContinuous while one is running is REFUSED, loudly',
      () async {
    final String first = await startSitting();
    await spill.journalFlush();
    final List<String> before = pcmFiles();
    expect(before, hasLength(1), reason: 'positive control: one recording, one '
        'journal — the invariant the defect broke');

    final String? second =
        session.beginContinuous(cap: _cap, onWarning: () {});

    expect(second, isNull, reason: 'the caller must not be able to believe a '
        'second recording started');
    expect(session.articles.liveArticleId, first,
        reason: 'and the scribe must not have rolled: a new article id here is '
            'the second half of the corruption — rows filed under an article '
            'whose bytes are in another one');
    await spill.journalFlush();
    expect(pcmFiles(), before,
        reason: 'no second journal, and no second file for one to be written '
            'into');
    expect(
      DiagLog.instance
          .snapshot()
          .where((String l) => l.contains('continuous.begin_refused')),
      hasLength(1),
      reason: 'a refusal nobody can see is how this became invisible on device',
    );
    await session.pttUp();
  });

  test('🔴 ② and it is refused in D-1\'s state too — the link is dead and the '
      'recorder is still running', () async {
    // This is the state the defect was actually found in: the page had left,
    // the microphone had not, and the entry was the only thing left to press.
    await startSitting();
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(_pastGrace);
    expect(capture.currentState, RecorderState.recording,
        reason: 'positive control: CR-3 kept it open');

    expect(session.beginContinuous(cap: _cap, onWarning: () {}), isNull);
    expect(session.capTimer.armedCap, _cap,
        reason: 'the FIRST sitting\'s ceiling is untouched — a refused press '
            'must not re-arm the clock and hand the user another thirty '
            'minutes');
    session.stopContinuousOffline();
  });

  test('🔴 ③ POSITIVE CONTROL: after the recording ends, the next one is '
      'allowed and gets its own journal', () async {
    final String first = await startSitting();
    await session.pttCancel(); // lands the FSM back in IDLE for a second press
    await Future<void>.delayed(Duration.zero);
    await spill.journalFlush();
    expect(session.continuousStillCapturing, isFalse);

    final String? second =
        session.beginContinuous(cap: _cap, onWarning: () {});
    expect(second, isNotNull);
    expect(second, isNot(first));
    expect(await session.pttDown(), isTrue);
    recorder.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);
    await spill.journalFlush();

    expect(pcmFiles(), hasLength(2),
        reason: 'the refusal is about a LIVE recording only — it must not turn '
            'into a phone that can record once');
    await session.pttUp();
  });
}
