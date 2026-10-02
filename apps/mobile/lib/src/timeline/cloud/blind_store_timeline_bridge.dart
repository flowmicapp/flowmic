// E-CL — the timeline side of the blind store, and the pull cursor.
//
// SPEC-REF: docs/archive/strategy/2026-08-08-design-e-blindstore-client.md §3.1
//   (only upload the phone's own light records), §3.2 (merge is idempotent by id).
//
// NR-146: writes go through TimelineStore.saveExternalRecord, sharing local
// failure notices and source_text checks; timeline_external_write_test.dart.
// Reload stays once per sync. Cloud envelope validation remains keyring.open
// in blind_store_cloud_sync.dart, before upsertFromCloud.
//
// 🔴 DELETION STILL GOES THROUGH THE ONE DELETER. timeline_reaper.dart's header
// says every row's disappearance passes through `TimelineReaper.reap`, and
// applying a remote tombstone is a row disappearing. It is routed there — with
// `queueCloudTombstones: false`, because a row deleted BECAUSE the cloud said so
// must not turn around and ask the cloud to delete it again.

import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../../diag/diag_log.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'blind_store_cloud_client.dart';

import '../timeline_entry.dart';
import '../timeline_persistence.dart';
import '../timeline_reaper.dart';
import '../timeline_row_stores.dart' show cloudRetryBinding, kCloudRetryAttribution;
import '../timeline_store.dart';
import '../timeline_write_gate.dart';

part 'blind_store_retry_schedule.dart';

enum BlindStoreRetryFailure { other, localStorage, unreadable }

/// `TimelineEntry.origin` for a record the phone authored for itself rather than
/// for a PC.
///
/// ⚠️ A mirror of a bare string literal, and worth naming as such: the two
/// producers spell it inline — `chat_utterance_settle.dart`
/// (`origin: c.destination.isFixed ? 'cloud' : 'paired'`) and
/// `image_send_controller.dart` (`origin: 'cloud'`). Both are in another lane's
/// territory this wave, so this card mirrors rather than extracts. If that
/// spelling ever changes, `blind_store_timeline_bridge_test.dart` fails — it
/// asserts against an entry built by the real `TimelineStore.buildFromUtterance`
/// with a fixed destination, not against this constant.
const String kBlindStoreCloudOrigin = 'cloud';

/// Is this row a light record the product still has anything to say about?
///
/// REQ-12-09 09-A — the predicate lives here, beside the constant, and is SHARED
/// with `LightRecordQuery` (light_record_query.dart) rather than copied into it.
/// 「what counts as a light record」 must have exactly one answer, or the panel that lists them
/// and the sync that uploads them can disagree about the same row.
///
/// The [TimelineEntry.deleted] half is not decoration. That flag means the row
/// is gone as far as the product is concerned, so including it would upload
/// something the user deleted (sync) and list something the user deleted (panel)
/// — the same mistake wearing two faces.
bool isLightRecord(TimelineEntry e) =>
    e.origin == kBlindStoreCloudOrigin && !e.deleted;

/// The slice of the timeline the blind store owns, plus the ability to write
/// back what other devices wrote.
class BlindStoreTimelineBridge {
  BlindStoreTimelineBridge({
    required TimelinePersistence persistence,
    required TimelineReaper reaper,
    required TimelineStore store,
    required Future<void> Function() reload,
  }) : _persistence = persistence,
       _store = store,
       _reload = reload;

  final TimelinePersistence _persistence;
  final TimelineStore _store;
  final Future<void> Function() _reload;

  /// Every phone-authored light record currently on this device.
  ///
  /// A full scan and a filter in Dart, deliberately: the same argument
  /// `timeline_sqlite.dart` makes for `LIKE` over FTS5 — at private-domain scale
  /// this is a few thousand rows and milliseconds, and a projected `origin`
  /// column would be a schema change (and a second place the value lives) bought
  /// for nothing measurable.
  ///
  /// Rows already marked [TimelineEntry.deleted] are excluded: that flag means
  /// the row is gone as far as the product is concerned, and pushing it would
  /// upload something the user deleted.
  ///
  /// The membership test itself moved to [isLightRecord] (REQ-12-09 09-A) so the
  /// 「+」 panel reads rows by the same rule this sync uploads them by. Behaviour
  /// here is unchanged — same two clauses, same order.
  Future<List<TimelineEntry>> lightRecords() async {
    final List<TimelineEntry> all = await _persistence.loadAll();
    return <TimelineEntry>[
      for (final TimelineEntry e in all)
        if (isLightRecord(e)) e,
    ];
  }

