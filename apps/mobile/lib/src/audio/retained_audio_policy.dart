// 700-line cap — the RETENTION POLICY FAMILY, a `part` of
// retained_audio_store.dart. Same shape `timeline_store_batch_delete.dart`
// and its siblings established: the mother class keeps one-line delegates and
// the bodies live here.
//
// WHY THIS IS THE RIGHT CUT: retained_audio_store.dart answers 「what audio is
// on disk right now and how do I read/write/settle one segment」. This file
// answers a narrower, later question about the SAME bytes — 「when does
// retained audio stop being retained even though nobody claimed it」.
//
// 🔴 CARD LS-3 (owner ruling O-2, 2026-09-06) REWROTE THAT ANSWER, AND THE
// SHORT VERSION IS: ALMOST NEVER.
//
//   · [_sweep] may only take a recording whose manifest says `settled`, i.e.
//     one that passed the §A5-3 clearing gate — plus, since card LK-1
//     (2026-09-07), one marked `transcribed_unverified`: transcribed normally,
//     row read back, and unprovable only because the server issues no coverage
//     receipts. The reasoning is at the condition itself. Legacy
//     `<session>__seg-N.pcm`
//     files have no manifest, so they are unrecovered BY DEFINITION and the
//     sweep no longer touches them at all (audit item E13).
//   · `_makeRoomFor` — cap-driven eviction of the oldest file in the
//     directory — IS GONE FROM THIS FILE. It is not disabled, not flagged, not
//     kept "in case": a deletion path that still compiles is one somebody
//     calls. The cap is now balanced by refusing new bytes and announcing
//     (audit item E12, §A5-2).
//   · [_dropAllFiles] survives untouched. It is not a policy, it is a caller
//     saying "I know none of this can ever be claimed again", and it has no
//     production caller today.
//
// 🔴 WHAT THIS COSTS, WRITTEN DOWN RATHER THAN DISCOVERED LATER: the 24-hour
// backstop is retired for every file the old sweep actually reached. Orphan
// audio from a run that was killed mid-outage now sits until something
// recovers it or the user clears app data. What bounds it instead is
// [RetainedAudioStore.kUnrecoveredCapBytes] — a bound by SIZE, which refuses
// out loud, instead of a bound by AGE, which deleted quietly. The ruling made
// that trade deliberately; see that constant's doc for the arithmetic.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (§Chose 4: O-2)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A5-1 (failed/partial audio is exempt from TTL and eviction), §A5-2
//     (on reaching the ceiling, stop promising — do not delete), §A5-3 (what
//     `settled` means and who may set it)

part of 'retained_audio_store.dart';

/// TTL sweep over SETTLED recordings only.
///
/// 🔴 THE `settled` FLAG IS THE WHOLE GATE, AND NOTHING SETS IT YET. Card RC-1
/// writes it, after a coverage receipt, a normal final and a result row read
/// back from storage (§A5-3). Until then this function deletes nothing on any
/// phone — which is the direction owner ruling O-2 chose, not a gap.
///
/// ⚠️ It reads manifests and never writes one. A manifest it cannot parse is
/// LEFT ALONE, not quarantined and not deleted: quarantining is the startup
/// scan's job (`RetainedAudioJournalScan`, §A3-8), and doing it from two
/// places is how two places come to disagree about which file is parked.
Future<void> _sweep(RetainedAudioStore store) async {
  final int now = store._clock();
  for (final File m in await store._manifestFiles()) {
    final RecordingManifest parsed;
    try {
      parsed = RecordingManifest.decode(await m.readAsString());
    } on Object {
      continue; // unreadable ⇒ the scan's problem, and nobody's delete
    }
    // 🔴 OWNER RULING O-5 (card LS-4) — a tombstoned recording is never
    // swept, on any timer, at any age. The ruling keeps the bytes; letting the
    // TTL take them would honour the letter of 「never auto-transcribe」 while
    // deleting the thing it was protecting.
    //
    // ⚠️ BEFORE the `settled` gate on purpose, not folded into it. A cancel
    // and a clearing gate are two different authors, and RC-1 owns `settled`:
    // if it ever settles a recording that was cancelled, this line is what
    // still refuses. A single `if (!parsed.settled || parsed.cancelled)` would
    // read the same and mean less — it would be one condition again.
    if (parsed.cancelled) continue;
    // 🔴 TWO CONDITIONS NOW, AND THE SECOND ONE IS CARD LK-1 (2026-09-07).
    // §A5-3's cleared state, OR a recording that transcribed normally against
    // a server which cannot issue coverage receipts at all
    // (`RecoveryQueueState.transcribedUnverified`, spelled next door on
    // [RecordingManifest]).
    //
    // 🔴 IT DOES NOT WEAKEN O-2. That ruling exempts UNRECOVERED audio from
    // the TTL — audio whose words nobody has. These recordings' words are in
    // the timeline and were read back out of persistent storage before this
    // state could be written (`session/live_settle.dart`); what is missing is a
    // PROOF, from a server that has no way to give one. Keeping them forever
    // means a phone that only ever meets today's relay fills to the 512 MiB
    // ceiling and then refuses to keep audio at all — which is the failure O-2
    // was protecting the user from, arrived at from the other side.
    //
    // ⚠️ Everything else still stays: `settled_unverified` (something about
    // THIS recording could not be confirmed), `needs_manual`, `pending`,
    // legacy segments, and anything cancelled.
    final bool transcribedUnverified = parsed.recoveryState ==
        RecordingManifest.recoveryStateTranscribedUnverified;
    if (!parsed.settled && !transcribedUnverified) continue;
    final FileStat st = await m.stat();
    if (now - st.modified.millisecondsSinceEpoch < store._ttl.inMilliseconds) {
      continue;
    }
    final File pcm = File(store._pcmPathFor(parsed.recordingId));
    int len = 0;
    if (await pcm.exists()) {
      len = await pcm.length();
      await pcm.delete();
    }
    await m.delete();
    store._retainedBytes = (store._retainedBytes - len).clamp(0, 1 << 62);
    store._announce(RetainedAudioNotice(
      code: RetainedAudioNotice.codeExpired,
      bytes: len,
    ));
  }
}

/// Drop everything. Used by teardown paths that know no segment can ever be
/// claimed again; still announces, because bytes we said we were holding do
/// not get to vanish quietly.
///
/// ⚠️ Unchanged by LS-3, and it is worth saying why it is allowed to delete
/// what the sweep may not: this is not a policy deciding that some audio has
/// outlived its usefulness. It is a caller asserting that the audio cannot be
/// claimed by anybody, ever. 🔴 It has no production caller (grep `dropAll`:
/// tests only), so nothing in the product reaches it.
Future<void> _dropAllFiles(RetainedAudioStore store) async {
  for (final File f in await store._segmentFiles()) {
    final int len = await f.length();
    final int? idx = store._indexOf(f);
    await f.delete();
    store._announce(RetainedAudioNotice(
      code: RetainedAudioNotice.codeExpired,
      segmentIdx: idx,
      bytes: len,
    ));
  }
  store._retainedBytes = 0;
  store._capAnnounced.clear();
}
