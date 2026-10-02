// NR-137 round 8 (review r7, BLOCKING D2) — EVERY PHYSICAL PLACE ON THIS
// DEVICE THAT CAN HOLD A TIMELINE ROW, AND WHAT EACH ONE IS TO A DECISION.
//
// Three review rounds each found one more place that hid an unreadable row
// from a removal proof: the SQLite decoder (round 5), the fallback's converted
// legacy array (round 6), everything the one-time import skipped (round 7).
// The cause was the same every time: each decision reader asked one store,
// and every other store had to be added to it by hand. This file is the list,
// and the readers iterate it.
//
// ⚠️ NR-137 round 9 (review r8, B2): the list missed a sixth store, the cloud
// retry records (`prefsCloudRetries`): pulled rows this build could not read,
// kept to be merged later. They were filed under the cursor's family as
// "cursors". Now every key under `flowmic.timeline.` is classified by
// [scanTimelinePrefs]; a key nothing here claims is reported as UNCLAIMED and
// the census treats it as an item that may be any row.
//
// 🔴 THE RULE. A decision that removes rows or releases audio stands on the
// ACTIVE store's census (`TimelineVerifiedReads`, decided only by
// `TimelineProof`). The census names every physical item, in every store
// below, that is not positively resolved. What an item is depends on which
// store is active ([TimelineStoreRole]):
//   · primary     — the active store's own rows; one that will not decode is
//                   a hole (round 6);
//   · residue     — rows of a store the active one does not own. Each item is
//                   a hole until it is resolved: imported (a receipt for exactly
//                   that row), superseded (a valid record for its id written by
//                   the active store after the item was recorded), or gone (its
//                   bytes are no longer there);
//   · archive     — the bytes of a row that a verified same-id record replaced:
//                   a recovery copy, never a row (`timeline_corrupt_archive.dart`);
//   · unreachable — a store this session cannot open: any id and any article
//                   may be in it.
//
// ADDING A STORE: add it here with a role on BOTH backends. Every switch over
// [TimelineRowStore] is exhaustive, so it does not compile until each reader
// says what the new store means; the registry test
// (nr137_row_store_registry_test.dart) plants an item in every store on both
// backends, and its source scan goes red on any table, key family, writer or
// row decoder that is neither a store here nor in [kTimelineNonRowSurfaces].

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'timeline_entry.dart';
import 'timeline_persistence.dart' show decodeTimelineRow;
import 'timeline_verified_reads.dart';

/// The fallback's legacy JSON array (one value holding every row).
const String kTimelineLegacyArrayKey = 'flowmic.timeline.entries.v1';

/// The fallback's row keys before `pending.v3` (one row per key).
const String kTimelineV2RowPrefix = 'flowmic.timeline.row.v2.';

/// The fallback's row keys (one row per key).
const String kTimelineV3RowPrefix = 'flowmic.timeline.pending.v3.';

/// The fallback's archive: `<prefix><id>.<sha256>`.
const String kTimelineCorruptPrefsPrefix = 'flowmic.timeline.corrupt.v1.';

/// The cloud pull cursors: `<prefix><account>`, an int each
/// (`SharedPrefsBlindStoreCursorStore.kPrefix`, blind_store_timeline_bridge.dart).
const String kTimelineCloudCursorPrefix = 'flowmic.timeline.cloud.cursor.v1.';

/// The cloud retry records under the cursor family:
/// `<prefix><account>.<row id>`, each a pulled row this build could not merge.
const String kTimelineCloudRetryPrefix = '${kTimelineCloudCursorPrefix}retry.';

/// NR-137 round 10 (review r9 B2) — the field of a cloud retry record that
/// carries what the merge positively learned about the row: written only
/// after the envelope AUTHENTICATED with the account key and the row-id
/// binding, and the supported payload decoder returned a complete row whose
/// id is the retry's. `{'v': 1, 'id', 'binding', 'article' | 'no_article'}`.
const String kCloudRetryAttribution = 'attr';

/// What a cloud retry's attribution is bound to: the account, the row id and
/// the exact envelope. A record whose envelope no longer matches its binding
/// has no attribution.
String cloudRetryBinding({
  required String account,
  required String id,
  required int seq,
  required int schemaVer,
  required bool deleted,
  required String ciphertext,
}) =>
    _digest(jsonEncode(<Object?>[
      'nr137-cloud-retry-attr-v1', account, id, seq, schemaVer, deleted, ciphertext,
    ]));

