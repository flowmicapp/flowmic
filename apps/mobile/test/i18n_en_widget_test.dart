// V2-07.7 acceptance — the surfaces whose hard-coded zh was folded into the
// catalogue REALLY render English under an explicit EN locale: the long-press
// context menu, the delivery status pill (+ edited overlay + source line), the
// live draft row, the mode chip (+ translate target chip), and the edit page.
// The destination badge's record-only word is pinned in
// destination_controller_test.dart (headerLabel). Explicit locale only —
// nothing here reads the OS locale (CLAUDE.md red line).

import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/edit_entry_page.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flowmic/src/ui/mode_chip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _en = AppStringsEn();

TimelineEntry _entry({
  required EntryStatus status,
  required Delivery delivery,
  bool edited = false,
  String? processMode,
  String source = '正文',
  String? output,
  String origin = 'paired',
  String entryType = TimelineEntry.kTranscript,
  bool cachedByVerdict = false,
}) {
  final DateTime now = DateTime.utc(2026, 7, 23, 14, 32);
  return TimelineEntry(
    id: 'loc_mobile_c',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: delivery,
    sourceText: source,
    outputText: output ?? source,
    processMode: processMode,
    status: status,
    edited: edited,
    origin: origin,
    entryType: entryType,
    cachedByVerdict: cachedByVerdict,
    createdAt: now,
    updatedAt: now,
  );
}

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

/// Taps its child to open the long-press context menu for [entry] in EN.
Widget _menuOpener(TimelineEntry entry) => Builder(
  builder: (BuildContext context) => Center(
    child: GestureDetector(
      onTap: () => showEntryContextMenu(context, entry, strings: _en),
      child: const Text('open'),
    ),
  ),
);

