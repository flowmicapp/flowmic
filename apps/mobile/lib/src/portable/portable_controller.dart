// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §8-2 (the estimated size
//     shows live beside the checkbox; 🔴 that number must be genuinely
//     computed)
//
// The UI-facing state for export / import. Holds no format knowledge and no
// platform knowledge — it holds the TALLY (from the inventory) and the busy
// flag, and delegates everything else.
//
// 🔴 [tally] is why this class exists rather than the sheet calling the exporter
// directly: the number beside 「包含图片」("include images") has to be on
// screen BEFORE the user decides, and it has to be the inventory's measured
// byte count. A sheet that computed its own number would be the second
// traversal the overview design §1 forbids.

import 'package:flutter/foundation.dart';

import 'asset_inventory.dart';
import 'portable_export.dart';
import 'portable_import.dart';

class PortableController extends ChangeNotifier {
  PortableController({
    required AssetInventory inventory,
    required PortableExporter exporter,
    required PortableImporter importer,
  }) : _inventory = inventory,
       _exporter = exporter,
       _importer = importer;

  final AssetInventory _inventory;
  final PortableExporter _exporter;
  final PortableImporter _importer;

  /// The measured state of this phone's assets, or null while it has never been
  /// read. **Null is 「还没数过」("not counted yet"), not 「零」("zero")** — the
  /// sheet renders a spinner for null and never a 0 it did not measure.
  AssetTally? get tally => _tally;
  AssetTally? _tally;

  bool get loadingTally => _loadingTally;
  bool _loadingTally = false;

  /// owner 2026-08-01 ruling 5: 「每次导出时让用户选，默认包含」("let the user
  /// choose every time they export, defaulting to included").
  bool get includeImages => _includeImages;
  bool _includeImages = true;

  set includeImages(bool v) {
    if (_includeImages == v) return;
    _includeImages = v;
    notifyListeners();
  }

  /// An export or an import is in flight. One flag for both: they use the same
  /// scratch area and the same store, and letting them overlap would make the
  /// report of one describe rows written by the other.
  bool get busy => _busy;
  bool _busy = false;

  Future<void> loadTally() async {
    if (_loadingTally) return;
    _loadingTally = true;
    notifyListeners();
    try {
      _tally = await _inventory.tally();
    } finally {
      _loadingTally = false;
      notifyListeners();
    }
  }

  Future<ExportOutcome> export({required FprReadmeBuilder readme}) async {
    if (_busy) {
      return const ExportOutcome.failed(ExportFailure.buildFailed);
    }
    _busy = true;
    notifyListeners();
    try {
      return await _exporter.run(
        includeAttachments: _includeImages,
        readme: readme,
      );
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<ImportReport> import() async {
    if (_busy) return const ImportReport.cancelled();
    _busy = true;
    notifyListeners();
    try {
      return await _importer.run();
    } finally {
      _busy = false;
      // An import adds rows, so the tally the sheet is showing is now stale.
      // Re-measured rather than adjusted by arithmetic: 「我以为加了 N 条」
      // ("I think N rows were added") and 「库里现在有多少」("how many are in
      // the store right now") are two questions, and only one of them has a
      // source.
      _tally = null;
      notifyListeners();
    }
  }
}
