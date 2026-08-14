// 🔴 16 册 §9 acceptance — the whole chain, over REAL files and a REAL zip.
//
// Every row of §9's table has a test here or in portable_fpr_format_test.dart /
// portable_ui_widget_test.dart. The headline one is the first group: export N →
// clear → import → N rows, compared FIELD BY FIELD (not by count), then the same
// file imported a second time and still N.
//
// The archive is written by `PortableExporter` and read by `PortableImporter` —
// no hand-built fixtures on the happy path, because a fixture agrees with
// whatever the test author believed rather than with what the exporter does.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/portable/fpr_archive.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/portable/fpr_record.dart';
import 'package:flowmic/src/portable/portable_export.dart';
import 'package:flowmic/src/portable/portable_import.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/portable_fakes.dart';
import 'support/portable_rows.dart';

/// One export/import world over a real temp directory.
class _World {
  _World(this.dir)
    : images = FileOutboxBlobStore('${dir.path}/blobs'),
      exportVault = InMemoryUnknownFieldVault(),
      importVault = InMemoryUnknownFieldVault();

  final Directory dir;

  /// A REAL file-backed blob store: the export reads pictures through the same
  /// class production uses, so "do the pictures travel with the archive" is
  /// proved against the real thing rather than against a map (13 册 §7 F1 ③).
  final FileOutboxBlobStore images;
  final InMemoryUnknownFieldVault exportVault;
  final InMemoryUnknownFieldVault importVault;

  late RecordingExportDestination destination;

  String get work => dir.path;

  Future<String?> export(
    List<TimelineEntry> rows, {
    bool includeImages = true,
    String? version = '0.2.36',
  }) async {
    destination = RecordingExportDestination('${dir.path}/out');
    final AssetInventory inv = TimelineAssetInventory(
      rows: ListRowSource(rows),
      images: images,
    );
    final ExportOutcome o = await PortableExporter(
      inventory: inv,
      images: images,
      destination: destination,
      version: FixedAppVersion(version),
      vault: exportVault,
      workDir: work,
      deviceName: 'TestPhone-0000',
    ).run(includeAttachments: includeImages, readme: _readme);
    expect(o.failure, isNull, reason: 'export failed: ${o.detail}');
    return destination.savedPath;
  }

  Future<ImportReport> import(String archive, MapImportSink sink) =>
      PortableImporter(
        source: FixedImportSource(archive),
        sink: sink,
        images: images,
        vault: importVault,
        workDir: work,
      ).run();
}

String _readme({
  required DateTime exportedAt,
  required int entryCount,
  required int attachmentCount,
  required bool hasAttachments,
  required String? appVersion,
}) =>
    'FlowMic\n这份文件里是你的原文，没有加密。谁拿到它都能看。\n'
    'exported=$exportedAt count=$entryCount att=$attachmentCount '
    'hasAtt=$hasAttachments version=$appVersion\n';

Future<List<String>> _recordLines(String archivePath) async {
  final FprArchiveReader r = (await FprArchiveReader.open(archivePath))!;
  final Directory tmp = await Directory.systemTemp.createTemp('fpr_read');
  try {
    final String out = '${tmp.path}/records.jsonl';
    expect(await r.extractRecords(out), isTrue);
    return const LineSplitter()
        .convert(await File(out).readAsString())
        .where((String l) => l.trim().isNotEmpty)
        .toList();
  } finally {
    await r.close();
    await tmp.delete(recursive: true);
  }
}

