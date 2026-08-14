// owner 2026-07-27 image copy — 「手机端的复制也只是复制文字」.
//
// The contract under test is not "an image gets copied"; it is that the user is
// never told something untrue about WHAT got copied. The phone kept only a
// 256 px preview (ImageSendController drops the picked bytes after the emit),
// so each of the four outcomes below is a different fact and must stay
// distinguishable:
//   - a transcript row copies its text and says nothing (unchanged behaviour);
//   - a picture row with a preview copies the PNG, and is announced as a preview;
//   - a picture row without one degrades to text AND says so;
//   - a platform refusal degrades to text AND says so — it never reports success.
//
// SPEC-REF: apps/mobile/lib/src/session/image_clipboard.dart;
//   packages/protocol/src/protocol-schemas-sync.ts (HistoryItemSchema.thumb_b64);
//   CLAUDE.md red line: 没有静默失败.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_clipboard.dart';
import 'package:flowmic/src/session/image_thumbnail.dart'
    show decodedThumbnail, kThumbMaxEdge;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

/// A real 2×2 RGBA PNG (the same bytes the image-send test uses).
const String kPngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
    'SUkJeJw9PL4AAAAASUVORK5CYII=';

class _FakeImageClipboard implements ImageClipboardPort {
  Uint8List? got;
  String? label;
  int calls = 0;
  Object? blowUp;

  @override
  Future<void> copyPng(Uint8List png, {required String label}) async {
    calls++;
    if (blowUp != null) throw blowUp!;
    got = png;
    this.label = label;
  }
}

TimelineEntry _entry({
  required String entryType,
  String? thumbB64,
  String text = '🖼 PNG · 78 KB',
}) {
  final DateTime now = DateTime.utc(2026, 7, 27, 12);
  return TimelineEntry(
    id: 'loc_dev_u1',
    clientId: 'u1',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: text,
    outputText: text,
    status: EntryStatus.injected,
    createdAt: now,
    updatedAt: now,
    entryType: entryType,
    thumbB64: thumbB64,
  );
}

