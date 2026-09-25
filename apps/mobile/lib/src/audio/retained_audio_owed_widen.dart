// Card RC-P — THE OWED TAIL OF A STOPPED RECORDING, ON DISK.
//
// A `part` of retained_audio_spill.dart (785 lines, the 800 cap) because it
// needs the spill's journal queue: the live terminal final regularly lands
// inside `AudioCapture.stop()` (retained_audio_live_settle.dart LK-4), so the
// recording's journal may still be open, and a second handle committing beside
// it would be two writers of one manifest (the last commit wins).
//
// ⚠️ 更正（Codex rc3 ①，2026-09-24）：原为「WIDEN AN OWED TAIL BACK TO THE
// SETTLED PREFIX WHEN THE DRAFT THAT WAS SUPPOSED TO COVER THE GAP NEVER CAME」
// (`widenOwedTail`). The stop wrote the tail from the ANSWERED position and the
// duty to widen it lived only in memory (`ArticleScribe._pendingTail`): a
// restart, or a new recording, before the draft final landed lost it, and the
// tail's settle then released the whole file with 36.8–45.2 s on no row. The
// direction is now reversed: the stop writes the tail from the SETTLED PREFIX
// (safe whatever happens to memory), and it is narrowed to the answered
// position only once the draft row is on disk (`narrowOwedTail`; since RC7
// `settleTailPieces`, which concludes only the tail's own pieces). The file
// keeps its name because the spill's `part` line names it.

part of 'retained_audio_spill.dart';

extension RetainedAudioOwedWiden on RetainedAudioSpill {
  /// Codex rc3 ① — [recordingId]'s owed tail, written from the prefix at the
  /// stop, is narrowed to [answeredBytes]: the dead leg's draft covering the gap
  /// is a row on disk (the caller checks that first). Card RC6 (F2 ②) — with
  /// [closingLegHeard], the relay's closing leg heard the rest of it and the
  /// same final carried it: the tail is concluded whole.
  ///
  /// ⚠️ 更正（RC7，Codex rc6 ①②，2026-09-25）：原为 `narrowOwedTail`, moving the
  /// start of the ONE range that began at the prefix — and RC6 marking that
  /// range done when the closing rung's `ready` arrived. That range could hold a
  /// bounded hole merged into it (the hole was concluded unrecovered), and the
  /// `ready` wrote before any word was on disk (a kill then lost the tail). Now
  /// only the pieces [oweTail] wrote are touched, and only here, after the
  /// draft is on disk: a piece the draft covers (it ends by [answeredBytes]) or
  /// the closing leg heard is marked done, one that straddles [answeredBytes]
  /// starts there. A stretch that is not a piece is never touched.
  Future<void> settleTailPieces(String recordingId,
          {required int answeredBytes, required bool closingLegHeard}) =>
      _onJournalOf(recordingId, (RetainedAudioJournal j, bool _) {
        final List<OwedRange>? pieces = _tailPieces[recordingId];
        if (pieces == null) return;
        final int frame = j.manifest.format.bytesPerFrame;
        final int to = answeredBytes - (answeredBytes % frame);
        for (final OwedRange p in pieces) {
          final int? end = p.end;
          if (closingLegHeard || (end != null && end <= to)) {
            j.markOwedRangeDone(p.start, OwedRange.doneSettled);
          } else if (p.start < to) {
            j.narrowOwedRangeStart(p.start, to);
          }
        }
        _tailPieces.remove(recordingId);
      });
}
