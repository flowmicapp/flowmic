// 700-line cap — the WRITE-FAILURE RECORDS, moved out of
// retained_audio_spill.dart VERBATIM on 2026-09-06 (card LS-1b) to make room
// for the live settle path. Not one character of either class changed; the
// only edit is this header and the `part of` line.
//
// WHY THIS IS THE RIGHT CUT: retained_audio_spill.dart answers 「what happens to
// captured audio」. These two answer 「what do we say about the stretch that did
// not make it」 — a value pair with no behaviour, read by the spill and by the
// tests, and by nothing else (grep 2026-09-06: `retained_audio_spill.dart` +
// `test/retained_audio_write_failure_poison_test.dart`).

part of 'retained_audio_spill.dart';

/// An interval of captured audio that this layer was asked to keep and could
/// not. P1-1 (card LS-1b).
///
/// 🔴 It is a RECORD, not an apology. §A9 P1-1 ④: the honest sentence is 「this
/// stretch has no local copy」 — never 「nothing has been saved since」, because
/// the interval after the hole may well still be being written.
class RetainedAudioHole {
  /// The `segment_idx` the bytes would have been filed under.
  final int segmentIdx;

  /// The ring buffer's own sequence number for the chunk. The nearest thing to
  /// a position this layer has: the store appends, so it never learns a byte
  /// offset, and inventing one here would be a coordinate nobody can check.
  final int seq;

  final int bytes;

  /// The error, stringified. Machine-facing; not a user sentence.
  final String reason;

  const RetainedAudioHole({
    required this.segmentIdx,
    required this.seq,
    required this.bytes,
    required this.reason,
  });

  @override
  String toString() =>
      'RetainedAudioHole(segment=$segmentIdx, seq=$seq, bytes=$bytes, '
      'reason=$reason)';
}

/// Announced on [RetainedAudioSpill.writeFailures] for each [RetainedAudioHole].
class RetainedAudioWriteFailure {
  final RetainedAudioHole hole;
  final Object error;

  const RetainedAudioWriteFailure({required this.hole, required this.error});

  @override
  String toString() => 'RetainedAudioWriteFailure($hole)';
}
