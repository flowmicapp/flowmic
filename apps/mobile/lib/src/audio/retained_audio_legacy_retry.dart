// NR-138 ① — THE LEGACY FACE'S AUTOMATIC-ATTEMPT RECORD, a `part` of
// retained_audio_store.dart (same shape as the tombstone and unverified
// families next door: one-line delegates on the store, bodies here).
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, NR-138 correction (2026-10-01) ①
//   apps/mobile/lib/src/session/legacy_retry_budget.dart (the policy that reads
//     and writes this record; this file only stores it)
//
// WHY A FILE: the legacy face has no manifest, so it had nowhere to remember
// that an attempt happened — every sweep found the same bytes and tried again,
// and every attempt was billed. The record must survive the process, because a
// budget kept in memory turns 「at most five」 into 「five per launch, forever」
// (recovery_backoff.dart says the same about the journal).
//
// 🔴 THE FILE IS INVISIBLE TO EVERY EXISTING PARSER, like the cancel tombstone:
//   · `_indexOf` needs `seg-<n>.pcm` after the separator ⇒ not a segment, not
//     counted against the cap, not read, not dropped;
//   · `_readTombstones` needs exactly `cancelled.tomb` ⇒ not a tombstone;
//   · `_manifestFiles` and `RetainedAudioJournalScan` need `.manifest.json` or
//     `.pcm` ⇒ not a recording.
// `legacy_retry_budget_test.dart` pins that the file does not change what the
// store lists.
//
// 🔴 UNREADABLE IS NOT ABSENT. An absent file is a session no automatic
// attempt has touched. A file that is there and cannot be read or parsed is a
// session whose history we lost — and reading it as zero would reopen the
// unlimited loop this card closes. The policy blocks automatic sending on it.

part of 'retained_audio_store.dart';

/// Follows the session separator: `<session>__legacy-retry.json`.
const String _legacyRetrySuffix = 'legacy-retry.json';

/// The persisted record of one legacy session's automatic attempts.
@immutable
class LegacyRetryRecord {
  const LegacyRetryRecord({
    this.starts = 0,
    this.failedStarts = 0,
    this.nextEligibleAtMs,
    this.reservedAtMs,
    this.reservedBy,
    this.firstAutoStartAtMs,
    this.lastAutoStartAtMs,
    this.autoStoppedAtMs,
  });

  /// Nothing has been tried.
  static const LegacyRetryRecord fresh = LegacyRetryRecord();

  /// NR-138 round 2 (review B1) — EVERY automatic start that reached the
  /// relay, whatever it ended in. THIS is what the five-start cap counts.
  final int starts;

  /// Of [starts], the ones that ended without a conclusion. Only the waits
  /// between attempts (1, 2, 4, 8 minutes) are computed from this.
  final int failedStarts;

  /// Wall clock before which no automatic start may be made, or null.
  final int? nextEligibleAtMs;

  /// Set BEFORE `audio:start`, cleared when the attempt resolves. A record
  /// that still carries one when nobody owns it is an attempt whose ending
  /// was never written (a killed process).
  final int? reservedAtMs;

  /// Which runner wrote the reservation (an opaque token).
  final String? reservedBy;

  /// NR-138 round 2 (review B3) — wall clock of the FIRST automatic start
  /// that went out (written with its reservation, kept from then on). The
  /// six-day automatic window is measured from here
  /// (`session/legacy_retry_budget.dart` `kLegacyAutoWindow`).
  final int? firstAutoStartAtMs;

  /// Wall clock of the latest automatic start. A clock that now reads earlier
  /// than this went backwards, and the window is then read as closed.
  final int? lastAutoStartAtMs;

  /// NR-138 round 3 (review B4, MAIN decision) — wall clock of the moment this
  /// phone first OBSERVED the automatic route stopped for the session (budget
  /// spent or window closed) and wrote it down. Present ⇒ stopped, for good:
  /// no later clock value, restart or reconnect reopens the automatic route
  /// (`session/legacy_retry_budget.dart` `LegacyRetryStatus.stoppedAt`). The
  /// value itself is only evidence; its presence is the decision.
  final int? autoStoppedAtMs;

  static const int _version = 1;

  String encode() => jsonEncode(<String, Object?>{
        'v': _version,
        'starts': starts,
        'failed_starts': failedStarts,
        'next_eligible_at_ms': ?nextEligibleAtMs,
        'reserved_at_ms': ?reservedAtMs,
        'reserved_by': ?reservedBy,
        'first_auto_start_at_ms': ?firstAutoStartAtMs,
        'last_auto_start_at_ms': ?lastAutoStartAtMs,
        'auto_stopped_at_ms': ?autoStoppedAtMs,
      });

