// REQ-12-09 09-D/09-F/09-G — the 「+」 panel's tick boxes, what they compose, and
// the picture rows that can never be ticked.
//
// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     §2-2 (legacy light-record picture rows can never be sent), §3 criteria 1/2/3/4
//   docs/strategy/2026-08-12-req1209-plus-panel-design.md §4-1, §6-4, §7-3
//
// 🔴 WHAT THIS FILE PROVES AND WHAT IT DOES NOT. It proves the PANEL hands over
// one composed string plus N picture rows, in tick order, and that a picture
// with no bytes has no tick box and a readable reason instead. It proves nothing
// about delivery — 「exactly one `deliverText`, exactly M image sends, 1+M rows」
// is asserted end to end against a real ChatController in
// `plus_selection_delivery_test.dart`. Two files, two halves; neither fakes the
// other's half.
//
// ⚠️ THE STORE IS [InMemoryTimelinePersistence] for the reason
// plus_panel_notes_tab_test.dart's header measured: `testWidgets` runs inside a
// FakeAsync zone and sqflite_common_ffi's futures never complete there.
//
// ⚠️ 0.2.53's rule is obeyed for the 09-G sentence: "can the user actually
// read this sentence" is asserted on the RENDERED result (`didExceedMaxLines`
// at 360 dp, in all four languages), never on `Text.data`. A suite that
// asserts `Text.data` was green for 1259 tests while the screen showed three
// letters.

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flowmic/src/ui/plus_panel_notes_tab.dart';
import 'package:flowmic/src/ui/plus_panel_selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();

TimelineEntry _entry(
  String id, {
  required String text,
  required DateTime at,
  String origin = 'cloud',
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
  origin: origin,
  entryType: entryType,
);

/// Everything one send handed over. A list of these IS the assertion "how many
/// times the panel was invoked" — a single nullable field could not tell
/// "one call carrying two things" apart from "two calls each carrying one",
/// which is precisely the ruling.
class _Handover {
  _Handover(this.text, this.images);
  final String? text;
  final List<TimelineEntry> images;
}

class _Rig {
  _Rig({
    required this.persistence,
    this.favorites = const <String>[],
    this.noPcTarget = false,
    this.wired = true,
    this.bytesFor = const <String>{},
  });

  final TimelinePersistence persistence;
  final List<String> favorites;
  final bool noPcTarget;

  /// False ⇒ the panel is built with NO sender, i.e. the shape a build without
  /// this feature has. Anti-façade: no surface without a way to fill it.
  final bool wired;

  /// Row ids whose original bytes are still on this phone (09-G).
  final Set<String> bytesFor;

  /// ⚠️ NO `strings` KNOB. The four-language measurement below mounts
  /// [PlusPanelNotesTab] directly instead of driving this rig, for the reason
  /// stated there — so a locale parameter here would be a seam with no caller,
  /// which is a small façade of exactly the kind this panel's own header warns
  /// about.
  static const AppStrings strings = _zh;

  final List<_Handover> sends = <_Handover>[];
  int probes = 0;

  Widget build() {
    final FavoritesStore store = FavoritesStore(prefs: InMemoryLocalPrefs());
    for (final String f in favorites) {
      store.add(f);
    }
    return MaterialApp(
      home: Scaffold(
        body: PlusPanel(
          favorites: store,
          strings: strings,
          buffer: '',
          noPcTarget: noPcTarget,
          onSend: (_) {},
          onFeedback: (_) {},
          lightRecords: LightRecordQuery(persistence: persistence),
          isSignedIn: () => true,
          onSendSelection: wired
              ? ({
                  required String? text,
                  required List<TimelineEntry> images,
                }) async => sends.add(_Handover(text, images))
              : null,
          imageSendable: wired
              ? (TimelineEntry e) async {
                  probes++;
                  return bytesFor.contains(e.id);
                }
              : null,
        ),
      ),
    );
  }
}

/// Switch to light records and let the disk read AND the byte probe land.
Future<void> _openNotes(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey<String>('plus.tab.notes')));
  await tester.pump(); // tab mounts, starts its read
  await tester.pump(); // read resolves
  await tester.pump(); // the 09-G probes resolve
}

