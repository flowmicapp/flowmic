// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §2 (design rationale),
//     §3 (container), §4 (records.jsonl: header + record lines),
//     §5.2 (per-line results must be explainable), §5.4 (unknown fields
//     preserved verbatim)
//
// FPR v1, the PURE half: the header line, the entry line, and the named reasons
// a line can be refused. No dart:io, no zip, no Flutter, no TimelineEntry — so
// every rule below is unit-provable, and the SAME file will be readable by the
// desktop end and (Book 16 §1 ruling 3) by a future MCP consumer.
//
// 🔴 WHY EVERY LINE CARRIES `fpr` (§4.1's first hard constraint, restated
// because it is the one that looks redundant and is not): JSON Lines gets
// `tail`-ed, sliced
// and grepped. A fragment cut out of the middle of the file must still be able
// to say what format it is in. A version that lived only in the header would
// make every slice unidentifiable.

import 'dart:convert';

/// The format version. Bumped only for a shape change readers must know about.
const int kFprVersion = 1;

const String kFprKindHeader = 'header';
const String kFprKindEntry = 'entry';

/// `source.end` values. Book 16 §5.3 makes this the import-side admission
/// criterion.
const String kFprEndMobile = 'mobile';
const String kFprEndDesktop = 'desktop';

/// §3 container member names. Frozen: they are the addresses a future MCP
/// reader and the desktop end both hard-code.
const String kFprRecordsName = 'records.jsonl';
const String kFprReadmeName = 'README.txt';
const String kFprAttachmentDir = 'att';

/// The three modes. 🔴 red line 「三模式锁定，永无第四模式」("three modes
/// locked, never a fourth mode") — this is the import-side guard for it
/// (§4.2: reading an out-of-range value ⇒ §5.2 named refusal), and it is a
/// LITERAL set
/// rather than an import of `FlowMode` because this layer must stay free of the
/// app's own model (a future MCP reader gets the same rule from the same file).
const Set<String> kFprModes = <String>{'realtime', 'translate', 'organize'};

/// The four delivery-truth words (Book 15 §2.1 — `EntryStatus` plus the
/// orthogonal `edited` bit, which rides in `source_ext`, not here).
const Set<String> kFprStatuses = <String>{
  'injected',
  'cached',
  'failed',
  'noted',
};

const Set<String> kFprEntryTypes = <String>{'transcript', 'image'};

/// Why ONE line could not be read. §5.2: 「原因要具名，不许只说『格式错误』」
/// ("the reason must be named; you may not just say 'format error'").
enum FprLineRefusal {
  /// The line is not a JSON object at all.
  notJson,

  /// `fpr` is missing or is a version this build does not know.
  unknownFprVersion,

  /// `kind` is neither `entry` nor anything this build handles.
  unknownKind,

  /// A second `header` line. §4.1: 「第一行，必有且只有一行」("the first line
  /// must exist, and there must be only one").
  strayHeader,

  /// No `id`, or an empty one. Without it there is no idempotency key (§5.1).
  missingId,

  /// `created_at` absent or not a parseable ISO 8601 instant.
  badCreatedAt,

  /// `mode` outside [kFprModes] — the 三模式 ("three-mode") red line.
  badMode,

  /// `status` outside [kFprStatuses].
  badStatus,

  /// `entry_type` outside [kFprEntryTypes].
  badEntryType,
}

/// Why the WHOLE file could not be read. Separate enum from [FprLineRefusal] on
/// purpose: these end the import before a single row is touched, and the user's
/// next action is different for each.
enum FprFileRefusal {
  /// The picked file is not a readable zip.
  notAnArchive,

  /// No `records.jsonl` inside.
  missingRecords,

  /// 🔴 Book 16 §9b #1 — a member is deflate/bzip2 rather than STORE.
  ///
  /// A NAMED refusal, deliberately not a silent skip and deliberately not an
  /// inflate: the desktop end cannot inflate at all, so accepting it here would
  /// make one file importable on one end and refused on the other. The user's
  /// action is specific too (「用原始的那个 zip，别解开重新压缩」 "use the
  /// original zip, don't unzip and re-compress it"), which is why it does not
  /// reuse [notAnArchive] — that one says 「这根本不是我们的文件」("this isn't
  /// our file at all").
  compressedMember,