void main() {
  late List<String> textCopies;
  late _FakeImageClipboard image;
  Future<void> capture(String s) async => textCopies.add(s);

  setUp(() {
    textCopies = <String>[];
    image = _FakeImageClipboard();
  });

  group('copyEntryToClipboard', () {
    test('a transcript row copies its text and never touches the image path', () async {
      final ImageCopyOutcome out = await copyEntryToClipboard(
        _entry(entryType: TimelineEntry.kTranscript, text: '你好世界'),
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.copiedText);
      expect(textCopies, <String>['你好世界']);
      expect(image.calls, 0);
    });

    test('a picture row with a preview copies the PNG, not the descriptor', () async {
      final ImageCopyOutcome out = await copyEntryToClipboard(
        _entry(entryType: TimelineEntry.kImage, thumbB64: kPngB64),
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.copiedPreview);
      expect(image.calls, 1);
      expect(image.got, base64Decode(kPngB64));
      // The descriptor rides along as the clip LABEL, but must not be what the
      // user pastes.
      expect(image.label, '🖼 PNG · 78 KB');
      expect(textCopies, isEmpty);
    });

    test('a picture row with no preview degrades to text — and is not called a success', () async {
      final ImageCopyOutcome out = await copyEntryToClipboard(
        _entry(entryType: TimelineEntry.kImage),
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.noPreviewCopiedText);
      expect(out, isNot(ImageCopyOutcome.copiedText));
      expect(textCopies, <String>['🖼 PNG · 78 KB']);
      expect(image.calls, 0);
    });

    test('an undecodable stored thumbnail is the same fact as no thumbnail', () async {
      final ImageCopyOutcome out = await copyEntryToClipboard(
        _entry(entryType: TimelineEntry.kImage, thumbB64: 'not-base64!!!'),
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.noPreviewCopiedText);
      expect(image.calls, 0);
    });

    test('a platform refusal falls back to text and reports the refusal', () async {
      image.blowUp = PlatformExceptionStub();
      final ImageCopyOutcome out = await copyEntryToClipboard(
        _entry(entryType: TimelineEntry.kImage, thumbB64: kPngB64),
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.platformRefusedCopiedText);
      expect(textCopies, <String>['🖼 PNG · 78 KB']);
    });
  });

  group('the user is told which of the four happened', () {
    for (final AppLocale locale in AppLocale.values) {
      test('every non-silent outcome has a $locale sentence', () {
        final AppStrings s = AppStrings.of(locale);
        // The plain text copy is the ONE silent branch: it is what copy always
        // did and there is nothing to explain.
        expect(s.imageCopyResult(ImageCopyOutcome.copiedText), isNull);
        for (final ImageCopyOutcome o in <ImageCopyOutcome>[
          ImageCopyOutcome.copiedPreview,
          ImageCopyOutcome.noPreviewCopiedText,
          ImageCopyOutcome.platformRefusedCopiedText,
        ]) {
          expect(s.imageCopyResult(o), isNotNull, reason: '$o has no copy');
          expect(s.imageCopyResult(o)!.trim(), isNotEmpty, reason: '$o is blank');
        }
      });
    }

    test('the success sentence says PREVIEW, never plain 「图片」', () {
      // ⚠️ Card G-19 addendum: this case and "which bytes were actually copied"
      // are **two independently-true** tests; changing one side will not ring
      // the other. The case that pins both together is in the G-19 group at
      // the end of this file.
      // The whole point: the user must not paste a 256 px square expecting the
      // screenshot they sent. If someone later shortens this to 「已复制图片」 /
      // "Image copied", this test is the thing that objects.
      expect(
        AppStrings(AppLocale.zh).imageCopyResult(ImageCopyOutcome.copiedPreview),
        contains('预览图'),
      );
      // V2-07.7: the sentence now wraps the ONE bounded-preview statement
      // (AppStrings.imagePreviewNote) shared with the context menu, so the EN
      // face carries the fact in sentence case rather than a capitalized label.
      expect(
        AppStrings(AppLocale.en).imageCopyResult(ImageCopyOutcome.copiedPreview),
        allOf(contains('preview'), contains('not the original')),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Card G-19 — the only reason this case exists: make a **one-sided change**
  // impossible
  //
  // Ruling = docs/decisions/2026-08-05-it18-leftover-items-rulings.md「G-19」:
  // **behavior unchanged, copy unchanged**, add one test that pins both
  // together. Today the two sides agree ⇒ **today there is no lie**; the risk
  // is not now, it is later.
  //
  // 🔴 What it pins is the already-written contract in the image_clipboard.dart
  //    file header (grep there for the 「THE SENTENCES BELOW ARE THEREFORE
  //    STILL EXACT」 paragraph):
  //    **"if a later card changes 'copy' to copy the full image, those
  //    sentences must change in the same commit"**.
  //    Until today **nothing guarded that sentence** — it is a "comment that
  //    asserts someone else's behavior" (anti-façade ④), and this family's
  //    truth value changes when someone else's code changes, while the comment
  //    itself does not.
  //
  // 🔴 Where the hole is (this is the whole card): the behavior criterion and
  //    the copy criterion used to be **two unrelated tests** (the two above in
  //    this file, each correct on its own). Someone who swapped the byte source
  //    to the full image would change the behavior case in the same commit,
  //    and the copy case would **stay green** — so that day produces a lie,
  //    「已复制：256px 预览图，非原图」, while the clipboard holds the original.
  //    **The whole suite stays green.**
  //    ⇒ three legs go into **the same** test, sharing the same premise; none
  //    can move alone.
  //
  // 🔴 The third leg (`256` must be derived, not typed in) used to have
  //    **nothing holding it**: the day `kThumbMaxEdge` becomes 512, the
  //    "256px" in the four-locale copy quietly becomes a lie, and the
  //    thumbnail-generation tests stay green — they measure pixels, not that
  //    sentence.
  // ══════════════════════════════════════════════════════════════════════════
  group('G-19 — the copied bytes and the spoken sentence must change in the same frame', () {
    test('🔴 three legs share one premise: bytes = preview ∧ the sentence says preview ∧ 256 is derived', () async {
      final TimelineEntry entry = _entry(
        entryType: TimelineEntry.kImage,
        thumbB64: kPngB64,
      );

      // ── Leg ① behavior: what is handed to the clipboard is this row's 256px preview.
      final ImageCopyOutcome out = await copyEntryToClipboard(
        entry,
        image: image,
        text: capture,
      );
      expect(out, ImageCopyOutcome.copiedPreview);
      final Uint8List? preview = decodedThumbnail(entry.thumbB64);
      expect(preview, isNotNull, reason: 'premise collapsed: this row has no preview at all');
      expect(
        image.got,
        same(preview),
        reason: 'the clipboard did not receive the thumbnail instance the production decoder emits',
      );
      expect(image.got, equals(preview));

      // ── Leg ② copy: the success sentence of **the same** outcome must carry
      // that 「非原图」 clause. The criterion hangs on `out` rather than
      // hard-coding `copiedPreview`, so if leg ① changes outcome, this leg
      // changes question with it instead of answering a scene that no longer
      // exists.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(
          s.imageCopyResult(out),
          contains(s.imagePreviewNote),
          reason: '$locale: the copy result did not name which copy was handed over',
        );
      }

      // ── Leg ③ the 256 in that sentence must be derived from kThumbMaxEdge.
      for (final AppLocale locale in AppLocale.values) {
        expect(
          AppStrings.of(locale).imagePreviewNote,
          contains('$kThumbMaxEdge'),
          reason: '$locale: the size in the copy no longer matches kThumbMaxEdge',
        );
      }
    });

    test('reverse-control direction: this case must go red because "the byte source changed"', () {
      // 🔴 0.2.52 §3 law: **when writing a negative assertion the first
      //    question is not "is this right", it is "if I am wrong, who will
      //    tell me"**. The answer for the case above is: point
      //    `copyEntryToClipboard`'s byte source elsewhere and leg ① goes red
      //    on the spot (already measured; see the red-run excerpt pasted in
      //    the delivery report).
      //    Pin one more here: the preview and "some other bytes" must be
      //    distinguishable in this suite, or leg ①'s `same()` is only true
      //    by coincidence.
      final Uint8List? preview = decodedThumbnail(kPngB64);
      expect(preview, isNotNull);
      expect(
        preview,
        isNot(equals(Uint8List.fromList(<int>[1, 2, 3, 4]))),
        reason: 'if the samples are indistinguishable, leg ① stays green on any bytes',
      );
    });
  });
}

/// Stands in for a PlatformException without importing services.dart into the
/// assertion surface — copyEntryToClipboard catches Object, deliberately, so
/// the kind of throw is not part of the contract.
class PlatformExceptionStub implements Exception {}