void main() {
  testWidgets('anti-façade: no sender wired ⇒ NO tick box anywhere, on either tab',
      (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.upsert(_entry('cloud-1', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));
    final _Rig rig = _Rig(persistence: p, favorites: <String>['常用一'], wired: false);

    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('plus.fav.tick.常用一')), findsNothing);

    await _openNotes(tester);
    expect(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-1')), findsNothing);
    expect(find.byKey(const ValueKey<String>('plus.selection.bar')), findsNothing);
  });

  testWidgets('🔴 09-D: no PC to send to ⇒ no tick boxes either — a control '
      'that could only fail is worse than none (R8)',
      (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.upsert(_entry('cloud-1', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 1)));
    final _Rig rig =
        _Rig(persistence: p, favorites: <String>['常用一'], noPcTarget: true);

    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    // Positive control: the reason is already on screen where the user is
    // looking, so this is "explained clearly and no control is offered" rather
    // than "nothing at all".
    expect(find.text(_zh.favoritesNoPcTarget), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('plus.fav.tick.常用一')), findsNothing);

    await _openNotes(tester);
    expect(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-1')), findsNothing);
  });

  testWidgets('🔴 09-F: ticks across BOTH tabs compose ONE string in tick '
      'order, handed over in ONE call', (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.upsert(_entry('cloud-a', text: '周三还书', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-b', text: '牛奶和鸡蛋', at: DateTime.utc(2026, 8, 2)));
    final _Rig rig = _Rig(persistence: p, favorites: <String>['收到，我稍后回复你']);

    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();

    // Tick the FAVOURITE first, then the OLDER note, then the NEWER one — an
    // order no sort would reproduce (the list is newest-first).
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.tick.收到，我稍后回复你')));
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('plus.selection.bar')), findsOneWidget);
    expect(find.text(_zh.selectionCount(1)), findsOneWidget);

    await _openNotes(tester);
    await tester.tap(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-a')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-b')));
    await tester.pump();

    // 🔴 The count spans both tabs — a favourite ticked before the tab switch
    // is still ticked.
    expect(find.text(_zh.selectionCount(3)), findsOneWidget);
    // No pictures ⇒ the "pictures are sent separately" line must NOT be on screen (it would
    // be a statement about something that is not happening).
    expect(
      find.byKey(const ValueKey<String>('plus.selection.imagesNote')),
      findsNothing,
    );

    await tester.tap(find.byKey(const ValueKey<String>('plus.selection.send')));
    await tester.pumpAndSettle();

    expect(rig.sends, hasLength(1), reason: 'ONE handover, not one per item');
    expect(rig.sends.single.text, '收到，我稍后回复你\n周三还书\n牛奶和鸡蛋');
    expect(rig.sends.single.images, isEmpty);
  });

  testWidgets('09-D: the tick set dies with the sheet — reopening starts empty',
      (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    final _Rig rig = _Rig(persistence: p, favorites: <String>['常用一']);

    // Two independent openings of the panel, which is what production does:
    // `showPlusPanel` constructs a fresh PlusPanel every time.
    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.tick.常用一')));
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('plus.selection.bar')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    // A tick that outlives the panel is a tick somebody eventually forgets to
    // clear — and it would send words picked in a previous session.
    expect(find.byKey(const ValueKey<String>('plus.selection.bar')), findsNothing);
  });

  testWidgets('🔴 09-G/09-J: a picture WITH bytes is tickable and travels as a '
      'picture, never inside the text line', (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.upsert(_entry('cloud-txt', text: '带上这句', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-img',
        text: '🖼 PNG · 214 KB',
        at: DateTime.utc(2026, 8, 2),
        entryType: TimelineEntry.kImage));
    final _Rig rig = _Rig(persistence: p, bytesFor: <String>{'cloud-img'});

    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    await _openNotes(tester);

    await tester.tap(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-img')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('plus.notes.tick.cloud-txt')));
    await tester.pump();
    // The consequence the user cannot guess: this will be TWO messages.
    expect(
      find.byKey(const ValueKey<String>('plus.selection.imagesNote')),
      findsOneWidget,
    );
    expect(find.text(_zh.plusSelectionImagesSeparate), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('plus.selection.send')));
    await tester.pumpAndSettle();

    expect(rig.sends, hasLength(1));
    // 🔴 The picture's LABEL is not in the text line. Sending 「🖼 PNG · 214 KB」
    // as words would make the PC type a file description into the document.
    expect(rig.sends.single.text, '带上这句');
    expect(rig.sends.single.images.map((TimelineEntry e) => e.id).toList(),
        <String>['cloud-img']);
  });

  testWidgets('🔴 09-G criterion 4: a picture with NO bytes has no tick box, and the '
      'reason stands where the box would have been',
      (WidgetTester tester) async {
    final TimelinePersistence p = InMemoryTimelinePersistence();
    await p.upsert(_entry('legacy-img',
        text: '🖼 JPEG · 88 KB',
        at: DateTime.utc(2026, 8, 2),
        entryType: TimelineEntry.kImage));
    await p.upsert(_entry('fresh-img',
        text: '🖼 PNG · 12 KB',
        at: DateTime.utc(2026, 8, 3),
        entryType: TimelineEntry.kImage));
    // Positive control alongside the negative one: one picture CAN be sent, so
    // "no tick box" below is a narrowing rather than "this feature was never wired".
    final _Rig rig = _Rig(persistence: p, bytesFor: <String>{'fresh-img'});

    await tester.pumpWidget(rig.build());
    await tester.pumpAndSettle();
    await _openNotes(tester);

    expect(find.byKey(const ValueKey<String>('plus.notes.tick.fresh-img')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('plus.notes.tick.legacy-img')),
        findsNothing,
        reason: 'those bytes were never written — a tick could only fail');
    // The row is still LISTED. Hiding it would be the other direction of the
    // same red line (15 册 F2): it really is on this phone.
    expect(find.byKey(const ValueKey<String>('plus.notes.row.legacy-img')),
        findsOneWidget);
    expect(find.text('🖼 JPEG · 88 KB'), findsOneWidget);
    // …and the reason is on screen without a tap.
    expect(
      find.byKey(const ValueKey<String>('plus.notes.noOriginal.legacy-img')),
      findsOneWidget,
    );
    // Negative control for the sentence: the row that CAN be sent must not
    // carry it, or the sentence would be decoration rather than a reason.
    expect(
      find.byKey(const ValueKey<String>('plus.notes.noOriginal.fresh-img')),
      findsNothing,
    );
  });

  testWidgets('🔴 09-G criterion 4: the reason is READABLE at 360 dp in all four '
      'languages — asserted on the rendered box, never on Text.data',
      (WidgetTester tester) async {
    // 0.2.53: `flutter_test` uses the Ahem placeholder font, where every glyph
    // is a full em square — so this measurement is CONSERVATIVE (not clipped
    // here ⇒ not clipped on a real font). The converse does NOT hold and this
    // test may not be read as "it fits exactly on a real device".
    //
    // ⚠️ THE TAB IS MOUNTED DIRECTLY, AT THE WIDTH IT REALLY GETS INSIDE THE
    // PANEL (360 dp − the panel's 16+16 padding = 328), AND THAT IS NOT A
    // CONVENIENCE. Driving the whole `PlusPanel` at 360 dp throws a layout
    // error before this tab is even reachable: the Favorites header
    // (`plus_panel.dart` `_header`) overflows by 15 px under ja/ko, where
    // 「よく使うフレーズ」 + 「n / 50」 + 「現在のテキストを保存」 measure 347 against
    // 328. 🔴 THAT IS A REAL, PRE-EXISTING DEFECT — it belongs to F-5/09-B, not
    // to this card, and it is recorded here rather than swallowed because this
    // measurement is the first thing in the suite that ever put this panel on a
    // 360 dp screen. Nothing here fixes it, and nothing here hides it.
    tester.view.physicalSize = const Size(360 * 3, 890 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final TimelinePersistence p = InMemoryTimelinePersistence();
      await p.upsert(_entry('legacy-img',
          text: '🖼 JPEG · 88 KB',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage));

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 328,
                child: PlusPanelNotesTab(
                  strings: s,
                  query: LightRecordQuery(persistence: p),
                  isSignedIn: () => true,
                  selection: PlusPanelSelection(),
                  imageSendable: (TimelineEntry _) async => false,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final Finder note = find.byKey(
        const ValueKey<String>('plus.notes.noOriginal.legacy-img'),
      );
      expect(note, findsOneWidget, reason: '$locale: this line must be able to say why');
      final RenderParagraph para = tester.renderObject<RenderParagraph>(note);
      expect(para.didExceedMaxLines, isFalse,
          reason: '$locale: this sentence was clipped by layout — the user reads an ellipsis');
      expect(tester.getSize(note).height, greaterThan(0), reason: '$locale');

      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  test('🔴 09-G criterion 4: the reason is four-language, states a FACT, and never '
      'suggests retrying or waiting', () {
    // Those bytes were never written (RV-93). They are not late, they are not
    // in flight, and no amount of trying again produces them — so a word that
    // implies otherwise would be a promise nothing can keep, which is the same
    // red line 「待投递」 was once banned under.
    const List<String> banned = <String>[
      // zh — imperatives / "it will get better"
      '请', '重试', '再试', '稍后', '暂', '稍候', '等待',
      // en
      'please', 'try again', 'retry', 'later', 'wait', 'temporar',
      // ja
      'もう一度', 'しばらく', 'お待ち', '再試行',
      // ko
      '다시', '잠시', '기다',
    ];
    final Set<String> seen = <String>{};
    for (final AppLocale locale in AppLocale.values) {
      final String note = AppStrings.of(locale).lightRecordImageNoOriginal;
      expect(note.trim(), isNotEmpty, reason: '$locale');
      expect(seen.add(note), isTrue,
          reason: '$locale reuses another language\'s sentence verbatim');
      for (final String bad in banned) {
        expect(note.toLowerCase().contains(bad.toLowerCase()), isFalse,
            reason: '$locale: 「$bad」 tells the user to do something that '
                'cannot work');
      }
    }
    // Positive control on the same rule, in the other direction: the ONE state
    // on this panel that MAY carry an imperative still does, so the check above
    // is measuring wording and not measuring nothing.
    expect(AppStrings.of(AppLocale.en).lightRecordsSignedOutEmpty.toLowerCase(),
        contains('sign in'));
  });

  test('09-F/09-J: the send bar\'s two strings are four-language and distinct',
      () {
    final Set<String> sends = <String>{};
    final Set<String> notes = <String>{};
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.plusSelectionSend.trim(), isNotEmpty, reason: '$locale');
      expect(s.plusSelectionImagesSeparate.trim(), isNotEmpty, reason: '$locale');
      expect(sends.add(s.plusSelectionSend), isTrue, reason: '$locale');
      expect(notes.add(s.plusSelectionImagesSeparate), isTrue, reason: '$locale');
      // M5-③ precedent: no digits inside the sentence — the count lives on the
      // line above it, in one place.
      expect(RegExp(r'\d').hasMatch(s.plusSelectionImagesSeparate), isFalse,
          reason: '$locale');
    }
  });
}