  /// Empty file, or a first line that is not a header.
  missingHeader,

  /// The header's `fpr` is a version this build does not know.
  unknownFprVersion,

  /// Book 16 §5.3 — `source.end` is not this end. The refusal names the OTHER
  /// end so the sentence can be 「这是从电脑导出的记录…」("this is a record
  /// exported from the computer…").
  crossEnd,

  /// §9 / §4.1 — the header's `count` disagrees with the actual number of entry
  /// lines. 「不等 = 导出撒谎」("mismatch = the export lied"), and a lying file
  /// is refused whole rather than half-imported.
  countMismatch,
}

/// §4.1 `scope` — 「这份文件包含什么」("what this file contains").
///
/// 🔴 This field is the landing point of 「导出不许只导一半」("an export must
/// not export only half"). The local timeline is not 「全部说过的话」
/// ("everything ever said"), it is 「此刻本机还留着的」("what this device
/// still has right now"), and the header has to say so or the user will read
/// it as the former.
class FprScope {
  const FprScope.all({this.truncatedBefore}) : kind = 'all';

  const FprScope._(this.kind, this.truncatedBefore);

  final String kind;

  /// The earliest instant this end can still account for, or **null when it
  /// genuinely does not know**.
  ///
  /// ⚠️ §4.1: 「只在真的知道时才写。不知道就不写这个字段，绝不许写一个猜的时刻」
  /// ("only write it when it's genuinely known; if unknown, don't write this
  /// field at all — never write a guessed instant").
  final DateTime? truncatedBefore;

  Map<String, Object?> toJson() => <String, Object?>{
    'kind': kind,
    if (truncatedBefore != null)
      'truncated_before': _iso(truncatedBefore!),
  };

  static FprScope parse(Object? raw) {
    if (raw is! Map) return const FprScope.all();
    final Object? kind = raw['kind'];
    final Object? tb = raw['truncated_before'];
    return FprScope._(
      kind is String && kind.isNotEmpty ? kind : 'all',
      tb is String ? DateTime.tryParse(tb)?.toUtc() : null,
    );
  }
}

/// §4.1 — the first line.
class FprHeader {
  const FprHeader({
    required this.exportedAt,
    required this.end,
    required this.appVersion,
    required this.device,
    required this.count,
    required this.hasAttachments,
    this.scope = const FprScope.all(),
    this.unknown = const <String, Object?>{},
  });

  final DateTime exportedAt;

  /// `mobile` / `desktop`. The import-side admission criterion (§5.3).
  final String end;

  /// The app version that WROTE this file, or **null when this build could not
  /// read its own version**.
  ///
  /// §4.1: 「从 package.json / pubspec 读，不许硬编码」("read it from
  /// package.json / pubspec, never hard-code it"). Null rather than a
  /// placeholder string: a made-up version in a file that outlives the install
  /// is exactly the Book 13 D5 failure the version discipline exists to
  /// prevent.
  final String? appVersion;

  /// The device name as the phone knows it, or null.
  final String? device;

  /// Number of `entry` lines. §4.1: 「必须与实际行数相等；不等 = 导出撒谎」
  /// ("must equal the actual line count; mismatch = the export lied") —
  /// enforced on write (the exporter rewinds and stamps the real number) and on
  /// read ([FprFileRefusal.countMismatch]).
  final int count;

  /// §8-3 — false when the user unticked 「包含图片」("include images"),
  /// **even if the phone has pictures**.
  final bool hasAttachments;

  final FprScope scope;

  /// §5.4 — header keys this build did not recognise, kept so a re-export does
  /// not silently drop a future version's metadata.
  final Map<String, Object?> unknown;

