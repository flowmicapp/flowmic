import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/mcp/mcp_mapping.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

final TimelineEntry row = TimelineEntry(id: 'loc_d_one', clientId: 'one',
  mode: FlowMode.realtime, delivery: Delivery.none, sourceText: 'original',
  outputText: 'edited output', status: EntryStatus.noted, sourceLang: 'en',
  thumbB64: 'private-image-bytes', createdAt: DateTime.utc(2026, 9, 22, 1, 2, 3),
  updatedAt: DateTime.utc(2026, 9, 22), origin: 'cloud');

Map<String, Object?> object(Map<String, Object?> fields) => <String, Object?>{
  'type': 'object', 'properties': fields, 'required': fields.keys.toList(), 'additionalProperties': false,
};
Map<String, Object?> source(String name) => <String, Object?>{'source': name};

void main() {
  test('optional nested objects require their siblings once materialized; UTC dates cannot normalize silently', () {
    final Map<String, Object?> schema = <String, Object?>{'type': 'object', 'properties': <String, Object?>{
      'optional': object(<String, Object?>{'a': <String, Object?>{'type': 'string'}, 'b': <String, Object?>{'type': 'string'}}),
    }};
    expect(McpMapping(schema, <String, Object?>{}).arguments(row, secrets: <String, Object?>{}), isEmpty);
    expect(() => McpMapping(schema, <String, Object?>{'/optional/a': source('outputText')}), throwsA(isA<McpMappingError>()));
    final Map<String, Object?> empty = object(<String, Object?>{'empty': <String, Object?>{'type': 'object'}});
    expect(McpMapping(empty, <String, Object?>{}).arguments(row, secrets: <String, Object?>{}), <String, Object?>{'empty': <String, Object?>{}});
    final Map<String, Object?> time = object(<String, Object?>{'at': <String, Object?>{'type': 'string', 'format': 'date-time'}});
    for (final String invalid in <String>['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '20260101Z']) {
      expect(() => McpMapping(time, <String, Object?>{'/at': <String, Object?>{'source': 'fixed', 'value': invalid}}), throwsA(isA<McpMappingError>()));
    }
  });
  test('official SDK nested object and enum schema maps the actual row', () {
    final Map<dynamic, dynamic> capture = jsonDecode(File('test/fixtures/mcp_sdk_responses.json').readAsStringSync()) as Map;
    final Map<dynamic, dynamic> exchange = (capture['exchanges'] as List).cast<Map<dynamic, dynamic>>().firstWhere((Map<dynamic, dynamic> e) => e['name'] == 'modern-tools');
    final Map<dynamic, dynamic> result = (jsonDecode(exchange['body'] as String) as Map)['result'] as Map;
    final Map<dynamic, dynamic> tool = (result['tools'] as List).cast<Map<dynamic, dynamic>>().firstWhere((Map<dynamic, dynamic> t) => t['name'] == 'submit');
    final Map<String, Object?> schema = (tool['inputSchema'] as Map).cast<String, Object?>();
    final McpMapping mapping = McpMapping(schema, <String, Object?>{
      '/payload/text': source('outputText'), '/kind': <String, Object?>{'source': 'fixed', 'value': 'record'},
    });
    expect(mapping.arguments(row, secrets: <String, Object?>{}), <String, Object?>{
      'payload': <String, Object?>{'text': 'edited output'}, 'kind': 'record',
    });
    expect(() => McpMapping(schema, <String, Object?>{
      '/payload/text': source('outputText'), '/kind': source('entryType'),
    }), throwsA(isA<McpMappingError>()));
  });

  test('three typed time sources are distinct, and date-time cannot use epoch', () {
    final Map<String, Object?> schema = object(<String, Object?>{
      'iso': <String, Object?>{'type': 'string', 'format': 'date-time'},
      'ms': <String, Object?>{'type': 'integer'}, 'sec': <String, Object?>{'type': 'integer'},
    });
    final Map<String, Object?> bindings = <String, Object?>{
      '/iso': source('createdIso'), '/ms': source('createdMs'), '/sec': source('createdSeconds'),
    };
    final Map<String, Object?> args = McpMapping(schema, bindings).arguments(row, secrets: <String, Object?>{});
    expect(args['iso'], '2026-09-22T01:02:03.000Z');
    expect(args['ms'], row.createdAt.millisecondsSinceEpoch);
    expect(args['sec'], row.createdAt.millisecondsSinceEpoch ~/ 1000);
    expect(() => McpMapping(schema, <String, Object?>{...bindings, '/iso': source('createdMs')}), throwsA(isA<McpMappingError>()));
  });

  test('record JSON is the FPR entry row with no thumbnail or attachment bytes', () {
    final McpMapping mapping = McpMapping(object(<String, Object?>{
      'record': <String, Object?>{'type': 'object'}, 'text': <String, Object?>{'type': 'string'},
    }), <String, Object?>{'/record': source('recordJson'), '/text': source('recordJson')});
    final Map<String, Object?> args = mapping.arguments(row, secrets: <String, Object?>{});
    final Map<String, Object?> expected = fprRecordOfRow(row).toJson();
    (expected['source_ext']! as Map).remove('thumb_b64');
    expect(args['record'], expected);
    expect(jsonDecode(args['text']! as String), expected);
    expect(jsonEncode(args), isNot(contains('private-image-bytes')));
    expect((args['record']! as Map)['attachment'], isNull);
  });

  test('missing processed text never borrows output; arrays only accept fixed scalars', () {
    final Map<String, Object?> schema = object(<String, Object?>{'text': <String, Object?>{'type': 'string'}});
    expect(() => McpMapping(schema, <String, Object?>{'/text': source('processedText')})
      .arguments(row, secrets: <String, Object?>{}), throwsA(isA<McpMappingError>()));
    final Map<String, Object?> array = object(<String, Object?>{
      'tags': <String, Object?>{'type': 'array', 'items': <String, Object?>{'type': 'string'}, 'maxItems': 2},
    });
    expect(McpMapping(array, <String, Object?>{'/tags': <String, Object?>{'source': 'fixed', 'value': <String>['one']}})
      .arguments(row, secrets: <String, Object?>{}), <String, Object?>{'tags': <String>['one']});
    expect(() => McpMapping(array, <String, Object?>{'/tags': source('recordJson')}), throwsA(isA<McpMappingError>()));
    for (final Map<String, Object?> unsupported in <Map<String, Object?>>[
      <String, Object?>{'type': 'string', 'pattern': '.*'},
      <String, Object?>{r'$ref': '#/x'},
      <String, Object?>{'type': 'array', 'items': <String, Object?>{'type': 'object'}},
      <String, Object?>{'type': 'string', 'maxLength': 'not-an-integer'},
    ]) {
      expect(() => McpMapping(object(<String, Object?>{'x': unsupported}), <String, Object?>{}),
        throwsA(isA<McpMappingError>().having((McpMappingError e) => e.unsupported, 'unsupported', true)));
    }
  });
}
