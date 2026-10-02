// NR-137 round 9 (review r8, BLOCKING B1–B4) — A REMOVAL OR A MEMBERSHIP IS
// PROVEN ONLY BY POSITIVE EVIDENCE.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   lib/src/timeline/timeline_verified_reads.dart (`TimelineProof`, the one
//   place a removal or a membership is decided)
//   lib/src/timeline/timeline_row_stores.dart (every place a row can live)
//
// Review of `30e40186` (`_dispatch/2026-10-02-nr137-r8-review.md.out`): four
// attacks, each on both backends, each ending in a false proof:
//   B1 an undecodable row WITHOUT `article_id` was read as "known: no article",
//      so the article looked complete and its audio was released;
//   B2 the cloud retry store (undecodable pulled rows waiting under
//      `flowmic.timeline.cloud.cursor.v1.retry.*`) was in no inventory;
//   B3 a malformed key's literal suffix overruled the readable id inside an
//      undecodable payload, so that id was "proven" absent;
//   B4 a readable tombstone written BEFORE unresolved same-id residue answered
//      the keyed read first, so the residue never counted.
//
// These are the reviewer's eight rows (`_dispatch/nr137-r8-review-
// inventory_test.dart`) made permanent, on the real chain and the shipped
// backends. The reviewer's B2 case also asserted the OLD registry entries (the
// mechanism of the defect); those two lines are not carried over, the product
// assertions are.
//
// REVERSE CONTROL (2026-10-02): this file on `30e40186`, unmodified product
// code — all eight red at their product assertions; see the round-9 report.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/nr137_rig.dart';
import 'support/rc3_rig.dart';

/// A relay that serves [blobs] to a pull and acks every push.
class _CloudRelay extends FakeSocketTransport {
  _CloudRelay(this.blobs);
  final List<Map<String, Object?>> blobs;
  @override
  Future<R> emitWithAck<R>(String event, Object? payload,
      {Duration timeout = const Duration(seconds: 3)}) async {
    if (event == FlowMicEvents.timelinePush) {
      final List<Object?> entries = (payload! as Map)['entries'] as List<Object?>;
      return <String, Object?>{
        'ok': true,
        'assigned': <Object?>[
          for (final Object? e in entries)
            <String, Object?>{'id': (e! as Map)['id'], 'seq': 100},
        ],
      } as R;
    }
    if (event == FlowMicEvents.timelinePull) {
      return <String, Object?>{'blobs': blobs, 'next_seq': 2} as R;
    }
    return super.emitWithAck<R>(event, payload, timeout: timeout);
  }
}

enum _Backend { fallback, sqlite }

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

/// The fallback the app runs on when SQLite will not open and its file does
/// not exist: obtained from the shipped opener, so each case is decided by
/// its own evidence and not by what this session cannot see.
Future<SharedPrefsTimelinePersistence> _fallback(SharedPreferences prefs) async {
  final Directory dir = await Directory.systemTemp.createTemp('nr137-r9-');
  addTearDown(() async {
    try { await dir.delete(recursive: true); } on Object { /* best effort */ }
  });
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs, factory: _UnopenableFactory(), path: '${dir.path}/none.db');
  expect(open.kind, TimelineStorageKind.sharedPrefsFallback);
  return open.persistence as SharedPrefsTimelinePersistence;
}

