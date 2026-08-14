// SPEC-REF:
//   docs/strategy/2026-08-08-design-n1-long-recording.md §2.2 (M2 — disk-spill trigger)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//   apps/mobile/lib/src/audio/ring_buffer.dart (AudioRingBuffer.onEvict — the
//     seam this class subscribes to)
//
// ── WHEN TO SPILL ───────────────────────────────────────────────────────────
//
// NOT "always write to disk". The design's trigger (§2.2) is: spill exactly
// when the ring is about to evict a chunk the server has not confirmed
// receiving. Healthy link ⇒ nothing is ever written and this layer costs zero
// I/O; only a real outage pays.
//
// 🔴 THE DESIGN'S PREDICATE DOES NOT EXIST IN THIS CODEBASE, AND THIS COMMENT
// IS THE HONEST SUBSTITUTE.
// 「the server has not yet confirmed receiving」 presumes a per-chunk
// acknowledgement. There is none: `audio:chunk` is fire-and-forget in both
// directions — the phone emits through `AudioEmitter.emitChunk` with no ack
// callback, and the server's `socket.on('audio:chunk', …)` in
// `apps/server-core/src/socket/handlers/audio.handler.ts` answers nothing.
// (Verified by grep 2026-08-08, card N1-B3; the nearest thing to a watermark is
// the reconnect replay, which re-sends the WHOLE ring window precisely because
// no watermark exists.) Building the ack would be a protocol change — owner-gated
// — so this card does not invent one.
//
// The predicate actually available, and the one used here, is
// 「the uplink was down while this chunk was live」. It is observable, it is the
// same fact `ptt_capture_pump._emitChunk` already holds in its catch block
// (whose comment 「the ring buffer replays it on the next reconnect edge」 is the
// promise this layer exists to make true past 30 s), and it errs in the safe
// direction: a chunk that WAS delivered but got retained anyway costs disk, not
// data. The reverse error — believing a chunk was delivered when it was not —
// is the one that loses the user's words, and this predicate cannot make it.
//
// ⚠️ [uplinkUp] DEFAULTS TO TRUE ON PURPOSE. An unwired build therefore behaves
// exactly as the phone behaves today: nothing is written, nothing is promised.
// That is a graceful degradation to the status quo rather than a façade — but it
// is also why 「待转录」("pending transcription") MUST NOT ship as a user-facing
// word until the signal below has a production caller (Book 15 §2.0-b
// constraint 3).
//
// ── WHY ONE FILE PER SEGMENT, AND WHAT THAT DEGRADES TO ─────────────────────
//
// The segment is the unit because the server already delimits it and already
// guarantees one final per `segment_idx` (W2.5-B). This class does NOT invent a
// second segmentation scheme (design doc §6, 「刻意不做的」 "deliberately not
// done").
//
// 🔴 But note what that means during the exact situation this layer is for: the
// phone only ever learns `segment_idx` INBOUND, from `stt:interim` / `stt:final`
// (`stt/stt_stream.dart` parses it; `session/recording_telemetry.dart` tracks the
// highest seen). During an outage NO frames arrive, so the observed index is
// FROZEN at whatever the server had reached when the link died. An entire
// offline stretch therefore lands in ONE file, keyed by the last segment the
// server actually delimited — not in one file per 30 s as a reader of the design
// might expect. That is correct (we must not fabricate segment boundaries the
// server never issued), but it is not what §2.2 reads like, so it is written
// down here rather than discovered later.

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'ring_buffer.dart';
import 'retained_audio_store.dart';

/// Decides whether an evicted ring chunk becomes retained audio, and keys it to
/// a segment. Retention policy itself lives in [RetainedAudioStore].
class RetainedAudioSpill {
  final RetainedAudioStore _store;

  /// See the header: default true ⇒ an unwired build writes nothing.
  bool _uplinkUp = true;

