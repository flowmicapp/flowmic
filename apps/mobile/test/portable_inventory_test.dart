// 16 册 §6 acceptance — the inventory layer.
//
// The overview design §5-2's verdict question is 「统计说 N 条 M 字节，导出出来是不是恰好
// N 条？」. The 「导出出来」 half is in portable_roundtrip_test.dart; this file pins
// the 「统计说」 half: the three questions §6-2 requires, each answered from
// measurement rather than from a shape assumption.

import 'dart:typed_data';

import 'support/di.dart';
import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/portable_fakes.dart';
import 'support/portable_rows.dart';

TimelineAssetInventory _inv(
  List<TimelineEntry> rows,
  OutboxBlobStore images,
) => TimelineAssetInventory(rows: ListRowSource(rows), images: images);

void main() {
  test('§6-2 ① which assets exist — transcripts and pictures counted apart', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    await images.put(
      requestId: 'p-1',
      bytes: Uint8List.fromList(List<int>.filled(100, 1)),
      extension: 'png',
    );
    final AssetTally t = await _inv(<TimelineEntry>[
      ...testRows(3),
      testRow(id: 'loc_d_p-1', clientId: 'p-1', text: '', entryType: TimelineEntry.kImage),
    ], images).tally();

    expect(t.entryCount, 4);
    expect(t.transcriptCount, 3);
    expect(t.imageCount, 1);
    expect(t.imageFileCount, 1);
  });

  test('🔴 §6-2 ② byte counts — the picture number is the FILE LENGTH, and the text '
      'number is utf8 of the words', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    await images.put(
      requestId: 'p-1',
      bytes: Uint8List.fromList(List<int>.filled(4321, 2)),
      extension: 'jpg',
    );
    final TimelineEntry text = testRow(id: 'loc_d_t-1', clientId: 't-1', text: '你好');
    final TimelineEntry pic = testRow(
      id: 'loc_d_p-1',
      clientId: 'p-1',
      text: '',
      entryType: TimelineEntry.kImage,
    );
    final AssetTally t = await _inv(<TimelineEntry>[text, pic], images).tally();

    expect(t.imageBytes, 4321);
    // The sum of the per-row figure, not a formula re-derived here — if the two
    // could disagree, the number under the checkbox would stop being the number
    // C2's statistics will show.
    expect(
      t.textBytes,
      TimelineAsset.textBytesOf(text) + TimelineAsset.textBytesOf(pic),
    );
    // …and it really is utf8 of the WORDS: source '你好' (6 B) + output
    // '你好（面）' (15 B). A count over code units would say 2 + 5.
    expect(TimelineAsset.textBytesOf(text), 21);
  });

  test('🔴 an image ROW whose bytes are gone counts as a row but not as a file '
      '(imageCount ≠ imageFileCount is real data, not rounding)', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    final AssetTally t = await _inv(<TimelineEntry>[
      testRow(id: 'loc_d_g-1', clientId: 'g-1', text: '', entryType: TimelineEntry.kImage),
    ], images).tally();

    expect(t.imageCount, 1);
    expect(t.imageFileCount, 0);
    expect(t.imageBytes, 0);
  });

  test('§6-2 ③ time range', () async {
    final AssetTally t = await _inv(testRows(5), InMemoryOutboxBlobStore()).tally();
    expect(t.oldest, DateTime.utc(2026, 8, 1, 8));
    expect(t.newest, DateTime.utc(2026, 8, 1, 8, 0, 4));
  });

  test('an empty timeline answers 0 / null, never a fabricated range', () async {
    final AssetTally t =
        await _inv(const <TimelineEntry>[], InMemoryOutboxBlobStore()).tally();
    expect(t.isEmpty, isTrue);
    expect(t.oldest, isNull);
    expect(t.newest, isNull);
    expect(t.imageBytes, 0);
  });

  test('walk() and tally() see the SAME rows (one traversal, three verbs)',
      () async {
    final List<TimelineEntry> rows = testRows(6);
    final TimelineAssetInventory inv = _inv(rows, InMemoryOutboxBlobStore());
    final List<TimelineAsset> walked = await inv.walk().toList();
    final AssetTally t = await inv.tally();
    expect(walked.length, t.entryCount);
    expect(
      walked.map((TimelineAsset a) => a.entry.id).toSet(),
      rows.map((TimelineEntry e) => e.id).toSet(),
    );
  });

  group('TimelineStore.readAllRowsForInventory', () {
    test('returns EVERY row (not just the loaded page) and drops soft-deleted '
        'ones', () async {
      final InMemoryTimelinePersistence p = InMemoryTimelinePersistence();
      // More than one page, so a paginated read would come back short.
      final List<TimelineEntry> rows = testRows(TimelineStore.pageSize + 12);
      await p.saveAll(rows);
      // One tombstone.
      await p.upsert(rows.first.copyWith(deleted: true));

      final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
      await store.load();
      expect(
        store.entries.length,
        TimelineStore.pageSize,
        reason: 'precondition: the in-memory list really is one page',
      );

      final List<TimelineEntry> all = await store.readAllRowsForInventory();
      expect(all.length, rows.length - 1);
      expect(all.any((TimelineEntry e) => e.id == rows.first.id), isFalse);
      // newest-first
      expect(all.first.createdAt.isAfter(all.last.createdAt), isTrue);
      store.dispose();
    });
  });

  // ── window C2 (16 册 §6.1): statistics = walk + aggregate ─────────────────

  test('🔴 §6.1 word count —— the aggregate is always the sum of per-row entryWordCount', () async {
    final List<TimelineEntry> rows = <TimelineEntry>[
      testRow(id: 'loc_d_a', clientId: 'a', text: '你好 world 123'),
      testRow(id: 'loc_d_b', clientId: 'b', text: '这是一句中文'),
      testRow(id: 'loc_d_c', clientId: 'c', text: '', entryType: TimelineEntry.kImage),
    ];
    final AssetTally t = await _inv(rows, InMemoryOutboxBlobStore()).tally();
    // What is asserted is 「equals the per-row sum」, not some concrete number:
    // swapping the algorithm still keeps this green, while writing a second
    // algorithm at the aggregate site turns it red immediately — that is
    // exactly what it is here to catch.
    int byRow = 0;
    for (final TimelineEntry e in rows) {
      byRow += entryWordCount(e) ?? 0;
    }
    expect(t.wordCount, byRow);
  });

  test('🔴 §6.1 duration —— null is never added into the total as 0; it is reported separately', () async {
    final TimelineEntry withMs = testRow(id: 'loc_d_x', clientId: 'x', text: '有时长');
    final TimelineEntry noMs = testRow(
      id: 'loc_d_y',
      clientId: 'y',
      text: '没时长',
      durationMs: null,
    );
    final AssetTally t = await _inv(<TimelineEntry>[withMs, noMs], InMemoryOutboxBlobStore()).tally();

    expect(withMs.durationMs, isNotNull);
    expect(noMs.durationMs, isNull);
    expect(t.durationMs, withMs.durationMs);
    expect(t.withoutDurationCount, 1);

    // Positive control: when every row has a duration that number is 0,
    // otherwise 「1」 might just be the probe counting forever.
    final AssetTally all = await _inv(<TimelineEntry>[withMs], InMemoryOutboxBlobStore()).tally();
    expect(all.withoutDurationCount, 0);
  });

  test('§6.1 grouping —— the groups sum to the total (the same aggregator, not a second copy of the fields)', () async {
    final List<TimelineEntry> rows = <TimelineEntry>[
      testRow(id: 'loc_d_1', clientId: '1', text: '一'),
      testRow(id: 'loc_d_2', clientId: '2', text: '二'),
      testRow(id: 'loc_d_3', clientId: '3', text: '三').copyWith(spokenToInstanceId: 'other'),
    ];
    final TimelineAssetInventory inv = _inv(rows, InMemoryOutboxBlobStore());
    final AssetTally total = await inv.tally();
    final List<InstanceTally> groups = await inv.tallyByInstance();

    expect(groups, hasLength(2));
    int rowsSum = 0;
    int wordsSum = 0;
    for (final InstanceTally g in groups) {
      rowsSum += g.tally.entryCount;
      wordsSum += g.tally.wordCount;
    }
    expect(rowsSum, total.entryCount);
    expect(wordsSum, total.wordCount);
    // The group with more rows comes first.
    expect(groups.first.instanceId, 'instance-7');
  });
}
