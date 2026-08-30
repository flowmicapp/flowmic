// Part of timeline_entry.dart — THE LOCAL PERSISTENCE CODEC.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────────
// Card CR-7's two fields (`article_id` / `article_offset_ms`, with the argument
// each one owes) put timeline_entry.dart at 827 against
// `verify/lint/file-size.mjs`'s SRC_MAX = 800. This repo's practice at that cap
// is a STRUCTURAL split — take a coherent family out whole — rather than
// trimming the evidence a comment carries (`bootstrap.ts`/`shutdown.ts`, IT-02;
// timeline_store_control_rows.dart; timeline_sqlite_schema.dart).
//
// The family is coherent because it answers ONE question end to end: 「how does a
// row go into, and come back out of, the single device-local `payload` JSON
// column?」 — the section timeline_entry.dart had already drawn a banner around.
// What stays behind is the MODEL: what a row IS, what each field means, and what
// it says on the WIRE ([TimelineEntry.toHistoryItem]) — a different question,
// with a different audience, which is why it is deliberately NOT filed here.
//
// 🔴 DIFF DISCIPLINE. Both bodies are moved line-for-line, with the ONE
// mechanical edit this family always makes — the receiver becomes explicit,
// exactly as timeline_store_control_rows.dart records for `store._entries`:
//   · `toJson`'s body reads the row's own fields, so each one gained an `e.`;
//   · `fromJson`'s body names three `entryType` constants that needed no prefix
//     inside the class and need `TimelineEntry.` outside it.
// **Any other difference in the diff is a bug.**
//
// 🔴 WHY BOTH STAYED FUNCTIONS AND NOT AN `extension`. An extension would have
// moved `toJson` with ZERO edits, and it was refused: extension members are
// invisible to DYNAMIC dispatch, so `jsonEncode(entry)` — which finds `toJson`
// at runtime — would compile and then throw. Nothing in the tree does that
// today (measured: the one `jsonEncode(e)` is over a `Map`), and that is
// precisely the problem: the trap would be armed for whoever writes it next,
// and it would not be a type error. A cheaper diff is not worth a runtime cliff.
//
// ⚠️ NOTHING WAS DELETED. Every rationale comment travels with the line it
// justifies — including the two that record why a field is read the way it is
// (V2-06a-1's refusal to invent an owner for a legacy row, and the entry_type
// read-back's three-way test), which are the evidence a split must not drop.

part of 'timeline_entry.dart';

/// The device-local JSON face of a row. NEVER the wire — that is
/// [TimelineEntry.toHistoryItem], and the two must not be confused.
///
/// [TimelineEntry.toJson] delegates here in one line, so every caller and every
/// test double is byte-for-byte unchanged.
Map<String, Object?> timelineEntryToJson(TimelineEntry e) =>
    <String, Object?>{
  'id': e.id,
  'client_id': e.clientId,
  'mode': e.mode.name,
  'delivery': e.delivery.name,
  'source_text': e.sourceText,
  'output_text': e.outputText,
  'source_lang': e.sourceLang,
  'output_lang': e.outputLang,
  'process_mode': e.processMode,
  'processed_text': e.processedText,
  'refined_at': e.refinedAt?.toIso8601String(),
  'inject_target': e.injectTarget?.toJson(),
  'pc_name': e.pcName,
  // V2-06a-1. Absent on legacy rows -> null on read, which is the honest
  // answer: those rows genuinely have no recorded owner.
  'spoken_to_instance_id': e.spokenToInstanceId,
  'spoken_to_instance_name': e.spokenToInstanceName,
  'edited': e.edited,
  'status': e.status.wire,
  'duration_ms': e.durationMs,
  'segments_count': e.segmentsCount,
  'origin': e.origin,
  'deleted': e.deleted,
  'entry_type': e.entryType,
  'thumb_b64': e.thumbB64,
  // REQ-12-13 — device-local, rides the one `payload` JSON column (no migration).
  'control_kind': e.controlKind,
  // 🔴 CR-7 — this key is the half of the grouping that survives blind-store
  // sync (see the field). Absent, not null, on a row outside an article: an
  // absent key reads back as null either way, and writing nulls into every
  // row's payload would grow the ciphertext of a feature most rows never use.
  if (e.articleId != null) 'article_id': e.articleId,
  if (e.articleOffsetMs != null) 'article_offset_ms': e.articleOffsetMs,
  // Device-local payload key; SQLite stores this JSON as-is (no schema migrate).
  'failure_reason': e.failureReason,
  // N2, same deal: the sqlite row is one JSON `payload` column, so a new
  // device-local key rides along with no migration and no projected column.
  'cached_by_verdict': e.cachedByVerdict,
  // owner 2026-07-31 resend time (重发时间). Same deal again — a device-local key inside the
  // one `payload` JSON column, so it persists across a relaunch with no
  // migration and no projected column. Absent (null) on a row never re-sent.
  'last_resent_at': e.lastResentAt?.toUtc().toIso8601String(),
  'created_at': e.createdAt.toUtc().toIso8601String(),
  'updated_at': e.updatedAt.toUtc().toIso8601String(),
};

