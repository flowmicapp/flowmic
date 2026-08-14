// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (container),
//     §4 (records.jsonl), §7 (the duty to warn about plaintext),
//     §8 (streaming + estimated size + a picture row still exports when
//     「不含图片」 "exclude images" is set)
//
// Export = walk + serialize (the unifying design doc §1). This file is the
// serialize half; the walk half is `asset_inventory.dart` and is NOT
// reimplemented here — that separation is the whole reason the inventory is
// a named layer.
//
// ── 🔴 WHY `count` CANNOT BE PRE-COMPUTED (§4.1: 「必须与实际行数相等；不等 =
//    导出撒谎」 "must equal the actual line count; mismatch = the export
//    lied") ───────────────────────────────────────────────────────────────
// The header is the FIRST line and carries the number of entry lines. Tallying
// first and then walking again would let a row land between the two passes and
// make the header a lie. So the entry lines are written to a scratch file while
// counting, and `records.jsonl` is assembled afterwards as header + scratch.
// The number in the header is therefore the number of lines that exist, by
// construction rather than by agreement.
//
// ── §8-1 STREAMING ──────────────────────────────────────────────────────────
// One row is encoded at a time into an IOSink. Nothing here ever holds the whole
// jsonl as a String, and pictures are added to the zip FROM THEIR ORIGINAL PATH
// (the encoder streams them) — the only time a picture's bytes are in memory is
// the single read that produces its content hash, one picture at a time.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../session/outbox_blob_store.dart';
import 'asset_inventory.dart';
import 'fpr_archive.dart';
import 'fpr_mobile.dart';
import 'fpr_record.dart';
import 'portable_ports.dart';
import 'unknown_field_vault.dart';

/// What the README says. Built by the caller so the file is written in the
/// user's chosen UI language (red line: the UI does not follow the OS
/// locale — the same rule applies to a file the UI produces).
typedef FprReadmeBuilder =
    String Function({
      required DateTime exportedAt,
      required int entryCount,
      required int attachmentCount,
      required bool hasAttachments,

      /// Whatever [AppVersionPort] answered — including null. The README and the
      /// header therefore state the SAME thing, and neither can invent a version
      /// the other does not have.
      required String? appVersion,
    });

/// Why an export did not produce a file. `cancelled` is NOT here: a user
/// backing out of the save dialog is a normal outcome, not a failure, and
/// reporting it as one would be as dishonest as the reverse.
enum ExportFailure {
  /// The timeline has no live rows. Refused up front rather than writing an
  /// archive containing a header and nothing else.
  nothingToExport,

  /// The archive could not be built (scratch disk, encoder).
  buildFailed,

  /// The user picked a destination and the write to it failed.
  saveFailed,
}

class ExportOutcome {
  const ExportOutcome.saved({
    required ExportLanding this.landing,
    required this.entryCount,
    required this.attachmentCount,
  }) : cancelled = false,
       failure = null,
       detail = null;

  const ExportOutcome.cancelled()
    : landing = null,
      cancelled = true,
      failure = null,
      detail = null,
      entryCount = 0,
      attachmentCount = 0;

  const ExportOutcome.failed(ExportFailure this.failure, {this.detail})
    : landing = null,
      cancelled = false,
      entryCount = 0,
      attachmentCount = 0;

  /// Non-null exactly when the file really landed somewhere.
  final ExportLanding? landing;
  final bool cancelled;
  final ExportFailure? failure;

  /// The platform's own words, when there are any. Surfaced, never swallowed.
  final String? detail;

  final int entryCount;
  final int attachmentCount;

  bool get ok => landing != null;
}

class PortableExporter {
  PortableExporter({
    required AssetInventory inventory,
    required OutboxBlobStore images,
    required ExportDestinationPort destination,
    required AppVersionPort version,
    required UnknownFieldVault vault,
    required String workDir,
    required this.deviceName,
  }) : _inventory = inventory,
       _images = images,
       _destination = destination,
       _version = version,
       _vault = vault,
       _workDir = workDir;

  final AssetInventory _inventory;
  final OutboxBlobStore _images;
  final ExportDestinationPort _destination;
  final AppVersionPort _version;
  final UnknownFieldVault _vault;

  /// App-private scratch area (the composition root passes the same databases
  /// path the timeline and the picture blobs already live under, so no new
  /// permission and nothing lands anywhere a backup agent would sync).
  final String _workDir;

  /// `source.device` — null when the platform told us nothing.
  final String? deviceName;

  /// §3 — `flowmic-export-mobile-<YYYYMMDD-HHMMSS>.zip`.
  static String fileNameFor(DateTime at) {
    final DateTime t = at.toLocal();
    String p(int v, [int w = 2]) => v.toString().padLeft(w, '0');
    return 'flowmic-export-$kFprEndMobile-'
        '${p(t.year, 4)}${p(t.month)}${p(t.day)}-'
        '${p(t.hour)}${p(t.minute)}${p(t.second)}.zip';
  }

  /// §3 — content-addressed attachment name: sha256, first 16 hex chars.
  ///
  /// Content-addressed rather than row-addressed so one picture referenced by
  /// two rows is stored once, and so re-exporting the same history produces the
  /// same `att/` regardless of row ids.
  static String attachmentNameFor(Uint8List bytes, String extension) {
    final String hex = sha256.convert(bytes).toString().substring(0, 16);
    return '$hex.$extension';
  }

  /// The extension of a blob path, lower-cased, restricted to the set
  /// `OutboxBlobStore` can actually produce ([kRowImageExtensions]).
  static String extensionOf(String path) {
    final int dot = path.lastIndexOf('.');
    if (dot < 0 || dot == path.length - 1) return 'bin';
    final String ext = path.substring(dot + 1).toLowerCase();
    return kRowImageExtensions.contains(ext) ? ext : 'bin';
  }

