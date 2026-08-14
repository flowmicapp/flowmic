// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §4.2 (core fields + source_ext
//     is the sole pocket for end-specific fields), §5.4 (unknown fields are kept as-is)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.3 (the two ends are
//     deliberately asymmetric — no "casually unifying" them)
//
// The MOBILE end's mapping: TimelineEntry ⇄ FprEntryRecord.
//
// ── WHY THE POCKET EXISTS AND WHY IT IS NOT A BIN ───────────────────────────
//
// 15 册 §2.3: the phone's row is the owner of 「这句话」("this utterance"), the
// PC's row is the log of 「投递」("delivery").
// They are not the same object, and flattening both ends' private fields into
// one top-level namespace would (a) collide and (b) make an MCP consumer read
// `cachedByVerdict` as if it were a universal concept. So end-specific keys go
// into `source_ext`, and a reader may ignore that object entirely without
// losing any core semantics (§4.2).
//
// ⚠️ §4.2 also says 「source_ext 不是垃圾桶：进去的每个键都要在实现处写明它是什
// 么、哪一端产生」 ("source_ext is not a trash bin: every key that goes in must be
// documented at its implementation site — what it is, which end produces it").
// The table is [kMobileSourceExtKeys] below, and the guard that
// keeps it honest is `portable_fpr_test.dart`, which pins BOTH key sets against
// `TimelineEntry.toJson()`'s actual output: adding a field to the row makes that
// test fail until somebody decides, in writing, where it goes. Without that
// test the pocket really would become a bin — silently, by construction.
//
// ── THE ROUND-TRIP GUARANTEE (16 册 §9 requires 「一字不差」, "not a single
// character off") ─────────────────
// Export builds the record from `TimelineEntry.toJson()`; import rebuilds the
// row with `TimelineEntry.fromJson()`. ONE serializer, used in both directions,
// so a field cannot survive one leg and be dropped on the other. Anything the
// promotion table moves to a core field is put back under its original key
// before `fromJson` ever sees the map.

import '../timeline/timeline_entry.dart';
import 'fpr_record.dart';

/// Every key `TimelineEntry.toJson()` emits, as of 0.2.36 【已核 timeline_entry
/// .dart:428-465, 2026-08-01】. Pinned by a test — see the file header.
const Set<String> kMobileRowKeys = <String>{
  'id',
  'client_id',
  'mode',
  'delivery',
  'source_text',
  'output_text',
  'source_lang',
  'output_lang',
  'process_mode',
  'processed_text',
  'refined_at',
  'inject_target',
  'pc_name',
  'spoken_to_instance_id',
  'spoken_to_instance_name',
  'edited',
  'status',
  'duration_ms',
  'segments_count',
  'origin',
  'deleted',
  'entry_type',
  'thumb_b64',
  // REQ-12-13 — device-local, and DROPPED rather than pocketed; see
  // [kFprDroppedRowKeys] for why it is named at all when the row it belongs to
  // never reaches the exporter.
  'control_kind',
  'failure_reason',
  'cached_by_verdict',
  'last_resent_at',
  'created_at',
  'updated_at',
};

/// Row keys PROMOTED to FPR core fields (§4.2's table). Same name on both
/// sides, so the promotion is a move, not a rename that could drift.
const Set<String> kFprPromotedRowKeys = <String>{
  'id',
  'mode',
  'source_text',
  'output_text',
  'status',
  'duration_ms',
  'entry_type',
  'created_at',
};

