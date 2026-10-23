// NR-214 (review D7, R4) — a long recording killed by the system is caught up
// from where its live rows reach, never from byte 0.
//
// A killed recording never runs `_accountOwedTail` (ptt_capture_pump.dart):
// its manifest has no owed range, and the recovery scan used to read that as
// "the whole recording" (retained_audio_journal_scan.dart `_Owed.of`). On the
// relaunch the catch-up then re-fed audio whose words were already rows and
// appended them again. 【review 2026-10-10, R4】 the article held 44 s · 4
// parts of a 47.8 s recording, and the relaunched catch-up had fed 19.6 s
// within 7 s — far past the ~4 s that was actually owed.
//
// The writer half: each live segment final's row, once it read back, raises
// `RecordingManifest.liveCoveredBytes` to the answered position at that final
// (`chat_utterance_settle.dart` `_noteLiveCovered`). The reader half: a scan of
// a manifest with no owed range starts there. The "kill" below is a scan of the
// journal as it sits on disk while the recording is still running — exactly
// what a relaunch finds, since nothing after the last commit runs.

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const int _bytesPerMs = 32; // PCM16 mono 16 kHz

void main() {
  testWidgets(
    '🔴 NR-214: the live rows of a long recording are marked on the manifest, '
    'and a scan after a kill owes only what follows them',
    (WidgetTester t) async {
      await t.runAsync(() async {
        final Rc3Rig r = await Rc3Rig.open();
        try {
          await r.begin();
          await r.feedMs(10000);
          await r.interim(0, ackedMs: 9800);
          await r.segment('first part', 0, 10000);
          await r.feedMs(10000);
          await r.interim(1, ackedMs: 19800);
          await r.segment('second part', 1, 10000);
          await r.feedMs(4000);
          await r.until(
            () => r.rows.length >= 2,
            max: const Duration(seconds: 10),
          );
          // The mark is written after the row reads back, asynchronously.
          RecordingManifest? m;
          await r.untilAsync(() async {
            m = await r.manifest();
            return (m?.liveCoveredBytes ?? 0) >= 19000 * _bytesPerMs;
          }, max: const Duration(seconds: 10));
          expect(
            m?.liveCoveredBytes,
            19800 * _bytesPerMs,
            reason: 'the answered position when the second final landed',
          );
          expect(
            m?.owedRanges,
            isEmpty,
            reason: 'positive control: nothing measured a tail (no stop ran)',
          );

          // The app is killed here. What the relaunch scan sees:
          final String manifestPath = r.fs.paths.firstWhere(
            (String p) => p.endsWith(RetainedAudioJournal.manifestSuffix),
          );
          final String dir = manifestPath.substring(
            0,
            manifestPath.lastIndexOf('/'),
          );
          final List<RecordingScan> scans = await RetainedAudioJournalScan.scan(
            dirPath: dir,
            fs: r.fs,
            recordingId: m!.recordingId,
          );
          expect(scans, hasLength(1));
          final RecordingScan s = scans.single;
          expect(
            s.verifiedRecoverableRange.start,
            19800 * _bytesPerMs,
            reason: 'the catch-up must start after the live rows, not at 0',
          );
          expect(
            s.verifiedRecoverableRange.end,
            greaterThanOrEqualTo(23800 * _bytesPerMs),
            reason: 'positive control: the unanswered 4 s are still owed',
          );
        } finally {
          await r.dispose();
        }
      });
    },
  );
}
