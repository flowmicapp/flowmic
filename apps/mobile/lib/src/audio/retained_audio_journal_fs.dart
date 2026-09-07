// Card LS-1 — the filesystem seam the journal writes through.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-3 (commit order), §A11-D D-1 (API capability audit)
//
// 🔴 WHY A SEAM AT ALL, GIVEN retained_audio_store.dart TALKS TO dart:io
// DIRECTLY. Because the property this module has to defend is a property of
// the ORDER of four filesystem calls, and the only way to test an order is to
// be able to kill the process between any two of them. A test that drives the
// real filesystem can assert the happy path and nothing else; the interesting
// states (§A3-8: claim ahead of file, unverified tail) are exactly the ones a
// real filesystem will not produce on demand. [IoJournalFileSystem] is the
// production implementation and is the only thing production constructs.
//
// ⚠️ This seam does NOT make the operations durable and does not claim to. See
// the D-1 note at the top of retained_audio_journal.dart for what `dart:io`
// actually documents about `flush()` and `rename()`.

import 'dart:io';
import 'dart:typed_data';

/// An open append handle on one PCM file.
abstract class JournalFileHandle {
  /// Append [bytes] at the current end of file.
  Future<void> append(Uint8List bytes);

  /// Ask the platform to push buffered data out. See D-1: what this buys is
  /// not established, which is why the header of the journal says so rather
  /// than the word "durable".
  Future<void> flush();

  /// Current length of the file as the platform reports it.
  Future<int> length();

  Future<void> close();
}

/// The four filesystem operations the journal needs, and nothing else.
abstract class JournalFileSystem {
  Future<void> ensureDirectory(String path);

  Future<bool> exists(String path);

  Future<int> lengthOf(String path);

  Future<Uint8List> readBytes(String path);

  /// Card RC-1a - read the half-open byte range `[start, end)` WITHOUT reading
  /// the rest of the file.
  ///
  /// 🔴 IT EXISTS BECAUSE `readBytes` IS THE WRONG TOOL FOR A RECOVERY. A
  /// thirty-minute recording is ~57 MiB of PCM; the recovery leg feeds it back
  /// in bounded blocks precisely so the phone never holds the whole thing, and
  /// a range read implemented as 「read it all, then sublist」 would give that
  /// property away while looking correct.
  ///
  /// Returns fewer bytes than asked for when the file is shorter - the caller
  /// (recovery_journal_leg.dart) treats a short read as the end of what is
  /// there, never as a failure, because the file genuinely can be shorter than
  /// a manifest claims (audit A3-8's claim-ahead case).
  Future<Uint8List> readRange(String path, int start, int end);

  /// Whole-file write used for the manifest TEMP file only. [flush] is passed
  /// through to `dart:io`'s own `flush:` parameter.
  Future<void> writeBytes(String path, Uint8List bytes, {bool flush = true});

  Future<JournalFileHandle> openAppend(String path);

  Future<void> rename(String from, String to);

  /// Only ever called on a temp manifest we ourselves just wrote. 🔴 §A3-8:
  /// nothing in the journal deletes PCM.
  Future<void> deleteFile(String path);

  /// Entry names (basenames) directly inside [dirPath]; empty when absent.
  Future<List<String>> listNames(String dirPath);
}

class _IoHandle implements JournalFileHandle {
  final RandomAccessFile _raf;

  _IoHandle(this._raf);

  @override
  Future<void> append(Uint8List bytes) async {
    await _raf.setPosition(await _raf.length());
    await _raf.writeFrom(bytes);
  }

  @override
  Future<void> flush() => _raf.flush();

  @override
  Future<int> length() => _raf.length();

  @override
  Future<void> close() => _raf.close();
}

/// Production implementation over `dart:io`.
class IoJournalFileSystem implements JournalFileSystem {
  const IoJournalFileSystem();

  @override
  Future<void> ensureDirectory(String path) async {
    final Directory d = Directory(path);
    if (!await d.exists()) await d.create(recursive: true);
  }

  @override
  Future<bool> exists(String path) => File(path).exists();

  @override
  Future<int> lengthOf(String path) => File(path).length();

  @override
  Future<Uint8List> readBytes(String path) => File(path).readAsBytes();

  @override
  Future<Uint8List> readRange(String path, int start, int end) async {
    if (end <= start) return Uint8List(0);
    final RandomAccessFile raf = await File(path).open();
    try {
      await raf.setPosition(start);
      return await raf.read(end - start);
    } finally {
      await raf.close();
    }
  }

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
          {bool flush = true}) async =>
      File(path).writeAsBytes(bytes, flush: flush);

  @override
  Future<JournalFileHandle> openAppend(String path) async =>
      _IoHandle(await File(path).open(mode: FileMode.append));

  @override
  Future<void> rename(String from, String to) async {
    await File(from).rename(to);
  }

  @override
  Future<void> deleteFile(String path) async {
    final File f = File(path);
    if (await f.exists()) await f.delete();
  }

  @override
  Future<List<String>> listNames(String dirPath) async {
    final Directory d = Directory(dirPath);
    if (!await d.exists()) return const <String>[];
    final List<String> out = <String>[];
    await for (final FileSystemEntity e in d.list(followLinks: false)) {
      final String p = e.path;
      final int i = p.lastIndexOf(Platform.pathSeparator);
      out.add(i < 0 ? p : p.substring(i + 1));
    }
    out.sort();
    return out;
  }
}