  /// Write a record another device authored (or a newer version of one of ours).
  Future<void> upsertFromCloud(TimelineEntry entry, {bool notifyFailure = true}) =>
      _store.saveExternalRecord(entry, recovery: true, notifyFailure: notifyFailure);

  Future<void> upsertBatchFromCloud(List<TimelineEntry> entries) =>
      _store.saveExternalRecords(entries, recovery: true, notifyFailure: false);

  /// Apply a tombstone another device raised.
  ///
  /// Routed through the reaper so the row's picture bytes and its side-table
  /// entry go with it — doc 16 §6.2-2「deleting a row = deleting all its
  /// bytes」 does not stop
  /// applying because the instruction arrived over a wire.
  Future<void> applyRemoteTombstone(TimelineEntry entry) =>
      _store.applyRemoteTombstone(entry);

  ValueListenable<int> get successfulLocalWrites => _store.successfulLocalWrites;
  void recordUnreadableCloud(String account, String id) =>
      _store.recoveryFailures.recordCorruption('unreadable-cloud:$account', [id]);
  void recordMergeFailure(String id) => _store.recoveryFailures.recordPersistent(id);
  void recordRetryCorruption(String account, Iterable<String> ids) =>
      _store.recoveryFailures.recordCorruption('unreadable-retries:$account', ids);
  void resolveMergeFailure(String id, {String? account}) {
    _store.recoveryFailures.forgetDeletedEntries(<String>[id]);
    if (account != null) _store.recoveryFailures.resolveCorruption('unreadable-cloud:$account', id);
  }

  /// Refresh what the user is looking at, once per sync rather than per row.
  Future<void> reload() => _reload();
}

/// Where the `timeline:pull` cursor lives.
///
/// 🔴 KEYED BY ACCOUNT, and that is not tidiness. The cursor is a position in
/// ONE account's server-side seq sequence. Reusing another account's cursor
/// after a logout/login would start the pull above rows that were never read,
/// and those records would never be fetched again — an empty history that looks
/// like a working sync. Keying by account makes a switched account a fresh
/// cursor by construction rather than by someone remembering to reset it.
abstract interface class BlindStoreCursorStore {
  int read(String accountKey);

  Future<void> write(String accountKey, int seq);
  Future<List<BlindStoreRemoteBlob>> loadRetries(String accountKey);
  /// [decoded]: the row the envelope AUTHENTICATED and decoded to with the
  /// supported decoder, when it did (NR-137 round 10): its id and article are
  /// recorded, bound to this exact envelope (`cloudRetryBinding`).
  Future<void> saveRetry(String accountKey, BlindStoreRemoteBlob blob,
      {BlindStoreRetryFailure failure = BlindStoreRetryFailure.other,
      TimelineEntry? decoded});
  Future<void> removeRetry(String accountKey, String id);
  void resetBackoff({bool localStorageOnly = false});
  bool shouldRetry(String accountKey, BlindStoreRemoteBlob blob);
  bool retryWasNoticed(String accountKey, BlindStoreRemoteBlob blob);
  bool retryIsUnreadable(String accountKey, BlindStoreRemoteBlob blob);
}

