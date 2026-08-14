// The production [ImportRowSink].
//
// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5.1 (idempotent, dedup by id)
//
// ⚠️ WHY THIS WRITES THROUGH `TimelinePersistence` RATHER THAN `TimelineStore`,
// stated plainly because `timeline_store.dart` calls itself 「the single writer
// of the local table」 and this is a second one:
//
//   窗口C's boundary allows exactly ONE addition to that class — a read-only walk
//   entry — so an `insertImported(...)` method was not available to this card.
//   The write therefore goes to the SAME `TimelinePersistence` INSTANCE the
//   store holds, which is what preserves ordering: `SqfliteTimelinePersistence`
//   serialises its own write chain per instance, so an import and a live
//   utterance cannot interleave into a lost update.
//
//   🔴 The composition root MUST pass the same instance (`storage.persistence`),
//   not a second one over the same file. Two instances would be two write
//   chains over one database, which is exactly the invariant the store's
//   sentence is protecting. There is no way to enforce that from here; it is
//   enforced by there being ONE production construction site (main.dart).
//
// Import happens on the settings screen with no capture in flight, so the
// practical overlap is nil — but 「it will not actually happen at the same
// time」 is not an invariant, and the ordering guarantee above is.

import '../timeline/timeline_entry.dart';
import '../timeline/timeline_persistence.dart';
import '../timeline/timeline_store.dart';
import 'portable_import.dart';

class TimelineImportSink implements ImportRowSink {
  const TimelineImportSink({
    required TimelinePersistence persistence,
    required TimelineStore store,
  }) : _persistence = persistence,
       _store = store;

  final TimelinePersistence _persistence;
  final TimelineStore _store;

  @override
  Future<Set<String>> existingRowIds() async {
    // `loadAll`, NOT the inventory's live-rows walk: a row the user deleted is
    // still 「already in the store」 for the purposes of §5.1 on any store that
    // keeps a tombstone, and re-adding it would be an import that undoes a
    // deletion.
    final List<TimelineEntry> rows = await _persistence.loadAll();
    return rows.map((TimelineEntry e) => e.id).toSet();
  }

  @override
  Future<void> insert(TimelineEntry entry) => _persistence.upsert(entry);

  @override
  Future<void> refresh() => _store.load();
}
