// Card CR-5 — THE RE-TRANSCRIPTION CHANNEL, and with it C3, which the task
// unit calls 「本单元唯一真正的验收」 (「this unit's only real acceptance」):
//
//   中途断网 ≥60 秒再恢复 ⇒ 断网期间说的话也在这一篇里，且时间戳接得上
//   (a ≥60 s outage mid-recording ⇒ what was said while the link was down is
//    in this piece too, and its timestamps join up)
//
// 🔴 WALKS THE REAL CHAIN. The recovery is only worth anything if it goes
// through the ORDINARY path — the same `audio:start`/`audio:chunk`/`audio:stop`
// the microphone uses, the same inbound dispatch, the same single settlement
// path. A test that called the row builder directly would prove that this file
// can construct a row, which nobody doubted.
//
// C4 is the reverse control and it is at the bottom: unhook the channel and C3
// must go red. It was seen red before it was written down.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/article.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// A fake that ANSWERS `audio:stop` the way the server does.
///
/// 🔴 THIS REPLACED A TIMING-BASED TEST AND THE DIFFERENCE IS THE WHOLE
/// LESSON. The first version started the recovery, waited (first for a fixed
/// number of event-loop pumps, then for an `audio:stop` to appear in the
/// emitted list) and then pushed its finals by hand. Every version of that
/// wait was answering a slightly different question from the one it needed —
/// pumps do not cover file I/O; 「an audio:stop exists」 finds the LIVE
/// recording's; 「a new one exists」 races with the two production edges that
/// fire their own sweeps. The test failed, passed alone, and failed again in
/// the suite, and each time it looked like a product defect.
///
/// A transcription session is a REQUEST-RESPONSE: the client says stop and the
/// server answers with finals. Modelling that removes the synchronisation
/// problem instead of solving it, and it is also the more faithful fixture.
class _ReplyingTransport extends FakeSocketTransport {
  /// Finals to answer the NEXT `audio:stop` with. Consumed once, so a second
  /// stop (a live release, say) is answered by the test as before.
  List<Map<String, Object?>> replyToNextStop = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event != 'audio:stop' || replyToNextStop.isEmpty) return;
    final List<Map<String, Object?>> finals = replyToNextStop;
    replyToNextStop = <Map<String, Object?>>[];
    // Asynchronously, like a server: the caller of emit() must be allowed to
    // finish (it still has `fsm.onPttUp()` to run) before the answer lands.
    // One per turn, not all in one microtask: back-to-back frames let the
    // inbound dispatch fill the segment buffer with BOTH before the controller
    // has settled the first, and the first row then covers a span it should not.
    // In production these are seconds apart.
    Future<void>(() async {
      for (final Map<String, Object?> f in finals) {
        pushIncoming(FlowMicEvents.sttFinal, f);
        await pumpEventQueue();
      }
    });
  }
}

