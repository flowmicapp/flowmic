// REQ-12-09 09-D/09-F — the tick set and the ONE function that composes it.
//
// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     §3 criterion 2 (SUPERSEDED, see below) and criterion 3 (zero decoration)
//   docs/strategy/2026-08-12-req1209-plus-panel-design.md §4-1, §6 tables 1/2/3
//
// 🔴🔴 SUPERSEDED (owner report, 2026-08-27): this file used to pin 「tick
// order, not time order」, because the notes list is newest-first and sorting
// by `createdAt` looked like the panel silently reordering what the user
// assembled. In production it was the opposite problem: ticking top-to-bottom
// on a newest-first list ticks newest-to-oldest, so tick order delivered
// exactly the scrambled message the owner reported ("从上到下…顺序是乱的").
// Owner ruling reversed on the spot: delivery must be CHRONOLOGICAL (oldest
// record first), regardless of tick order or screen order. See
// `plus_panel_selection.dart`'s header for the full account.
//
// 🔴 THE ONE THAT MATTERS is now 「chronological, not tick order」. It is the
// assertion with a REVERSE CONTROL behind it, because the OLD implementation
// (deliver in tick order) is the one a reader who only read the code's
// history would assume is still right. The control below was OBSERVED RED
// (reading `inTickOrder` instead of `inChronologicalOrder` inside `texts`/
// `images`) before this file was left green.

import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/plus_panel_selection.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _note(
  String id, {
  required String text,
  required DateTime at,
  String entryType = TimelineEntry.kTranscript,
}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  createdAt: at,
  updatedAt: at,
  origin: 'cloud',
  entryType: entryType,
);

