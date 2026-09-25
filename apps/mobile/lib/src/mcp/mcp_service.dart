// Optional device-local MCP composition. Nothing polls or calls a server while
// unconfigured. Foreground/network edges merely invite a bounded drain; they
// never claim that the remote service is reachable.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../diag/diag_log.dart';
import '../timeline/timeline_entry.dart';
import 'mcp_channel.dart';
import 'mcp_client.dart';
import 'mcp_mapping.dart';
import 'mcp_secrets.dart';
import 'mcp_store.dart';
import 'mcp_submission_store.dart';
import 'mcp_transport.dart';

class McpService extends ChangeNotifier {
  McpService({required this.store, McpSecretStore? secrets, McpTransport? transport})
    : secrets = secrets ?? const SecureMcpSecretStore(), transport = transport ?? HttpMcpTransport();
  // Null is the actual SQLite-unavailable product state, never an empty ledger.
  final McpStore? store;
  final McpSecretStore secrets;
  final McpTransport transport;
  final Map<String, ({int generation, McpClient client})> _clients = <String, ({int generation, McpClient client})>{};
  StreamSubscription<void>? _network;
  Stream<void>? _networkSource;
  Timer? _timer;
  bool _attached = false;
  bool _foreground = true;
  bool _busy = false;
  bool _disposed = false;
  bool get available => store?.available == true;
  List<McpChannel> get channels => store?.channels ?? const <McpChannel>[];

  void attach({required Stream<void> networkReturned}) {
    if (_attached) throw StateError('already_attached');
    _attached = true;
    store?.addListener(_changed);
    _networkSource = networkReturned;
    _armNetwork();
    kick();
  }

  void _changed() { if (!_disposed) { _armNetwork(); notifyListeners(); kick(); } }
  void _armNetwork() {
    if (_attached && available && channels.any((McpChannel c) => c.canSend)) {
      _network ??= _networkSource!.listen((_) => kick());
    } else {
      unawaited(_network?.cancel());
      _network = null;
    }
  }
  void background() { _foreground = false; _timer?.cancel(); }
  void foreground() { _foreground = true; kick(); }
  void kick() {
    if (_disposed || !_foreground || !available || _busy || !channels.any((McpChannel c) => c.authorized)) return;
    unawaited(drain());
  }

  McpClient _client(McpChannel channel, McpSecrets credential) {
    final ({int generation, McpClient client})? old = _clients[channel.id];
    if (old != null && old.generation == channel.generation) return old.client;
    final McpClient client = McpClient(endpoint: credential.endpoint, token: credential.token,
      transport: transport, onUnauthorized: () => store!.setState(channel.id,
        channel.generation, McpChannelState.reauthorizationRequired));
    _clients[channel.id] = (generation: channel.generation, client: client);
    return client;
  }

  Future<McpSecrets?> _readSecrets(McpChannel channel) async {
    try { return await secrets.read(channel.id, channel.generation); }
    on StateError catch (e) {
      if (e.message != 'credential_unavailable') rethrow;
      await store!.setState(channel.id, channel.generation, McpChannelState.reauthorizationRequired);
      return null;
    } on Object {
      await store!.markUnavailable('read_credentials');
      throw StateError('storage_unavailable');
    }
  }

  /// The editor first saves a generation, then explicitly discovers its tools.
  /// This shares the same epoch and 401 latch as testing and the worker.
  Future<McpReply> discover(String id) async {
    if (!available) return const McpReply(McpEvidence.notExecuted, 'storage_unavailable');
    try {
      final McpChannel channel = channels.firstWhere((McpChannel c) => c.id == id);
      if (channel.state == McpChannelState.reauthorizationRequired) {
        return const McpReply(McpEvidence.notExecuted, 'reauthorization_required', status: 401);
      }
      final McpSecrets? credential = await _readSecrets(channel);
      if (credential == null) return const McpReply(McpEvidence.notExecuted, 'credential_unavailable');
      return await _client(channel, credential).listTools();
    } on Object {
      await store!.markUnavailable('discover');
      return const McpReply(McpEvidence.notExecuted, 'storage_unavailable');
    }
  }

