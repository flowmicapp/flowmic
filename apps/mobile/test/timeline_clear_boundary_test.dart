// D7 (0.3.0) — batch clear must delete what it claims, ACROSS the pagination
// boundary.
//
// THE DEFECT THIS PINS: the clear sheet's 「将删除 N 条」 counts the WHOLE
// database (AssetInventory → loadAll), but `TimelineStore.clear` used to select
// its doomed set from `_entries` — the in-memory pages, at most `pageSize` (60)
// rows after a fresh `load()`. Every clear over a history longer than one page
// deleted one screenful, ADVANCED THE CUTOFF over the whole promised range, and
// told the user 「早于 X 的记录都已清除」 while the survivors (rows AND their
// image files) stayed on disk. Every prior test seeded ≤4 rows, so the 60-row
// page hid the defect structurally — this file exists to make >pageSize the
// tested case.
//
// REVERSE CONTROL (D7): revert `clear()`'s doomed selection to
// `planClear(_entries, …)` and the first two tests go red on the survivor
// assertions. Executed for real during the card (red output in the report),
// then restored; marker grep REVERSE-CONTROL-D7 = 0 in lib/.

import 'dart:typed_data';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/portable/fpr_mobile.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_purge.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/portable_rows.dart';

final DateTime _now = DateTime.utc(2026, 8, 4, 12);

/// An OLD row — well before every horizon this file uses.
TimelineEntry _oldRow(int i, {bool image = false}) => testRow(
  id: 'loc_d_old$i',
  clientId: 'old$i',
  text: 'old sentence $i',
  entryType: image ? TimelineEntry.kImage : TimelineEntry.kTranscript,
  // One second apart so createdAt is unique and sortable.
  createdAt: DateTime.utc(2026, 1, 1, 8).add(Duration(seconds: i)),
);

/// A NEW row — inside the newest month, never in range.
TimelineEntry _newRow(int i, {bool image = false}) => testRow(
  id: 'loc_d_new$i',
  clientId: 'new$i',
  text: 'new sentence $i',
  entryType: image ? TimelineEntry.kImage : TimelineEntry.kTranscript,
  createdAt: DateTime.utc(2026, 8, 3, 8).add(Duration(seconds: i)),
);

