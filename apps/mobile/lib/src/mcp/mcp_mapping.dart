// SPEC-REF: Task C plan §9.5. A small explicit JSON Schema subset, not a
// permissive generic mapper. Unknown validation keywords close the channel.
// A missing source stays absent; it never borrows another text or time field.
import 'dart:convert';

import '../portable/fpr_mobile.dart';
import '../timeline/timeline_entry.dart';

class McpMappingError implements Exception {
  const McpMappingError(this.field, {this.unsupported = false});
  final String field;
  final bool unsupported;
  @override
  String toString() => unsupported ? 'schema_unsupported' : 'local_mapping';
}

class McpField {
  const McpField(this.path, this.schema, this.required);
  final String path;
  final Map<String, Object?> schema;
  final bool required;
  String get type => schema['type']! as String;
}

const Set<String> mcpSources = <String>{'fixed', 'sourceText', 'outputText',
  'processedText', 'sourceLang', 'outputLang', 'processMode', 'entryType',
  'articleId', 'id', 'createdIso', 'createdMs', 'createdSeconds', 'recordJson'};

String _pointer(String parent, String key) => '$parent/${key.replaceAll('~', '~0').replaceAll('/', '~1')}';

class McpMapping {
  McpMapping(this.schema, this.bindings, {bool requireComplete = true}) {
    int nodes = 0;
    void visit(Map<String, Object?> s, String path, bool required, int depth) {
      if (++nodes > 128 || depth > 8) throw McpMappingError(path, unsupported: true);
      const Set<String> keys = <String>{r'$schema', 'type', 'title', 'description',
        'properties', 'required', 'additionalProperties', 'enum', 'const', 'default',
        'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
        'exclusiveMaximum', 'minItems', 'maxItems', 'items'};
      if (s.keys.any((String k) => !keys.contains(k)) ||
          !<String>{'object', 'array', 'string', 'number', 'integer', 'boolean'}.contains(s['type']) ||
          (s.containsKey('format') && (s['format'] != 'date-time' || s['type'] != 'string')) ||
          (s.containsKey('enum') && (s['enum'] is! List || (s['enum']! as List).isEmpty))) {
        throw McpMappingError(path, unsupported: true);
      }
      _schemas[path] = s;
      for (final String key in <String>['minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (s.containsKey(key) && (s[key] is! int || (s[key]! as int) < 0)) {
          throw McpMappingError(path, unsupported: true);
        }
      }
      for (final String key in <String>['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
        if (s.containsKey(key) && (s[key] is! num || !(s[key]! as num).isFinite)) {
          throw McpMappingError(path, unsupported: true);
        }
      }
      if (s['type'] == 'object') {
        final Object? props = s['properties'];
        final Object? requiredKeys = s['required'];
        if ((props != null && props is! Map) ||
            (requiredKeys != null && (requiredKeys is! List || requiredKeys.any((Object? k) => k is! String))) ||
            (s.containsKey('additionalProperties') && s['additionalProperties'] is! bool)) {
          throw McpMappingError(path, unsupported: true);
        }
        final Map properties = props as Map? ?? <String, Object?>{};
        if ((requiredKeys as List? ?? <Object?>[]).any((Object? k) => !properties.containsKey(k))) {
          throw McpMappingError(path, unsupported: true);
        }
        if (path.isNotEmpty) fields.add(McpField(path, s, required));
        for (final MapEntry e in properties.entries) {
          if (e.key is! String || e.value is! Map) throw McpMappingError(path, unsupported: true);
          visit((e.value as Map).cast<String, Object?>(), _pointer(path, e.key as String),
            required && (requiredKeys as List? ?? <Object?>[]).contains(e.key), depth + 1);
        }
      } else {
        fields.add(McpField(path, s, required));
        if (s['type'] == 'array') {
          final Object? items = s['items'];
          if (items is! Map || !<String>{'string', 'number', 'integer', 'boolean'}.contains(items['type'])) {
            throw McpMappingError(path, unsupported: true);
          }
          // Fixed arrays of scalars only. Tuple/nested/object arrays fail closed.
          visit(items.cast<String, Object?>(), '$path/*', false, depth + 1);
          fields.removeLast();
          _schemas.remove('$path/*');
        }
      }
    }
    if (schema['type'] != 'object') throw const McpMappingError('', unsupported: true);
    visit(schema, '', true, 0);
    for (final MapEntry<String, Object?> pair in bindings.entries) {
      if (bindings.keys.any((String other) => other != pair.key && pair.key.startsWith('$other/'))) {
        throw McpMappingError(pair.key);
      }
      final Map<String, Object?>? target = _schemas[pair.key];
      final Object? raw = pair.value;
      if (target == null || pair.key.isEmpty || raw is! Map || !mcpSources.contains(raw['source'])) {
        throw McpMappingError(pair.key);
      }
      final String source = raw['source'] as String;
      final String type = target['type']! as String;
      if ((target.containsKey('enum') || target.containsKey('const') || type == 'array') && source != 'fixed') {
        throw McpMappingError(pair.key);
      }
      if (source == 'fixed') {
        if (raw['secret'] != true) _validate(raw['value'], target, pair.key);
      } else if (source == 'recordJson') {
        if (!<String>{'string', 'object'}.contains(type)) throw McpMappingError(pair.key);
      } else if (<String>{'createdMs', 'createdSeconds'}.contains(source)) {
        if (!<String>{'number', 'integer'}.contains(type)) throw McpMappingError(pair.key);
      } else if (type != 'string' || (target['format'] == 'date-time' && source != 'createdIso')) {
        throw McpMappingError(pair.key);
      }
    }
    void requireFields(Map<String, Object?> s, String path) {
      if (bindings.containsKey(path)) return;
      if (s['type'] != 'object') throw McpMappingError(path);
      final Map props = s['properties'] as Map? ?? <String, Object?>{};
      final List required = s['required'] as List? ?? <Object?>[];
      for (final Object? name in props.keys) {
        final String child = _pointer(path, name! as String);
        // Optional objects become present when any descendant is mapped. Their
        // own required siblings must then be mapped before testing can pass.
        if (required.contains(name) || bindings.keys.any((String p) => p == child || p.startsWith('$child/'))) {
          requireFields((props[name] as Map).cast<String, Object?>(), child);
        }
      }
    }
    if (requireComplete) requireFields(schema, '');
  }

  final Map<String, Object?> schema;
  final Map<String, Object?> bindings;
  final List<McpField> fields = <McpField>[];
  final Map<String, Map<String, Object?>> _schemas = <String, Map<String, Object?>>{};

  void validateSecrets(Map<String, Object?> secrets) {
    for (final MapEntry<String, Object?> entry in bindings.entries) {
      if (entry.value is Map && (entry.value! as Map)['secret'] == true) {
        _validate(secrets[entry.key], _schemas[entry.key]!, entry.key);
      }
    }
  }

  Map<String, Object?> arguments(TimelineEntry entry, {required Map<String, Object?> secrets}) {
    Object? materialize(Map<String, Object?> s, String path) {
      final Object? raw = bindings[path];
      if (raw is Map) {
        final String source = raw['source']! as String;
        if (source == 'fixed') return raw['secret'] == true ? secrets[path] : raw['value'];
        if (source == 'recordJson') {
          final Map<String, Object?> row = mcpFprRow(entry);
          return s['type'] == 'string' ? jsonEncode(row) : row;
        }
        return <String, Object?>{
          'sourceText': entry.sourceText, 'outputText': entry.outputText,
          'processedText': entry.processedText, 'sourceLang': entry.sourceLang,
          'outputLang': entry.outputLang, 'processMode': entry.processMode,
          'entryType': entry.entryType, 'articleId': entry.articleId, 'id': entry.id,
          'createdIso': entry.createdAt.toUtc().toIso8601String(),
          'createdMs': entry.createdAt.toUtc().millisecondsSinceEpoch,
          'createdSeconds': (entry.createdAt.toUtc().millisecondsSinceEpoch / 1000).floor(),
        }[source];
      }
      if (s['type'] != 'object') return null;
      final Map<String, Object?> result = <String, Object?>{};
      for (final MapEntry e in (s['properties'] as Map? ?? <String, Object?>{}).entries) {
        final Object? value = materialize((e.value as Map).cast<String, Object?>(), _pointer(path, e.key as String));
        if (value != null && (!(value is Map && value.isEmpty) ||
            (s['required'] as List? ?? <Object?>[]).contains(e.key) || bindings.containsKey(_pointer(path, e.key as String)))) {
          result[e.key as String] = value;
        }
      }
      return result;
    }
    final Map<String, Object?> result = materialize(schema, '')! as Map<String, Object?>;
    _validate(result, schema, '');
    return result;
  }
}

// Same FPR entry row, with the optional thumbnail extension removed. This
// operation does not invent a third record shape or carry local image bytes.
Map<String, Object?> mcpFprRow(TimelineEntry entry) {
  final Map<String, Object?> row = fprRecordOfRow(entry).toJson();
  final Map<String, Object?> ext = Map<String, Object?>.from(row['source_ext']! as Map);
  ext.remove('thumb_b64');
  row['source_ext'] = ext;
  return row;
}

void _validate(Object? value, Map<String, Object?> schema, String path) {
  Never bad() => throw McpMappingError(path);
  final String type = schema['type']! as String;
  final bool matches = switch (type) {
    'object' => value is Map,
    'array' => value is List,
    'string' => value is String,
    'integer' => value is int,
    'number' => value is num && value.isFinite,
    'boolean' => value is bool,
    _ => false,
  };
  if (!matches) bad();
  if (schema.containsKey('enum') && !(schema['enum']! as List).any((Object? v) => jsonEncode(v) == jsonEncode(value))) bad();
  if (schema.containsKey('const') && jsonEncode(schema['const']) != jsonEncode(value)) bad();
  if (value is String) {
    if (schema['format'] == 'date-time') {
      final RegExpMatch? match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$').firstMatch(value);
      final DateTime? parsed = DateTime.tryParse(value);
      if (match == null || parsed == null ||
          <int>[parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second]
            .asMap().entries.any((MapEntry<int, int> e) => e.value != int.parse(match.group(e.key + 1)!))) bad();
    }
    if (schema['minLength'] is num && value.runes.length < (schema['minLength']! as num)) bad();
    if (schema['maxLength'] is num && value.runes.length > (schema['maxLength']! as num)) bad();
  }
  if (value is num) {
    if (schema['minimum'] is num && value < (schema['minimum']! as num)) bad();
    if (schema['maximum'] is num && value > (schema['maximum']! as num)) bad();
    if (schema['exclusiveMinimum'] is num && value <= (schema['exclusiveMinimum']! as num)) bad();
    if (schema['exclusiveMaximum'] is num && value >= (schema['exclusiveMaximum']! as num)) bad();
  }
  if (value is List) {
    if (schema['minItems'] is num && value.length < (schema['minItems']! as num)) bad();
    if (schema['maxItems'] is num && value.length > (schema['maxItems']! as num)) bad();
    for (final Object? item in value) { _validate(item, (schema['items']! as Map).cast<String, Object?>(), path); }
  }
  if (value is Map) {
    final Map props = schema['properties'] as Map? ?? <String, Object?>{};
    for (final Object? required in schema['required'] as List? ?? <Object?>[]) {
      if (!value.containsKey(required)) throw McpMappingError(_pointer(path, required! as String));
    }
    for (final MapEntry e in value.entries) {
      if (e.key is! String) bad();
      if (!props.containsKey(e.key)) {
        if (schema['additionalProperties'] == false) bad();
      } else {
        _validate(e.value, (props[e.key] as Map).cast<String, Object?>(), _pointer(path, e.key as String));
      }
    }
  }
}
