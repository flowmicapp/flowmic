// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (container: records.jsonl +
//     README.txt + att/; content-hashed filenames; ⛔ no absolute paths, no `..`),
//     §8-1 (streaming write: must not assemble the whole records.jsonl in memory
//     before flushing to disk)
//
// The `.zip` container — the only file that knows the archive is a zip.
//
// ── STREAMING, AND WHERE IT STOPS ───────────────────────────────────────────
// [FprArchiveWriter] wraps `ZipFileEncoder`, which writes THROUGH an
// `OutputFileStream` and pulls each member from an `InputFileStream`. So a
// 2000-row export never holds more than one buffer's worth of `records.jsonl`
// and never holds a picture: the exporter writes the jsonl to a scratch file one
// line at a time, then hands the FILE over. (Where streaming stops is the SAF
// hand-off — stated in `platform_portable.dart`, not hidden.)
//
// ── 🔴 STORE ONLY, BOTH DIRECTIONS (Book 16 §9b #1) ─────────────────────────
// Every member is written with compression method 0, and a member that arrives
// compressed is REFUSED BY NAME rather than inflated. The two halves are one
// ruling: the desktop end carries a ~330-line hand-written STORE implementation
// and cannot inflate at all, so an `archive`-powered phone that quietly accepted
// deflate would make 「这份文件能不能导入」("can this file be imported") depend
// on which end you ask — the exact 「一份 schema 三个消费者」("one schema,
// three consumers") failure this contract exists to prevent.
//
// The cost is real and is owner-visible: unzip the archive, re-zip it with any
// ordinary tool, and the import refuses it by name. That is acceptable because
// `records.jsonl` is bounded by the timeline itself and the attachments are
// ALREADY-compressed JPEG/PNG/WebP — deflate buys almost nothing here. Adding
// inflate later is a NEW FEATURE, not a bug fix.
//
// ── 🔴 PATH TRAVERSAL (§3) ──────────────────────────────────────────────────
// A zip is attacker-supplied input the moment a user can pick one off their
// phone. Member names are validated on the way IN by [isSafeArchiveName] — the
// same allow-list shape as the desktop's `safe_stem` (Book 15 §6.5 human-review
// record) — and nothing is ever written to a path derived from a name in the
// archive:
// [readAttachment] returns BYTES, and the only file this reader creates is the
// scratch copy of `records.jsonl` at a path the CALLER chose.

import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive_io.dart';

import 'fpr_record.dart';

/// Characters a member name may contain, per component. Deliberately narrower
/// than 「valid on this filesystem」: we mint every name we write, so anything
/// outside this set arrived from somewhere else.
final RegExp _kSafeComponent = RegExp(r'^[A-Za-z0-9_.-]+$');

/// §3 — a member name we are willing to look at.
///
/// Rejects: absolute paths (`/x`, `C:\x`), any `..` component, backslashes,
/// empty components, and anything nested deeper than `att/<file>`.
bool isSafeArchiveName(String name) {
  if (name.isEmpty) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (name.contains('\\')) return false;
  // `C:` / `\\server` — a Windows-absolute name that has no leading slash.
  if (name.length >= 2 && name[1] == ':') return false;
  final List<String> parts = name.split('/');
  if (parts.length > 2) return false;
  for (final String p in parts) {
    if (p.isEmpty) return false;
    if (p == '.' || p == '..') return false;
    if (!_kSafeComponent.hasMatch(p)) return false;
  }
  if (parts.length == 2 && parts[0] != kFprAttachmentDir) return false;
  return true;
}

/// Builds the container. One instance per export.
class FprArchiveWriter {
  FprArchiveWriter(this.zipPath);

  final String zipPath;
  final ZipFileEncoder _encoder = ZipFileEncoder();
  bool _open = false;

  void open() {
    _encoder.create(zipPath, level: ZipFileEncoder.store);
    _open = true;
  }

  /// 🔴 Book 16 §9b #1 — the ONE place a member is handed to the encoder, and the
  /// one place `compression` is set.
  ///
  /// ⚠️ `ZipFileEncoder.create(level: store)` is NOT enough, and this is the
  /// trap: `ZipEncoder.add` decides per entry with
  /// `entry.compression ?? CompressionType.deflate`, and `addFile(File, name)`
  /// builds an entry that leaves it null — so the encoder-wide level is ignored
  /// and every member comes out deflated. Measured, not assumed: the first
  /// version of this file passed `level: store` and the acceptance test read
  /// `CompressionType.deflate` straight back off the produced archive.
  void _addStored(ArchiveFile f) {
    f.compression = CompressionType.none;
    _encoder.addArchiveFile(f);
  }

