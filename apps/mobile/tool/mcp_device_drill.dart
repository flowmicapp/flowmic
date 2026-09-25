// TEST TARGET ONLY, never the production entrypoint. The installed drill must
// have the .mcpdrill application id suffix (external Gradle init script). It has
// its own real SQLite and Android secure storage, and trusts exactly one local
// fixture certificate. STT/PC transport is explicitly fake; records are typed
// through the real ChatFlowPage -> ChatController -> local persistence path.
// The receiver is a running official SDK, not a replay transport.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/mcp/mcp_page.dart';
import 'package:flowmic/src/mcp/mcp_scope.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/mcp/mcp_secrets.dart';
import 'package:flowmic/src/mcp/mcp_settings_backup.dart';
import 'package:flowmic/src/mcp/mcp_transport.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/app_lifecycle_bridge.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';

import '../test/support/di.dart';
import '../test/support/fakes.dart';

class _Owner implements InstanceOwnerProbe {
  const _Owner(this.session);
  final PttSession session;
  @override
  String? get instanceId => session.connectedInstanceId;
  @override
  String? get instanceName => session.pcDisplayName;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const String encoded = String.fromEnvironment('MCP_DRILL_CA');
  const String url = String.fromEnvironment('MCP_DRILL_URL');
  if (encoded.isEmpty || url.isEmpty) throw StateError('explicit fixture certificate and URL required');
  final String cert = utf8.decode(base64Decode(encoded));
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController settings = AppSettingsController(prefs: prefs);
  await settings.load(); settings.setLocale(AppLocale.en);
  final Directory directory = await getApplicationSupportDirectory();
  final SqfliteTimelinePersistence persistence = (await openTimelinePersistence(
    prefs: prefs, factory: databaseFactory, path: '${directory.path}/mcp-drill.db')).persistence as SqfliteTimelinePersistence;
  final McpService service = McpService(store: persistence.mcp,
    transport: HttpMcpTransport(clientFactory: () => HttpClient()..badCertificateCallback =
      (X509Certificate c, String host, int port) => host == '127.0.0.1' && c.pem == cert));
  // Prefill only the synthetic service's draft. Discovery is real, but neither
  // tested-generation nor authorization is set here: both are UI actions.
  if (service.channels.isEmpty) {
    final McpSecrets secret = McpSecrets(endpoint: Uri.parse(url), token: 'fixture-token', fixed: <String, Object?>{});
    final McpChannel draft = await service.configure(name: 'Local SDK drill', tool: '',
      schema: <String, Object?>{'type': 'object'}, mapping: <String, Object?>{}, credential: secret);
    final McpReply discovered = await service.discover(draft.id);
    if (!discovered.succeeded) throw StateError('fixture discovery failed: ${discovered.reason}');
    final Map tool = (discovered.result!['tools']! as List).cast<Map>().firstWhere((Map t) => t['name'] == 'submit');
    await service.configure(id: draft.id, name: draft.name, tool: 'submit',
      schema: (tool['inputSchema'] as Map).cast<String, Object?>(),
      mapping: <String, Object?>{'/payload/text': <String, Object?>{'source': 'outputText'}, '/kind': <String, Object?>{'source': 'fixed', 'value': 'record'}},
      credential: secret);
  }
  final FakeSocketTransport socket = FakeSocketTransport();
  final PttSession session = newTestSession(transport: socket, audio: AudioCapture(recorder: FakeAudioRecorder()));
  giveSessionAPairedIdentity(session);
  final TimelineStore timeline = newTestStore(persistence: persistence, owner: _Owner(session));
  await timeline.load();
  final ChatController chat = ChatController(session: session, store: timeline,
    destination: DestinationController(fixedRecordOnly: true), outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(), syncGate: TimelineSyncGate(transport: socket), localPrefs: SharedPrefsLocalPrefs(prefs));
  service.attach(networkReturned: const Stream<void>.empty());
  final GlobalKey<NavigatorState> navigation = GlobalKey<NavigatorState>();
  Future<void> evidence() async {
    try {
      final List<Object?> credentials = <Object?>[];
      for (final McpChannel c in service.channels) {
        final McpSecrets? stored = await service.secrets.read(c.id, c.generation);
        credentials.add(<String, Object?>{'id': c.id, 'generation': c.generation, 'secureReadBackMatchesFixture': stored?.endpoint.toString() == url});
      }
      final Map<String, Object?> value = <String, Object?>{
        'at': DateTime.now().toUtc().toIso8601String(),
        'channels': await persistence.mcp.db.query('mcp_channels'),
        'registrations': await persistence.mcp.db.query('mcp_local_records'),
        'submissions': await persistence.mcp.db.query('mcp_submissions'),
        'credentials': credentials,
        'portable': await McpSettingsBackup(store: service.store, secrets: service.secrets).exportChannels(),
        'diag': DiagLog.instance.snapshot(),
      };
      await File('${directory.path}/mcp-device-evidence.json').writeAsString(jsonEncode(value), flush: true);
    } on Object { debugPrint('MCP_DEVICE_EVIDENCE_FAILED'); }
  }
  // This is drill-only readback, not a product timer or a network request.
  Timer.periodic(const Duration(seconds: 2), (_) => unawaited(evidence()));
  await evidence();
  debugPrint('MCP_DEVICE_READY evidence=${directory.path}/mcp-device-evidence.json');
  runApp(AppLifecycleBridge(onBackground: () async { service.background(); }, onForeground: () async { service.foreground(); },
    child: MaterialApp(navigatorKey: navigation, debugShowCheckedModeBanner: false,
      builder: (_, Widget? child) => McpScope(service: service, settings: settings, child: child!),
      home: ChatFlowPage(controller: chat, appSettings: settings, isCloudInstance: true,
        onOpenSettings: () => navigation.currentState!.push<void>(MaterialPageRoute<void>(
          builder: (_) => McpPage(service: service, settings: settings)))))));
}
