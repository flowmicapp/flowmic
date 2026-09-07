// AppStrings copy-catalogue shard: card F6 (2026-09-02 audit) — the sentences
// that answer 「the store told me it kept my audio, and then it let it go —
// why」.
//
// Split out of `recording_strings.dart` for the file-size cap (E46,
// 2026-08-27 audit: that file was 750 lines, already past the 700-line
// target), the same way `SttStallStrings` was split out of it a card earlier.
// This shard holds copy and its reasoning only; the selector that CHOOSES
// between these sentences ([retainedAudioNoticeMessage]) moved with it,
// because a second place that decides which sentence to show is how two
// places come to disagree.
part of '../app_strings.dart';

mixin RecordingRetentionStrings on AppStringsLeaves {
  // ── F6 (2026-09-02 audit): retained-audio eviction/TTL notices ───────────
  //
  // `RetainedAudioStore` (audio/retained_audio_store.dart) already refuses to
  // drop a segment silently — every eviction and every TTL expiry is
  // announced on its `notices` stream — but until this shard the ONLY
  // listener was the diagnostics log (`retained_audio_boot.dart`). "No
  // silent failure" runs in both directions: a store that told a user their
  // audio was "留存" ("retained") and then discarded it with nothing but a
  // diag line is the exact unbacked-promise shape volume 15 §2.0-b bans, just
  // moved one step later than the original defect these words were coined
  // to fix.
  //
  // ⚠️ NOT ONE BYTE OR HOUR COUNT, on the same principle as
  // [recordingStoppedContinuousCap]: `kDefaultCapBytes` / `kDefaultTtl` are
  // compile-time constants that this store's own header says to expect to
  // move (「IF THE TIER CEILING EVER RISES AGAIN, COME BACK HERE」), and a
  // sentence that quotes today's number becomes nine translations of a wrong
  // fact the day either constant changes.

  // 🔴 `retainedAudioNoticeDroppedOldest` STOOD HERE AND IS GONE (card RC-1,
  // 2026-09-06), with its nine translations. Its code lost its only producer
  // under owner ruling O-2 (card LS-3) and was kept only while the storage
  // face was off by default and the change was rollback-shaped; RC-1 shipped
  // that face, so the string leaves with its producer.

  /// [RetainedAudioNotice.codeCapReached] — the ceiling is reached, so the
  /// recording being written to RIGHT NOW is the one that stopped growing.
  /// Under owner ruling O-2 that is the ONLY thing hitting the ceiling does:
  /// nothing older is ever given up to make room.
  String get retainedAudioNoticeCapReached => _lfRetainedAudioNoticeCapReached;

  /// [RetainedAudioNotice.codeExpired] — the TTL sweep reclaimed a recording.
  ///
  /// 🔴 THE SENTENCE HAD TO CHANGE BECAUSE THE SWEEP DID (card LS-3, owner
  /// ruling O-2). It used to say an UNCLAIMED recording had been deleted, and
  /// that is now the one recording this sweep may never take:
  /// `_sweep` (audio/retained_audio_policy.dart) skips anything whose manifest
  /// does not say `settled`, so what ages out is audio whose words are already
  /// in the timeline. The old wording told the user their unsent words were
  /// gone — the exact fear the new policy exists to remove.
  String get retainedAudioNoticeExpired => _lfRetainedAudioNoticeExpired;

  /// [RetainedAudioNotice.codeWriteFailed] — card LS-2. The disk refused a
  /// stretch of audio that was handed to it. Deliberately NOT the cap
  /// sentence: that one sends the user to free up space, and space is not
  /// what went wrong here.
  ///
  /// 🔴 §A9 P1-1 ④ CONSTRAINS THIS WORDING AND THE CONSTRAINT IS NOT
  /// COSMETIC. "Part of this recording" — never "nothing has been saved
  /// since". The stretch after a failed write may well still be reaching the
  /// disk, and a sentence that writes the rest of the recording off would send
  /// the user to start over when they did not have to.
  String get retainedAudioNoticeWriteFailed =>
      _lfRetainedAudioNoticeWriteFailed;

  /// Selector for [RetainedAudioNotice.code]. Keyed on the store's own named
  /// constants (never re-typed literals) — same discipline as
  /// [recordingAutoStoppedMessage]. The default arm exists only so a future
  /// fourth code added to the store without a matching sentence here fails
  /// visibly (an unrecognised identifier survives to the diag line already
  /// written by the caller) rather than throwing past a `switch` that never
  /// expected to see one; today's three codes are the store's whole
  /// contract and this is a closed set, not open wire data.
  String retainedAudioNoticeMessage(String code) {
    switch (code) {
      case RetainedAudioNotice.codeCapReached:
        return retainedAudioNoticeCapReached;
      case RetainedAudioNotice.codeExpired:
        return retainedAudioNoticeExpired;
      case RetainedAudioNotice.codeWriteFailed:
        return retainedAudioNoticeWriteFailed;
      default:
        return code;
    }
  }
}