  /// Null for anything this build did not write: a newer version, a missing
  /// or negative count, a field of the wrong type.
  static LegacyRetryRecord? decode(String raw) {
    final Object? json;
    try {
      json = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    if (json is! Map<String, Object?> || json['v'] != _version) return null;
    final Object? started = json['starts'];
    final Object? failed = json['failed_starts'];
    final Object? next = json['next_eligible_at_ms'];
    final Object? at = json['reserved_at_ms'];
    final Object? by = json['reserved_by'];
    final Object? first = json['first_auto_start_at_ms'];
    final Object? last = json['last_auto_start_at_ms'];
    final Object? stopped = json['auto_stopped_at_ms'];
    if (started is! int || failed is! int || failed < 0) return null;
    // A stop marker this build cannot read is unreadable ⇒ the route stays
    // stopped (an unreadable record blocks it), never 「not stopped」.
    if (stopped != null && stopped is! int) return null;
    if (first != null && first is! int) return null;
    if (last != null && last is! int) return null;
    // More failures than starts is not a record this build wrote.
    if (started < failed) return null;
    if (next != null && next is! int) return null;
    if (at != null && at is! int) return null;
    if (by != null && by is! String) return null;
    return LegacyRetryRecord(
      starts: started,
      failedStarts: failed,
      nextEligibleAtMs: next as int?,
      reservedAtMs: at as int?,
      reservedBy: by as String?,
      firstAutoStartAtMs: first as int?,
      lastAutoStartAtMs: last as int?,
      autoStoppedAtMs: stopped as int?,
    );
  }

  @override
  String toString() => 'LegacyRetryRecord(starts=$starts failed=$failedStarts '
      'next=$nextEligibleAtMs reserved=$reservedAtMs/$reservedBy '
      'stopped=$autoStoppedAtMs)';
}

/// What reading a session's record found: a record (possibly
/// [LegacyRetryRecord.fresh] for an absent file), or nothing readable.
@immutable
class LegacyRetryRead {
  const LegacyRetryRead.ok(LegacyRetryRecord this.record);
  const LegacyRetryRead.unreadable() : record = null;

  final LegacyRetryRecord? record;
  bool get readable => record != null;
}

File _legacyRetryFile(RetainedAudioStore store, String session) =>
    File('${store._dir.path}${Platform.pathSeparator}'
        '${RetainedAudioStore._sanitise(session)}'
        '${RetainedAudioStore._sessionSep}$_legacyRetrySuffix');

Future<LegacyRetryRead> _readLegacyRetry(
    RetainedAudioStore store, String session) async {
  final File f = _legacyRetryFile(store, session);
  try {
    // The TYPE, not `exists()`: `File.exists` answers false for a directory
    // standing at this path, which would read a broken record as 「never
    // tried」.
    final FileSystemEntityType type = await FileSystemEntity.type(f.path);
    if (type == FileSystemEntityType.notFound) {
      return const LegacyRetryRead.ok(LegacyRetryRecord.fresh);
    }
    if (type != FileSystemEntityType.file) {
      throw FileSystemException('not a file ($type)', f.path);
    }
    final LegacyRetryRecord? r = LegacyRetryRecord.decode(await f.readAsString());
    if (r != null) return LegacyRetryRead.ok(r);
    diag('audio.retained.legacy_retry_unparseable',
        <String, Object?>{'session': session});
  } on Object catch (e) {
    diag('audio.retained.legacy_retry_unreadable', <String, Object?>{
      'session': session,
      'error': '$e',
    });
  }
  return const LegacyRetryRead.unreadable();
}

/// Temp file, flush, rename: a torn write leaves the previous record or the
/// temp file, never half of one. Returns false (and says so) on any failure.
Future<bool> _writeLegacyRetry(
    RetainedAudioStore store, String session, LegacyRetryRecord r) async {
  final File f = _legacyRetryFile(store, session);
  final File tmp = File('${f.path}.tmp');
  try {
    if (!await store._dir.exists()) await store._dir.create(recursive: true);
    await tmp.writeAsString(r.encode(), flush: true);
    await tmp.rename(f.path);
    return true;
  } on Object catch (e) {
    diag('audio.retained.legacy_retry_write_failed', <String, Object?>{
      'session': session,
      'error': '$e',
    });
    return false;
  }
}

/// The session has no audio left, so its record has nothing to describe.
Future<void> _clearLegacyRetry(RetainedAudioStore store, String session) async {
  final File f = _legacyRetryFile(store, session);
  for (final File x in <File>[f, File('${f.path}.tmp')]) {
    try {
      if (await x.exists()) await x.delete();
    } on Object catch (e) {
      // Harmless leftover: a record for a session with no segments is never
      // read (nothing lists the session), and session keys are not reused.
      diag('audio.retained.legacy_retry_clear_failed', <String, Object?>{
        'session': session,
        'error': '$e',
      });
    }
  }
}
