// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5.1 (idempotent,
//     dedupe by id),
//     §5.2 (the per-line result must be explicable — the four outcomes are each
//     counted, and a refusal must be named),
//     §5.3 (this round only accepts a file exported from the same end),
//     §5.4 (unknown fields are preserved as-is)
//
// ── 🔴 THE RED LINE THIS FILE IS ABOUT ──────────────────────────────────────
// §5.2: 「a partial success must be reported as a partial success. **「import
// complete」 must NEVER appear while rows were in fact swallowed.**」
// Every line reaches exactly one counter, and there is no path that drops a line
// without incrementing something. [ImportReport] is the proof obligation: if it
// says 「added 5」 and the file had 7 entry lines, the other two are in
// [ImportReport.skippedExisting] or in [ImportReport.refusedLines] BY NAME.
//
// ── WHY THE FILE IS READ TWICE ──────────────────────────────────────────────
// The whole-file refusals (§5.3 cross-end, §4.1 count mismatch) must fire BEFORE
// a single row is written, or a rejected file has already half-landed. The
// archive is on local scratch disk by then, so pass 1 (validate + count) is a
// cheap sequential read and pass 2 (write) starts from a decided state.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../session/outbox_blob_store.dart';
import '../timeline/timeline_entry.dart';
import 'fpr_archive.dart';
import 'fpr_mobile.dart';
import 'fpr_record.dart';
import 'portable_ports.dart';
import 'unknown_field_vault.dart';

/// Where imported rows land.
///
/// ⚠️ **Deliberately NOT `TimelineStore`.** Window C's boundary froze that class to
/// one read-only addition (「only a read-only traversal entry point may be
/// added」), so the import writes through
/// the SAME `TimelinePersistence` instance the store writes through — which is
/// what keeps the writes ordered (`SqfliteTimelinePersistence` serialises its
/// own chain per instance) — and then asks the store to reload. Stated here
/// rather than left to be discovered: the store's 「single writer of the local
/// table」 claim now has a second writer, and a later window may well want to
/// move this behind a store method.
abstract interface class ImportRowSink {
  /// Every row id already on this phone, in ANY state.
  ///
  /// 🔴 §5.1's judgement is 「is this row already in the database」, not 「have I
  /// imported this file before」.
  /// Deleted-flagged rows count as present: re-adding a row the user removed
  /// would be an import that resurrects deletions.
  Future<Set<String>> existingRowIds();

  Future<void> insert(TimelineEntry entry);

  /// Make the freshly written rows visible to the UI.
  Future<void> refresh();
}

/// §5.2's four outcomes, plus the file-level refusals. Every line lands in
/// exactly one of these.
class ImportReport {
  const ImportReport({
    required this.added,
    required this.skippedExisting,
    required this.missingAttachments,
    required this.refusedLines,
    required this.fileDeclaredAttachments,
    this.fileRefusal,
    this.otherEnd,
    this.cancelled = false,
    this.detail,
  });

  const ImportReport.cancelled()
    : added = 0,
      skippedExisting = 0,
      missingAttachments = 0,
      refusedLines = const <FprLineRefusal, int>{},
      fileDeclaredAttachments = false,
      fileRefusal = null,
      otherEnd = null,
      cancelled = true,
      detail = null;

  const ImportReport.refusedFile(
    FprFileRefusal this.fileRefusal, {
    this.otherEnd,
    this.detail,
  }) : added = 0,
       skippedExisting = 0,
       missingAttachments = 0,
       refusedLines = const <FprLineRefusal, int>{},
       fileDeclaredAttachments = false,
       cancelled = false;

  /// New rows written.
  final int added;

  /// Lines whose id was already here (§5.1 — the idempotency half).
  final int skippedExisting;

  /// Rows that named an `att/…` the archive does not contain.
  ///
  /// 🔴 The row IS imported (§5.2's table). This counter exists so the report
  /// can say 「the picture for N of these is not in this file」 — and the WORDING must distinguish
  /// the expected case (the user exported without pictures) from the broken one;
  /// see `settings_strings.dart` where both sentences live.
  final int missingAttachments;

  /// Refused lines, BY REASON. Never collapsed into one number: §5.2 says
  /// 「the reason must be named; just saying "format error" is not allowed」.
  final Map<FprLineRefusal, int> refusedLines;

