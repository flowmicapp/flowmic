// REQ-12-09 09-D/09-F — what the "+" panel has ticked, in the order it was
// ticked, and the ONE function that turns that into a message.
//
// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     §1 (rulings 3 and 4), §2-1 (text composes into one message; each picture
//     is its own delivery), §3 criteria 1/2/3
//   docs/strategy/2026-08-12-req1209-plus-panel-design.md §4-1 (read-only
//     projection + kind prefix + the selection set is never persisted), §6 tables 1/2/3
//
// ── 🔴 THREE RULED PROPERTIES LIVE HERE, AND NOWHERE ELSE ────────────────────
//
//   1. ORDER IS TICK ORDER, NOT TIME ORDER (owner ruling 4). [inTickOrder] is a
//      `List` appended to on tick and removed from on untick — there is no sort
//      anywhere in this file, and that absence is the feature. Ticking 3→1→2
//      sends 3→1→2, because a panel that reorders what the user assembled is a
//      panel that does not listen. Pinned by
//      `plus_panel_selection_test.dart`'s "tick order survives", whose reverse
//      control is a `createdAt` sort.
//   2. ONE '\n', AND NOTHING ELSE (owner ruling 3). See [joinSelectedTexts].
//   3. NOTHING HERE PERSISTS. This object is created by `_PlusPanelState` and
//      dies with the sheet — the same reason `_ImageTile._original` is local
//      State (design §4-1 rule 3): a tick that outlives the panel is a tick
//      somebody will eventually forget to clear, and it would send words the
//      user picked in a previous session.
//
// ── WHY THE KEY CARRIES A KIND PREFIX ────────────────────────────────────────
// A favourite's identity IS its string; a light record's identity is a row id
// (design §4 identity row). Both are `String`, so a single un-prefixed
// `Set<String>` would collide on the day a user saves a favourite whose text
// happens to equal some row's id. That is unlikely and it is also free to
// prevent, which is the whole argument. Pinned by the "fav: and note: do not
// collide" test.
//
// ⚠️ ONE PREFIX FOR BOTH NOTE KINDS, ON PURPOSE. A picture note and a text note
// are the SAME row family with the same id space (`note:<entry id>`), so a
// second prefix would be a second answer to "what is this row called". What
// differs is [PlusPickKind], which is derived from the row, not from the key.

import 'package:flutter/foundation.dart';

import '../timeline/timeline_entry.dart';

/// What the panel hands over when the user presses send.
///
/// 🔴 TWO ARGUMENTS, NOT ONE LIST, because they travel differently and the
/// difference is the ruling: [text] is at most ONE composed message (owner
/// ruling 3+4) and [images] is N deliveries of one picture each (owner: "in new
/// line, not merging to text line"). A single "here is what was picked" list
/// would leave the split to be re-derived by whoever implements the sender, and
/// that is where "compose into one" quietly becomes "compose into N".
///
/// [text] is null when nothing textual was ticked — NOT an empty string, which
/// would make the sender ask "should an empty message be sent" at a layer that
/// should not have to.
typedef PlusSelectionSender =
    Future<void> Function({
      required String? text,
      required List<TimelineEntry> images,
    });

/// What a ticked thing is. The panel needs the distinction because the two
/// halves travel differently: text composes into ONE message, each picture is
/// its own delivery (owner 2026-08-12).
enum PlusPickKind {
  /// A favorite (常用) phrase. Its identity is the string itself.
  favorite,

  /// A text light record.
  note,

  /// A picture light record. Never joined into the text line.
  image,
}

/// One ticked thing — a read-only projection over whichever store it came from
/// (design §4-1 rule 1: the panel never writes through this type).
@immutable
class PlusPick {
  const PlusPick._({
    required this.key,
    required this.kind,
    this.text,
    this.entry,
  });

  /// A favorite (常用) phrase.
  factory PlusPick.favorite(String text) =>
      PlusPick._(key: 'fav:$text', kind: PlusPickKind.favorite, text: text);

  /// A light record. Whether it is [PlusPickKind.note] or [PlusPickKind.image]
  /// is read off the ROW, never passed in — one answer to "is this row a
  /// picture", and
  /// it is `TimelineEntry.isImage`, the same one every other surface uses.
  factory PlusPick.note(TimelineEntry entry) => PlusPick._(
    key: keyForNote(entry),
    kind: entry.isImage ? PlusPickKind.image : PlusPickKind.note,
    // 🔴 `displayText`, i.e. exactly the words on screen in the row the user
    // ticked. Not `sourceText`: on a translated/organized row those differ, and
    // sending the one the user did NOT look at is the quiet kind of wrong.
    // Null for a picture — a picture has no text to compose, only a label, and
    // the label is a description of the file, not something anyone asked to say.
    text: entry.isImage ? null : entry.displayText,
    entry: entry,
  );

