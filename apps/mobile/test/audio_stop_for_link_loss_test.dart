// SEG-2 — STOP VERB ③ (`AudioCapture.stopForLinkLoss`) and the replay-trim
// predicate (`bufferedChunkPayloads(cutoffSeq:)`), at the unit level.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R3
//     (three stop verbs, three tail semantics), §2-R5 (trim = seq > watermark),
//     §5-4 (fail toward duplication, never loss), §5-5 (fenceAndStop's discard
//     is frozen — the regression pin below guards it)
//   apps/mobile/lib/src/audio/audio_capture.dart (the three verbs' docs)
//
// The session-level halves (the FSM grace-expiry trigger; the ack watermark
// reaching the replay) live in ptt_link_loss_test.dart /
// reconnect_replay_trim_test.dart — real wiring, per house bias.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;
  late FakeAudioRecorder recorder;
  late AudioCapture capture;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-linkloss-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
    recorder = FakeAudioRecorder();
    capture = AudioCapture(recorder: recorder, spill: spill);
  });

  tearDown(() async {
    await capture.dispose();
    await store.dispose();
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  Future<int> retainedBytesOnDisk() async {
    await spill.flush();
    int total = 0;
    for (final int seg in await spill.pendingSegments()) {
      total += (await spill.readSegment(seg))?.length ?? 0;
    }
    return total;
  }

  group('stopForLinkLoss (verb ③): retain the tail, tell no one', () {
    test('retains exactly the ring content plus the residual partial, and '
        'emits nothing', () async {
      final List<CapturedChunk> emitted = <CapturedChunk>[];
      capture.chunks.listen(emitted.add);
      await capture.start();
      recorder.feed(makePcm(kChunkBytes)); // seq 0
      recorder.feed(makePcm(kChunkBytes)); // seq 1
      recorder.feed(makePcm(1000)); // residual partial (< one chunk)
      await Future<void>.delayed(Duration.zero);
      expect(emitted, hasLength(2),
          reason: 'positive control: two full chunks went through the live '
              'pipeline; the partial stayed in the accumulator');

      final bool kept = capture.stopForLinkLoss();

      expect(kept, isTrue,
          reason: 'a live spill plus real audio ⇒ the notice may claim '
              'retention');
      expect(capture.currentState, RecorderState.stopped);
      // The whole tail is on disk: 2 full chunks + the 1000-byte residual.
      expect(await retainedBytesOnDisk(), 2 * kChunkBytes + 1000);
      // NO wire face: the verb added nothing to the chunk stream (the
      // residual was folded into the ring, not emitted — the link is dead).
      await Future<void>.delayed(Duration.zero);
      expect(emitted, hasLength(2),
          reason: 'the residual must NOT surface as a live chunk; an emitted '
              'frame on a dead link would be a lie');
      // The residual left the accumulator: a later caller finds nothing.
      expect(capture.takeResidualChunk(), isNull);
    });

    test('without a spill it still stops, but refuses the retention claim',
        () async {
      final AudioCapture bare = AudioCapture(recorder: FakeAudioRecorder());
      await bare.start();
      expect(bare.stopForLinkLoss(), isFalse,
          reason: '15 册 §2.0-b: 「已录的音频保留在这台手机上」 with no retention '
              'layer would be an unbacked promise');
      expect(bare.currentState, RecorderState.stopped);
      await bare.dispose();
    });

    test('with a spill but zero audio it refuses the claim too', () async {
      await capture.start();
      expect(capture.stopForLinkLoss(), isFalse,
          reason: 'nothing was recorded, so there is nothing being kept');
      expect(await retainedBytesOnDisk(), 0);
    });

    test('idempotent: a second call (or one after stop()) is a no-op',
        () async {
      await capture.start();
      recorder.feed(makePcm(kChunkBytes));
      await Future<void>.delayed(Duration.zero);
      expect(capture.stopForLinkLoss(), isTrue);
      expect(capture.stopForLinkLoss(), isFalse);
      final int bytes = await retainedBytesOnDisk();
      expect(bytes, kChunkBytes, reason: 'retained once, not twice');
    });

    test('works from PAUSED as well — a backgrounded utterance whose link '
        'died is equally dead', () async {
      await capture.start();
      recorder.feed(makePcm(kChunkBytes));
      await Future<void>.delayed(Duration.zero);
      await capture.pause();
      expect(capture.currentState, RecorderState.paused);
      expect(capture.stopForLinkLoss(), isTrue);
      expect(capture.currentState, RecorderState.stopped);
      expect(await retainedBytesOnDisk(), kChunkBytes);
    });
  });

  group('the other two verbs are unchanged (regression pins)', () {
    test('fenceAndStop still DISCARDS the tail, uplink down or not '
        '(design §5-5: frozen semantics)', () async {
      capture.noteUplinkDown(); // the retain-most-eager configuration
      await capture.start();
      recorder.feed(makePcm(kChunkBytes));
      recorder.feed(makePcm(1000));
      await Future<void>.delayed(Duration.zero);

      capture.fenceAndStop();

      expect(capture.currentState, RecorderState.stopped);
      expect(await retainedBytesOnDisk(), 0,
          reason: 'cancel/fault means 「the utterance never happened」 — '
              'retaining it would resurface audio the user threw away');
    });

    test('stop() still retains when the uplink is down', () async {
      capture.noteUplinkDown();
      await capture.start();
      recorder.feed(makePcm(kChunkBytes));
      await Future<void>.delayed(Duration.zero);
      await capture.stop();
      expect(await retainedBytesOnDisk(), kChunkBytes);
    });

    test('stop() still writes nothing on a healthy link', () async {
      await capture.start(); // uplink defaults to up
      recorder.feed(makePcm(kChunkBytes));
      await Future<void>.delayed(Duration.zero);
      await capture.stop();
      expect(await retainedBytesOnDisk(), 0);
    });
  });

  group('bufferedChunkPayloads(cutoffSeq:) — the §2-R5 trim predicate', () {
    Future<void> fill3() async {
      await capture.start();
      recorder.feed(makePcm(kChunkBytes)); // seq 0
      recorder.feed(makePcm(kChunkBytes)); // seq 1
      recorder.feed(makePcm(kChunkBytes)); // seq 2
      await Future<void>.delayed(Duration.zero);
    }

    List<int> seqsOf(List<Map<String, Object?>> payloads) =>
        <int>[for (final Map<String, Object?> p in payloads) p['seq']! as int];

    test('no cutoff (today\'s call shape) ⇒ the whole ring', () async {
      await fill3();
      expect(seqsOf(capture.bufferedChunkPayloads()), <int>[0, 1, 2]);
      expect(seqsOf(capture.bufferedChunkPayloads(cutoffSeq: null)),
          <int>[0, 1, 2]);
    });

    test('-1 is a VALUE (session live, zero observed) and trims nothing',
        () async {
      await fill3();
      expect(
          seqsOf(capture.bufferedChunkPayloads(cutoffSeq: -1)), <int>[0, 1, 2]);
    });

    test('🔴 boundary: the chunk AT the watermark is trimmed (observed), the '
        'one after it is sent (unproven)', () async {
      await fill3();
      final List<int> seqs = seqsOf(capture.bufferedChunkPayloads(cutoffSeq: 1));
      expect(seqs, isNot(contains(1)),
          reason: 'seq == watermark: the server SAID it observed this chunk');
      expect(seqs, contains(2),
          reason: 'seq == watermark+1: nothing proves the server has it — '
              'trimming it would be loss, the one direction §5-4 forbids');
      expect(seqs, <int>[2]);
    });

    test('watermark at or past the newest seq ⇒ nothing to resend', () async {
      await fill3();
      expect(seqsOf(capture.bufferedChunkPayloads(cutoffSeq: 2)), isEmpty);
      expect(seqsOf(capture.bufferedChunkPayloads(cutoffSeq: 99)), isEmpty);
    });
  });
}
