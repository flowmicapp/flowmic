// CR-12-F — the 「+」 panel's 「with times」 chip for a forwarded recording.
//
// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     ruling 3, in-place addendum 2026-09-22 (the user may opt in to times)
//   CR-12 design §10 (the chip, its memory, `articleCopyText` as the format)
//
// 🔴 DRIVEN THROUGH THE REAL PANEL (CLAUDE.md anti-facade ⑥): the deliverable is
// 「what the send bar shows and what one tap on 发送 hands over」, so every case
// mounts [PlusPanel], ticks rows on its own light-record tab and reads the one
// handover — never `PlusPanelSelection` alone.
//
// ⚠️ THE STORE IS [InMemoryTimelinePersistence] for the reason
// plus_panel_multiselect_test.dart's header states (sqflite futures never
// complete inside `testWidgets`' FakeAsync zone).
//
// ⚠️ THE NARROW-SCREEN CASE asserts on the RENDERED label (`didExceedMaxLines`
// and intrinsic width against the laid-out box), under the Ahem ruler scaled
// per script by `ahemWidthBudget` — never on `Text.data` (0.2.53).

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flowmic/src/ui/plus_panel_selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart' show ahemWidthBudget;

const String kArt = 'a0-1788000000000000';
final DateTime _t0 = DateTime.utc(2026, 9, 22, 9);

TimelineEntry _member(String id, String text, int offsetMs, int ms) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      articleId: kArt,
      articleOffsetMs: offsetMs,
      durationMs: ms,
      createdAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
      updatedAt: _t0.add(Duration(milliseconds: offsetMs + 1)),
    );

final TimelineEntry _head = TimelineEntry(
  id: 'loc_$kArt',
  clientId: kArt,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '先说库存。',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kArticle,
  articleId: kArt,
  origin: 'cloud',
  durationMs: 115_000,
  segmentsCount: 3,
  createdAt: _t0,
  updatedAt: _t0,
);

TimelineEntry _plain(String id, String text, DateTime at) => TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      createdAt: at,
      updatedAt: at,
    );

/// 45 s / 30 s / 40 s, the first two ending a sentence: CR-12-B closes the
/// first paragraph at 45 s (past the 40 s floor, on a sentence end) and keeps
/// the other two together.
final List<TimelineEntry> _members = <TimelineEntry>[
  _member('s1', '先说库存。', 0, 45_000),
  _member('s2', '再说采购。', 45_000, 30_000),
  _member('s3', '最后排期', 75_000, 40_000),
];

/// Written out once, so the assertion reads as the expectation and not as the
/// implementation echoed back.
const String kTimed = '00:00–00:45 先说库存。\n00:45–01:55 再说采购。最后排期';

/// What the send carried BEFORE this card (`transcriptOf`): one row per line.
const String kUntimed = '先说库存。\n再说采购。\n最后排期';

const Key kChip = ValueKey<String>('plus.selection.withTimes');
const Key kSend = ValueKey<String>('plus.selection.send');

class _Rig {
  _Rig({required this.persistence, required this.prefs, AppStrings? strings})
      : strings = strings ?? const AppStringsZh();

  final TimelinePersistence persistence;
  final LocalPrefs prefs;
  final AppStrings strings;
  final List<String?> sent = <String?>[];

  Widget build() => MaterialApp(
        home: Scaffold(
          body: PlusPanel(
            favorites: FavoritesStore(prefs: InMemoryLocalPrefs()),
            strings: strings,
            buffer: '',
            noPcTarget: false,
            onSend: (_) {},
            onFeedback: (_) {},
            lightRecords: LightRecordQuery(persistence: persistence),
            isSignedIn: () => true,
            onSendSelection: ({
              required String? text,
              required List<TimelineEntry> images,
            }) async =>
                sent.add(text),
            imageSendable: (TimelineEntry e) async => false,
            prefs: prefs,
          ),
        ),
      );
}

Future<TimelinePersistence> _store({bool withArticle = true}) async {
  final TimelinePersistence p = InMemoryTimelinePersistence();
  await p.saveAll(<TimelineEntry>[
    if (withArticle) ...<TimelineEntry>[_head, ..._members],
    _plain('p1', '随口一句', _t0.add(const Duration(minutes: 5))),
  ]);
  return p;
}

Future<void> _openNotes(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey<String>('plus.tab.notes')));
  for (int i = 0; i < 6; i++) {
    await tester.pump(); // the list read, then the article reads, land
  }
}

Future<void> _tickArticle(WidgetTester tester) async {
  await tester.tap(
    find.byKey(ValueKey<String>('plus.notes.openArticle.${_head.id}')),
  );
  await tester.pump();
}

Future<void> _tickPlain(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey<String>('plus.notes.tick.p1')));
  await tester.pump();
}

Future<void> _send(WidgetTester tester) async {
  await tester.tap(find.byKey(kSend));
  await tester.pumpAndSettle();
}

Future<_Rig> _mount(
  WidgetTester tester, {
  LocalPrefs? prefs,
  bool withArticle = true,
  AppStrings? strings,
}) async {
  final _Rig rig = _Rig(
    persistence: await _store(withArticle: withArticle),
    prefs: prefs ?? InMemoryLocalPrefs(),
    strings: strings,
  );
  await tester.pumpWidget(rig.build());
  await tester.pumpAndSettle();
  await _openNotes(tester);
  return rig;
}

