// NR-137 round 10b — THE ROWS A LEGACY SESSION'S PRESSES WITHDREW, a `part` of
// retained_audio_store.dart (same shape as the legacy retry record next door).
//
// A legacy recording has no journal, so when a kept-words press withdrew its
// own rows (its answer did not land), nothing remembered which rows those were;
// a later press then released the session's audio on a claim that never named
// them, and one of them coming back (a cloud copy) went unseen. The ids are
// written here BEFORE the withdrawal runs, and every later release of the
// session re-proves them gone (`backfill_legacy_kept.dart`).
//
// 🔴 THE FILE IS INVISIBLE TO EVERY EXISTING PARSER, like the legacy retry
// record: not `seg-<n>.pcm`, not `cancelled.tomb`, not `.manifest.json`, not
// `.pcm`. 🔴 UNREADABLE IS NOT EMPTY: a file that is there and cannot be read
// answers null, and the caller refuses the release.

part of 'retained_audio_store.dart';

/// Follows the session separator: `<session>__withdrawn-rows.json`.
const String _withdrawnRowsSuffix = 'withdrawn-rows.json';

File _withdrawnRowsFile(RetainedAudioStore store, String session) =>
    File('${store._dir.path}${Platform.pathSeparator}'
        '${RetainedAudioStore._sanitise(session)}'
        '${RetainedAudioStore._sessionSep}$_withdrawnRowsSuffix');

/// 🔴 NR-160 (round-10 final review F-4) — IDS WHOSE RECORD DID NOT REACH
/// DISK. The record used to be written and its result dropped
/// (`backfill_legacy_kept.dart`): on a failed write the withdrawal still ran,
/// the file stayed absent, and the next release read `[]` and stood on a
/// claim that never named those rows. Now the ids are kept here, per store and
/// session, and every read writes them first ([_withdrawnRows]); while that
/// write fails the read answers null — the same answer as an unreadable file,
/// so the release is refused. ⚠️ Memory only: a process that dies before the
/// write lands loses them (the disk refused the one place they could go).
final Expando<Map<String, Set<String>>> _unrecordedWithdrawals =
    Expando<Map<String, Set<String>>>('unrecordedWithdrawals');

Map<String, Set<String>> _unrecordedOf(RetainedAudioStore store) =>
    _unrecordedWithdrawals[store] ??= <String, Set<String>>{};

/// The ids recorded for [session]; empty when none; null when unreadable, or
/// when ids withdrawn earlier still cannot be written (NR-160).
Future<List<String>?> _withdrawnRows(RetainedAudioStore store, String session) async {
  final Set<String>? unrecorded = _unrecordedOf(store)[session];
  if (unrecorded != null && unrecorded.isNotEmpty &&
      !await _recordWithdrawnRows(store, session, const <String>[])) {
    return null;
  }
  return _readWithdrawnRows(store, session);
}

Future<List<String>?> _readWithdrawnRows(
    RetainedAudioStore store, String session) async {
  final File f = _withdrawnRowsFile(store, session);
  try {
    final FileSystemEntityType type = await FileSystemEntity.type(f.path);
    if (type == FileSystemEntityType.notFound) return const <String>[];
    if (type != FileSystemEntityType.file) {
      throw FileSystemException('not a file ($type)', f.path);
    }
    final Object? json = jsonDecode(await f.readAsString());
    if (json is List && json.every((Object? x) => x is String)) {
      return json.cast<String>();
    }
  } on Object catch (e) {
    diag('audio.retained.withdrawn_rows_unreadable', <String, Object?>{
      'session': session,
      'error': '$e',
    });
    return null;
  }
  diag('audio.retained.withdrawn_rows_unparseable',
      <String, Object?>{'session': session});
  return null;
}

/// Add [ids] to [session]'s record: temp file, flush, rename. False (after a
/// diag line) when it did not reach disk — or when the existing record cannot
/// be read, because writing over it would forget what it held.
///
/// NR-160 — [ids] are remembered in memory BEFORE the write and forgotten only
/// once a write holding them has landed, so a failed write leaves them for the
/// next read to write first (and to refuse on).
Future<bool> _recordWithdrawnRows(
    RetainedAudioStore store, String session, Iterable<String> ids) async {
  final Set<String> unrecorded =
      (_unrecordedOf(store)[session] ??= <String>{})..addAll(ids);
  final Set<String> writing = Set<String>.of(unrecorded);
  final List<String>? earlier = await _readWithdrawnRows(store, session);
  if (earlier == null) return false;
  final File f = _withdrawnRowsFile(store, session);
  final File tmp = File('${f.path}.tmp');
  try {
    if (!await store._dir.exists()) await store._dir.create(recursive: true);
    await tmp.writeAsString(
        jsonEncode(<String>{...earlier, ...writing}.toList()),
        flush: true);
    await tmp.rename(f.path);
    unrecorded.removeAll(writing);
    return true;
  } on Object catch (e) {
    diag('audio.retained.withdrawn_rows_write_failed', <String, Object?>{
      'session': session,
      'error': '$e',
    });
    return false;
  }
}

/// The session has no audio left, so there is no release left to prove.
Future<void> _clearWithdrawnRows(RetainedAudioStore store, String session) async {
  _unrecordedOf(store).remove(session); // NR-160: nothing left to release
  final File f = _withdrawnRowsFile(store, session);
  for (final File x in <File>[f, File('${f.path}.tmp')]) {
    try {
      if (await x.exists()) await x.delete();
    } on Object catch (e) {
      diag('audio.retained.withdrawn_rows_clear_failed', <String, Object?>{
        'session': session,
        'error': '$e',
      });
    }
  }
}
