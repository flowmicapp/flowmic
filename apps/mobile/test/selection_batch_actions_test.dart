// Card FB-7 — the **judgment** half of batch copy / hand-to-AI organize.
//
// [unit] Pure functions, no page. Whether the production entry is actually
// wired is proven by `selection_wire_test.dart`.
//
// 🔴 The two most important cases in this file are not "does the feature
// work", they are two **content-safety** rules:
//   ① what lands on the clipboard and what the sentence says must be the same
//      fact (a false report is the other half of 没有静默失败);
//   ② handing to AI organize must never overwrite words the user has not sent
//      (`bufferBusy`), because the controlled pipeline only acts on that
//      shared buffer.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/selection/batch_actions.dart';
import 'package:flutter_test/flutter_test.dart';

const List<AppLocale> kLocales = AppLocale.values;
const AppStrings _zh = AppStringsZh();

TimelineEntry _text(String id, String body) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.inject,
  sourceText: body,
  outputText: body,
  status: EntryStatus.injected,
  createdAt: DateTime.utc(2026, 8, 7),
  updatedAt: DateTime.utc(2026, 8, 7),
);

TimelineEntry _image(String id) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.inject,
  sourceText: null,
  outputText: '🖼 PNG · 214 KB',
  status: EntryStatus.injected,
  entryType: 'image',
  createdAt: DateTime.utc(2026, 8, 7),
  updatedAt: DateTime.utc(2026, 8, 7),
);

SelectedRecords _plain(int n) =>
    selectedRecords(<TimelineEntry>[for (int i = 0; i < n; i++) _text('t$i', 'w$i')]);

