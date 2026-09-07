// 700-line cap — THE LEGACY SEGMENT FACE, moved out of
// retained_audio_spill.dart VERBATIM on 2026-09-06 to make room for the
// journal-notice / manifest-republish family (card FX-1) that grew the mother
// file past the cap. Not one character of any of these bodies changed; the
// only edits are this header, the `part of` line, and the mechanical
// `RetainedAudioSpill` receiver each function now takes because a `part` file
// cannot reopen a class — it can only add top-level declarations to the same
// library. Every private field these functions touch (`_uplinkUp`,
// `_segmentIdx`, `_writes`, `_refusedChunks`, `_failedWrites`, `_holes`,
// `_writeFailures`, `_store`, `_retainFromFirstFrame`) stays declared on the
// class in retained_audio_spill.dart; being in the same library is what makes
// that reachable from here.
//
// WHY THIS IS THE RIGHT CUT: the mother file's own header (§「WHICH FACE IS
// LIVE」) already names this family — "OFF (the legacy face; no longer what
// ships): byte-for-byte the [eviction-triggered] behaviour". Everything below
// answers 「what happens on the pre-journal, eviction-triggered storage path」
// and nothing else; the journal face (retained_audio_live_settle.dart) never
// calls into it, and it never calls into the journal face except through the
// public `journalFlush()` seam `retainTail` already used before this move.

part of 'retained_audio_spill.dart';

/// The uplink is down: from here, chunks aging out of the ring are retained
/// instead of discarded.
void _noteUplinkDown(RetainedAudioSpill s) {
  if (!s._uplinkUp) return;
  s._uplinkUp = false;
  debugPrint('[flowmic.audio] uplink DOWN — ring evictions now retained');
}

/// The uplink is back. Chunks aging out of the ring are discarded again; the
/// audio retained while it was down stays on disk until each segment settles
/// (or the TTL backstop takes it).
void _noteUplinkUp(RetainedAudioSpill s) {
  if (s._uplinkUp) return;
  s._uplinkUp = true;
  debugPrint('[flowmic.audio] uplink UP — ring evictions discarded again');
}

/// Record the `segment_idx` seen on an inbound stt frame. Monotonic: a late
/// or replayed frame carrying an older index must not walk the key backwards
/// and start appending live audio onto a segment that already closed.
void _noteSegmentObserved(RetainedAudioSpill s, int segmentIdx) {
  if (segmentIdx > s._segmentIdx) s._segmentIdx = segmentIdx;
}

/// Ring eviction sink. Wired to [AudioRingBuffer.onEvict]; synchronous by
/// necessity, so the write is queued rather than awaited.
void _onEvicted(RetainedAudioSpill s, BufferedChunk chunk) {
  // 🔴 LS-2: under the journal face, eviction is not a storage trigger at
  // all. Those bytes were written when they were CAPTURED, not when they
  // aged out, so writing them again here would store the same audio twice
  // and spend the O-2 budget twice. The ring goes back to being purely the
  // reconnect-replay window, which is what it was built as.
  if (s._retainFromFirstFrame) return;
  if (s._uplinkUp) return; // healthy link ⇒ zero I/O, per §2.2
  final int idx = s._segmentIdx;
  final Uint8List payload = chunk.payload;
  // 🔴 P1-1: `_appendOne` never completes with an error, so the chain's tail
  // is always a succeeded future and the NEXT eviction still gets its turn.
  s._writes = s._writes.then((_) => _appendOne(s, idx, chunk.seq, payload));
}

/// One queued append, with its failure contained. Never throws.
Future<void> _appendOne(
    RetainedAudioSpill s, int idx, int seq, Uint8List payload) async {
  try {
    final bool kept = await s._store.append(segmentIdx: idx, bytes: payload);
    if (!kept) s._refusedChunks += 1;
  } on Object catch (e) {
    s._failedWrites += 1;
    final RetainedAudioHole hole = RetainedAudioHole(
      segmentIdx: idx,
      seq: seq,
      bytes: payload.length,
      reason: '$e',
    );
    s._holes.add(hole);
    debugPrint('[flowmic.audio] retained-audio append FAILED: $hole');
    if (!s._writeFailures.isClosed) {
      s._writeFailures.add(RetainedAudioWriteFailure(hole: hole, error: e));
    }
    // 🔴 LS-2 — AND ONTO THE ONE VALUE A SCREEN READS. This stream's own doc
    // said the merge was LS-1b/LS-3 work and that no production subscriber
    // existed; it does now, and it is not a subscriber but the same
    // announcement the banner queue already binds to
    // (`onRetainedAudioNoticeRouted` in `session/chat_notices.dart` reads
    // `store.lastNotice`). A write
    // failure that only ever reached a broadcast stream nobody listened to
    // was as gone as one we never raised.
    s._store.announce(RetainedAudioNotice(
      code: RetainedAudioNotice.codeWriteFailed,
      segmentIdx: idx,
      bytes: payload.length,
    ));
  }
}

/// Retain chunks that are still IN the ring because capture ended before they
/// aged out. Called from `AudioCapture.retainUnsentTail` on the stop path; see
/// that method for why the eviction trigger alone is not enough.
Future<void> _retainTail(
    RetainedAudioSpill s, Iterable<BufferedChunk> chunks) async {
  if (s._retainFromFirstFrame) {
    // 🔴 LS-2: nothing to retain — every chunk in that ring, and the
    // residual partial ahead of it, is already in the journal. What the stop
    // path still needs from this call is the COMMIT, so that is what it
    // gets. Silently doing nothing here would leave the last second of every
    // recording claimed by no manifest.
    await s.journalFlush();
    return;
  }
  if (s._uplinkUp) return;
  for (final BufferedChunk c in chunks) {
    _onEvicted(s, c);
  }
  await _flush(s);
}

/// Await every queued append. Tests and recovery both need this: eviction is
/// fire-and-forget by design, so "is it on disk yet?" has no answer without
/// it.
///
/// 🔴 P1-1: this NEVER rethrows a past append failure. It used to hand back
/// `_writes` while `_writes` could be permanently rejected, so a stop path
/// asking "are the writes done?" got an exception describing something that
/// went wrong minutes ago and had nothing to do with stopping. Ask
/// [RetainedAudioSpill.failedWrites] / [RetainedAudioSpill.holes] /
/// [RetainedAudioSpill.writeFailures] what went wrong; `flush` only answers
/// "the queue has drained".
Future<void> _flush(RetainedAudioSpill s) => s._writes;

/// Segments with retained audio, ascending. Recovery re-feeds IN THIS ORDER.
Future<List<int>> _pendingSegments(RetainedAudioSpill s) async {
  await _flush(s);
  return s._store.pendingSegments();
}

/// Retained bytes for one segment, for the recovery feed.
Future<Uint8List?> _readSegment(RetainedAudioSpill s, int segmentIdx) async {
  await _flush(s);
  return s._store.read(segmentIdx);
}
