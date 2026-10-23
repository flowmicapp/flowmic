// D-14 VERBATIM split (NR-214, 2026-10-14): `JournalHoleLedger` moved here
// unchanged from retained_audio_manifest.dart, which had reached the 800-line
// cap and needed one more field. A `part`, so it keeps the private helpers it
// shares with the manifest; nothing about it changed but its file.

part of 'retained_audio_manifest.dart';

/// The running record of what did not land, in STREAM coordinates.
///
/// 🔴 A HOLE'S `start` IS A POSITION IN THE CAPTURED STREAM, NOT A FILE OFFSET.
/// The two agree only until the first loss. Drill D-5b (2026-09-06, device
/// HA2F8D3H) recorded 132 holes at 2 distinct starts: nothing had landed
/// between the failures, so every catch re-used the same file length and all
/// 132 ranges overlapped. `sum(length)` was right (835,584 B) but the UNION of
/// the ranges was 6,400 B — a reader who merges instead of adding under-reports
/// the loss by ~130x. This ledger advances the cursor past every missing byte,
/// so union == sum by construction.
class JournalHoleLedger {
  final List<JournalHole> _holes = <JournalHole>[];
  int _missing = 0;

  List<JournalHole> get holes => List<JournalHole>.unmodifiable(_holes);

  /// Total bytes recorded as missing. Equals the sum of [holes] lengths.
  int get missingBytes => _missing;

  /// Stream position of the next byte, given the file currently holds
  /// [observedBytes].
  int cursor(int observedBytes) => observedBytes + _missing;

  /// Reload from a manifest being resumed, so the cursor continues past what a
  /// previous run already lost.
  void restore(List<JournalHole> prior) {
    _holes.addAll(prior);
    for (final JournalHole h in prior) {
      _missing += h.length;
    }
  }

  /// Record [length] bytes missing at stream position [start].
  ///
  /// Adjacent holes with the same reason coalesce: a disk that stays full emits
  /// one failure per captured chunk, and 132 rows describing one continuous gap
  /// are 132 chances for a reader to mis-add them.
  void record({
    required int start,
    required int length,
    required String reason,
  }) {
    if (length <= 0) return;
    _missing += length;
    if (_holes.isNotEmpty) {
      final JournalHole last = _holes.last;
      if (last.reason == reason && last.start + last.length == start) {
        _holes[_holes.length - 1] = JournalHole(
          start: last.start,
          length: last.length + length,
          reason: reason,
        );
        return;
      }
    }
    _holes.add(JournalHole(start: start, length: length, reason: reason));
  }
}
