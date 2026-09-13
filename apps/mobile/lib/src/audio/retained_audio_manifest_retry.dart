// Card FX-1 — THE MANIFEST WE COULD NOT PUBLISH, KEPT UNTIL WE CAN.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-6/7 (a write failure is RECORDED and ANNOUNCED, never silent),
//     §A3-3 (commit order), §A5-2 (space)
//
// ── THE MEASUREMENT THAT PUT THIS FILE HERE ─────────────────────────────────
//
// Device drill D-5b (2026-09-06, dev-pc-a / HA2F8D3H, evidence
// `.local/session-2026-09-06-durability-drill-r2/D-5b/`): a 30.7 s press with
// `/data/user/0` driven to 0 KB at t=4.5 s. The PCM stopped at 122,880 B and
// the manifest on disk read `"committedClaimBytes":115200, "holes":[],
// "interruptReason":"none"` — i.e. it asserted that a recording missing 26.5 s
// of audio was whole.
//
// 🔴 THE FACTS WERE NEVER LOST IN MEMORY. `RetainedAudioJournal.appendPcm`
// records a [JournalHole] and sets `interruptReason: io_error` on the
// in-memory manifest for every failed append; what failed was PUBLISHING it.
// `_commitLocked` writes a temp file and renames it — and on a full disk the
// TEMP FILE IS EXACTLY WHAT CANNOT BE CREATED. Its catch swallowed the error
// with the comment 「a failed commit leaves the PREVIOUS manifest standing,
// which under-claims, and under-claiming is the safe direction」. That
// reasoning is true of `committedClaimBytes` and FALSE of `holes` and
// `interruptReason`: the previous manifest does not under-claim those, it
// DENIES them. A claim that is too small is a conservative coordinate; an
// empty `holes` list is a statement that nothing is missing.
//
// ⇒ Two things had to change and this file is the second of them. The first is
// in the journal (re-arm the commit timer after a failure, so the retry
// happens while the recording is still open). This one covers the case that
// actually occurred on the device: space came back AFTER the press ended, when
// the journal was already closed and its handle released.
//
// 🔴 WHY THE HANDLE DOES NOT MATTER HERE. Publishing a manifest is
// `writeBytes` + `rename` — two whole-file operations on paths, neither of
// which needs the PCM handle. So a closed journal's last manifest is still
// publishable, indefinitely, by anyone holding the same [JournalFileSystem]
// and the same base path. That is all this queue holds.
//
// ⚠️ IT IS NOT A DURABILITY MECHANISM AND MUST NOT BE DESCRIBED AS ONE. It
// lives in memory: if the process dies before space returns, the facts die
// with it and the on-disk manifest stays behind. What survives that is the PCM
// file being SHORTER than the recording the user made, which the boot scan
// already reports as its own condition. The honest claim is: while this
// process is alive, a manifest that could not be written is retried and the
// first successful publish carries the holes.

import 'dart:async';

import 'package:flutter/foundation.dart';

// Card RF-2 - the registry every manifest writer consults. Kept a direct
// import (the journal re-exports it, but the journal imports THIS file, so
// reaching for it that way would close the cycle).
import 'retained_audio_deleted.dart';
import 'retained_audio_journal_fs.dart';
import 'retained_audio_manifest.dart';

/// One manifest whose publish failed, and everything needed to retry it.
@immutable
class PendingManifestPublish {
  final JournalFileSystem fs;

  /// `<dir>/<recordingId>` — the same base the journal computes. Held rather
  /// than recomputed so this queue never has to know the directory-separator
  /// rule twice.
  final String base;

  final RecordingManifest manifest;

  const PendingManifestPublish({
    required this.fs,
    required this.base,
    required this.manifest,
  });

  String get recordingId => manifest.recordingId;

  @override
  String toString() => 'PendingManifestPublish(${manifest.recordingId}, '
      'holes=${manifest.holes.length}, '
      'interrupt=${manifest.interruptReason})';
}

