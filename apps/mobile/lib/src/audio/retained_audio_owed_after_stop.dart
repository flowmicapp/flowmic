// Card RC4-S5 — A RECORDING THAT LEARNS IT OWES ITS TAIL AFTER IT STOPPED.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:error` row (`unheard_from_ms`)
//
// RC-P owes a long recording's tail at the STOP, from what the phone itself sees
// then (the link or the engine down: `ptt_capture_pump.dart` `_accountOwedTail`,
// through [RetainedAudioSpill.noteOwedTail] while the journal is still open).
// CR-12-E re-run 4 (S5) stopped with the engine UP: the relay found only later —
// when its terminal path ran, 18 s after the stop — that a stretch had reached no
// engine, and said so with STT_SEGMENT_NOT_TRANSCRIBED. By then the journal was
// closed and stamped for the live settle, so [RetainedAudioSpill.noteOwedTail]
// (open journal only) wrote nothing, the live settle kept the file as
// `settled_unverified`, and nothing ever recovered the stretch.
//
// A `part` of retained_audio_spill.dart for the reason retained_audio_owed_widen
// .dart gives: it needs the spill's journal queue, so it is never a second writer
// beside a handle that is still open.

part of 'retained_audio_spill.dart';

extension RetainedAudioOwedAfterStop on RetainedAudioSpill {
  /// Card RC7 — [recordingId] owes its tail from [prefixBytes] (the settled
  /// prefix, RC-P). The ONE writer of an owed tail, for both of its callers:
  /// RC-P at the stop, while the journal is still open
  /// (`ptt_capture_pump.dart` `_accountOwedTail`), and RC4-S5 after it, when the
  /// relay says a stretch reached no engine (`ptt_unheard_tail.dart`).
  ///
  /// Takes the recording away from the live settle at once ([owesTail], read
  /// synchronously by `live_settle.dart`). On the journal it writes the tail as
  /// [owedTailPieces] — around every stretch already listed, never merged into
  /// one (Codex rc6 ②) — and remembers them for [settleTailPieces]. After the
  /// stop ([afterStop]) it also clears the live-settle stamp, which would hold
  /// the recovery this tail waits for, and hands the one sweep its ticket
  /// ([owedTailReady]); an open journal's close raises that ticket itself
  /// (retained_audio_live_settle.dart). A recording already deleted is left
  /// deleted (owner ruling O-5).
  ///
  /// ⚠️ 更正（RC7，2026-09-25）：原为 `oweTailAfterStop`, writing
  /// `setOwedRange(prefixBytes, null)` — one range, merged with any overlapping
  /// stretch — and RC-P's `noteOwedTail(prefixBytes)`, the same.
  Future<void> oweTail(String recordingId, int prefixBytes,
      {bool afterStop = false}) {
    if (!_retainFromFirstFrame) return Future<void>.value();
    _owedTailRecordingId = recordingId;
    return _onJournalOf(recordingId, (RetainedAudioJournal j, bool open) {
      final List<OwedRange> pieces = owedTailPieces(
          j.manifest.owedRanges, prefixBytes, j.manifest.format.bytesPerFrame);
      for (final OwedRange p in pieces) {
        j.setOwedRange(p.start, p.end);
      }
      _tailPieces[recordingId] = pieces;
      if (afterStop) j.clearLiveSettlePending();
      if (!open) owedTailReady.value = recordingId;
    });
  }

  /// Card RC7 (Codex rc6 ①) — the relay's closing rung heard [recordingId]'s
  /// tail. IN MEMORY ONLY: the recording may be settled live again when its
  /// final lands (the live settle deletes nothing before that final's row is
  /// read back from disk), unless a bounded stretch of it is owed too. The
  /// manifest keeps owing the tail until [settleTailPieces] runs on a persisted
  /// draft; an app killed or a link lost before then recovers it after all.
  void noteTailHeardByClosingLeg(String recordingId) {
    if (_owedTailRecordingId == recordingId && !_owedStretchNoted) {
      _owedTailRecordingId = null;
    }
  }

  /// The journal of [recordingId]: the open one through its own handle, or the
  /// manifest on disk reopened and closed again. Nothing when it is gone.
  Future<void> _onJournalOf(String recordingId,
      void Function(RetainedAudioJournal j, bool open) write) {
    return _enqueueJournal(() async {
      final RetainedAudioJournal? open = _journal;
      if (open != null && _recordingId == recordingId) {
        write(open, true);
        await open.commit();
        return;
      }
      final String dir = _journalDirPath;
      final String sep = dir.endsWith('/') || dir.endsWith(r'\') ? '' : '/';
      // Gone, or settled and its audio released (the live settle got there
      // first): reopening would recreate the audio file, so nothing is written.
      if (!await _journalFs.exists(
              '$dir$sep$recordingId${RetainedAudioJournal.manifestSuffix}') ||
          !await _journalFs.exists(
              '$dir$sep$recordingId${RetainedAudioJournal.pcmSuffix}')) {
        return;
      }
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: dir,
        recordingId: recordingId,
        fs: _journalFs,
        commitInterval: const Duration(days: 1),
        deleted: deletedRecordings,
      );
      try {
        write(j, false);
        await j.commit();
      } finally {
        await j.close();
      }
    });
  }
}
