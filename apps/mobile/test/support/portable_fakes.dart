// Test doubles for the Window C export/import seams (16 册).
//
// 🔴 These are LEGITIMATE doubles, not the friendly empty defaults 13 册 §7 F1 ②
// bans. Each one states what it did truthfully: [RecordingExportDestination]
// keeps the archive it was handed (so a test can open it), [CancellingExportDestination]
// reports a CANCEL because that is what it did, and neither ever claims a file
// landed when none did. They exist only under test/ and have no production
// construction site.

import 'dart:io';

import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/portable/portable_controller.dart';
import 'package:flowmic/src/portable/portable_export.dart';
import 'package:flowmic/src/portable/portable_import.dart';
import 'package:flowmic/src/portable/portable_ports.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';

/// Rows straight from a list — the inventory under test without a database.
class ListRowSource implements TimelineRowSource {
  ListRowSource(this.rows);
  List<TimelineEntry> rows;

  @override
  Future<List<TimelineEntry>> readAllRows() async =>
      List<TimelineEntry>.from(rows);
}

/// 「the user picked a location」 — the archive is COPIED there, so a test can read back
/// exactly what a real save would have produced.
class RecordingExportDestination implements ExportDestinationPort {
  RecordingExportDestination(this.targetDir);

  final String targetDir;

  /// Where the last export landed, or null when none has.
  String? savedPath;
  String? savedFileName;

  @override
  Future<ExportLanding?> saveAs({
    required String fileName,
    required String sourcePath,
  }) async {
    await Directory(targetDir).create(recursive: true);
    final String dest = '$targetDir/$fileName';
    await File(sourcePath).copy(dest);
    savedPath = dest;
    savedFileName = fileName;
    return ExportLanding(
      displayPath: dest,
      bytes: await File(dest).length(),
    );
  }
}

/// 「the user pressed back」.
class CancellingExportDestination implements ExportDestinationPort {
  @override
  Future<ExportLanding?> saveAs({
    required String fileName,
    required String sourcePath,
  }) async => null;
}

/// A picker that always hands back the same archive (or nothing), and COUNTS
/// how many times it was asked.
///
/// The count is the anti-façade probe for the settings-page button: a tap that
/// never reaches the controller leaves it at zero, and zero is not something a
/// passing assertion can be confused about.
class FixedImportSource implements ImportSourcePort {
  FixedImportSource(this.path);
  String? path;
  int calls = 0;

  @override
  Future<String?> pickArchive() async {
    calls += 1;
    return path;
  }
}

/// A version that is known. Distinct from a version that is NOT known — pass
/// null explicitly to exercise the 「must not invent a version number」 branch.
class FixedAppVersion implements AppVersionPort {
  const FixedAppVersion(this.value);
  final String? value;

  @override
  Future<String?> appVersion() async => value;
}

/// Rows land in a map; ids already present are reported honestly.
class MapImportSink implements ImportRowSink {
  MapImportSink([Map<String, TimelineEntry>? seed])
    : rows = seed ?? <String, TimelineEntry>{};

  final Map<String, TimelineEntry> rows;
  int refreshCount = 0;

  @override
  Future<Set<String>> existingRowIds() async => rows.keys.toSet();

  @override
  Future<void> insert(TimelineEntry entry) async {
    rows[entry.id] = entry;
  }

  @override
  Future<void> refresh() async {
    refreshCount += 1;
  }
}

/// The inventory over an explicit row list + blob store — used when a test needs
/// the SAME store to back both the tally and its own assertion.
AssetInventory newTestInventory({
  required List<TimelineEntry> rows,
  required OutboxBlobStore images,
}) => TimelineAssetInventory(rows: ListRowSource(rows), images: images);

PortableExporter newTestExporter({
  required OutboxBlobStore images,
  AssetInventory? inventory,
  ExportDestinationPort? destination,
  String workDir = '.',
}) => PortableExporter(
  inventory:
      inventory ??
      TimelineAssetInventory(
        rows: ListRowSource(<TimelineEntry>[]),
        images: images,
      ),
  images: images,
  destination: destination ?? CancellingExportDestination(),
  version: const FixedAppVersion('0.0.0-test'),
  vault: InMemoryUnknownFieldVault(),
  workDir: workDir,
  deviceName: 'TestPhone-0000',
);

PortableImporter newTestImporter({
  required OutboxBlobStore images,
  ImportSourcePort? source,
  ImportRowSink? sink,
  String workDir = '.',
}) => PortableImporter(
  source: source ?? FixedImportSource(null),
  sink: sink ?? MapImportSink(),
  images: images,
  vault: InMemoryUnknownFieldVault(),
  workDir: workDir,
);

/// A controller wired entirely to doubles — for widget tests that only need the
/// settings page to build.
PortableController newTestPortableController({
  List<TimelineEntry> rows = const <TimelineEntry>[],
  ExportDestinationPort? destination,
  ImportSourcePort? source,
  String workDir = '.',
}) {
  final OutboxBlobStore images = InMemoryOutboxBlobStore();
  final AssetInventory inventory = TimelineAssetInventory(
    rows: ListRowSource(List<TimelineEntry>.from(rows)),
    images: images,
  );
  return PortableController(
    inventory: inventory,
    exporter: PortableExporter(
      inventory: inventory,
      images: images,
      destination: destination ?? CancellingExportDestination(),
      version: const FixedAppVersion('0.0.0-test'),
      vault: InMemoryUnknownFieldVault(),
      workDir: workDir,
      deviceName: 'TestPhone-0000',
    ),
    importer: PortableImporter(
      source: source ?? FixedImportSource(null),
      sink: MapImportSink(),
      images: images,
      vault: InMemoryUnknownFieldVault(),
      workDir: workDir,
    ),
  );
}
