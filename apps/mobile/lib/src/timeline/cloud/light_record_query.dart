// REQ-12-09 09-A — the ONE read the 「+」 panel's light-record (轻记录) tab
// needs and the timeline layer did not already have: 「search ∩ light record」.
//
// SPEC-REF: docs/strategy/2026-08-12-req1209-plus-panel-design.md §5-3
//   (the gap is exactly one intersection query — 缺口只有一个交集查询),
//   §1-3 (across owners, on-screen entries are always empty — 跨 owner，
//   屏幕上的 entries 恒空).
//
// ── WHY BESIDE THE BRIDGE, NOT A METHOD ON TimelineStore ─────────────────────
// The same two reasons blind_store_timeline_bridge.dart gives for itself, and
// the second is still the real one:
//   · timeline_store.dart sits at 751 of the 800-line src cap
//     (verify/lint/file-size.mjs), so this card cannot grow it without a split
//     it did not come to do;
//   · TimelineStore is the in-memory OWNER of what the chat screen is looking
//     at, and this query is about rows that screen structurally CANNOT see. A
//     light record is born with the cloud instance's `spoken_to_instance_id`
//     (timeline_store.dart:342), and every paired screen reads
//     `entriesForOwners(...)` — so asking the store would return an empty list
//     forever, and it would look like a working feature with nothing in it.
//
// ── WHY IT TAKES A TimelinePersistence, NOT A BlindStoreTimelineBridge ───────
// The bridge needs a [TimelineReaper] and a reload callback, neither of which a
// read has any use for — and in production it is constructed only inside
// main.dart's `if (cloudState != null)` branch, i.e. it does not exist at all
// when SQLite failed to open and the app is running the shared_preferences
// fallback. A light-record tab that vanishes when storage degrades would hide rows that
// are really on disk, which is exactly what design §3-3 state B forbids. So the
// two share the PREDICATE ([isLightRecord]) rather than the object.

import '../timeline_entry.dart';
import '../timeline_persistence.dart';
import 'blind_store_timeline_bridge.dart';

/// Read-only. Every light record on this device, and the subset matching a word.
///
/// 🔴 READ-ONLY IS STRUCTURAL, NOT A HABIT. Nothing here writes, deletes or
/// notifies. Deleting a light record still goes through `TimelineReaper.reap`
/// (the one deleter), and a row referenced by anything the panel later builds
/// keeps its own status byte for byte — 「这一条到底发生了什么」("what actually
/// happened with this item") is not changed by someone reading it (design
/// §7-4).
class LightRecordQuery {
  LightRecordQuery({required TimelinePersistence persistence})
    : _persistence = persistence;

  final TimelinePersistence _persistence;

  /// Every light record on this phone, newest first.
  ///
  /// The same whole-table scan `BlindStoreTimelineBridge.lightRecords` is, for
  /// the reason its doc already argues: at private-domain scale this is a few
  /// thousand rows and milliseconds, and a projected `origin` column would be a
  /// schema change plus a second home for the value.
  Future<List<TimelineEntry>> all() async {
    final List<TimelineEntry> rows = await _persistence.loadAll();
    return _newestFirst(<TimelineEntry>[
      for (final TimelineEntry e in rows)
        if (isLightRecord(e)) e,
    ]);
  }

  /// The light records whose visible text contains [query], newest first.
  ///
  /// Blank [query] returns NOTHING rather than everything — the convention
  /// `TimelinePersistence.search` already set (「搜了个空的就把全部倒出来」
  /// ("searching for nothing dumps everything") reads as a broken filter).
  /// ⚠️ That is a statement about this METHOD, not about the
  /// tab: a panel whose search box is empty is not searching, so it shows [all].
  ///
  /// 🔴 THE NARROWING HAPPENS FIRST, AND THAT ORDER IS THE WHOLE CARD.
  ///
  /// The obvious implementation — `persistence.search(q)` and then keep the rows
  /// whose origin is cloud — is wrong, and wrong in a way no casual test finds.
  /// `search` truncates at its `limit` (200 by default) INSIDE the store, so the
  /// Dart-side filter would run over 「the 200 newest rows containing this word」
  /// rather than over the matches. A user with many ordinary transcripts and few
  /// light notes searches a common word and gets NOTHING, while the notes sit on
  /// disk. That is a correctness bug, not a performance preference. Pinned by
  /// `light_record_query_test.dart`「201 paired hits + one older cloud hit」,
  /// whose reverse control is precisely that implementation.
  ///
  /// ⚠️ WHAT THIS IS NOT: the `origin` condition is NOT pushed into a SQL WHERE,
  /// which is what design §5-3 asked for. MEASURED at this HEAD: `origin` is not
  /// a column of `timeline_entries`. The projected columns are written by one
  /// function (`_row` in timeline_sqlite.dart) and `origin` is not among them —
  /// it exists only inside the JSON `payload`. A WHERE over it therefore needs a
  /// new projected column and a version step, i.e. a schema change, which is a
  /// human-audit gate. The two ways to fake one were both refused on grounds
  /// this package has already written down: `json_extract` depends on whether
  /// the DEVICE's system SQLite shipped JSON1 (timeline_sqlite.dart:405-428
  /// refuses FTS5 on exactly that ground), and `payload LIKE '%"origin":"cloud"%'`
  /// matches a user who typed that string into a transcript.
  ///
  /// What is guaranteed instead is stronger than a larger limit: there is no
  /// truncation anywhere on this path, so the defect cannot return by someone
  /// picking the wrong number.
  ///
  /// COST, stated rather than hidden: this decodes every row, which is the same
  /// scan [all] already is. If it ever stops being milliseconds the fix is the
  /// projected `origin` column and its migration — not a limit.
  Future<List<TimelineEntry>> search(String query) async {
    final String needle = query.trim().toLowerCase();
    if (needle.isEmpty) return const <TimelineEntry>[];
    // Narrow to light records FIRST (unbounded), match SECOND. See above.
    final List<TimelineEntry> notes = await all();
    return <TimelineEntry>[
      for (final TimelineEntry e in notes)
        if (timelineSearchText(e).contains(needle)) e,
    ];
  }
}

/// Newest first, explicitly.
///
/// `TimelinePersistence.loadAll` only PROMISES an order in the SQLite
/// implementation (`ORDER BY created_at DESC`); the in-memory and
/// shared_preferences ones hand back insertion order. Leaning on the former
/// would give the panel a list whose order depends on which store managed to
/// open — visible only on the fallback, which is the worst place to find it.
List<TimelineEntry> _newestFirst(List<TimelineEntry> rows) {
  rows.sort(
    (TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt),
  );
  return List<TimelineEntry>.unmodifiable(rows);
}