  /// Adds an already-written `records.jsonl` from [path]. Streamed by the
  /// encoder — the bytes never pass through this process's heap as one string.
  Future<void> addRecords(String path) => _addFileStored(path, kFprRecordsName);

  /// §3 — `README.txt` is not decoration. Small and generated, so it is the one
  /// member built from a string.
  void addReadme(String text) =>
      _addStored(ArchiveFile.string(kFprReadmeName, text));

  /// [name] must be a bare file name; it is placed under `att/`.
  Future<void> addAttachment(String name, String sourcePath) {
    assert(isSafeArchiveName('$kFprAttachmentDir/$name'));
    return _addFileStored(sourcePath, '$kFprAttachmentDir/$name');
  }

  Future<void> _addFileStored(String sourcePath, String memberName) async {
    final File file = File(sourcePath);
    final InputFileStream stream = InputFileStream(sourcePath);
    final ArchiveFile f = ArchiveFile.stream(memberName, stream)
      ..lastModTime = (await file.lastModified()).millisecondsSinceEpoch ~/ 1000
      ..mode = (await file.stat()).mode;
    _addStored(f);
    await stream.close();
  }

  Future<void> close() async {
    if (!_open) return;
    _open = false;
    await _encoder.close();
  }
}

/// Reads the container. Null from [open] means 「这不是一个能读的 zip」("this
/// isn't a zip we can read") — the caller turns that into
/// [FprFileRefusal.notAnArchive].
class FprArchiveReader {
  FprArchiveReader._(this._archive, this._input);

  final Archive _archive;
  final InputFileStream _input;

  static Future<FprArchiveReader?> open(String zipPath) async {
    InputFileStream? input;
    try {
      input = InputFileStream(zipPath);
      final Archive archive = ZipDecoder().decodeStream(input);
      return FprArchiveReader._(archive, input);
    } on Object {
      // Deliberately broad, and deliberately NOT rethrown: every way this can
      // fail (not a zip, truncated, unreadable, encrypted) has the same correct
      // response — say 「这个文件读不出来」("this file can't be read") by name
      // and stop. A crash is not a message.
      await input?.close();
      return null;
    }
  }

  /// Copies `records.jsonl` out to [destPath]. False when the archive has none.
  Future<bool> extractRecords(String destPath) async {
    final ArchiveFile? f = _archive.findFile(kFprRecordsName);
    if (f == null || !f.isFile) return false;
    final OutputFileStream out = OutputFileStream(destPath);
    try {
      f.writeContent(out);
    } finally {
      await out.close();
    }
    return true;
  }

  /// The bytes of an `att/…` member, or null when it is absent or its name is
  /// not one we are willing to touch (§3).
  Uint8List? readAttachment(String relativeName) {
    if (!isSafeArchiveName(relativeName)) return null;
    if (!relativeName.startsWith('$kFprAttachmentDir/')) return null;
    final ArchiveFile? f = _archive.findFile(relativeName);
    if (f == null || !f.isFile) return null;
    return f.readBytes();
  }

  /// Every member name in the archive, as stored. Used by the acceptance tests
  /// (§9: 「去掉勾选 ⇒ 无 att/」 "uncheck the box ⇒ no att/") and by nothing in
  /// production.
  List<String> get memberNames =>
      _archive.files.map((ArchiveFile f) => f.name).toList(growable: false);

  /// 🔴 Book 16 §9b #1 — true when ANY member is stored with a compression
  /// method other than 0.
  ///
  /// `archive` could inflate it; we refuse instead, by name, because the desktop
  /// end structurally cannot and 「能不能导入」("whether it can be imported")
  /// must not depend on which end you ask. Read off `ArchiveFile.compression`,
  /// which `ZipDecoder` fills from the
  /// central-directory `compressionMethod` — the file's own claim, not a guess.
  bool get hasCompressedMember => _archive.files.any(
    (ArchiveFile f) =>
        f.isFile && f.compression != null && f.compression != CompressionType.none,
  );

  Future<void> close() async {
    await _archive.clear();
    await _input.close();
  }
}