/// Set once the fallback copied the legacy array's readable rows to row keys.
const String kTimelineLegacyConvertedKey = 'flowmic.timeline.legacy_converted.v1';

/// Set once the one-time import into SQLite completed.
const String kTimelineMigratedKey = 'flowmic.timeline.migrated.sqlite.v1';

/// Every key under this prefix is classified by [scanTimelinePrefs].
const String kTimelinePrefsNamespace = 'flowmic.timeline.';

/// What one store's items are to a decision, given which store is active.
enum TimelineStoreRole { primary, residue, archive, unreachable }

/// Every place on the device that can physically hold a timeline row.
enum TimelineRowStore {
  /// SQLite `timeline_entries` (`timeline_sqlite.dart`).
  sqliteRows('sqlite:timeline_entries',
      onSqlite: TimelineStoreRole.primary,
      onFallback: TimelineStoreRole.unreachable),

  /// SQLite `timeline_corrupt_archive`. On the fallback the whole database
  /// file is out of reach, this table with it.
  sqliteCorruptArchive('sqlite:timeline_corrupt_archive',
      onSqlite: TimelineStoreRole.archive,
      onFallback: TimelineStoreRole.unreachable),

  /// [kTimelineLegacyArrayKey]. On the fallback it is the store until it is
  /// converted; then, and after migration, its readable entries are a
  /// rollback copy and its undecodable ones stay holes (round 7).
  prefsLegacyArray('prefs:$kTimelineLegacyArrayKey',
      onSqlite: TimelineStoreRole.residue,
      onFallback: TimelineStoreRole.primary),

  /// [kTimelineV2RowPrefix]. Frozen after migration: readable keys were
  /// imported, undecodable ones stay holes.
  prefsV2Rows('prefs:$kTimelineV2RowPrefix*',
      onSqlite: TimelineStoreRole.residue,
      onFallback: TimelineStoreRole.primary),

  /// [kTimelineV3RowPrefix] — what a session on the fallback writes, before
  /// or after a migration.
  prefsV3Rows('prefs:$kTimelineV3RowPrefix*',
      onSqlite: TimelineStoreRole.residue,
      onFallback: TimelineStoreRole.primary),

  /// [kTimelineCorruptPrefsPrefix].
  prefsCorruptArchive('prefs:$kTimelineCorruptPrefsPrefix*',
      onSqlite: TimelineStoreRole.archive,
      onFallback: TimelineStoreRole.archive),

  /// [kTimelineCloudRetryPrefix] — round 9 (review B2). A pulled row waiting to
  /// be merged can land later and become a row, so it is residue until its
  /// record is removed. A retry of a cloud DELETE carries no row and is not
  /// residue. ⚠️ Round 10 (review r9 B2): was "its article is never known
  /// here". Its article is known when the merge authenticated and fully
  /// decoded it and bound that to the envelope ([kCloudRetryAttribution]);
  /// a locked key, a failed authentication, an unsupported schema, a
  /// malformed record or a replaced envelope stays unknown. Decoding it is
  /// not importing it: it stays residue for its id either way.
  prefsCloudRetries('prefs:$kTimelineCloudRetryPrefix*',
      onSqlite: TimelineStoreRole.residue,
      onFallback: TimelineStoreRole.residue);

  const TimelineRowStore(this.surface,
      {required this.onSqlite, required this.onFallback});

  /// `sqlite:<table>` or `prefs:<key>` (`*` ends a key family).
  final String surface;
  final TimelineStoreRole onSqlite;
  final TimelineStoreRole onFallback;

  /// The SharedPreferences key (or key family prefix) this store lives under;
  /// null for a SQLite store.
  String? get prefsKey => switch (this) {
        TimelineRowStore.sqliteRows || TimelineRowStore.sqliteCorruptArchive => null,
        TimelineRowStore.prefsLegacyArray => kTimelineLegacyArrayKey,
        TimelineRowStore.prefsV2Rows => kTimelineV2RowPrefix,
        TimelineRowStore.prefsV3Rows => kTimelineV3RowPrefix,
        TimelineRowStore.prefsCorruptArchive => kTimelineCorruptPrefsPrefix,
        TimelineRowStore.prefsCloudRetries => kTimelineCloudRetryPrefix,
      };
}

