// NR-137 rounds 8–9 — EVERY PLACE A ROW CAN LIVE IS IN THE REGISTRY, EVERY
// REGISTERED PLACE REACHES THE ONE PROOF, AND THE PROOF SAYS YES ONLY ON
// POSITIVE EVIDENCE.
//
// SPEC-REF:
//   lib/src/timeline/timeline_row_stores.dart (the registry and its roles)
//   lib/src/timeline/timeline_verified_reads.dart (`TimelineProof`, evidence)
//   lib/src/timeline/timeline_unresolved_rows.dart (residue on SQLite)
//
// Review r8 (`_dispatch/2026-10-02-nr137-r8-review.md.out`) found a sixth
// store (the cloud retry records) while the round-8 version of this file was
// green: its prefix check accepted the whole cursor family as "cursors", and
// its decoder check did not know the cloud decoder. So this file now checks:
//
//   1. PER STORE × ACTIVE BACKEND. One physical item, an undecodable copy of a
//      known row, is planted in each store; `TimelineProof` must answer as
//      the store's ROLE says. `_plant` is an exhaustive switch.
//   2. THE EVIDENCE RULES, one by one: what a missing, malformed or
//      conflicting source means (unknown), and that an unclaimed
//      `flowmic.timeline.*` key leaves the census unable to prove anything.
//   3. THE SOURCE TREE. Every SQLite table; every `flowmic.*` key and every
//      key family built by appending to a key constant; every file that
//      writes persistent state; every row decoder; every place a timeline
//      persistence is built — each must be registered, with a reason.
//
// REVERSE CONTROLS (2026-10-02, round-9 report §4): each evidence rule and
// the retry store's registration removed in turn ⇒ its rows red here.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_corrupt_archive.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_row_stores.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const String _article = 'art-registry';
const String _account = 'registry-account';

final TimelineEntry _x = TimelineEntry(
  id: 'loc_registry_x',
  clientId: 'registry-x',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: 'Registry probe row',
  outputText: 'Registry probe row',
  status: EntryStatus.noted,
  articleId: _article,
  articleOffsetMs: 0,
  durationMs: 1000,
  createdAt: DateTime.utc(2026, 9, 30),
  updatedAt: DateTime.utc(2026, 9, 30),
);

/// [_x] as a value the production decoder rejects; id and article intact.
Map<String, Object?> _undecodableMap() {
  final Map<String, Object?> bad = Map<String, Object?>.from(_x.toJson())
    ..['duration_ms'] = 'undecodable-duration';
  expect(decodeTimelineRow(bad), isNull, reason: 'decoder control');
  return bad;
}

String _undecodable() => jsonEncode(_undecodableMap());

String _retryKey(String id) => '$kTimelineCloudRetryPrefix'
    '${Uri.encodeComponent(_account)}.${Uri.encodeComponent(id)}';

String _retryValue(String id, {bool deleted = false}) => jsonEncode(<String, Object?>{
      'id': id, 'seq': 1, 'ciphertext': 'sealed-and-opaque', 'created_at': 0,
      'schema_ver': 9, 'deleted': deleted,
    });

enum _Backend { sqlite, fallback }

/// SQLite that will not open this session; whether its file exists is real.
class _UnopenableFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Env {
  _Env(this.prefs, this.dir);
  final SharedPreferences prefs;
  final Directory dir;
  String get path => '${dir.path}/timeline.db';

  Future<TimelineStorageOpen> openSqlite() async {
    final TimelineStorageOpen open = await openTimelinePersistence(
        prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(open.kind, TimelineStorageKind.sqlite);
    return open;
  }

  Future<void> raw(Future<void> Function(Database db) body) async {
    await ((await openSqlite()).persistence as SqfliteTimelinePersistence).close();
    final Database db = await databaseFactoryFfi.openDatabase(path);
    try {
      await body(db);
    } finally {
      await db.close();
    }
  }
}

Future<_Env> _env() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final Directory dir = await Directory.systemTemp.createTemp('nr137-r9-registry-');
  final _Env env = _Env(await SharedPreferences.getInstance(), dir);
  addTearDown(() async {
    await databaseFactoryFfi.deleteDatabase(env.path);
    try { await dir.delete(recursive: true); } on Object { /* best effort */ }
  });
  return env;
}