  /// The header's `has_attachments`.
  ///
  /// 🔴 This is what lets the report tell §5.2's TWO missing-picture cases
  /// apart, from data rather than from a guess: a file that says it carries no
  /// pictures is EXPECTED to have rows whose pictures are absent; a file that
  /// says it carries them and then does not is a real gap. Two different
  /// sentences, one field.
  final bool fileDeclaredAttachments;

  /// Non-null ⇒ the file was refused whole and NOTHING was written.
  final FprFileRefusal? fileRefusal;

  /// For [FprFileRefusal.crossEnd] — which end the file actually came from, so
  /// the sentence can name it.
  final String? otherEnd;

  final bool cancelled;

  /// Platform words on an unexpected failure. Surfaced, never swallowed.
  final String? detail;

  int get refusedCount =>
      refusedLines.values.fold<int>(0, (int a, int b) => a + b);

  /// The file was read and rows were considered.
  bool get ran => fileRefusal == null && !cancelled;

  /// §5.2 — 「a partial success must be reported as a partial success」.
  bool get partial => ran && refusedCount > 0;
}

class PortableImporter {
  PortableImporter({
    required ImportSourcePort source,
    required ImportRowSink sink,
    required OutboxBlobStore images,
    required UnknownFieldVault vault,
    required String workDir,
  }) : _source = source,
       _sink = sink,
       _images = images,
       _vault = vault,
       _workDir = workDir;

  final ImportSourcePort _source;
  final ImportRowSink _sink;
  final OutboxBlobStore _images;
  final UnknownFieldVault _vault;
  final String _workDir;

  Future<ImportReport> run() async {
    final String? picked = await _source.pickArchive();
    if (picked == null) return const ImportReport.cancelled();
    return runOn(picked);
  }

  /// The whole import against an archive already on disk. Separate from [run]
  /// so every rule below is testable without a file picker.
  Future<ImportReport> runOn(String archivePath) async {
    final Directory scratch = Directory(
      '$_workDir/portable_import_${DateTime.now().microsecondsSinceEpoch}',
    );
    FprArchiveReader? reader;
    try {
      await scratch.create(recursive: true);
      reader = await FprArchiveReader.open(archivePath);
      if (reader == null) {
        return const ImportReport.refusedFile(FprFileRefusal.notAnArchive);
      }
      // 🔴 Book 16 §9b #1 — checked BEFORE anything is extracted: an archive we
      // are not willing to read must not have any of its bytes acted on.
      if (reader.hasCompressedMember) {
        return const ImportReport.refusedFile(FprFileRefusal.compressedMember);
      }
      final String recordsPath = '${scratch.path}/$kFprRecordsName';
      if (!await reader.extractRecords(recordsPath)) {
        return const ImportReport.refusedFile(FprFileRefusal.missingRecords);
      }

      // ── pass 1: header + count, nothing written ─────────────────────────
      final _Preflight pre = await _preflight(recordsPath);
      if (pre.refusal != null) {
        return ImportReport.refusedFile(pre.refusal!, otherEnd: pre.otherEnd);
      }

      // ── pass 2: rows ────────────────────────────────────────────────────
      return await _apply(recordsPath, reader, pre.declaredAttachments);
    } on Object catch (e) {
      return ImportReport.refusedFile(
        FprFileRefusal.notAnArchive,
        detail: '$e',
      );
    } finally {
      await reader?.close();
      try {
        await scratch.delete(recursive: true);
      } on Object {
        // A temp directory we could not remove is not the user's problem.
      }
    }
  }

  Future<_Preflight> _preflight(String recordsPath) async {
    FprHeader? header;
    int entryLines = 0;
    bool first = true;
    await for (final String line in _lines(recordsPath)) {
      if (first) {
        first = false;
        final FprLineRead read = readFprLine(line, allowHeader: true);
        if (read.refusal == FprLineRefusal.unknownFprVersion) {
          return const _Preflight(FprFileRefusal.unknownFprVersion);
        }
        header = read.header;
        if (header == null) {
          return const _Preflight(FprFileRefusal.missingHeader);
        }
        // §5.3 — the admission rule. Checked before anything else about the
        // rows, because a cross-end file is refused whole and the user's next
        // action ("export it to the PC end instead") has nothing to do with its contents.
        if (header.end != kFprEndMobile) {
          return _Preflight(
            FprFileRefusal.crossEnd,
            otherEnd: header.end.isEmpty ? null : header.end,
          );
        }
        continue;
      }
      final FprLineRead read = readFprLine(line, allowHeader: false);
      // A refused line still COUNTS as an entry line for the header's `count`:
      // the exporter wrote one line per row, so a line that will not parse is a
      // corrupted row, not an absent one. Counting it here is what makes
      // `count` disagreement mean 「the row count does not match」 rather than 「some rows are broken」.
      if (read.header == null) entryLines += 1;
    }
    if (header == null) {
      return const _Preflight(FprFileRefusal.missingHeader);
    }
    // §4.1 — 「must equal the actual row count; a mismatch = the export lied」. A negative count means the
    // key was missing entirely, which is the same defect.
    if (header.count != entryLines) {
      return const _Preflight(FprFileRefusal.countMismatch);
    }
    return _Preflight(null, declaredAttachments: header.hasAttachments);
  }

