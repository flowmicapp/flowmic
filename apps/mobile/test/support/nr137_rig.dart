// NR-137 — the shared rig for the storage-proof tests: a retained article on
// the real chain (`Rc3Rig` → `PendingRecoveryStore.retryNow`), and an adapter
// that only switches which SHIPPED backend the rig calls, as an app reopen
// would. The adapter forwards every read, write, scan and delete; it injects
// no fault.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'di.dart';
import 'fakes.dart';
import 'rc3_rig.dart';

String nr137V3Key(String id) =>
    'flowmic.timeline.pending.v3.${Uri.encodeComponent(id)}';
String nr137V2Key(String id) =>
    'flowmic.timeline.row.v2.${Uri.encodeComponent(id)}';

class Nr137BackendSlot
    implements TimelinePersistence, TimelineVerifiedReads, TimelineKeyedPersistence {
  Nr137BackendSlot(this.current);
  TimelinePersistence current;
  @override
  Future<List<TimelineEntry>> loadAll() => current.loadAll();
  @override
  Future<TimelineEntry?> readRecord(String id) => current.loadById(id);
  @override
  Future<TimelineInventory> loadInventory() => current.inventory();
  @override
  Future<bool> mayHoldRow(String id) =>
      (current as TimelineVerifiedReads).mayHoldRow(id);
  @override
  Future<void> upsert(TimelineEntry row) => current.upsert(row);
  @override
  Future<void> delete(String id) => current.delete(id);
  @override
  Future<void> saveAll(List<TimelineEntry> rows) => current.saveAll(rows);
  @override
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit}) =>
      current.loadPage(before: before, limit: limit);
  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 1000}) =>
      current.search(query, limit: limit);
}

Future<SharedPreferences> nr137EmptyPrefs() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return SharedPreferences.getInstance();
}

/// A four-second article kept `settled_unverified` with two paragraphs and
/// its PCM; a recovery answers the whole recording.
Future<Rc3Rig> nr137Article(TimelinePersistence p) async {
  final Rc3Rig r = await Rc3Rig.open(persistence: p);
  addTearDown(r.dispose);
  r.relay.onStop = (Rc3Stop stop) {
    Future<void>.delayed(
        const Duration(milliseconds: 20),
        () => r.relay.pushIncoming(
            FlowMicEvents.sttFinal,
            stop.recovery
                ? r.relay.terminal(stop,
                    text: 'Verified new whole recording', durationMs: 4000)
                : r.relay.terminal(stop,
                    text: '', durationMs: 0, segmentIdx: 2,
                    endedNormally: false)));
  };
  await r.begin();
  await r.feedMs(4000);
  await r.segment('First earlier visible paragraph', 0, 2000);
  await r.segment('Second earlier visible paragraph', 1, 2000);
  await r.controller.pttUp();
  await r.untilAsync(() async =>
      (await r.manifest())?.recoveryState ==
      RecoveryQueueState.settledUnverified);
  for (final TimelineEntry row in r.rows) {
    await r.timeline.awaitPersisted(row.id);
  }
  expect(r.rows, hasLength(2));
  expect(r.pcmPresent, isTrue);
  return r;
}

Future<PendingRetryOutcome> nr137Press(Rc3Rig r) async {
  final PendingRecoveryStore pending = PendingRecoveryStore(
      runner: r.controller.backfill, sourceLang: () => 'zh');
  final PendingRetryOutcome out =
      await pending.retryNow((await pending.list()).single);
  await r.recoveries(1);
  return out;
}

/// [row]'s JSON with `duration_ms` a string: the production decoder rejects it.
Map<String, Object?> nr137Undecodable(TimelineEntry row) =>
    Map<String, Object?>.from(row.toJson())
      ..['duration_ms'] = 'undecodable-duration';

/// A relay that serves [blobs] to a pull and acks every push.
class Nr137CloudRelay extends FakeSocketTransport {
  Nr137CloudRelay(this.blobs);
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
      return <String, Object?>{'blobs': blobs, 'next_seq': blobs.length + 1} as R;
    }
    return super.emitWithAck<R>(event, payload, timeout: timeout);
  }
}

/// A keyring enrolled from a test-only input (no real key material).
Future<BlindStoreKeyring> nr137Keyring() async {
  final BlindStoreKeyring keyring = BlindStoreKeyring(
      store: InMemoryBlindStoreKeyStore(),
      cost: Argon2Cost.reducedForTestsOnly(memoryKiB: 64, iterations: 1, lanes: 1));
  await keyring.enroll('nr137-test-only-input');
  return keyring;
}

/// The shipped pull and merge over [persistence], for [account].
BlindStoreCloudSync nr137CloudSync({
  required BlindStoreKeyring keyring,
  required Nr137CloudRelay relay,
  required TimelinePersistence persistence,
  required Rc3Rig rig,
  required BlindStoreCursorStore cursor,
  required String account,
}) =>
    BlindStoreCloudSync(
        keyring: keyring,
        client: BlindStoreCloudClient(transport: relay),
        state: InMemoryBlindStoreCloudStateStore(),
        bridge: BlindStoreTimelineBridge(
            persistence: persistence,
            store: rig.timeline,
            reaper: newTestReaper(persistence: persistence),
            reload: rig.timeline.load),
        cursor: cursor,
        isCloudRelay: () => true,
        accountKey: () => account,
        keymetaConfirmed: () async => true);

/// The wire form of [ciphertext] sealed for [row].
Map<String, Object?> nr137Blob(TimelineEntry row, String ciphertext,
        {required int seq, required int schemaVer}) =>
    <String, Object?>{
      'id': row.id,
      'seq': seq,
      'ciphertext': ciphertext,
      'created_at': row.createdAt.millisecondsSinceEpoch,
      'schema_ver': schemaVer,
      'deleted': false,
    };

String nr137RetryKey(String account, String id) =>
    '${SharedPrefsBlindStoreCursorStore.kPrefix}retry.'
    '${Uri.encodeComponent(account)}.${Uri.encodeComponent(id)}';