/// Put ONE physical item into [store] that is an undecodable copy of [_x].
/// Exhaustive: a store added to the registry does not compile here until it
/// has a fixture.
Future<void> _plant(TimelineRowStore store, _Env env) async {
  switch (store) {
    case TimelineRowStore.sqliteRows:
      await env.raw((Database db) async {
        await db.insert(kTimelineTable, <String, Object?>{
          'id': _x.id, 'created_at': 0, 'updated_at': 0,
          'client_id': _x.clientId, 'mode': 'realtime', 'status': 'noted',
          'entry_type': 'utterance', 'article_id': _article, 'deleted': 0,
          'search_text': '', 'payload': _undecodable(),
        });
      });
    case TimelineRowStore.sqliteCorruptArchive:
      // An archive copy whose owning row is no longer there.
      await env.raw((Database db) async {
        await db.execute(
            'CREATE TABLE IF NOT EXISTS $kTimelineCorruptArchiveTable ('
            'archive_id INTEGER PRIMARY KEY AUTOINCREMENT, row_id TEXT NOT NULL, '
            'payload BLOB NOT NULL, original_row TEXT NOT NULL)');
        await db.insert(kTimelineCorruptArchiveTable, <String, Object?>{
          'row_id': _x.id, 'payload': _undecodable(), 'original_row': '{}',
        });
      });
    case TimelineRowStore.prefsLegacyArray:
      await env.prefs.setString(
          kTimelineLegacyArrayKey, jsonEncode(<Object?>[_undecodableMap()]));
    case TimelineRowStore.prefsV2Rows:
      await env.prefs.setString(
          '$kTimelineV2RowPrefix${Uri.encodeComponent(_x.id)}', _undecodable());
    case TimelineRowStore.prefsV3Rows:
      await env.prefs.setString(
          '$kTimelineV3RowPrefix${Uri.encodeComponent(_x.id)}', _undecodable());
    case TimelineRowStore.prefsCorruptArchive:
      await env.prefs.setString(
          '$kTimelineCorruptPrefsPrefix${Uri.encodeComponent(_x.id)}.deadbeef',
          _undecodable());
    case TimelineRowStore.prefsCloudRetries:
      await env.prefs.setString(_retryKey(_x.id), _retryValue(_x.id));
  }
}

/// Stores whose planted item states no article (a cloud retry without an
/// attribution bound to its envelope).
const Set<TimelineRowStore> _articleSealed = <TimelineRowStore>{
  TimelineRowStore.prefsCloudRetries,
};

/// The store the app is running on, as `openTimelinePersistence` returns it.
Future<TimelinePersistence> _active(_Backend backend, _Env env) async {
  switch (backend) {
    case _Backend.sqlite:
      final SqfliteTimelinePersistence sql =
          (await env.openSqlite()).persistence as SqfliteTimelinePersistence;
      addTearDown(sql.close);
      return sql;
    case _Backend.fallback:
      final TimelineStorageOpen open = await openTimelinePersistence(
          prefs: env.prefs, factory: _UnopenableFactory(), path: env.path);
      expect(open.kind, TimelineStorageKind.sharedPrefsFallback);
      return open.persistence;
  }
}

/// Files under `lib/`, comment lines removed.
List<(String, String)> _sources() => <(String, String)>[
      for (final FileSystemEntity f in Directory('lib').listSync(recursive: true))
        if (f is File && f.path.endsWith('.dart') && !f.path.endsWith('.g.dart'))
          (
            f.path.replaceAll('\\', '/'),
            f.readAsStringSync().split('\n')
                .where((String l) => !l.trimLeft().startsWith('//'))
                .join('\n'),
          ),
    ];

/// Persisted structures that carry no row id and no row content, outside the
/// timeline registry, and why. Keys: `prefs:` (`*` ends a family),
/// `secure:`, `file:`.
const Map<String, String> _noRowSurfaces = <String, String>{
  'prefs:flowmic.pref.*': 'user settings',
  'prefs:flowmic.prefs.*': 'phone preferences and the backup of unknown keys',
  'prefs:flowmic.compose.*': 'send policy and favourite phrases, typed by the user',
  'prefs:flowmic.update.*': 'update checks',
  'prefs:flowmic.auth.*': 'a pending browser login',
  'prefs:flowmic.camera.*': 'permission asked',
  'prefs:flowmic.mic.*': 'permission asked',
  'prefs:flowmic.scenario.*': 'scenario card cache',
  'prefs:flowmic.cloud.*': 'cloud account',
  'prefs:flowmic.mobile.*': 'session and token',
  'prefs:flowmic.blindstore.*': 'blind store key material',
  'prefs:flowmic.blindstore.key.v2.*': 'blind store key material',
  'prefs:flowmic.mcp.secrets.v1.*': 'MCP channel secrets',
  'prefs:usage.*': 'local usage counters',
  'secure:blindstore-key': 'blind store key material',
  'secure:mcp-secrets': 'MCP channel secrets',
  'secure:cloud-account': 'the signed-in cloud account',
  'secure:sessions': 'pairing sessions and tokens',
  'file:outbox_blobs': 'queued picture bytes; a row is built at send time',
  'file:settings_backup': 'settings only',
  'file:update_download': 'the downloaded installer',
};

