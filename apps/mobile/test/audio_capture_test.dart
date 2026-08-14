// Audio-pipeline contract test (WP-R3-1): 6400-byte = 200 ms slicing, monotonic
// seq from 0, residual-tail flush, dBFS amplitude, and ring-buffer replay.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §3.

import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  late FakeAudioRecorder rec;
  late AudioCapture cap;
  late List<CapturedChunk> chunks;
  late List<double> amps;

  setUp(() {
    rec = FakeAudioRecorder();
    cap = AudioCapture(recorder: rec);
    chunks = <CapturedChunk>[];
    amps = <double>[];
    cap.chunks.listen(chunks.add);
    cap.amplitudeDb.listen(amps.add);
  });

  tearDown(() => cap.dispose());

  test('kChunkBytes is 6400 (200 ms × 16 kHz × 2 bytes)', () {
    expect(kChunkBytes, 6400);
  });

  test('one full frame yields exactly one chunk, seq 0', () async {
    await cap.start();
    rec.feed(makePcm(6400));
    await pumpEventQueue();
    expect(chunks.length, 1);
    expect(chunks.single.seq, 0);
    expect(chunks.single.payload.length, 6400);
  });

  test('sub-chunk fills accumulate; boundary crossing emits monotonic seq', () async {
    await cap.start();
    rec.feed(makePcm(4000)); // < 6400 → nothing yet
    await pumpEventQueue();
    expect(chunks, isEmpty);
    rec.feed(makePcm(4000)); // 8000 total → one 6400 chunk, 1600 left over
    await pumpEventQueue();
    expect(chunks.length, 1);
    expect(chunks[0].seq, 0);
    rec.feed(makePcm(6400)); // 8000 total → second chunk
    await pumpEventQueue();
    expect(chunks.length, 2);
    expect(chunks[1].seq, 1);
  });

  test('takeResidualChunk pops the < 200 ms tail with the next seq', () async {
    await cap.start();
    rec.feed(makePcm(6400)); // seq 0
    rec.feed(makePcm(3200)); // partial tail, no chunk yet
    await pumpEventQueue();
    expect(chunks.length, 1);
    final CapturedChunk? residual = cap.takeResidualChunk();
    expect(residual, isNotNull);
    expect(residual!.seq, 1);
    expect(residual.payload.length, 3200);
    // Tail landed in the ring buffer for reconnect replay.
    expect(cap.bufferedSize, 2);
    // Nothing left to pop.
    expect(cap.takeResidualChunk(), isNull);
  });

  test('amplitude is dBFS in [-100, 0]: silence floors at -100, tone above it', () async {
    await cap.start();
    rec.feed(Uint8List(6400)); // all zeros → silence
    await pumpEventQueue();
    expect(amps.last, -100.0);
    rec.feed(makePcm(6400, amplitude: 12000)); // loud tone
    await pumpEventQueue();
    expect(amps.last, greaterThan(-100.0));
    expect(amps.last, lessThanOrEqualTo(0.0));
  });

  test('bufferedChunkPayloads produces audio:chunk-shaped maps for replay', () async {
    await cap.start();
    rec.feed(makePcm(6400));
    rec.feed(makePcm(6400));
    await pumpEventQueue();
    final payloads = cap.bufferedChunkPayloads();
    expect(payloads.length, 2);
    expect(payloads.first.keys, containsAll(<String>['seq', 'ts_ms', 'data_b64']));
    expect(payloads.first['seq'], 0);
    expect(payloads[1]['seq'], 1);
  });

  // owner 2026-07-27, measured on the tablet: the platform recorder accepted
  // start(), reported no error, drove the red PTT bar and the running timer —
  // and delivered ZERO bytes. The server's intake tally said it plainly
  // (`audio intake {"chunks":0,"bytes":0}`) while the user was told
  // 「没有听到语音」, which blames the room for a microphone that never opened.
  group('dead-capture watchdog', () {
    test('a recorder that delivers nothing raises a LOUD fault', () async {
      final List<String> faults = <String>[];
      cap.faults.listen(faults.add);
      await cap.start();
      // …and then nothing at all arrives.
      await Future<void>.delayed(AudioCapture.kDeadCaptureAfter * 2);
      expect(faults, <String>['no-audio-captured']);
    });

    test('one byte of real audio is enough to clear it — no false alarm', () async {
      final List<String> faults = <String>[];
      cap.faults.listen(faults.add);
      await cap.start();
      rec.feed(makePcm(64)); // far below a chunk, but the mic is demonstrably open
      await Future<void>.delayed(AudioCapture.kDeadCaptureAfter * 2);
      expect(faults, isEmpty);
    });

    test('stopping disarms it — a finished utterance is not a dead mic', () async {
      final List<String> faults = <String>[];
      cap.faults.listen(faults.add);
      await cap.start();
      await cap.stop();
      await Future<void>.delayed(AudioCapture.kDeadCaptureAfter * 2);
      expect(faults, isEmpty);
    });
  });
}
