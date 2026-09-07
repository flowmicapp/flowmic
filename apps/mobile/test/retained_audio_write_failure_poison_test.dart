// Card LS-1b / P1-1 — the poisoned retention write chain (audit evidence E44).
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A2 E44, A9 stage 1 (retained_audio_spill.dart row), A10 tests
//     `write_failure_poison_chain_test` / `stop_survives_write_failure_test`
//
// 🔴 WHAT WAS WRONG, AND WHY NO EXISTING TEST SAW IT. The spill queued every
// append as `_writes = _writes.then(...)` with no error handling. One throw
// left that future permanently rejected, and a rejected future's `.then`
// callbacks never run — so from the first I/O error onward the retention layer
// wrote NOTHING, while capture, the ring buffer and every status line carried
// on exactly as before. On top of that, `flush()` handed the same rejected
// future to its awaiter, which on the stop path is `AudioCapture.stop()`:
// a disk error minutes earlier surfaced as a failure to stop the microphone.
//
// The suite could not see it because no test ever made a write fail. Every
// retention test drove a real, healthy temp directory.
//
// ⚠️ These tests inject the failure by subclassing the real store rather than
// faking the filesystem: the assertion is 「the bytes of the LATER chunks are
// on the disk」, and a fake store would only prove our bookkeeping agrees with
// itself.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// The real store, with a scriptable I/O failure. `append` is the exact seam
/// the spill calls, so the failure enters production code at the production
/// boundary.
class _FlakyStore extends RetainedAudioStore {
  _FlakyStore({required super.dir}) : super(clock: () => 0);

  /// 1-based call numbers that should throw.
  final Set<int> throwOnCall = <int>{};
  int calls = 0;

  @override
  Future<bool> append({
    required int segmentIdx,
    required Uint8List bytes,
  }) async {
    calls += 1;
    if (throwOnCall.contains(calls)) {
      throw const FileSystemException('injected write failure');
    }
    return super.append(segmentIdx: segmentIdx, bytes: bytes);
  }
}

void main() {
  late Directory tmp;
  late _FlakyStore store;
  late RetainedAudioSpill spill;

  Uint8List chunkFor(int i) => makePcm(6400, amplitude: 1000 + i);

  BufferedChunk buffered(int seq) =>
      BufferedChunk(seq: seq, tsMs: seq * 200, payload: chunkFor(seq));

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-poison-');
    store = _FlakyStore(dir: tmp);
    await store.open();
    spill = RetainedAudioSpill(store: store);
  });

  tearDown(() async {
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  });

  group('write_failure_poison_chain_test', () {
    test('one failed append does not stop the ones behind it', () async {
      final List<RetainedAudioWriteFailure> announced =
          <RetainedAudioWriteFailure>[];
      spill.writeFailures.listen(announced.add);

      spill.noteUplinkDown();
      store.throwOnCall.add(1);
      spill.onEvicted(buffered(0)); // fails
      spill.onEvicted(buffered(1)); // must still land
      spill.onEvicted(buffered(2)); // must still land
      await spill.flush();
      // The announcement is delivered on a microtask.
      await Future<void>.delayed(Duration.zero);

      final Uint8List? onDisk = await store.read(0);
      expect(onDisk, isNotNull,
          reason: 'chunks 1 and 2 were queued behind a failure and must have '
              'reached the disk anyway');
      expect(onDisk!.length, 6400 * 2);
      // Order and identity, not just length: out-of-order PCM still
      // transcribes to something, which is a silent corruption.
      expect(onDisk.sublist(0, 6400), chunkFor(1));
      expect(onDisk.sublist(6400), chunkFor(2));

      expect(spill.failedWrites, 1);
      expect(spill.holes, hasLength(1));
      expect(spill.holes.single.seq, 0);
      expect(spill.holes.single.bytes, 6400);
      expect(announced, hasLength(1));
    });

    test('flush() never rethrows a past failure to its awaiter', () async {
      spill.noteUplinkDown();
      store.throwOnCall.add(1);
      spill.onEvicted(buffered(0));
      // The assertion is the absence of a throw: before P1-1 this line raised
      // the FileSystemException at whichever caller happened to be asking
      // whether the queue had drained.
      await expectLater(spill.flush(), completes);
      // ...and it stays clean on every later call, too.
      spill.onEvicted(buffered(1));
      await expectLater(spill.flush(), completes);
      expect(await store.read(0), isNotNull);
    });

    test('a hole is recorded rather than swallowed', () async {
      spill.noteUplinkDown();
      store.throwOnCall
        ..add(2)
        ..add(3);
      spill.onEvicted(buffered(0));
      spill.onEvicted(buffered(1));
      spill.onEvicted(buffered(2));
      spill.onEvicted(buffered(3));
      await spill.flush();

      expect(spill.failedWrites, 2);
      expect(spill.holes.map((RetainedAudioHole h) => h.seq), <int>[1, 2]);
      // 🔴 Two chunks are missing and the record says WHICH. The wording rule
      // (A9 P1-1 ④) lives with the banner layer; what this layer owes it is
      // the interval, so the sentence can be 「this stretch has no local copy」
      // rather than 「nothing has been saved since」.
      expect(spill.holes.every((RetainedAudioHole h) => h.bytes == 6400), true);
      // 🔴 CARD LS-2 — AND IT REACHES THE VALUE A SCREEN READS. Until then
      // this fact stopped at `spill.writeFailures`, a broadcast stream with no
      // subscriber, which is exactly as gone as never raising it. The banner
      // queue binds to `store.lastNotice` (session/chat_notices.dart), so that
      // is where the announcement has to land.
      await pumpEventQueue();
      expect(store.lastNotice.value?.code,
          RetainedAudioNotice.codeWriteFailed);
    });
  });

  group('stop_survives_write_failure_test', () {
    late FakeAudioRecorder recorder;
    late AudioCapture capture;

    setUp(() async {
      recorder = FakeAudioRecorder();
      capture = AudioCapture(recorder: recorder, spill: spill);
    });

    test('stop() releases the recorder even when retention throws', () async {
      await capture.start();
      recorder.feed(makePcm(6400));
      await Future<void>.delayed(Duration.zero);
      capture.noteUplinkDown();
      store.throwOnCall.add(1);

      await expectLater(capture.stop(), completes);

      expect(recorder.started, isFalse,
          reason: 'the microphone must be released even when the safety net '
              'failed — the user asked to stop, not to save');
      expect(capture.currentState, RecorderState.stopped);
      expect(spill.failedWrites, greaterThanOrEqualTo(1));
    });

    test('stopForLinkLoss() releases the recorder even when retention throws',
        () async {
      await capture.start();
      recorder.feed(makePcm(6400));
      await Future<void>.delayed(Duration.zero);
      store.throwOnCall.add(1);

      expect(capture.stopForLinkLoss(), isTrue);
      await spill.flush();
      await Future<void>.delayed(Duration.zero);

      expect(capture.currentState, RecorderState.stopped);
      expect(spill.failedWrites, greaterThanOrEqualTo(1));
    });
  });
}
