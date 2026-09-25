// Typed field controls. Enum values are selections, arrays are fixed scalar
// lists, nested objects use schema paths. No JSON authoring is required.
import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'mcp_copy.dart';
import 'mcp_editor.dart';
import 'mcp_mapping.dart';

const Map<String, McpText> _labels = <String, McpText>{
  'fixed': McpText.sourceFixed, 'sourceText': McpText.sourceText, 'outputText': McpText.outputText,
  'processedText': McpText.processedText, 'sourceLang': McpText.sourceLang, 'outputLang': McpText.outputLang,
  'processMode': McpText.processMode, 'entryType': McpText.entryType, 'articleId': McpText.articleId,
  'id': McpText.entryId, 'createdIso': McpText.createdIso, 'createdMs': McpText.createdMs,
  'createdSeconds': McpText.createdSeconds, 'recordJson': McpText.recordJson,
};

class McpFieldEditor extends StatelessWidget {
  const McpFieldEditor({super.key, required this.editor, required this.field, required this.strings});
  final McpEditor editor;
  final McpField field;
  final AppStrings strings;
  Map get binding => editor.bindings[field.path] as Map? ?? <String, Object?>{};
  bool get secret => binding['secret'] == true;
  Object? get value => secret ? editor.fixedSecrets[field.path] : binding['value'];

  List<String> get sources {
    if (field.schema.containsKey('enum') || field.schema.containsKey('const') || field.type == 'array' || field.type == 'boolean') return <String>['fixed'];
    if (field.type == 'object') return <String>['recordJson'];
    if (field.type == 'number' || field.type == 'integer') return <String>['fixed', 'createdMs', 'createdSeconds'];
    if (field.schema['format'] == 'date-time') return <String>['fixed', 'createdIso'];
    return _labels.keys.where((String s) => s != 'createdMs' && s != 'createdSeconds').toList();
  }

  void _fixed(Object? value, {bool? isSecret}) {
    final bool protect = isSecret ?? secret;
    _removeChildren();
    editor.bindings[field.path] = <String, Object?>{'source': 'fixed', if (protect) 'secret': true, if (!protect) 'value': value};
    if (protect) { editor.fixedSecrets[field.path] = value; }
    else { editor.fixedSecrets.remove(field.path); }
    editor.changed();
  }
  void _removeChildren() {
    editor.bindings.removeWhere((String path, _) => path.startsWith('${field.path}/'));
    editor.fixedSecrets.removeWhere((String path, _) => path.startsWith('${field.path}/'));
  }

  @override
  Widget build(BuildContext context) {
    final String? source = binding['source'] as String?;
    return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
      Text('${field.path}${field.required ? ' *' : ''}', style: Theme.of(context).textTheme.titleSmall),
      DropdownButtonFormField<String>(key: ValueKey<String>('mcp.source.${field.path}'),
        initialValue: source, isExpanded: true, hint: Text(strings.mcp(McpText.mapping)),
        items: <DropdownMenuItem<String>>[for (final String s in sources) DropdownMenuItem<String>(value: s, child: Text(strings.mcp(_labels[s]!)))],
        onChanged: (String? s) {
          if (s == null) return;
          if (s == 'fixed') {
            final Object? initial = field.schema['const'] ?? (field.schema['enum'] is List ? (field.schema['enum']! as List).first : switch (field.type) {
              'array' => <Object?>[], 'boolean' => false, 'number' || 'integer' => 0, _ => '',
            });
            _fixed(initial, isSecret: RegExp(r'api.?key|token|password|secret', caseSensitive: false).hasMatch(field.path));
          } else {
            _removeChildren();
            editor.bindings[field.path] = <String, Object?>{'source': s};
            editor.fixedSecrets.remove(field.path); editor.changed();
          }
        }),
      if (source == 'fixed') ...<Widget>[
        _fixedEditor(context),
        SwitchListTile(contentPadding: EdgeInsets.zero, title: Text(strings.mcp(McpText.secretValue)),
          value: secret, onChanged: (bool on) => _fixed(value, isSecret: on)),
      ],
      if (source != null) Align(alignment: Alignment.centerRight, child: IconButton(
        tooltip: strings.confirmDelete, icon: const Icon(Icons.clear), onPressed: () {
          editor.bindings.remove(field.path); editor.fixedSecrets.remove(field.path); editor.changed();
        })),
    ]));
  }

  Widget _fixedEditor(BuildContext context) {
    final List? enumeration = field.schema['enum'] as List?;
    if (enumeration != null || field.schema.containsKey('const')) {
      final List choices = enumeration ?? <Object?>[field.schema['const']];
      // Index selection supports scalar, array and object enum constants alike.
      return DropdownButtonFormField<int>(isExpanded: true,
        key: ValueKey<String>('mcp.enum.${field.path}'),
        initialValue: choices.indexWhere((Object? v) => v.toString() == value.toString()).clamp(0, choices.length - 1),
        items: <DropdownMenuItem<int>>[for (int i = 0; i < choices.length; i++) DropdownMenuItem<int>(value: i, child: Text(secret ? '••••' : '${choices[i]}'))],
        onChanged: (int? i) { if (i != null) _fixed(choices[i]); });
    }
    if (field.type == 'array') {
      final List values = value as List? ?? <Object?>[];
      final Map item = field.schema['items']! as Map;
      final String type = item['type']! as String;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
        for (int i = 0; i < values.length; i++) Row(children: <Widget>[
          Expanded(child: _scalar(type, values[i], (Object? v) => _fixed(<Object?>[...values]..[i] = v), '${field.path}.$i', schema: item)),
          IconButton(tooltip: strings.confirmDelete, onPressed: () => _fixed(<Object?>[...values]..removeAt(i)), icon: const Icon(Icons.remove_circle_outline)),
        ]),
        TextButton(onPressed: values.length >= (field.schema['maxItems'] as int? ?? 128) ? null : () => _fixed(<Object?>[
          ...values, item['const'] ?? (item['enum'] is List ? (item['enum']! as List).first : type == 'boolean' ? false : type == 'string' ? '' : 0),
        ]), child: Text(strings.add)),
      ]);
    }
    return _scalar(field.type, value, _fixed, field.path, schema: field.schema);
  }

  Widget _scalar(String type, Object? value, void Function(Object?) set, String key, {required Map schema}) {
    if (schema['enum'] is List || schema.containsKey('const')) {
      final List choices = schema['enum'] as List? ?? <Object?>[schema['const']];
      return DropdownButtonFormField<int>(isExpanded: true, initialValue: choices.indexOf(value).clamp(0, choices.length - 1),
        items: <DropdownMenuItem<int>>[for (int i = 0; i < choices.length; i++) DropdownMenuItem<int>(value: i, child: Text(secret ? '••••' : '${choices[i]}'))],
        onChanged: (int? i) { if (i != null) set(choices[i]); });
    }
    if (type == 'boolean') return Switch(value: value == true, onChanged: set);
    return TextFormField(key: ValueKey<String>('mcp.fixed.$key.$secret'), initialValue: value?.toString() ?? '',
      obscureText: secret, enableSuggestions: !secret, autocorrect: false,
      keyboardType: type == 'string' ? TextInputType.text : const TextInputType.numberWithOptions(decimal: true, signed: true),
      decoration: InputDecoration(labelText: strings.mcp(McpText.sourceFixed)),
      onChanged: (String v) => set(type == 'integer' ? int.tryParse(v) : type == 'number' ? num.tryParse(v) : v));
  }
}
