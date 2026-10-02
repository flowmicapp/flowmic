// Legacy replay has no operation ID. Mark only existing, unconfirmed results
// so a failed timeline write cannot trigger repeated billing in this process.
// Unlike the session cancel tombstone, this marker leaves siblings eligible
// and is included by PendingRecoveryStore._addLegacy for manual deletion.
part of 'retained_audio_store.dart';

// Shared by store instances for the process lifetime. A restart loses this
// fallback and can permit one more attempt if the marker never reached disk.
// NR-138: that 「one more」 is now bounded — [_markUnverified] says whether the
// marker reached disk, and the legacy leg counts a start whose marker did not
// as a failed one against the session's persisted five-start budget.
final Set<String> _unverifiedThisProcess = <String>{};

File _unverifiedFile(RetainedAudioStore store, int idx, String? session) =>
    File('${store._fileFor(idx, session: session).path}.unverified.tomb');

Future<bool> _isUnverified(
    RetainedAudioStore store, int idx, String? session) async {
  final File marker = _unverifiedFile(store, idx, session);
  return _unverifiedThisProcess.contains(marker.absolute.path) ||
      await marker.exists();
}

/// Returns whether the marker reached disk (NR-138).
Future<bool> _markUnverified(
  RetainedAudioStore store,
  int idx,
  String? session,
) async {
  final File marker = _unverifiedFile(store, idx, session);
  _unverifiedThisProcess.add(marker.absolute.path);
  try {
    await marker.writeAsString('settled_unverified\n', flush: true);
    return true;
  } on FileSystemException catch (e) {
    // The memory fallback still suppresses subsequent sweeps in this process.
    diag('audio.retained.unverified_marker_failed', <String, Object?>{
      'session': session,
      'segment': idx,
      'skipped_in_memory': true,
      'error': '$e',
    });
    return false;
  }
}

Future<void> _clearUnverified(
  RetainedAudioStore store,
  int idx,
  String? session,
) async {
  final File marker = _unverifiedFile(store, idx, session);
  if (await marker.exists()) await marker.delete();
  _unverifiedThisProcess.remove(marker.absolute.path);
}

Future<List<int>> _legacySegments(
  RetainedAudioStore store,
  String? session, {
  required bool includeUnverified,
}) async {
  final String want = RetainedAudioStore._sanitise(session ?? store._session);
  if ((await _readTombstones(store)).contains(want)) return const <int>[];
  final List<int> out = <int>[];
  for (final File f in await store._segmentFiles()) {
    if (store._sessionOf(f) != want) continue;
    final int? idx = store._indexOf(f);
    if (idx != null &&
        (includeUnverified ||
            !await _isUnverified(store, idx, want))) {
      out.add(idx);
    }
  }
  return out..sort();
}

Future<Set<int>> _unverifiedSegments(
  RetainedAudioStore store,
  String session,
) async {
  final Set<int> out = <int>{};
  for (final int idx in await _legacySegments(
    store,
    session,
    includeUnverified: true,
  )) {
    if (await _isUnverified(store, idx, session)) out.add(idx);
  }
  return out;
}
