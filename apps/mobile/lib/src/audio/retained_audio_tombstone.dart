// Card LS-4 (owner ruling O-5, 2026-09-06) — THE CANCEL TOMBSTONE for the
// LEGACY storage face, a `part` of retained_audio_store.dart. Same shape
// retained_audio_policy.dart established next door: the mother class keeps
// one-line delegates, the bodies and the reasoning live here.
//
// WHAT THE RULING SAYS, IN ONE LINE: 「取消后已落盘音频保留但永不自动转」 — audio
// that reached the disk before the user swiped it away is KEPT, and is NEVER
// fed back to the engine on its own.
//
// 🔴 THIS CLOSES A LIVE DEFECT, NOT A FUTURE RISK (§A12 P1-5). Today, with the
// journal face OFF, a continuous recording whose uplink died spills real
// segment files under the article's session key. `BackfillRunner` picks its
// work up from `RetainedAudioStore.pendingSessions()`, which lists every
// session with bytes on disk — a swipe-up cancel does not remove those bytes
// and did not mark them, so on the NEXT recovery edge the cancelled words were
// transcribed and minted into a row. The user threw a sentence away and got it
// back hours later.
//
// WHY A FILE AND NOT A FIELD: the legacy face has nowhere to put a field. It is
// a directory of `<session>__seg-N.pcm` blobs with no manifest — that absence
// is exactly what makes the LS-3 sweep unable to reach it. A sibling marker is
// the only per-session state this layout can hold, and it survives a process
// death for free, which is what "persistent" in the ruling means.
//
// 🔴 THE MARKER IS DELIBERATELY INVISIBLE TO EVERY EXISTING PARSER, and this
// is checkable rather than asserted:
//   · `_indexOf` splits on `__`, then requires the remainder to start `seg-`
//     and end `.pcm`. The remainder here is `cancelled.tomb` ⇒ null ⇒ the file
//     is NOT in `_segmentFiles()`, so it is not counted, not read, not swept,
//     not dropped by `dropAll`.
//   · `_sessionOf` is only ever handed files from `_segmentFiles()`, so it
//     never sees this one (it would parse it correctly if it did).
//   · `_manifestFiles()` requires `.manifest.json` ⇒ ignored.
//   · `RetainedAudioJournalScan.scan` collects ids from `.pcm` /
//     `.manifest.json` suffixes only ⇒ ignored. The suffix is `.tomb` for that
//     reason and must not be changed to `.pcm`-anything.
// `retained_audio_cancel_tombstone_test.dart` pins all four.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (§Chose 4: O-5)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A4 (取消的语义), §A10 card LS-4, §A12 P1-5

part of 'retained_audio_store.dart';

/// Marker suffix. Follows the session separator, so a marker file is
/// `<session>__cancelled.tomb`. See the header for the four parsers this is
/// shaped to slip past.
const String _tombstoneSuffix = 'cancelled.tomb';

/// Write the tombstone for [session] (default: the current write cursor).
///
/// 🔴 IT DELETES NOTHING AND IT REFUSES NOTHING. The bytes stay exactly where
/// they are and still count against the unrecovered cap, because the ruling
/// keeps them; all that changes is that the recovery reader stops listing them.
///
/// ⚠️ Idempotent, and a failure is swallowed to a diag line. This runs on the
/// swipe-up cancel path, which is a teardown: the same P1-1 rule that keeps a
/// write failure from holding the microphone open applies to a marker write.
/// The failure direction is that a cancelled recording could still be fed back
/// — which is the defect this card closes, so it is written down here rather
/// than left to be rediscovered: **an unwritable app-support directory
/// re-opens P1-5 for that one recording.**
Future<void> _writeTombstone(RetainedAudioStore store, String? session) async {
  final String key = RetainedAudioStore._sanitise(session ?? store._session);
  if (key.isEmpty) return;
  final File f = store._tombstoneFileFor(key);
  try {
    if (!await store._dir.exists()) await store._dir.create(recursive: true);
    // Content is a courtesy for a human reading the directory; nothing parses
    // it. The FILE'S EXISTENCE is the whole state — a reader that had to parse
    // the body would have a second way to be wrong.
    await f.writeAsString(
      'cancelled_at_ms=${store._clock()}\n',
      flush: true,
    );
  } on Object catch (e) {
    diag('audio.retained.tombstone_failed', <String, Object?>{
      'session': key,
      'error': '$e',
    });
    return;
  }
  // 🔴 A DIAG LINE, NOT A `RetainedAudioNotice`. Announcing on the store's
  // notice channel would have put this on the user's screen: every code that
  // reaches `lastNotice` is rendered by the banner queue through
  // `RecordingStrings.retainedAudioNoticeMessage`, whose default arm RETURNS
  // THE CODE ITSELF (recording_retention_strings.dart:85-86). A new code with
  // no sentence would therefore show `retained-audio-cancelled` to the user,
  // which owner's 2026-08-22 rule bans outright — and this card ships no new
  // user-visible copy. Nothing needs saying to the user here anyway: they just
  // cancelled; the product agreeing with them is not news.
  diag('audio.retained.tombstoned', <String, Object?>{'session': key});
}

/// Every session key that carries a tombstone. Read from disk on each call:
/// the writer may be a previous run of the app, and a cache would answer for
/// the run it was built in.
Future<Set<String>> _readTombstones(RetainedAudioStore store) async {
  final Set<String> out = <String>{};
  if (!await store._dir.exists()) return out;
  try {
    await for (final FileSystemEntity e
        in store._dir.list(followLinks: false)) {
      if (e is! File) continue;
      final String name = e.uri.pathSegments.last;
      final int i = name.indexOf(RetainedAudioStore._sessionSep);
      if (i <= 0) continue;
      if (name.substring(i + RetainedAudioStore._sessionSep.length) !=
          _tombstoneSuffix) {
        continue;
      }
      out.add(name.substring(0, i));
    }
  } on FileSystemException {
    // Same reasoning as `_segmentFiles`: the directory went away under the
    // listing. 🔴 But the SAFE answer is the opposite one here — "no
    // tombstones" means "feed everything back", so this failure re-opens
    // P1-5 rather than closing it. It is reported, and it is bounded by the
    // fact that the same exception makes `_segmentFiles` empty too, so there
    // is nothing to feed back either.
    diag('audio.retained.tombstone_list_failed', const <String, Object?>{});
    return out;
  }
  return out;
}