class SharedPrefsBlindStoreCursorStore with TimelineReadIssues implements BlindStoreCursorStore {
  SharedPrefsBlindStoreCursorStore(this._prefs, {int Function()? nowMs, this.appVersion})
      : _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch) {
    resetBackoff();
  }
  final int Function() _nowMs;

  final String? appVersion;
  final SharedPreferences _prefs;
  final Set<String> _resetKeys = {};
  @override
  void resetBackoff({bool localStorageOnly = false}) {
    for (final key in _prefs.getKeys().where((key) => key.startsWith('${kPrefix}retry.'))) {
      try {
        final value = (jsonDecode(_prefs.getString(key)!) as Map).cast<String, Object?>();
        final failure = _RetrySchedule.fromJson(value).failure;
        if (failure == BlindStoreRetryFailure.unreadable) continue;
        if (!localStorageOnly || failure == BlindStoreRetryFailure.localStorage) _resetKeys.add(key);
      } on Object { /* Preserve corrupt retry bytes and their schedule. */ }
    }
  }

  static const String kPrefix = 'flowmic.timeline.cloud.cursor.v1.';

  String _retryPrefix(String account) => '${kPrefix}retry.${Uri.encodeComponent(account)}.';
  String _retryKey(String account, String id) => '${_retryPrefix(account)}${Uri.encodeComponent(id)}';

  @override
  Future<List<BlindStoreRemoteBlob>> loadRetries(String accountKey) async {
    final List<BlindStoreRemoteBlob> rows = [];
    final Set<String> unreadable = {};
    for (final String key in _prefs.getKeys().where((k) => k.startsWith(_retryPrefix(accountKey)))) {
      try {
        final Object? raw = _prefs.get(key);
        if (raw is! String) throw const FormatException();
        final blob = _retryBlob((jsonDecode(raw) as Map).cast<String, Object?>());
        if (_retryKey(accountKey, blob.id) != key) throw const FormatException();
        _RetrySchedule.fromJson((jsonDecode(raw) as Map).cast<String, Object?>());
        rows.add(blob);
      } on Object { unreadable.add(Uri.decodeComponent(key.substring(_retryPrefix(accountKey).length))); }
    }
    reportUnreadableRows(unreadable);
    if (unreadable.isNotEmpty) {
      diag('blindstore.unreadable_retries', <String, Object?>{'rows': unreadable.length});
    }
    return rows;
  }

  /// NR-137 round 10b: a retry record can make a row residue, so it is
  /// written under the timeline write gate (timeline_write_gate.dart).
  @override
  Future<void> saveRetry(String accountKey, BlindStoreRemoteBlob blob,
          {BlindStoreRetryFailure failure = BlindStoreRetryFailure.other,
          TimelineEntry? decoded}) =>
      TimelineWriteGate.timeline
          .run(() => _saveRetry(accountKey, blob, failure, decoded));

  Future<void> _saveRetry(String accountKey, BlindStoreRemoteBlob blob,
      BlindStoreRetryFailure failure, TimelineEntry? decoded) async {
    final String key = _retryKey(accountKey, blob.id);
    final schedule = _schedule(accountKey, blob).afterFailure(_nowMs(), failure);
    final String value = jsonEncode({..._retryJson(blob), ...schedule.toJson(), 'retry_app_version': appVersion,
      // NR-137 round 10 (review r9 B2) — what the merge positively learned,
      // bound to this envelope; rewritten (or dropped) with every save.
      if (decoded != null && decoded.id == blob.id && !blob.deleted)
        kCloudRetryAttribution: <String, Object?>{
          'v': 1,
          'id': decoded.id,
          'binding': cloudRetryBinding(account: accountKey, id: blob.id, seq: blob.seq,
              schemaVer: blob.schemaVer, deleted: blob.deleted, ciphertext: blob.ciphertext),
          if (decoded.articleId != null) 'article': decoded.articleId else 'no_article': true,
        },
    });
    final bool saved = await _prefs.setString(key, value);
    await _prefs.reload();
    if (!saved || _prefs.getString(key) != value) throw StateError('cloud retry write refused');
    _resetKeys.remove(key);
  }

  _RetrySchedule _schedule(String account, BlindStoreRemoteBlob blob) {
    final Object? raw = _prefs.get(_retryKey(account, blob.id));
    if (raw == null) return const _RetrySchedule();
    final value = (jsonDecode(raw as String) as Map).cast<String, Object?>();
    final previous = _retryBlob(value);
    final schedule = _RetrySchedule.fromJson(value);
    if (value['retry_app_version'] != appVersion || previous.seq != blob.seq || previous.ciphertext != blob.ciphertext || previous.deleted != blob.deleted) {
      return const _RetrySchedule();
    }
    return schedule.failure != BlindStoreRetryFailure.unreadable && _resetKeys.contains(_retryKey(account, blob.id))
        ? const _RetrySchedule() : schedule;
  }

  @override
  bool retryIsUnreadable(String accountKey, BlindStoreRemoteBlob blob) {
    try { return _schedule(accountKey, blob).failure == BlindStoreRetryFailure.unreadable; }
    on Object { return true; }
  }

  @override
  bool shouldRetry(String accountKey, BlindStoreRemoteBlob blob) {
    try { return _schedule(accountKey, blob).ready(_nowMs()); }
    on Object { return false; } // Preserve an unreadable retry under this id.
  }

  @override
  bool retryWasNoticed(String accountKey, BlindStoreRemoteBlob blob) {
    try { return _schedule(accountKey, blob).noticed; }
    on Object { return true; }
  }

  @override
  Future<void> removeRetry(String accountKey, String id) =>
      TimelineWriteGate.timeline.run(() => _removeRetry(accountKey, id));

  Future<void> _removeRetry(String accountKey, String id) async {
    final String key = _retryKey(accountKey, id);
    if (!_prefs.containsKey(key)) return;
    final bool removed = await _prefs.remove(key);
    await _prefs.reload();
    if (!removed || _prefs.containsKey(key)) throw StateError('cloud retry delete refused');
  }

  @override
  int read(String accountKey) => _prefs.getInt('$kPrefix$accountKey') ?? 0;

  @override
  Future<void> write(String accountKey, int seq) async {
    final bool saved = await _prefs.setInt('$kPrefix$accountKey', seq);
    await _prefs.reload();
    if (!saved || _prefs.getInt('$kPrefix$accountKey') != seq) throw StateError('cloud cursor write refused');
  }
}