/// Manifests that could not be published, newest last.
///
/// 🔴 AN OBJECT, NOT A GLOBAL. One instance is owned by [RetainedAudioSpill]
/// and handed to every journal it opens, so a test gets its own and no test
/// can leak an entry into the next one. A `static` here would be a second
/// answer to 「which manifests are outstanding」 that nothing could reset.
class ManifestRepublishQueue {
  /// Card RF-2 - the recordings the user threw away, from the spill that owns
  /// both this queue and that registry.
  ///
  /// 🔴 HELD BY THE QUEUE, NOT CARRIED ON THE ENTRY. An entry is a snapshot of
  /// a manifest taken when its publish failed; whether the user has since
  /// deleted that recording is a fact about NOW, asked at the moment of the
  /// write. Copying the answer into the entry would freeze it at the worst
  /// possible instant - the one before the delete.
  final DeletedRecordings? _deleted;

  ManifestRepublishQueue({DeletedRecordings? deleted}) : _deleted = deleted;

  final List<PendingManifestPublish> _q = <PendingManifestPublish>[];

  /// Recording ids still waiting, in retry order.
  List<String> get pendingIds =>
      List<String>.unmodifiable(_q.map((PendingManifestPublish e) => e.recordingId));

  int get length => _q.length;

  /// Remember [entry], replacing any earlier entry for the same recording.
  ///
  /// Replacing rather than appending is deliberate: two failed commits of the
  /// same recording are two snapshots of one truth, and the later one is a
  /// superset (holes only ever accumulate). Keeping both would publish the
  /// older one second and take facts back off the disk.
  void remember(PendingManifestPublish entry) {
    _q.removeWhere(
        (PendingManifestPublish e) => e.recordingId == entry.recordingId);
    _q.add(entry);
  }

  /// Serialises [republish]. Two of the three callers fire it UNAWAITED (the
  /// start and the end of a recording), so two runs could overlap and both
  /// take the same entry off `_q`, write the same `.manifest.json.tmp` and
  /// race each other's `rename` — on Windows the second of those two whole-file
  /// writes fails outright. Chaining also gives a caller that DOES await
  /// (`RetainedAudioSpill.dispose`) a way to await a run it did not start.
  Future<void> _inFlight = Future<void>.value();

  /// Try to publish every outstanding manifest. Returns how many landed.
  ///
  /// 🔴 NEVER THROWS. Its callers are the start and the end of a recording;
  /// a stale manifest must not be able to stop a press.
  ///
  /// Entries that fail again stay queued, in order, for the next call.
  Future<int> republish() {
    final Completer<int> out = Completer<int>();
    _inFlight = _inFlight.then((_) async {
      out.complete(await _republishOnce());
    });
    return out.future;
  }

  Future<int> _republishOnce() async {
    if (_q.isEmpty) return 0;
    final List<PendingManifestPublish> todo =
        List<PendingManifestPublish>.from(_q);
    int landed = 0;
    for (final PendingManifestPublish e in todo) {
      try {
        final bool published = await publishManifest(
          fs: e.fs,
          base: e.base,
          manifest: e.manifest,
          deleted: _deleted,
        );
        // Dropped either way: a publish that was DECLINED (the recording is
        // gone) can never become possible again, so leaving it queued would
        // retry it at both ends of every future recording, forever.
        _q.remove(e);
        if (!published) {
          // 🔴 NOT COUNTED AS LANDED, AND THAT IS NOT BOOKKEEPING PEDANTRY.
          // The return value is what `retained_audio_dispose_drains_test` and
          // the D-5b regression read as 「the facts reached the disk」; saying
          // 1 here would report a manifest carrying holes as published when
          // nothing was written.
          debugPrint('[flowmic.audio] dropped a queued manifest whose '
              'recording is gone: $e');
          continue;
        }
        landed += 1;
        debugPrint('[flowmic.audio] republished a manifest that ENOSPC had '
            'blocked: $e');
      } on Object catch (err) {
        debugPrint('[flowmic.audio] manifest republish still failing for '
            '${e.recordingId}: $err');
      }
    }
    return landed;
  }

  @visibleForTesting
  void clear() => _q.clear();
}

