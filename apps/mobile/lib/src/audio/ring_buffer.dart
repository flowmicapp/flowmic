// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (30 s ring buffer; 200 ms slices)
//   packages/protocol/src/constants.ts AUDIO_DEFAULTS.client_ring_buffer_ms
//   13-LESSONS-LEARNED §2 N-family (blip < 30 s recovers losslessly)
//
// Bounded FIFO of (seq, ts_ms, payload) entries. Mirrors the server-side ring
// buffer semantics: `since(cutoff)` returns every chunk whose `ts_ms` is
// strictly greater than `cutoff`; `prune` drops anything older than
// `nowMs - windowMs`. The mobile copy is the disconnect-recovery source for the
// WS reconnect coordinator (08 §4).
//
// Ported from legacy apps/mobile/lib/services/audio/ring_buffer.dart
// (implementation mechanics carried over; contract per new rebuild spec).

import 'dart:typed_data';

import 'package:meta/meta.dart';

@immutable
class BufferedChunk {
  final int seq;
  final int tsMs;
  final Uint8List payload;

  const BufferedChunk({
    required this.seq,
    required this.tsMs,
    required this.payload,
  });
}

/// Bounded FIFO that retains the last [window] of audio chunks.
///
///   - `push` appends and prunes everything older than `nowMs - windowMs`.
///   - `since(cutoffMs)` returns chunks strictly newer than `cutoffMs`, in seq
///     (= insertion) order.
///   - `clear` empties the buffer.
class AudioRingBuffer {
  final int _windowMs;
  final List<BufferedChunk> _entries = <BufferedChunk>[];

  /// N1-B3 seam: called with each chunk as it ages out of the window, BEFORE it
  /// is forgotten. Until this existed, an eviction was the moment that audio
  /// stopped existing anywhere on the phone — there is no disk copy behind this
  /// buffer (there was none at all before card N1-B3). The retained-audio layer
  /// (retained_audio_spill.dart) subscribes here and keeps the chunk when the
  /// uplink is down.
  ///
  /// ⚠️ Synchronous on purpose: [prune] runs inside [push], and an async hook
  /// would let a second push evict past this one before it had looked at the
  /// chunk. Subscribers queue their own I/O.
  final void Function(BufferedChunk evicted)? onEvict;

  AudioRingBuffer({
    Duration window = const Duration(seconds: 30),
    this.onEvict,
  }) : _windowMs = window.inMilliseconds {
    if (_windowMs <= 0) {
      throw ArgumentError.value(
        window,
        'window',
        'window must be > 0 (08-MOBILE-SPEC §3 client ring buffer)',
      );
    }
  }

  /// Append a chunk and prune anything older than the configured window
  /// relative to [nowMs]. Defaults to the chunk's own timestamp.
  void push({
    required int seq,
    required int tsMs,
    required Uint8List payload,
    int? nowMs,
  }) {
    _entries.add(BufferedChunk(seq: seq, tsMs: tsMs, payload: payload));
    prune(nowMs: nowMs ?? tsMs);
  }

  /// Returns all buffered chunks whose `tsMs` is strictly greater than
  /// [cutoffMs], preserving insertion order.
  List<BufferedChunk> since({required int cutoffMs}) {
    final result = <BufferedChunk>[];
    for (final c in _entries) {
      if (c.tsMs > cutoffMs) result.add(c);
    }
    return result;
  }

  // `rangeBySeq(from, to)` was removed on 2026-07-31: it existed solely to
  // serve AudioCapture.replay(), which existed solely to answer the
  // `audio:resend-request` the server never sends. Deleting the event but
  // keeping the chain would only move the façade from the wire to the API.

  /// Drop entries older than `nowMs - windowMs`. Idempotent.
  void prune({required int nowMs}) {
    final cutoff = nowMs - _windowMs;
    while (_entries.isNotEmpty && _entries.first.tsMs < cutoff) {
      final BufferedChunk evicted = _entries.removeAt(0);
      onEvict?.call(evicted);
    }
  }

  int get size => _entries.length;

  void clear() => _entries.clear();
}
