// One edit session serializes secure writes. Text edits persist after a short
// debounce; test/leave flush it. Editing invalidates sending before saving a
// new generation. Discovery is an explicit read-only action, never typing.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'mcp_channel.dart';
import 'mcp_mapping.dart';
import 'mcp_secrets.dart';
import 'mcp_service.dart';
import 'mcp_transport.dart';

class McpEditor extends ChangeNotifier {
  McpEditor(this.service, this.channel) {
    if (channel case final McpChannel c) {
      name = c.name; tool = c.tool; schema = c.inputSchema;
      bindings = Map<String, Object?>.from(c.mapping);
    }
  }
  final McpService service;
  McpChannel? channel;
  String name = '';
  String endpoint = '';
  String token = '';
  String tool = '';
  bool bearer = false;
  bool loaded = false;
  bool busy = false;
  bool restored = false;
  String? error;
  String errorField = '';
  McpReply? tested;
  List<Map<String, Object?>> tools = <Map<String, Object?>>[];
  Map<String, Object?> schema = <String, Object?>{'type': 'object'};
  Map<String, Object?> bindings = <String, Object?>{};
  Map<String, Object?> fixedSecrets = <String, Object?>{};
  Timer? _debounce;
  Future<void> _tail = Future<void>.value();
  bool _closed = false;
  bool _dirty = false;
  bool get dirty => _dirty;
  int _revision = 0;
  void _notify() { if (!_closed) notifyListeners(); }

  Future<void> load() async {
    try {
      if (channel case final McpChannel c) {
        final McpSecrets? secret = await service.secrets.read(c.id, c.generation);
        restored = secret == null;
        if (secret != null) {
          endpoint = secret.endpoint.toString(); token = secret.token ?? '';
          bearer = token.isNotEmpty; fixedSecrets = Map<String, Object?>.from(secret.fixed);
        }
      }
    } on Object { error = 'storage_unavailable'; }
    loaded = true; _notify();
  }

  void changed() {
    _revision++; _dirty = true; tested = null; error = null; errorField = '';
    _debounce?.cancel();
    final McpChannel? old = channel;
    if (old != null) {
      _tail = _tail.then((_) async {
        try { await service.pause(old.id); }
        on Object { error = 'storage_unavailable'; }
      });
    }
    _debounce = Timer(const Duration(milliseconds: 400), () { unawaited(flush()); });
    _notify();
  }

  Future<void> flush() {
    _debounce?.cancel();
    _tail = _tail.then((_) async {
      if (!_dirty) return;
      final int revision = _revision;
      try {
        final Uri uri = Uri.parse(endpoint.trim());
        validateMcpEndpoint(uri);
        McpMapping(schema, bindings, requireComplete: false);
        final McpChannel saved = await service.configure(id: channel?.id,
          name: name.trim().isEmpty ? uri.host : name.trim(), tool: tool,
          schema: schema, mapping: Map<String, Object?>.from(bindings),
          credential: McpSecrets(endpoint: uri, token: bearer ? token : null,
            fixed: Map<String, Object?>.from(fixedSecrets)));
        channel = saved;
        restored = false;
        if (_revision == revision) { _dirty = false; error = null; }
      } on McpMappingError catch (e) { error = e.unsupported ? 'schema_unsupported' : 'local_mapping'; errorField = e.field; }
      on StateError catch (e) { error = '${e.message}'; }
      on FormatException { error = 'https_required'; }
      on Object { error = 'storage_unavailable'; }
      _notify();
    });
    return _tail;
  }

  Future<void> discover() async {
    if (busy) return;
    if (channel == null) _dirty = true;
    busy = true; tested = null; _notify();
    await flush();
    if (error != null) { busy = false; _notify(); return; }
    final int revision = _revision;
    final McpReply reply = await service.discover(channel!.id);
    if (revision == _revision) {
      tested = reply;
      tools = reply.succeeded
        ? (reply.result!['tools']! as List).whereType<Map>().map((Map t) => t.cast<String, Object?>()).toList()
        : <Map<String, Object?>>[];
      if (reply.succeeded && channel != null && tool.isNotEmpty) tested = await service.testChannel(channel!.id);
    }
    busy = false; _notify();
  }

  void selectTool(Map<String, Object?> selected) {
    tool = selected['name']! as String;
    try {
      schema = (selected['inputSchema']! as Map).cast<String, Object?>();
      bindings = <String, Object?>{}; fixedSecrets = <String, Object?>{};
      changed();
      McpMapping(schema, bindings, requireComplete: false);
    } on Object { error = 'schema_unsupported'; _notify(); }
  }

  @override
  void dispose() { _closed = true; _debounce?.cancel(); super.dispose(); }
}