  /// The key for a light-record row, without building a pick. Used by the list
  /// widgets to ask "is this row ticked" while rebuilding.
  static String keyForNote(TimelineEntry entry) => 'note:${entry.id}';

  /// The key for a favorite (常用) phrase, without building a pick.
  static String keyForFavorite(String text) => 'fav:$text';

  final String key;
  final PlusPickKind kind;

  /// The words this pick contributes to the composed message, or null when it
  /// contributes none (a picture).
  final String? text;

  /// The row behind a light record; null for a favourite (there is no row —
  /// a favourite lives in `shared_preferences`).
  final TimelineEntry? entry;
}

/// The "+" panel's tick set for one opening of the sheet.
///
/// A [ChangeNotifier] rather than `setState` in one widget because the ticks
/// are made in TWO places (the favorites (常用) list and the light-record
/// (轻记录) tab, which is its own
/// widget) and read in a third (the send bar). One object, three readers —
/// rather than three copies of "what was selected", which is how they drift.
class PlusPanelSelection extends ChangeNotifier {
  final List<PlusPick> _ticks = <PlusPick>[];

  /// Everything ticked, oldest tick first. 🔴 See property 1 in the header: no
  /// sort, ever.
  List<PlusPick> get inTickOrder => List<PlusPick>.unmodifiable(_ticks);

  int get length => _ticks.length;
  bool get isEmpty => _ticks.isEmpty;
  bool get isNotEmpty => _ticks.isNotEmpty;

  bool contains(String key) => _ticks.any((PlusPick p) => p.key == key);

  /// Tick or untick. Re-ticking something already ticked REMOVES it (that is
  /// what a check box does); re-ticking it again puts it at the END, because
  /// the user's latest action is the latest thing they chose to say.
  void toggle(PlusPick pick) {
    final int at = _ticks.indexWhere((PlusPick p) => p.key == pick.key);
    if (at >= 0) {
      _ticks.removeAt(at);
    } else {
      _ticks.add(pick);
    }
    notifyListeners();
  }

  void clear() {
    if (_ticks.isEmpty) return;
    _ticks.clear();
    notifyListeners();
  }

  /// The ticked TEXT, in tick order. Pictures are absent by construction —
  /// [PlusPick.text] is null for them.
  ///
  /// 🔴 Reads [inTickOrder], not `_ticks`. Both halves of what gets sent must
  /// come through the SAME ordering, or "in tick order" would be two answers
  /// that only happen to agree — and the reverse control that proves the
  /// ordering is real would only bite one of them.
  List<String> get texts => <String>[
    for (final PlusPick p in inTickOrder)
      if (p.text != null) p.text!,
  ];

  /// The ticked PICTURES, in tick order. Each of these becomes its own
  /// delivery and its own timeline row (owner 2026-08-12: "in new line, not
  /// merging to text line").
  List<TimelineEntry> get images => <TimelineEntry>[
    for (final PlusPick p in inTickOrder)
      if (p.kind == PlusPickKind.image) p.entry!,
  ];

  /// The one message the ticked text becomes, or null when no text is ticked.
  String? get composedText {
    final List<String> parts = texts;
    if (parts.isEmpty) return null;
    return joinSelectedTexts(parts);
  }
}

/// 🔴 owner 2026-08-12 ruling 3: "a single newline, no numbering, no
/// separator lines, no decoration" (「单个换行，不加任何标号/分隔线/装饰」).
///
/// The body is `parts.join('\n')` and it must stay that. Every decoration that
/// looks helpful here — a bullet, a number, a 「---」, a blank line between
/// entries — is a character the user did not say being typed into their
/// document by us. The reason a bare `join` deserves a named function at all is
/// so that the rule has ONE greppable home and one test, instead of living
/// inline at a call site where the next person adds 「just a separator」.
///
/// ⚠️ Nothing is trimmed here either. A favourite is stored as the user saved
/// it and a note is stored as it was spoken; re-normalising whitespace at
/// compose time would make the delivered text differ from the rows the user
/// ticked, and there would be no screen anywhere showing what actually went.
String joinSelectedTexts(List<String> parts) => parts.join('\n');
