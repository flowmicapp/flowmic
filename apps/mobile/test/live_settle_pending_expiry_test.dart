// Card SD-2 — THE CRASH FALLBACK OF THE 「a live settle is coming」 STAMP.
//
// The stamp itself, and the window it covers, are measured end to end in
// `live_settle_test.dart` (group `live_settle_pending_sweep_test`). What is
// measured HERE is the other half: what happens when nobody ever clears it.
//
// 🔴 WHY IT IS ITS OWN FILE. These cases drive `RetainedAudioJournalScan`
// against hand-written manifests on a fake clock — no session, no controller,
// no rig — and the rig's file-level `tearDown` would dispose a `_Rig` that this
// file never built.
//
// SPEC-REF: owner ruling O-2 (unrecovered audio counts against the cap, so a
//   recording nothing lists and nobody can remove is a defect in its own
//   right) — which is exactly what a BOOLEAN 「settle pending」 flag would
//   create the first time a process died in the window.

import 'dart:io';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// One 200 ms frame at 16 kHz mono s16le.
const int _frameBytes = 6400;

void main() {
  // 🔴 SD-2's CRASH FALLBACK. A process killed between the stamp and the
  // settle leaves the stamp with nobody to clear it. A boolean flag would hide
  // that recording from the recovery queue forever — which owner ruling O-2
  // names as a defect in its own right (invisible and undeletable) and which
  // would be strictly worse than the duplicate the stamp prevents. So the stamp
  // is a TIMESTAMP and readers stop believing it after
  // [kLiveSettlePendingGraceMs].
  group('live_settle_pending_expiry_test (SD-2)', () {
    late Directory dir;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('flowmic-sd2-');
    });

    tearDown(() async {
      await removeTempDir(dir);
    });

    Future<List<RecordingScan>> scanAt(int nowMs) =>
        RetainedAudioJournalScan.scan(dirPath: dir.path, clock: () => nowMs);

    Future<void> writeStamped(String id, int atMs) async {
      final RetainedAudioJournal j =
          await RetainedAudioJournal.open(dirPath: dir.path, recordingId: id);
      await j.appendPcm(makePcm(_frameBytes));
      j.markLiveSettlePending(atMs);
      await j.close();
    }

    test('inside the window it is held; after it, it is a candidate again',
        () async {
      await writeStamped('rec-1', 1000);

      expect((await scanAt(1000)).single.liveSettlePending, isTrue);
      expect(
          (await scanAt(1000 + kLiveSettlePendingGraceMs - 1))
              .single
              .liveSettlePending,
          isTrue);
      expect(
          (await scanAt(1000 + kLiveSettlePendingGraceMs))
              .single
              .liveSettlePending,
          isFalse,
          reason: 'the crash fallback: nobody cleared it, so it expires');
      // And the recording is otherwise intact — it is a HOLD, not an exclusion.
      final RecordingScan after =
          (await scanAt(1000 + kLiveSettlePendingGraceMs)).single;
      expect(after.verifiedRecoverableRange.isEmpty, isFalse);
      expect(after.quarantined, isFalse);
    });

    test('a stamp from the future is not believed at all', () async {
      // A wall clock that moved backwards between the write and the read (a
      // timezone change, an NTP step). `now - t < grace` alone would then be
      // true forever, i.e. the one outcome this mechanism may not produce.
      await writeStamped('rec-2', 5000);
      expect((await scanAt(1000)).single.liveSettlePending, isFalse);
    });

    test('a manifest written before SD-2 carries no stamp', () async {
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
          dirPath: dir.path, recordingId: 'rec-3');
      await j.appendPcm(makePcm(_frameBytes));
      await j.close();
      expect((await scanAt(1)).single.liveSettlePending, isFalse);
    });
  });
}