class InMemoryBlindStoreCursorStore implements BlindStoreCursorStore {
  InMemoryBlindStoreCursorStore({int Function()? nowMs})
      : _nowMs = nowMs ?? (() => DateTime.now().millisecondsSinceEpoch);
  final int Function() _nowMs;
  final Map<String, Map<String, _RetrySchedule>> _schedules = {};
  @override
  void resetBackoff({bool localStorageOnly = false}) {
    for (final schedules in _schedules.values) {
      schedules.removeWhere((id, schedule) => schedule.failure != BlindStoreRetryFailure.unreadable &&
          (!localStorageOnly || schedule.failure == BlindStoreRetryFailure.localStorage));
    }
  }
  _RetrySchedule _schedule(String account, BlindStoreRemoteBlob blob) {
    final previous = _retries[account]?[blob.id];
    return previous?.seq == blob.seq && previous?.ciphertext == blob.ciphertext && previous?.deleted == blob.deleted
        ? (_schedules[account]?[blob.id] ?? const _RetrySchedule()) : const _RetrySchedule();
  }
  @override
  bool retryIsUnreadable(String accountKey, BlindStoreRemoteBlob blob) {
    try { return _schedule(accountKey, blob).failure == BlindStoreRetryFailure.unreadable; }
    on Object { return true; }
  }

  @override
  bool shouldRetry(String accountKey, BlindStoreRemoteBlob blob) => _schedule(accountKey, blob).ready(_nowMs());
  @override
  bool retryWasNoticed(String accountKey, BlindStoreRemoteBlob blob) => _schedule(accountKey, blob).noticed;
  final Map<String, Map<String, BlindStoreRemoteBlob>> _retries = {};
  @override
  Future<List<BlindStoreRemoteBlob>> loadRetries(String accountKey) async =>
      _retries[accountKey]?.values.toList() ?? <BlindStoreRemoteBlob>[];
  @override
  Future<void> saveRetry(String accountKey, BlindStoreRemoteBlob blob,
      {BlindStoreRetryFailure failure = BlindStoreRetryFailure.other,
      TimelineEntry? decoded}) async {
    final schedule = _schedule(accountKey, blob).afterFailure(_nowMs(), failure);
    (_retries[accountKey] ??= {})[blob.id] = blob;
    (_schedules[accountKey] ??= {})[blob.id] = schedule;
  }
  @override
  Future<void> removeRetry(String accountKey, String id) async { _retries[accountKey]?.remove(id); _schedules[accountKey]?.remove(id); }

  final Map<String, int> _byAccount = <String, int>{};

  @override
  int read(String accountKey) => _byAccount[accountKey] ?? 0;

  @override
  Future<void> write(String accountKey, int seq) async {
    _byAccount[accountKey] = seq;
  }
}

Map<String, Object?> _retryJson(BlindStoreRemoteBlob b) => {
  'id': b.id, 'seq': b.seq, 'ciphertext': b.ciphertext,
  'created_at': b.createdAtMs, 'schema_ver': b.schemaVer, 'deleted': b.deleted,
};
BlindStoreRemoteBlob _retryBlob(Map<String, Object?> value) => BlindStoreRemoteBlob(
  id: value['id']! as String, seq: value['seq']! as int,
  ciphertext: value['ciphertext']! as String,
  createdAtMs: value['created_at']! as int, schemaVer: value['schema_ver']! as int,
  deleted: value['deleted']! as bool,
);
