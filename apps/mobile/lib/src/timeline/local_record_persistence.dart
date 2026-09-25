// SPEC-REF: Task C plan §9.1. A local birth is not a generic database upsert.
// Import and cloud merge continue calling upsert and never enter this API.
import 'timeline_entry.dart';
import 'timeline_persistence.dart';

enum LocalRecordSource { birthReady, birthAwaitingContent, contentReady, edit }

abstract interface class LocalRecordPersistence {
  Future<void> saveLocalRecord(TimelineEntry entry, {required LocalRecordSource source});
  Future<void> forgetSubmissionRecords(Iterable<String> entryIds);
}

extension LocalRecordSave on TimelinePersistence {
  Future<void> saveLocalRecord(TimelineEntry entry, {required LocalRecordSource source}) {
    final TimelinePersistence store = this;
    if (store is LocalRecordPersistence) {
      return (store as LocalRecordPersistence).saveLocalRecord(entry, source: source);
    }
    // The actual shared-preferences fallback still saves local records. It has
    // no durable MCP tables and the composition root reports MCP unavailable.
    // This is a real save, not a default recorder pretending to register.
    return upsert(entry);
  }
}