void main() {
  group('when the chip is on the send bar', () {
    testWidgets('🔴 a ticked recording ⇒ the chip, beside the send button',
        (WidgetTester tester) async {
      await _mount(tester);
      await _tickArticle(tester);
      expect(find.byKey(kSend), findsOneWidget,
          reason: 'positive control: the send bar is up');
      expect(find.byKey(kChip), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('plus.selection.withTimes.off')),
          findsOneWidget, reason: 'off by default');
    });

    testWidgets('🔴 only plain rows ticked ⇒ no chip (it would change nothing)',
        (WidgetTester tester) async {
      await _mount(tester);
      await _tickPlain(tester);
      expect(find.byKey(kSend), findsOneWidget,
          reason: 'positive control: the send bar is up');
      expect(find.byKey(kChip), findsNothing);
    });
  });

  group('what one send hands over', () {
    testWidgets('🔴 chip on ⇒ one line per paragraph, each with its range',
        (WidgetTester tester) async {
      final _Rig rig = await _mount(tester);
      await _tickArticle(tester);
      await tester.tap(find.byKey(kChip));
      await tester.pump();
      await _send(tester);
      expect(rig.sent, hasLength(1));
      expect(rig.sent.single, kTimed);
      expect(rig.sent.single!.split('\n'), hasLength(2));
    });

    testWidgets('🔴 chip off ⇒ byte-identical to the send before this card',
        (WidgetTester tester) async {
      final _Rig rig = await _mount(tester);
      await _tickArticle(tester);
      await _send(tester);
      expect(rig.sent.single, kUntimed);
      expect(
        rig.sent.single,
        await LightRecordQuery(persistence: rig.persistence).transcriptOf(kArt),
      );
    });

    testWidgets('chip on beside a plain row: the row is untouched, oldest first',
        (WidgetTester tester) async {
      final _Rig rig = await _mount(tester);
      await _tickPlain(tester);
      await _tickArticle(tester);
      await tester.tap(find.byKey(kChip));
      await tester.pump();
      await _send(tester);
      expect(rig.sent.single, '$kTimed\n随口一句');
    });
  });

  testWidgets('🔴 the chip remembers: leave the panel, come back, still on',
      (WidgetTester tester) async {
    final LocalPrefs prefs = InMemoryLocalPrefs();
    await _mount(tester, prefs: prefs);
    await _tickArticle(tester);
    await tester.tap(find.byKey(kChip));
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('plus.selection.withTimes.on')),
        findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    final _Rig again = await _mount(tester, prefs: prefs);
    await _tickArticle(tester);
    expect(find.byKey(const ValueKey<String>('plus.selection.withTimes.on')),
        findsOneWidget, reason: 'the last choice, read back on a fresh panel');
    await _send(tester);
    expect(again.sent.single, kTimed);
  });

  test('two recordings with times: joined by ONE newline, oldest first', () {
    TimelineEntry head(String id, DateTime at) => TimelineEntry(
          id: 'loc_$id',
          clientId: id,
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          sourceText: null,
          outputText: id,
          status: EntryStatus.noted,
          entryType: TimelineEntry.kArticle,
          articleId: id,
          origin: 'cloud',
          createdAt: at,
          updatedAt: at,
        );
    final PlusPanelSelection sel = PlusPanelSelection()
      ..toggle(PlusPick.article(head('b', _t0.add(const Duration(hours: 1))),
          '后一篇', timedText: '00:00–00:30 后一篇'))
      ..toggle(PlusPick.article(head('a', _t0), '前一篇',
          timedText: '00:00–00:30 前一篇'));
    addTearDown(sel.dispose);
    expect(sel.composeText(withTimes: true),
        '00:00–00:30 前一篇\n00:00–00:30 后一篇');
    expect(sel.composeText(withTimes: false), sel.composedText);
  });

  group('narrow screen: chip and send share one row, nothing clipped', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets(locale.name, (WidgetTester tester) async {
        addTearDown(tester.view.reset);
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1200, 900);
        await _mount(tester, strings: AppStrings(locale));
        await _tickArticle(tester);
        tester.view.physicalSize = Size(ahemWidthBudget(locale), 900);
        await tester.pumpAndSettle();

        final AppStrings s = AppStrings(locale);
        final Finder chipLabel =
            find.byKey(const ValueKey<String>('plus.selection.withTimes.label'));
        expect(chipLabel, findsOneWidget);
        final RenderParagraph chip = tester.renderObject(chipLabel);
        expect(chip.text.toPlainText(), s.selectionSendWithTimes);
        expect(chip.didExceedMaxLines, isFalse);
        expect(chip.getMaxIntrinsicWidth(double.infinity),
            lessThanOrEqualTo(chip.size.width + 0.5),
            reason: '「${s.selectionSendWithTimes}」 is clipped');

        final Finder sendLabel = find.descendant(
          of: find.byKey(kSend),
          matching: find.byType(RichText),
        );
        final RenderParagraph send = tester.renderObject(sendLabel.first);
        expect(send.getMaxIntrinsicWidth(double.infinity),
            lessThanOrEqualTo(send.size.width + 0.5),
            reason: 'the send label is clipped');

        expect(tester.getCenter(find.byKey(kChip)).dy,
            closeTo(tester.getCenter(find.byKey(kSend)).dy, 0.5),
            reason: 'one row');
        expect(tester.takeException(), isNull, reason: 'no overflow');
      });
    }
  });
}
