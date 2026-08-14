// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6 (the inventory layer —
//     this document's most important constraint on the implementation), §8-2
//     (the byte count beside the checkbox must be really computed)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §1 (the core
//     ruling: export = traverse + serialize; stats = traverse + aggregate;
//     clear = traverse + delete. **one traversal implementation, three verbs
//     consume it**), §5-2 (the acceptance question)
//
// ── THE PHONE'S ASSET WALKER ─────────────────────────────────────────────────
//
// 🔴 THIS IS NOT AN EXPORT HELPER. Export is its FIRST consumer; window-C2's
// stats and clear are the second and third, and they are the reason the walk
// is a named layer instead of a loop inside the exporter. The statement being
// defended (the overview design §1, verbatim): if each feature grows its own
// traversal, 「你有多少条记录、占多少空间」("how many records do you have, how
// much space do they take") gets three answers — this repo's headline bug
// shape (one value answering two questions) at feature scale.
//
// ⚠️ Anti-façade ④ — that paragraph is a greppable claim, so here is its current
// state, honestly. 【Corrected 2026-08-04】The original text read "TODAY the only
// production consumer is `portable_export.dart` … C2 does not exist yet" — **both
// sentences are now stale**: C2 (stats / clear) **is already in production, and
// is exactly this layer's consumer**: `portable/stats_clear_sheet.dart` takes
// `required AssetInventory inventory` (:43) and calls `inventory.tally()` (:99);
// it is wired up in `main.dart:257-261`, with entry points in
// `settings_page.dart:66` / `portable_controller.dart:63`.
// ⇒ **The current truth is: at least two production consumers (export and
// stats/clear) walk the SAME traversal.** This is exactly the thing this file
// originally promised being fulfilled, not overturned — but **fulfilling a
// promise still means updating the comment**, because a line saying "does not
// yet exist" would leave the next reader thinking this path is still unwired.
// What this file promises is still not "three consumers are already using it"
// but rather "all three verbs can be answered from one traversal", and
// that is checkable now: [AssetTally] carries counts / bytes / time-range and
// NOTHING about serialization (§6-1), and [walk] yields the row plus its bytes
// so a deleter has everything it needs without re-deriving anything.
//
// ── WHAT IT ANSWERS (16 册 §6-2, the three questions C2 needs) ───────────────
//   1. What assets exist — [AssetTally.entryCount] / [transcriptCount] / [imageCount]
//   2. How many bytes each takes (text / images separately) — [textBytes] / [imageBytes]
//   3. Time range — [oldest] / [newest]
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// No JSON, no zip, no file names. §6-1: 「盘点层只负责『有哪些资产、各占多少字节』，
// 不负责序列化格式」("the inventory layer is responsible only for 'what assets
// exist, how many bytes each takes' — it is not responsible for the
// serialization format"). A tally that knew about `records.jsonl` could not be
// reused by clear.

import 'dart:async';
import 'dart:convert';

import '../session/outbox_blob_store.dart';
import '../timeline/entry_metrics.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';

/// The rows to walk. A one-method interface rather than a bare
/// `Future<List<TimelineEntry>> Function()` so the null/empty case has a name
/// and so a test double is a class the reader can find (same posture as
/// [InstanceOwnerProbe] in timeline_store.dart).
abstract interface class TimelineRowSource {
  /// EVERY live row on this phone, newest-first, soft-deleted rows already
  /// dropped.
  ///
  /// 🔴 「live」 is the load-bearing word: `TimelineStore.delete` is a soft
  /// remove, and a row the user deleted must not reappear in an export they
  /// then re-import. The filtering happens in the implementation, next to the
  /// storage that knows about the flag.
  Future<List<TimelineEntry>> readAllRows();
}

/// Production source — the timeline store's read-only walk entry.
class TimelineStoreRows implements TimelineRowSource {
  const TimelineStoreRows(this._store);
  final TimelineStore _store;

  @override
  Future<List<TimelineEntry>> readAllRows() => _store.readAllRowsForInventory();
}

/// One row plus the disk facts about its picture.
///
/// The picture half is resolved ONCE, here, and handed to whoever consumes the
/// walk. Export needs the path (to put bytes in `att/`), stats needs the size,
/// clear needs the path (to delete). Making each of them ask again is how the
/// three end up disagreeing about whether a picture exists.
class TimelineAsset {
  const TimelineAsset({
    required this.entry,
    required this.imagePath,
    required this.imageBytes,
  });

