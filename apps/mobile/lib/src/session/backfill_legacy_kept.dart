// Part of backfill_runner.dart — NR-137 round 2 (MAIN 2026-10-02): a LEGACY
// recording whose only audio left is kept unverified (`.unverified.tomb`,
// retained_audio_unverified.dart) can be re-transcribed by the user.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 corrections
//   _dispatch/2026-10-02-nr137-design.md, round 2 section
//
// 🔴 WHY A NEW NOTE AND NOT A REPLACEMENT. Nothing on this face records which
// rows a segment produced or where (no manifest; the tomb holds the literal
// `settled_unverified`), so the earlier rows cannot be found — and they stay
// exactly as they are. The press makes ONE record-only note marked as a
// re-transcription of this recording (`consolidateIntoRetranscribedNote`).
//
// Everything else is the NR-138 manual press: through the runner's latch
// (`BackfillRunner.retranscribe`, `legacy: true`), the capability gate at the
// send point (`_replayOne`), `user_retranscribe` with a fresh `operation_id`
// per segment (O-4, metered per press), `delivery: none`, and the automatic
// retry record is neither read nor written.

part of 'backfill_runner.dart';

// ⚠️ 更正（NR-137 round 3, independent review B1/B3/B4）:
//   · B1 — this used to replay each kept segment as its own start, each with
//     its own fresh `operation_id`: one press, N metered operations. The
//     relay binds an operation to ONE recording and ONE range
//     (`recovery-operations.repo.ts` `sameBinding`), so one id cannot span
//     segments. Now the kept segments are fed as ONE start — one recording id
//     (`<session>__kept`), the range `[0, all samples)`, one operation.
//   · B3 — the rows folded are the ones THIS replay settled (the segment
//     ledger, `_replayOne`'s `ownedRows`), not every row that appeared in the
//     timeline meanwhile; a delivered row is never folded.
//   · B4 — the fold's removals are awaited and read back; if they do not
//     complete, the press reports `failed` and no byte is released.

/// The recording id one kept-words press names on the wire.
String legacyKeptRecordingId(String sessionKey) => '${sessionKey}__kept';

extension _BackfillLegacyKept on BackfillRunner {
  Future<PendingRetryOutcome> _retranscribeLegacyKept(
      RetainedAudioStore store, String key, String sourceLang) async {
    final Set<int> marked = await store.unverifiedSegments(key);
    final List<int> kept = <int>[
      for (final int idx in await store.pendingSegments(
          session: key, includeUnverified: true))
        if (marked.contains(idx)) idx,
    ];
    final BytesBuilder audio = BytesBuilder(copy: false);
    final List<int> fed = <int>[];
    for (final int idx in kept) {
      final Uint8List? pcm = await store.read(idx, session: key);
      if (pcm == null || pcm.isEmpty) continue;
      audio.add(pcm);
      fed.add(idx);
    }
    if (fed.isEmpty) return PendingRetryOutcome.unavailable;
    await _publish(store, running: true);
    try {
      // Ordinary rows, never filed into a piece: they are folded below.
      _session.articles.endReplay();
      final List<String> owned = <String>[];
      final _LegacyReplayOutcome outcome = await _replayOne(
        pcm: audio.takeBytes(),
        target: null,
        sourceLang: sourceLang,
        sessionKey: key,
        segmentIdx: fed.first,
        kind: RecoveryAttemptKind.userRetranscribe,
        recordingIdOverride: legacyKeptRecordingId(key),
        ownedRows: owned,
      );
      _session.articles.dropStretchStart(key);
      switch (outcome) {
        case _LegacyReplayOutcome.refusedBusy:
          return PendingRetryOutcome.refusedBusy;
        case _LegacyReplayOutcome.refusedNoLink:
          return PendingRetryOutcome.refusedNoLink;
        case _LegacyReplayOutcome.refusedServer:
          return PendingRetryOutcome.refusedServer;
        case _LegacyReplayOutcome.refusedNoAck:
          return PendingRetryOutcome.failed;
        case _LegacyReplayOutcome.retry:
        case _LegacyReplayOutcome.unverified:
          // Not durable: nothing of this answer may stay beside the earlier
          // words, and the segments stay kept.
          // Round 4 (review D1/D2) — resolved from storage, proven gone.
          // Round 10b — the ids are recorded FIRST, so every later release of
          // this session re-proves them gone.
          await store.recordWithdrawnRows(key, owned);
          final List<TimelineEntry>? rows =
              await withdrawalRows(_timeline, owned);
          if (rows != null) await removeRowsDurably(_timeline, rows);
          return PendingRetryOutcome.failed;
        case _LegacyReplayOutcome.done:
          break;
      }
      // 🔴 NO WORDS IS NOT 「NO WORDS」 HERE: the earlier rows exist, so the
      // legacy empty-result disposal does not apply — the segments stay.
      if (owned.isEmpty) return PendingRetryOutcome.done;
      final KeptWordsFold fold = await consolidateIntoRetranscribedNote(
        timeline: _timeline,
        ownedRowIds: owned,
        sourceRecordingId: key,
        clientId: 'rt-l-${_mintId()}',
      );
      if (fold.storageFailed) return PendingRetryOutcome.failed;
      // 🔴 NR-137 round 10 (review r9 B1) — and, LAST, one fresh proof of what
      // the release stands on (the note present, the folded rows gone): a
      // store change since the fold's own proof keeps the segments and says
      // the press failed. The note stays; it is the words.
      // Round 10b — plus every row an earlier press of this session withdrew
      // (unreadable record ⇒ no release). Round 10c — proven with writers
      // running, and the deletes (this session's seal: nothing else decides
      // its bytes) run inside the timeline write gate's bounded hold, so no
      // writer lands between the proof and them, and none waits on a proof.
      final List<String>? earlier = await store.withdrawnRows(key);
      final TimelineReleaseClaim? claim = earlier == null
          ? null
          : fold.claim?.and(TimelineReleaseClaim(gone: earlier));
      if (fold.noteId != null) {
        final TimelineReleaseVerdict verdict = claim == null
            ? TimelineReleaseVerdict.notProven
            : await TimelineWriteGate.timeline.release(
                prove: () => _timeline.releaseAuthorized(claim),
                // The note is on disk and its rows are gone from disk ⇒ the
                // segments' words exist again, proven: their bytes may go
                // (the automatic route's own delete).
                seal: () async {
                  for (final int idx in fed) {
                    await store.settle(idx, session: key);
                  }
                  return true;
                });
        if (verdict != TimelineReleaseVerdict.released) {
          diag('audio.recovery.kept_words_release_unproven', <String, Object?>{
            'session': key,
            'verdict': verdict.name,
          });
          return PendingRetryOutcome.failed;
        }
      }
      return PendingRetryOutcome.done;
    } finally {
      if ((await store.pendingSegments(session: key, includeUnverified: true))
          .isEmpty) {
        await store.clearLegacyRetry(key);
        await store.clearWithdrawnRows(key); // round 10b
      }
      await _publish(store, running: false);
    }
  }

}
