import 'package:flutter/foundation.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_leg.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_key_provisioner.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_keymeta_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'blind_store_cloud_sync_test.dart' as base;

class _Refuses extends InMemoryTimelinePersistence {
  bool fail = true;
  @override
  Future<void> upsert(TimelineEntry e) async {
    if (fail && e.id == 'late-row') throw StateError('disk full');
    await super.upsert(e);
  }
}

class _UnusedKeymeta implements BlindStoreKeymetaClient {
  @override
  Future<BlindStoreKeymetaRow?> get() => throw StateError('unexpected GET');
  @override
  Future<BlindStoreKeymetaPutOutcome> put({required Uint8List salt, required String sentinel}) =>
      throw StateError('unexpected PUT');
}

void main() {
  test('local recovery resets only storage rows in both cursor implementations', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    for (final cursor in <BlindStoreCursorStore>[
      InMemoryBlindStoreCursorStore(nowMs: () => 0),
      SharedPrefsBlindStoreCursorStore(prefs, nowMs: () => 0, appVersion: 'same-build'),
    ]) {
      final p = _Refuses(); final h = base.Harness(persistence: p, cursorStore: cursor);
      await h.boot(); addTearDown(h.store.dispose);
      final row = base.lightRecord(id: 'late-row');
      h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
        ciphertext: h.keyring.seal(entryId: row.id, plaintext: encodeBlindStorePayload(row))!),
        base.Harness.remoteBlob(id: 'decrypt-row', seq: 2, ciphertext: 'e2e:v1:invalid')], 'next_seq': 2});
      await h.sync.syncNow();
      final retries = await cursor.loadRetries(base.kAccount);
      final storage = retries.firstWhere((b) => b.id == row.id);
      final decrypt = retries.firstWhere((b) => b.id == 'decrypt-row');
      const network = BlindStoreRemoteBlob(id: 'network-row', seq: 3, ciphertext: 'bytes',
        createdAtMs: 1, schemaVer: 1, deleted: false);
      await cursor.saveRetry(base.kAccount, network);
      expect(cursor.shouldRetry(base.kAccount, storage), isFalse);
      await h.store.saveExternalRecord(base.lightRecord(id: 'local', origin: 'paired'));
      h.sync.storageRecovered();
      expect(cursor.shouldRetry(base.kAccount, storage), isTrue);
      expect(cursor.shouldRetry(base.kAccount, decrypt), isFalse);
      expect(cursor.shouldRetry(base.kAccount, network), isFalse);
      expect((await cursor.loadRetries(base.kAccount)).firstWhere((b) => b.id == decrypt.id).ciphertext, decrypt.ciphertext);
      // A validation rejection is not a storage error either.
      await p.upsert(base.lightRecord(id: 'immutable', origin: 'paired'));
      final changed = base.lightRecord(id: 'immutable').toJson()..['source_text'] = 'changed';
      final invalid = TimelineEntry.fromJson(changed)!;
      h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: invalid.id, seq: 4,
        ciphertext: h.keyring.seal(entryId: invalid.id, plaintext: encodeBlindStorePayload(invalid))!)], 'next_seq': 4});
      await h.sync.syncNow();
      final rejected = (await cursor.loadRetries(base.kAccount)).firstWhere((b) => b.id == invalid.id);
      await h.store.saveExternalRecord(base.lightRecord(id: 'local-2', origin: 'paired'));
      h.sync.storageRecovered();
      expect(cursor.shouldRetry(base.kAccount, rejected), isFalse);
    }
  });

  testWidgets('twenty local writes start one sync after five quiet seconds', (tester) async {
    final h = base.Harness();
    await tester.runAsync(() => h.boot()); addTearDown(h.store.dispose);
    final joins = ValueNotifier<int>(0); addTearDown(joins.dispose);
    final leg = BlindStoreCloudLeg(keyring: h.keyring, sync: h.sync, roomJoins: joins,
      provisioner: BlindStoreKeyProvisioner(keyring: h.keyring, client: _UnusedKeymeta(),
        accountKey: () => base.kAccount));
    addTearDown(leg.dispose);
    await tester.runAsync(() async {
      h.transport.ackQueue.add(base.Harness.emptyPull());
      leg.attach();
      while (leg.lastReport == null) { await Future<void>.delayed(const Duration(milliseconds: 1)); }
    });
    final before = h.keymetaAsks;
    h.transport.ackQueue.add(base.Harness.emptyPull());
    for (int i = 0; i < 20; i++) {
      await h.store.saveExternalRecord(base.lightRecord(id: 'local-$i', origin: 'paired'));
    }
    await tester.pump(const Duration(seconds: 4));
    expect(h.keymetaAsks, before, reason: 'local writes wait for the debounce');
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(h.keymetaAsks - before, 1, reason: 'one cloud sync for the entire burst');
    await tester.pump(const Duration(seconds: 5));
    expect(h.keymetaAsks - before, 1);
    await h.store.saveExternalRecord(base.lightRecord(id: 'last', origin: 'paired'));
    leg.detachForAccountChange();
    await tester.pump(const Duration(seconds: 6));
    expect(h.keymetaAsks - before, 1, reason: 'account detach cancels the pending sync');
  });

  test('a local write resets a storage failure but keeps another failure backoff', () async {
    final p = _Refuses(); final h = base.Harness(persistence: p, nowMs: () => 0);
    await h.boot(); addTearDown(h.store.dispose);
    final row = base.lightRecord(id: 'late-row');
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
      ciphertext: h.keyring.seal(entryId: row.id, plaintext: encodeBlindStorePayload(row))!)], 'next_seq': 1});
    await h.sync.syncNow();
    const other = BlindStoreRemoteBlob(id: 'other-failure', seq: 2, ciphertext: 'bytes',
      createdAtMs: 1, schemaVer: 1, deleted: false);
    await h.cursor.saveRetry(base.kAccount, other);
    final storage = (await h.cursor.loadRetries(base.kAccount)).firstWhere((b) => b.id == row.id);
    expect(h.cursor.shouldRetry(base.kAccount, storage), isFalse);
    await h.store.saveExternalRecord(base.lightRecord(id: 'local-write', origin: 'paired'));
    h.sync.storageRecovered();
    expect(h.cursor.shouldRetry(base.kAccount, storage), isTrue);
    expect(h.cursor.shouldRetry(base.kAccount, other), isFalse,
      reason: 'a local write proves nothing about other failures');
  });

  test('attached cloud leg retries after five quiet seconds following a local write', () async {
    const int nowMs = 0; final p = _Refuses();
    final h = base.Harness(persistence: p, nowMs: () => nowMs);
    await h.boot(); addTearDown(h.store.dispose);
    final joins = ValueNotifier<int>(0); addTearDown(joins.dispose);
    final leg = BlindStoreCloudLeg(keyring: h.keyring, sync: h.sync, roomJoins: joins,
      provisioner: BlindStoreKeyProvisioner(keyring: h.keyring, client: _UnusedKeymeta(),
        accountKey: () => base.kAccount));
    addTearDown(leg.dispose);
    final row = base.lightRecord(id: 'late-row');
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
      ciphertext: h.keyring.seal(entryId: row.id, plaintext: encodeBlindStorePayload(row))!)], 'next_seq': 1});
    leg.attach();
    for (int i = 0; i < 500 && leg.lastReport == null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
    expect(leg.lastReport?.failure, isNotNull);
    p.fail = false;
    h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1));
    await h.store.saveExternalRecord(base.lightRecord(id: 'local-write', origin: 'paired'));
    for (int i = 0; i < 6500 && await p.loadById(row.id) == null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
    expect(await p.loadById(row.id), isNotNull, reason: 'local storage recovery triggers the real subscribed cloud leg');
  });

  test('a transient failure longer than 31 minutes must not lose the cloud row forever', () async {
    int nowMs = 0; final p = _Refuses();
    final h = base.Harness(persistence: p, nowMs: () => nowMs);
    await h.boot(); addTearDown(h.store.dispose);
    final row = base.lightRecord(id: 'late-row');
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
      ciphertext: h.keyring.seal(entryId: row.id, plaintext: encodeBlindStorePayload(row))!)], 'next_seq': 1});
    await h.sync.syncNow();
    for (int i = 0; i < 8; i++) {
      nowMs += 20 * 60 * 1000;
      h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1)); await h.sync.syncNow();
    }
    p.fail = false; nowMs += 7 * 24 * 60 * 60 * 1000;
    h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1)); await h.sync.syncNow();
    expect(await p.loadById(row.id), isNotNull, reason: 'the note must eventually reach this phone');
    expect(h.store.recoveryFailures.noticeTicket, isNull);
  });

  test('persisted backoff caps at thirty minutes and resets on app start', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    int nowMs = 0;
    final cursor = SharedPrefsBlindStoreCursorStore(prefs, nowMs: () => nowMs);
    const blob = BlindStoreRemoteBlob(id: 'persisted', seq: 1, ciphertext: 'cipher',
      createdAtMs: 1, schemaVer: 1, deleted: false);
    for (int i = 0; i < 20; i++) {
      await cursor.saveRetry('a', blob);
      expect(cursor.shouldRetry('a', blob), isFalse);
      nowMs += 30 * 60 * 1000;
      expect(cursor.shouldRetry('a', blob), isTrue);
    }
    await cursor.saveRetry('a', blob);
    final restarted = SharedPrefsBlindStoreCursorStore(prefs, nowMs: () => nowMs);
    expect(await restarted.loadRetries('a'), hasLength(1));
    expect(restarted.shouldRetry('a', blob), isTrue);
    await restarted.saveRetry('a', blob);
    nowMs += 60000;
    expect(restarted.shouldRetry('a', blob), isTrue, reason: 'restart resets the ladder too');
    expect(await restarted.loadRetries('b'), isEmpty);
  });

  test('successful local write resets retry and the standing notice clears only after success', () async {
    const int nowMs = 0; final p = _Refuses();
    final h = base.Harness(persistence: p, nowMs: () => nowMs);
    await h.boot(); addTearDown(h.store.dispose);
    final row = base.lightRecord(id: 'late-row');
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
      ciphertext: h.keyring.seal(entryId: row.id, plaintext: encodeBlindStorePayload(row))!)], 'next_seq': 1});
    await h.sync.syncNow();
    final ticket = h.store.recoveryFailures.noticeTicket;
    h.store.recoveryFailures.dismissNotice();
    expect(h.store.recoveryFailures.noticeTicket, ticket, reason: 'a failing cloud row remains visible');
    p.fail = false;
    await h.store.saveExternalRecord(base.lightRecord(id: 'local-write', origin: 'paired'));
    h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1));
    await h.sync.syncNow();
    expect(await p.loadById(row.id), isNotNull);
    expect(h.store.recoveryFailures.noticeTicket, isNull);
  });
}
