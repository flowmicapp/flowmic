// Part of audio_capture.dart — THE PLATFORM RECORDER SEAM.
//
// Everything between the OS recorder and this class's three streams: attaching
// and detaching it, and what happens to every buffer it hands us (slice at the
// chunk boundary, journal it, ring it, fan it out, meter it) plus the state
// transition that announces the result.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// `audio_capture.dart` reached 709 lines against this window's 700-line plan
// cap. The repo's standing move at a cap is a STRUCTURAL SPLIT with the bodies
// moved character-for-character, never deleting the evidence in the comments
// (CLAUDE.md, 0.2.52). This family was the cut with the least to argue about:
// nothing below is part of the public verb set (start / pause / resume / the
// three stops / the ring-buffer readers), nothing below is called from outside
// this library, and every one of them is private.
//
// 🔴 DIFF DISCIPLINE: the six members below are the previous methods moved
// verbatim. **Any other difference in the diff is a bug.** They live in an
// `extension` rather than as top-level functions taking the instance — the
// shape `recovery_leg_wire.dart` uses for the same reason — so every private
// field reference below reads exactly as it did inside the class.

part of 'audio_capture.dart';

extension AudioCapturePcm on AudioCapture {
  Future<void> _attachRecorder() async {
    await _recorder.start(
      sampleRate: kAudioSampleRate,
      numChannels: kAudioChannels,
    );
    _pcmSub = _recorder.pcmStream.listen(
      _onPcm,
      onError: _chunksController.addError,
    );
  }

  Future<void> _detachRecorder() async {
    _deadCaptureTimer?.cancel();
    _deadCaptureTimer = null;
    await _pcmSub?.cancel();
    _pcmSub = null;
    try {
      await _recorder.stop();
    } catch (_) {
      // Stop errors during pause/stop are non-fatal — the spec only requires
      // that the upstream audio:pause / audio:stop event fires.
    }
  }

  void _onPcm(Uint8List data) {
    // Counted BEFORE the state gate: bytes that arrive are proof the microphone
    // opened, even if this instance is no longer the one recording them.
    _platformBytes += data.length;
    // Announced BEFORE the state gate, for the same reason the counter above
    // is incremented before it: a byte that arrived is proof the microphone
    // opened, whoever owns the recording it belongs to.
    if (!_platformBytesController.isClosed) {
      _platformBytesController.add(data.length);
    }
    if (_state != RecorderState.recording) return;
    _accumulator.add(data);
    while (_accumulator.length >= _chunkBytes) {
      final taken = _accumulator.takeBytes();
      // takeBytes() returns the entire accumulator — slice off one chunk and
      // put the remainder back so partial fills survive across reads.
      final chunk = Uint8List.sublistView(taken, 0, _chunkBytes);
      if (taken.length > _chunkBytes) {
        _accumulator.add(Uint8List.sublistView(taken, _chunkBytes, taken.length));
      }
      _emitChunk(chunk);
    }
  }

  void _emitChunk(Uint8List payload) {
    final tsMs = _clock();
    final captured = CapturedChunk(seq: _seq, tsMs: tsMs, payload: payload);
    // Card LS-2 — THE LINE THAT CLOSES E7. It asks nothing about the uplink,
    // so a recognition provider that died behind a healthy socket no longer
    // means the only copy of these words is a ring that will evict them.
    _journalAppend(this, payload);
    _ringBuffer.push(seq: _seq, tsMs: tsMs, payload: payload, nowMs: tsMs);
    _chunksController.add(captured);
    _amplitudeController.add(_amplitudeDbFor(payload));
    _seq += 1;
  }

  void _transition(RecorderState next) {
    if (_state == next) return;
    _state = next;
    _stateController.add(next);
  }

  /// 08 §3: the amplitude meter feeds off this. Returns dBFS in `[-100, 0]`
  /// (silence → -100). Pure function over the slice payload so tests assert
  /// without microphone hardware.
  double _amplitudeDbFor(Uint8List payload) {
    if (payload.isEmpty) return -100.0;
    final samples = Int16List.view(
      payload.buffer,
      payload.offsetInBytes,
      payload.lengthInBytes ~/ 2,
    );
    var sumSq = 0.0;
    for (final s in samples) {
      sumSq += s * s;
    }
    final rms = math.sqrt(sumSq / samples.length);
    if (rms <= 0) return -100.0;
    final db = 20.0 * (math.log(rms / 32768.0) / math.ln10);
    return db.clamp(-100.0, 0.0).toDouble();
  }
}