void main() {
  testWidgets('EN: the long-press context menu speaks English', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        _menuOpener(
          _entry(status: EntryStatus.injected, delivery: Delivery.inject),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Inject to PC'), findsOneWidget);
    expect(find.text('Re-deliver to the focused window'), findsOneWidget);
    expect(find.text('Re-translate / re-organize'), findsOneWidget);
    expect(find.text('Edit'), findsOneWidget);
    expect(find.text('Copy'), findsOneWidget);
    expect(find.text('Add to Favorites'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
    expect(find.text('注入到 PC'), findsNothing);
    expect(find.text('删除'), findsNothing);
  });

  testWidgets('EN: an image row’s copy entry says WHICH picture (preview, '
      'not the original)', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        _menuOpener(
          _entry(
            status: EntryStatus.injected,
            delivery: Delivery.inject,
            source: '🖼 PNG · 78 KB',
            entryType: TimelineEntry.kImage,
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    // The shared ONE statement of the bounded-preview fact (menu sub-line and
    // copy-result toast both build on imagePreviewNote).
    expect(find.text('Copy preview image'), findsOneWidget);
    expect(find.text('256 px preview, not the original'), findsOneWidget);
    // …and the menu still withholds the actions an image cannot honour.
    expect(find.text('Edit'), findsNothing);
    expect(find.text('Inject to PC'), findsNothing);
  });

  testWidgets('EN: the delivery status pill + edited overlay + source line '
      'speak English', (WidgetTester tester) async {
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: _en,
          entry: _entry(
            status: EntryStatus.injected,
            delivery: Delivery.inject,
            edited: true,
            processMode: 'translate',
            source: '报告已发送',
            output: 'The report has been sent.',
          ),
        ),
      ),
    );
    expect(find.text('✓ Delivered'), findsOneWidget); // 卡 L7: was 'Injected'
    expect(find.text('Edited'), findsOneWidget);
    expect(find.textContaining('Source: 报告已发送'), findsOneWidget);
    expect(find.textContaining('原文：'), findsNothing);

    // N2: both faces of `cached` speak English, and they are DIFFERENT words —
    // a locale that translated only one of them would re-merge the two states
    // for its users while zh looked fine.
    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: _en,
          entry: _entry(status: EntryStatus.cached, delivery: Delivery.inject),
        ),
      ),
    );
    expect(find.text('⏳ Pending · in flight'), findsOneWidget); // 卡 L7

    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: _en,
          entry: _entry(
            status: EntryStatus.cached,
            delivery: Delivery.inject,
            cachedByVerdict: true,
          ),
        ),
      ),
    );
    // 卡 L7 (owner 2026-08-02): was 'Not delivered'. The queue still owes this
    // row — "still queued", not "given up" (docs/rebuild/15 §2.0.1).
    expect(find.text('📥 Pending delivery'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        ChatMessageTile(
          queued: false,
          canResendImage: false,
          strings: _en,
          entry: _entry(status: EntryStatus.noted, delivery: Delivery.none),
        ),
      ),
    );
    expect(find.text('Record only'), findsOneWidget);
    expect(find.text('仅记录'), findsNothing);
  });

  testWidgets('EN: the live draft row says Now / Transcribing', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const LiveDraftTile(
          text: 'partial words',
          mode: FlowMode.realtime,
          strings: _en,
          elapsed: Duration(seconds: 7),
        ),
      ),
    );
    expect(find.text('Now'), findsOneWidget);
    expect(find.text('Transcribing'), findsOneWidget);
    expect(find.text('现在'), findsNothing);
    expect(find.text('转录中'), findsNothing);
  });

  testWidgets('EN: the mode row is the BARE three words, no ①②③', (
    WidgetTester tester,
  ) async {
    // FB-3 option A: the single cycling `ModeChip` became a three-segment control,
    // so an English user now sees all three words at once — which makes this
    // case STRONGER than before: it can catch a shard that only translated the
    // selected mode.
    //
    // 🔴 WP8 VF-2 REWROTE THE OTHER HALF OF THIS CASE. It used to assert
    // "② Translate" — the numeral AND the word, in one string. The mock's
    // segmented pill carries no numerals (`<span class="sgi on">实时`), and
    // they were never catalogue copy: `mode_chip.dart` concatenated them, so
    // deleting them is a layout change and every `AppStrings.modeLabel` value
    // is byte-identical. The i18n guarantee this case exists for is unchanged
    // and is now asserted on the word alone.
    //
    // ⚠️ REVERSE CONTROL (run red, reverted — output quoted in the VF-2 return
    // report): putting the `'$numeral '` prefix back in `_segment` turns the
    // three `findsOneWidget` lines below red by name.
    await tester.pumpWidget(
      _wrap(
        ModeSegmentedControl(
          mode: FlowMode.translate,
          strings: _en,
          onSelect: (FlowMode _) {},
        ),
      ),
    );
    expect(find.text('Translate'), findsOneWidget);
    expect(find.text('翻译'), findsNothing);
    expect(find.text('Realtime'), findsOneWidget);
    expect(find.text('Organize'), findsOneWidget);
    // 🔴 The numerals are GONE, not merely unasserted — a segment that still
    // printed "② Translate" would pass every line above (`find.text` is an
    // exact match, so it would simply find nothing… which is why the positive
    // controls above have to come first, and why this negative one names the
    // numeral itself).
    for (final String numeral in <String>['①', '②', '③']) {
      expect(
        find.textContaining(numeral),
        findsNothing,
        reason: '🔴 the mode row grew its numerals back — the mock\'s `.sgi` '
            'carries the word alone (contract §0 D1)',
      );
    }

    // The translate target chip: an English user gets the ISO code, not 「中」.
    await tester.pumpWidget(
      _wrap(const TranslateTargetChip(target: 'zh', strings: _en)),
    );
    expect(find.text('→ ZH'), findsOneWidget);
    expect(find.text('→ 中'), findsNothing);
  });

  testWidgets('EN: the edit page speaks English end to end', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: EditEntryPage(
          strings: _en,
          entry: _entry(status: EntryStatus.injected, delivery: Delivery.inject),
        ),
      ),
    );
    expect(find.text('Edit entry'), findsOneWidget);
    // The note quotes the SAME editedMark word the corner overlay wears.
    expect(find.textContaining('“Edited”'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    expect(find.text('Save'), findsOneWidget);
    expect(find.text('Save & re-inject'), findsOneWidget);
    expect(find.text('编辑条目'), findsNothing);
  });

  group('EN: scenario presets / packs resolve through the catalogue', () {
    test('profession / domain labels are the catalogue faces', () {
      expect(_en.professionLabel('software development'), 'Software dev');
      expect(_en.professionLabel('law'), 'Law');
      expect(_en.domainLabel('cloud native'), 'Cloud native');
      expect(_en.domainLabel('e-commerce'), 'E-commerce');
      // An unknown stored value is DATA (the stable contract string), not copy.
      expect(_en.professionLabel('whatever-else'), 'whatever-else');
    });

    test('a pack id falls back to the protocol English SSOT label', () {
      expect(_en.packLabel('tech-dev', 'Tech / Dev terms'), 'Tech / Dev terms');
      expect(_en.packLabel('code-switch', 'zh<->en code-switch loanwords'),
          'zh<->en code-switch loanwords');
      expect(_en.packLabel('unknown-pack', 'Protocol label'), 'Protocol label');
    });
  });
}
