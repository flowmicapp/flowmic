// card FB-7 —— the multi-select state itself (enter / toggle / select-all / exit).
//
// [unit test] Pure state, does not touch the page. The page half is proved
// wired by `selection_wire_test.dart`
// —— this repo stepped on this in 0.2.51: the tracker unit tests were all
// green while the production entry was unwired, and not one of the four tests
// would go red.

import 'package:flowmic/src/ui/selection/entry_selection.dart';
import 'package:flutter_test/flutter_test.dart';

class _Row {
  const _Row(this.id);
  final String id;
}

void main() {
  group('EntrySelection — enter / toggle / select-all / exit', () {
    test('a newly created instance is off, with nothing checked', () {
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      expect(s.active, isFalse);
      expect(s.ids, isEmpty);
    });

    test('enter(seed) opens the mode and seeds the row that triggered it', () {
      // The row the user long-pressed IS that row — if it is not seeded, the
      // mode opens empty and the first thing they have to do is tap the row
      // they were just holding again.
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      int notifies = 0;
      s.addListener(() => notifies++);

      s.enter(seed: 'a');
      expect(s.active, isTrue);
      expect(s.ids, <String>{'a'});
      expect(notifies, 1);
    });

    test('toggle really goes both ways: check, then tap again to uncheck', () {
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'a');
      s.toggle('b');
      expect(s.ids, <String>{'a', 'b'});
      s.toggle('a');
      expect(s.ids, <String>{'b'});
      s.toggle('b');
      expect(s.ids, isEmpty);
      // 🔴 Empty is not the same as exiting the mode — that would turn
      // 「unchecking the last box」 into an exit nobody asked for.
      expect(s.active, isTrue);
    });

    test('selectAll only adds, never subtracts, and a repeat call does not notify', () {
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'a');
      int notifies = 0;
      s.addListener(() => notifies++);

      s.selectAll(<String>['a', 'b', 'c']);
      expect(s.ids, <String>{'a', 'b', 'c'});
      expect(notifies, 1);

      s.selectAll(<String>['a', 'b', 'c']);
      expect(notifies, 1, reason: 'no change means it must not rebuild');
    });

    test('exit closes the mode **and** clears', () {
      // Leaving the previous checks around means the next enter arrives with a
      // selection the user never made, and the toolbar will report its count
      // as if it were entitled to.
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'a');
      s.toggle('b');
      s.exit();
      expect(s.active, isFalse);
      expect(s.ids, isEmpty);

      s.enter(seed: 'c');
      expect(s.ids, <String>{'c'}, reason: 'the second enter has only the newly seeded one');
    });

    test('ids is a read-only view; the outside cannot mutate it', () {
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'a');
      expect(() => s.ids.add('b'), throwsUnsupportedError);
    });
  });

  group('visibleSelected — the count only counts 「what is still in the list」', () {
    test('returns in list order, and is not affected by set order', () {
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'c');
      s.toggle('a');
      final List<_Row> rows = <_Row>[
        const _Row('a'),
        const _Row('b'),
        const _Row('c'),
      ];
      expect(
        visibleSelected<_Row>(rows, s, (_Row r) => r.id)
            .map((_Row r) => r.id)
            .toList(),
        <String>['a', 'c'],
      );
    });

    test('🔴 a row deleted elsewhere stops counting immediately', () {
      // R11: 「已选 2 条」 must not speak for a record that no longer exists.
      // This class deliberately does not reconcile
      // (mutating state inside build is markNeedsBuild during build); the
      // intersection answers on the spot instead.
      final EntrySelection s = EntrySelection();
      addTearDown(s.dispose);
      s.enter(seed: 'a');
      s.toggle('gone');
      expect(s.ids, hasLength(2), reason: 'the set really still holds that ghost id');
      expect(
        visibleSelected<_Row>(<_Row>[const _Row('a')], s, (_Row r) => r.id),
        hasLength(1),
        reason: 'and the on-screen count is only 1 —— that is exactly why this function exists',
      );
    });
  });
}