/// Row keys deliberately NOT exported at all.
///
/// `deleted`: the inventory yields live rows only, so every exported row would
/// carry `false`, and a `true` arriving on import would resurrect a tombstone as
/// an invisible row. Dropping it means an imported row is born live, which is the
/// only state an exported row can honestly claim.
///
/// 🔴 `control_kind` (REQ-12-13, 2026-08-12): a remote-key row is NOT a portable
/// record and never reaches this function at all — the walker excludes it
/// (`asset_inventory.dart`, 16 册 §4.2), because FPR v1's `entry_type` admits
/// `transcript`/`image` only and an exported keypress row is REFUSED line-by-line
/// on re-import (导得出、导不回 — "exportable, not importable back").
///
/// ⚠️ It is listed here ANYWAY, and the reason is the point: this set is what the
/// key-accounting test measures `TimelineEntry.toJson` against, so leaving the key
/// out would have meant either 「悄悄进了口袋」 ("quietly slipping into the pocket" —
/// a device-local field for a row kind that cannot be in the file, riding along in
/// every OTHER row's `source_ext` as `null`) or a gate failure with no stated
/// answer. Naming it says out loud that
/// the field is deliberately outside the format — belt and braces with the walker,
/// so that if someone ever widens the walker the format still cannot silently gain
/// a key it has no meaning for.
const Set<String> kFprDroppedRowKeys = <String>{'deleted', 'control_kind'};

/// 🔴 THE POCKET, key by key. Everything here is DEVICE-LOCAL on the phone —
/// none of it is on the wire — and each line says what it is.
///
/// | key | what it is |
/// |---|---|
/// | `client_id` | the utterance id / `request_id`; also the address of this row's picture on disk |
/// | `delivery` | the intent fixed at `audio:start` (`inject` / `none`) |
/// | `source_lang` / `output_lang` | STT language and the translate target |
/// | `process_mode` | `translate` / `organize` / absent — what makes the 「原文」 ("original text") line show |
/// | `processed_text` | the compose product |
/// | `refined_at` | GA-14 second-pass marker |
/// | `inject_target` | `{window_title, process_name, injected_at}` — where it landed |
/// | `pc_name` | the PC it landed on, snapshotted at the time |
/// | `spoken_to_instance_id` / `_name` | 「这条是对谁说的」 ("who this was said to") at birth (V2-06a-1) |
/// | `edited` | 红线's ("the red line's") orthogonal 「人改过」 ("a human edited it") bit (15 册 §2.1's fifth state) |
/// | `segments_count` | STT segments behind this row |
/// | `origin` | `paired` / `cloud` (轻记录行 — "light-record rows" — 16 册 §10-4 says these belong in the export) |
/// | `thumb_b64` | the 256 px preview the row already carries |
/// | `failure_reason` | named delivery-failure code |
/// | `cached_by_verdict` | 「在等判决」 ("awaiting a verdict") vs 「判决说没投」 ("the verdict says it wasn't delivered") (15 册 §2.1) |
/// | `last_resent_at` | 「最后一次重发」 ("the last resend") — records the ACT, not its outcome |
/// | `updated_at` | last mutation instant |
const Set<String> kMobileSourceExtKeys = <String>{
  'client_id',
  'delivery',
  'source_lang',
  'output_lang',
  'process_mode',
  'processed_text',
  'refined_at',
  'inject_target',
  'pc_name',
  'spoken_to_instance_id',
  'spoken_to_instance_name',
  'edited',
  'segments_count',
  'origin',
  'thumb_b64',
  'failure_reason',
  'cached_by_verdict',
  'last_resent_at',
  'updated_at',
};

/// §5.4 — the fields a FILE carried that THIS build could not place.
///
/// Two buckets because they go back to two different places on re-export: a
/// future version's top-level key must return to the top level, and a future
/// version's `source_ext` key must return to `source_ext`. Merging them would
/// move a field between namespaces, which is a quiet corruption rather than
/// preservation.
class FprCarriedFields {
  const FprCarriedFields({required this.top, required this.ext});

  static const FprCarriedFields none = FprCarriedFields(
    top: <String, Object?>{},
    ext: <String, Object?>{},
  );

  final Map<String, Object?> top;
  final Map<String, Object?> ext;

  bool get isEmpty => top.isEmpty && ext.isEmpty;

  Map<String, Object?> toJson() => <String, Object?>{
    if (top.isNotEmpty) 'top': top,
    if (ext.isNotEmpty) 'ext': ext,
  };