/// Every other persisted structure that holds a row id or a row's content, or
/// lives beside the rows, and why it never holds a row the timeline could show
/// or bring back. The registry test requires every SQLite table, every
/// `flowmic.*` key family and every file writer in `lib/` to be here or a
/// [TimelineRowStore].
const Map<String, String> kTimelineNonRowSurfaces = <String, String>{
  'sqlite:timeline_fallback_import_receipts':
      'which fallback rows were imported: an id and a fingerprint',
  'sqlite:timeline_unresolved_rows':
      'which residue items existed when SQLite opened, and which were superseded',
  'sqlite:outbox_items': 'a send and the ids of the rows it settles; a settle '
      'never creates a row (timeline_store_inject_writeback.dart returns false '
      'for an id it cannot find)',
  'sqlite:instance_machine_map': 'which computer an instance id belonged to',
  'sqlite:timeline_cloud_state':
      'cloud ledger: entry id, state, payload hash; no row content',
  'sqlite:mcp_channels': 'MCP channel configuration',
  'sqlite:mcp_local_records': 'which entry ids are registered for MCP',
  'sqlite:mcp_submissions':
      'what was submitted to a channel; never decoded into a row',
  'sqlite:mcp_evictions': 'MCP eviction audit',
  'sqlite:mcp_maintenance': 'MCP maintenance flag',
  'sqlite:mcp_configuration_epochs': 'MCP configuration sequence',
  'prefs:$kTimelineMigratedKey': 'a marker (bool)',
  'prefs:$kTimelineLegacyConvertedKey': 'a marker (bool)',
  'prefs:flowmic.timeline.cutoffs.v1': 'reaper cutoffs',
  'prefs:flowmic.timeline.corruption_ack.v2.*': 'acknowledged notice ids (hashes)',
  'prefs:$kTimelineCloudCursorPrefix<account>':
      'a pull cursor, an int; any other value under this family is unclaimed',
  'prefs:flowmic.portable.carried_fields.v1':
      'unknown FPR fields keyed by row id; read only by export, never a row',
  'file:retained_audio':
      'recordings, manifests and journals: audio and row ids, no row content',
  'file:portable_export_*': 'export scratch: deleted in a finally, never read back',
  'file:portable_import_*': 'import scratch: deleted in a finally, never read back',
};

/// One physical item in a SharedPreferences row store.
class TimelineResidueItem {
  TimelineResidueItem._(this.store, this.key, this.locator, this.fingerprint,
      this.value, this.decoded,
      {this.keyId, this.keyMalformed = false, this.wholeArray = false});

  final TimelineRowStore store;
  final String key;

  /// Exactly where: the key, or `<key>#<digest>` for one array element.
  final String locator;

  /// sha256 of the stored bytes (an array element: of its JSON encoding).
  final String fingerprint;
  final Object? value;

  /// What the value decodes to as a timeline row, if it does.
  final TimelineEntry? decoded;

  /// The id the key names (row keys only), when it can be read.
  final String? keyId;

  /// The key's id part does not decode (round 9, review B3).
  final bool keyMalformed;

  /// The legacy key holds something that is not a JSON array.
  final bool wholeArray;

  /// A readable row filed under its own id; null for anything else
  /// (undecodable, filed under another id's key, or never a row: an archive
  /// or a cloud retry record).
  TimelineEntry? get row {
    final TimelineEntry? e = decoded;
    if (e == null) return null;
    switch (store) {
      case TimelineRowStore.prefsLegacyArray:
        return e;
      case TimelineRowStore.prefsV2Rows:
      case TimelineRowStore.prefsV3Rows:
        return !keyMalformed && key == '${store.prefsKey}${Uri.encodeComponent(e.id)}'
            ? e
            : null;
      case TimelineRowStore.prefsCorruptArchive:
      case TimelineRowStore.prefsCloudRetries:
      case TimelineRowStore.sqliteRows:
      case TimelineRowStore.sqliteCorruptArchive:
        return null;
    }
  }