void main() {
  late InMemoryTimelinePersistence persistence;
  late InMemoryOutboxBlobStore images;
  late InMemoryUnknownFieldVault vault;
  late TimelineStore store;

  Future<TimelineStore> seeded(List<TimelineEntry> rows) async {
    persistence = InMemoryTimelinePersistence();
    images = InMemoryOutboxBlobStore();
    vault = InMemoryUnknownFieldVault();
    for (final TimelineEntry e in rows) {
      await persistence.upsert(e);
      if (e.isImage) {
        await images.put(
          requestId: e.clientId,
          bytes: Uint8List.fromList(List<int>.filled(100, 3)),
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

  test('🔴 D7 — >pageSize rows: the clear deletes the WHOLE promised range, '
      'rows and image files, not one page of it', () async {
    // 130 old rows (90 text + 40 images) + 5 new ones. A fresh load() holds
    // only pageSize of them — the exact condition that hid the defect.
    final List<TimelineEntry> old = <TimelineEntry>[
      for (int i = 0; i < 90; i++) _oldRow(i),
      for (int i = 90; i < 130; i++) _oldRow(i, image: true),
    ];
    store = await seeded(<TimelineEntry>[
      ...old,
      _newRow(0),
      _newRow(1),
      _newRow(2),
      _newRow(3, image: true),
      _newRow(4),
    ]);
    addTearDown(store.dispose);

    // Positive control ①: pagination is genuinely in play.
    expect(store.entries.length, TimelineStore.pageSize,
        reason: 'the fixture must be bigger than what the store has loaded');
    // Positive control ②: the promise the sheet makes — the full-table count
    // through the SAME predicate the delete must honour.
    final DateTime? horizon = horizonOf(ClearWindow.month, _now);
    final List<TimelineEntry> promised =
        planClear(await persistence.loadAll(), ClearKind.both, horizon);
    expect(promised.length, 130);
    // Positive control ③: the old images' files exist before the clear.
    expect(await images.pathFor('old90'), isNotNull);
    expect(await images.pathFor('old129'), isNotNull);

    final ReapResult out = await store.clear(
      ClearKind.both,
      ClearWindow.month,
      now: _now,
    );

    // 「已删除 N 条」 must equal 「将删除 N 条」 — the whole point of the card.
    expect(out.rows, promised.length);
    expect(out.pictures, 40);
    expect(out.bytesFreed, 40 * 100, reason: 'measured bytes, all 40 files');

    // No survivors ANYWHERE in storage under the same predicate. This is the
    // assertion the old in-memory selection fails: it left 130 - 60 = 70 rows.
    final List<TimelineEntry> leftover =
        planClear(await persistence.loadAll(), ClearKind.both, horizon);
    expect(leftover, isEmpty,
        reason: 'rows older than the cutoff survived the clear — the delete '
            'did not cover the range the preview promised');
    expect((await persistence.loadAll()).length, 5,
        reason: 'the five new rows are out of range and must all remain');

    // Every old image FILE is gone (G-21: deleting a row deletes its bytes) —
    // including the ones beyond the loaded page.
    for (int i = 90; i < 130; i++) {
      expect(await images.pathFor('old$i'), isNull,
          reason: 'old$i left its picture on disk');
    }
    // …and the new image row keeps its file.
    expect(await images.pathFor('new3'), isNotNull);

    // The cutoff now tells the truth: everything before it IS gone, and it sits
    // at the newest deleted row, not at the newest row of one lucky page.
    expect(out.cutoffs.combined, old.last.createdAt);
  });

  test('D7 — type filter holds at full-table scope: clearing text leaves every '
      'image row and file, beyond the page too', () async {
    store = await seeded(<TimelineEntry>[
      for (int i = 0; i < 70; i++) _oldRow(i),
      for (int i = 70; i < 140; i++) _oldRow(i, image: true),
    ]);
    addTearDown(store.dispose);

    final ReapResult out =
        await store.clear(ClearKind.text, ClearWindow.month, now: _now);

    expect(out.rows, 70, reason: 'all 70 old text rows, not one page');
    expect(out.pictures, 0);
    final List<TimelineEntry> left = await persistence.loadAll();
    expect(left.length, 70);
    expect(left.every((TimelineEntry e) => e.isImage), isTrue);
    for (int i = 70; i < 140; i++) {
      expect(await images.pathFor('old$i'), isNotNull,
          reason: 'a text-only clear must not touch image bytes');
    }
    // Only the text mark moved (16 册 §6.2-3 — do not say more).
    expect(out.cutoffs.text, isNotNull);
    expect(out.cutoffs.images, isNull);
  });

  test('D7 — the vault entries of rows beyond the page are forgotten too', () async {    final List<TimelineEntry> old =
        <TimelineEntry>[for (int i = 0; i < 80; i++) _oldRow(i)];
    store = await seeded(old);
    addTearDown(store.dispose);
    await vault.merge(<String, FprCarriedFields>{
      // One inside the loaded page (newest), one far beyond it (oldest).
      old.last.id: const FprCarriedFields(
        top: <String, Object?>{'future_a': 1},
        ext: <String, Object?>{},
      ),
      old.first.id: const FprCarriedFields(
        top: <String, Object?>{'future_b': 2},
        ext: <String, Object?>{},
      ),
    });

    await store.clear(ClearKind.both, ClearWindow.month, now: _now);

    final Map<String, FprCarriedFields> kept = await vault.readAll();
    expect(kept.containsKey(old.last.id), isFalse);
    expect(kept.containsKey(old.first.id), isFalse,
        reason: 'the vault entry of a row beyond the loaded page stayed');
  });

  test('🔴 D7 — a delete that dies halfway advances NOTHING: no cutoff, no rows '
      'wiped off the screen, and it says so', () async {
    // The partial-failure form of the same lie. The card's rule is 「the cutoff
    // advances only after the delete truly covered the range」; the screen is
    // bound by it too, or 「已删除」 comes back through the UI door.
    final _DeleteDiesPersistence dying = _DeleteDiesPersistence(after: 10);
    for (int i = 0; i < 130; i++) {
      await dying.upsert(_oldRow(i));
    }
    images = InMemoryOutboxBlobStore();
    vault = InMemoryUnknownFieldVault();
    final TimelineStore s = TimelineStore(
      persistence: dying,
      reaper: newTestReaper(persistence: dying, images: images, vault: vault),
    );
    addTearDown(s.dispose);
    await s.load();
    DiagLog.instance.clear();
    expect(s.cutoffs.isEmpty, isTrue); // positive control ①
    final int shownBefore = s.entries.length;
    expect(shownBefore, TimelineStore.pageSize); // positive control ②

    await expectLater(
      s.clear(ClearKind.both, ClearWindow.month, now: _now),
      throwsA(isA<StateError>()),
    );

    // Positive control ③ — the batch really did get partway (otherwise the
    // assertions below would pass on a delete that never started).
    expect(dying.deleted, 10);
    expect((await dying.loadAll()).length, 120);

    // 🔴 The three things that must NOT have moved.
    expect(s.cutoffs.isEmpty, isTrue,
        reason: '「早于 X 的记录都已清除」 after a delete that covered 10 of 130 '
            'rows is the exact claim this card exists to remove');
    expect(s.entries.length, shownBefore,
        reason: 'rows must leave the screen only after the batch is gone — '
            'under-claiming the deletion is the honest direction');
    expect(DiagLog.instance.snapshot().join('\n'),
        contains('timeline.clear_failed'),
        reason: 'an irreversible delete that stopped halfway with no trail is '
            'a silent failure (red line F2)');
  });
}

/// A persistence whose `delete` starts throwing partway through a batch — the
/// disk-error shape a 130-row clear can genuinely hit in the middle.
class _DeleteDiesPersistence extends InMemoryTimelinePersistence {
  _DeleteDiesPersistence({required this.after});

  final int after;
  int deleted = 0;

  @override
  Future<void> delete(String id) async {
    if (deleted >= after) throw StateError('disk delete refused (test)');
    deleted++;
    return super.delete(id);
  }
}