  static FprCarriedFields fromJson(Object? raw) {
    if (raw is! Map) return none;
    final Object? top = raw['top'];
    final Object? ext = raw['ext'];
    return FprCarriedFields(
      top: top is Map ? top.cast<String, Object?>() : const <String, Object?>{},
      ext: ext is Map ? ext.cast<String, Object?>() : const <String, Object?>{},
    );
  }
}

/// Which of an incoming record's fields this build cannot place.
FprCarriedFields carriedFieldsOf(FprEntryRecord r) {
  final Map<String, Object?> ext = <String, Object?>{};
  for (final MapEntry<String, Object?> e in r.sourceExt.entries) {
    if (!kMobileSourceExtKeys.contains(e.key)) ext[e.key] = e.value;
  }
  if (r.unknown.isEmpty && ext.isEmpty) return FprCarriedFields.none;
  return FprCarriedFields(top: r.unknown, ext: ext);
}

/// EXPORT: one live row → one record line.
///
/// [attachment] is the `att/<hash>.<ext>` relative path, or null when this row
/// has no picture in this file — either because it is a transcript, because the
/// bytes are gone, or because the user unticked 「包含图片」 ("include images")
/// (§8-3: the row is still exported, only the pointer is null).
///
/// [carried] puts a previous import's unrecognised fields back (§5.4).
FprEntryRecord fprRecordOfRow(
  TimelineEntry row, {
  String? attachment,
  FprCarriedFields carried = FprCarriedFields.none,
}) {
  final Map<String, Object?> j = row.toJson();
  final Map<String, Object?> ext = <String, Object?>{};
  for (final MapEntry<String, Object?> e in j.entries) {
    if (kFprPromotedRowKeys.contains(e.key)) continue;
    if (kFprDroppedRowKeys.contains(e.key)) continue;
    ext[e.key] = e.value;
  }
  // A future version's keys go back LAST so they cannot shadow a key this
  // build owns — 「原样写回」 ("write back unchanged") means preserved, not
  // promoted to authority.
  ext.addAll(carried.ext);

  return FprEntryRecord(
    id: row.id,
    createdAt: row.createdAt,
    entryType: row.entryType,
    mode: row.mode.name,
    sourceText: row.sourceText,
    outputText: row.outputText,
    status: row.status.wire,
    durationMs: row.durationMs,
    attachment: attachment,
    // 🔴 16 册 §4.2 (2026-08-01, 两端逐字相同 — "identical, verbatim, on both
    // ends"): the top-level key is a DECLARATION SLOT and is ALWAYS null. The
    // real title is already in the pocket, under
    // `inject_target` — the same object that carries `process_name` and
    // `injected_at`, so nothing is lost and nothing is duplicated. Projecting the
    // title up here would give one key two meanings across the two ends.
    windowTitle: null,
    sourceExt: ext,
    unknown: carried.top,
  );
}

/// IMPORT: one record line → the `TimelineEntry.fromJson` map.
///
/// The pocket is laid down first and the promoted core fields are written back
/// over it under their ORIGINAL row keys, so `fromJson` sees exactly the map
/// `toJson` produced. A field that disagreed between the two would be a
/// round-trip loss, which is why the promotion set is a named constant used by
/// both directions rather than two hand-written literals.
Map<String, Object?> rowJsonOfFpr(FprEntryRecord r) => <String, Object?>{
  ...r.sourceExt,
  'id': r.id,
  'mode': r.mode,
  'source_text': r.sourceText,
  // `outputText` is non-null on the row; an FPR file may legitimately carry
  // null (§4.2 types it `string | null`), and the row's own `fromJson` already
  // coerces a missing value to ''. Passing the null through keeps ONE coercion
  // rule instead of two.
  'output_text': r.outputText,
  'status': r.status,
  'duration_ms': r.durationMs,
  'entry_type': r.entryType,
  'created_at': fprIso(r.createdAt),
};