  final TimelineEntry entry;

  /// Where this row's picture sits on this phone, or **null when there is
  /// none** — a transcript row, or a picture row whose file is genuinely gone
  /// (see `row_image_lookup.dart`: null is a normal answer, not a failure).
  final String? imagePath;

  /// The picture's real on-disk size in bytes. `0` exactly when [imagePath] is
  /// null. **Measured, never estimated** — 16 册 §8-2 ("a fake byte-count number
  /// and a fake progress bar are the same kind of thing").
  final int imageBytes;

  bool get hasImage => imagePath != null;

  /// UTF-8 bytes of the words this row carries.
  ///
  /// The three text fields a user can actually see and search
  /// (`timelineSearchText` uses the same three) — not the whole serialized row,
  /// because 「时间线的文字占多少空间」("how much space does the timeline's text
  /// take") is a question about the user's words, and C2 will render it under
  /// that name. The serialized record line is larger (ids, timestamps, JSON
  /// punctuation); that difference belongs to the exporter, not here (§6-1).
  static int textBytesOf(TimelineEntry e) {
    int n = 0;
    for (final String? s in <String?>[
      e.sourceText,
      e.outputText,
      e.processedText,
    ]) {
      if (s != null && s.isNotEmpty) n += utf8.encode(s).length;
    }
    return n;
  }
}

/// The aggregate — 16 册 §6-2's three questions in one value.
class AssetTally {
  const AssetTally({
    required this.entryCount,
    required this.transcriptCount,
    required this.imageCount,
    required this.imageFileCount,
    required this.textBytes,
    required this.imageBytes,
    required this.wordCount,
    required this.durationMs,
    required this.withoutDurationCount,
    required this.oldest,
    required this.newest,
  });

  static const AssetTally empty = AssetTally(
    entryCount: 0,
    transcriptCount: 0,
    imageCount: 0,
    imageFileCount: 0,
    textBytes: 0,
    imageBytes: 0,
    wordCount: 0,
    durationMs: 0,
    withoutDurationCount: 0,
    oldest: null,
    newest: null,
  );

  /// Live rows of every kind.
  final int entryCount;

  final int transcriptCount;

  /// Rows whose `entry_type` is `image`.
  final int imageCount;

  /// Picture rows whose bytes are ACTUALLY on this phone.
  ///
  /// 🔴 Deliberately separate from [imageCount], and the gap is real data, not
  /// rounding: a row minted before RV-93 had its bytes deleted on delivery by a
  /// ruling owner has since revoked, so it is an image row with no image. The
  /// export's 「包含图片」("include images") checkbox must show the number of
  /// files it can actually carry, and clear must not promise to free bytes that
  /// are not there.
  final int imageFileCount;

  /// UTF-8 bytes of the rows' visible text. See [TimelineAsset.textBytesOf].
  final int textBytes;

  /// Real on-disk bytes of the pictures counted by [imageFileCount].
  final int imageBytes;

  /// Window-C2 (16 册 §6.1) — total word count.
  ///
  /// 🔴 Sum of [entryWordCount], THE row-level function, not a second algorithm.
  /// The overview design §4b-8, verbatim: 「聚合＝逐行之和，**一套算法两个展示
  /// 粒度**」("aggregate = the sum of the rows, **one algorithm, two display
  /// granularities**"). If the stats page counted words itself, the pill on the
  /// row and the total below it would each drift on their own, and neither
  /// number would be far enough off for anyone to notice.
  final int wordCount;

  /// Window-C2 — total transcription duration (milliseconds). The owner's #1
  /// dimension ("count transcription duration only").
  ///
  /// Only sums rows that GENUINELY have a duration; rows with no duration all
  /// go into [withoutDurationCount].
  final int durationMs;

  /// 🔴 How many rows have **no** recorded duration.
  ///
  /// The one reason this slot exists: a `null` duration **must never be added
  /// into the total as 0** — that would be counting "unknown" as "zero
  /// seconds", the aggregate-side form of the ban 16 册 §4.1 states (never
  /// write a guessed value). The UI must say this out loud, or the total looks
  /// like it covers everything when it does not.
  final int withoutDurationCount;

