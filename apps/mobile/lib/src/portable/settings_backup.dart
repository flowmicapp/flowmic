// SPEC-REF:
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     (Q6 note 「可导出导入配置,导出存在本地的存储空间,导入也是从本地的存储空间导入」;
//      Q7 b — each phone its own copy, moving phones = export/import;
//      Q8 a — the file carries the synced items AND the phone-local habits)
//   docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md D9
//     (the file shape, key-by-key replacement, no timestamp arbitration,
//      unknown keys preserved, the first-run markers never written, cross-end
//      refusal on `source.end`)
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7-2 / §7-3 (the SAME two
//     rules the record export obeys: the user picks the destination, and the
//     success line says where the file landed) — reused through the SAME ports
//
// The settings backup: one JSON file holding every preference this phone owns.
//
// ── THE FILE ─────────────────────────────────────────────────────────────────
//   {
//     "flowmic_settings": 1,
//     "exported_at": "<ISO-8601 UTC>",
//     "source": {"app": "flowmic", "end": "mobile", "version": "<pubspec>|null,
//                "device": "<label>|null"},
//     "prefs": {"scenario.card": {...}, "stt.polish": {...}, "stt.refine": {...},
//               "scenario.inference": {...}, "spoken_lang": "zh"},
//     "local": {"locale": "en", "theme": "system", "text_scale": "large",
//               "send_policy": "direct", "translate_target": "en",
//               "favorites": [...]}
//   }
// ── `flowmic_settings` STAYS 1 (2026-09-04) ─────────────────────────────────
// `scenario.card` now holds taxonomy IDS in `professions` / `domains` instead
// of display labels. The FIELDS are unchanged (same keys, same list-of-string
// types), so this is additive in the only sense the format number governs:
// nothing a format-1 reader parses stopped parsing. Bumping to 2 would have
// been strictly worse — the reader above refuses a NEWER format outright, so
// every phone still on 0.3.5x would refuse the whole file rather than restore
// the eight keys it does understand, to avoid mis-reading two of them.
//
// `prefs` keys are the WIRE key names for the four phone-owned rows (so a
// reader of this file and a reader of the socket see one vocabulary) plus the
// spoken language, which rides `audio:start` rather than a settings row. A row
// the phone never set is ABSENT, not null — absent round-trips as 「never set」,
// which is a real state (prefs_controller.dart header) and must survive.
//
// ── IMPORT REPLACES KEY BY KEY ───────────────────────────────────────────────
// A single-phone model has no second writer to arbitrate against, so there is
// no `updated_at` and no merge: every key present in the file replaces the key
// on this phone; every key absent from the file leaves this phone's value
// alone. The two are different on purpose — a file exported from a phone that
// never touched refine says nothing about refine, and 「says nothing」 must not
// become 「turn it off」.
//
// ── 🔴 THE TWO THINGS AN IMPORT NEVER WRITES ────────────────────────────────
// `flowmic.pref.locale_prompt` and `flowmic.pref.onboarding_seen` are the
// first-run gates' own bookkeeping (app_settings.dart `_firstRunMarkers`). They
// are not preferences, they are not exported, and an import that wrote them
// would either re-ask a settled question or skip one that was never asked.
// Pinned by settings_backup_test.dart on both sides of the round trip.
//
// ── UNKNOWN KEYS ─────────────────────────────────────────────────────────────
// A newer app may write keys this one does not know. They are kept verbatim
// under one device-local key and written back into the next export, so a file
// that passes through an older phone loses nothing — the same posture as the
// record exporter's UnknownFieldVault, at the scale one small map deserves.
//
// ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────────
// It does not touch the timeline, the outbox, tokens, pairings or the account.
// Those have their own exports (records) or are deliberately not portable
// (credentials). It also does not tell the live controllers anything itself:
// [SettingsBackup.import] writes the store and then calls [onImported], and
// the composition root reloads every controller from the store there — one
// hook, so 「restored on disk」 and 「restored on screen」 cannot come apart.

import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import '../../generated/flowmic_settings.g.dart';
import '../settings/app_settings.dart';
import '../settings/local_prefs.dart';
import '../settings/prefs_controller.dart';
import '../settings/scenario_card.dart';
import '../settings/scenario_card_controller.dart';
import '../ui/tokens.dart' show AppThemeMode;
import 'portable_ports.dart';

/// The `flowmic_settings` format this app writes and the highest it reads.
const int kSettingsBackupFormat = 1;

/// The `source.end` this app writes and the only one it accepts.
const String kSettingsBackupEnd = 'mobile';

/// Where an import that touched nothing is refused, and why.
enum SettingsRestoreRefusal {
  /// Not JSON, or JSON without the `flowmic_settings` header.
  notASettingsFile,

  /// `source.end` names another end (a PC export). Carried with the end name.
  otherEnd,

  /// A `flowmic_settings` number above what this app reads.
  newerFormat,
}

/// The outcome of one export. Same three shapes as the record export, for the
/// same reason: 「cancelled」 must never read as 「failed」.
class SettingsBackupOutcome {
  const SettingsBackupOutcome.saved(ExportLanding this.landing)
      : cancelled = false,
        detail = null;
  const SettingsBackupOutcome.cancelled()
      : landing = null,
        cancelled = true,
        detail = null;
  const SettingsBackupOutcome.failed(String this.detail)
      : landing = null,
        cancelled = false;

  final ExportLanding? landing;
  final bool cancelled;
  final String? detail;
  bool get ok => landing != null;
}

/// The outcome of one import.
class SettingsRestoreOutcome {
  const SettingsRestoreOutcome.restored(this.keysWritten)
      : cancelled = false,
        refusal = null,
        otherEnd = null,
        detail = null;
  const SettingsRestoreOutcome.cancelled()
      : keysWritten = 0,
        cancelled = true,
        refusal = null,
        otherEnd = null,
        detail = null;
  const SettingsRestoreOutcome.refused(SettingsRestoreRefusal this.refusal, {this.otherEnd})
      : keysWritten = 0,
        cancelled = false,
        detail = null;
  const SettingsRestoreOutcome.failed(String this.detail)
      : keysWritten = 0,
        cancelled = false,
        refusal = null,
        otherEnd = null;

  /// How many keys the file replaced on this phone.
  final int keysWritten;
  final bool cancelled;
  final SettingsRestoreRefusal? refusal;

  /// The `source.end` a refused file named, for the sentence.
  final String? otherEnd;
  final String? detail;
  bool get ok => refusal == null && !cancelled && detail == null;
}

/// What the settings page holds: the two verbs and nothing else. [SettingsBackup]
/// is the one production implementation; tests hand the page an explicit
/// double (test/support/settings_fakes.dart) the way the record rows get a
/// PortableController over doubles — the double says what it did (nothing,
/// cancelled) and never claims a file landed.
abstract interface class SettingsBackupPort {
  Future<SettingsBackupOutcome> export();
  Future<SettingsRestoreOutcome> import();
}

class SettingsBackup implements SettingsBackupPort {
  SettingsBackup({
    required SharedPreferences prefs,
    required ExportDestinationPort destination,
    required ImportSourcePort source,
    required AppVersionPort version,
    required String workDir,
    required String? deviceName,
    required Future<void> Function() onImported,
  }) : _prefs = prefs,
       _destination = destination,
       _source = source,
       _version = version,
       _workDir = workDir,
       _deviceName = deviceName,
       _onImported = onImported;

  final SharedPreferences _prefs;
  final ExportDestinationPort _destination;
  final ImportSourcePort _source;
  final AppVersionPort _version;
  final String _workDir;
  final String? _deviceName;
  final Future<void> Function() _onImported;

  /// Device-local key holding the unknown keys of the last imported file.
  static const String unknownKeysKey = 'flowmic.prefs.backup_unknown';

  static const String _spokenLangPrefKey = 'spoken_lang';

  /// `flowmic-settings-YYYYMMDD-HHMMSS.json` — local time, like the record
  /// export's name: the user reads it off their own file manager.
  static String fileNameFor(DateTime at) {
    final DateTime l = at.toLocal();
    String p(int v) => v.toString().padLeft(2, '0');
    return 'flowmic-settings-${l.year}${p(l.month)}${p(l.day)}-${p(l.hour)}${p(l.minute)}${p(l.second)}.json';
  }

  /// The document as it would be exported RIGHT NOW. Exposed so a test can
  /// assert the shape without a file, and so [export] and the round-trip test
  /// read one builder.
  Future<Map<String, Object?>> snapshot({DateTime? exportedAt}) async {
    final DateTime at = (exportedAt ?? DateTime.now()).toUtc();
    final ScenarioCard card = await SharedPrefsScenarioCardCache(_prefs).load();
    final PhonePrefs rows = await SharedPrefsPrefsStore(_prefs).load();
    final Map<String, Object?> prefs = <String, Object?>{
      // ids, not labels (2026-09-04). `migratedToIds` is applied on the way
      // OUT as well as on the way in, because a phone that has not opened the
      // settings screen since upgrading may still hold a pre-id store, and an
      // export must never carry the mixed-language duplicates forward into the
      // next phone. It is a no-op on a card that is already ids.
      if (!card.isEmpty)
        FlowMicSettingsKeys.scenarioCard: card.migratedToIds().toJson(),
      if (rows.polish != null) FlowMicSettingsKeys.sttPolish: rows.polish!.toJson(),
      if (rows.refine != null) FlowMicSettingsKeys.sttRefine: rows.refine!.toJson(),
      if (rows.inference != null)
        FlowMicSettingsKeys.scenarioInference: rows.inference!.toJson(),
      if (_prefs.getString(AppSettingsController.kSpokenLangKey) != null)
        _spokenLangPrefKey: _prefs.getString(AppSettingsController.kSpokenLangKey),
    };
    final Map<String, Object?> local = <String, Object?>{
      if (_prefs.getString(AppSettingsController.kLocaleKey) != null)
        'locale': _prefs.getString(AppSettingsController.kLocaleKey),
      if (_prefs.getString(AppSettingsController.kThemeModeKey) != null)
        'theme': _prefs.getString(AppSettingsController.kThemeModeKey),
      if (_prefs.getString(AppSettingsController.kTextScaleKey) != null)
        'text_scale': _prefs.getString(AppSettingsController.kTextScaleKey),
      if (_prefs.getString(kSendPolicyKey) != null)
        'send_policy': _prefs.getString(kSendPolicyKey),
      if (_prefs.getString(kTranslateTargetKey) != null)
        'translate_target': _prefs.getString(kTranslateTargetKey),
      if (_prefs.getStringList(kFavoritesKey) != null)
        'favorites': _prefs.getStringList(kFavoritesKey),
    };
    // Unknown keys a newer app wrote, carried through verbatim (header).
    final Map<String, Object?> unknown = _readUnknown();
    final Object? unknownPrefs = unknown['prefs'];
    final Object? unknownLocal = unknown['local'];
    if (unknownPrefs is Map) {
      for (final MapEntry<Object?, Object?> e in unknownPrefs.entries) {
        if (e.key is String && !prefs.containsKey(e.key)) prefs[e.key! as String] = e.value;
      }
    }
    if (unknownLocal is Map) {
      for (final MapEntry<Object?, Object?> e in unknownLocal.entries) {
        if (e.key is String && !local.containsKey(e.key)) local[e.key! as String] = e.value;
      }
    }
    return <String, Object?>{
      'flowmic_settings': kSettingsBackupFormat,
      'exported_at': at.toIso8601String(),
      'source': <String, Object?>{
        'app': 'flowmic',
        'end': kSettingsBackupEnd,
        'version': await _version.appVersion(),
        'device': _deviceName,
      },
      'prefs': prefs,
      'local': local,
      for (final MapEntry<String, Object?> e in unknown.entries)
        if (e.key != 'prefs' && e.key != 'local') e.key: e.value,
    };
  }

  /// Write the snapshot to a scratch file and hand it to a destination the USER
  /// picks (§7-2). Never throws.
  @override
  Future<SettingsBackupOutcome> export() async {
    final DateTime at = DateTime.now();
    final String path = '$_workDir/settings_backup_${at.microsecondsSinceEpoch}.json';
    try {
      final Map<String, Object?> doc = await snapshot(exportedAt: at);
      await File(path).writeAsString(
        const JsonEncoder.withIndent('  ').convert(doc),
        flush: true,
      );
      final ExportLanding? landing = await _destination.saveAs(
        fileName: fileNameFor(at),
        sourcePath: path,
      );
      if (landing == null) return const SettingsBackupOutcome.cancelled();
      return SettingsBackupOutcome.saved(landing);
    } on Object catch (e) {
      return SettingsBackupOutcome.failed('$e');
    } finally {
      try {
        final File f = File(path);
        if (f.existsSync()) f.deleteSync();
      } on Object {
        // Scratch is app-private; a leftover must never fail a finished export.
      }
    }
  }

  /// Let the user pick a file and restore it. Never throws.
  @override
  Future<SettingsRestoreOutcome> import() async {
    final String? picked = await _source.pickArchive();
    if (picked == null) return const SettingsRestoreOutcome.cancelled();
    try {
      return await restoreFrom(await File(picked).readAsString());
    } on Object catch (e) {
      return SettingsRestoreOutcome.failed('$e');
    }
  }

  /// The whole restore against a document already in hand. Separate from
  /// [import] so every rule is testable without a file picker.
  Future<SettingsRestoreOutcome> restoreFrom(String text) async {
    Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException {
      return const SettingsRestoreOutcome.refused(SettingsRestoreRefusal.notASettingsFile);
    }
    if (decoded is! Map) {
      return const SettingsRestoreOutcome.refused(SettingsRestoreRefusal.notASettingsFile);
    }
    final Object? format = decoded['flowmic_settings'];
    if (format is! int) {
      return const SettingsRestoreOutcome.refused(SettingsRestoreRefusal.notASettingsFile);
    }
    // 🔴 The end check comes BEFORE the format check: a PC file of a newer
    // format is still, first of all, a PC file, and the sentence the user
    // needs is 「this came from a computer」 rather than 「update the app」.
    final Object? source = decoded['source'];
    final Object? end = source is Map ? source['end'] : null;
    if (end != kSettingsBackupEnd) {
      return SettingsRestoreOutcome.refused(
        SettingsRestoreRefusal.otherEnd,
        otherEnd: end is String ? end : null,
      );
    }
    if (format > kSettingsBackupFormat) {
      return const SettingsRestoreOutcome.refused(SettingsRestoreRefusal.newerFormat);
    }

    int written = 0;
    final Map<String, Object?> unknown = <String, Object?>{};
    final Map<String, Object?> unknownPrefs = <String, Object?>{};
    final Map<String, Object?> unknownLocal = <String, Object?>{};

    final Object? prefs = decoded['prefs'];
    if (prefs is Map) {
      for (final MapEntry<Object?, Object?> e in prefs.entries) {
        final Object? k = e.key;
        if (k is! String) continue;
        if (await _restorePref(k, e.value)) {
          written++;
        } else {
          unknownPrefs[k] = e.value;
        }
      }
    }
    final Object? local = decoded['local'];
    if (local is Map) {
      for (final MapEntry<Object?, Object?> e in local.entries) {
        final Object? k = e.key;
        if (k is! String) continue;
        if (await _restoreLocal(k, e.value)) {
          written++;
        } else {
          unknownLocal[k] = e.value;
        }
      }
    }
    for (final MapEntry<Object?, Object?> e in decoded.entries) {
      final Object? k = e.key;
      if (k is! String) continue;
      if (const <String>{'flowmic_settings', 'exported_at', 'source', 'prefs', 'local'}
          .contains(k)) {
        continue;
      }
      unknown[k] = e.value;
    }
    if (unknownPrefs.isNotEmpty) unknown['prefs'] = unknownPrefs;
    if (unknownLocal.isNotEmpty) unknown['local'] = unknownLocal;
    if (unknown.isEmpty) {
      await _prefs.remove(unknownKeysKey);
    } else {
      await _prefs.setString(unknownKeysKey, jsonEncode(unknown));
    }
    await _onImported();
    return SettingsRestoreOutcome.restored(written);
  }

  /// True when [key] is one this app owns and [value] was written; false hands
  /// the pair to the unknown-key keep. A KNOWN key with a value this app cannot
  /// parse is also refused into the keep rather than half-written: 「polish is
  /// on」 with a strength nobody recognises is not a preference, it is a typo.
  Future<bool> _restorePref(String key, Object? value) async {
    if (key == FlowMicSettingsKeys.scenarioCard) {
      if (value is! Map) return false;
      // A backup file may have been written by a build that stored LABELS
      // (any of the nine locales) or by one that stores ids. Both restore to
      // ids through the one migration; a value no locale and no canonical
      // knows is dropped there rather than becoming a phantom profession.
      await SharedPrefsScenarioCardCache(_prefs)
          .save(ScenarioCard.fromJson(value).migratedToIds());
      return true;
    }
    final SharedPrefsPrefsStore store = SharedPrefsPrefsStore(_prefs);
    if (key == FlowMicSettingsKeys.sttPolish) {
      final PolishPrefs? p = PolishPrefs.tryFromJson(value);
      if (p == null) return false;
      await store.save((await store.load()).copyWith(polish: p));
      return true;
    }
    if (key == FlowMicSettingsKeys.sttRefine) {
      final RefinePrefs? p = RefinePrefs.tryFromJson(value);
      if (p == null) return false;
      await store.save((await store.load()).copyWith(refine: p));
      return true;
    }
    if (key == FlowMicSettingsKeys.scenarioInference) {
      final InferenceConsentPrefs? p = InferenceConsentPrefs.tryFromJson(value);
      if (p == null) return false;
      await store.save((await store.load()).copyWith(inference: p));
      return true;
    }
    if (key == _spokenLangPrefKey) {
      // Same whitelist the picker enforces: a tag the routing table has no
      // row for is not restored (app_settings.dart setSpokenLang says why).
      if (value is! String || !kSpokenLangs.contains(value)) return false;
      await _prefs.setString(AppSettingsController.kSpokenLangKey, value);
      return true;
    }
    return false;
  }

  Future<bool> _restoreLocal(String key, Object? value) async {
    switch (key) {
      case 'locale':
        if (value is! String || !AppLocale.values.any((AppLocale l) => l.name == value)) {
          return false;
        }
        await _prefs.setString(AppSettingsController.kLocaleKey, value);
        return true;
      case 'theme':
        if (value is! String || !AppThemeMode.values.any((AppThemeMode m) => m.name == value)) {
          return false;
        }
        await _prefs.setString(AppSettingsController.kThemeModeKey, value);
        return true;
      case 'text_scale':
        if (value is! String || !AppTextScale.values.any((AppTextScale t) => t.name == value)) {
          return false;
        }
        await _prefs.setString(AppSettingsController.kTextScaleKey, value);
        return true;
      case 'send_policy':
        if (value is! String) return false;
        await _prefs.setString(kSendPolicyKey, sendPolicyFromWire(value).name);
        return true;
      case 'translate_target':
        if (value is! String || !kTranslateTargets.contains(value)) return false;
        await _prefs.setString(kTranslateTargetKey, value);
        return true;
      case 'favorites':
        if (value is! List) return false;
        await _prefs.setStringList(kFavoritesKey, value.whereType<String>().toList());
        return true;
      default:
        return false;
    }
  }

  Map<String, Object?> _readUnknown() {
    final String? raw = _prefs.getString(unknownKeysKey);
    if (raw == null || raw.isEmpty) return <String, Object?>{};
    try {
      final Object? decoded = jsonDecode(raw);
      return decoded is Map ? decoded.cast<String, Object?>() : <String, Object?>{};
    } on FormatException {
      return <String, Object?>{};
    }
  }
}
