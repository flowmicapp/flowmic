// Actual SettingsPage -> MCP configuration -> consent -> durable submission
// results. Network seam replays captured OFFICIAL SDK bytes; TLS is covered by
// mcp_submission_integration_test.dart, not claimed by this widget test.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_copy.dart';
import 'package:flowmic/src/mcp/mcp_page.dart';
import 'package:flowmic/src/mcp/mcp_scope.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/mcp/mcp_secrets.dart';
import 'package:flowmic/src/mcp/mcp_transport.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/ui/settings_page.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';

import 'support/article_rig.dart';
import 'support/di.dart';
import 'support/cloud_summary_fakes.dart';
import 'support/portable_fakes.dart';
import 'support/settings_fakes.dart';
import 'support/update_fakes.dart';

class _Captured implements McpTransport {
  _Captured() {
    final Map raw = jsonDecode(File('test/fixtures/mcp_sdk_responses.json').readAsStringSync()) as Map;
    captures = <String, Map>{for (final Map c in (raw['exchanges'] as List).cast<Map>()) c['name'] as String: c};
  }
  late Map<String, Map> captures;
  final List<String> methods = <String>[];
  String mode = 'modern-success';
  int get calls => methods.where((String m) => m == 'tools/call').length;
  @override
  Future<McpReply> request({required Uri endpoint, required Map<String, Object?> message,
    required String version, required String? token, required String? session}) async {
    final String method = message['method']! as String;
    methods.add(method);
    final Map capture = captures[mode == 'auth-required' ? mode : method == 'server/discover' ? 'modern-discover' : method == 'tools/list' ? 'modern-tools' : mode]!;
    return decodeMcpReply(status: capture['status'] as int, headers: (capture['headers'] as Map).cast<String, String>(),
      body: (capture['body'] as String).replaceAll('"id":${(capture['request'] as Map)['id']}', '"id":${message['id']}'),
      id: message['id'], toolCall: method == 'tools/call');
  }
}