  Map<String, Object?> toJson() => <String, Object?>{
    // Unknown keys FIRST so a known key can never be shadowed by a stale one
    // carried over from a future version's file.
    ...unknown,
    'fpr': kFprVersion,
    'kind': kFprKindHeader,
    'exported_at': _iso(exportedAt),
    'source': <String, Object?>{
      'app': 'flowmic',
      'end': end,
      // Same normalisation as the record line, and the precedent the ruling
      // cites: an empty device name / version is 「我们没有它」("we don't
      // have it"), i.e. null. Both keys are always PRESENT — only the value
      // is normalised.
      'version': fprNullIfEmpty(appVersion),
      'device': fprNullIfEmpty(device),
    },
    'count': count,
    'has_attachments': hasAttachments,
    'scope': scope.toJson(),
  };

  /// Keys this build places itself; everything else on the header line is
  /// [unknown].
  static const Set<String> knownKeys = <String>{
    'fpr',
    'kind',
    'exported_at',
    'source',
    'count',
    'has_attachments',
    'scope',
  };
}

/// §4.2 — one record line.
///
/// Core fields only. Anything that belongs to ONE end lives in [sourceExt]
/// (§4.2: 「端专属字段的唯一口袋」 "the one pocket for end-specific fields")
/// so a reader can ignore that object entirely and still have the full core
/// semantics.
class FprEntryRecord {
  const FprEntryRecord({
    required this.id,
    required this.createdAt,
    required this.entryType,
    required this.mode,
    required this.sourceText,
    required this.outputText,
    required this.status,
    required this.durationMs,
    required this.attachment,
    required this.windowTitle,
    this.sourceExt = const <String, Object?>{},
    this.unknown = const <String, Object?>{},
  });

  /// The row's address on its own end. Mobile: `loc_{deviceId}_{clientId}`
  /// ([verified] `TimelineEntry.mintLocId`, timeline_entry.dart:362).
  final String id;

  /// 🔴 Carried over verbatim — Book 15 §2.4: on the phone this is the
  /// SPEAKING instant and it is never recomputed by an export.
  final DateTime createdAt;

  final String entryType;
  final String mode;

  /// 🔴 red line R5 — immutable. `null` means 「这一行结构上没有原文」("this
  /// row structurally has no source text"), never 「导出时丢了」("lost during
  /// export").
  ///
  /// ⚠️ **An empty string is written as `null`** — see [fprNullIfEmpty]. The
  /// field itself may hold `''` (the phone's model does); the NORMALISATION is
  /// in [toJson] only.
  final String? sourceText;

  /// The mode's FINAL result. The word-count convention (the unifying design
  /// doc §4-2).
  ///
  /// ⚠️ Same empty-string normalisation as [sourceText].
  final String? outputText;

  final String status;

  /// Spoken duration, or null. Never fabricated.
  final int? durationMs;

  /// `att/<hash>.<ext>`, or null. Non-null only on a picture row in an export
  /// the user ticked 「包含图片」("include images") for (§8-3).
  final String? attachment;

  /// 🔴 **A DECLARATION SLOT, AND IT IS ALWAYS `null`** (Book 16 §4.2, updated
  /// 2026-08-01 — both ends word for word).
  ///
  /// It says: 「this format HAS this field, and this line does not answer it
  /// HERE」. Constant on purpose, because a value that is null on one end and a
  /// real title on the other would give one key two meanings in the field an MCP
  /// consumer reads first — the exact failure this contract exists to prevent.
  ///
  /// **The real title is not thrown away**: on this end it rides in
  /// `source_ext.inject_target` (key spelled `inject_target`, the repo's own
  /// word), together with `process_name` / `injected_at`. Dropping it would be
  /// cutting down the user's own backup, not protecting them — owner's
  /// collection ruling governs what the app UPLOADS for contextual inference,
  /// a different threat model from a plaintext copy the user chose the
  /// destination for.
  ///
  /// The constructor still takes it so a FILE that carries a non-null value
  /// round-trips unchanged; nothing on this end ever passes one.
  final String? windowTitle;