/// Every file in `lib/` that writes persistent state, and what it writes.
const Map<String, List<String>> _writers = <String, List<String>>{
  'lib/src/timeline/timeline_persistence.dart': <String>[
    'prefs:$kTimelineLegacyArrayKey', 'prefs:$kTimelineV2RowPrefix*',
    'prefs:$kTimelineV3RowPrefix*', 'prefs:$kTimelineCorruptPrefsPrefix*',
    'prefs:$kTimelineLegacyConvertedKey',
  ],
  'lib/src/timeline/timeline_fallback_import.dart': <String>[
    'sqlite:timeline_entries', 'sqlite:timeline_fallback_import_receipts',
    'prefs:$kTimelineMigratedKey',
  ],
  'lib/src/timeline/timeline_sqlite.dart': <String>['sqlite:timeline_entries'],
  'lib/src/timeline/timeline_sqlite_migrations.dart': <String>[
    'sqlite:timeline_entries', 'sqlite:outbox_items',
    'sqlite:instance_machine_map', 'sqlite:timeline_cloud_state',
  ],
  'lib/src/timeline/timeline_sqlite_schema.dart': <String>[
    'sqlite:timeline_entries', 'sqlite:outbox_items',
    'sqlite:instance_machine_map', 'sqlite:timeline_cloud_state',
  ],
  'lib/src/timeline/timeline_corrupt_archive.dart': <String>[
    'sqlite:timeline_corrupt_archive',
  ],
  'lib/src/timeline/timeline_fallback_receipts_schema.dart': <String>[
    'sqlite:timeline_fallback_import_receipts',
  ],
  'lib/src/timeline/timeline_unresolved_rows.dart': <String>[
    'sqlite:timeline_unresolved_rows',
  ],
  'lib/src/timeline/cloud/blind_store_timeline_bridge.dart': <String>[
    'prefs:$kTimelineCloudCursorPrefix<account>',
    'prefs:$kTimelineCloudRetryPrefix*',
  ],
  'lib/src/timeline/cloud/blind_store_cloud_state.dart': <String>[
    'sqlite:timeline_cloud_state',
  ],
  'lib/src/timeline/cloud/blind_store_secure_key_store.dart': <String>[
    'secure:blindstore-key',
  ],
  'lib/src/timeline/timeline_reaper.dart': <String>['prefs:flowmic.timeline.cutoffs.v1'],
  'lib/src/timeline/timeline_recovery_failures.dart': <String>[
    'prefs:flowmic.timeline.corruption_ack.v2.*',
  ],
  'lib/src/session/outbox_store.dart': <String>['sqlite:outbox_items'],
  'lib/src/session/instance_machine_map.dart': <String>['sqlite:instance_machine_map'],
  'lib/src/session/outbox_blob_store.dart': <String>['file:outbox_blobs'],
  'lib/src/session/usage_counters.dart': <String>['prefs:usage.*'],
  'lib/src/mcp/mcp_schema.dart': <String>['sqlite:mcp_channels'],
  'lib/src/mcp/mcp_settings_backup.dart': <String>['sqlite:mcp_channels'],
  'lib/src/mcp/mcp_store.dart': <String>[
    'sqlite:mcp_local_records', 'sqlite:mcp_submissions',
  ],
  'lib/src/mcp/mcp_submission_store.dart': <String>['sqlite:mcp_submissions'],
  'lib/src/mcp/mcp_secrets.dart': <String>['secure:mcp-secrets'],
  'lib/src/portable/unknown_field_vault.dart': <String>[
    'prefs:flowmic.portable.carried_fields.v1',
  ],
  'lib/src/portable/portable_export.dart': <String>['file:portable_export_*'],
  'lib/src/portable/settings_backup.dart': <String>[
    'prefs:flowmic.prefs.*', 'file:settings_backup',
  ],
  'lib/src/audio/retained_audio_journal.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_journal_fs.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_journal_scan.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_legacy_retry.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_manifest_retry.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_store.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_tombstone.dart': <String>['file:retained_audio'],
  'lib/src/audio/retained_audio_unverified.dart': <String>['file:retained_audio'],
  // Round 10b: a legacy session's record of the rows it withdrew (ids only).
  'lib/src/audio/retained_audio_withdrawn.dart': <String>['file:retained_audio'],
  'lib/src/auth/deep_link_source.dart': <String>['prefs:flowmic.auth.*'],
  'lib/src/auth/account_store.dart': <String>['secure:cloud-account'],
  'lib/src/auth/token_storage.dart': <String>['secure:sessions'],
  'lib/src/permission/os_permission.dart': <String>[
    'prefs:flowmic.camera.*', 'prefs:flowmic.mic.*',
  ],
  'lib/src/settings/app_settings.dart': <String>['prefs:flowmic.pref.*'],
  'lib/src/settings/local_prefs.dart': <String>[
    'prefs:flowmic.compose.*', 'prefs:flowmic.pref.*',
  ],
  'lib/src/settings/prefs_controller.dart': <String>['prefs:flowmic.prefs.*'],
  'lib/src/settings/scenario_card_controller.dart': <String>['prefs:flowmic.scenario.*'],
  'lib/src/update/update_prefs.dart': <String>['prefs:flowmic.update.*'],
  'lib/src/update/update_download.dart': <String>['file:update_download'],
};

