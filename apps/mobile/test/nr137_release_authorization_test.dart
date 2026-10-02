// NR-137 round 10 (review r9, BLOCKING B1–B2) — A RELEASE OF AUDIO STANDS ON
// ONE CURRENT PROOF; A CLOUD RETRY BLOCKS ONLY WHAT IT MAY BE.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   lib/src/timeline/timeline_verified_reads.dart (`TimelineProof.authorizes`,
//   `TimelineReleaseClaim`)
//   lib/src/timeline/timeline_row_stores.dart (`kCloudRetryAttribution`)
//
// Review of `639df912` (`_dispatch/2026-10-02-nr137-r9-review.md.out`):
//   B1 the final check of an in-place press accepted the fresh answer's
//      PRESENCE although its own census held a cloud retry that landed after
//      the earlier rows were proven gone; the press said done and the PCM went;
//   B2 every cloud retry blocked every article, even one this build had
//      authenticated and fully decoded as another article's row.
//
// All on the real chain (`Rc3Rig` → `PendingRecoveryStore.retryNow`), the
// shipped opener (the fallback is the one the app runs on when SQLite will
// not open and has no file) and the shipped pull/merge
// (`BlindStoreCloudClient` → `BlindStoreCloudSync`), which writes the retry
// records itself. The adapters forward every read, write and delete to the
// shipped backend; the only refusal is the one cloud row write a case names.
//
// REVERSE CONTROL (2026-10-02): this file on `639df912`, unmodified product
// code — B1 × 2 red on `Expected: failed, Actual: done`, the decodable
// unrelated rows red on `Expected: done`, the attribution rows red on the
// census attribution; see the round-10 report.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/legacy_backfill_rig.dart';
import 'support/nr137_rig.dart';
import 'support/rc3_rig.dart';

/// SQLite that will not open this session; whether its file exists is real.
class _NoSqliteFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

enum _Backend { fallback, sqlite }

/// The backend the app runs on, from the shipped opener.
Future<TimelinePersistence> _backend(_Backend b, SharedPreferences prefs) async {
  final Directory dir = await Directory.systemTemp.createTemp('nr137-r10-');
  addTearDown(() async {
    try { await dir.delete(recursive: true); } on Object { /* best effort */ }
  });
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs,
      factory: b == _Backend.sqlite ? databaseFactoryFfi : _NoSqliteFactory(),
      path: '${dir.path}/timeline.db');
  expect(open.kind,
      b == _Backend.sqlite ? TimelineStorageKind.sqlite : TimelineStorageKind.sharedPrefsFallback);
  if (open.persistence is SqfliteTimelinePersistence) {
    addTearDown((open.persistence as SqfliteTimelinePersistence).close);
  }
  return open.persistence;
}

/// Refuses the local write of the cloud rows in [failIds], once each time it
/// is asked; everything else reaches the shipped backend.
class _CloudWriteRefused extends Nr137BackendSlot {
  _CloudWriteRefused(super.current);
  final Set<String> failIds = <String>{};
  @override
  Future<void> upsert(TimelineEntry row) async {
    if (failIds.contains(row.id)) throw StateError('cloud row write refused');
    await super.upsert(row);
  }
}

/// A cloud retry lands AFTER every earlier row's removal was proven (its keyed
/// read returned absent) and BEFORE the next census — the reviewer's
/// interleaving. The retry is written by the shipped merge; no read result is
/// invented.
class _RetryBeforeFinalProof extends Nr137BackendSlot {
  _RetryBeforeFinalProof(super.current);
  final Set<String> originalIds = <String>{};
  final Set<String> deleted = <String>{};
  final Set<String> readGone = <String>{};
  Future<void> Function()? land;
  bool landed = false;
  bool censusSawIt = false;

  @override
  Future<void> delete(String id) async {
    await super.delete(id);
    if (originalIds.contains(id)) deleted.add(id);
  }

  @override
  Future<TimelineEntry?> readRecord(String id) async {
    final TimelineEntry? e = await super.readRecord(id);
    if (originalIds.contains(id) && deleted.containsAll(originalIds) && e == null) {
      readGone.add(id);
    }
    return e;
  }