  /// §4.2 — the end-specific pocket. See `fpr_mobile.dart` for the exact key
  /// list this end puts in it and where each key comes from.
  final Map<String, Object?> sourceExt;

  /// §5.4 — top-level keys this build did not recognise.
  final Map<String, Object?> unknown;

  Map<String, Object?> toJson() => <String, Object?>{
    ...unknown,
    'fpr': kFprVersion,
    'kind': kFprKindEntry,
    'id': id,
    'created_at': _iso(createdAt),
    'entry_type': entryType,
    'mode': mode,
    // 🔴 Book 16 §4.2 (owner/lead 2026-08-01, same on both ends): an empty
    // string is written as `null`. See [fprNullIfEmpty] for the judgement.
    'source_text': fprNullIfEmpty(sourceText),
    'output_text': fprNullIfEmpty(outputText),
    'status': status,
    'duration_ms': durationMs,
    'attachment': attachment,
    // Written explicitly, never omitted — §4.2: a reader must be able to see
    // that 「没有」("none") is deliberate rather than an old version that did
    // not write it.
    // See the field doc: on this end the value is always null and the real title
    // lives in `source_ext.inject_target`.
    'window_title': windowTitle,
    'source_ext': sourceExt,
  };

  static const Set<String> knownKeys = <String>{
    'fpr',
    'kind',
    'id',
    'created_at',
    'entry_type',
    'mode',
    'source_text',
    'output_text',
    'status',
    'duration_ms',
    'attachment',
    'window_title',
    'source_ext',
  };
}

/// The outcome of reading ONE line: exactly one of [record] / [header] /
/// [refusal] is non-null.
class FprLineRead {
  const FprLineRead.entry(FprEntryRecord this.record)
    : header = null,
      refusal = null;
  const FprLineRead.header(FprHeader this.header)
    : record = null,
      refusal = null;
  const FprLineRead.refused(FprLineRefusal this.refusal)
    : record = null,
      header = null;

  final FprEntryRecord? record;
  final FprHeader? header;
  final FprLineRefusal? refusal;
}

/// Parse one `records.jsonl` line.
///
/// [allowHeader] is false for every line after the first: a header appearing
/// mid-file is [FprLineRefusal.strayHeader], not a silently-ignored line.
FprLineRead readFprLine(String line, {required bool allowHeader}) {
  final Object? decoded;
  try {
    decoded = jsonDecode(line);
  } on FormatException {
    return const FprLineRead.refused(FprLineRefusal.notJson);
  }
  if (decoded is! Map) {
    return const FprLineRead.refused(FprLineRefusal.notJson);
  }
  final Map<String, Object?> j = decoded.cast<String, Object?>();
  if (j['fpr'] != kFprVersion) {
    return const FprLineRead.refused(FprLineRefusal.unknownFprVersion);
  }
  final Object? kind = j['kind'];
  if (kind == kFprKindHeader) {
    if (!allowHeader) {
      return const FprLineRead.refused(FprLineRefusal.strayHeader);
    }
    return FprLineRead.header(_readHeader(j));
  }
  if (kind != kFprKindEntry) {
    return const FprLineRead.refused(FprLineRefusal.unknownKind);
  }

  final Object? id = j['id'];
  if (id is! String || id.isEmpty) {
    return const FprLineRead.refused(FprLineRefusal.missingId);
  }
  final Object? createdRaw = j['created_at'];
  final DateTime? created = createdRaw is String
      ? DateTime.tryParse(createdRaw)
      : null;
  if (created == null) {
    return const FprLineRead.refused(FprLineRefusal.badCreatedAt);
  }
  final Object? mode = j['mode'];
  if (mode is! String || !kFprModes.contains(mode)) {
    return const FprLineRead.refused(FprLineRefusal.badMode);
  }
  final Object? status = j['status'];
  if (status is! String || !kFprStatuses.contains(status)) {
    return const FprLineRead.refused(FprLineRefusal.badStatus);
  }
  final Object? entryType = j['entry_type'];
  if (entryType is! String || !kFprEntryTypes.contains(entryType)) {
    return const FprLineRead.refused(FprLineRefusal.badEntryType);
  }

  return FprLineRead.entry(
    FprEntryRecord(
      id: id,
      createdAt: created.toUtc(),
      entryType: entryType,
      mode: mode,
      sourceText: j['source_text'] as String?,
      outputText: j['output_text'] as String?,
      status: status,
      durationMs: (j['duration_ms'] as num?)?.toInt(),
      attachment: j['attachment'] as String?,
      windowTitle: j['window_title'] as String?,
      sourceExt: j['source_ext'] is Map
          ? (j['source_ext']! as Map).cast<String, Object?>()
          : const <String, Object?>{},
      unknown: _unknownKeys(j, FprEntryRecord.knownKeys),
    ),
  );
}

