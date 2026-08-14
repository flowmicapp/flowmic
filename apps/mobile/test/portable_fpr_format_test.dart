// 16 册 §9 acceptance — the PURE half: §4.1 header, §4.2 record line,
// §5.2 named per-line refusals, §5.4 unknown-field preservation, §3 path safety.
//
// No files, no zip, no plugin: everything here is a rule a future MCP reader
// will also have to obey, so it is proved without a device.

import 'dart:convert';

import 'package:flowmic/src/portable/fpr_archive.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/portable/fpr_record.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/portable_rows.dart';

void main() {
  group('§4.1 header', () {
    test('every key the contract names, and `fpr` on the line itself', () {
      final FprHeader h = FprHeader(
        exportedAt: DateTime.utc(2026, 8, 1, 9, 12, 33),
        end: kFprEndMobile,
        appVersion: '0.2.36',
        device: 'Pixel 8-3f2a',
        count: 128,
        hasAttachments: true,
      );
      final Map<String, Object?> j = h.toJson();
      expect(j['fpr'], 1);
      expect(j['kind'], 'header');
      expect(j['exported_at'], '2026-08-01T09:12:33.000Z');
      expect((j['source']! as Map<String, Object?>)['end'], 'mobile');
      expect((j['source']! as Map<String, Object?>)['version'], '0.2.36');
      expect(j['count'], 128);
      expect(j['has_attachments'], isTrue);
      expect((j['scope']! as Map<String, Object?>)['kind'], 'all');
    });

    test('🔴 `truncated_before` is OMITTED when unknown — never a guessed '
        'instant (§4.1)', () {
      final Map<String, Object?> scope =
          const FprScope.all().toJson();
      expect(scope.containsKey('truncated_before'), isFalse);
    });

    test('a version this build could not read is written as null, not as a '
        'stand-in string', () {
      final FprHeader h = FprHeader(
        exportedAt: DateTime.utc(2026, 8, 1),
        end: kFprEndMobile,
        appVersion: null,
        device: null,
        count: 0,
        hasAttachments: false,
      );
      final Map<String, Object?> src = h.toJson()['source']! as Map<String, Object?>;
      expect(src.containsKey('version'), isTrue);
      expect(src['version'], isNull);
      // §4.1 (2026-08-01): `source.device` is written explicitly too — 「两种做法
      // 都讲得通就等于没有规则」, so both ends omit nothing.
      expect(src.containsKey('device'), isTrue);
      expect(src['device'], isNull);
    });
  });

  group('§4.2 record line', () {
    test('core fields are promoted and window_title is always PRESENT', () {
      final TimelineEntry row = testRow(id: 'loc_dev_u1-1', text: '你好');
      final Map<String, Object?> j = fprRecordOfRow(row).toJson();
      expect(j['fpr'], 1);
      expect(j['kind'], 'entry');
      expect(j['id'], 'loc_dev_u1-1');
      expect(j['entry_type'], 'transcript');
      expect(j['mode'], 'realtime');
      expect(j['source_text'], '你好');
      expect(j['status'], 'cached');
      // §4.2: present-with-null says 「这个字段存在且我们没有它」.
      expect(j.containsKey('window_title'), isTrue);
      expect(j['window_title'], isNull);
      expect(j.containsKey('attachment'), isTrue);
    });

    test('🔴 top-level `window_title` is a DECLARATION SLOT: null even when the '
        'row HAS a title, and the real title is in source_ext.inject_target '
        '(16 册 §4.2, 2026-08-01, both ends identical word for word)', () {
      final TimelineEntry row = testRow(
        id: 'loc_dev_u2-1',
        text: 'hi',
        injectTarget: const InjectTarget(
          windowTitle: '无标题 - 记事本',
          processName: 'notepad',
          injectedAt: '2026-08-01T00:00:00.000Z',
        ),
      );
      final Map<String, Object?> j = fprRecordOfRow(row).toJson();
      // ① the slot exists and is constant
      expect(j.containsKey('window_title'), isTrue);
      expect(
        j['window_title'],
        isNull,
        reason: 'a title here would give one key two meanings across the ends',
      );
      // ② nothing was thrown away — the pocket key is spelled `inject_target`
      final Map<String, Object?> ext = j['source_ext']! as Map<String, Object?>;
      final Map<String, Object?> target =
          (ext['inject_target']! as Map).cast<String, Object?>();
      expect(target['window_title'], '无标题 - 记事本');
      expect(target['process_name'], 'notepad');
      expect(ext.containsKey('target'), isFalse, reason: 'the key name is inject_target');
    });

    test('🔴 empty strings are normalised to null, and only at the serialisation layer (16 册 §4.2, 2026-08-01, '
        'both ends the same)', () {
      // A picture row: no spoken original. `''` would say "there is text, and it is empty".
      final TimelineEntry pic = testRow(
        id: 'loc_d_pic-1',
        clientId: 'pic-1',
        text: '',
        entryType: TimelineEntry.kImage,
      );
      expect(pic.sourceText, '', reason: 'the in-end model is unchanged, still an empty string');
      final Map<String, Object?> j = fprRecordOfRow(pic).toJson();
      expect(j.containsKey('source_text'), isTrue, reason: 'the key is present, only the value is null');
      expect(j['source_text'], isNull);
      // A non-empty one is untouched.
      expect(
        fprRecordOfRow(testRow(id: 'loc_d_t-1', text: '有字'))
            .toJson()['source_text'],
        '有字',
      );
    });

    test('output_text follows the same rule', () {
      final TimelineEntry blank = TimelineEntry(
        id: 'loc_d_b-1',
        clientId: 'b-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: null,
        outputText: '',
        status: EntryStatus.noted,
        createdAt: DateTime.utc(2026, 8, 1),
        updatedAt: DateTime.utc(2026, 8, 1),
      );
      final Map<String, Object?> j = fprRecordOfRow(blank).toJson();
      expect(j.containsKey('output_text'), isTrue);
      expect(j['output_text'], isNull);
    });

    test('the header normalises `version` / `device` the same way, and both '
        'keys stay PRESENT', () {
      final Map<String, Object?> src = FprHeader(
        exportedAt: DateTime.utc(2026, 8, 1),
        end: kFprEndMobile,
        appVersion: '',
        device: '',
        count: 0,
        hasAttachments: false,
      ).toJson()['source']! as Map<String, Object?>;
      expect(src.containsKey('version'), isTrue);
      expect(src.containsKey('device'), isTrue);
      expect(src['version'], isNull);
      expect(src['device'], isNull);
    });

    test('🔴 `source_ext.inject_target` on a NEVER-DELIVERED row is an explicit '
        'null, never an omitted key (§4.2 the same criterion)', () {
      final Map<String, Object?> ext =
          fprRecordOfRow(testRow(id: 'loc_d_n-1', text: '没投过'))
              .toJson()['source_ext']! as Map<String, Object?>;
      expect(
        ext.containsKey('inject_target'),
        isTrue,
        reason: 'omitting it would let a reader think an older version simply did not write it',
      );
      expect(ext['inject_target'], isNull);
    });

    test('🔴 source_ext is not a bin: the pocket + the promotions + the drops '
        'account for EVERY key TimelineEntry.toJson emits', () {
      final Set<String> emitted = testRow(id: 'x', text: 'y').toJson().keys.toSet();
      // Pins the documented table against reality. A new field on the row makes
      // this fail until somebody decides, in writing, where it goes.
      expect(
        emitted,
        equals(kMobileRowKeys),
        reason: 'TimelineEntry.toJson changed — update kMobileRowKeys and decide '
            'whether the new key is a core field, a source_ext key, or dropped',
      );
      expect(
        kFprPromotedRowKeys
            .union(kMobileSourceExtKeys)
            .union(kFprDroppedRowKeys),
        equals(kMobileRowKeys),
        reason: 'every row key must be promoted, pocketed or explicitly dropped',
      );
      expect(
        kFprPromotedRowKeys.intersection(kMobileSourceExtKeys),
        isEmpty,
        reason: 'a key that is both a core field and a pocket key has two homes',
      );
    });

    test('the pocket really carries the phone-only fields', () {
      final TimelineEntry row = testRow(id: 'loc_d_u3-1', text: 'z');
      final Map<String, Object?> ext =
          fprRecordOfRow(row).toJson()['source_ext']! as Map<String, Object?>;
      for (final String k in kMobileSourceExtKeys) {
        expect(ext.containsKey(k), isTrue, reason: 'missing pocket key $k');
      }
      expect(ext.containsKey('deleted'), isFalse);
      expect(ext.containsKey('id'), isFalse);
    });
  });

  group('§5.2 every per-line refusal must be named', () {
    FprLineRefusal? refusalOf(Map<String, Object?> j) =>
        readFprLine(jsonEncode(j), allowHeader: false).refusal;

    Map<String, Object?> good() =>
        fprRecordOfRow(testRow(id: 'loc_d_u9-1', text: 'ok')).toJson();

    test('a well-formed line is NOT refused (the positive control — without it '
        'every negative below could be a blind probe)', () {
      final FprLineRead read = readFprLine(jsonEncode(good()), allowHeader: false);
      expect(read.refusal, isNull);
      expect(read.record, isNotNull);
    });

    test('not JSON', () {
      expect(
        readFprLine('{not json', allowHeader: false).refusal,
        FprLineRefusal.notJson,
      );
    });

    test('unknown fpr version', () {
      expect(refusalOf(good()..['fpr'] = 99), FprLineRefusal.unknownFprVersion);
    });

    test('unknown kind', () {
      expect(refusalOf(good()..['kind'] = 'note'), FprLineRefusal.unknownKind);
    });

    test('a header in the middle of the file', () {
      final FprHeader h = FprHeader(
        exportedAt: DateTime.utc(2026),
        end: kFprEndMobile,
        appVersion: null,
        device: null,
        count: 0,
        hasAttachments: false,
      );
      expect(
        readFprLine(jsonEncode(h.toJson()), allowHeader: false).refusal,
        FprLineRefusal.strayHeader,
      );
      // …and IS accepted as line one.
      expect(
        readFprLine(jsonEncode(h.toJson()), allowHeader: true).header,
        isNotNull,
      );
    });

    test('missing id', () {
      expect(refusalOf(good()..['id'] = ''), FprLineRefusal.missingId);
    });

    test('created_at that is not an instant', () {
      expect(
        refusalOf(good()..['created_at'] = 'yesterday'),
        FprLineRefusal.badCreatedAt,
      );
    });

    test('🔴 a fourth mode is refused BY NAME (三模式红线)', () {
      expect(refusalOf(good()..['mode'] = 'summarize'), FprLineRefusal.badMode);
      // and each of the three real ones passes
      for (final String m in kFprModes) {
        expect(refusalOf(good()..['mode'] = m), isNull, reason: m);
      }
    });

    test('status / entry_type outside the closed sets', () {
      expect(refusalOf(good()..['status'] = 'delivered'), FprLineRefusal.badStatus);
      expect(refusalOf(good()..['entry_type'] = 'video'), FprLineRefusal.badEntryType);
    });
  });

  group('§5.4 unknown fields', () {
    test('a future top-level key and a future source_ext key are both '
        'recognised as carried', () {
      final Map<String, Object?> j = fprRecordOfRow(
        testRow(id: 'loc_d_u4-1', text: 'a'),
      ).toJson();
      j['future_top'] = <String, Object?>{'a': 1};
      (j['source_ext']! as Map<String, Object?>)['future_ext'] = 'keep me';

      final FprEntryRecord r =
          readFprLine(jsonEncode(j), allowHeader: false).record!;
      final FprCarriedFields c = carriedFieldsOf(r);
      expect(c.top['future_top'], <String, Object?>{'a': 1});
      expect(c.ext['future_ext'], 'keep me');

      // …and putting them back reproduces both, in their own namespaces.
      final Map<String, Object?> again = fprRecordOfRow(
        TimelineEntry.fromJson(rowJsonOfFpr(r))!,
        carried: c,
      ).toJson();
      expect(again['future_top'], <String, Object?>{'a': 1});
      expect(
        (again['source_ext']! as Map<String, Object?>)['future_ext'],
        'keep me',
      );
    });

    test('a carried key cannot shadow a key this build owns', () {
      final TimelineEntry row = testRow(id: 'loc_d_u5-1', text: 'b');
      final Map<String, Object?> j = fprRecordOfRow(
        row,
        carried: const FprCarriedFields(
          top: <String, Object?>{'id': 'HIJACKED', 'fpr': 42},
          ext: <String, Object?>{},
        ),
      ).toJson();
      expect(j['id'], 'loc_d_u5-1');
      expect(j['fpr'], 1);
    });
  });

  group('§3 zip member names', () {
    test('the names we mint are accepted', () {
      expect(isSafeArchiveName('records.jsonl'), isTrue);
      expect(isSafeArchiveName('README.txt'), isTrue);
      expect(isSafeArchiveName('att/0123456789abcdef.jpg'), isTrue);
    });

    test('🔴 traversal and absolute paths are refused', () {
      for (final String bad in <String>[
        '',
        '/etc/passwd',
        r'C:\windows\system32',
        '../../secret',
        'att/../../secret',
        'att/./x.png',
        r'att\x.png',
        'nested/dir/x.png',
        'other/0123.jpg',
        'att/',
      ]) {
        expect(isSafeArchiveName(bad), isFalse, reason: bad);
      }
    });
  });
}
