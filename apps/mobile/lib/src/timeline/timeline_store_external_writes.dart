// NR-146: import and cloud merge share the local write queue and notice.
// Regression: timeline_external_write_test.dart. Cloud decryption remains
// BlindStoreCloudSync._pull's keyring.open (e2e prefix isolation is tested by
// blind_store_prefix_isolation_test.dart); plaintext rows enter only afterwards.
part of 'timeline_store.dart';

Future<T> _queueRecordOperation<T>(
  TimelineStore store,
  Future<T> Function() action,
) {
  final Future<void>? prior = store._writeTail;
  final Future<T> operation = prior == null
      ? Future<T>.sync(action)
      : prior.then((_) => action());
  // NR-146: only the scheduling tail recovers; callers keep the failing future
  // and surface it. An idle queue has no future tied to another async zone.
  final Future<void> tail = operation.then<void>(
    (_) {},
    onError: (Object _) {},
  );
  store._writeTail = tail;
  unawaited(
    tail.then((_) {
      if (identical(store._writeTail, tail)) {
        store._writeTail = null;
        store._reapedWhileQueued.clear();
      }
    }),
  );
  return operation;
}

Future<T> _recordStorageOperation<T>(
  Future<T> Function() operation, {
  required bool classify,
}) async {
  try {
    return await operation();
  } on Object catch (e, stack) {
    if (!classify || e is TimelineRecordRejected) rethrow;
    Error.throwWithStackTrace(TimelineLocalStorageError(e), stack);
  }
}

Future<void> _writeRecord(
  TimelineStore store,
  TimelineEntry entry, {
  LocalRecordSource? source,
  bool preserveNewer = false,
  bool signalLocalWrite = true,
}) => _writeRecords(
  store,
  [entry],
  source: source,
  preserveNewer: preserveNewer,
  signalLocalWrite: signalLocalWrite,
);

Future<void> _writeRecords(
  TimelineStore store,
  List<TimelineEntry> entries, {
  LocalRecordSource? source,
  bool preserveNewer = false,
  bool signalLocalWrite = true,
  bool batch = false,
}) {
  return _queueRecordOperation(store, () async {
    int written = 0;
    Future<void> persist(
      TimelineEntry entry,
      Map<String, TimelineEntry>? index,
      Future<void> Function(TimelineEntry) write,
    ) async {
      if (source == null) {
        if (store._reapedWhileQueued.contains(entry.id)) return;
        // Only external callers can supply a new source_text for an existing id.
        // Local mutations use TimelineEntry.copyWith, which cannot change it.
        final TimelineEntry? existing = index == null
            ? await _recordStorageOperation(
                () => store._persistence.loadById(entry.id),
                classify: preserveNewer,
              )
            : index[entry.id];
        if (existing != null && existing.sourceText != entry.sourceText) {
          throw TimelineRecordRejected();
        }
        if (preserveNewer &&
            existing != null &&
            existing.updatedAt.isAfter(entry.updatedAt)) {
          return;
        }
        if (existing?.deleted == true && !entry.deleted) return;
        await _recordStorageOperation(
          () => write(entry),
          classify: preserveNewer,
        );
        index?[entry.id] = entry;
        store._reapedWhileQueued.remove(entry.id);
      } else {
        // NR-146: a mutation queued behind a successful reap must not recreate
        // its removed row. Regression: timeline_external_write_test.dart.
        // Page reload can also remove a row from the loaded view; it must not
        // cancel persistence. Both edges: timeline_external_write_test.dart.
        if (store._reapedWhileQueued.contains(entry.id)) return;
        await store._persistence.saveLocalRecord(entry, source: source);
      }
      written++;
    }

    if (batch) {
      await _recordStorageOperation(
        () => store._persistence.withRecordBatch((index, write) async {
          for (final entry in entries) {
            await persist(entry, index, write);
          }
        }),
        classify: preserveNewer,
      );
    } else {
      for (final entry in entries) {
        await persist(entry, null, store._persistence.upsert);
      }
    }
    if (signalLocalWrite && written > 0) store.successfulLocalWrites.value += written;
  });
}

Future<ReapResult> _reapRecords(
  TimelineStore store,
  List<TimelineEntry> rows, {
  ClearKind? advance,
  bool queueCloudTombstones = true,
}) => _queueRecordOperation(store, () async {
  final ReapResult result = await store._reaper.reap(
    rows,
    advance: advance,
    queueCloudTombstones: queueCloudTombstones,
  );
  final Set<String> ids = rows.map((TimelineEntry e) => e.id).toSet();
  store._reapedWhileQueued.addAll(ids);
  store._dropRows(ids);
  return result;
});

Future<void> _saveExternalRecord(
  TimelineStore store,
  TimelineEntry entry, {
  bool recovery = false,
  bool notifyFailure = true,
}) => _saveExternalRecords(
  store,
  [entry],
  recovery: recovery,
  notifyFailure: notifyFailure,
);

Future<void> _saveExternalRecords(
  TimelineStore store,
  List<TimelineEntry> entries, {
  bool recovery = false,
  bool notifyFailure = true,
  bool batch = false,
}) async {
  final failures = recovery ? store.recoveryFailures : store.writeFailures;
  try {
    await _writeRecords(
      store,
      entries,
      preserveNewer: recovery,
      signalLocalWrite: !recovery,
      batch: batch,
    );
    for (final entry in entries) {
      if (!recovery || notifyFailure) failures.saved(entry.id);
    }
    if (recovery && failures.entryIds.isEmpty) failures.dismissNotice();
  } on Object catch (e) {
    for (final entry in entries) {
      if (recovery) {
        if (notifyFailure) {
          failures.recordPersistent(entry.id);
        } else {
          failures.remember(entry.id);
        }
      } else {
        failures.record(entry.id);
      }
      diag('timeline.persist_failed', <String, Object?>{
        'entry_id': entry.id,
        'source': 'external',
        'error': e is TimelineLocalStorageError
            ? e.cause.runtimeType
            : e.runtimeType,
      });
    }
    rethrow; // Import/sync must not advance their success/cursor on a failed save.
  }
}

Future<void> _applyRemoteTombstone(
  TimelineStore store,
  TimelineEntry entry,
) async {
  diag('timeline.tombstone_apply.request', <String, Object?>{
    'entry_id': entry.id,
  });
  try {
    await _reapRecords(store, <TimelineEntry>[
      entry,
    ], queueCloudTombstones: false);
    diag('timeline.tombstone_apply.confirmed', <String, Object?>{
      'entry_id': entry.id,
    });
  } on Object {
    store.deleteFailures.record(entry.id);
    rethrow;
  }
}