FprHeader _readHeader(Map<String, Object?> j) {
  final Object? src = j['source'];
  final Map<String, Object?> source = src is Map
      ? src.cast<String, Object?>()
      : const <String, Object?>{};
  final Object? exportedAt = j['exported_at'];
  return FprHeader(
    // A header whose timestamp will not parse is NOT refused: the instant is
    // metadata, and refusing a whole file over it would throw away rows that
    // are perfectly readable. Epoch 0 would be a lie, so the fallback is the
    // one honest thing available — see [FprHeaderRead.exportedAtParsed].
    exportedAt: (exportedAt is String ? DateTime.tryParse(exportedAt) : null)
            ?.toUtc() ??
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    end: source['end'] is String ? source['end']! as String : '',
    appVersion: source['version'] is String
        ? source['version']! as String
        : null,
    device: source['device'] is String ? source['device']! as String : null,
    count: (j['count'] as num?)?.toInt() ?? -1,
    hasAttachments: j['has_attachments'] == true,
    scope: FprScope.parse(j['scope']),
    unknown: _unknownKeys(j, FprHeader.knownKeys),
  );
}

Map<String, Object?> _unknownKeys(
  Map<String, Object?> j,
  Set<String> known,
) {
  final Map<String, Object?> out = <String, Object?>{};
  for (final MapEntry<String, Object?> e in j.entries) {
    if (!known.contains(e.key)) out[e.key] = e.value;
  }
  return out;
}

/// 🔴 **`''` → `null`, at the serialization layer only** (Book 16 §4.2,
/// 2026-08-01, same on both ends — the same shape as the `source.device`
/// precedent).
///
/// The judgement: `''` is a VALUE meaning 「有文本，而它是空的」("there is
/// text, and it's empty"); `null` means 「**结构上没有这一项**」("structurally
/// there is no such item"). A picture row has no spoken original, which is
/// the second one. Two spellings that both 「讲得通」("make sense") for the
/// same fact is the same as having no rule at all — and this key is one an
/// MCP consumer reads first.
///
/// ⚠️ It is NOT a data-model change: the phone still stores `''` in
/// `TimelineEntry.sourceText` / `.outputText`. Only what goes on the line is
/// normalised.
///
/// ⚠️ **It is therefore a deliberate one-way collapse**: a row exported with
/// `sourceText: ''` comes back from an import as `null`. That is the ruling, not
/// a round-trip defect — both spellings mean 「这一行没有原文」("this row has
/// no source text"), and the format picks one. Pinned by
/// `portable_roundtrip_test.dart`
/// (「an empty source_text comes back as null」), so nobody later reads the
/// field-by-field round-trip test as 「every row is byte-identical」.
String? fprNullIfEmpty(String? v) => (v == null || v.isEmpty) ? null : v;

/// ISO 8601 UTC with the trailing `Z` (§4.1 hard constraint).
String _iso(DateTime t) => t.toUtc().toIso8601String();

/// Public form of [_iso] — the exporter and the README use the same formatter,
/// so the instant in the header and the instant in the human-readable file
/// cannot disagree.
String fprIso(DateTime t) => _iso(t);