void main() {
  group('selectedRecords — which text a batch of records equals', () {
    test('text rows in list order, one line per row', () {
      final SelectedRecords r = selectedRecords(<TimelineEntry>[
        _text('a', '第一句'),
        _text('b', '第二句'),
      ]);
      expect(r.text, '第一句\n第二句');
      expect(r.textRows, 2);
      expect(r.imageRows, 0);
      expect(r.hasText, isTrue);
    });

    test('🔴 image rows are excluded, and they are counted', () {
      // An image row's displayText is a descriptor (a sentence about the
      // picture), not the record itself.
      final SelectedRecords r = selectedRecords(<TimelineEntry>[
        _text('a', '第一句'),
        _image('img1'),
        _image('img2'),
      ]);
      expect(r.text, '第一句');
      expect(r.textRows, 1);
      expect(r.imageRows, 2);
      expect(
        r.text.contains('PNG'),
        isFalse,
        reason: 'a descriptor must never impersonate record content and sneak onto the clipboard',
      );
    });

    test('all images ⇒ no text', () {
      final SelectedRecords r =
          selectedRecords(<TimelineEntry>[_image('i1'), _image('i2')]);
      expect(r.hasText, isFalse);
      expect(r.textRows, 0);
      expect(r.imageRows, 2);
    });
  });

  group('runBatchCopy — what lands on the clipboard, and the sentence', () {
    test('🔴 all text: the string on the clipboard and the count in the sentence are the same fact', () {
      // One **joint** assertion, not two independently-true ones: the N in
      // 「已复制 N 条」 must be the N rows that are actually on the clipboard.
      late String landed;
      final SelectedRecords r = selectedRecords(<TimelineEntry>[
        _text('a', 'one'),
        _text('b', 'two'),
        _text('c', 'three'),
      ]);
      return runBatchCopy(r, text: (String t) async => landed = t)
          .then((BatchCopyOutcome outcome) {
        expect(outcome, BatchCopyOutcome.copied);
        final String said = batchCopyResultText(outcome, r, _zh);
        expect(landed, 'one\ntwo\nthree');
        expect(landed.split('\n'), hasLength(3));
        expect(
          said,
          _zh.selectionCopiedRecords(landed.split('\n').length),
          reason: 'the number in the sentence is computed from clipboard content; mismatch goes red',
        );
      });
    });

    test('🔴 mixed selection: images that were not taken must be named in the same sentence', () async {
      late String landed;
      final SelectedRecords r = selectedRecords(<TimelineEntry>[
        _text('a', 'one'),
        _image('i1'),
        _image('i2'),
      ]);
      final BatchCopyOutcome outcome =
          await runBatchCopy(r, text: (String t) async => landed = t);
      expect(outcome, BatchCopyOutcome.copiedSkippedImages);
      expect(landed, 'one');
      final String said = batchCopyResultText(outcome, r, _zh);
      expect(said, contains('1'));
      expect(said, contains('2'));
      expect(
        said,
        _zh.selectionCopiedRecordsSkippedImages(
          landed.split('\n').length,
          r.imageRows,
        ),
      );
    });

    test('🔴 all images: the clipboard is never touched', () async {
      // Writing an empty string would silently wipe what the user last copied
      // — a loss this button never promised. The sentence 「剪贴板未改动」 in the
      // copy is this branch's user-readable evidence.
      int calls = 0;
      final SelectedRecords r =
          selectedRecords(<TimelineEntry>[_image('i1')]);
      final BatchCopyOutcome outcome = await runBatchCopy(
        r,
        text: (String t) async => calls++,
      );
      expect(outcome, BatchCopyOutcome.nothingToCopy);
      expect(calls, 0);
      expect(batchCopyResultText(outcome, r, _zh), _zh.selectionCopiedNothing);
    });

    test('all three result sentences are non-empty in every locale, and pairwise distinct within a locale', () {
      for (final AppLocale loc in kLocales) {
        final AppStrings s = AppStrings.of(loc);
        final Set<String> seen = <String>{};
        for (final (BatchCopyOutcome o, SelectedRecords r) in <
            (BatchCopyOutcome, SelectedRecords)>[
          (BatchCopyOutcome.copied, _plain(3)),
          (
            BatchCopyOutcome.copiedSkippedImages,
            selectedRecords(<TimelineEntry>[_text('a', 'x'), _image('i')]),
          ),
          (BatchCopyOutcome.nothingToCopy, selectedRecords(<TimelineEntry>[])),
        ]) {
          final String t = batchCopyResultText(o, r, s);
          expect(t.trim(), isNotEmpty, reason: '$loc/$o');
          expect(seen.add(t), isTrue, reason: '$loc: $o collided with another outcome on the same sentence');
        }
      }
    });
  });

  group('checkBatchOrganize — six gates', () {
    BatchOrganizeRefusal? check({
      SelectedRecords? records,
      int selectedCount = 2,
      bool canCompose = true,
      bool isAiComposing = false,
      bool speechInFlight = false,
      String buffer = '',
    }) => checkBatchOrganize(
      records: records ?? _plain(2),
      selectedCount: selectedCount,
      canCompose: canCompose,
      isAiComposing: isAiComposing,
      speechInFlight: speechInFlight,
      buffer: buffer,
    );

    test('everything fine ⇒ null (may run)', () {
      expect(check(), isNull);
    });

    test('nothing checked', () {
      expect(
        check(records: selectedRecords(<TimelineEntry>[]), selectedCount: 0),
        BatchOrganizeRefusal.noSelection,
      );
    });

    test('everything checked is an image', () {
      expect(
        check(
          records: selectedRecords(<TimelineEntry>[_image('i')]),
          selectedCount: 1,
        ),
        BatchOrganizeRefusal.noText,
      );
    });

    test('disconnected', () {
      expect(check(canCompose: false), BatchOrganizeRefusal.offline);
    });

    test('a previous AI run is still in flight', () {
      expect(check(isAiComposing: true), BatchOrganizeRefusal.aiBusy);
    });

    test('🔴 speaking/transcribing — the final will fold into the same buffer, and organize finishes with a wholesale replace', () {
      expect(check(speechInFlight: true), BatchOrganizeRefusal.speechInFlight);
    });

    test('🔴 the input box still has unsent words — refuse rather than overwrite', () {
      expect(check(buffer: '还没发出去的话'), BatchOrganizeRefusal.bufferBusy);
      expect(
        check(buffer: '   \n  '),
        isNull,
        reason: 'whitespace only ⇒ nothing would be lost, must not block',
      );
    });

    test('when two gates trip at once, answer "what you just selected" first', () {
      // Order is priority: the action the user just took > a state they did
      // not create.
      expect(
        check(
          records: selectedRecords(<TimelineEntry>[_image('i')]),
          selectedCount: 1,
          canCompose: false,
          buffer: '有字',
        ),
        BatchOrganizeRefusal.noText,
      );
    });

    test('all six reasons are non-empty in every locale, and pairwise distinct within a locale', () {
      for (final AppLocale loc in kLocales) {
        final AppStrings s = AppStrings.of(loc);
        final Set<String> seen = <String>{};
        for (final BatchOrganizeRefusal r in BatchOrganizeRefusal.values) {
          final String t = batchOrganizeRefusalText(r, s);
          expect(t.trim(), isNotEmpty, reason: '$loc/$r');
          expect(seen.add(t), isTrue, reason: '$loc: $r collided with another reason on the same sentence');
        }
      }
    });
  });

  group('batchOrganizeStartedText — the started sentence must also count images', () {
    test('does not mention images when there are none', () {
      final String t = batchOrganizeStartedText(_plain(3), _zh);
      expect(t, _zh.selectionOrganizeStarted(3));
      expect(t.contains('图片'), isFalse);
    });

    test('when there are images, count them in the same sentence', () {
      final SelectedRecords r = selectedRecords(<TimelineEntry>[
        _text('a', 'x'),
        _image('i1'),
      ]);
      expect(
        batchOrganizeStartedText(r, _zh),
        _zh.selectionOrganizeStartedSkippedImages(1, 1),
      );
    });
  });
}
