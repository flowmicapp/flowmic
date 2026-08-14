// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §2 F-7 (the 4 recording-state indicators:
//     ⏱ elapsed time / 📊 amplitude /
//     📡 network / 📍 segment count), §6.3 (the recording panel)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 1 T-5d
//
// The recording panel's numbers, split out of ChatController so the file-size
// cap holds and so this contract is testable without a session.
//
// EVERY field here is fed by a REAL source; nothing is synthesised for looks.
// The panel omits an indicator rather than guessing (anti-façade) — that is why
// [observedSegments] starts at 0 and stays there until a segment_idx is
// actually seen on the wire, and why [amplitudeWindow] is empty (not zero-
// filled) before the first sample.

import 'dart:async';

/// How many dBFS samples the 📊 meter keeps, oldest→newest.
const int kAmplitudeWindow = 8;

class RecordingTelemetry {
  RecordingTelemetry({required DateTime Function() clock, required void Function() onTick})
    : _clock = clock,
      _onTick = onTick;

  /// Wall-clock seam — injected so the ⏱ readout is deterministic in tests.
  final DateTime Function() _clock;

  /// Repaint request. Fired by the ticker only (see [addAmplitude]).
  final void Function() _onTick;

  DateTime? _startedAt;
  Duration _elapsed = Duration.zero;
  Timer? _ticker;
  final List<double> _amplitude = <double>[];
  int _observedSegments = 0;

  /// Elapsed capture time for the ⏱ readout. Frozen once recording ends.
  Duration get elapsed => _elapsed;

  /// Real dBFS history for the 📊 meter. Empty ⇒ no samples ⇒ the panel draws
  /// inert bars instead of faking motion.
  List<double> get amplitudeWindow => List<double>.unmodifiable(_amplitude);

  /// Soft segments observed on the wire this utterance (0 = none yet).
  int get observedSegments => _observedSegments;

  /// Clear everything for a fresh utterance.
  void reset() {
    _amplitude.clear();
    _observedSegments = 0;
    _elapsed = Duration.zero;
    _startedAt = null;
  }

  /// Begin at audio:start — the same edge the server times the 5-min cap from.
  void start() {
    _startedAt = _clock();
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      final DateTime? started = _startedAt;
      if (started == null) return;
      _elapsed = _clock().difference(started);
      _onTick();
    });
  }

  /// Capture ended (release / cancel / auto-stop / drop): freeze the readout.
  void stop() {
    _ticker?.cancel();
    _ticker = null;
  }

  /// One on-device dBFS sample.
  ///
  /// Deliberately does NOT request a repaint: the 200 ms ticker already
  /// repaints the panel, so the meter and the timer share one frame budget
  /// instead of each driving a rebuild at 5 Hz.
  void addAmplitude(double db) {
    _amplitude.add(db);
    if (_amplitude.length > kAmplitudeWindow) _amplitude.removeAt(0);
  }

  /// Record the highest segment_idx seen on the wire (soft segmentation rolls
  /// it over every 30 s server-side).
  void observeSegment(int segmentIdx) {
    if (segmentIdx + 1 > _observedSegments) _observedSegments = segmentIdx + 1;
  }

  void dispose() => stop();
}
