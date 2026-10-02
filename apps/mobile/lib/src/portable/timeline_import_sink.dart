// The production [ImportRowSink].
//
// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5.1 (idempotent, dedup by id)
//
// NR-146: writes go through TimelineStore.saveExternalRecord, which shares
// _writeRecord with local writes. Pinned by timeline_external_write_test.dart.

import '../timeline/timeline_entry.dart';
import '../timeline/timeline_persistence.dart';
import '../timeline/timeline_store.dart';
import 'portable_import.dart';

class TimelineImportSink implements ImportRowSink, ImportBatchSink {
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
  Future<void> insert(TimelineEntry entry) => _store.saveExternalRecord(entry);

  @override
  Future<void> insertBatch(List<TimelineEntry> entries) => _store.saveExternalRecords(entries);

  @override
  Future<void> refresh() => _store.load();
}