/// Write [manifest] to `<base>.manifest.json` through a flushed temp file and
/// a rename — steps (3) and (4) of the §A3-3 commit order, and nothing else.
///
/// 🔴 IT DOES NOT FLUSH ANY PCM, AND MUST NOT. Steps (1) and (2) belong to the
/// open handle; a caller with no handle (this queue, after the journal closed)
/// has nothing to flush and nothing to re-measure. It publishes the claim it
/// was given, which is the claim the last successful `length()` produced.
///
/// Returns whether a manifest now stands on disk because of this call. `false`
/// is a DECISION, not a failure: the recording is gone, so there is nothing to
/// say about it and nothing for a caller to retry. A real write failure still
/// throws.
///
/// 🔴 CARD RF-2 — THE FIFTH DOOR, AND THE LAST WRITER OF A MANIFEST PATH UNDER
/// `lib/src/audio`. The other two (`RetainedAudioJournal._commitLocked`,
/// `RetainedAudioJournalScan._publishManifest`) carry the registry and the
/// post-write undo; this one carried a lone `fs.exists(<pcm>)`, which is a
/// check-then-write of exactly the shape `retained_audio_deleted.dart` was
/// written to replace. It is also the writer with the WIDEST gap between
/// deciding and writing: its entry can sit in memory across whole recordings
/// (drill D-5b freed its space only after the press ended), and it fires
/// UNAWAITED at both ends of every recording — so a delete pressed while a
/// press is starting or stopping lands squarely inside it.
Future<bool> publishManifest({
  required JournalFileSystem fs,
  required String base,
  required RecordingManifest manifest,
  DeletedRecordings? deleted,
}) async {
  final String recordingId = manifest.recordingId;
  // The recording may have been DELETED while this manifest waited (owner
  // ruling O-5's delete, or the TTL sweep). Publishing then would recreate the
  // manifest of audio that is gone, the scan would list it again and the user's
  // delete would look as if it had silently failed - the same trap
  // `RetainedAudioJournal.abandon()` exists for. No PCM, nothing to say.
  if (deleted?.contains(recordingId) ?? false) return false;
  // ⚠️ THE PCM CHECK STAYS, AND IT IS NOT THE SAME QUESTION. The registry
  // knows about deletes THIS PROCESS performed; the bytes can also be gone
  // because the TTL sweep took them, or because the file was removed while the
  // app was not running. Either answer means the same thing here, and neither
  // one implies the other.
  if (!await fs.exists('$base${RetainedAudioJournalPaths.pcmSuffix}')) {
    return false;
  }
  final String tmp = '$base${RetainedAudioJournalPaths.manifestTempSuffix}';
  await fs.writeBytes(
    tmp,
    Uint8List.fromList(manifest.encode().codeUnits),
    flush: true,
  );
  final String manifestPath = '$base${RetainedAudioJournalPaths.manifestSuffix}';
  await fs.rename(tmp, manifestPath);
  // 🔴 ASKED AGAIN, AFTER THE RENAME, AND THIS HALF IS THE FIX. Both checks
  // above are check-then-write: a delete arriving between either of them and
  // the rename publishes anyway, and this writer's window is milliseconds wide
  // (a temp write and a rename), not microseconds. The only thing a writer can
  // do about a fact that became true underneath it is take back what it wrote.
  //
  // ⚠️ IT REMOVES ONLY THE MANIFEST THIS CALL PUT THERE, and never any PCM:
  // §A3-8, nothing in the journal layer deletes audio. A swallowed failure
  // leaves a few hundred bytes of JSON that the next scan reads as
  // claim-ahead-of-an-absent-file — the same leftover `PendingRecoveryStore
  // ._deleteJournal`'s own PCM-first order accepts.
  if (deleted?.contains(recordingId) ?? false) {
    try {
      await fs.deleteFile(manifestPath);
    } on Object {
      // Swallowed for the same reason the journal swallows its own undo: the
      // audio is exactly where the user put it (gone), and this queue may not
      // fail a recording's start or stop because of a write it performs on the
      // side.
    }
    return false;
  }
  return true;
}

/// The two suffixes [publishManifest] needs, kept here so this file does not
/// import the journal (the journal imports this one).
///
/// ⚠️ `RetainedAudioJournal` re-exports the same three constants and they must
/// stay equal; `retained_audio_manifest_retry_test.dart` asserts the identity
/// rather than trusting two literals to agree.
class RetainedAudioJournalPaths {
  static const String pcmSuffix = '.pcm';
  static const String manifestSuffix = '.manifest.json';
  static const String manifestTempSuffix = '.manifest.json.tmp';
}
