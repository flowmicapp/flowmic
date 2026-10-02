import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'blind_store_cloud_sync_test.dart' as base;

void main() {
  test('an app version change retries unchanged ciphertext and resets the ladder', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    int nowMs = 0;
    final cursor = SharedPrefsBlindStoreCursorStore(prefs, nowMs: () => nowMs, appVersion: 'build-new');
    const blob = BlindStoreRemoteBlob(id: 'future', seq: 1, ciphertext: 'sealed-future-schema',
      createdAtMs: 1, schemaVer: 999, deleted: false);
    await cursor.saveRetry('a', blob);
    expect(cursor.shouldRetry('a', blob), isFalse);
    const key = '${SharedPrefsBlindStoreCursorStore.kPrefix}retry.a.future';
    final value = jsonDecode(prefs.getString(key)!) as Map;
    expect(value['retry_app_version'], 'build-new');
    // Load an older build's schedule in this already-running session so the
    // independent app-start reset cannot mask a missing version comparison.
    value['retry_app_version'] = 'build-old';
    value['retry_attempts'] = 6;
    value['retry_next_ms'] = 1800000;
    await prefs.setString(key, jsonEncode(value));
    expect(cursor.shouldRetry('a', blob), isTrue);
    expect((await cursor.loadRetries('a')).single.ciphertext, blob.ciphertext);
    await cursor.saveRetry('a', blob);
    nowMs += 60000;
    expect(cursor.shouldRetry('a', blob), isTrue);
  });

  test('waiting cloud rows report deferred without reporting a sync failure', () async {
    const int nowMs = 0;
    final h = base.Harness(nowMs: () => nowMs); await h.boot();
    addTearDown(h.store.dispose);
    final row = base.lightRecord(id: 'future-row');
    final payload = jsonDecode(encodeBlindStorePayload(row)) as Map;
    payload['v'] = 999;
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: row.id,
      ciphertext: h.keyring.seal(entryId: row.id, plaintext: jsonEncode(payload))!)], 'next_seq': 1});
    final first = await h.sync.syncNow();
    expect(first.failure, isNotNull);
    expect(await h.cursor.loadRetries(base.kAccount), hasLength(1));
    h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1));
    final waiting = await h.sync.syncNow();
    expect(waiting.failure, isNull, reason: 'waiting is deferred, not a new sync failure');
    expect(waiting.toDiag()['deferred'], 1);
    expect(h.store.recoveryFailures.noticeTicket, isNotNull);
  });
}
