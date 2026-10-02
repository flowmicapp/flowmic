import 'dart:io';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_recovery_failures.dart';
import 'support/temp_teardown.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/article_rig.dart';

void main() {
  test('fallback import reports its corruption count and respects persisted dismissal on later opens', () async {
    sqfliteFfiInit();
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true,
      'flowmic.timeline.pending.v3.broken': '{broken'});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('corruption-ack-');
    addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    for (int launch = 0; launch < 3; launch++) {
      if (launch == 2) await prefs.setString('flowmic.timeline.pending.v3.new-broken', '{broken');
      final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
      expect(opened.kind, TimelineStorageKind.sqlite);
      expect(opened.corruptionCounts['fallback_unreadable_rows'], launch == 2 ? 2 : 1);
      final failures = TimelineRecoveryFailures(prefs: prefs);
      failures.reportStorageOpen(opened.failure, opened.corruptionRowIds);
      expect(failures.noticeTicket, launch == 1 ? isNull : isNotNull);
      if (launch == 0) {
        failures.dismissNotice(); await failures.acknowledgement;
        expect(prefs.getString('${TimelineRecoveryFailures.acknowledgementPrefix}fallback_unreadable_rows'), matches(RegExp(r'^[a-f0-9]{64}$')));
      }
      failures.dispose();
      await (opened.persistence as SqfliteTimelinePersistence).close();
    }
    expect(prefs.getString('flowmic.timeline.pending.v3.broken'), '{broken');
  });

  testWidgets('first corruption is dismissible; restart stays quiet until identity or kind changes', (tester) async {
    SharedPreferences.setMockInitialValues({
      'flowmic.timeline.migrated.sqlite.v1': true,
      'flowmic.timeline.pending.v3.broken': '{broken',
    });
    final prefs = await SharedPreferences.getInstance();
    final settings = AppSettingsController(prefs: prefs);
    await settings.load(); settings.setLocale(AppLocale.en);
    addTearDown(settings.dispose);
    final strings = AppStrings.of(AppLocale.en);
    ArticleRig rig = ArticleRig(persistence: SharedPrefsTimelinePersistence(prefs), recoveryPrefs: prefs);
    Future<void> mount() async {
      await rig.store.load();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller,
        appSettings: settings, historySource: rig.persistence, isCloudInstance: true)));
      await tester.pump();
    }
    final warning = find.descendant(of: find.byType(BannerSlot), matching: find.text(strings.timelineRecoveryFailed));
    final close = find.descendant(of: find.byType(BannerSlot), matching: find.byIcon(Icons.close));
    Future<void> dismiss() async {
      expect(close, findsOneWidget);
      await tester.tap(close);
      await tester.runAsync(() => rig.store.recoveryFailures.acknowledgement);
      await tester.pump();
      expect(warning, findsNothing);
    }
    try {
      await mount();
      expect(warning, findsOneWidget, reason: 'first corruption must be visible');
      await tester.pump(const Duration(seconds: 5));
      expect(warning, findsOneWidget, reason: 'only user dismissal acknowledges corruption');
      await dismiss();
      expect(prefs.getString('flowmic.timeline.pending.v3.broken'), '{broken');
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
      await prefs.reload();
      rig = ArticleRig(persistence: SharedPrefsTimelinePersistence(prefs), recoveryPrefs: prefs);
      await mount();
      expect(warning, findsNothing, reason: 'acknowledgement survives a new store and controller');
      await prefs.setString('flowmic.timeline.pending.v3.new-broken', '{new-broken');
      await rig.store.load(); await tester.pump();
      expect(warning, findsOneWidget, reason: 'larger count is a new problem');
      await dismiss();
      rig.store.recoveryFailures.recordCorruption('unreadable-retries:account', ['broken']);
      await tester.pump();
      expect(warning, findsOneWidget, reason: 'new corruption kind is a new problem');
      await dismiss();
    } finally {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    }
  });
}