  /// `createdAt` of the oldest / newest live row, or null on an empty timeline.
  ///
  /// ⚠️ These are the range of 「本机此刻还留着的」("what this phone still
  /// currently holds"), NOT 「用户说过的全部」("everything the user has ever
  /// said") — that distinction is exactly what 16 册 §4.1's `scope` field
  /// exists to say out loud in the export header.
  final DateTime? oldest;
  final DateTime? newest;

  bool get isEmpty => entryCount == 0;
}

/// The named layer. See the file header for why it is named.
abstract interface class AssetInventory {
  /// Every live row, newest-first, each with its picture facts resolved.
  ///
  /// A `Stream` rather than a `List` so a consumer that only needs to write
  /// each row out and forget it (the exporter) never holds the serialized form
  /// of more than one row at a time (16 册 §8-1).
  Stream<TimelineAsset> walk();

  /// One pass, aggregated. Same traversal as [walk] — literally, it consumes it
  /// — so 「统计说 N 条」("stats says N entries") and 「导出出来 N 条」("export
  /// produced N entries") cannot disagree (the overview design §5-2).
  Future<AssetTally> tally();

  /// Window-C2 — the same numbers, split by WHICH PC the rows were spoken to.
  ///
  /// 🔴 The phone groups by **target PC**; the desktop groups by **source
  /// phone** — the two ends are deliberately asymmetric (15 册 §2.3): the
  /// phone is the owner of "this utterance", the PC is the log of "the
  /// delivery". Grouping the delivery log by anything other than the sender
  /// would mean answering the phone's question with this machine's data.
  Future<List<InstanceTally>> tallyByInstance();
}

/// The stats belonging to ONE PC (one instance).
class InstanceTally {
  const InstanceTally({
    required this.instanceId,
    required this.instanceName,
    required this.tally,
  });

  /// `null` = these rows have no recorded counterpart (rows written before
  /// V2-06a-1, or something said while unpaired).
  final String? instanceId;

  /// The name snapshotted when the row was born; when `null` the UI renders
  /// 「未知实例」("unknown instance") — **never invent a name**.
  final String? instanceName;

  final AssetTally tally;
}

class TimelineAssetInventory implements AssetInventory {
  TimelineAssetInventory({required TimelineRowSource rows, required OutboxBlobStore images})
    : _rows = rows,
      _images = images;

  final TimelineRowSource _rows;
  final OutboxBlobStore _images;

  @override
  Stream<TimelineAsset> walk() async* {
    final List<TimelineEntry> rows = await _rows.readAllRows();
    for (final TimelineEntry e in rows) {
      // 🔴 REQ-12-13 — a remote control-key row is not a portable record; the
      // exclusion point is the **inventory layer** (16 册 §4.2).
      //
      // Why it is excluded HERE rather than in the exporter: this walker is
      // the **single production shared by stats and export**, so excluding it
      // here means 「哪些行算数」("which rows count") has exactly one answer;
      // excluding it in the exporter would be two rules, bound to drift apart
      // sooner or later. And the two verbs each need it, for different
      // reasons:
      //   · export: FPR v1's `entry_type` only recognizes transcript/image
      //     (`kFprEntryTypes`), so letting it out means it can be EXPORTED but
      //     never IMPORTED BACK (rejected row-by-row on import as
      //     `badEntryType`) — after one round trip those rows are simply gone,
      //     and nothing anywhere shouts about it;
      //   · stats: `_Accumulator.add` has only two buckets (`isImage` and
      //     else), so every keypress would be counted into the
      //     **transcript count**.
      // ⚠️ Do not "solve" this by adding control to `kFprEntryTypes`: that
      // would be **changing the already-frozen v1 format**, and a keypress was
      // never a piece of content to begin with — an MCP consumer reading it
      // back would get nothing useful.
      if (e.isControl) continue;
      yield await _resolve(e);
    }
  }

  Future<TimelineAsset> _resolve(TimelineEntry e) async {
    if (!e.isImage) {
      return TimelineAsset(entry: e, imagePath: null, imageBytes: 0);
    }
    // `clientId`, not `id` — the file is named by the request id, and for a
    // picture row the request id IS the client id (row_image_lookup.dart says
    // why using `id` here 「would look plausible and find nothing, every time」).
    final String? path = await _images.pathFor(e.clientId);
    if (path == null) {
      return TimelineAsset(entry: e, imagePath: null, imageBytes: 0);
    }
    final int? size = await _images.sizeOf(path);
    // A path that exists but whose size cannot be read is treated as 「no
    // picture」 rather than 「a picture of unknown size」: the export would have
    // nothing to put in `att/` and the tally would have to guess a number.
    if (size == null) {
      return TimelineAsset(entry: e, imagePath: null, imageBytes: 0);
    }
    return TimelineAsset(entry: e, imagePath: path, imageBytes: size);
  }

