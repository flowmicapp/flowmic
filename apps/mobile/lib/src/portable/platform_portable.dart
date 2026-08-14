// The ONLY file in the export/import chain that touches a platform channel.
// Everything else talks to `portable_ports.dart` and is testable on the host VM.
//
// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7-2 / §7-3
//
// ── WHY `file_picker` AND NOT `share_plus` (the judgement, written down so it
//    is not re-litigated from the 「sharing is simpler」 side) ──────────────────────────
//
// owner's rule has two halves and they point at different APIs:
//   (a) 「must not default to the photo gallery / download directory / cloud
//       backup — anywhere that gets synced automatically」
//   (b) 「the export-succeeded notice must say where the file landed」
//
// `saveFile` opens Android's Storage Access Framework CREATE_DOCUMENT dialog:
// the user picks the directory AND the file name, nothing is defaulted, and the
// call RETURNS THE RESULTING LOCATION. Both halves.
//
// `share_plus` satisfies (a) — a share sheet is a real user choice — and
// STRUCTURALLY CANNOT satisfy (b): ACTION_SEND hands a content URI to another
// app and gets back, at best, the identity of that app. The success line would
// have had to go quiet about the one thing §7-3 requires it to say, and 「export
// succeeded」 with no address is the "reporting something that did not happen as
// having happened" half of red line F2 wearing a
// friendlier hat.
//
// ── 🔴 ZERO TEST COVERAGE, AND THAT IS A KNOWN BOUNDARY (Book 16 §9b #3) ───────
// Nothing in this file is exercised by `flutter test`: it calls native dialogs,
// which a unit test cannot reach. This repo's own law applies at full strength —
// **when a bug lives in the layer a test double replaced, it is invisible to the
// whole test suite** (0.2.35's
// `getUrl` hid from 879 green tests exactly this way). So the tests assert on the
// PORTS, never on these classes, and pretending otherwise with a test that stubs
// the picker would be worse than the gap.
// ⇒ **the first real-device action: export → open that zip in the file manager
// → import it back.**
//
// ⚠️ THE COST, STATED RATHER THAN HIDDEN: on Android `saveFile` takes the bytes
// (`Uint8List bytes` is REQUIRED in the Android platform implementation —
// file_picker_android/lib/src/file_picker_android.dart), so the finished archive
// is read into memory ONCE at hand-off. The archive is BUILT streaming (see
// `fpr_archive.dart`); this last step is not, and cannot be with this API. It is
// bounded by the number the user was shown next to the 「include pictures」 checkbox
// before they pressed export, which is why that number has to be real (§8-2).

import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'portable_ports.dart';

/// SAF CREATE_DOCUMENT. See the file header for why this API and not a share
/// sheet.
class SafExportDestination implements ExportDestinationPort {
  const SafExportDestination();

  @override
  Future<ExportLanding?> saveAs({
    required String fileName,
    required String sourcePath,
  }) async {
    final File src = File(sourcePath);
    final Uint8List bytes = await src.readAsBytes();
    final String? landed = await FilePicker.saveFile(
      fileName: fileName,
      bytes: bytes,
      // A zip, not an image or a document — `any` keeps the dialog from
      // filtering the user's own folders out of view.
      type: FileType.any,
    );
    // null ⇒ the user backed out. A cancel is NOT an error and must not be
    // reported as one (red line: must not report something that did not happen
    // as having happened — and equally, must not report the user's own
    // deliberate cancellation as a failure).
    if (landed == null) return null;
    return ExportLanding(displayPath: landed, bytes: bytes.length);
  }
}

/// SAF OPEN_DOCUMENT, narrowed to the container we write.
class SafImportSource implements ImportSourcePort {
  const SafImportSource();

  @override
  Future<String?> pickArchive() async {
    final FilePickerResult? picked = await FilePicker.pickFiles(
      type: FileType.any,
      // The plugin copies the picked document into app cache and gives us a
      // real path; without this a `content://` URI would come back and
      // `dart:io` cannot open one.
      withData: false,
    );
    final List<PlatformFile> files = picked?.files ?? const <PlatformFile>[];
    final String? path = files.length == 1 ? files.single.path : null;
    if (path == null || path.isEmpty) return null;
    return path;
  }
}

/// Reads the INSTALLED package's version — which Flutter derives from
/// pubspec's `version:` — so there is no second number to keep in step.
class PackageAppVersion implements AppVersionPort {
  const PackageAppVersion();

  @override
  Future<String?> appVersion() async {
    try {
      final PackageInfo info = await PackageInfo.fromPlatform();
      final String v = info.version.trim();
      return v.isEmpty ? null : v;
    } on Object {
      // 「unknown」 — the header writes null. Never a stand-in string; see
      // AppVersionPort.appVersion.
      return null;
    }
  }
}