  /// A cloud retry of a DELETE: a record that only ever removes a row. True
  /// only when its value says so and names the id its key ends with.
  bool get cloudDeleteRetry {
    if (store != TimelineRowStore.prefsCloudRetries) return false;
    final Map<Object?, Object?>? v = lenientTimelineMap(value);
    final Object? id = v?['id'];
    return v != null && v['deleted'] == true && id is String && id.isNotEmpty &&
        key.endsWith('.${Uri.encodeComponent(id)}');
  }

  /// What this item may be, from positive evidence only (round 9).
  UnreadableRow get hole {
    final TimelineEntry? e = row;
    if (e != null) return decodedRowAttribution(e);
    switch (store) {
      case TimelineRowStore.prefsCloudRetries:
        // The value names the row it was pulled for; the key must end with
        // that same id. Its article is known only through an attribution the
        // merge bound to this exact envelope (round 10, review r9 B2).
        final Map<Object?, Object?>? v = lenientTimelineMap(value);
        final Object? id = v?['id'];
        if (v == null || id is! String || id.isEmpty ||
            !key.endsWith('.${Uri.encodeComponent(id)}')) {
          return const UnreadableRow();
        }
        final ({bool known, String? articleId}) a = _retryArticle(v, id);
        return UnreadableRow(
            id: id, articleKnown: a.known, articleId: a.articleId);
      case TimelineRowStore.prefsLegacyArray:
        if (wholeArray) return const UnreadableRow();
        return unreadableRowOf(value);
      case TimelineRowStore.prefsV2Rows:
      case TimelineRowStore.prefsV3Rows:
        if (decoded != null) return const UnreadableRow(); // filed under another id
        return unreadableRowOf(value, id: keyId, keyMalformed: keyMalformed);
      case TimelineRowStore.prefsCorruptArchive:
      case TimelineRowStore.sqliteRows:
      case TimelineRowStore.sqliteCorruptArchive:
        return const UnreadableRow();
    }
  }

  /// The article a cloud retry record positively states, through its
  /// attribution — only when that attribution names this id and is bound to
  /// this account (from the key) and this envelope. Anything else: unknown.
  ({bool known, String? articleId}) _retryArticle(
      Map<Object?, Object?> v, String id) {
    const ({bool known, String? articleId}) unknown = (known: false, articleId: null);
    final String tail = '.${Uri.encodeComponent(id)}';
    if (!key.startsWith(kTimelineCloudRetryPrefix) || !key.endsWith(tail)) {
      return unknown;
    }
    final String accountPart =
        key.substring(kTimelineCloudRetryPrefix.length, key.length - tail.length);
    final Object? attr = v[kCloudRetryAttribution];
    final Object? seq = v['seq'];
    final Object? schema = v['schema_ver'];
    final Object? deleted = v['deleted'];
    final Object? ciphertext = v['ciphertext'];
    if (attr is! Map || attr['v'] != 1 || attr['id'] != id || seq is! int ||
        schema is! int || deleted is! bool || ciphertext is! String) {
      return unknown;
    }
    final String account;
    try {
      account = Uri.decodeComponent(accountPart);
    } on Object {
      return unknown;
    }
    if (attr['binding'] !=
        cloudRetryBinding(account: account, id: id, seq: seq, schemaVer: schema,
            deleted: deleted, ciphertext: ciphertext)) {
      return unknown;
    }
    final Object? article = attr['article'];
    final bool none = attr['no_article'] == true;
    if (none && !attr.containsKey('article')) return (known: true, articleId: null);
    if (!none && article is String && article.isNotEmpty) {
      return (known: true, articleId: article);
    }
    return unknown;
  }

  /// The id the fallback's unreadable-rows notice uses for it.
  String get reportId => wholeArray
      ? key
      : keyId ?? (keyMalformed
          ? key.substring((store.prefsKey ?? '').length)
          : 'legacy:$fingerprint');
}

/// Everything under [kTimelinePrefsNamespace]: the items of every row store,
/// and the keys nothing claims.
class TimelinePrefsScan {
  const TimelinePrefsScan(this.items, this.unclaimed);
  final List<TimelineResidueItem> items;
  final List<String> unclaimed;
}

