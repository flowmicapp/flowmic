import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'blind_store_cloud_sync_test.dart' as base;

void main() {
  test('one undecryptable cloud row leaves a dismissible unreadable notice', () async {
    int nowMs = 0;
    final h = base.Harness(nowMs: () => nowMs);
    await h.boot(); addTearDown(h.store.dispose);
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: 'foreign-row',
      ciphertext: 'e2e:v1:not-a-valid-envelope')], 'next_seq': 1});
    await h.sync.syncNow();
    int repeatedDecryptions = 0;
    for (int i = 0; i < 10; i++) {
      nowMs += 24 * 60 * 60 * 1000;
      h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1));
      final report = await h.sync.syncNow();
      repeatedDecryptions += report.undecryptable;
    }
    h.store.recoveryFailures.dismissNotice();
    await h.store.recoveryFailures.acknowledgement;
    expect(h.store.recoveryFailures.hasPersistentFailures, isFalse);
    expect(h.store.recoveryFailures.noticeTicket, isNull);
    expect(repeatedDecryptions, 0, reason: 'unreadable bytes wait for another app version');
    expect((await h.cursor.loadRetries(base.kAccount)).single.ciphertext, 'e2e:v1:not-a-valid-envelope');
    h.transport.ackQueue.add(base.Harness.emptyPull(nextSeq: 1));
    await h.sync.syncNow();
    expect(h.store.recoveryFailures.noticeTicket, isNull);
  });

  test('the link-down banner stays primary ahead of all timeline failures', () {
    for (final persistent in [false, true]) {
      final q = buildChatBanners(connection: ConnectionState.disconnected, autoStopped: false,
        strings: AppStrings.of(AppLocale.en), timelineRecoveryFailure: true,
        timelineRecoveryPersistent: persistent, timelineWriteFailure: true, timelineDeleteFailure: true);
      expect(q.top?.id, BannerIds.link);
    }
  });

  test('unreadable cloud bytes stay parked across restart until the app version changes', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final cursor = SharedPrefsBlindStoreCursorStore(prefs, appVersion: 'old');
    final h = base.Harness(cursorStore: cursor); await h.boot(); addTearDown(h.store.dispose);
    h.transport.ackQueue.add({'blobs': [base.Harness.remoteBlob(id: 'foreign-row',
      ciphertext: 'e2e:v1:not-a-valid-envelope')], 'next_seq': 1});
    await h.sync.syncNow();
    final restarted = SharedPrefsBlindStoreCursorStore(prefs, appVersion: 'old');
    final blob = (await restarted.loadRetries(base.kAccount)).single;
    expect(restarted.shouldRetry(base.kAccount, blob), isFalse);
    final upgraded = SharedPrefsBlindStoreCursorStore(prefs, appVersion: 'new');
    expect(upgraded.shouldRetry(base.kAccount, blob), isTrue);
    final raw = prefs.getString(prefs.getKeys().singleWhere((key) => key.contains('retry.')))!;
    expect((jsonDecode(raw) as Map)['ciphertext'], blob.ciphertext);
  });
}
