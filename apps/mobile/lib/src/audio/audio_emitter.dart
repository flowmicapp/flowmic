// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (audio:chunk payload: seq + ts_ms + b64)
//   packages/protocol/src/protocol-schemas-audio.ts (AudioChunkSchema)
//   13-LESSONS-LEARNED §3 D3 (event names come from the generated whitelist,
//     never a hand-written literal)
//
// Single canonical surface that builds the wire-level `audio:chunk` payload
// from a chunk source (live recorder OR ring-buffer replay) and emits it via a
// [SocketTransport]. Both the live path and the reconnect replay path flow
// through here so the payload shape and the event name stay in lock-step.
//
// Ported from legacy signaling/audio_emitter.dart; the event name is now the
// generated FlowMicEvents.audioChunk constant (no `'audio:chunk'` literal).

import 'dart:convert' show base64Encode;
import 'dart:typed_data' show Uint8List;

import '../../generated/flowmic_events.g.dart';
import '../signaling/socket_core.dart' show SocketTransport;

/// Single canonical surface for building + emitting an `audio:chunk` payload.
class AudioEmitter {
  AudioEmitter._();

  /// Build the wire payload for a single chunk (AudioChunkSchema shape).
  static Map<String, Object?> buildChunkPayload({
    required int seq,
    required int tsMs,
    required Uint8List payload,
  }) {
    return <String, Object?>{
      'seq': seq,
      'ts_ms': tsMs,
      'data_b64': base64Encode(payload),
    };
  }

  /// Emit a single chunk over the transport. Throws if the transport is
  /// closed; callers swallow per the best-effort pattern (live path drops on
  /// disconnect; replay path stops and lets the next reconnect reissue).
  static void emitChunk(
    SocketTransport transport, {
    required int seq,
    required int tsMs,
    required Uint8List payload,
  }) {
    transport.emit(
      FlowMicEvents.audioChunk,
      buildChunkPayload(seq: seq, tsMs: tsMs, payload: payload),
    );
  }

  /// Re-emit a pre-built chunk map during ring-buffer replay (already the
  /// AudioChunkSchema shape — avoids a redundant base64 re-encode).
  static void emitReplayChunk(
    SocketTransport transport,
    Map<String, Object?> chunk,
  ) {
    transport.emit(FlowMicEvents.audioChunk, chunk);
  }
}