  @override
  Future<TimelineInventory> loadInventory() async {
    if (!landed && land != null && originalIds.isNotEmpty &&
        readGone.containsAll(originalIds)) {
      landed = true;
      await land!();
    }
    final TimelineInventory inv = await super.loadInventory();
    if (landed && inv.unreadable.isNotEmpty) censusSawIt = true;
    return inv;
  }
}

/// The legacy fold: its removals are proven (every deleted row read back
/// absent), its note is written — and then, before anything releases the
/// audio, a cloud retry for one of the removed rows lands.
class _RetryAfterFoldRemoval extends Nr137BackendSlot {
  _RetryAfterFoldRemoval(super.current);
  final Set<String> deleted = <String>{};
  final Set<String> readGone = <String>{};
  Future<void> Function(String id)? land;
  bool landed = false;

  @override
  Future<void> delete(String id) async {
    await super.delete(id);
    deleted.add(id);
  }

  @override
  Future<TimelineEntry?> readRecord(String id) async {
    final TimelineEntry? e = await super.readRecord(id);
    if (deleted.contains(id) && e == null) readGone.add(id);
    return e;
  }

  @override
  Future<void> upsert(TimelineEntry row) async {
    await super.upsert(row);
    if (!landed && land != null && deleted.isNotEmpty &&
        readGone.containsAll(deleted) && !deleted.contains(row.id)) {
      landed = true;
      await land!(deleted.first);
    }
  }
}

/// RC-3: the partial row of a shortfall is removed and its removal proven —
/// and during that proof's own keyed read (its census already taken), a
/// cloud retry for that row lands. Only a census taken after it can see it.
class _RetryDuringRemovalRead extends Nr137BackendSlot {
  _RetryDuringRemovalRead(super.current, this.partialText);
  final String partialText;
  final Set<String> partialIds = <String>{};
  final Set<String> deleted = <String>{};
  Future<void> Function(String id)? land;
  bool landed = false;

  @override
  Future<void> upsert(TimelineEntry row) async {
    if (row.displayText == partialText) partialIds.add(row.id);
    await super.upsert(row);
  }

  @override
  Future<void> delete(String id) async {
    await super.delete(id);
    deleted.add(id);
  }

  @override
  Future<TimelineEntry?> readRecord(String id) async {
    final TimelineEntry? e = await super.readRecord(id);
    if (!landed && land != null && e == null && partialIds.contains(id) &&
        deleted.contains(id)) {
      landed = true;
      await land!(id);
    }
    return e;
  }
}

String _rowsJson(List<TimelineEntry> rows) =>
    jsonEncode(rows.map((TimelineEntry e) => e.toJson()).toList());