String _digest(String s) => sha256.convert(utf8.encode(s)).toString();
String _bytesOf(Object v) => v is String ? v : jsonEncode(v);

/// Is [key] a registered non-row key, with the value that key is for?
bool _claimedNonRow(String key, Object? value) {
  if (key == kTimelineMigratedKey || key == kTimelineLegacyConvertedKey) {
    return value is bool;
  }
  if (key == 'flowmic.timeline.cutoffs.v1') return value is String;
  if (key.startsWith('flowmic.timeline.corruption_ack.v2.')) {
    return value is String || value is List;
  }
  // The cursor family holds ints. A retry record is claimed by its store
  // above; anything else under the cursor family is not a cursor.
  if (key.startsWith(kTimelineCloudCursorPrefix)) return value is int;
  return false;
}

/// The store whose key (or key family) [key] is, if any. The longest match
/// wins, so the retry records are never taken for cursors.
TimelineRowStore? _storeOfKey(String key) {
  TimelineRowStore? best;
  for (final TimelineRowStore s in TimelineRowStore.values) {
    final String? k = s.prefsKey;
    if (k == null) continue;
    final bool family = s.surface.endsWith('*');
    if (family ? key.startsWith(k) : key == k) {
      if (best == null || k.length > best.prefsKey!.length) best = s;
    }
  }
  return best;
}

/// The one enumeration of the SharedPreferences side, used by both backends'
/// census and by the SQLite import: the legacy array first, then every other
/// key in the platform's order (the fallback has always let the later of two
/// row keys win for a duplicated id on screen).
TimelinePrefsScan scanTimelinePrefs(SharedPreferences prefs) {
  final List<TimelineResidueItem> items = <TimelineResidueItem>[];
  final List<String> unclaimed = <String>[];
  items.addAll(_scanLegacyArray(prefs));
  for (final String key in prefs.getKeys().toList()) {
    if (!key.startsWith(kTimelinePrefsNamespace)) continue;
    final Object? value = prefs.get(key);
    final TimelineRowStore? store = _storeOfKey(key);
    if (store == null) {
      if (!_claimedNonRow(key, value)) unclaimed.add(key);
      continue;
    }
    switch (store) {
      case TimelineRowStore.prefsLegacyArray:
        break; // read first, above
      case TimelineRowStore.prefsV2Rows:
      case TimelineRowStore.prefsV3Rows:
        final String suffix = key.substring(store.prefsKey!.length);
        String? id;
        try {
          id = Uri.decodeComponent(suffix);
        } on Object {
          id = null;
        }
        items.add(TimelineResidueItem._(store, key, key,
            _digest(value == null ? '' : _bytesOf(value)), value,
            decodeTimelineRow(value),
            keyId: id, keyMalformed: id == null || id.isEmpty));
      case TimelineRowStore.prefsCorruptArchive:
      case TimelineRowStore.prefsCloudRetries:
        items.add(TimelineResidueItem._(store, key, key,
            _digest(value == null ? '' : _bytesOf(value)), value, null));
      case TimelineRowStore.sqliteRows:
      case TimelineRowStore.sqliteCorruptArchive:
        break; // never a SharedPreferences key
    }
  }
  return TimelinePrefsScan(items, unclaimed);
}

/// The row-store items only (the SQLite import's view).
List<TimelineResidueItem> scanTimelinePrefsResidue(SharedPreferences prefs) =>
    scanTimelinePrefs(prefs).items;

Iterable<TimelineResidueItem> _scanLegacyArray(SharedPreferences prefs) sync* {
  const String key = kTimelineLegacyArrayKey;
  final Object? legacy = prefs.get(key);
  if (legacy == null) return;
  Object? decoded;
  try {
    decoded = legacy is String ? jsonDecode(legacy) : null;
  } on Object {
    decoded = null;
  }
  if (decoded is! List) {
    yield TimelineResidueItem._(TimelineRowStore.prefsLegacyArray, key, key,
        _digest(_bytesOf(legacy)), legacy, null,
        wholeArray: true);
    return;
  }
  for (final Object? value in decoded) {
    final String digest = _digest(jsonEncode(value));
    yield TimelineResidueItem._(TimelineRowStore.prefsLegacyArray, key,
        '$key#$digest', digest, value, decodeTimelineRow(value));
  }
}