/// Wait for something the PRODUCT does, rather than for a number of event-loop
/// turns.
///
/// 🔴 `pumpEventQueue()` drains microtasks; the recovery reads a file, which is
/// real I/O and takes as many turns as it takes. A test that pumped a fixed
/// number of times and then pushed its finals delivered them BEFORE the
/// recovery had opened the wire — the words then settled against the live
/// utterance's watermark, produced nothing, and read as a product defect for
/// two rounds. Poll for the fact instead.
Future<void> until(bool Function() done, {String? why}) async {
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!done()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('timed out waiting for: ${why ?? 'a condition'}');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// 45 seconds of retained PCM — past the 30 s ring, and long enough that the
/// offset it contributes cannot be confused with a rounding error.
const int kOutageSeconds = 45;
const int kOutageBytes = kOutageSeconds * kPcmBytesPerSecond;

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-backfill-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(tmp, store, RetainedAudioSpill(store: store));
    r._build();
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;

  late final _ReplyingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  void _build() {
    transport = _ReplyingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  Map<String, Object?> finalFrame({
    required String text,
    required int idx,
    required bool isSegment,
    required int durationMs,
  }) => <String, Object?>{
    'text': text,
    'confidence': 0.95,
    'language': 'zh',
    'segment_idx': idx,
    'is_segment': isSegment,
    'duration_ms': durationMs,
  };

  Future<void> pushFinal({
    required String text,
    required int idx,
    required bool isSegment,
    required int durationMs,
  }) async {
    transport.pushIncoming(
      FlowMicEvents.sttFinal,
      finalFrame(
        text: text, idx: idx, isSegment: isSegment, durationMs: durationMs),
    );
    await pumpEventQueue();
  }

  List<TimelineEntry> membersOf(String id) => articleMembersOf(timeline, id);

  Future<void> dispose() async {
    // 🔴 LET THE EDGE-TRIGGERED SWEEPS FINISH FIRST. They are unawaited by
    // design, and tearing the temp directory out from under one produces a
    // PathNotFoundException in the NEXT test — a fixture racing the product,
    // reported against whichever case happened to be running.
    await until(() => !controller.backfill.isBusy, why: 'sweeps to finish');
    await controller.dispose();
    timeline.dispose();
    await session.dispose();
    await store.dispose();
    try {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    } on FileSystemException {
      // Windows holds a just-closed file briefly; a leftover temp dir is not
      // worth failing an acceptance over.
    }
  }
}

void main() {
  test('C3: a 45-second outage mid-recording ends up in the same piece, in place',
      () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);

    // ── the recording starts, and thirty seconds are said on a live link ────
    final String articleId = r.session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    );
    await r.controller.pttDown();
    await r.pushFinal(text: '开会之前先说三件事', idx: 0, isSegment: true, durationMs: 30000);

    // ── the link dies. CR-3 keeps the microphone; the bytes go to disk ──────
    r.transport.pushStatus(SocketStatus.disconnected);
    await pumpEventQueue();
    r.spill.onEvicted(
      BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(kOutageBytes)),
    );
    await r.spill.flush();
    expect(await r.store.bytesForSession(articleId), kOutageBytes,
        reason: 'positive control: the outage really was retained, under this '
            'recording id');

    // ── the link returns ───────────────────────────────────────────────────
    r.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    await pumpEventQueue();

    // 🔴 THE SEAM (C5). The outage was accounted for the instant the link came
    // back — which is the only instant it COULD be, because recovery starts
    // deleting those bytes as it transcribes them. Everything spoken from here
    // on sits after it.
    expect(r.session.articles.accountedMs, 30000 + kOutageSeconds * 1000);

    // ── the user says one more thing live, then stops ───────────────────────
    await r.pushFinal(text: '最后一件', idx: 1, isSegment: true, durationMs: 5000);
    await r.controller.pttUp();

    // 🔴 THE SERVER'S ANSWER TO THE RECOVERY, ARMED HERE — after the live
    // release has sent ITS `audio:stop`, and before the recovery sends its own.
    // From this point exactly one more stop can occur and it is the recovery's,
    // so the fixture cannot be answering the wrong session.
    //
    // ⚠️ AND THE SWEEP IS NEVER CALLED BY THIS TEST. It is triggered by the
    // production edge (a recording ending), which is the thing that has to
    // work — a test that called `sweep()` itself would leave the wiring
    // unproven and would race the edge on top of that.
    r.transport.replyToNextStop = <Map<String, Object?>>[
      r.finalFrame(text: '断网时说的第一句', idx: 0, isSegment: true, durationMs: 20000),
      r.finalFrame(text: '断网时说的第二句', idx: 1, isSegment: false, durationMs: 25000),
    ];
    await r.pushFinal(text: '就这样', idx: 2, isSegment: false, durationMs: 2000);

    // ── the recovery runs on its own, and its words land INSIDE the gap ────
    await until(() => !r.controller.backfill.isBusy,
        why: 'the recovery triggered by the end of the recording');

    final List<TimelineEntry> rows = r.membersOf(articleId);

    // 🔴 C3, first half — the words said while the link was down are HERE.
    expect(
      rows.map((TimelineEntry e) => e.displayText).toList(),
      <String>['开会之前先说三件事', '断网时说的第一句', '断网时说的第二句', '最后一件', '就这样'],
      reason: 'the recovered sentences belong in this piece, in the order they '
          'were spoken — not appended after the live ones that followed them',
    );

    // 🔴 C3, second half — 「时间戳接得上」. The offsets join with no gap and no
    // overlap: 30 s live, then the 45 s outage split 20 + 25, then live again.
    expect(
      rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
      <int>[0, 30000, 50000, 75000, 80000],
      reason: 'the two sources meet at the seam — durations before the outage, '
          'bytes across it, durations after',
    );

    // And the bytes are gone, because their words exist. Settle ⇒ delete is the
    // boundary that keeps this from becoming a voice archive.
    expect(await r.store.bytesForSession(articleId), 0);
    expect(r.controller.backfill.progress.value.pendingMs, 0);
  });

  test('the recovery goes over the ORDINARY wire path, delivering nothing',
      () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);

    r.spill.beginSession('a0-1');
    r.spill.noteUplinkDown();
    r.spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(12800)));
    await r.spill.flush();
    r.spill.endSession();

    r.transport.emitted.clear();
    // Answer it, so the recovery completes instead of holding the latch for its
    // full settle timeout — the wire frames are what this case is about, but a
    // recovery that never finishes would leave the NEXT case waiting on it.
    r.transport.replyToNextStop = <Map<String, Object?>>[
      r.finalFrame(text: '补回来的一句', idx: 0, isSegment: false, durationMs: 400),
    ];
    await r.controller.backfill.sweep(sourceLang: 'zh');

    // audio:start → audio:chunk × N → audio:stop, the same three verbs the
    // microphone uses. No second protocol was invented for recovery.
    expect(r.transport.emittedNames, contains('audio:start'));
    expect(r.transport.emittedWhere('audio:chunk'), hasLength(2),
        reason: '12800 bytes at 6400 per frame — the live path\'s own cadence');
    expect(r.transport.emittedNames, contains('audio:stop'));

    // 🔴 delivery: none, ALWAYS. A recovered sentence arriving on somebody's PC
    // minutes late and out of order is the accidental delivery §4.0 C exists to
    // prevent, and the fact that this recording could never be delivered live
    // is exactly why nothing may change here.
    final Map<dynamic, dynamic> start =
        r.transport.emittedWhere('audio:start').single.data as Map<dynamic, dynamic>;
    expect(start['delivery'], 'none');
  });

  test('nothing retained ⇒ nothing on the wire, and no fabricated progress',
      () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);

    r.transport.emitted.clear();
    await r.controller.backfill.sweep(sourceLang: 'zh');

    expect(r.transport.emittedNames, isNot(contains('audio:start')));
    expect(r.controller.backfill.progress.value.hasWork, isFalse);
  });

  test('a recording in progress wins — the recovery waits rather than interleaves',
      () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);

    r.spill.beginSession('a0-1');
    r.spill.noteUplinkDown();
    r.spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(6400)));
    await r.spill.flush();
    r.spill.endSession();

    // A live press is holding the session.
    await r.controller.pttDown();
    r.transport.emitted.clear();

    await r.controller.backfill.sweep(sourceLang: 'zh');

    // 🔴 A second audio:start on one socket would read to the server as the user
    // pressing again, and the recovered audio would be interleaved into the live
    // recording — a corruption nothing downstream could detect.
    expect(r.transport.emittedNames, isNot(contains('audio:start')));
    // The debt is still owed, and the face still says so.
    expect(await r.store.bytesForSession('a0-1'), 6400);
  });

  test('progress is measured in bytes on disk, not guessed', () async {
    final _Rig r = await _Rig.open();
    addTearDown(r.dispose);

    r.spill.beginSession('a0-1');
    r.spill.noteUplinkDown();
    r.spill.onEvicted(
      BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(10 * kPcmBytesPerSecond)),
    );
    await r.spill.flush();
    r.spill.endSession();

    // A recording is running, so the sweep publishes the debt and then refuses
    // to act on it — which is exactly the state ruling ⑮ asks the screen to
    // describe.
    await r.controller.pttDown();
    await r.controller.backfill.sweep(sourceLang: 'zh');

    final BackfillProgress p = r.controller.backfill.progress.value;
    expect(p.pendingMs, 10000, reason: '10 s of PCM16/16k/mono is 10 s');
    expect(p.hasWork, isTrue);
  });
}