  /// Last `segment_idx` the SERVER delimited, as observed on inbound stt
  /// frames. Starts at 0: before any frame arrives the utterance is, by the
  /// server's own numbering, segment 0.
  int _segmentIdx = 0;

  /// Serialises appends. Eviction is synchronous (it happens inside
  /// [AudioRingBuffer.prune]) while writing is async, so without this chain two
  /// evictions could interleave their writes and produce PCM in the wrong
  /// order — which is not a corrupt file, it is garbled speech that still
  /// transcribes to something, i.e. a silent data corruption.
  Future<void> _writes = Future<void>.value();

  /// Chunks that were dropped because the store refused them (cap reached).
  /// Counted so a caller can assert on it; the store has already announced each
  /// one on [RetainedAudioStore.notices].
  int _refusedChunks = 0;

  RetainedAudioSpill({required RetainedAudioStore store}) : _store = store;

  RetainedAudioStore get store => _store;

  bool get uplinkUp => _uplinkUp;

  int get currentSegmentIdx => _segmentIdx;

  int get refusedChunks => _refusedChunks;

  /// The uplink is down: from here, chunks aging out of the ring are retained
  /// instead of discarded.
  void noteUplinkDown() {
    if (!_uplinkUp) return;
    _uplinkUp = false;
    debugPrint('[flowmic.audio] uplink DOWN — ring evictions now retained');
  }

  /// The uplink is back. Chunks aging out of the ring are discarded again; the
  /// audio retained while it was down stays on disk until each segment settles
  /// (or the TTL backstop takes it).
  void noteUplinkUp() {
    if (_uplinkUp) return;
    _uplinkUp = true;
    debugPrint('[flowmic.audio] uplink UP — ring evictions discarded again');
  }

  /// Record the `segment_idx` seen on an inbound stt frame. Monotonic: a late
  /// or replayed frame carrying an older index must not walk the key backwards
  /// and start appending live audio onto a segment that already closed.
  void noteSegmentObserved(int segmentIdx) {
    if (segmentIdx > _segmentIdx) _segmentIdx = segmentIdx;
  }

  /// Ring eviction sink. Wired to [AudioRingBuffer.onEvict]; synchronous by
  /// necessity, so the write is queued rather than awaited.
  void onEvicted(BufferedChunk chunk) {
    if (_uplinkUp) return; // healthy link ⇒ zero I/O, per §2.2
    final int idx = _segmentIdx;
    _writes = _writes.then((_) async {
      final bool kept =
          await _store.append(segmentIdx: idx, bytes: chunk.payload);
      if (!kept) _refusedChunks += 1;
    });
  }

  /// Retain chunks that are still IN the ring because capture ended before they
  /// aged out. Called from `AudioCapture.retainUnsentTail` on the stop path; see
  /// that method for why the eviction trigger alone is not enough.
  Future<void> retainTail(Iterable<BufferedChunk> chunks) async {
    if (_uplinkUp) return;
    for (final BufferedChunk c in chunks) {
      onEvicted(c);
    }
    await flush();
  }

  /// Await every queued append. Tests and recovery both need this: eviction is
  /// fire-and-forget by design, so "is it on disk yet?" has no answer without
  /// it.
  Future<void> flush() => _writes;

  /// 🔴 J6 — the segment settled, so its audio goes NOW. Delegates to the store
  /// after draining queued writes, otherwise an append still in the chain could
  /// land after the delete and resurrect the file.
  Future<void> settleSegment(int segmentIdx) async {
    await flush();
    await _store.settle(segmentIdx);
  }

  /// Segments with retained audio, ascending. Recovery re-feeds IN THIS ORDER.
  Future<List<int>> pendingSegments() async {
    await flush();
    return _store.pendingSegments();
  }

  /// Retained bytes for one segment, for the recovery feed.
  Future<Uint8List?> readSegment(int segmentIdx) async {
    await flush();
    return _store.read(segmentIdx);
  }
}
