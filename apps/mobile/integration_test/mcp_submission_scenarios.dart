// Host integration scenarios, executed by test/mcp_submission_integration_test.dart.
// Real SQLite -> production worker -> real HTTPS -> recorded official SDK bytes.
// Fault modes intentionally mutate captures; they are not SDK interoperability claims.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_secrets.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/mcp/mcp_transport.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/local_record_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../test/support/di.dart';

void mcpSubmissionScenarios() {
  sqfliteFfiInit();
  late SecurityContext tls;
  late String cert;
  late Map<String, Map<dynamic, dynamic>> captures;
  late Map<String, Object?> toolSchema;
  setUpAll(() async {
    final ProcessResult minted = await Process.run('node', <String>[
      '--experimental-strip-types', 'test/support/mint_lan_tls_identity.mjs'], runInShell: true);
    expect(minted.exitCode, 0);
    final Map<dynamic, dynamic> identity = jsonDecode(minted.stdout as String) as Map;
    cert = identity['certPem'] as String;
    tls = SecurityContext()..useCertificateChainBytes(utf8.encode(cert))
      ..usePrivateKeyBytes(utf8.encode(identity['keyPem'] as String));
    final Map<dynamic, dynamic> fixture = jsonDecode(File('test/fixtures/mcp_sdk_responses.json').readAsStringSync()) as Map;
    captures = <String, Map<dynamic, dynamic>>{for (final Map<dynamic, dynamic> e in (fixture['exchanges'] as List).cast<Map<dynamic, dynamic>>()) e['name'] as String: e};
    final Map<dynamic, dynamic> result = (jsonDecode(captures['modern-tools']!['body'] as String) as Map)['result'] as Map;
    toolSchema = ((result['tools'] as List).cast<Map<dynamic, dynamic>>().firstWhere((Map<dynamic, dynamic> t) => t['name'] == 'submit')['inputSchema'] as Map).cast<String, Object?>();
  });

  late Directory folder;
  late SqfliteTimelinePersistence persistence;
  late TimelineStore timeline;
  late McpService service;
  late HttpServer server;
  late String mode;
  late List<Map<String, Object?>> requests;
  Completer<void>? slowEntered;
  Completer<void>? quickEntered;
  Completer<void>? releaseSlow;
  final Map<String, Object?> mapping = <String, Object?>{
    '/payload/text': <String, Object?>{'source': 'outputText'},
    '/kind': <String, Object?>{'source': 'fixed', 'value': 'record'},
  };
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('mcp-integration-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final TimelineStorageOpen storage = await openTimelinePersistence(prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi, path: '${folder.path}/timeline.db');
    persistence = storage.persistence as SqfliteTimelinePersistence;
    timeline = newTestStore(persistence: persistence);
    mode = 'modern-success';
    requests = <Map<String, Object?>>[];
    server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, tls);
    server.listen((HttpRequest request) async {
      final Map<String, Object?> body = (jsonDecode(await utf8.decoder.bind(request).join()) as Map).cast<String, Object?>();
      requests.add(body);
      final bool call = body['method'] == 'tools/call';
      if (call && mode == 'slow-channel') {
        if (request.headers.value('authorization') == 'Bearer slow') {
          slowEntered!.complete();
          await releaseSlow!.future;
        } else {
          quickEntered!.complete();
        }
      }
      final String capture = body['method'] == 'server/discover' ? 'modern-discover'
        : body['method'] == 'tools/list' ? 'modern-tools'
        : mode == 'modern-refusal' ? 'modern-refusal' : mode == '401' ? 'auth-required'
        : mode == 'modern-sse' ? 'modern-sse' : 'modern-success';
      final Map<dynamic, dynamic> record = captures[capture]!;
      request.response.statusCode = record['status'] as int;
      for (final MapEntry<dynamic, dynamic> e in (record['headers'] as Map).entries) {
        if (<String>{'content-type', 'www-authenticate'}.contains(e.key)) request.response.headers.set(e.key as String, e.value as Object);
      }
      String response = (record['body'] as String).replaceAll('"id":${(record['request'] as Map)['id']}', '"id":${body['id']}');
      // Labelled fault mutation of the recorded official tool list, not an
      // invented interoperability fixture. Keep another tool to catch fallback.
      if (body['method'] == 'tools/list' && mode == 'selected-tool-removed') {
        final Map<dynamic, dynamic> changed = jsonDecode(response) as Map;
        ((changed['result'] as Map)['tools'] as List).removeWhere((Object? t) => (t! as Map)['name'] == 'submit');
        response = jsonEncode(changed);
      }
      if (call && mode == 'wrong-id') response = response.replaceAll('"id":${body['id']}', '"id":999999');
      if (call && mode == '429') {
        request.response.statusCode = 429;
        request.response.headers.set('Retry-After', '120');
      }
      if (call && mode == '503') request.response.statusCode = 503;
      request.response.write(response);
      await request.response.close();
    });
    service = McpService(store: persistence.mcp, transport: HttpMcpTransport(
      clientFactory: () => HttpClient()..badCertificateCallback =
        (X509Certificate c, String host, int port) => c.pem == cert));
    DiagLog.instance.clear();
  });
  tearDown(() async {
    service.dispose();
    timeline.dispose();
    await server.close(force: true);
    await persistence.close();
    await folder.delete(recursive: true);
  });

  McpSecrets credential([String token = 'fixture-bearer']) => McpSecrets(
    endpoint: Uri.parse('https://127.0.0.1:${server.port}/secret-url-path-key'), token: token, fixed: <String, Object?>{});
  Future<McpChannel> configure() => service.configure(name: 'SDK fixture', tool: 'submit',
    schema: toolSchema, mapping: mapping, credential: credential());
  Future<McpChannel> enable() async {
    final McpChannel channel = await configure();
    expect((await service.testChannel(channel.id)).succeeded, true);
    expect(requests.map((Map<dynamic, dynamic> r) => r['method']), isNot(contains('tools/call')));
    await service.enable(channel.id);
    return channel;
  }
  Future<TimelineEntry> birth(String text) async {
    final TimelineEntry row = timeline.buildFromUtterance(clientId: text, mode: FlowMode.realtime,
      delivery: Delivery.none, text: text, origin: 'cloud', mcpContentReady: true);
    await timeline.awaitPersisted(row.id);
    return row;
  }
  int getCalls() => requests.where((Map<dynamic, dynamic> r) => r['method'] == 'tools/call').length;

  test('zero configuration: zero real HTTPS requests and registry, enabled positive control is nonzero', () async {
    await birth('local only');
    // Observe immediately too: maintenance must not conceal an illegal birth.
    expect(await persistence.mcp.db.query('mcp_local_records'), isEmpty);
    await service.drain();
    expect(requests, isEmpty);
    expect(await persistence.mcp.db.query('mcp_local_records'), isEmpty);
    final McpChannel channel = await enable();
    await birth('opted in');
    await service.drain();
    expect(getCalls(), 1);
    final Map<dynamic, dynamic> job = (await persistence.mcp.submissions(channel.id)).single;
    expect(job['state'], 'sent');
    expect(job['remote_ack'], 'tool_result');
    expect(job['snapshot'], isNull);
    expect(job['payload_hash'], isNotNull);
    expect(await persistence.mcp.db.query('mcp_local_records'), hasLength(1));
    expect(jsonEncode(DiagLog.instance.snapshot()), isNot(contains('secret-url-path-key')));
    expect(jsonEncode(DiagLog.instance.snapshot()), isNot(contains('fixture-bearer')));
  });

  test('read-only connection test never invokes; sent edits do not add requests', () async {
    final McpChannel channel = await enable();
    expect(getCalls(), 0);
    final TimelineEntry row = await birth('first body');
    mode = 'modern-sse';
    await service.drain();
    final int before = requests.length;
    timeline.applyEdit(row.id, 'edited after tool success');
    timeline.applyRefined(row.id, 'refined later');
    await timeline.awaitPersisted(row.id);
    await service.drain();
    expect(requests.length, before);
    expect((await persistence.mcp.submissions(channel.id)).single['state'], 'sent');
    final Map<dynamic, dynamic> call = requests.firstWhere((Map<dynamic, dynamic> r) => r['method'] == 'tools/call');
    expect(((call['params'] as Map)['arguments'] as Map)['payload'], <String, Object?>{'text': 'first body'});
  });

  test('a removed selected tool stops the channel without falling back to another listed tool', () async {
    final McpChannel channel = await enable();
    mode = 'selected-tool-removed';
    await birth('tool disappeared');
    await service.drain();
    expect(service.channels.single.state, McpChannelState.toolMissing);
    expect(getCalls(), 0);
    expect((await persistence.mcp.submissions(channel.id)).single['state'], 'pending');
  });

  test('a later local birth with an older creation time is not skipped after success', () async {
    final McpChannel channel = await enable();
    await birth('newer clock');
    await service.drain();
    expect(getCalls(), 1);
    final DateTime older = DateTime.now().subtract(const Duration(days: 2));
    await persistence.saveLocalRecord(TimelineEntry(id: 'loc_older_clock', clientId: 'older-clock',
      mode: FlowMode.realtime, delivery: Delivery.none, sourceText: 'older clock', outputText: 'older clock',
      origin: 'cloud', status: EntryStatus.noted, createdAt: older, updatedAt: older), source: LocalRecordSource.birthReady);
    await service.drain();
    expect(getCalls(), 2);
    final List<Map<String, Object?>> jobs = await persistence.mcp.submissions(channel.id);
    expect(jobs, hasLength(2));
    expect(jobs.map((Map<dynamic, dynamic> j) => j['state']), everyElement('sent'));
  });

  test('slow channel does not block another receiver', () async {
    final McpChannel slow = await service.configure(name: 'slow', tool: 'submit',
      schema: toolSchema, mapping: mapping, credential: credential('slow'));
    expect((await service.testChannel(slow.id)).succeeded, true);
    await service.enable(slow.id);
    await enable();
    slowEntered = Completer<void>(); quickEntered = Completer<void>(); releaseSlow = Completer<void>();
    mode = 'slow-channel';
    await birth('two receivers');
    final Future<void> drain = service.drain();
    try {
      await slowEntered!.future.timeout(const Duration(seconds: 3));
      await quickEntered!.future.timeout(const Duration(seconds: 3));
    } finally {
      releaseSlow!.complete();
      await drain;
    }
    expect(getCalls(), 2);
    expect(await persistence.mcp.db.query('mcp_submissions'), hasLength(2));
  });

  test('production attach is inert before opt-in and automatically drains after a local birth', () async {
    int subscriptions = 0;
    final StreamController<void> network = StreamController<void>.broadcast(
      onListen: () => subscriptions++, onCancel: () => subscriptions--);
    addTearDown(network.close);
    service.attach(networkReturned: network.stream);
    await birth('unconfigured');
    expect(subscriptions, 0);
    expect(requests, isEmpty);
    final McpChannel channel = await enable();
    expect(subscriptions, 1);
    await birth('automatic from local save');
    // Poll only the fixture's receipt; no test calls drain or kick for this row.
    final DateTime end = DateTime.now().add(const Duration(seconds: 4));
    while (getCalls() == 0 && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(getCalls(), 1);
    // Wait for the corresponding durable conclusion before removing its channel.
    while ((await persistence.mcp.submissions(channel.id)).single['state'] != 'sent' && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    await service.pause(channel.id);
    expect(subscriptions, 0);
    await birth('paused');
    expect(getCalls(), 1);
    await service.remove(channel.id);
    await birth('removed');
    expect(subscriptions, 0);
    expect(await persistence.mcp.db.query('mcp_local_records'), isEmpty);
    service.dispose();
    // TearDown calls dispose again, so leave a fresh unattached real service.
    service = McpService(store: persistence.mcp);
  });

  test('crash after sending is unknown on reopen and does not retry', () async {
    final McpChannel channel = await enable();
    await birth('crash window');
    await persistence.mcp.db.update('mcp_submissions', <String, Object?>{'state': 'sending', 'snapshot': '{}'});
    await persistence.mcp.initialize();
    await service.drain();
    expect(getCalls(), 0);
    expect((await persistence.mcp.submissions(channel.id)).single['state'], 'unknown');
  });

  for (final String fault in <String>['wrong-id', 'modern-refusal', '503']) {
    test('200 wrong id / isError / 5xx never write sent: $fault', () async {
      final McpChannel channel = await enable();
      mode = fault;
      await birth('uncertain or refused');
      await service.drain();
      final Map<dynamic, dynamic> job = (await persistence.mcp.submissions(channel.id)).single;
      expect(job['state'], fault == 'modern-refusal' ? 'rejected' : 'unknown');
      expect(job['remote_ack'], isNull);
      if (fault == 'modern-refusal') { expect(job['snapshot'], isNull); expect(job['last_error'], 'remote_tool'); }
      await service.drain();
      expect(getCalls(), 1, reason: 'unknown or executed refusal must not auto-retry');
    });
  }

  test('401 stops all later attempts, pending survives token-only change until retest', () async {
    final McpChannel channel = await enable();
    mode = '401';
    await birth('one'); await birth('two');
    await service.drain();
    expect(getCalls(), 1);
    expect(service.channels.single.state, McpChannelState.reauthorizationRequired);
    expect((await persistence.mcp.submissions(channel.id)).map((Map<dynamic, dynamic> j) => j['state']), everyElement('pending'));
    final int count = requests.length;
    await service.drain();
    expect((await service.testChannel(channel.id)).succeeded, false);
    expect(requests.length, count);
    await expectLater(service.configure(id: channel.id, name: channel.name, tool: channel.tool,
      schema: toolSchema, mapping: mapping, credential: credential()), throwsStateError);
    await service.configure(id: channel.id, name: channel.name, tool: channel.tool,
      schema: toolSchema, mapping: mapping, credential: credential('new-fixture-bearer'));
    expect(service.channels.single.canSend, false);
    expect((await persistence.mcp.submissions(channel.id)).map((Map<dynamic, dynamic> j) => j['state']), everyElement('pending'));
    mode = 'modern-success';
    expect((await service.testChannel(channel.id)).succeeded, true);
    await service.drain();
    expect((await persistence.mcp.submissions(channel.id)).map((Map<dynamic, dynamic> j) => j['state']), everyElement('sent'));
    expect(getCalls(), 3);
  });

  test('429 honors Retry-After, freezes body, and ends visibly at attempt limit', () async {
    final McpChannel channel = await enable();
    final TimelineEntry row = await birth('frozen body');
    mode = '429';
    await service.drain();
    final Map<dynamic, dynamic> initial = (await persistence.mcp.submissions(channel.id)).single;
    expect(initial['state'], 'retrying');
    expect((initial['next_attempt_at'] as int) - (initial['updated_at'] as int), greaterThanOrEqualTo(119000));
    timeline.applyEdit(row.id, 'do not send this edit');
    await timeline.awaitPersisted(row.id);
    await service.drain();
    expect(getCalls(), 1);
    for (int attempt = 1; attempt < 5; attempt++) {
      await persistence.mcp.db.update('mcp_submissions', <String, Object?>{'next_attempt_at': 0});
      await service.drain();
    }
    expect(getCalls(), 5);
    for (final Map<dynamic, dynamic> call in requests.where((Map<dynamic, dynamic> r) => r['method'] == 'tools/call')) {
      expect(((call['params'] as Map)['arguments'] as Map)['payload'], <String, Object?>{'text': 'frozen body'});
    }
    final Map<dynamic, dynamic> terminal = (await persistence.mcp.submissions(channel.id)).single;
    expect(terminal['state'], 'rejected');
    expect(terminal['last_error'], 'retry_exhausted');
    expect(terminal['snapshot'], isNull);
    await service.drain(); expect(getCalls(), 5);
  });

  test('integration directory maps to mobile gate, and its discovered wrapper runs this scenario', () async {
    final ProcessResult route = await Process.run('node', <String>['--input-type=module', '-e',
      "import {selectStages} from '../../verify/lane-map.mjs'; console.log(JSON.stringify(selectStages(['apps/mobile/integration_test/mcp_submission_scenarios.dart'])));"], runInShell: true);
    expect(route.exitCode, 0);
    final Map<dynamic, dynamic> result = jsonDecode(route.stdout as String) as Map;
    expect(result['unmapped'], isEmpty);
    expect((result['matched'] as List).cast<Map<dynamic, dynamic>>().map((Map<dynamic, dynamic> m) => (m['rule'] as Map)['id']), contains('mobile'));
    expect(result['stages'], contains('verify:mobile-tests'));
    expect(File('test/mcp_submission_integration_test.dart').readAsStringSync(), contains('mcpSubmissionScenarios();'));
  });
}