void main() {
  group('09-D — the tick set', () {
    test('🔴 criterion 2 (owner 2026-08-27 reversal): ticking 3 → 1 → 2 '
        'composes 1 → 2 → 3 — oldest RECORD first, tick order ignored', () {
      // Three notes whose TICK order (3, 1, 2) disagrees with their TIME
      // order (1, 2, 3) — exactly the shape of the owner's report: the notes
      // list renders newest-first, so tapping top-to-bottom ticks
      // newest-to-oldest. Without that disagreement the assertion would pass
      // under either implementation and prove nothing.
      final TimelineEntry one = _note('n1',
          text: '第一句', at: DateTime.utc(2026, 8, 1));
      final TimelineEntry two = _note('n2',
          text: '第二句', at: DateTime.utc(2026, 8, 2));
      final TimelineEntry three = _note('n3',
          text: '第三句', at: DateTime.utc(2026, 8, 3));

      final PlusPanelSelection sel = PlusPanelSelection();
      sel.toggle(PlusPick.note(three));
      sel.toggle(PlusPick.note(one));
      sel.toggle(PlusPick.note(two));

      // Positive control: tick order really is 3 → 1 → 2 (not accidentally
      // already sorted), so the reordering asserted below is demonstrably the
      // panel's doing, not a fixture accident.
      expect(sel.inTickOrder.map((PlusPick p) => p.text),
          <String>['第三句', '第一句', '第二句']);

      expect(sel.texts, <String>['第一句', '第二句', '第三句']);
      expect(sel.composedText, '第一句\n第二句\n第三句');
      sel.dispose();
    });

    test('🔴 fallback, documented not silent: an untimestamped pick (a '
        'favourite has no `entry`, hence no clock) sorts AFTER every '
        'timestamped pick, keeping tick order among the untimestamped ones',
        () {
      final TimelineEntry older = _note('n1',
          text: '旧笔记', at: DateTime.utc(2026, 8, 1));
      final TimelineEntry newer = _note('n2',
          text: '新笔记', at: DateTime.utc(2026, 8, 10));

      final PlusPanelSelection sel = PlusPanelSelection();
      sel.toggle(PlusPick.favorite('常用甲'));
      sel.toggle(PlusPick.note(newer));
      sel.toggle(PlusPick.favorite('常用乙'));
      sel.toggle(PlusPick.note(older));

      expect(sel.inTickOrder.map((PlusPick p) => p.text),
          <String>['常用甲', '新笔记', '常用乙', '旧笔记']);
      // The two timestamped notes sort oldest-first and come FIRST; the two
      // favourites (no createdAt) land after both notes, in THEIR OWN tick
      // order (甲 before 乙) — the only deterministic order they have.
      expect(sel.texts, <String>['旧笔记', '新笔记', '常用甲', '常用乙']);
      sel.dispose();
    });

    test('un-ticking removes it; re-ticking puts it LAST — the latest action '
        'is the latest thing the user chose to say', () {
      final PlusPanelSelection sel = PlusPanelSelection();
      sel.toggle(PlusPick.favorite('A'));
      sel.toggle(PlusPick.favorite('B'));
      sel.toggle(PlusPick.favorite('A')); // untick
      expect(sel.texts, <String>['B']);
      sel.toggle(PlusPick.favorite('A')); // tick again
      expect(sel.texts, <String>['B', 'A']);
      sel.dispose();
    });

    test('🔴 the kind prefix: a favourite whose TEXT equals a row id does not '
        'collide with that row', () {
      // The collision this prevents, spelled out: the phrase the user saved IS
      // its identity, and a light record's identity is its row id. Both are
      // `String`.
      const String clash = 'loc_mobile_i1754000000000-1';
      final TimelineEntry row = _note(clash,
          text: '完全不同的一句话', at: DateTime.utc(2026, 8, 1));

      final PlusPanelSelection sel = PlusPanelSelection();
      sel.toggle(PlusPick.favorite(clash));
      expect(sel.contains(PlusPick.keyForNote(row)), isFalse,
          reason: 'ticking a favourite must not tick the row that shares its text');
      sel.toggle(PlusPick.note(row));
      expect(sel.length, 2);
      // Positive control alongside the negative one: both keys really are in
      // there, so the `isFalse` above is a narrowing and not an empty set.
      expect(sel.contains(PlusPick.keyForFavorite(clash)), isTrue);
      expect(sel.contains(PlusPick.keyForNote(row)), isTrue);
      sel.dispose();
    });

    test('a picture contributes no text and is carried separately, both '
        'chronologically (owner: 「in new line, not merging to text line」)',
        () {
      final TimelineEntry pic1 = _note('img1',
          text: '🖼 PNG · 12 KB',
          at: DateTime.utc(2026, 8, 5),
          entryType: TimelineEntry.kImage);
      final TimelineEntry pic2 = _note('img2',
          text: '🖼 JPEG · 40 KB',
          at: DateTime.utc(2026, 8, 4),
          entryType: TimelineEntry.kImage);
      final TimelineEntry txt = _note('n1',
          text: '带上这句', at: DateTime.utc(2026, 8, 3));

      final PlusPanelSelection sel = PlusPanelSelection();
      sel.toggle(PlusPick.note(pic1)); // ticked first, but the NEWEST record
      sel.toggle(PlusPick.note(txt));
      sel.toggle(PlusPick.note(pic2)); // ticked last, but OLDER than pic1

      // 🔴 The picture LABEL must never end up in the text line: it describes a
      // file, it is not something the user said.
      expect(sel.texts, <String>['带上这句']);
      expect(sel.composedText, '带上这句');
      // Chronological, not tick order: pic2 (08-04) precedes pic1 (08-05)
      // even though pic1 was ticked first.
      expect(
        sel.images.map((TimelineEntry e) => e.id).toList(),
        <String>['img2', 'img1'],
      );
      sel.dispose();
    });

    test('nothing ticked ⇒ composedText is null, not an empty string', () {
      final PlusPanelSelection sel = PlusPanelSelection();
      expect(sel.composedText, isNull);
      // …and a picture-only selection is the same case: there is no text
      // message, rather than an empty one for `deliverText` to refuse.
      sel.toggle(PlusPick.note(_note('img1',
          text: '🖼 PNG · 1 KB',
          at: DateTime.utc(2026, 8, 1),
          entryType: TimelineEntry.kImage)));
      expect(sel.composedText, isNull);
      expect(sel.images, hasLength(1));
      sel.dispose();
    });
  });

  group('09-F — joinSelectedTexts', () {
    test('🔴 criterion 3 (zero decoration): the only character the join adds is ONE newline '
        'per gap — no bullet, no number, no rule, no blank line', () {
      const List<String> parts = <String>['一', '二', '三'];
      final String joined = joinSelectedTexts(parts);

      expect(joined, '一\n二\n三');
      // The ruled property, asserted as a property rather than as a literal:
      // every character in the result either came from an input or is the one
      // separator we are allowed to add.
      final Set<String> fromInputs = parts.expand((String p) => p.split('')).toSet();
      final Set<String> added =
          joined.split('').toSet().difference(fromInputs);
      expect(added, <String>{'\n'},
          reason: 'the join introduced a character the user did not say');
      // And exactly N-1 of them: `\n\n` would be a blank line, which several
      // chat apps read as a send boundary (design §6 table row 1).
      expect('\n'.allMatches(joined).length, parts.length - 1);
    });

    test('one part joins to itself — no trailing separator', () {
      expect(joinSelectedTexts(<String>['只有一句']), '只有一句');
    });

    test('whitespace inside a part is left exactly as stored', () {
      // Re-normalising here would make the delivered text differ from the rows
      // the user ticked, with no screen anywhere showing what actually went.
      expect(joinSelectedTexts(<String>['  前后有空格  ', 'b']),
          '  前后有空格  \nb');
    });
  });
}
