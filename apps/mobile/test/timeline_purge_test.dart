// 16 册 §6.2 (clear) + 15 册 G-21 (single-row delete does not delete bytes) —— phone side.
//
// The most important group is 「one delete path」: single-row delete and clear
// must have **exactly the same side effects** on the same row, because before
// this card they did not — `TimelineStore.delete` only deleted the row in the
// table; the picture file and the vault's unknown fields were left alone
// (`discard(` had zero production callers).

import 'dart:typed_data';

import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_purge.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/portable_rows.dart';

final DateTime _now = DateTime.utc(2026, 8, 2, 12);

TimelineEntry _row({
  required String id,
  DateTime? at,
  bool image = false,
}) => testRow(
  id: 'loc_d_$id',
  clientId: id,
  text: '一句话',
  createdAt: at ?? DateTime.utc(2026, 8, 1),
  entryType: image ? TimelineEntry.kImage : TimelineEntry.kTranscript,
);

void main() {
  group('planClear —— two kinds + time windows (owner 2026-08-01 §4-4)', () {
    final List<TimelineEntry> rows = <TimelineEntry>[
      _row(id: 'old-text', at: DateTime.utc(2026, 1, 1)),
      _row(id: 'new-text', at: DateTime.utc(2026, 8, 2)),
      _row(id: 'old-pic', at: DateTime.utc(2026, 1, 1), image: true),
      _row(id: 'new-pic', at: DateTime.utc(2026, 8, 2), image: true),
    ];

    test('「clear pictures · older than a month」 takes only the old picture; the other three stay put', () {
      final List<TimelineEntry> doomed = planClear(
        rows,
        ClearKind.images,
        horizonOf(ClearWindow.month, _now),
      );
      expect(doomed.map((TimelineEntry e) => e.clientId), <String>['old-pic']);
    });

    test('「clear text · older than a month」 is its mirror', () {
      final List<TimelineEntry> doomed = planClear(
        rows,
        ClearKind.text,
        horizonOf(ClearWindow.month, _now),
      );
      expect(doomed.map((TimelineEntry e) => e.clientId), <String>['old-text']);
    });

    test('「all」 has no lower bound; even the newest are taken', () {
      expect(planClear(rows, ClearKind.both, horizonOf(ClearWindow.all, _now)), hasLength(4));
      expect(horizonOf(ClearWindow.all, _now), isNull);
    });

    test('already-soft-deleted rows no longer count toward 「will delete N」', () {
      final TimelineEntry ghost = _row(id: 'ghost', at: DateTime.utc(2026, 1, 1)).copyWith(deleted: true);
      expect(planClear(<TimelineEntry>[ghost], ClearKind.both, horizonOf(ClearWindow.year, _now)), isEmpty);
    });

    test('the five windows get earlier in order, no shuffling', () {
      final List<DateTime> marks = <ClearWindow>[
        ClearWindow.week,
        ClearWindow.month,
        ClearWindow.quarter,
        ClearWindow.halfYear,
        ClearWindow.year,
      ].map((ClearWindow w) => horizonOf(w, _now)!).toList();
      for (int i = 1; i < marks.length; i++) {
        expect(marks[i].isBefore(marks[i - 1]), isTrue, reason: '$i');
      }
    });
  });

  group('cutoffs —— cleared ≠ never existed, and must not over-claim (16 册 §6.2-3)', () {
    final TimelineEntry t = _row(id: 't', at: DateTime.utc(2026, 3, 1));
    final TimelineEntry p = _row(id: 'p', at: DateTime.utc(2026, 4, 1), image: true);

    test('single-row delete advances no mark —— 「I deleted this one」 ≠ 「everything older than it is gone」', () {
      expect(advanceCutoffs(Cutoffs.none, <TimelineEntry>[t], null).isEmpty, isTrue);
    });

    test('🔴 when only pictures are cleared, the UI must not claim the text is gone too', () {
      final Cutoffs after = advanceCutoffs(Cutoffs.none, <TimelineEntry>[p], ClearKind.images);
      expect(after.images, p.createdAt);
      expect(after.text, isNull);
      // A single scalar cutoff would say here 「records older than April have been
      // cleared」, while every March text row is still on screen — that is exactly
      // why the marks are split by type.
      expect(after.combined, isNull);
    });

    test('a type-agnostic delete counts both marks (even if this pass only scooped text)', () {
      final Cutoffs after = advanceCutoffs(Cutoffs.none, <TimelineEntry>[t], ClearKind.both);
      expect(after.text, t.createdAt);
      expect(after.images, t.createdAt);
      expect(after.combined, t.createdAt);
    });

    test('marks only move forward', () {
      const Cutoffs start = Cutoffs(text: null, images: null);
      final Cutoffs a = advanceCutoffs(start, <TimelineEntry>[p], ClearKind.both);
      final Cutoffs b = advanceCutoffs(a, <TimelineEntry>[t], ClearKind.both);
      expect(b.text, p.createdAt); // March is earlier than April; the mark does not retreat
    });

    test('persist round-trip: still answers after a restart (JSON shape)', () {
      final Cutoffs before = advanceCutoffs(Cutoffs.none, <TimelineEntry>[t, p], ClearKind.both);
      final Cutoffs after = Cutoffs.fromJson(before.toJson());
      expect(after.text, before.text);
      expect(after.images, before.images);
      expect(Cutoffs.fromJson(null).isEmpty, isTrue);
    });
  });

  group('TimelineReaper —— deleting a row = deleting every byte of that row (16 册 §6.2-2)', () {
    late InMemoryOutboxBlobStore images;
    late InMemoryUnknownFieldVault vault;
    late InMemoryTimelinePersistence persistence;
    late TimelineReaper reaper;

    setUp(() async {
      images = InMemoryOutboxBlobStore();
      vault = InMemoryUnknownFieldVault();
      persistence = InMemoryTimelinePersistence();
      reaper = TimelineReaper(
        persistence: persistence,
        images: images,
        vault: vault,
        cutoffs: InMemoryCutoffStore(),
      );
    });

    test('🔴 the row is gone ∧ the picture file is gone ∧ the vault entry is gone —— all three must be asserted', () async {
      final TimelineEntry pic = _row(id: 'p1', image: true);
      await persistence.upsert(pic);
      await images.put(
        requestId: 'p1',
        bytes: Uint8List.fromList(List<int>.filled(500, 7)),
        extension: 'png',
      );
      await vault.merge(<String, FprCarriedFields>{
        pic.id: const FprCarriedFields(
          top: <String, Object?>{'future_field': 1},
          ext: <String, Object?>{},
        ),
      });
      // Positive control: all three things are there before we act.
      expect(await persistence.loadAll(), hasLength(1));
      expect(await images.pathFor('p1'), isNotNull);
      expect((await vault.readAll()).containsKey(pic.id), isTrue);

      final ReapResult out = await reaper.reap(<TimelineEntry>[pic]);

      expect(out.rows, 1);
      expect(out.pictures, 1);
      expect(out.bytesFreed, 500); // measured, not pictures × an average (§6.2-5)
      expect(await persistence.loadAll(), isEmpty);
      expect(await images.pathFor('p1'), isNull);
      expect((await vault.readAll()).containsKey(pic.id), isFalse);
    });

    test('an image row with no picture file does not promise to free bytes that do not exist (§9b-6)', () async {
      final TimelineEntry pic = _row(id: 'p2', image: true);
      await persistence.upsert(pic);
      final ReapResult out = await reaper.reap(<TimelineEntry>[pic]);
      expect(out.rows, 1);
      expect(out.pictures, 0);
      expect(out.bytesFreed, 0);
    });

    test('single-row delete does not write a cutoff; only clear does', () async {
      final TimelineEntry e = _row(id: 't1');
      await persistence.upsert(e);
      await reaper.reap(<TimelineEntry>[e]);
      expect(reaper.cutoffs.isEmpty, isTrue);

      final TimelineEntry e2 = _row(id: 't2');
      await persistence.upsert(e2);
      await reaper.reap(<TimelineEntry>[e2], advance: ClearKind.both);
      expect(reaper.cutoffs.combined, e2.createdAt);
    });
  });

  group('TimelineStore —— two triggers, one delete path (16 册 §6.2-1)', () {
    late InMemoryOutboxBlobStore images;
    late InMemoryUnknownFieldVault vault;
    late InMemoryTimelinePersistence persistence;
    late TimelineStore store;

    Future<TimelineStore> seeded(List<TimelineEntry> rows) async {
      images = InMemoryOutboxBlobStore();
      vault = InMemoryUnknownFieldVault();
      persistence = InMemoryTimelinePersistence();
      for (final TimelineEntry e in rows) {
        await persistence.upsert(e);
        if (e.isImage) {
          await images.put(
            requestId: e.clientId,
            bytes: Uint8List.fromList(List<int>.filled(300, 1)),
            extension: 'png',
          );
        }
      }
      final TimelineStore s = TimelineStore(
        persistence: persistence,
        reaper: newTestReaper(
          persistence: persistence,
          images: images,
          vault: vault,
        ),
      );
      await s.load();
      return s;
    }

    test('🔴 G-21 —— user deleting a single row now also deletes the picture file', () async {
      final TimelineEntry pic = _row(id: 'p1', image: true);
      store = await seeded(<TimelineEntry>[pic]);
      addTearDown(store.dispose);
      expect(await images.pathFor('p1'), isNotNull); // positive control

      store.delete(pic.id);
      // delete is fire-and-forget (same posture as this class's other persist);
      // wait for it to be scheduled.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(store.entries, isEmpty);
      expect(await images.pathFor('p1'), isNull);
    });

    test('the two triggers have exactly the same side effects on the same row', () async {
      final TimelineEntry pic = _row(id: 'same', image: true);

      final TimelineStore byDelete = await seeded(<TimelineEntry>[pic]);
      byDelete.delete(pic.id);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final bool fileGoneA = await images.pathFor('same') == null;
      final List<TimelineEntry> leftA = await persistence.loadAll();
      byDelete.dispose();

      final TimelineStore byClear = await seeded(<TimelineEntry>[pic]);
      await byClear.clear(ClearKind.images, ClearWindow.all, now: _now);
      final bool fileGoneB = await images.pathFor('same') == null;
      final List<TimelineEntry> leftB = await persistence.loadAll();
      byClear.dispose();

      expect(fileGoneB, fileGoneA);
      expect(fileGoneA, isTrue);
      expect(leftB.length, leftA.length);
      expect(leftA, isEmpty);
    });

    // D7 (0.3.0) — this test originally asked `store.previewClear(...)`, and that
    // method had **zero production callers** and only looked at rows already
    // paged into memory; it was deleted with D7 (reason written at the original
    // site in `timeline_store.dart`). The **intent** of the assertion did not
    // change; what changed is who is asked: now it asks the estimate chain the
    // clear panel actually uses (`AssetInventory.readAllRows()` →
    // [TimelineStore.readAllRowsForInventory] → [planClear]), i.e. the same
    // whole-store source the reaper now picks rows from. The half that crosses
    // a pagination boundary lives in timeline_clear_boundary_test.dart
    // (>60 rows; the old implementation went red there).
    test('clear deletes exactly the rows the 「estimate chain」 promised (same predicate, two callers)', () async {
      final List<TimelineEntry> rows = <TimelineEntry>[
        _row(id: 'a', at: DateTime.utc(2026, 1, 1)),
        _row(id: 'b', at: DateTime.utc(2026, 8, 1)),
        _row(id: 'c', at: DateTime.utc(2026, 1, 2), image: true),
      ];
      store = await seeded(rows);
      addTearDown(store.dispose);

      final List<TimelineEntry> preview = planClear(
        await store.readAllRowsForInventory(),
        ClearKind.text,
        horizonOf(ClearWindow.month, _now),
      );
      expect(preview.map((TimelineEntry e) => e.clientId), <String>['a']);

      final ReapResult out = await store.clear(ClearKind.text, ClearWindow.month, now: _now);
      expect(out.rows, preview.length);
      expect(
        store.entries.map((TimelineEntry e) => e.clientId).toList()..sort(),
        <String>['b', 'c'],
      );
      // Clearing text did not touch pictures —— the two kinds can run separately.
      expect(await images.pathFor('c'), isNotNull);
    });

    test('when the range holds nothing, no row is deleted and the marks do not move', () async {
      store = await seeded(<TimelineEntry>[_row(id: 'recent', at: DateTime.utc(2026, 8, 2))]);
      addTearDown(store.dispose);
      final ReapResult out = await store.clear(ClearKind.text, ClearWindow.year, now: _now);
      expect(out.rows, 0);
      expect(store.cutoffs.isEmpty, isTrue);
      expect(store.entries, hasLength(1));
    });

    test('🔴 after a clear, the sentence 「what range was cleared」 still holds after the store is reconstructed', () async {
      final InMemoryCutoffStore disk = InMemoryCutoffStore();
      images = InMemoryOutboxBlobStore();
      vault = InMemoryUnknownFieldVault();
      persistence = InMemoryTimelinePersistence();
      final TimelineEntry gone = _row(id: 'gone', at: DateTime.utc(2026, 1, 1));
      final TimelineEntry kept = _row(id: 'kept', at: DateTime.utc(2026, 8, 1));
      await persistence.upsert(gone);
      await persistence.upsert(kept);

      TimelineStore build() => TimelineStore(
        persistence: persistence,
        reaper: newTestReaper(persistence: persistence, images: images, vault: vault, cutoffs: disk),
      );

      final TimelineStore first = build();
      await first.load();
      await first.clear(ClearKind.both, ClearWindow.month, now: _now);
      final DateTime? mark = first.cutoffs.combined;
      expect(mark, gone.createdAt);
      first.dispose();

      // Reopen once (the same 「disk」): that sentence must still be there.
      final TimelineStore reborn = build();
      await reborn.load();
      addTearDown(reborn.dispose);
      expect(reborn.cutoffs.combined, mark);
      expect(reborn.entries, hasLength(1));
    });
  });
}