TimelineEntry _cloudRow(TimelineEntry like, String id, String? article) =>
    TimelineEntry.fromJson(Map<String, Object?>.from(like.toJson())
      ..['id'] = id
      ..['client_id'] = 'cloud-$id'
      ..['article_id'] = article)!;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  for (final _Backend backend in _Backend.values) {
    test('RC-3 ${backend.name}: a retry landing after the partial rows go keeps the audio',
        () async {
      const String opening = 'The opening before the engine went away.';
      const String short = 'Eight words.';
      const String whole = 'The whole tail, transcribed again.';
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RetryDuringRemovalRead slot =
          _RetryDuringRemovalRead(await _backend(backend, prefs), short);
      final Rc3Rig r = await Rc3Rig.open(persistence: slot);
      addTearDown(r.dispose);
      int n = 0;
      r.relay.onStop = (Rc3Stop stop) {
        final String text = !stop.recovery ? '' : (++n == 1 ? short : whole);
        Future<void>.delayed(const Duration(milliseconds: 20), () =>
            r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
                text: text,
                durationMs: stop.recovery ? stop.toMs - stop.fromMs : 0,
                segmentIdx: stop.recovery ? 0 : 2,
                endedNormally: stop.recovery && n != 1)));
      };
      await r.begin();
      await r.feedMs(2000);
      await r.segment(opening, 0, 2000);
      await r.engine('reconnecting');
      await r.feedMs(2000);
      await r.controller.pttUp();
      await r.recoveries(1);
      RecordingManifest m = (await r.manifest())!;
      expect(m.recoveryState, RecoveryQueueState.shortfall, reason: 'control');
      const String account = 'nr137-r10-rc3';
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      slot.land = (String id) => cursor.saveRetry(account, BlindStoreRemoteBlob(
          id: id, seq: 1, ciphertext: 'opaque-envelope', createdAtMs: 0,
          schemaVer: kBlindStoreBlobSchemaVer + 1, deleted: false));

      await r.controller.backfill
          .retranscribe(recordingId: m.recordingId, sourceLang: 'zh');
      await r.recoveries(2);
      m = (await r.manifest())!;

      // ignore: avoid_print
      print('R10 RC-3 ${backend.name}: landed=${slot.landed} '
          'settled=${m.settled} state=${m.recoveryState} audioPresent=${r.pcmPresent}');
      expect(slot.landed, isTrue, reason: 'control: the partial row was removed');
      expect(m.settled, isFalse,
          reason: 'the removed partial row may come back: release not proven');
      expect(r.pcmPresent, isTrue);
    });

    test('B1 ${backend.name}: a retry landing before the final proof keeps the audio',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RetryBeforeFinalProof slot =
          _RetryBeforeFinalProof(await _backend(backend, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry old = r.rows.first;
      slot.originalIds.addAll(r.rows.map((TimelineEntry e) => e.id));
      final BlindStoreKeyring keyring = await nr137Keyring();
      // A complete original member, authenticated, in a newer payload schema
      // the shipped decoder refuses.
      final String plaintext = jsonEncode(<String, Object?>{
        'v': kBlindStorePayloadVersion + 1,
        'entry': old.toJson(),
      });
      expect(decodeBlindStorePayload(plaintext), isNull);
      final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
        nr137Blob(old, keyring.seal(entryId: old.id, plaintext: plaintext)!,
            seq: 1, schemaVer: kBlindStoreBlobSchemaVer + 1),
      ]);
      addTearDown(relay.close);
      const String account = 'nr137-r10-b1';
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      final BlindStoreCloudSync sync = nr137CloudSync(keyring: keyring, relay: relay,
          persistence: slot, rig: r, cursor: cursor, account: account);
      String? retryBytes;
      slot.land = () async {
        final BlindStoreSyncReport report = await sync.syncNow();
        expect(report.undecryptable, 1, reason: 'control: the merge kept the row');
        retryBytes = prefs.getString(nr137RetryKey(account, old.id));
        expect(retryBytes, isNotNull);
      };

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R10 B1 ${backend.name}: landed=${slot.landed} '
          'censusSawIt=${slot.censusSawIt} outcome=$out audioPresent=${r.pcmPresent}');
      expect(slot.landed, isTrue, reason: 'control: the interleaving happened');
      expect(slot.censusSawIt, isTrue, reason: 'control: the census saw the retry');
      expect(prefs.getString(nr137RetryKey(account, old.id)), retryBytes);
      expect(out, PendingRetryOutcome.failed,
          reason: 'the answer being present does not resolve what may be the old row');
      expect(r.pcmPresent, isTrue);
      expect(await provenGone(r.timeline, old.id), isFalse);
    });

    test('B2 ${backend.name}: a decodable retry of another article does not block',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _CloudWriteRefused slot =
          _CloudWriteRefused(await _backend(backend, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final String before = _rowsJson(await slot.loadAll());
      final TimelineEntry remote =
          _cloudRow(r.rows.first, 'cloud-unrelated-row', 'another-article');
      final BlindStoreKeyring keyring = await nr137Keyring();
      final String ciphertext =
          keyring.seal(entryId: remote.id, plaintext: encodeBlindStorePayload(remote))!;
      final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
        nr137Blob(remote, ciphertext, seq: 1, schemaVer: kBlindStoreBlobSchemaVer),
      ]);
      addTearDown(relay.close);
      const String account = 'nr137-r10-b2';
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      slot.failIds.add(remote.id);
      final BlindStoreSyncReport report = await nr137CloudSync(keyring: keyring,
              relay: relay, persistence: slot, rig: r, cursor: cursor, account: account)
          .syncNow();
      expect(report.undecryptable, 0, reason: 'control: it authenticated and decoded');
      final List<BlindStoreRemoteBlob> retries = await cursor.loadRetries(account);
      expect(retries, hasLength(1), reason: 'control: the merge kept it to retry');
      expect(cursor.retryIsUnreadable(account, retries.single), isFalse);
      expect(_rowsJson(await slot.loadAll()), before, reason: 'the list is unchanged');
      final String bytes = prefs.getString(nr137RetryKey(account, remote.id))!;

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R10 B2 unrelated ${backend.name}: outcome=$out audioPresent=${r.pcmPresent}');
      expect(prefs.getString(nr137RetryKey(account, remote.id)), bytes);
      expect(out, PendingRetryOutcome.done,
          reason: 'a row positively of another article is not this article\'s');
      expect(r.pcmPresent, isFalse);
    });

    test('B2 ${backend.name}: a decodable retry of THIS article blocks, attributed',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _CloudWriteRefused slot =
          _CloudWriteRefused(await _backend(backend, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry remote =
          _cloudRow(r.rows.first, 'cloud-same-article-row', r.articleId);
      final BlindStoreKeyring keyring = await nr137Keyring();
      final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
        nr137Blob(remote,
            keyring.seal(entryId: remote.id, plaintext: encodeBlindStorePayload(remote))!,
            seq: 1, schemaVer: kBlindStoreBlobSchemaVer),
      ]);
      addTearDown(relay.close);
      const String account = 'nr137-r10-related';
      slot.failIds.add(remote.id);
      final BlindStoreSyncReport report = await nr137CloudSync(keyring: keyring,
              relay: relay, persistence: slot, rig: r,
              cursor: SharedPrefsBlindStoreCursorStore(prefs), account: account)
          .syncNow();
      expect(report.undecryptable, 0, reason: 'control');
      final UnreadableRow hole = (await slot.inventory())
          .unreadable
          .singleWhere((UnreadableRow u) => u.id == remote.id);

      final PendingRetryOutcome out = await nr137Press(r);

      // ignore: avoid_print
      print('R10 B2 related ${backend.name}: articleKnown=${hole.articleKnown} '
          'article=${hole.articleId} outcome=$out audioPresent=${r.pcmPresent}');
      expect(hole.articleKnown, isTrue,
          reason: 'it authenticated and decoded: its article is stated');
      expect(hole.articleId, r.articleId);
      expect(out, PendingRetryOutcome.failed,
          reason: 'a row of this article that may still land is unresolved');
      expect(r.pcmPresent, isTrue);
    });

    test('B2 ${backend.name}: only the genuinely unknown retries block', () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _CloudWriteRefused slot =
          _CloudWriteRefused(await _backend(backend, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final BlindStoreKeyring keyring = await nr137Keyring();
      final TimelineEntry known = _cloudRow(r.rows.first, 'cloud-known', 'article-b');
      final TimelineEntry newer = _cloudRow(r.rows.first, 'cloud-newer', 'article-b');
      final TimelineEntry replaced = _cloudRow(r.rows.first, 'cloud-replaced', 'article-b');
      final Nr137CloudRelay relay = Nr137CloudRelay(<Map<String, Object?>>[
        nr137Blob(known,
            keyring.seal(entryId: known.id, plaintext: encodeBlindStorePayload(known))!,
            seq: 1, schemaVer: kBlindStoreBlobSchemaVer),
        // Authenticated, but a payload schema this build cannot read.
        nr137Blob(newer,
            keyring.seal(entryId: newer.id, plaintext: jsonEncode(<String, Object?>{
              'v': kBlindStorePayloadVersion + 1, 'entry': newer.toJson()}))!,
            seq: 2, schemaVer: kBlindStoreBlobSchemaVer + 1),
        nr137Blob(replaced,
            keyring.seal(entryId: replaced.id, plaintext: encodeBlindStorePayload(replaced))!,
            seq: 3, schemaVer: kBlindStoreBlobSchemaVer),
      ]);
      addTearDown(relay.close);
      const String account = 'nr137-r10-mixed';
      slot.failIds.addAll(<String>[known.id, replaced.id]);
      final BlindStoreSyncReport report = await nr137CloudSync(keyring: keyring,
              relay: relay, persistence: slot, rig: r,
              cursor: SharedPrefsBlindStoreCursorStore(prefs), account: account)
          .syncNow();
      expect(report.undecryptable, 1, reason: 'control: only the newer schema');
      // Replace one record's envelope (a fresh seal of the same row) without
      // going through the merge: whatever it learned about the old envelope
      // no longer applies.
      final String key = nr137RetryKey(account, replaced.id);
      final Map<String, Object?> value =
          (jsonDecode(prefs.getString(key)!) as Map).cast<String, Object?>();
      final String fresh = keyring.seal(
          entryId: replaced.id, plaintext: encodeBlindStorePayload(replaced))!;
      expect(fresh, isNot(value['ciphertext']), reason: 'control: a new envelope');
      await prefs.setString(key, jsonEncode(<String, Object?>{...value, 'ciphertext': fresh}));
      final List<UnreadableRow> retries = (await slot.inventory())
          .unreadable
          .where((UnreadableRow u) =>
              <String>{known.id, newer.id, replaced.id}.contains(u.id))
          .toList();

      final PendingRetryOutcome out = await nr137Press(r);

      final Map<String?, String> seen = <String?, String>{
        for (final UnreadableRow u in retries)
          u.id: u.articleKnown ? 'known:${u.articleId}' : 'unknown',
      };
      // ignore: avoid_print
      print('R10 B2 mixed ${backend.name}: $seen outcome=$out '
          'audioPresent=${r.pcmPresent}');
      expect(seen, <String?, String>{
        known.id: 'known:article-b',
        newer.id: 'unknown',
        replaced.id: 'unknown',
      });
      expect(out, PendingRetryOutcome.failed,
          reason: 'a retry that may be any article blocks');
      expect(r.pcmPresent, isTrue);
    });

    test('legacy ${backend.name}: a retry landing after the fold keeps the segments',
        () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _RetryAfterFoldRemoval slot =
          _RetryAfterFoldRemoval(await _backend(backend, prefs));
      final LegacyRig r = await LegacyRig.open(persistence: slot);
      addTearDown(r.dispose);
      const String session = 'nr137-r10-legacy';
      await r.seed(session);
      await r.store.markUnverified(0, session: session);
      r.relay.replyWords('Fresh words from this press');
      const String account = 'nr137-r10-legacy-account';
      final SharedPrefsBlindStoreCursorStore cursor =
          SharedPrefsBlindStoreCursorStore(prefs);
      String? retried;
      slot.land = (String id) async {
        retried = id;
        // The shipped retry store, as the merge writes it for a row it could
        // not read: the folded replay row may come back from the cloud.
        await cursor.saveRetry(account, BlindStoreRemoteBlob(
            id: id, seq: 1, ciphertext: 'opaque-envelope', createdAtMs: 0,
            schemaVer: kBlindStoreBlobSchemaVer + 1, deleted: false));
      };

      final PendingRetryOutcome out =
          await r.pending.retryNow((await r.pending.list()).single);
      await r.idle();
      final int bytes = await r.store.bytesForSession(session);

      // ignore: avoid_print
      print('R10 legacy ${backend.name}: landed=${slot.landed} outcome=$out '
          'audioBytes=$bytes');
      expect(slot.landed, isTrue, reason: 'control: the interleaving happened');
      expect(prefs.getString(nr137RetryKey(account, retried!)), isNotNull);
      expect(out, PendingRetryOutcome.failed,
          reason: 'the folded row may come back: the release is not proven');
      expect(bytes, 6400, reason: 'the segment audio stays');
    });
  }
}
