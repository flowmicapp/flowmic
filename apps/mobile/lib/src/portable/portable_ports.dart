// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7-2 (⛔ must not default to
//     exporting into the photo album / download folder / cloud-backup locations
//     that get auto-synced away — the user must actively pick the destination),
//     §7-3 (the export-succeeded toast must say where the file landed), §4.1
//     (source.version must not be hardcoded)
//
// The platform seams. Every DECISION about export/import lives on the pure side
// of these three interfaces, so the whole feature is unit-provable without a
// device — same posture as `ImagePickerPort` (13 册 §7 F1 ②).
//
// 🔴 THERE ARE NO FRIENDLY DEFAULTS HERE. Each port is a REQUIRED constructor
// argument of `PortableController`; the only implementations that exist are the
// real ones (`platform_portable.dart`) and explicit test doubles. A port that
// quietly answered 「保存成功」 ("save succeeded") without a file is exactly the shape 13 册 §7 F1 ②
// bans, and on this feature it would mean telling a user their history is safe
// when nothing was written.

import 'dart:async';

/// Where the finished archive landed, as a string the user can be SHOWN.
///
/// §7-3: 「导出成功的提示里要带上文件落在哪，否则用户不知道那份副本躺在哪台机器
/// 上」 ("the export-succeeded toast must say where the file landed, otherwise
/// the user has no idea which machine that copy is sitting on"). This is the
/// reason the destination port returns a location at all, and
/// the reason `share_plus` was rejected for the job (a share sheet can name the
/// receiving app, never a path).
class ExportLanding {
  const ExportLanding({required this.displayPath, required this.bytes});

  /// Where it went, in whatever form the platform can state it (an SAF path or
  /// a `content://` URI on Android). Shown verbatim — never re-worded into
  /// something friendlier that would stop being an address.
  final String displayPath;

  /// Size of what was written, so the success line can also say how big.
  final int bytes;
}

/// 「让用户自己挑一个位置保存」 ("let the user pick a location to save it").
abstract interface class ExportDestinationPort {
  /// Hand the finished archive at [sourcePath] to a destination the USER picks.
  ///
  /// Returns null when the user CANCELLED — a first-class, non-error outcome
  /// (the caller says 「已取消」 ("cancelled"), never 「导出失败」 ("export
  /// failed")). Throws when the platform
  /// failed, so the caller can say what went wrong instead of inventing a
  /// cancel.
  Future<ExportLanding?> saveAs({
    required String fileName,
    required String sourcePath,
  });
}

/// 「让用户挑一个 .zip 导进来」 ("let the user pick a .zip to import").
abstract interface class ImportSourcePort {
  /// A local path to the picked archive, or null when the user cancelled.
  Future<String?> pickArchive();
}

/// §4.1 `source.version` — 「从 package.json / pubspec 读，不许硬编码」 ("read it
/// from package.json / pubspec, never hardcode it").
abstract interface class AppVersionPort {
  /// The running build's version, or **null when it genuinely cannot be read**.
  ///
  /// Null, not a placeholder: the header writes `"version": null`, which says
  /// 「这个字段存在且我们没有它」 ("this field exists and we don't have it"). A
  /// stand-in string would be a version number
  /// that outlives the install while pointing at nothing — 13 册 D5 in its
  /// purest form.
  Future<String?> appVersion();
}