  @override
  Future<AssetTally> tally() async {
    final _Accumulator acc = _Accumulator();
    await for (final TimelineAsset a in walk()) {
      acc.add(a);
    }
    return acc.result;
  }

  @override
  Future<List<InstanceTally>> tallyByInstance() async {
    // Keyed by instance id; `null` (a legacy / unpaired row) gets its OWN group
    // rather than being folded into whichever PC happens to be open — a null
    // owner means we do not know who it was said to, and TimelineStore draws the
    // same line for the history page (entriesWithUnknownInstance).
    final Map<String?, _Accumulator> byId = <String?, _Accumulator>{};
    final Map<String?, String?> names = <String?, String?>{};
    await for (final TimelineAsset a in walk()) {
      final String? id = a.entry.spokenToInstanceId;
      (byId[id] ??= _Accumulator()).add(a);
      // The walk is newest-first, so the FIRST non-null name seen is the most
      // recent label this phone snapshotted for that PC.
      names[id] ??= a.entry.spokenToInstanceName;
    }
    final List<InstanceTally> out = byId.entries
        .map(
          (MapEntry<String?, _Accumulator> e) => InstanceTally(
            instanceId: e.key,
            instanceName: names[e.key],
            tally: e.value.result,
          ),
        )
        .toList();
    // Biggest first, stable: a user with one main PC should not have to scan.
    out.sort((InstanceTally a, InstanceTally b) {
      final int byCount = b.tally.entryCount.compareTo(a.tally.entryCount);
      return byCount != 0
          ? byCount
          : (a.instanceId ?? '').compareTo(b.instanceId ?? '');
    });
    return out;
  }
}

/// One pass' running totals.
///
/// Extracted so [TimelineAssetInventory.tally] and [tallyByInstance] aggregate
/// with the SAME code: a per-group copy of the summing would let 「各组之和」
/// ("the sum of each group") drift from 「总计」("the grand total") the first
/// time a field is added to [AssetTally].
class _Accumulator {
  int entries = 0;
  int transcripts = 0;
  int images = 0;
  int imageFiles = 0;
  int textBytes = 0;
  int imageBytes = 0;
  int words = 0;
  int durationMs = 0;
  int withoutDuration = 0;
  DateTime? oldest;
  DateTime? newest;

  void add(TimelineAsset a) {
    entries += 1;
    if (a.entry.isImage) {
      images += 1;
    } else {
      transcripts += 1;
    }
    if (a.hasImage) {
      imageFiles += 1;
      imageBytes += a.imageBytes;
    }
    textBytes += TimelineAsset.textBytesOf(a.entry);
    // 🔴 THE row-level function, CALLED — not re-derived. A picture row answers
    // null there (no speech to count) and contributes nothing here.
    words += entryWordCount(a.entry) ?? 0;
    final int? ms = a.entry.durationMs;
    if (ms == null) {
      // ⚠️ NOT `+= 0`. A row with no duration is not a zero-second row, and that
      // difference is the whole reason [AssetTally.withoutDurationCount] exists.
      // Picture rows are counted here too: they genuinely have no spoken
      // duration, and excluding them would make the two numbers not add up.
      withoutDuration += 1;
    } else {
      durationMs += ms;
    }
    final DateTime at = a.entry.createdAt;
    final DateTime? o = oldest;
    final DateTime? n = newest;
    if (o == null || at.isBefore(o)) oldest = at;
    if (n == null || at.isAfter(n)) newest = at;
  }

  AssetTally get result => AssetTally(
    entryCount: entries,
    transcriptCount: transcripts,
    imageCount: images,
    imageFileCount: imageFiles,
    textBytes: textBytes,
    imageBytes: imageBytes,
    wordCount: words,
    durationMs: durationMs,
    withoutDurationCount: withoutDuration,
    oldest: oldest,
    newest: newest,
  );
}
