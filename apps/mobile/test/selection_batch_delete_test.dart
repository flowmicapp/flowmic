// Card NR-3 —— the batch delete's **mechanism** accept: does a multi-select
// delete really go through `TimelineReaper`, the phone's one deleter?
//
// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 8
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §3
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-21
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.2-1/-2
//
// ── 🔴 WHY THE ASSERTION IS ABOUT PICTURE FILES AND NOT ABOUT ROWS ──────────
// 「the rows are gone」 is true of BOTH implementations — the correct one and
// the wrong one. A batch delete written as a loop over `_persistence.delete`
// removes every row from the table and every row from the screen, and a test
// that only counts rows is green for it. What separates the two is what the
// row OWNED: its picture file on disk and its unknown-field entry in the side
// table. That is precisely the defect G-21 recorded — 「when a user deleted a
// picture record on the phone, the picture file stayed on disk forever, while
// the ENTIRE reason owner asked for this feature was to save space」 — and it
// is the only thing worth asserting here.
//
// ── 🔴 REVERSE CONTROL (measured, red, restored, green) ─────────────────────
// Change: in `timeline_store_batch_delete.dart`'s `_deleteMany`, replace
//     out = await store._reaper.reap(rows);
// with a bypass that deletes rows only, i.e. the plausible wrong version:
//     for (final TimelineEntry r in rows) { await store._persistence.delete(r.id); }
//     out = ReapResult(rows: rows.length, pictures: 0, bytesFreed: 0,
//                      cutoffs: store._reaper.cutoffs);
// **Measured: 7 passed, 4 FAILED**, verbatim:
//   ① it goes through the ONE deleter / the picture FILE goes with the row
//       Expected: null
//         Actual: 'mem://img-a.png'
//   ① it goes through the ONE deleter / the row's unknown fields are forgotten
//       Expected: false
//         Actual: <true>
//   ① it goes through the ONE deleter / the result is measured, not the tick count
//       Expected: <1>
//         Actual: <0>
//   ② it takes ROWS, not ids / a selected row the store never loaded is still deleted
//       Expected: <1>
//         Actual: <0>
// 🔴 What stayed GREEN under the bypass, and this is the point: every
// row-counting assertion (`out.rows` was still 2, storage still lost the rows,
// the list still shrank), the whole cutoff case, and every sentence case. A
// user would have seen a completely normal delete — and kept every deleted
// photo on their phone, forever.
// Restored; `REVERSE-CONTROL-NR3` grep = 0; re-greened at 11.

import 'dart:typed_data' show Uint8List;

import 'package:flowmic/src/portable/fpr_mobile.dart' show FprCarriedFields;
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_purge.dart' show Cutoffs;
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/selection/batch_actions.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/portable_rows.dart';

class _Fixture {
  _Fixture(this.persistence, this.images, this.vault, this.store);
  final InMemoryTimelinePersistence persistence;
  final InMemoryOutboxBlobStore images;
  final InMemoryUnknownFieldVault vault;
  final TimelineStore store;
}

TimelineEntry _row(String id, {bool image = false, int minute = 0}) => testRow(
  id: id,
  clientId: id,
  text: 'sentence $id',
  entryType: image ? TimelineEntry.kImage : TimelineEntry.kTranscript,
  createdAt: DateTime.utc(2026, 8, 27, 9).add(Duration(minutes: minute)),
);

Future<_Fixture> _seed(List<TimelineEntry> rows) async {
  final InMemoryTimelinePersistence persistence = InMemoryTimelinePersistence();
  final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
  final InMemoryUnknownFieldVault vault = InMemoryUnknownFieldVault();
  for (final TimelineEntry e in rows) {
    await persistence.upsert(e);
    // The side table the reaper's ③ clears. Seeded for every row so 「forgotten」
    // is a state change rather than a value that was already absent.
    await vault.merge(<String, FprCarriedFields>{
      e.id: FprCarriedFields(top: const <String, Object?>{}, ext: <String, Object?>{'x_note': e.id}),
    });
    if (e.isImage) {
      await images.put(
        requestId: e.clientId,
        bytes: Uint8List.fromList(List<int>.filled(64, 7)),
        extension: 'png',
      );
    }
  }
  final TimelineStore store = TimelineStore(
    persistence: persistence,
    reaper: newTestReaper(
      persistence: persistence,
      images: images,
      vault: vault,
    ),
  );
  await store.load();
  return _Fixture(persistence, images, vault, store);
}

