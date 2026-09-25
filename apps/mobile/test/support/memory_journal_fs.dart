// An in-memory [JournalFileSystem] for tests that need a REAL-LENGTH recording.
//
// 🔴 WHY IT EXISTS. Card RC-3's screen test replays the CR-12-E numbers
// (a 6:38 recording, 12.75 MB of PCM). Writing that to the system temp
// directory is the placeholder-file shape this repo already paid for once
// (a C-drive ENOSPC in the middle of a suite); holding it in memory keeps the
// numbers real without putting a file of that size on anybody's disk.
//
// ⚠️ IT MODELS THE SEAM, NOT A PLATFORM. Rename replaces, delete removes, a
// read past the end returns fewer bytes (the contract `readRange` documents).
// Nothing here imitates a platform quirk (Windows sharing violations, POSIX
// unlink-while-open); the suites that are about those have their own fakes.

import 'dart:async';
import 'dart:typed_data';

import 'package:flowmic/src/audio/retained_audio_journal_fs.dart';

class _Blob {
  Uint8List bytes = Uint8List(0);
  int length = 0;

  void append(Uint8List more) {
    final int need = length + more.length;
    if (need > bytes.length) {
      final Uint8List grown =
          Uint8List(need < bytes.length * 2 ? bytes.length * 2 : need);
      grown.setRange(0, length, bytes);
      bytes = grown;
    }
    bytes.setRange(length, need, more);
    length = need;
  }

  Uint8List read(int start, int end) {
    final int s = start.clamp(0, length);
    final int e = end.clamp(s, length);
    return Uint8List.fromList(bytes.sublist(s, e));
  }
}

class _Handle implements JournalFileHandle {
  _Handle(this._blob);
  final _Blob _blob;

  @override
  Future<void> append(Uint8List bytes) async => _blob.append(bytes);

  @override
  Future<void> flush() async {}

  @override
  Future<int> length() async => _blob.length;

  @override
  Future<void> close() async {}
}

/// Codex rc3 ⑥ — [MemoryJournalFs] whose writes can be held: while [gate] is
/// set, every `writeBytes` waits on it ([blocked] says one is waiting).
class GatedMemoryJournalFs extends MemoryJournalFs {
  Completer<void>? gate;
  bool blocked = false;

  @override
  Future<void> writeBytes(String path, Uint8List bytes, {bool flush = true}) async {
    final Completer<void>? g = gate;
    if (g != null) {
      blocked = true;
      await g.future;
      blocked = false;
    }
    return super.writeBytes(path, bytes, flush: flush);
  }
}

class MemoryJournalFs implements JournalFileSystem {
  final Map<String, _Blob> _files = <String, _Blob>{};

  static String _norm(String p) => p.replaceAll(r'\', '/');

  /// Paths currently present, for assertions.
  Iterable<String> get paths => _files.keys;

  @override
  Future<void> ensureDirectory(String path) async {}

  @override
  Future<bool> exists(String path) async => _files.containsKey(_norm(path));

  @override
  Future<int> lengthOf(String path) async {
    final _Blob? b = _files[_norm(path)];
    if (b == null) throw StateError('no such file: $path');
    return b.length;
  }

  @override
  Future<Uint8List> readBytes(String path) async {
    final _Blob? b = _files[_norm(path)];
    if (b == null) throw StateError('no such file: $path');
    return b.read(0, b.length);
  }

  @override
  Future<Uint8List> readRange(String path, int start, int end) async {
    final _Blob? b = _files[_norm(path)];
    if (b == null) return Uint8List(0);
    return b.read(start, end);
  }

  @override
  Future<void> writeBytes(String path, Uint8List bytes,
      {bool flush = true}) async {
    _files[_norm(path)] = _Blob()..append(bytes);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async =>
      _Handle(_files.putIfAbsent(_norm(path), _Blob.new));

  @override
  Future<void> rename(String from, String to) async {
    final _Blob? b = _files.remove(_norm(from));
    if (b == null) throw StateError('no such file: $from');
    _files[_norm(to)] = b;
  }

  @override
  Future<void> deleteFile(String path) async => _files.remove(_norm(path));

  @override
  Future<List<String>> listNames(String dirPath) async {
    final String dir = _norm(dirPath).endsWith('/')
        ? _norm(dirPath)
        : '${_norm(dirPath)}/';
    return <String>[
      for (final String p in _files.keys)
        if (p.startsWith(dir) && !p.substring(dir.length).contains('/'))
          p.substring(dir.length),
    ];
  }
}
