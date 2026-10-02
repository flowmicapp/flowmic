import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_channel_page.dart';
import 'package:flowmic/src/mcp/mcp_page.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/local_record_persistence.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'support/inset_geometry.dart';

void main() {
  sqfliteFfiInit();
  late SqfliteTimelinePersistence persistence;
  late McpService service;
  late AppSettingsController settings;
  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    settings = AppSettingsController(prefs: prefs);
    await settings.load();
    persistence =
        (await openTimelinePersistence(
              prefs: prefs,
              factory: databaseFactoryFfi,
              path: inMemoryDatabasePath,
            )).persistence
            as SqfliteTimelinePersistence;
    for (int i = 0; i < 2; i++) {
      await persistence.mcp.saveChannel(
        McpChannel(
          id: 'c$i',
          name: '配置$i',
          hostHint: 'fixture.invalid',
          tool: 'submit',
          inputSchema: const <String, Object?>{'type': 'object'},
          mapping: const <String, Object?>{},
          generation: i + 1,
          authorized: i == 1,
          paused: i == 1,
          state: i == 1 ? McpChannelState.paused : McpChannelState.saved,
        ),
      );
    }
    for (int i = 0; i < 10; i++) {
      await persistence.saveLocalRecord(
        TimelineEntry(
          id: 'h$i',
          clientId: 'h$i',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          sourceText: '历史$i',
          outputText: '历史$i',
          status: EntryStatus.noted,
          origin: 'cloud',
          createdAt: DateTime(2026).add(Duration(minutes: i)),
          updatedAt: DateTime(2026),
        ),
        source: LocalRecordSource.birthReady,
      );
    }
    service = McpService(store: persistence.mcp);
  });
  tearDown(() async {
    service.dispose();
    settings.dispose();
    await persistence.close();
  });

  Future<void> finish(WidgetTester tester) async {
    for (int i = 0; i < 4; i++) {
      await tester.runAsync(() => persistence.mcp.db.rawQuery('select 1'));
      await tester.pump();
    }
    await tester.pumpWidget(const SizedBox.shrink());
  }

  for (final InsetCase c in insetCases) {
    testWidgets('MCP populated list final action safe ${c.name}', (
      WidgetTester tester,
    ) async {
      c.apply(tester);
      await tester.pumpWidget(
        c.app(McpPage(service: service, settings: settings)),
      );
      await tester.pumpAndSettle();
      final Finder lastEdit = find.byKey(const ValueKey<String>('mcp.edit.c1'));
      await reveal(tester, lastEdit);
      expectInside(tester, lastEdit, c);
      final Finder add = find.byKey(const ValueKey<String>('mcp.add'));
      await reveal(tester, add);
      expectInside(tester, add, c);
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(find.byType(McpChannelPage), findsOneWidget);
      expect(tester.takeException(), isNull);
      await finish(tester);
    });
    testWidgets('MCP editor final action safe ${c.name}', (
      WidgetTester tester,
    ) async {
      c.apply(tester);
      await tester.pumpWidget(
        c.app(
          McpChannelPage(
            service: service,
            settings: settings,
            channel: service.channels.last,
          ),
        ),
      );
      for (int i = 0; i < 10; i++) {
        await tester.runAsync(() => persistence.mcp.db.rawQuery('select 1'));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      final Finder enable = find.byKey(const ValueKey<String>('mcp.enable'));
      await reveal(tester, enable);
      expectInside(tester, enable, c);
      final Finder lastHistory = find.byKey(
        const ValueKey<String>('mcp.job.h0'),
      );
      await reveal(tester, lastHistory);
      expectInside(tester, lastHistory, c);
      if (c.ime > 0) {
        tester.view.viewInsets = FakeViewPadding.zero;
        tester.view.padding = FakeViewPadding(
          top: c.top,
          left: c.left,
          right: c.right,
          bottom: c.bottom,
        );
        await tester.pumpAndSettle();
        await reveal(tester, lastHistory);
        expectInside(
          tester,
          lastHistory,
          InsetCase('dismissed', bottom: c.bottom),
        );
      }
      expect(tester.takeException(), isNull);
      await finish(tester);
    });
  }
}