/// Switch the rig onto the shipped SQLite store opened over [prefs], the way
/// a later launch would; the fallback case keeps the shipped fallback.
Future<void> _useBackend(_Backend backend, Rc3Rig r, Nr137BackendSlot slot,
    SharedPreferences prefs, String name) async {
  if (backend == _Backend.sqlite) {
    final TimelineStorageOpen opened = await openTimelinePersistence(
        prefs: prefs,
        factory: databaseFactoryFfi,
        path: '${r.tmp.path}/$name.sqlite');
    expect(opened.kind, TimelineStorageKind.sqlite);
    final SqfliteTimelinePersistence sql =
        opened.persistence as SqfliteTimelinePersistence;
    addTearDown(sql.close);
    slot.current = sql;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  for (final _Backend backend in _Backend.values) {
    test('B1 ${backend.name}: a missing article_id is unknown, never "no article"',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final Nr137BackendSlot slot = Nr137BackendSlot(await _fallback(prefs));
      final Rc3Rig r = await nr137Article(slot);
      final Map<String, String> physical = <String, String>{};
      for (final TimelineEntry old in r.rows.toList()) {
        final Map<String, Object?> bad = nr137Undecodable(old)
          ..remove('article_id');
        expect(decodeTimelineRow(bad), isNull, reason: 'decoder control');
        physical[nr137V3Key(old.id)] = jsonEncode(bad);
        await prefs.setString(nr137V3Key(old.id), physical[nr137V3Key(old.id)]!);
      }
      await _useBackend(backend, r, slot, prefs, 'b1');
      await r.timeline.load();
      final TimelineInventory inv = await slot.inventory();
      final List<TimelineEntry>? members =
          await articleMembersVerified(r.timeline, r.articleId!);

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R9 B1 ${backend.name}: holes=${inv.unreadable.length} '
          'articleMayBeMissing=${inv.mayOmitMemberOf(r.articleId!)} '
          'membershipVerified=${members != null} outcome=$out '
          'audioPresent=${r.pcmPresent}');
      expect(physical.entries.every(
              (MapEntry<String, String> e) => prefs.getString(e.key) == e.value),
          isTrue, reason: 'control: the undecodable members are still stored');
      expect(members, isNull,
          reason: 'members whose article is not stated cannot be ruled out');
      expect(out, PendingRetryOutcome.failed);
      expect(r.pcmPresent, isTrue);
    });

    test('B2 ${backend.name}: undecodable rows waiting in the cloud retry store',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final SharedPrefsTimelinePersistence fallback = await _fallback(prefs);
      final Nr137BackendSlot slot = Nr137BackendSlot(fallback);
      final Rc3Rig r = await nr137Article(slot);
      final BlindStoreKeyring keyring = BlindStoreKeyring(
          store: InMemoryBlindStoreKeyStore(),
          cost: Argon2Cost.reducedForTestsOnly(memoryKiB: 64, iterations: 1, lanes: 1));
      await keyring.enroll('nr137-r9-test-only-input');
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      const String account = 'nr137-r9-account';
      final List<TimelineEntry> oldRows = r.rows.toList();
      final List<Map<String, Object?>> wire = <Map<String, Object?>>[];
      for (final TimelineEntry old in oldRows) {
        // An authenticated row from a newer payload schema: the shipped cloud
        // decoder refuses it rather than guess at its fields.
        final String plaintext = jsonEncode(<String, Object?>{
          'v': kBlindStorePayloadVersion + 1,
          'entry': old.toJson(),
        });
        expect(decodeBlindStorePayload(plaintext), isNull);
        final String ciphertext =
            keyring.seal(entryId: old.id, plaintext: plaintext)!;
        wire.add(<String, Object?>{
          'id': old.id,
          'seq': oldRows.indexOf(old) + 1,
          'ciphertext': ciphertext,
          'created_at': old.createdAt.millisecondsSinceEpoch,
          'schema_ver': kBlindStoreBlobSchemaVer + 1,
          'deleted': false,
        });
        await fallback.delete(old.id);
      }
      final _CloudRelay relay = _CloudRelay(wire);
      addTearDown(relay.close);
      // The shipped pull and merge: undecodable rows are saved as retries
      // before the cursor advances.
      final BlindStoreCloudSync sync = BlindStoreCloudSync(
          keyring: keyring,
          client: BlindStoreCloudClient(transport: relay),
          state: InMemoryBlindStoreCloudStateStore(),
          bridge: BlindStoreTimelineBridge(
              persistence: slot,
              store: r.timeline,
              reaper: newTestReaper(persistence: slot),
              reload: r.timeline.load),
          cursor: cursor,
          isCloudRelay: () => true,
          accountKey: () => account,
          keymetaConfirmed: () async => true);
      final BlindStoreSyncReport report = await sync.syncNow();
      expect(report.undecryptable, 2, reason: 'control');
      expect(await cursor.loadRetries(account), hasLength(2), reason: 'control');
      final Map<String, String> physical = <String, String>{
        for (final TimelineEntry old in oldRows)
          '${SharedPrefsBlindStoreCursorStore.kPrefix}retry.'
                  '${Uri.encodeComponent(account)}.${Uri.encodeComponent(old.id)}':
              '',
      };
      for (final String key in physical.keys.toList()) {
        physical[key] = prefs.getString(key)!;
      }
      await _useBackend(backend, r, slot, prefs, 'b2');
      await r.timeline.load();
      final bool absence = await provenGone(r.timeline, oldRows.first.id);
      final List<TimelineEntry>? members =
          await articleMembersVerified(r.timeline, r.articleId!);

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R9 B2 ${backend.name}: retries=${physical.length} '
          'absenceProven=$absence membershipVerified=${members != null} '
          'outcome=$out audioPresent=${r.pcmPresent}');
      expect(physical.entries.every(
              (MapEntry<String, String> e) => prefs.getString(e.key) == e.value),
          isTrue, reason: 'control: the retry records are still stored');
      expect(absence, isFalse,
          reason: 'a row waiting to land from the cloud is not absent');
      expect(members, isNull);
      expect(out, PendingRetryOutcome.failed);
      expect(r.pcmPresent, isTrue);
    });

    test('B3 ${backend.name}: a malformed key cannot clear the id in the payload',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final SharedPrefsTimelinePersistence fallback = await _fallback(prefs);
      final Nr137BackendSlot slot = Nr137BackendSlot(fallback);
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry old = r.rows.first;
      const String key = 'flowmic.timeline.pending.v3.%GG';
      final String bytes = jsonEncode(nr137Undecodable(old));
      await fallback.delete(old.id);
      await prefs.setString(key, bytes);
      await _useBackend(backend, r, slot, prefs, 'b3');
      final bool absence = await provenGone(r.timeline, old.id);

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R9 B3 ${backend.name}: absenceProven=$absence outcome=$out '
          'audioPresent=${r.pcmPresent}');
      expect(prefs.getString(key), bytes, reason: 'control');
      expect(absence, isFalse,
          reason: 'the payload still names this id under an unreadable key');
      expect(out, PendingRetryOutcome.failed);
      expect(r.pcmPresent, isTrue);
    });

    test('B4 ${backend.name}: an earlier tombstone cannot hide residue', () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final SharedPrefsTimelinePersistence fallback = await _fallback(prefs);
      final Nr137BackendSlot slot = Nr137BackendSlot(fallback);
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry old = r.rows.first;
      final String bytes = jsonEncode(nr137Undecodable(old));
      final String residueKey;
      if (backend == _Backend.sqlite) {
        final String path = '${r.tmp.path}/b4.sqlite';
        final TimelineStorageOpen first = await openTimelinePersistence(
            prefs: prefs, factory: databaseFactoryFfi, path: path);
        final SqfliteTimelinePersistence sql0 =
            first.persistence as SqfliteTimelinePersistence;
        await sql0.upsert(old.copyWith(deleted: true));
        await sql0.close();
        residueKey = nr137V3Key(old.id);
        await prefs.setString(residueKey, bytes);
        final TimelineStorageOpen again = await openTimelinePersistence(
            prefs: prefs, factory: databaseFactoryFfi, path: path);
        final SqfliteTimelinePersistence sql =
            again.persistence as SqfliteTimelinePersistence;
        addTearDown(sql.close);
        slot.current = sql;
      } else {
        await fallback.upsert(old.copyWith(deleted: true));
        residueKey = nr137V2Key(old.id);
        await prefs.setString(residueKey, bytes);
      }
      final TimelineInventory inv = await slot.inventory();
      final bool absence = await provenGone(r.timeline, old.id);

      // ignore: avoid_print
      print('R9 B4 ${backend.name}: holes=${inv.unreadable.length} '
          'absenceProven=$absence');
      expect(prefs.getString(residueKey), bytes, reason: 'control');
      expect(inv.unreadable, isNotEmpty, reason: 'control: the residue is seen');
      expect(absence, isFalse,
          reason: 'a tombstone older than the residue does not resolve it');
    });
  }
}