void main() {
  sqfliteFfiInit();
  late Directory folder;
  late SqfliteTimelinePersistence persistence;
  late ArticleRig rig;
  late AppSettingsController settings;
  late ScenarioCardController scenario;
  late LoginController login;
  late McpService service;
  late _Captured captured;
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('mcp-screen-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    persistence = (await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: '${folder.path}/timeline.db')).persistence as SqfliteTimelinePersistence;
    rig = ArticleRig(persistence: persistence);
    settings = AppSettingsController(prefs: prefs); await settings.load(); settings.setLocale(AppLocale.en);
    scenario = ScenarioCardController(cache: InMemoryScenarioCardCache()); await scenario.load();
    login = newTestLogin(transport: rig.session.transport);
    captured = _Captured(); service = McpService(store: persistence.mcp, transport: captured);
    service.attach(networkReturned: const Stream<void>.empty());
  });
  tearDown(() async {
    service.dispose(); login.dispose(); scenario.dispose(); settings.dispose();
    await rig.dispose(); await persistence.close(); await folder.delete(recursive: true);
  });
  AppStrings getStrings() => AppStrings.of(settings.locale);
  Future<void> settle(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 450));
    for (int i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 15)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }
  Future<void> tap(WidgetTester tester, Finder target) async {
    await tester.ensureVisible(target); await tester.tap(target); await settle(tester);
  }
  Future<void> mountSettings(WidgetTester tester) async {
    tester.view.physicalSize = const Size(800, 2400); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(builder: (_, Widget? child) => McpScope(service: service, settings: settings, child: child!),
      home: SettingsPage(scenario: scenario, appSettings: settings, login: login,
        destination: rig.controller.destination, session: rig.session, portable: newTestPortableController(),
        prefs: newTestPrefsController(), backup: newTestSettingsBackup(), inventory: newTestInventory(rows: const <TimelineEntry>[], images: InMemoryOutboxBlobStore()),
        timeline: rig.store, version: const FixedAppVersion('test'), update: newTestUpdateController(), cloudSummary: newTestCloudSummary(login: login))));
    await settle(tester);
    await tap(tester, find.byKey(const ValueKey<String>('settings.mcp')));
  }

  Future<McpChannel> enabled() async {
    final Map result = (jsonDecode(captured.captures['modern-tools']!['body'] as String) as Map)['result'] as Map;
    final Map tool = (result['tools'] as List).first as Map;
    final McpChannel channel = await service.configure(name: 'Fixture', tool: 'submit', schema: (tool['inputSchema'] as Map).cast<String, Object?>(),
      mapping: <String, Object?>{'/payload/text': <String, Object?>{'source': 'outputText'}, '/kind': <String, Object?>{'source': 'fixed', 'value': 'record'}},
      credential: McpSecrets(endpoint: Uri.parse('https://fixture.invalid/secret-path'), token: null, fixed: <String, Object?>{}));
    expect((await service.testChannel(channel.id)).succeeded, true);
    await service.enable(channel.id);
    return service.channels.single;
  }
  Future<TimelineEntry> birth(String text, {bool ready = true}) async {
    final TimelineEntry row = rig.store.buildFromUtterance(clientId: text, mode: FlowMode.realtime,
      delivery: Delivery.none, text: text, origin: 'cloud', mcpContentReady: ready);
    await rig.store.awaitPersisted(row.id); return row;
  }
  Future<void> openManual(WidgetTester tester, TimelineEntry row) async {
    await tester.pumpWidget(const SizedBox.shrink());
    tester.view.physicalSize = const Size(800, 2400); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(builder: (_, Widget? child) => McpScope(service: service, settings: settings, child: child!),
      home: ChatFlowPage(controller: rig.controller, appSettings: settings)));
    await settle(tester);
    await tester.longPress(find.text(row.outputText).first); await settle(tester);
    expect(find.byType(BottomSheet), findsOneWidget);
    await tap(tester, find.text(getStrings().mcp(McpText.manual)).last);
  }

  testWidgets('real settings: readonly discovery, typed nested mapping, consent, visible tool result and changed local content', (WidgetTester tester) async {
    await mountSettings(tester);
    expect(find.text(getStrings().mcp(McpText.unconfigured)), findsOneWidget);
    expect(captured.methods, isEmpty);
    expect(await tester.runAsync(() => persistence.mcp.db.query('mcp_local_records')), isEmpty);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.add')));
    await tester.enterText(find.byKey(const ValueKey<String>('mcp.endpoint')), 'https://fixture.invalid/private-url-secret');
    await settle(tester);
    // SQLite runs on a real isolate. Bound the wait by the observable saved
    // state, not a fixed wall-clock assumption under parallel gate load.
    for (int i = 0; service.channels.isEmpty && i < 30; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    expect(service.channels, hasLength(1));
    expect(service.channels.single.authorized, false);
    expect(captured.methods, isEmpty);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
    expect(captured.calls, 0);
    final Finder tool = find.byWidgetPredicate((Widget w) => w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('mcp.tool.'));
    await tap(tester, tool);
    await tap(tester, find.text('submit').last);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
    expect(find.text(getStrings().mcp(McpText.mappingInvalid, field: '/payload/text')), findsOneWidget);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.source./payload/text')));
    await tap(tester, find.text(getStrings().mcp(McpText.outputText)).last);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.source./kind')));
    await tap(tester, find.text(getStrings().mcp(McpText.sourceFixed)).last);
    expect(find.byKey(const ValueKey<String>('mcp.enum./kind')), findsOneWidget);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
    expect(find.text(getStrings().mcp(McpText.testPassed)), findsOneWidget);
    expect(captured.calls, 0);
    expect(service.channels.single.authorized, false);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.enable')));
    expect(find.textContaining('fixture.invalid'), findsWidgets);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.textContaining('private-url-secret')), findsNothing);
    expect(tester.widget<TextField>(find.byKey(const ValueKey<String>('mcp.endpoint'))).obscureText, true);
    expect(service.channels.single.authorized, false);
    await tap(tester, find.text(getStrings().cancel));
    expect(service.channels.single.authorized, false);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.enable')));
    await tap(tester, find.byKey(const ValueKey<String>('mcp.confirm')));
    expect(service.channels.single.canSend, true);
    late TimelineEntry entry;
    await tester.runAsync(() async {
      entry = rig.store.buildFromUtterance(clientId: 'widget-record', mode: FlowMode.realtime,
        delivery: Delivery.none, text: 'Widget record visible', origin: 'cloud', mcpContentReady: true);
      await rig.store.awaitPersisted(entry.id); await service.drain();
    });
    await settle(tester);
    expect(captured.calls, 1);
    expect(find.text('Widget record visible'), findsOneWidget);
    expect(find.text(getStrings().mcp(McpText.toolResult)), findsOneWidget);
    await tester.runAsync(() async { rig.store.applyEdit(entry.id, 'Edited locally'); await rig.store.awaitPersisted(entry.id); await service.drain(); });
    await settle(tester);
    expect(captured.calls, 1);
    expect(find.text(getStrings().mcp(McpText.localChanged)), findsOneWidget);
    expect(tester.takeException(), isNull);
    service.background(); await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('real record menu: history submission requires disclosure and remote refusal requires duplicate warning', (WidgetTester tester) async {
    final TimelineEntry row = await tester.runAsync(() => birth('Historical record')) as TimelineEntry;
    final McpChannel channel = await tester.runAsync(enabled) as McpChannel;
    await openManual(tester, row);
    final Finder submit = find.byKey(ValueKey<String>('mcp.manual.${channel.id}'));
    await tap(tester, submit);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.text('fixture.invalid')), findsOneWidget);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.text('submit')), findsOneWidget);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.textContaining('secret-path')), findsNothing);
    expect(captured.calls, 0);
    await tap(tester, find.text(getStrings().cancel));
    expect(captured.calls, 0);
    captured.mode = 'modern-refusal';
    await tap(tester, submit);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.confirm')));
    expect(captured.calls, 1);
    expect(find.text(getStrings().mcp(McpText.remoteRejected)), findsOneWidget);
    expect(find.text(getStrings().mcp(McpText.toolResult)), findsNothing);
    await tap(tester, find.text(getStrings().mcp(McpText.retry)));
    expect(find.textContaining(getStrings().mcp(McpText.unknownRetryWarning)), findsOneWidget);
    await tap(tester, find.text(getStrings().cancel));
    expect(captured.calls, 1);
    service.background(); await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('manual cannot promote unfinished content, and a changed result invalidates an open confirmation', (WidgetTester tester) async {
    final McpChannel channel = await tester.runAsync(enabled) as McpChannel;
    final TimelineEntry pending = await tester.runAsync(() => birth('Not ready', ready: false)) as TimelineEntry;
    await openManual(tester, pending);
    await tap(tester, find.byKey(ValueKey<String>('mcp.manual.${channel.id}')));
    await tap(tester, find.byKey(const ValueKey<String>('mcp.confirm')));
    expect(captured.calls, 0);
    expect(find.text(getStrings().mcp(McpText.contentNotReady)), findsOneWidget);
    service.background();
    final TimelineEntry ready = await tester.runAsync(() => birth('Ready to race')) as TimelineEntry;
    await openManual(tester, ready);
    await tap(tester, find.byKey(ValueKey<String>('mcp.manual.${channel.id}')));
    await tester.runAsync(() async { service.foreground(); await Future<void>.delayed(const Duration(milliseconds: 150)); });
    await settle(tester);
    expect(captured.calls, 1);
    await tap(tester, find.byKey(const ValueKey<String>('mcp.confirm')));
    expect(captured.calls, 1);
    expect(find.text(getStrings().mcp(McpText.unknownRetryWarning)), findsOneWidget);
    service.background(); await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('editor discovery 401 stops the channel and retesting cannot hammer the same token', (WidgetTester tester) async {
    final McpChannel channel = await tester.runAsync(enabled) as McpChannel;
    captured.mode = 'auth-required';
    await mountSettings(tester);
    await tap(tester, find.byKey(ValueKey<String>('mcp.edit.${channel.id}')));
    await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
    expect(service.channels.single.state, McpChannelState.reauthorizationRequired);
    expect(find.text(getStrings().mcp(McpText.reauthorize)), findsWidgets);
    final int count = captured.methods.length;
    await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
    expect(captured.methods.length, count);
    final FilledButton enable = tester.widget<FilledButton>(find.byKey(const ValueKey<String>('mcp.enable')));
    expect(enable.onPressed, isNull);
    service.background(); await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('narrow rendered heading, independent hint and accepted timestamp: ${locale.name}', (WidgetTester tester) async {
      final McpChannel channel = await tester.runAsync(enabled) as McpChannel;
      await tester.runAsync(() async {
        await birth('Synthetic layout record');
        await service.drain();
        final DateTime limit = DateTime.now().add(const Duration(seconds: 4));
        while (service.channels.single.lastSuccessAt == null && DateTime.now().isBefore(limit)) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      });
      expect(service.channels.single.lastSuccessAt, isNotNull);
      settings.setLocale(locale);
      tester.view.physicalSize = const Size(320, 740); tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.3)), child: child!),
        home: McpPage(service: service, settings: settings)));
      await settle(tester);
      Future<void> rendered(String key) async {
        final Finder target = find.byKey(ValueKey<String>(key));
        if (target.evaluate().isEmpty) {
          await tester.scrollUntilVisible(target, 120, scrollable: find.byType(Scrollable).first);
        }
        await tester.ensureVisible(target); await tester.pump();
        final RenderParagraph paragraph = tester.renderObject<RenderParagraph>(target);
        expect(paragraph.didExceedMaxLines, false, reason: '${locale.name} $key clipped');
        expect(paragraph.size.width, lessThanOrEqualTo(320));
        expect(paragraph.size.height, greaterThan(0));
        expect(paragraph.getMinIntrinsicWidth(double.infinity), lessThanOrEqualTo(paragraph.size.width + 0.5),
          reason: '${locale.name} $key has an unbreakable overflow');
        debugPrint('MCP_RENDER ${locale.name} $key width=${paragraph.size.width} height=${paragraph.size.height} clipped=${paragraph.didExceedMaxLines}');
      }
      await rendered('mcp.last-call-caption');
      await rendered('mcp.last-call-time');
      await tap(tester, find.byKey(ValueKey<String>('mcp.edit.${channel.id}')));
      await tap(tester, find.byKey(const ValueKey<String>('mcp.test')));
      await rendered('mcp.tool-heading');
      await rendered('mcp.tool-hint');
      final Finder dropdown = find.byWidgetPredicate((Widget w) => w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('mcp.tool.'));
      expect(tester.getTopLeft(find.byKey(const ValueKey<String>('mcp.tool-heading'))).dy,
        lessThan(tester.getTopLeft(dropdown).dy));
      expect(tester.getTopLeft(find.byKey(const ValueKey<String>('mcp.tool-hint'))).dy,
        greaterThanOrEqualTo(tester.getBottomLeft(dropdown).dy));
      expect(tester.takeException(), isNull);
      service.background(); await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
