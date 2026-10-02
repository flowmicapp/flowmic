// NR-146 B1: audio loss is primary; manifest failure remains a second fact.
// Regression: journal_commit_failure_notice_test.dart, both event orders.
part of 'retained_audio_spill.dart';

void _onJournalNotice(RetainedAudioSpill spill, JournalNotice n) {
    debugPrint('[flowmic.audio] journal notice: $n');
    if (n.code != JournalNotice.codeAppendFailed &&
        n.code != JournalNotice.codeShortWrite &&
        n.code != JournalNotice.codeCommitFailed) {
      return;
    }
    if (spill._noticeRecordingId != n.recordingId) {
      spill._noticeRecordingId = n.recordingId;
      spill._noticeAudioLost = false;
      spill._noticeLostBytes = 0;
      spill._noticeCommitFailed = false;
    }
    if (n.code == JournalNotice.codeCommitFailed) {
      spill._noticeCommitFailed = true;
    } else {
      spill._noticeAudioLost = true;
      spill._noticeLostBytes += n.bytes ?? 0;
    }
    spill._store.announce(RetainedAudioNotice(
      code: spill._noticeAudioLost ? RetainedAudioNotice.codeWriteFailed
          : RetainedAudioNotice.codeCommitFailed,
      secondaryCode: spill._noticeAudioLost && spill._noticeCommitFailed
          ? RetainedAudioNotice.codeCommitFailed : null,
      bytes: spill._noticeLostBytes,
    ));
  }