/// Files that turn stored or received bytes into a timeline row, and why.
const Map<String, String> _decoders = <String, String>{
  'lib/src/timeline/timeline_persistence.dart': 'fallback store + shared decoder',
  'lib/src/timeline/timeline_row_stores.dart': 'the scan of the prefs stores',
  'lib/src/timeline/timeline_sqlite.dart': 'the SQLite store',
  'lib/src/timeline/timeline_fallback_import.dart': 'prefs stores → SQLite',
  'lib/src/timeline/timeline_corrupt_archive.dart': 'is this value unreadable',
  'lib/src/mcp/mcp_service.dart': 'reads one sqlite:timeline_entries row',
  'lib/src/portable/portable_import.dart':
      'a file the user picked; rows land through upsert',
  'lib/src/timeline/cloud/blind_store_payload.dart': 'the cloud payload codec',
  'lib/src/timeline/cloud/blind_store_cloud_sync.dart':
      'pulled pages, and the registered cloud retry store',
};

void main() {
  setUpAll(sqfliteFfiInit);

  group('every registered store reaches the one proof', () {
    for (final TimelineRowStore store in TimelineRowStore.values) {
      for (final _Backend backend in _Backend.values) {
        final TimelineStoreRole role =
            backend == _Backend.sqlite ? store.onSqlite : store.onFallback;
        test('${store.name} on ${backend.name} (${role.name})', () async {
          final _Env env = await _env();
          await _plant(store, env);
          final TimelinePersistence active = await _active(backend, env);
          final TimelineInventory inv = await active.inventory();
          final TimelineProof proof =
              await TimelineProof.take(active, ids: <String>[_x.id]);

          switch (role) {
            case TimelineStoreRole.primary:
            case TimelineStoreRole.residue:
              expect(inv.unread, isEmpty, reason: 'control: every store read');
              expect(inv.unreadable.any((UnreadableRow u) => u.mayBe(_x.id)), isTrue);
              expect(inv.mayOmitMemberOf(_article), isTrue);
              expect(inv.mayOmitMemberOf('another-article'),
                  _articleSealed.contains(store),
                  reason: 'attributed only as far as the item states');
              expect(proof.absent(_x.id), isFalse,
                  reason: 'never proven absent while its bytes are there');
              expect(proof.lookup(_x.id).state, StoredRowState.unreadable);
              expect(proof.members(_article), isNull);
            case TimelineStoreRole.unreachable:
              expect(inv.unread, contains(store),
                  reason: 'a store that cannot be opened may hold anything');
              expect(proof.complete, isFalse);
              expect(proof.absent(_x.id), isFalse);
              expect(proof.members('another-article'), isNull);
            case TimelineStoreRole.archive:
              expect(inv.complete, isTrue, reason: 'a recovery copy is never a row');
              expect(proof.absent(_x.id), isTrue);
              expect(proof.members(_article), isEmpty);
          }
        });
      }
    }
  });

  group('evidence counts only when it is stated and agreed', () {
    test('ids: one stated id, or unknown', () {
      expect(agreedRowId(keyId: 'a'), 'a');
      expect(agreedRowId(payload: <String, Object?>{'id': 'a'}), 'a');
      expect(agreedRowId(keyId: 'a', payload: <String, Object?>{'id': 'a'}), 'a');
      expect(agreedRowId(keyId: 'a', payload: <String, Object?>{'id': 'b'}), isNull,
          reason: 'conflicting');
      expect(agreedRowId(keyMalformed: true, payload: <String, Object?>{'id': 'a'}),
          isNull, reason: 'a malformed key is not silence (review B3)');
      expect(agreedRowId(keyId: 'a', payload: <String, Object?>{'id': 7}), isNull,
          reason: 'malformed payload id');
      expect(agreedRowId(keyId: 'a', payload: <String, Object?>{'id': null}), isNull);
      expect(agreedRowId(), isNull, reason: 'nothing stated');
    });

    test('articles: one stated article, or unknown (review B1)', () {
      expect(agreedArticle(<Object?>[]).known, isFalse);
      expect(agreedArticle(<Object?>[null]).known, isFalse,
          reason: 'a missing article_id is not "no article"');
      expect(agreedArticle(<Object?>['']).known, isFalse);
      expect(agreedArticle(<Object?>[42]).known, isFalse);
      expect(agreedArticle(<Object?>['a']), (known: true, articleId: 'a'));
      expect(agreedArticle(<Object?>['a', null]), (known: true, articleId: 'a'));
      expect(agreedArticle(<Object?>['a', 'b']).known, isFalse, reason: 'conflicting');
      expect(unreadableRowOf(jsonEncode(<String, Object?>{'id': 'x'}),
              id: 'x').articleKnown, isFalse);
    });

    for (final _Backend backend in _Backend.values) {
      test('${backend.name}: a cloud DELETE retry carries no row', () async {
        final _Env env = await _env();
        await env.prefs.setString(_retryKey(_x.id), _retryValue(_x.id, deleted: true));
        final TimelineInventory inv = await (await _active(backend, env)).inventory();
        expect(inv.complete, isTrue);
      });

      test('${backend.name}: a retry whose value names another id is unknown',
          () async {
        final _Env env = await _env();
        await env.prefs.setString(_retryKey(_x.id), _retryValue('loc_someone_else'));
        final TimelineInventory inv = await (await _active(backend, env)).inventory();
        expect(inv.unreadable.single.id, isNull);
      });

      test('${backend.name}: an unclaimed flowmic.timeline key proves nothing',
          () async {
        final _Env env = await _env();
        await env.prefs.setString('flowmic.timeline.shadow.v1', '{}');
        // Under the cursor family, but not a cursor (not an int).
        await env.prefs.setString('${kTimelineCloudCursorPrefix}staged', '[]');
        final TimelinePersistence active = await _active(backend, env);
        final TimelineProof proof =
            await TimelineProof.take(active, ids: <String>[_x.id]);
        expect((await active.inventory()).unreadable, hasLength(2));
        expect(proof.absent(_x.id), isFalse);
        expect(proof.members(_article), isNull);
      });

      test('${backend.name}: a cursor (an int) is claimed and harmless', () async {
        final _Env env = await _env();
        await env.prefs.setInt('$kTimelineCloudCursorPrefix$_account', 7);
        final TimelinePersistence active = await _active(backend, env);
        expect((await active.inventory()).complete, isTrue);
        expect((await TimelineProof.take(active, ids: <String>[_x.id])).absent(_x.id),
            isTrue);
      });
    }

    test('fallback: two different readable copies of one id are a conflict',
        () async {
      final _Env env = await _env();
      await env.prefs.setString('$kTimelineV2RowPrefix${Uri.encodeComponent(_x.id)}',
          jsonEncode(_x.toJson()));
      await env.prefs.setString('$kTimelineV3RowPrefix${Uri.encodeComponent(_x.id)}',
          jsonEncode(_x.copyWith(outputText: 'edited later').toJson()));
      final TimelinePersistence active = await _active(_Backend.fallback, env);
      final TimelineProof proof = await TimelineProof.take(active, ids: <String>[_x.id]);
      expect(proof.absent(_x.id), isFalse,
          reason: 'the earlier copy is a conflict hole under the same id');
      expect(proof.members(_article), isNull);
    });

    test('sqlite: a payload that decodes to another id is not a row', () async {
      final _Env env = await _env();
      await env.raw((Database db) async {
        await db.insert(kTimelineTable, <String, Object?>{
          'id': 'loc_filed_here', 'created_at': 0, 'updated_at': 0,
          'client_id': 'c', 'mode': 'realtime', 'status': 'noted',
          'entry_type': 'utterance', 'article_id': _article, 'deleted': 0,
          'search_text': '', 'payload': jsonEncode(_x.toJson()),
        });
      });
      final TimelinePersistence active = await _active(_Backend.sqlite, env);
      final TimelineProof proof = await TimelineProof.take(active,
          ids: <String>[_x.id, 'loc_filed_here']);
      expect(proof.absent(_x.id), isFalse);
      expect(proof.absent('loc_filed_here'), isFalse);
      expect(proof.members(_article), isNull);
    });

    test('a store built without its preferences cannot prove anything', () async {
      final _Env env = await _env();
      await env.raw((Database db) async {});
      final Database db = await databaseFactoryFfi.openDatabase(env.path);
      final SqfliteTimelinePersistence bare = SqfliteTimelinePersistence(db);
      addTearDown(bare.close);
      final TimelineInventory inv = await bare.inventory();
      expect(inv.unread, contains(TimelineRowStore.prefsCloudRetries));
      expect((await TimelineProof.take(bare, ids: <String>[_x.id])).absent(_x.id),
          isFalse);
    });
  });

  group('every place a row can live is registered', () {
    final List<(String, String)> sources = _sources();
    final Map<String, String> registered = <String, String>{
      for (final TimelineRowStore s in TimelineRowStore.values) s.surface: 'row store',
      ...kTimelineNonRowSurfaces,
      ..._noRowSurfaces,
    };
    // `prefs:` surfaces as (prefix, isFamily, isRowStore).
    final List<(String, bool, bool)> prefsSurfaces = <(String, bool, bool)>[
      for (final String s in registered.keys)
        if (s.startsWith('prefs:'))
          (
            s.substring(6).split(RegExp(r'[*<]')).first,
            s.endsWith('*') || s.contains('<'),
            TimelineRowStore.values.any((TimelineRowStore r) => r.surface == s),
          ),
    ];

    test('control: the scan reads the source tree', () {
      expect(sources.length, greaterThan(100),
          reason: 'cwd=${Directory.current.path}');
    });

    test('every SQLite table', () {
      final Map<String, String> constants = <String, String>{
        for (final (String _, String text) in sources)
          for (final RegExpMatch m
              in RegExp(r"""(\w+)\s*=\s*'([a-z_0-9]+)'""").allMatches(text))
            m.group(1)!: m.group(2)!,
      };
      final Set<String> tables = <String>{};
      for (final (String path, String text) in sources) {
        for (final RegExpMatch m in RegExp(
                r'CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\$\{?(\w+)\}?|\w+)')
            .allMatches(text)) {
          final String? name =
              m.group(2) != null ? constants[m.group(2)] : m.group(1);
          expect(name, isNotNull, reason: 'unresolved table in $path: ${m.group(0)}');
          tables.add('sqlite:$name');
        }
      }
      expect(tables, contains('sqlite:timeline_entries'), reason: 'control');
      expect(tables.difference(registered.keys.toSet()), isEmpty,
          reason: 'a table nobody registered may hold rows');
      expect(registered.keys.where((String s) => s.startsWith('sqlite:'))
          .toSet().difference(tables), isEmpty,
          reason: 'a registered table that no longer exists');
    });

    test('every flowmic key, and every family built on a key constant', () {
      // Key constants, to resolve `'$kPrefix<suffix>'` / `'${kPrefix}<suffix>'`.
      final Map<String, Set<String>> constants = <String, Set<String>>{};
      for (final (String _, String text) in sources) {
        for (final RegExpMatch m in RegExp(
                r"""const\s+String\s+(\w+)\s*=\s*'([^'$]+)'""")
            .allMatches(text)) {
          (constants[m.group(1)!] ??= <String>{}).add(m.group(2)!);
        }
      }
      final Set<String> keys = <String>{};
      for (final (String path, String text) in sources) {
        for (final RegExpMatch m in RegExp(
                r"""['"](flowmic\.[a-z_]+\.[A-Za-z0-9_.\-]*|usage\.[A-Za-z0-9_.\-]*)""")
            .allMatches(text)) {
          keys.add(m.group(1)!);
        }
        for (final RegExpMatch m in RegExp(
                r"""['"]\$\{?(\w+)\}?([A-Za-z][A-Za-z0-9_.\-]*)""")
            .allMatches(text)) {
          for (final String base in constants[m.group(1)!] ?? const <String>{}) {
            if (base.startsWith('flowmic.')) keys.add('$base${m.group(2)}');
          }
        }
        expect(path, isNotEmpty);
      }
      expect(keys, contains('${kTimelineCloudCursorPrefix}retry.'),
          reason: 'control: the interpolated retry family is found');
      // The namespace the census scans is not a key family: registering it
      // as one would cover every key under it.
      keys.remove(kTimelinePrefsNamespace);
      final List<String> problems = <String>[];
      for (final String key in keys) {
        (String, bool, bool)? best;
        for (final (String, bool, bool) s in prefsSurfaces) {
          final bool covers = s.$2 ? key.startsWith(s.$1) : key == s.$1;
          if (covers && (best == null || s.$1.length > best.$1.length)) best = s;
        }
        if (best == null) {
          problems.add('$key: not registered');
        } else if (!best.$3 && best.$2 && key.endsWith('.') &&
            key.length > best.$1.length) {
          // A family inside a non-row family is a new decision.
          problems.add('$key: a family under non-row ${best.$1}');
        }
      }
      expect(problems, isEmpty);
    });

    test('every file that writes persistent state', () {
      final RegExp writes = RegExp(
          r'\.set(?:String|Bool|Int|Double|StringList)\('
          r'|\b(?:txn|db|_db|d|database|executor)\.(?:insert|update|rawInsert|rawUpdate|execute|delete|rawDelete)\('
          r'|writeAsString|writeAsBytes|openWrite|writeBytes\('
          r'|\.write\(\s*key:');
      final Set<String> found = <String>{
        for (final (String path, String text) in sources)
          if (writes.hasMatch(text)) path,
      };
      expect(found, contains('lib/src/timeline/cloud/blind_store_timeline_bridge.dart'),
          reason: 'control');
      expect(found.difference(_writers.keys.toSet()), isEmpty,
          reason: 'a new writer: what does it persist, and can it hold a row?');
      for (final MapEntry<String, List<String>> w in _writers.entries) {
        expect(found, contains(w.key), reason: 'a listed writer that no longer writes');
        for (final String surface in w.value) {
          expect(registered.containsKey(surface), isTrue,
              reason: '${w.key} writes $surface, which is not registered');
        }
      }
    });

    test('every file that turns bytes into a timeline row', () {
      final Set<String> found = <String>{
        for (final (String path, String text) in sources)
          if (RegExp(r'TimelineEntry\.fromJson\(|decodeTimelineRow\(|decodeBlindStorePayload\(')
              .hasMatch(text))
            path,
      };
      expect(found, contains('lib/src/timeline/cloud/blind_store_cloud_sync.dart'),
          reason: 'control: the cloud decoder is seen');
      expect(found.difference(_decoders.keys.toSet()), isEmpty,
          reason: 'a new decoder of rows: is it a new store?');
    });

    test('production builds a timeline store only through the opener', () {
      final Map<String, int> built = <String, int>{};
      for (final (String path, String text) in sources) {
        // A constructor declaration (`X(this.…`) is not a call.
        for (final RegExpMatch _ in RegExp(
                r'\b(?:SharedPrefs|Sqflite|InMemory)TimelinePersistence\((?!this\.)')
            .allMatches(text)) {
          built[path] = (built[path] ?? 0) + 1;
        }
      }
      expect(built, <String, int>{'lib/src/timeline/timeline_sqlite.dart': 2},
          reason: 'one fallback and one SQLite store, both in openTimelinePersistence');
      expect(sources.firstWhere(((String, String) s) =>
              s.$1 == 'lib/src/timeline/timeline_sqlite.dart').$2,
          contains('SqfliteTimelinePersistence(db, prefs: prefs)'));
    });
  });
}