  /// A change starts a fresh generation and needs fresh testing and consent.
  Future<McpChannel> configure({String? id, required String name, required String tool,
    required Map<String, Object?> schema, required Map<String, Object?> mapping,
    required McpSecrets credential}) async {
    if (!available) throw StateError('storage_unavailable');
    validateMcpEndpoint(credential.endpoint);
    final List<McpChannel> matches = channels.where((McpChannel c) => c.id == id).toList();
    final McpChannel? old = matches.isEmpty ? null : matches.single;
    if (old == null && channels.length >= 3) throw StateError('channel_limit');
    final McpSecrets? previous = old == null ? null : await _readSecrets(old);
    if (old?.state == McpChannelState.reauthorizationRequired) {
      if (previous != null && previous.endpoint == credential.endpoint && previous.token == credential.token) {
        throw StateError('reauthorization_required');
      }
    }
    final String key = id ?? List<int>.generate(16, (_) => Random.secure().nextInt(256))
      .map((int b) => b.toRadixString(16).padLeft(2, '0')).join();
    final int generation;
    try { generation = await store!.reserveGeneration(); }
    on Object { await store!.markUnavailable('reserve_generation'); throw StateError('storage_unavailable'); }
    // A token-only replacement does not change the recipient or frozen body.
    // Keep its pending rows and previous consent, but invalidate the test epoch.
    final bool credentialOnly = old != null && previous != null &&
      previous.endpoint == credential.endpoint && previous.token != credential.token &&
      _jsonEqual(previous.fixed, credential.fixed) && old.tool == tool &&
      _jsonEqual(old.inputSchema, schema) && _jsonEqual(old.mapping, publicMcpMapping(mapping));
    final McpChannel channel = McpChannel(id: key, name: name, hostHint: credential.endpoint.host,
      tool: tool, inputSchema: schema, mapping: publicMcpMapping(mapping), generation: generation,
      authorized: credentialOnly && old.authorized, paused: credentialOnly && old.paused,
      state: McpChannelState.saved, expiredCount: old?.expiredCount ?? 0,
      lastSuccessAt: credentialOnly ? old.lastSuccessAt : null);
    bool saved = false;
    try {
      // Secure write is read back before saving a configuration that depends on
      // it. Saving does not authorize network traffic. Old pending work closes.
      await secrets.write(key, generation, credential);
      await store!.saveChannel(channel, retainPendingForCredentialChange: credentialOnly);
      saved = true;
      _clients.remove(key);
      await secrets.prune(key, keepGeneration: generation);
      return channel;
    } on Object {
      if (!saved) {
        try { await secrets.remove(key, generation); }
        on Object { diag('mcp.storage_unavailable', <String, Object?>{'operation': 'orphan_credential_cleanup'}); }
      }
      await store!.markUnavailable('configure');
      throw StateError('storage_unavailable');
    }
  }

  Future<McpReply> testChannel(String id) async {
    if (!available) return const McpReply(McpEvidence.notExecuted, 'storage_unavailable');
    try {
      final McpChannel channel = channels.firstWhere((McpChannel c) => c.id == id);
      if (channel.state == McpChannelState.reauthorizationRequired) {
        return const McpReply(McpEvidence.notExecuted, 'reauthorization_required', status: 401);
      }
      final McpSecrets? credential = await _readSecrets(channel);
      if (credential == null) return const McpReply(McpEvidence.notExecuted, 'credential_unavailable');
      final McpReply reply = await _listAndValidate(channel, credential);
      if (reply.succeeded) await store!.tested(id, channel.generation);
      return reply;
    } on McpMappingError catch (e) {
      return McpReply(McpEvidence.notExecuted, e.unsupported ? 'schema_unsupported' : 'local_mapping', field: e.field);
    } on Object {
      await store!.markUnavailable('test_channel');
      return const McpReply(McpEvidence.notExecuted, 'storage_unavailable');
    }
  }

