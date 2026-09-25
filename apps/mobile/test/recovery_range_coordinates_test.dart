// Card RC-1a — THE RECOVERY QUEUE CORE: the sample-coordinate half.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A10's failure-test tables (the group name below is that test's name)
//
// Moved VERBATIM out of recovery_queue_core_test.dart (D-14: that file went over
// the 1200-line test cap when the RC-2 and RC-3 branches were merged into
// integ/next-release, 2026-09-24). This group needs no rig and no helper from
// that file, which is why it is the one that moved; nothing in it changed.

import 'package:flowmic/src/audio/retained_audio_manifest.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('range_boundary_continuity_test / sub_chunk_residual_test', () {
    test('adjacent half-open ranges touch and never overlap', () {
      const RecoverySampleRange a = RecoverySampleRange(0, 3200);
      const RecoverySampleRange b = RecoverySampleRange(3200, 4800);
      expect(a.joinsTo(b), isTrue);
      expect(a.overlaps(b), isFalse);
      expect(a.overlaps(const RecoverySampleRange(3199, 4000)), isTrue);
      expect(a.lengthSamples + b.lengthSamples, 4800);
    });

    test('a sub-200ms residual is measured in samples, not in 6400-byte frames',
        () {
      // 3200 bytes = 100 ms = 1600 samples. It is NOT a multiple of the 6400
      // transport frame, and A3-2a forbids deriving the coordinate from that.
      final RecoverySampleRange r = RecoverySampleRange.fromBytes(
          const JournalByteRange(0, 3200), AudioJournalFormat.current);
      expect(r.endSample, 1600);
      expect(3200 % 6400, isNot(0));
    });

    test('an odd byte offset is refused as a coordinate, not rounded', () {
      expect(
          () => RecoverySampleRange.fromBytes(
              const JournalByteRange(0, 3201), AudioJournalFormat.current),
          throwsArgumentError);
    });
  });
}
