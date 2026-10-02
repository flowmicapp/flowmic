import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'support/article_rig.dart';

void main() {
  testWidgets('resolving the cloud row makes a remaining recovery notice dismissible immediately', (tester) async {
    final rig = ArticleRig();
    try {
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller,
        historySource: rig.persistence, isCloudInstance: true)));
      rig.store.recoveryFailures.recordOnce('unreadable-row');
      rig.store.recoveryFailures.recordPersistent('cloud-row');
      await tester.pump();
      final close = find.descendant(of: find.byType(BannerSlot), matching: find.byIcon(Icons.close));
      expect(close, findsNothing);
      rig.store.recoveryFailures.forgetDeletedEntries(['cloud-row']);
      await tester.pump();
      expect(close, findsOneWidget);
    } finally {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    }
  });

  testWidgets('one standing cloud notice survives the timer and clears after every row succeeds', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final settings = AppSettingsController(prefs: await SharedPreferences.getInstance());
    await settings.load(); settings.setLocale(AppLocale.en); addTearDown(settings.dispose);
    final strings = AppStrings.of(AppLocale.en);
    final rig = ArticleRig();
    try {
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller,
        appSettings: settings, historySource: rig.persistence, isCloudInstance: true)));
      rig.store.recoveryFailures.recordPersistent('row-one');
      rig.store.recoveryFailures.recordPersistent('row-two');
      await tester.pump();
      final warning = find.descendant(of: find.byType(BannerSlot), matching: find.text(strings.timelineRecoveryFailed));
      expect(warning, findsOneWidget);
      expect(find.descendant(of: find.byType(BannerSlot), matching: find.byIcon(Icons.close)), findsNothing);
      await tester.pump(const Duration(seconds: 5));
      expect(warning, findsOneWidget);
      rig.store.recoveryFailures.forgetDeletedEntries(['row-one']);
      await tester.pump();
      expect(warning, findsOneWidget, reason: 'another row is still failing');
      rig.store.recoveryFailures.forgetDeletedEntries(['row-two']);
      await tester.pump();
      expect(warning, findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    }
  });
}