/// Read a row back off the device-local `payload` column.
///
/// Top-level rather than a member because a static cannot live on an extension
/// and `TimelineEntry.fromJson` is called by name in 26 places; the class keeps
/// the one-line delegate.
TimelineEntry? timelineEntryFromJson(Map<String, Object?> j) {
  final Object? id = j['id'];
  final Object? clientId = j['client_id'];
  if (id is! String || id.isEmpty) return null;
  if (clientId is! String || clientId.isEmpty) return null;
  return TimelineEntry(
    id: id,
    clientId: clientId,
    mode: _modeFromWire(j['mode']),
    delivery: j['delivery'] == 'none' ? Delivery.none : Delivery.inject,
    sourceText: j['source_text'] as String?,
    outputText: (j['output_text'] as String?) ?? '',
    sourceLang: j['source_lang'] as String?,
    outputLang: j['output_lang'] as String?,
    processMode: j['process_mode'] as String?,
    processedText: j['processed_text'] as String?,
    refinedAt: j['refined_at'] is String
        ? DateTime.tryParse(j['refined_at'] as String)
        : null,
    injectTarget: InjectTarget.tryParse(j['inject_target']),
    pcName: j['pc_name'] is String && (j['pc_name'] as String).isNotEmpty
        ? j['pc_name'] as String
        : null,
    // V2-06a-1: absent on every row written before this field existed, and it
    // stays null. There is no migration that could invent an owner for them —
    // guessing 「当前连着谁」("who is currently connected") is the same lie
    // requirement ③ (需求③) banned when it refused to
    // back-fill `now` onto old pairings.
    spokenToInstanceId:
        j['spoken_to_instance_id'] is String &&
            (j['spoken_to_instance_id'] as String).isNotEmpty
        ? j['spoken_to_instance_id'] as String
        : null,
    spokenToInstanceName:
        j['spoken_to_instance_name'] is String &&
            (j['spoken_to_instance_name'] as String).isNotEmpty
        ? j['spoken_to_instance_name'] as String
        : null,
    edited: j['edited'] == true,
    status: EntryStatus.fromWire(j['status']),
    durationMs: (j['duration_ms'] as num?)?.toInt(),
    segmentsCount: (j['segments_count'] as num?)?.toInt() ?? 0,
    origin: (j['origin'] as String?) ?? 'paired',
    deleted: j['deleted'] == true,
    // A pre-T-4 stored row has no entry_type — it is a transcript by
    // construction, so the default is the truth rather than a guess.
    // REQ-12-13: `control` MUST be listed. A two-way ternary rewrites a
    // keypress row into a transcript on the way back off disk — and then the
    // next write persists the rewrite, so one relaunch makes it permanent and
    // hands that row resend/edit/deferred-delivery (重发/编辑/补投) as a bonus. Anything still unrecognised
    // falls back to transcript exactly as before.
    // 🔴 CR-7 adds a THIRD value that must be listed here, and the cost of
    // forgetting is spelled out above: a head read back as a transcript is
    // then PERSISTED as one on the next write, so one relaunch turns the
    // cover of a recording into a sentence that can be re-delivered.
    entryType: j['entry_type'] == TimelineEntry.kImage
        ? TimelineEntry.kImage
        : (j['entry_type'] == TimelineEntry.kControl
              ? TimelineEntry.kControl
              : (j['entry_type'] == TimelineEntry.kArticle ? TimelineEntry.kArticle : TimelineEntry.kTranscript)),
    thumbB64: j['thumb_b64'] is String ? j['thumb_b64'] as String : null,
    // CR-7 — absent on every row written before articles existed → null,
    // which is the truth: those rows belong to no recording. There is no
    // migration that could invent one, and adopting them into 「whatever
    // article is open now」 would be the same lie V2-06a-1 refused above.
    articleId:
        j['article_id'] is String && (j['article_id'] as String).isNotEmpty
        ? j['article_id'] as String
        : null,
    articleOffsetMs: (j['article_offset_ms'] as num?)?.toInt(),
    // Absent on every row written before REQ-12-13 → null, which is the truth:
    // those rows are not keypresses.
    controlKind:
        j['control_kind'] is String && (j['control_kind'] as String).isNotEmpty
        ? j['control_kind'] as String
        : null,
    // Absent on legacy rows → null. That is the honest answer, not a guess.
    failureReason:
        j['failure_reason'] is String &&
            (j['failure_reason'] as String).isNotEmpty
        ? j['failure_reason'] as String
        : null,
    // Absent on every row stored before N2 → false, i.e. 「没有判决说过它未投递」
    // ("no verdict has ever said it was not delivered").
    // That is the honest default: those rows were written by a build whose only
    // meaning for cached was 投递中("in delivery").
    cachedByVerdict: j['cached_by_verdict'] == true,
    // Absent on every row stored before this field → null = 「没被重发过」
    // ("never been resent"), which
    // is the honest answer for a row written by a build that never recorded it.
    // Deliberately NOT `_date()`: that helper answers with epoch-0 for a
    // missing value, and an entry claiming it was last re-sent in 1970 would
    // render a confident lie in the meta row. Null is the only right answer.
    lastResentAt: j['last_resent_at'] is String
        ? DateTime.tryParse(j['last_resent_at'] as String)?.toUtc()
        : null,
    createdAt: _date(j['created_at']),
    updatedAt: _date(j['updated_at']),
  );
}

FlowMode _modeFromWire(Object? v) => _modeMap[v] ?? FlowMode.realtime;
const Map<Object?, FlowMode> _modeMap = <Object?, FlowMode>{
  'realtime': FlowMode.realtime,
  'translate': FlowMode.translate,
  'organize': FlowMode.organize,
};

DateTime _date(Object? v) {
  if (v is String && v.isNotEmpty) return DateTime.parse(v).toUtc();
  if (v is num) {
    return DateTime.fromMillisecondsSinceEpoch(v.toInt(), isUtc: true);
  }
  return DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
}