void main() {
  late Directory root;
  late _World w;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('flowmic_portable');
    w = _World(root);
  });

  tearDown(() async {
    if (root.existsSync()) await root.delete(recursive: true);
  });

  group('🔴 §5.1 round-trip', () {
    test('export N → clear → import → N rows, FIELD BY FIELD identical', () async {
      final List<TimelineEntry> rows = testRows(7);
      final String archive = (await w.export(rows))!;

      // "clear": a brand-new store with nothing in it.
      final MapImportSink sink = MapImportSink();
      final ImportReport r = await w.import(archive, sink);

      expect(r.fileRefusal, isNull);
      expect(r.refusedCount, 0, reason: 'no line may be refused on a clean round trip');
      expect(r.added, 7);
      expect(sink.rows.length, 7);

      for (final TimelineEntry before in rows) {
        final TimelineEntry? after = sink.rows[before.id];
        expect(after, isNotNull, reason: 'row ${before.id} did not come back');
        // Field by field, via the ONE serializer both directions use.
        expect(
          after!.toJson(),
          equals(before.toJson()),
          reason: 'row ${before.id} came back different',
        );
      }
    });

    test('🔴 the ONE documented one-way collapse: an empty source_text comes '
        'back as null (16 册 §4.2 empty-string normalisation) — pinned so nobody reads the '
        'field-by-field test above as "every row is byte-identical"', () async {
      final TimelineEntry blank = testRow(
        id: 'loc_d_blank-1',
        clientId: 'blank-1',
        text: '',
        entryType: TimelineEntry.kImage,
      );
      expect(blank.sourceText, '', reason: 'precondition: in-memory on the device it is an empty string');

      final String archive = (await w.export(<TimelineEntry>[blank]))!;
      final MapImportSink sink = MapImportSink();
      expect((await w.import(archive, sink)).added, 1);

      final TimelineEntry back = sink.rows['loc_d_blank-1']!;
      expect(back.sourceText, isNull, reason: '"structurally there is no source text" — this is a ruling, not a defect');
      // Everything else DID survive byte for byte — the collapse is exactly one
      // field, not a general looseness.
      final Map<String, Object?> a = blank.toJson()..remove('source_text');
      final Map<String, Object?> b = back.toJson()..remove('source_text');
      expect(b, equals(a));
      // …and `outputText` is non-null on the row by construction, so the same
      // rule lands as '' → null → '' and round-trips unchanged.
      expect(back.outputText, blank.outputText);
    });

    test('the SAME file imported twice is still N (idempotent, deduped by id)', () async {
      final List<TimelineEntry> rows = testRows(5);
      final String archive = (await w.export(rows))!;
      final MapImportSink sink = MapImportSink();

      final ImportReport first = await w.import(archive, sink);
      expect(first.added, 5);
      expect(first.skippedExisting, 0);

      final ImportReport second = await w.import(archive, sink);
      expect(second.added, 0);
      expect(second.skippedExisting, 5, reason: '§5.2 "N already exist (not imported again)"');
      expect(sink.rows.length, 5, reason: '🔴 red line: import must not grow a pile of duplicate rows');
    });

    test('a picture row round-trips its bytes through att/', () async {
      final Uint8List png = Uint8List.fromList(
        List<int>.generate(512, (int i) => (i * 7) % 256),
      );
      await w.images.put(requestId: 'img-1', bytes: png, extension: 'png');
      final TimelineEntry row = testRow(
        id: 'loc_dev_img-1',
        clientId: 'img-1',
        text: '',
        entryType: TimelineEntry.kImage,
        thumbB64: 'AAAA',
      );

      final String archive = (await w.export(<TimelineEntry>[row]))!;
      final FprArchiveReader reader = (await FprArchiveReader.open(archive))!;
      final List<String> names = reader.memberNames;
      await reader.close();
      expect(names, contains(kFprRecordsName));
      expect(names, contains(kFprReadmeName));
      expect(
        names.where((String n) => n.startsWith('att/')).length,
        1,
        reason: 'the picture must be in the archive exactly once',
      );

      // Import into an empty world whose blob store is also empty.
      final Directory root2 = await Directory.systemTemp.createTemp('fpr_in');
      final _World w2 = _World(root2);
      try {
        final MapImportSink sink = MapImportSink();
        final ImportReport r = await w2.import(archive, sink);
        expect(r.added, 1);
        expect(r.missingAttachments, 0);
        final String? path = await w2.images.pathFor('img-1');
        expect(path, isNotNull, reason: 'the row must be able to find its picture');
        expect(await w2.images.read(path!), equals(png));
      } finally {
        await root2.delete(recursive: true);
      }
    });

    test('one picture referenced by two rows is stored once (content-addressed)',
        () async {
      final Uint8List png = Uint8List.fromList(List<int>.filled(64, 9));
      await w.images.put(requestId: 'a-1', bytes: png, extension: 'png');
      await w.images.put(requestId: 'b-1', bytes: png, extension: 'png');
      final String archive = (await w.export(<TimelineEntry>[
        testRow(id: 'loc_d_a-1', clientId: 'a-1', text: '', entryType: TimelineEntry.kImage),
        testRow(id: 'loc_d_b-1', clientId: 'b-1', text: '', entryType: TimelineEntry.kImage),
      ]))!;
      final FprArchiveReader reader = (await FprArchiveReader.open(archive))!;
      final int atts =
          reader.memberNames.where((String n) => n.startsWith('att/')).length;
      await reader.close();
      expect(atts, 1);
    });
  });

  group('§4.1 header', () {
    test('count equals the actual number of entry lines', () async {
      final String archive = (await w.export(testRows(11)))!;
      final List<String> lines = await _recordLines(archive);
      final Map<String, Object?> header =
          jsonDecode(lines.first) as Map<String, Object?>;
      expect(header['kind'], 'header');
      expect(header['count'], 11);
      expect(lines.length - 1, 11);
      expect((header['source']! as Map<String, Object?>)['end'], 'mobile');
      expect((header['source']! as Map<String, Object?>)['version'], '0.2.36');
    });

    test('a version the phone could not read stays null in the file', () async {
      final String archive = (await w.export(testRows(1), version: null))!;
      final Map<String, Object?> header =
          jsonDecode((await _recordLines(archive)).first) as Map<String, Object?>;
      expect((header['source']! as Map<String, Object?>)['version'], isNull);
    });
  });

  group('§8-3 "without pictures"', () {
    test('no att/, has_attachments:false, and the PICTURE ROW IS STILL THERE '
        'with attachment:null', () async {
      final Uint8List png = Uint8List.fromList(List<int>.filled(32, 3));
      await w.images.put(requestId: 'p-1', bytes: png, extension: 'png');
      final List<TimelineEntry> rows = <TimelineEntry>[
        testRow(id: 'loc_d_t-1', clientId: 't-1', text: '文字'),
        testRow(
          id: 'loc_d_p-1',
          clientId: 'p-1',
          text: '',
          entryType: TimelineEntry.kImage,
        ),
      ];
      final String archive = (await w.export(rows, includeImages: false))!;

      final FprArchiveReader reader = (await FprArchiveReader.open(archive))!;
      final List<String> names = reader.memberNames;
      await reader.close();
      expect(
        names.where((String n) => n.startsWith('att/')),
        isEmpty,
        reason: '§8-3: must not produce att/',
      );

      final List<String> lines = await _recordLines(archive);
      expect(
        (jsonDecode(lines.first) as Map<String, Object?>)['has_attachments'],
        isFalse,
      );
      final List<Map<String, Object?>> entries = <Map<String, Object?>>[
        for (final String l in lines.skip(1))
          jsonDecode(l) as Map<String, Object?>,
      ];
      expect(entries, hasLength(2), reason: '🔴 the picture row is still there as a whole, not dropped');
      final Map<String, Object?> pic =
          entries.firstWhere((Map<String, Object?> e) => e['id'] == 'loc_d_p-1');
      expect(pic['entry_type'], 'image');
      expect(pic['attachment'], isNull);
    });
  });

  group('🔴 §9b #1 STORE-only container', () {
    test('everything WE write is compression method 0', () async {
      final Uint8List png = Uint8List.fromList(List<int>.filled(4096, 1));
      await w.images.put(requestId: 'z-1', bytes: png, extension: 'png');
      final String archive = (await w.export(<TimelineEntry>[
        ...testRows(3),
        testRow(id: 'loc_d_z-1', clientId: 'z-1', text: '', entryType: TimelineEntry.kImage),
      ]))!;
      final Archive a = ZipDecoder().decodeBytes(await File(archive).readAsBytes());
      expect(a.files, isNotEmpty);
      for (final ArchiveFile f in a.files) {
        expect(
          f.compression,
          anyOf(isNull, CompressionType.none),
          reason: '${f.name} is not STORE — the desktop end cannot inflate it',
        );
      }
      // Positive control for the negative below: this one imports.
      final FprArchiveReader r = (await FprArchiveReader.open(archive))!;
      expect(r.hasCompressedMember, isFalse);
      await r.close();
      expect((await w.import(archive, MapImportSink())).fileRefusal, isNull);
    });

    test('🔴 a re-compressed archive is refused BY NAME, not inflated and not '
        'silently skipped', () async {
      // Take a real export and rebuild it with deflate — exactly what a user
      // gets by unzipping and zipping again.
      final String original = (await w.export(testRows(3)))!;
      final Archive a =
          ZipDecoder().decodeBytes(await File(original).readAsBytes());
      final Archive rebuilt = Archive();
      for (final ArchiveFile f in a.files) {
        rebuilt.add(ArchiveFile.bytes(f.name, f.readBytes()!));
      }
      final String deflated = '${root.path}/deflated.zip';
      await File(deflated).writeAsBytes(
        ZipEncoder().encodeBytes(rebuilt, level: 6),
      );
      // Precondition: it really is compressed now.
      final FprArchiveReader r = (await FprArchiveReader.open(deflated))!;
      expect(r.hasCompressedMember, isTrue, reason: 'precondition');
      await r.close();

      final MapImportSink sink = MapImportSink();
      final ImportReport report = await w.import(deflated, sink);
      expect(report.fileRefusal, FprFileRefusal.compressedMember);
      expect(sink.rows, isEmpty, reason: 'refusal means write zero rows');
    });
  });

  group('§5.3 same-end admission', () {
    test('🔴 a DESKTOP file is refused by name and NOTHING is written', () async {
      final String archive = await _forgeArchive(
        root,
        header: <String, Object?>{
          'fpr': 1,
          'kind': 'header',
          'exported_at': '2026-08-01T00:00:00.000Z',
          'source': <String, Object?>{
            'app': 'flowmic',
            'end': 'desktop',
            'version': '0.2.36',
            'device': 'DESKTOP-7',
          },
          'count': 1,
          'has_attachments': false,
          'scope': <String, Object?>{'kind': 'all'},
        },
        entries: <Map<String, Object?>>[
          fprRecordOfRow(testRow(id: 'req:abc', text: 'from a PC')).toJson(),
        ],
      );
      final MapImportSink sink = MapImportSink();
      final ImportReport r = await w.import(archive, sink);
      expect(r.fileRefusal, FprFileRefusal.crossEnd);
      expect(r.otherEnd, 'desktop');
      expect(sink.rows, isEmpty, reason: 'refusal means write zero rows');
    });

    test('positive control: the SAME shape with end=mobile imports fine '
        '(otherwise the refusal above could be a blind probe)', () async {
      final String archive = await _forgeArchive(
        root,
        header: <String, Object?>{
          'fpr': 1,
          'kind': 'header',
          'exported_at': '2026-08-01T00:00:00.000Z',
          'source': <String, Object?>{
            'app': 'flowmic',
            'end': 'mobile',
            'version': '0.2.36',
            'device': 'Phone',
          },
          'count': 1,
          'has_attachments': false,
          'scope': <String, Object?>{'kind': 'all'},
        },
        entries: <Map<String, Object?>>[
          fprRecordOfRow(testRow(id: 'loc_d_ok-1', clientId: 'ok-1', text: 'x'))
              .toJson(),
        ],
      );
      final MapImportSink sink = MapImportSink();
      final ImportReport r = await w.import(archive, sink);
      expect(r.fileRefusal, isNull);
      expect(r.added, 1);
    });
  });

  group('§4.1 / §9 count mismatch', () {
    test('🔴 a header that lies about the count is refused whole', () async {
      final String archive = await _forgeArchive(
        root,
        header: <String, Object?>{
          'fpr': 1,
          'kind': 'header',
          'exported_at': '2026-08-01T00:00:00.000Z',
          'source': <String, Object?>{'app': 'flowmic', 'end': 'mobile'},
          'count': 9,
          'has_attachments': false,
          'scope': <String, Object?>{'kind': 'all'},
        },
        entries: <Map<String, Object?>>[
          fprRecordOfRow(testRow(id: 'loc_d_c-1', clientId: 'c-1', text: 'x')).toJson(),
        ],
      );
      final MapImportSink sink = MapImportSink();
      final ImportReport r = await w.import(archive, sink);
      expect(r.fileRefusal, FprFileRefusal.countMismatch);
      expect(sink.rows, isEmpty);
    });
  });

  group('§5.2 four outcomes', () {
    test('added / already-exists / named refusal / missing attachment — each one counted, and the '
        'report is PARTIAL, not "complete"', () async {
      final Map<String, Object?> ok1 =
          fprRecordOfRow(testRow(id: 'loc_d_n-1', clientId: 'n-1', text: 'new')).toJson();
      final Map<String, Object?> dup =
          fprRecordOfRow(testRow(id: 'loc_d_e-1', clientId: 'e-1', text: 'old')).toJson();
      final Map<String, Object?> badMode =
          fprRecordOfRow(testRow(id: 'loc_d_m-1', clientId: 'm-1', text: 'x')).toJson()
            ..['mode'] = 'summarize';
      final Map<String, Object?> badTime =
          fprRecordOfRow(testRow(id: 'loc_d_z-1', clientId: 'z-1', text: 'x')).toJson()
            ..['created_at'] = 'yesterday';
      final Map<String, Object?> lostPic =
          fprRecordOfRow(
            testRow(
              id: 'loc_d_g-1',
              clientId: 'g-1',
              text: '',
              entryType: TimelineEntry.kImage,
            ),
            attachment: 'att/deadbeefdeadbeef.png',
          ).toJson();

      final String archive = await _forgeArchive(
        root,
        header: <String, Object?>{
          'fpr': 1,
          'kind': 'header',
          'exported_at': '2026-08-01T00:00:00.000Z',
          'source': <String, Object?>{'app': 'flowmic', 'end': 'mobile'},
          'count': 5,
          'has_attachments': true,
          'scope': <String, Object?>{'kind': 'all'},
        },
        entries: <Map<String, Object?>>[ok1, dup, badMode, badTime, lostPic],
      );

      final MapImportSink sink = MapImportSink(<String, TimelineEntry>{
        'loc_d_e-1': testRow(id: 'loc_d_e-1', clientId: 'e-1', text: 'old'),
      });
      final ImportReport r = await w.import(archive, sink);

      expect(r.added, 2, reason: 'the new transcript + the picture row');
      expect(r.skippedExisting, 1);
      expect(r.refusedLines[FprLineRefusal.badMode], 1);
      expect(r.refusedLines[FprLineRefusal.badCreatedAt], 1);
      expect(r.refusedCount, 2);
      expect(r.missingAttachments, 1);
      expect(r.partial, isTrue, reason: '🔴 partial success must be said as partial success');
      // The picture row itself IS in (§5.2 table row 4: the row still imports).
      expect(sink.rows.containsKey('loc_d_g-1'), isTrue);
      // 5 entry lines, and 2 + 1 + 2 accounts for every one of them.
      expect(r.added + r.skippedExisting + r.refusedCount, 5);
    });
  });

  group('§5.4 unknown fields: import → export, still there as-is', () {
    test('a future version\'s key survives the store it cannot be stored in',
        () async {
      final Map<String, Object?> line = fprRecordOfRow(
        testRow(id: 'loc_d_f-1', clientId: 'f-1', text: 'x'),
      ).toJson();
      line['fpr_future_flag'] = 'from tomorrow';
      (line['source_ext']! as Map<String, Object?>)['future_ext_key'] = 42;

      final String archive = await _forgeArchive(
        root,
        header: <String, Object?>{
          'fpr': 1,
          'kind': 'header',
          'exported_at': '2026-08-01T00:00:00.000Z',
          'source': <String, Object?>{'app': 'flowmic', 'end': 'mobile'},
          'count': 1,
          'has_attachments': false,
          'scope': <String, Object?>{'kind': 'all'},
        },
        entries: <Map<String, Object?>>[line],
      );

      final MapImportSink sink = MapImportSink();
      final ImportReport r = await w.import(archive, sink);
      expect(r.added, 1);

      // Re-export from the SAME vault the import wrote into.
      w.exportVault.entries.addAll(w.importVault.entries);
      final String again = (await w.export(sink.rows.values.toList()))!;
      final Map<String, Object?> out =
          jsonDecode((await _recordLines(again))[1]) as Map<String, Object?>;
      expect(out['fpr_future_flag'], 'from tomorrow');
      expect(
        (out['source_ext']! as Map<String, Object?>)['future_ext_key'],
        42,
      );
    });
  });

  group('§7 README', () {
    test('the plaintext warning is IN the archive, not only on screen — and the '
        'zip is readable by a plain ZipDecoder', () async {
      final String archive = (await w.export(testRows(1)))!;
      // Read with the third-party decoder rather than our own reader: this also
      // proves the container is an ordinary zip and not something only we can
      // open (16 册 §2-2 "stream-readable by tools").
      final Archive a = ZipDecoder().decodeBytes(await File(archive).readAsBytes());
      final ArchiveFile? readme = a.findFile(kFprReadmeName);
      expect(readme, isNotNull);
      final String text = utf8.decode(readme!.readBytes()!);
      expect(text, contains('谁拿到它都能看'));
      expect(
        text.contains('妥善保管'),
        isFalse,
        reason: '⛔ 16 册 §7-1 explicitly forbids this sentence that does not name the consequence',
      );
    });
  });

  group('§6 inventory layer ⇔ export', () {
    test('"tally says N rows" and "export produced N rows" are the same number', () async {
      final Uint8List png = Uint8List.fromList(List<int>.filled(1000, 5));
      await w.images.put(requestId: 'i-1', bytes: png, extension: 'png');
      final List<TimelineEntry> rows = <TimelineEntry>[
        ...testRows(4),
        testRow(id: 'loc_d_i-1', clientId: 'i-1', text: '', entryType: TimelineEntry.kImage),
      ];
      final AssetTally tally = await TimelineAssetInventory(
        rows: ListRowSource(rows),
        images: w.images,
      ).tally();

      final String archive = (await w.export(rows))!;
      final Map<String, Object?> header =
          jsonDecode((await _recordLines(archive)).first) as Map<String, Object?>;

      expect(header['count'], tally.entryCount);
      expect(tally.imageFileCount, 1);
      expect(tally.imageBytes, 1000, reason: 'the byte count that was actually computed, not an estimate');
    });
  });

  group('§8 performance', () {
    test('2000 rows export end-to-end, and the wall time is REPORTED not '
        'asserted away', () async {
      final List<TimelineEntry> rows = testRows(2000);
      final Stopwatch sw = Stopwatch()..start();
      final String archive = (await w.export(rows))!;
      sw.stop();
      final int bytes = await File(archive).length();
      // Printed on purpose: this is a HOST-VM number. It bounds the algorithm
      // (streaming, one pass), NOT the phone — real-device unproven.
      // ignore: avoid_print
      print(
        '[perf] 2000-row export: ${sw.elapsedMilliseconds}ms, '
        'archive ${bytes}B',
      );
      final List<String> lines = await _recordLines(archive);
      expect(lines.length, 2001);
      expect(
        (jsonDecode(lines.first) as Map<String, Object?>)['count'],
        2000,
      );
    });
  });
}

/// Builds an archive from RAW json — the only way to produce a file our own
/// exporter would never write (a cross-end header, a lying count, a corrupt
/// line). Never used on the happy path.
Future<String> _forgeArchive(
  Directory root, {
  required Map<String, Object?> header,
  required List<Map<String, Object?>> entries,
}) async {
  final Directory d = await Directory('${root.path}/forge').create(recursive: true);
  final String records = '${d.path}/$kFprRecordsName';
  final StringBuffer b = StringBuffer()..writeln(jsonEncode(header));
  for (final Map<String, Object?> e in entries) {
    b.writeln(jsonEncode(e));
  }
  await File(records).writeAsString(b.toString());
  final String zip = '${d.path}/forged-${entries.length}-${header['count']}-'
      '${(header['source']! as Map<String, Object?>)['end']}.zip';
  final FprArchiveWriter w = FprArchiveWriter(zip);
  w.open();
  await w.addRecords(records);
  w.addReadme('forged');
  await w.close();
  return zip;
}