void main() {
  group('① it goes through the ONE deleter', () {
    late _Fixture f;

    setUp(() async {
      f = await _seed(<TimelineEntry>[
        _row('txt-a', minute: 1),
        _row('img-a', image: true, minute: 2),
        _row('txt-b', minute: 3),
        _row('keep', minute: 4),
      ]);
      addTearDown(f.store.dispose);
    });

    test('the picture FILE goes with the row', () async {
      // Positive control: without this the assertion below could pass because
      // the file was never there.
      expect(
        await f.images.pathFor('img-a'),
        isNotNull,
        reason: 'positive control: the fixture has a picture file to lose',
      );

      await f.store.deleteMany(<TimelineEntry>[
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'txt-a'),
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'img-a'),
      ]);

      expect(
        await f.images.pathFor('img-a'),
        isNull,
        reason: 'the row is gone from the table and its picture is still on '
            'disk ⇒ this batch did not go through TimelineReaper (G-21)',
      );
      // Negative control on the other side: an untouched picture must survive.
      expect(f.images.blobs, isEmpty);
    });

    test("the row's unknown fields are forgotten", () async {
      expect(
        f.vault.entries.containsKey('txt-a'),
        isTrue,
        reason: 'positive control: there is a side-table entry to forget',
      );

      await f.store.deleteMany(<TimelineEntry>[
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'txt-a'),
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'img-a'),
      ]);

      expect(f.vault.entries.containsKey('txt-a'), isFalse);
      expect(f.vault.entries.containsKey('img-a'), isFalse);
      expect(
        f.vault.entries.containsKey('keep'),
        isTrue,
        reason: 'a row that was not selected must keep its carried fields',
      );
    });

    test('the result is measured, not the tick count', () async {
      final ReapResult out = await f.store.deleteMany(<TimelineEntry>[
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'txt-a'),
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'img-a'),
      ]);
      expect(out.rows, 2);
      expect(out.pictures, 1);
      expect(out.bytesFreed, 64, reason: 'measured before the file was deleted');
      // The rows really left both the loaded view and storage.
      expect(
        f.store.entries.map((TimelineEntry e) => e.id),
        <String>['keep', 'txt-b'],
      );
      expect(
        (await f.persistence.loadAll()).map((TimelineEntry e) => e.id).toSet(),
        <String>{'txt-b', 'keep'},
      );
    });

    test('the cutoff marker does NOT move — 「I deleted these」 says nothing '
        'about everything older', () async {
      final Cutoffs before = f.store.cutoffs;
      await f.store.deleteMany(<TimelineEntry>[
        f.store.entries.firstWhere((TimelineEntry e) => e.id == 'txt-a'),
      ]);
      expect(f.store.cutoffs.toJson(), before.toJson());
    });
  });

  group('② it takes ROWS, not ids — the reason that is not a style choice', () {
    test('a selected row the store never loaded is still deleted', () async {
      // The shape: the all-history page's SEARCH results come straight from
      // storage, and the chat page's list unions in `OwnerTimelinePager.rows`.
      // Either way a ticked row can be absent from the store's loaded pages.
      // Reproduced here by writing a row to storage WITHOUT loading it.
      final _Fixture f = await _seed(<TimelineEntry>[_row('loaded', minute: 1)]);
      addTearDown(f.store.dispose);
      final TimelineEntry unloaded = _row('unloaded-img', image: true, minute: 9);
      await f.persistence.upsert(unloaded);
      await f.images.put(
        requestId: unloaded.clientId,
        bytes: Uint8List.fromList(List<int>.filled(32, 1)),
        extension: 'png',
      );

      expect(
        f.store.entries.any((TimelineEntry e) => e.id == unloaded.id),
        isFalse,
        reason: 'positive control: this row is genuinely not in the loaded view',
      );

      final ReapResult out = await f.store.deleteMany(<TimelineEntry>[unloaded]);

      // An id-resolving implementation returns here having done NOTHING, and
      // says so with a 0 nobody reads.
      expect(out.rows, 1);
      expect(out.pictures, 1);
      expect(await f.images.pathFor(unloaded.clientId), isNull);
      expect(
        (await f.persistence.loadAll()).map((TimelineEntry e) => e.id),
        isNot(contains(unloaded.id)),
      );
    });

    test('duplicates are counted once, so the sentence cannot over-claim',
        () async {
      final _Fixture f = await _seed(<TimelineEntry>[_row('dup', minute: 1)]);
      addTearDown(f.store.dispose);
      final TimelineEntry row = f.store.entries.single;
      final ReapResult out = await f.store.deleteMany(<TimelineEntry>[row, row]);
      expect(out.rows, 1, reason: '「2 deleted」 for one row is an over-claim');
    });

    test('an empty batch is a no-op that reports zero, not a crash', () async {
      final _Fixture f = await _seed(<TimelineEntry>[_row('a', minute: 1)]);
      addTearDown(f.store.dispose);
      final ReapResult out = await f.store.deleteMany(const <TimelineEntry>[]);
      expect(out.rows, 0);
      expect(f.store.entries, hasLength(1));
    });
  });

  group('③ the sentences the user is shown', () {
    const AppStrings s = AppStringsZh();

    test('the confirm body names the picture count only when there are '
        'pictures', () {
      final List<TimelineEntry> mixed = <TimelineEntry>[
        _row('t1'),
        _row('i1', image: true),
        _row('i2', image: true),
      ];
      expect(imageRowsIn(mixed), 2);
      expect(
        batchDeleteConfirmBody(mixed.length, imageRowsIn(mixed), s),
        s.selectionDeleteConfirmBodyWithImages(3, 2),
      );
      final List<TimelineEntry> textOnly = <TimelineEntry>[_row('t1'), _row('t2')];
      expect(imageRowsIn(textOnly), 0);
      expect(
        batchDeleteConfirmBody(textOnly.length, 0, s),
        s.selectionDeleteConfirmBody(2),
      );
    });

    test('🔴 the count in the confirm body is the ROW count, never the text '
        'count', () {
      // The trap: `selectedRecords` (copy/organize's derivation) drops picture
      // rows, so its `textRows` for this batch is 1. Announcing 「1 record will
      // be deleted」 before deleting three is the worst direction to be wrong
      // in for an irreversible action.
      final List<TimelineEntry> mixed = <TimelineEntry>[
        _row('t1'),
        _row('i1', image: true),
        _row('i2', image: true),
      ];
      expect(selectedRecords(mixed).textRows, 1, reason: 'positive control');
      expect(
        batchDeleteConfirmBody(mixed.length, imageRowsIn(mixed), s),
        contains('3'),
      );
    });

    test('the result sentence reports the reap, not the selection', () {
      const ReapResult withFiles = ReapResult(
        rows: 5,
        pictures: 2,
        bytesFreed: 900,
        cutoffs: Cutoffs.none,
      );
      expect(
        batchDeleteResultText(withFiles, s),
        s.selectionDeletedWithImages(5, 2),
      );
      // 🔴 pictures == 0 with image ROWS in the batch is a real state: a row
      // delivered before RV-93 has no file left. The sentence must not promise
      // files were freed when none were.
      const ReapResult noFiles = ReapResult(
        rows: 5,
        pictures: 0,
        bytesFreed: 0,
        cutoffs: Cutoffs.none,
      );
      expect(batchDeleteResultText(noFiles, s), s.selectionDeleted(5));
    });

    test('🔴 positive control: the new sentences are nine real translations, '
        'not one string copied nine times', () {
      // Without this, a catalogue that answered English for every locale would
      // leave every other assertion in this file green.
      final List<String Function(AppStrings)> picks = <String Function(AppStrings)>[
        (AppStrings x) => x.selectionDeleteSub,
        (AppStrings x) => x.selectionDeleteNoSelection,
        (AppStrings x) => x.selectionDeleteFailed,
        (AppStrings x) => x.selectionDeleteConfirmTitle(3),
        (AppStrings x) => x.selectionDeleteConfirmBody(3),
        (AppStrings x) => x.selectionDeleteConfirmBodyWithImages(3, 1),
        (AppStrings x) => x.selectionDeleted(3),
        (AppStrings x) => x.selectionDeletedWithImages(3, 1),
      ];
      for (final String Function(AppStrings) pick in picks) {
        final Set<String> seen = <String>{
          for (final AppLocale loc in AppLocale.values)
            pick(AppStrings.of(loc)),
        };
        expect(seen, hasLength(AppLocale.values.length));
        for (final String v in seen) {
          expect(v.trim(), isNotEmpty);
        }
      }
    });
  });
}
