// Card N1-B3 — the persistent audio layer (design draft §2.2 / 15 册 §2.0-b segment ⊖).
//
// SPEC-REF:
//   docs/strategy/2026-08-08-design-n1-long-recording.md §2.2, §3 (J3 / J6 / J8)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//
// ⚠️ These tests drive a REAL filesystem (a fresh systemTemp directory per
// case), not an in-memory double. The judgment being made is 「the bytes are on
// disk」 and 「the file is gone」 — an assertion against a fake store would be
// asserting that our own bookkeeping agrees with itself, which is the failure
// shape 15 册 records for the mobile suite: 1259 tests green while the screen
// showed three letters.
//
// ⚠️ The clock is injected, so a 40-second outage is simulated instantly. No
// test here sleeps.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;
  late List<RetainedAudioNotice> notices;
  late FakeAudioRecorder rec;
  int fakeNow = 0;

  /// Distinguishable payloads: a pure-length assertion would pass even if the
  /// chunks were written in the wrong order, and out-of-order PCM is not a
  /// corrupt file — it is garbled speech that still transcribes to something.
  Uint8List chunkFor(int i) => makePcm(6400, amplitude: 1000 + i);

  Future<void> openStore({int? capBytes, Duration? ttl}) async {
    store = RetainedAudioStore(
      dir: tmp,
      capBytes: capBytes ?? RetainedAudioStore.kDefaultCapBytes,
      ttl: ttl ?? RetainedAudioStore.kDefaultTtl,
      clock: () => fakeNow,
    );
    await store.open();
    notices = <RetainedAudioNotice>[];
    store.notices.listen(notices.add);
    spill = RetainedAudioSpill(store: store);
  }

  setUp(() async {
    fakeNow = 0;
    tmp = await Directory.systemTemp.createTemp('flowmic_retained_');
    rec = FakeAudioRecorder();
    await openStore();
  });

  tearDown(() async {
    await store.dispose();
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  /// Feed [count] 200 ms chunks through a real AudioCapture, advancing the
  /// injected clock so the 30 s ring evicts exactly as it would in production.
  Future<AudioCapture> driveCapture({
    required int count,
    required bool uplinkUp,
  }) async {
    final AudioCapture cap = AudioCapture(
      recorder: rec,
      spill: spill,
      clock: () => fakeNow,
    );
    if (!uplinkUp) spill.noteUplinkDown();
    await cap.start();
    for (int i = 0; i < count; i++) {
      fakeNow = i * 200;
      rec.feed(chunkFor(i));
      await pumpEventQueue();
    }
    return cap;
  }

  // ───────────────────────────────────────────────── the healthy direction

  test(
      'HEALTHY LINK: 40 s of capture evicts 50 chunks and writes NOTHING '
      '(§2.2 zero cost — only a real outage pays I/O)', () async {
    final AudioCapture cap = await driveCapture(count: 200, uplinkUp: true);
    await spill.flush();

    // The ring really did evict — otherwise this test proves nothing about
    // the trigger, only that we never got near it (positive control).
    expect(cap.bufferedSize, lessThan(200),
        reason: 'ring must actually have evicted for this to measure anything');

    expect(store.retainedBytes, 0);
    expect(await store.pendingSegments(), isEmpty);
    expect(tmp.listSync().whereType<File>(), isEmpty);
    await cap.dispose();
  });

  // ─────────────────────────────────────────────────────────────── J3

  test(
      'J3: a >30 s outage loses ZERO audio — every byte captured is either '
      'still in the ring or on disk, in order', () async {
    const int total = 200; // 200 × 200 ms = 40 s, i.e. past the 30 s ring
    final AudioCapture cap = await driveCapture(count: total, uplinkUp: false);

    // Mid-run: the ring has already evicted, and those evictions were retained
    // rather than forgotten.
    await spill.flush();
    final int retainedMidRun = store.retainedBytes;
    expect(retainedMidRun, greaterThan(0),
        reason: 'a >30 s outage must have spilled something by now');

    // Stop with the uplink still down ⇒ the ring tail is retained too.
    await cap.stop();
    await spill.flush();

    expect(await store.pendingSegments(), <int>[0],
        reason: 'no inbound frame arrived during the outage, so the server '
            'never advanced segment_idx past 0');

    final Uint8List? got = await store.read(0);
    expect(got, isNotNull);

    final BytesBuilder expected = BytesBuilder();
    for (int i = 0; i < total; i++) {
      expected.add(chunkFor(i));
    }
    final Uint8List want = expected.takeBytes();

    expect(got!.length, want.length,
        reason: 'zero segments lost means zero BYTES lost: '
            '${want.length} captured, ${got.length} retained');
    expect(got, orderedEquals(want),
        reason: 'byte-identical AND in order — a length-only check would pass '
            'on shuffled PCM');
    await cap.dispose();
  });

  test('J3: retained audio is byte-identical to capture — no transcoding',
      () async {
    spill.noteUplinkDown();
    final Uint8List one = chunkFor(7);
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: one));
    await spill.flush();
    expect(await store.read(0), orderedEquals(one));
  });

  // ─────────────────────────────────────────────────────────────── J6

  test('J6: settling a segment DELETES its audio file — asserted on the '
      'filesystem, not on our own bookkeeping', () async {
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();

    final File f = File('${tmp.path}${Platform.pathSeparator}seg-0.pcm');
    expect(f.existsSync(), isTrue, reason: 'positive control: it was there');
    expect(store.retainedBytes, 6400);

    await spill.settleSegment(0);

    expect(f.existsSync(), isFalse,
        reason: 'settle ⇒ delete is the FB-2 boundary mechanism, not a '
            'cleanup nicety');
    expect(store.retainedBytes, 0);
    expect(await store.pendingSegments(), isEmpty);
  });

  test('J6: settling one segment leaves the others alone', () async {
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    spill.noteSegmentObserved(1);
    spill.onEvicted(BufferedChunk(seq: 1, tsMs: 0, payload: chunkFor(2)));
    await spill.flush();

    expect(await store.pendingSegments(), <int>[0, 1]);
    await spill.settleSegment(0);
    expect(await store.pendingSegments(), <int>[1]);
  });

  // ──────────────────────────────────────────────── cap: never silent

  test('CAP HIT: the oldest segment is dropped AND announced', () async {
    await openStore(capBytes: 12800); // exactly two chunks
    spill.noteUplinkDown();

    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    spill.noteSegmentObserved(1);
    spill.onEvicted(BufferedChunk(seq: 1, tsMs: 0, payload: chunkFor(2)));
    await spill.flush();
    expect(await store.pendingSegments(), <int>[0, 1]);
    expect(notices, isEmpty, reason: 'nothing dropped yet');

    // Third chunk on a third segment: something has to give.
    spill.noteSegmentObserved(2);
    spill.onEvicted(BufferedChunk(seq: 2, tsMs: 0, payload: chunkFor(3)));
    await spill.flush();
    await pumpEventQueue(); // notices ride a broadcast stream, not the flush

    expect(await store.pendingSegments(), <int>[1, 2],
        reason: 'the OLDEST goes first');
    expect(notices.map((RetainedAudioNotice n) => n.code),
        contains(RetainedAudioNotice.codeDroppedOldest));
    final RetainedAudioNotice dropped = notices.firstWhere(
        (RetainedAudioNotice n) =>
            n.code == RetainedAudioNotice.codeDroppedOldest);
    expect(dropped.segmentIdx, 0);
    expect(dropped.bytes, 6400,
        reason: 'the notice must say how much was lost, not merely that '
            'something was');
  });

  test('CAP HIT with nothing older to give up: the append is REFUSED and '
      'announced — never a silent drop', () async {
    await openStore(capBytes: 6400); // one chunk
    spill.noteUplinkDown();

    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    expect(store.retainedBytes, 6400);

    // Same segment, no older candidate: we must not throw away the beginning
    // of the very utterance we are preserving, so the NEW bytes are refused.
    spill.onEvicted(BufferedChunk(seq: 1, tsMs: 0, payload: chunkFor(2)));
    await spill.flush();
    await pumpEventQueue(); // notices ride a broadcast stream, not the flush

    expect(store.retainedBytes, 6400, reason: 'nothing grew');
    expect(spill.refusedChunks, 1);
    expect(notices.map((RetainedAudioNotice n) => n.code),
        contains(RetainedAudioNotice.codeCapReached));
  });

  test('CAP HIT announces ONCE per segment, not once per 200 ms chunk',
      () async {
    await openStore(capBytes: 6400);
    spill.noteUplinkDown();
    for (int i = 0; i < 5; i++) {
      spill.onEvicted(BufferedChunk(seq: i, tsMs: 0, payload: chunkFor(i)));
      await spill.flush();
    }
    await pumpEventQueue(); // notices ride a broadcast stream, not the flush
    final int capNotices = notices
        .where((RetainedAudioNotice n) =>
            n.code == RetainedAudioNotice.codeCapReached)
        .length;
    expect(capNotices, 1, reason: 'a full store must not spam the log at 5 Hz');
    expect(spill.refusedChunks, 4);
  });

  // ─────────────────────────────────────────────────── TTL backstop

  test('TTL backstop: unclaimable audio ages out AND says so', () async {
    await openStore(ttl: const Duration(hours: 1));
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    expect(await store.pendingSegments(), <int>[0]);

    fakeNow = const Duration(hours: 2).inMilliseconds +
        DateTime.now().millisecondsSinceEpoch;
    await store.sweep();
    await pumpEventQueue(); // notices ride a broadcast stream, not the flush

    expect(await store.pendingSegments(), isEmpty);
    expect(notices.map((RetainedAudioNotice n) => n.code),
        contains(RetainedAudioNotice.codeExpired));
  });

  // ─────────────────────────────────────── keying + lifecycle guards

  test('segment key never walks backwards on a late/replayed frame', () {
    spill.noteSegmentObserved(3);
    spill.noteSegmentObserved(1); // late arrival
    expect(spill.currentSegmentIdx, 3,
        reason: 'walking back would append live audio onto a closed segment');
  });

  test('uplink coming back stops retention but keeps what was retained',
      () async {
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    expect(store.retainedBytes, 6400);

    spill.noteUplinkUp();
    spill.onEvicted(BufferedChunk(seq: 1, tsMs: 0, payload: chunkFor(2)));
    await spill.flush();

    expect(store.retainedBytes, 6400,
        reason: 'healthy link ⇒ no new writes; the outage audio still stands '
            'until its segment settles');
  });

  test('CANCEL (fenceAndStop) does NOT retain the ring tail', () async {
    final AudioCapture cap = await driveCapture(count: 10, uplinkUp: false);
    cap.fenceAndStop();
    await spill.flush();
    expect(store.retainedBytes, 0,
        reason: 'a cancelled utterance never happened — retaining it would '
            'resurface as 「待转录」 for something the user threw away');
    await cap.dispose();
  });

  test('stop() retains the ring tail that never aged out', () async {
    final AudioCapture cap = await driveCapture(count: 10, uplinkUp: false);
    // 10 chunks over 2 s: nothing has aged out of a 30 s ring yet.
    await spill.flush();
    expect(store.retainedBytes, 0, reason: 'positive control: no evictions yet');

    await cap.stop();
    await spill.flush();
    expect(store.retainedBytes, 10 * 6400,
        reason: 'without this the last ≤30 s of every outage would still be '
            'lost — the eviction trigger covers the middle, not the tail');
    await cap.dispose();
  });

  test('reopening the store seeds retainedBytes from what is on disk',
      () async {
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: chunkFor(1)));
    await spill.flush();
    await store.dispose();

    await openStore();
    expect(store.retainedBytes, 6400,
        reason: 'an app killed mid-outage must not lose track of its own '
            'retained bytes and blow past the cap');
  });
}