  Future<ExportOutcome> run({
    required bool includeAttachments,
    required FprReadmeBuilder readme,
  }) async {
    final DateTime exportedAt = DateTime.now().toUtc();
    final Directory scratch = Directory(
      '$_workDir/portable_export_${exportedAt.millisecondsSinceEpoch}',
    );
    try {
      await scratch.create(recursive: true);
    } on Object catch (e) {
      return ExportOutcome.failed(ExportFailure.buildFailed, detail: '$e');
    }

    final String entriesPath = '${scratch.path}/entries.jsonl';
    final String attDir = '${scratch.path}/$kFprAttachmentDir';
    final String recordsPath = '${scratch.path}/$kFprRecordsName';
    final String zipPath = '${scratch.path}/archive.zip';

    try {
      final Map<String, FprCarriedFields> carried = await _vault.readAll();

      // ── pass: rows → entry lines (+ the attachment table) ────────────────
      // name → the SCRATCH path holding those bytes.
      //
      // ⚠️ Deliberately NOT `TimelineAsset.imagePath`, which is tempting and
      // wrong: `OutboxBlobStore.path` is an OPAQUE handle by contract (the
      // in-memory double answers `mem://…`), and handing it to `File()` would
      // bake in an assumption the interface never made. The bytes are already
      // in hand for the content hash, so parking them costs one write and keeps
      // the port a port.
      final Map<String, String> attachments = <String, String>{};
      int count = 0;
      final IOSink sink = File(entriesPath).openWrite();
      try {
        await for (final TimelineAsset a in _inventory.walk()) {
          String? attachment;
          if (includeAttachments && a.hasImage) {
            final Uint8List? bytes = await _images.read(a.imagePath!);
            if (bytes != null) {
              final String name = attachmentNameFor(
                bytes,
                extensionOf(a.imagePath!),
              );
              // Same picture, two rows ⇒ one member, written once.
              if (!attachments.containsKey(name)) {
                await Directory(attDir).create(recursive: true);
                final String at = '$attDir/$name';
                await File(at).writeAsBytes(bytes, flush: true);
                attachments[name] = at;
              }
              attachment = '$kFprAttachmentDir/$name';
            }
            // bytes == null ⇒ the file vanished between the walk and here. The
            // ROW IS STILL WRITTEN, with `attachment: null` — §8-3's rule
            // ("the row itself exports as usual") applies to a missing file
            // for the same reason it applies to an unticked checkbox.
          }
          sink.writeln(
            jsonEncode(
              fprRecordOfRow(
                a.entry,
                attachment: attachment,
                carried: carried[a.entry.id] ?? FprCarriedFields.none,
              ).toJson(),
            ),
          );
          count += 1;
        }
      } finally {
        await sink.flush();
        await sink.close();
      }

      if (count == 0) {
        return const ExportOutcome.failed(ExportFailure.nothingToExport);
      }

      // ── assemble records.jsonl = header + the scratch lines ──────────────
      final bool hasAttachments = attachments.isNotEmpty;
      final String? appVersion = await _version.appVersion();
      final FprHeader header = FprHeader(
        exportedAt: exportedAt,
        end: kFprEndMobile,
        appVersion: appVersion,
        device: deviceName,
        count: count,
        hasAttachments: hasAttachments,
        // 🔴 §4.1: `truncated_before` is written ONLY when the instant is
        // genuinely known. On this phone it is not: the SQLite store has no
        // time cutoff at all, and the shared_preferences fallback trims by ROW
        // COUNT (100 newest), which cannot be turned into an instant. So the
        // field is omitted — 「不知道就不写这个字段，绝不许写一个猜的时刻」
        // ("if unknown, don't write this field at all — never write a
        // guessed instant").
        scope: const FprScope.all(),
      );
      final IOSink out = File(recordsPath).openWrite();
      try {
        out.writeln(jsonEncode(header.toJson()));
        await out.addStream(File(entriesPath).openRead());
      } finally {
        await out.flush();
        await out.close();
      }

      // ── container ────────────────────────────────────────────────────────
      final FprArchiveWriter writer = FprArchiveWriter(zipPath);
      writer.open();
      try {
        await writer.addRecords(recordsPath);
        writer.addReadme(
          readme(
            exportedAt: exportedAt,
            entryCount: count,
            attachmentCount: attachments.length,
            hasAttachments: hasAttachments,
            appVersion: appVersion,
          ),
        );
        for (final MapEntry<String, String> a in attachments.entries) {
          await writer.addAttachment(a.key, a.value);
        }
      } finally {
        await writer.close();
      }

      // ── hand off to a destination the USER picks (§7-2) ──────────────────
      final ExportLanding? landing = await _destination.saveAs(
        fileName: fileNameFor(exportedAt),
        sourcePath: zipPath,
      );
      if (landing == null) return const ExportOutcome.cancelled();
      return ExportOutcome.saved(
        landing: landing,
        entryCount: count,
        attachmentCount: attachments.length,
      );
    } on Object catch (e) {
      // One catch, two shapes: anything thrown before the hand-off is a build
      // failure, anything from the hand-off is a save failure. They are told
      // apart by whether the zip exists, because that is the only fact that
      // actually distinguishes them.
      final bool built = File(zipPath).existsSync();
      return ExportOutcome.failed(
        built ? ExportFailure.saveFailed : ExportFailure.buildFailed,
        detail: '$e',
      );
    } finally {
      // Scratch is app-private and disposable; a failure to clean it must never
      // turn a successful export into a failed one.
      try {
        await scratch.delete(recursive: true);
      } on Object {
        // Nothing to say to the user about a temp directory.
      }
    }
  }
}