  Future<McpReply> _listAndValidate(McpChannel channel, McpSecrets credential) async {
    final McpReply reply = await _client(channel, credential).listTools();
    if (!reply.succeeded) return reply;
    final List<Map<dynamic, dynamic>> tools = (reply.result!['tools']! as List).whereType<Map<dynamic, dynamic>>().toList();
    final List<Map<dynamic, dynamic>> matches = tools.where((Map<dynamic, dynamic> t) => t['name'] == channel.tool).toList();
    if (matches.length != 1) {
      await store!.setState(channel.id, channel.generation, McpChannelState.toolMissing);
      return const McpReply(McpEvidence.notExecuted, 'tool_missing');
    }
    try {
      final Map<String, Object?> schema = (matches.single['inputSchema'] as Map).cast<String, Object?>();
      // A changed schema needs user review even if the old mapping still parses.
      if (!_jsonEqual(schema, channel.inputSchema)) throw const McpMappingError('', unsupported: true);
      for (final MapEntry<String, Object?> binding in channel.mapping.entries) {
        if (binding.value is Map && (binding.value! as Map)['secret'] == true && !credential.fixed.containsKey(binding.key)) {
          return const McpReply(McpEvidence.notExecuted, 'credential_unavailable');
        }
      }
      McpMapping(schema, channel.mapping).validateSecrets(credential.fixed);
      return const McpReply(McpEvidence.result, 'test_passed');
    } on McpMappingError catch (e) {
      if (e.unsupported) await store!.setState(channel.id, channel.generation, McpChannelState.schemaUnsupported);
      return McpReply(McpEvidence.notExecuted, e.unsupported ? 'schema_unsupported' : 'local_mapping', field: e.field);
    } on Object {
      await store!.setState(channel.id, channel.generation, McpChannelState.schemaUnsupported);
      return const McpReply(McpEvidence.notExecuted, 'schema_unsupported');
    }
  }

  Future<void> enable(String id) async {
    final McpChannel channel = channels.firstWhere((McpChannel c) => c.id == id);
    await store!.enable(id, channel.generation);
  }
  Future<void> pause(String id) => store!.pause(id);
  Future<void> remove(String id) async {
    await store!.removeChannel(id);
    _clients.remove(id);
    try { await secrets.prune(id); }
    on Object { await store!.markUnavailable('remove_credential'); throw StateError('storage_unavailable'); }
    if (!channels.any((McpChannel c) => c.authorized)) _timer?.cancel();
  }

  Future<TimelineEntry?> readEntry(String id) async {
    final List<Map<String, Object?>> rows = await store!.db.query('timeline_entries', columns: <String>['payload'],
      where: 'id = ?', whereArgs: <Object?>[id], limit: 1);
    if (rows.isEmpty) return null;
    return TimelineEntry.fromJson((jsonDecode(rows.single['payload']! as String) as Map).cast<String, Object?>());
  }

  Future<void> manual(String entryId, String channelId, {required int generation, required String? expectedRevision}) async {
    final TimelineEntry? row = await readEntry(entryId);
    if (row == null) throw StateError('local_mapping');
    final McpChannel channel = channels.firstWhere((McpChannel c) => c.id == channelId);
    if (channel.generation != generation) throw StateError('manual_unavailable');
    await store!.manual(row, channel, expectedRevision: expectedRevision);
  }

  Future<void> drain() async {
    if (_disposed || !_foreground || _busy || !available) return;
    _busy = true;
    _timer?.cancel();
    try {
      await store!.maintain();
      // Each channel has one serial worker. A slow receiver must not hold the
      // other channels behind its timeout; the maximum concurrency is three.
      await Future.wait<void>(channels.where((McpChannel c) => c.canSend).map((McpChannel channel) async {
        final List<Map<String, Object?>> jobs = await store!.submissions(channel.id);
        for (final Map<String, Object?> job in jobs.reversed) {
          if (_disposed || !_foreground || !available ||
              !channels.any((McpChannel c) => c.id == channel.id && c.generation == channel.generation && c.canSend)) {
            break;
          }
          if (job['ready'] != 1 || !<String>{'pending', 'retrying'}.contains(job['state']) ||
              (job['next_attempt_at'] as int? ?? 0) > store!.nowMs) {
            continue;
          }
          if (job['generation'] != channel.generation) {
            await store!.reject(job, 'local_mapping');
            continue;
          }
          await _attempt(channel, job);
        }
      }));
    } on Object {
      // If the durable conclusion fails after a request, leave sending on disk:
      // startup turns it unknown. Stop now; never manufacture a retry or success.
      await store!.markUnavailable('drain');
    } finally {
      _busy = false;
      if (!_disposed && _foreground && available && channels.any((McpChannel c) => c.authorized)) {
        try {
          int wait = const Duration(hours: 1).inMilliseconds;
          for (final McpChannel channel in channels.where((McpChannel c) => c.canSend)) {
            for (final Map<String, Object?> job in await store!.submissions(channel.id)) {
              if (job['ready'] == 1 && <String>{'pending', 'retrying'}.contains(job['state'])) {
                wait = min(wait, max(50, (job['next_attempt_at'] as int? ?? 0) - store!.nowMs));
              }
            }
          }
          _timer = Timer(Duration(milliseconds: wait), kick);
        } on Object {
          await store!.markUnavailable('schedule');
        }
      }
    }
  }

