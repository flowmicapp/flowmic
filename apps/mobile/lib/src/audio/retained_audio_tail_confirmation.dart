// NR-146/R11: a stop request is not confirmation that audio reached storage.
// Regression: ptt_retention_confirmation_test.dart holds/fails the real write seam.
part of 'retained_audio_spill.dart';

Future<bool> _retainTailConfirmed(
    RetainedAudioSpill s, List<BufferedChunk> chunks) async {
  if (chunks.isEmpty) return false;
  final int expected = chunks.fold(0, (int n, BufferedChunk c) => n + c.payload.length);
  if (s._retainFromFirstFrame) {
    final Completer<bool> out = Completer<bool>();
    s._journalOps = s._journalOps.then((_) async {
      try {
        final RetainedAudioJournal? j = s._journal;
        final bool saved = j != null && await j.commit();
        out.complete(saved && j.failedAppendCount == 0 &&
            !s._journalCapAnnounced && j.committedClaimBytes >= expected);
      } on Object {
        s.handleJournalNotice(JournalNotice(code: JournalNotice.codeCommitFailed,
          recordingId: s._recordingId ?? s._noticeRecordingId ?? s._store.sessionKey));
        out.complete(false);
      }
    });
    return out.future;
  }
  final int failures = s._failedWrites;
  final int refused = s._refusedChunks;
  final int segment = s._segmentIdx;
  await _retainTail(s, chunks);
  if (s._failedWrites != failures || s._refusedChunks != refused) return false;
  final Uint8List? saved = await s._store.read(segment);
  return saved != null && saved.length >= expected;
}
