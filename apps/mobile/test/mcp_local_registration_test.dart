// Real SQLite + the actual light-record screen pin the best-effort boundary.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/local_record_persistence.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'support/article_rig.dart';
import 'support/di.dart';

McpChannel channel({bool authorized = false}) => McpChannel(id: 'c', name: 'fixture',
  hostHint: 'fixture.invalid', tool: 'submit', inputSchema: const <String, Object?>{},
  mapping: const <String, Object?>{}, generation: 1, authorized: authorized,
  paused: false, state: authorized ? McpChannelState.enabled : McpChannelState.saved,
  testedGeneration: authorized ? 1 : null);

void main() {
  sqfliteFfiInit();
  late Directory folder;
  late SqfliteTimelinePersistence persistence;
  late TimelineStore timeline;
  late McpStore journal;
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('mcp-local-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final TimelineStorageOpen opened = await openTimelinePersistence(
      prefs: await SharedPreferences.getInstance(), factory: databaseFactoryFfi,
      path: '${folder.path}/timeline.db');
    persistence = opened.persistence as SqfliteTimelinePersistence;
    journal = persistence.mcp;
    timeline = newTestStore(persistence: persistence);
    DiagLog.instance.clear();
  });
  tearDown(() async {
    timeline.dispose();
    await persistence.close();
    await folder.delete(recursive: true);
  });

  Future<TimelineEntry> birth(String id, {bool ready = true}) async {
    final TimelineEntry entry = timeline.buildFromUtterance(clientId: id,
      mode: FlowMode.realtime, delivery: Delivery.none, text: id,
      origin: 'cloud', mcpContentReady: ready);
    await timeline.awaitPersisted(entry.id);
    return entry;
  }

  test('unconfigured and saved-only have zero registry; enabled positive control registers once', () async {
    await birth('zero');
    expect(await journal.db.query('mcp_local_records'), isEmpty);
    await journal.saveChannel(channel());
    await birth('saved-only');
    expect(await journal.db.query('mcp_local_records'), isEmpty);
    await journal.tested('c', 1);
    await journal.enable('c', 1);
    final TimelineEntry row = await birth('armed');
    await persistence.saveLocalRecord(row, source: LocalRecordSource.birthReady);
    timeline.applyEdit(row.id, 'edit');
    await timeline.awaitPersisted(row.id);
    expect((await journal.db.query('mcp_local_records')).length, 1);
    expect((await journal.submissions('c')).length, 1);
    // Import/merge use the generic upsert, even for an otherwise eligible row.
    await persistence.upsert(TimelineEntry(id: 'imported', clientId: 'imported',
      mode: FlowMode.realtime, delivery: Delivery.none, sourceText: 'import', outputText: 'import',
      origin: 'cloud', status: EntryStatus.noted, createdAt: row.createdAt, updatedAt: row.updatedAt));
    expect((await journal.db.query('mcp_local_records')).length, 1);
    await journal.removeChannel('c');
    await birth('after-removal');
    expect(journal.armedTargets, isEmpty);
    expect(await journal.db.query('mcp_local_records'), isEmpty);
    expect(await journal.db.query('mcp_submissions'), isEmpty);
  });

  test('content readiness follows birth order; edits and refinements cannot enroll history', () async {
    await journal.saveChannel(channel(authorized: true));
    final TimelineEntry row = timeline.buildFromUtterance(clientId: 'compose',
      mode: FlowMode.organize, delivery: Delivery.none, text: 'raw', origin: 'cloud');
    timeline.applyProcessed(row.id, 'finished', FlowMode.organize);
    await timeline.awaitPersisted(row.id);
    expect((await journal.db.query('mcp_local_records')).single['ready'], 1);
    await journal.removeChannel('c');
    await journal.saveChannel(channel(authorized: true));
    timeline.applyProcessed(row.id, 'another result', FlowMode.organize);
    await timeline.awaitPersisted(row.id);
    expect(await journal.db.query('mcp_local_records'), isEmpty);
  });

  test('401 revokes the tested generation; pause then enable cannot bypass reauthorization', () async {
    await journal.saveChannel(channel(authorized: true));
    await birth('pending');
    await journal.setState('c', 1, McpChannelState.reauthorizationRequired);
    await journal.pause('c');
    await expectLater(journal.enable('c', 1), throwsStateError);
    expect(journal.channels.single.state, McpChannelState.reauthorizationRequired);
    expect((await journal.submissions('c')).single['state'], 'pending');
  });

  test('age eviction is audited per row and counted; TimelineReaper also removes the audit', () async {
    await journal.saveChannel(channel(authorized: true));
    await journal.pause('c');
    final TimelineEntry row = await birth('expired');
    await journal.db.update('mcp_local_records', <String, Object?>{'registered_at': 1});
    await journal.maintain();
    expect(journal.channels.single.expiredCount, 1);
    expect((await journal.db.query('mcp_evictions')).single['reason'], 'age_pending');
    expect(await journal.db.query('mcp_submissions'), isEmpty);
    expect(await persistence.loadAll(), hasLength(1));
    await newTestReaper(persistence: persistence).reap(<TimelineEntry>[row]);
    expect(await persistence.loadAll(), isEmpty);
    expect(await journal.db.query('mcp_local_records'), isEmpty);
    expect(await journal.db.query('mcp_evictions'), isEmpty);
  });

  testWidgets('registration INSERT throws: local commit persists and stays visible on ChatFlowPage', (WidgetTester tester) async {
    final ArticleRig rig = ArticleRig(persistence: persistence);
    await tester.runAsync(() async {
      await journal.saveChannel(channel(authorized: true));
      await journal.db.execute("CREATE TRIGGER break_registration BEFORE INSERT ON mcp_local_records BEGIN SELECT RAISE(ABORT, 'registration fault'); END");
      await rig.controller.delivery.deliverText('local record survives', covered: const <String>[]);
      await rig.store.awaitPersisted(rig.store.entries.single.id);
      expect((await persistence.loadAll()).single.outputText, 'local record survives');
      expect(journal.available, isFalse);
      expect(DiagLog.instance.snapshot().join('\n'), contains('register_local'));
    });
    await mountLightRecordScreen(tester, rig);
    expect(find.text('local record survives'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(rig.dispose);
  });

  test('capacity eviction keeps primary rows and bounded per-row audit with pruned count', () async {
    await journal.saveChannel(channel(authorized: true));
    for (int i = 0; i < 5; i++) { await birth('row-$i'); }
    final McpStore bounded = McpStore(journal.db, limits: const McpLimits(
      registrations: 3, pendingPerChannel: 1, auditRows: 1));
    await bounded.initialize();
    expect(await persistence.loadAll(), hasLength(5));
    expect(await journal.db.query('mcp_local_records'), hasLength(3));
    expect(await journal.db.query('mcp_submissions', where: "state = 'pending'"), hasLength(1));
    expect(await journal.db.query('mcp_evictions'), hasLength(1));
    expect((await journal.db.query('mcp_maintenance')).single['audit_pruned'], 3);
    expect(bounded.channels.single.expiredCount, 4);
    bounded.dispose();
  });

  test('local minting guard: all production births reach the required-source persistence method', () {
    final String store = File('lib/src/timeline/timeline_store.dart').readAsStringSync()
      .split('\n').where((String line) => !line.trimLeft().startsWith('//')).join('\n');
    expect(RegExp(r'_persistence\.upsert\(').allMatches(store), isEmpty);
    expect(RegExp(r'_persistence\.saveLocalRecord\(entry, source: source\)').allMatches(store), hasLength(1));
    expect(store, contains('void _persistOne(TimelineEntry entry, {required LocalRecordSource source})'));
    final Set<String> callers = Directory('lib/src').listSync(recursive: true).whereType<File>()
      .where((File f) => f.path.endsWith('.dart') && RegExp(r'\w+\.buildFromUtterance\(').hasMatch(f.readAsStringSync()))
      .map((File f) => f.uri.pathSegments.last).toSet();
    expect(callers, <String>{'chat_mode_chip.dart', 'chat_utterance_processing.dart',
      'chat_utterance_settle.dart', 'image_send_controller.dart', 'manual_delivery.dart', 'manual_delivery_noted.dart'});
    // Every known transcript producer names readiness, including the pending
    // reprocess path. Image readiness is pinned at the single store classifier.
    for (final String path in <String>['chat_mode_chip', 'chat_utterance_processing', 'chat_utterance_settle', 'manual_delivery_noted']) {
      expect(File('lib/src/session/$path.dart').readAsStringSync(), contains('mcpContentReady:'));
    }
    expect(store, contains('mcpContentReady || entryType == TimelineEntry.kImage'));
  });
}
