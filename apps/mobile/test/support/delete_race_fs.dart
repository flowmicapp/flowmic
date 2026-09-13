// The filesystem doubles the RF-2 delete-race cases are driven through, moved
// out of `pending_recovery_actions_test.dart` for the 1200-line cap when card
// RF-2's fifth door (the manifest republish queue) added its case there.
//
// 🔴 MOVED VERBATIM. Every line below, and every comment in it, is what stood
// in that file; the only edit is the leading underscore on the three class
// names, which had to go because a private name cannot cross a library
// boundary. Nothing was rewritten and no behaviour changed.
//
// WHY THIS IS THE RIGHT CUT: the cases ask what the PRODUCT does when a delete
// lands mid-write. These three classes answer a different question — what a
// phone's filesystem does, which is not what this machine's does — and they are
// the reason any of those cases can run on Windows at all.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal_fs.dart';

/// A filesystem that models POSIX `unlink` on a file that is still open.
///
/// 🔴 IT EXISTS BECAUSE WINDOWS CANNOT REPRODUCE THE RACE. The leg holds an
/// append handle on the PCM while an attempt runs; on Windows the OS refuses
/// to remove an open file, so the user's delete fails cleanly and the bug is
/// unreachable on this machine. On Android and iOS - every device that ships -
/// the unlink succeeds, the handle stays valid, and the closing commit writes
/// the manifest back for audio that is gone. This double is the phone's
/// behaviour, on the seam `RetainedAudioSpill` already exposes.
///
/// A deleted path reads as absent and unreadable from here on; a later WRITE
/// to it brings it back, which is exactly the resurrection under test.
class PosixUnlinkFs implements JournalFileSystem {
  final JournalFileSystem _inner = const IoJournalFileSystem();
  final Set<String> unlinked = <String>{};

  /// ⚠️ SEPARATORS ARE NORMALISED BEFORE ANYTHING IS COMPARED. Production
  /// builds these paths with '/' while `Platform.pathSeparator` is a backslash
  /// here, so a set keyed on the raw string would answer 「never deleted」 to
  /// every question and this double would silently model nothing. (Same shape
  /// as the 8.3-short-name bug in the worktree-location lint: measure your own
  /// ruler first.)
  static String _norm(String p) => p.replaceAll(r'\', '/');

  @override
  Future<void> deleteFile(String path) async {
    unlinked.add(_norm(path));
    try {
      await _inner.deleteFile(path);
    } on Object {
      // Windows refuses while the leg's handle is open. The point of this
      // double is that the CALLER is told the same thing a phone would tell
      // it, so the refusal is swallowed here and nowhere else.
    }
  }

  @override
  Future<bool> exists(String path) async =>
      unlinked.contains(_norm(path)) ? false : _inner.exists(path);

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
      {bool flush = true}) async {
    unlinked.remove(_norm(path));
    await _inner.writeBytes(path, bytes, flush: flush);
  }

  @override
  Future<void> rename(String from, String to) async {
    unlinked.remove(_norm(to));
    unlinked.remove(_norm(from));
    await _inner.rename(from, to);
  }

  @override
  Future<void> ensureDirectory(String path) => _inner.ensureDirectory(path);
  @override
  Future<int> lengthOf(String path) async =>
      unlinked.contains(_norm(path)) ? 0 : _inner.lengthOf(path);
  @override
  Future<List<String>> listNames(String path) async {
    final List<String> names = await _inner.listNames(path);
    return names
        .where((String n) =>
            !unlinked.any((String u) => u.endsWith(_norm(n))))
        .toList(growable: false);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) => _inner.openAppend(path);
  @override
  Future<Uint8List> readBytes(String path) async =>
      unlinked.contains(_norm(path)) ? Uint8List(0) : _inner.readBytes(path);
  @override
  Future<Uint8List> readRange(String path, int start, int end) async =>
      unlinked.contains(_norm(path))
          ? Uint8List(0)
          : _inner.readRange(path, start, end);
}

/// The delete lands INSIDE the window between a check and the write it guards.
///
/// 🔴 THE FIXED DELAY IN THE CASE ABOVE CANNOT REACH THAT WINDOW ON PURPOSE,
/// AND THAT IS WHY IT WENT GREEN WHILE THE DEFECT WAS ALIVE. Every write in
/// the leg is preceded by its own `await _fs.exists(<manifest>)`; what the
/// gate-0 flake hit was a delete arriving AFTER one of those checks passed and
/// BEFORE its write landed. A wall-clock delay can only find that window by
/// luck — it is microseconds wide — so this double opens it on demand: the
/// first time the journal publishes a manifest, [onManifestWrite] runs first.
///
/// ⚠️ It models a real interleaving, it does not invent one. Nothing here
/// changes what the leg does; it only decides WHEN the user's delete happens,
/// which on a phone is decided by the user.
class DeleteAtWriteFs extends PosixUnlinkFs {
  /// Fired once, before the write that would publish a manifest.
  Future<void> Function()? onManifestWrite;

  bool _firing = false;

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
      {bool flush = true}) async {
    final Future<void> Function()? hook = onManifestWrite;
    if (hook != null &&
        !_firing &&
        PosixUnlinkFs._norm(path).endsWith('.manifest.json.tmp')) {
      _firing = true;
      onManifestWrite = null;
      await hook();
      _firing = false;
    }
    return super.writeBytes(path, bytes, flush: flush);
  }
}

/// [DeleteAtWriteFs] plus a full disk, which is what it takes to reach the
/// FIFTH manifest writer: `ManifestRepublishQueue`.
///
/// 🔴 THAT QUEUE CANNOT BE REACHED WITHOUT A FAILED COMMIT, AND THAT IS WHY IT
/// WAS THE LAST DOOR FOUND. Nothing on the ordinary path ever puts an entry in
/// it; a manifest only gets there when its publish threw (drill D-5b: the disk
/// filled mid-press). So this double refuses manifest writes on demand -
/// ENOSPC, the exact failure the queue exists for - and then, once the entry
/// is queued and writes are allowed again, opens the delete window inside the
/// retry the way its parent does.
///
/// ⚠️ IT BLOCKS ONLY THE MANIFEST. The PCM keeps landing, because that is what
/// the device did: the appends had already been taken by the platform, and the
/// file whose creation ENOSPC refused was the few-hundred-byte temp manifest.
class EnospcThenDeleteAtWriteFs extends DeleteAtWriteFs {
  /// While true, every manifest publish throws. The PCM is untouched.
  bool blockManifestWrites = false;

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
      {bool flush = true}) async {
    if (blockManifestWrites &&
        PosixUnlinkFs._norm(path).endsWith('.manifest.json.tmp')) {
      // Asked BEFORE `super`, so a blocked write can never fire the delete
      // hook: the window this case is about is inside the RETRY, not inside
      // the attempt that failed.
      throw const FileSystemException('no space left on device');
    }
    return super.writeBytes(path, bytes, flush: flush);
  }
}