  Future<ImportReport> _apply(
    String recordsPath,
    FprArchiveReader reader,
    bool declaredAttachments,
  ) async {
    final Set<String> known = await _sink.existingRowIds();
    final Map<FprLineRefusal, int> refused = <FprLineRefusal, int>{};
    final Map<String, FprCarriedFields> carried = <String, FprCarriedFields>{};
    int added = 0;
    int skipped = 0;
    int missingAtt = 0;
    bool first = true;

    await for (final String line in _lines(recordsPath)) {
      if (first) {
        first = false;
        continue; // the header, already validated in pass 1
      }
      final FprLineRead read = readFprLine(line, allowHeader: false);
      if (read.refusal != null) {
        refused[read.refusal!] = (refused[read.refusal!] ?? 0) + 1;
        continue;
      }
      final FprEntryRecord r = read.record!;
      if (known.contains(r.id)) {
        skipped += 1;
        continue;
      }
      final TimelineEntry? row = TimelineEntry.fromJson(rowJsonOfFpr(r));
      if (row == null) {
        // `fromJson` only returns null for a missing id/client_id. The id is
        // already checked, so this is a record with no `source_ext.client_id` —
        // a real defect, refused by the nearest name rather than dropped.
        refused[FprLineRefusal.missingId] =
            (refused[FprLineRefusal.missingId] ?? 0) + 1;
        continue;
      }
      await _sink.insert(row);
      known.add(row.id);
      added += 1;

      final FprCarriedFields c = carriedFieldsOf(r);
      if (!c.isEmpty) carried[row.id] = c;

      // §5.2 row 4 — a picture the file does not carry. The ROW is already in.
      final String? att = r.attachment;
      if (att != null && att.isNotEmpty) {
        final Uint8List? bytes = reader.readAttachment(att);
        if (bytes == null) {
          missingAtt += 1;
        } else {
          // The picture is addressed by the row's OWN identity — `clientId`,
          // which is what `OutboxBlobStore.pathFor` probes (row_image_lookup
          // .dart). A picture written under any other key would be invisible to
          // opening the full-size image, i.e. imported and lost at the same time.
          final String? stored = await _images.put(
            requestId: row.clientId,
            bytes: bytes,
            extension: PortableImporter.attachmentExtension(att),
          );
          if (stored == null) missingAtt += 1;
        }
      }
    }

    await _vault.merge(carried);
    if (added > 0) await _sink.refresh();

    return ImportReport(
      added: added,
      skippedExisting: skipped,
      missingAttachments: missingAtt,
      refusedLines: refused,
      fileDeclaredAttachments: declaredAttachments,
    );
  }

  /// The extension off an `att/<hash>.<ext>` name, restricted to what the blob
  /// store can produce.
  static String attachmentExtension(String attachment) {
    final int dot = attachment.lastIndexOf('.');
    if (dot < 0 || dot == attachment.length - 1) return 'bin';
    final String ext = attachment.substring(dot + 1).toLowerCase();
    return kRowImageExtensions.contains(ext) ? ext : 'bin';
  }

  /// Line-by-line, streamed — a 2000-row file is never a single String.
  Stream<String> _lines(String path) => File(path)
      .openRead()
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .where((String l) => l.trim().isNotEmpty);
}

class _Preflight {
  const _Preflight(this.refusal, {this.otherEnd, this.declaredAttachments = false});
  final FprFileRefusal? refusal;
  final String? otherEnd;

  /// The accepted header's `has_attachments`, carried forward so pass 2 does not
  /// have to re-parse the header to word its report.
  final bool declaredAttachments;
}