  Future<void> _attempt(McpChannel channel, Map<String, Object?> job) async {
    final McpSecrets? credential = await _readSecrets(channel);
    if (credential == null) {
      await store!.setState(channel.id, channel.generation, McpChannelState.reauthorizationRequired);
      return;
    }
    final TimelineEntry? entry = await readEntry(job['entry_id']! as String);
    if (entry == null || entry.deleted) return;
    Map<String, Object?> arguments;
    try {
      final McpMapping mapping = McpMapping(channel.inputSchema, channel.mapping);
      if (job['snapshot'] is String) {
        arguments = (jsonDecode(job['snapshot']! as String) as Map).cast<String, Object?>();
        for (final MapEntry<String, Object?> binding in channel.mapping.entries) {
          if (binding.value is Map && (binding.value! as Map)['secret'] == true) {
            _put(arguments, binding.key, credential.fixed[binding.key]);
          }
        }
        if (mcpPayloadHash(arguments) != job['payload_hash']) throw const McpMappingError('');
      } else {
        arguments = mapping.arguments(entry, secrets: credential.fixed);
      }
    } on McpMappingError {
      await store!.reject(job, 'local_mapping');
      return;
    }
    final Map<String, Object?> snapshot = (jsonDecode(jsonEncode(arguments)) as Map).cast<String, Object?>();
    for (final MapEntry<String, Object?> binding in channel.mapping.entries) {
      if (binding.value is Map && (binding.value! as Map)['secret'] == true) _put(snapshot, binding.key, null);
    }
    final McpReply checked = await _listAndValidate(channel, credential);
    if (!checked.succeeded && <String>{'tool_missing', 'schema_unsupported', 'reauthorization_required', 'credential_unavailable'}.contains(checked.reason)) return;
    if (checked.status == 401) return;
    if (_disposed || !_foreground || !available) return;
    if (!await store!.claim(job, jsonEncode(snapshot), mcpPayloadHash(arguments))) return;
    if (_disposed || !_foreground || !available ||
        !channels.any((McpChannel c) => c.id == channel.id && c.generation == channel.generation && c.canSend)) {
      await store!.conclude(job, const McpReply(McpEvidence.notExecuted, 'request_cancelled'));
      return;
    }
    // No tools/call happened when discovery failed. That layer owns all facts
    // needed to retry safely, even if its READ request ended ambiguously.
    final McpReply reply = checked.succeeded
      ? await _client(channel, credential).invoke(channel.tool, arguments)
      : McpReply(McpEvidence.notExecuted, checked.reason, retryAfter: checked.retryAfter);
    await store!.conclude(job, reply);
    diag('mcp.attempt', <String, Object?>{'host': channel.hostHint,
      'channel_id': channel.id, 'evidence': reply.evidence.name, 'reason': reply.reason});
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    unawaited(_network?.cancel());
    store?.removeListener(_changed);
    super.dispose();
  }
}

void _put(Map<String, Object?> arguments, String pointer, Object? value) {
  final List<String> keys = pointer.substring(1).split('/').map((String k) => k.replaceAll('~1', '/').replaceAll('~0', '~')).toList();
  Map<dynamic, dynamic> target = arguments;
  for (final String key in keys.take(keys.length - 1)) { target = target[key] as Map; }
  target[keys.last] = value;
}

bool _jsonEqual(Object? a, Object? b) {
  if (a is Map && b is Map) return a.length == b.length && a.keys.every((Object? k) => b.containsKey(k) && _jsonEqual(a[k], b[k]));
  if (a is List && b is List) return a.length == b.length && List<int>.generate(a.length, (int i) => i).every((int i) => _jsonEqual(a[i], b[i]));
  return a == b;
}
