// SPEC-REF:
//   packages/protocol/src/protocol-schemas-sync.ts (HistoryItemSchema.thumb_b64)
//   apps/mobile/lib/src/session/image_thumbnail.dart (who makes the preview)
//   CLAUDE.md red line: no silent failure
//
// owner 2026-07-27: 「the phone side's copy also just copies text」. A
// picture row long-pressed → Copy used to put its DESCRIPTOR
// (「🖼 PNG · 78 KB」) on the clipboard, which is a sentence about a picture
// rather than the picture.
//
// What can honestly be copied — and why it is the PREVIEW, not the original.
//
// ⚠️⚠️ Correction (RV-93): the reason used to be 「ImageSendController deliberately never
// retains the picked bytes (they are pasted on the PC and dropped)…that thumbnail
// is the only image this phone still has」. That stopped being true on 2026-08-01
// (owner: 「delete on successful delivery」 changed to 「keep it instead」) —
// the DELIVERED bytes are kept and tapping to view the full image renders
// them. This path was NOT switched to them, deliberately: it is a
// synchronous read of an already-decoded thumbnail, while the delivered file is a
// disk read that has to be awaited and can be absent on an old row.
// 🔴 THE SENTENCES BELOW ARE THEREFORE STILL EXACT — 「256px preview image,
// not the original」 describes what this code really puts on the clipboard.
// **If a later card makes Copy use the big picture, those strings must
// change in the same commit**, or the app will understate what it just
// handed over. Logged as a gap, not implied.
//
// ✅ card G-19 (2026-08-07) — the sentence above, 「must change in the same
// commit」, had **nothing enforcing it** before today. It is a comment
// asserting another place's behaviour (anti-façade ④), and this family's
// truth value changes as someone else's code changes while the comment
// itself does not; each side had one test at the time, but they were
// **unrelated to each other**, so whoever swapped the byte source would only
// see the behaviour test go red, while the copy test stayed green ⇒ a false
// statement would be produced that very day, with the whole test suite
// green. Now something enforces it: the group in
// `test/image_clipboard_test.dart` — 「G-19 — the copied bytes and the
// spoken sentence must change in the same frame」 — writes all three facts
// into **one** test sharing one premise: the bytes handed over =
// `decodedThumbnail(entry.thumbB64)`, the same outcome's success sentence
// contains `AppStrings.imagePreviewNote`, and the size in that sentence
// comes from `kThumbMaxEdge` (the third fact previously had zero holders
// too: changing 256 to 512 would quietly turn the four-language copy into a
// lie, while the thumbnail-side test measures pixels, not the sentence).
// **Grep that group name — if it's not found, this comment has drifted back
// into a statement nobody enforces.**
// ⚠️ Neither the behaviour nor the copy changed by one character this round:
// G-19's ruling is 「no changing one side without the other」, not 「change
// it to this」.
// Every outcome below NAMES what landed on the clipboard: copying a 256 px
// preview while saying 「image copied」 would have the user paste a blurry
// square into a document expecting their screenshot — the false-reporting
// half of the fail-loud red line, which cuts both ways (never swallow, never
// overclaim).
//
// Flutter's own Clipboard is text-only; an image needs a content:// URI, so the
// image half goes through a MethodChannel to android/.../ImageClipboard.kt. Any
// refusal from that channel falls back to the text copy AND says it fell back.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../timeline/timeline_entry.dart';
import 'image_thumbnail.dart' show decodedThumbnail;

/// What actually landed on the clipboard. There is no "succeeded" value that
/// hides which of these happened — the caller shows a different sentence for
/// each, because they are different facts.
enum ImageCopyOutcome {
  /// A plain transcript row: its text is on the clipboard. (The pre-existing
  /// behaviour, unchanged, and the only case with nothing to explain.)
  copiedText,

  /// The row's 256 px PREVIEW is on the clipboard — not the original picture.
  copiedPreview,

  /// A picture row with no preview (best-effort generation failed, or a row
  /// created before thumbnails existed). The descriptor text was copied and the
  /// user is told there was no image to copy.
  noPreviewCopiedText,

  /// The platform refused to put the image on the clipboard. Descriptor text
  /// copied instead, said out loud.
  platformRefusedCopiedText,
}

/// The image-clipboard seam. Production is [MethodChannelImageClipboard]; tests
/// pass a fake, which is what keeps this contract provable headless.
abstract class ImageClipboardPort {
  /// Put [png] on the system clipboard as an image. Throws on refusal — a
  /// silent no-op here would be indistinguishable from a successful copy.
  Future<void> copyPng(Uint8List png, {required String label});
}

/// Android: writes the PNG to a cache file and hands the clipboard a
/// FileProvider content:// URI (ClipData.newUri). See ImageClipboard.kt.
class MethodChannelImageClipboard implements ImageClipboardPort {
  const MethodChannelImageClipboard();

  /// Must match `ImageClipboard.CHANNEL` on the Kotlin side.
  static const MethodChannel channel = MethodChannel(
    'app.flowmic/image_clipboard',
  );

  @override
  Future<void> copyPng(Uint8List png, {required String label}) async {
    await channel.invokeMethod<void>('copyPng', <String, Object?>{
      'png': png,
      'label': label,
    });
  }
}

/// The text half of the seam (Flutter's own clipboard), injectable for tests.
typedef TextCopy = Future<void> Function(String text);

Future<void> _systemTextCopy(String text) =>
    Clipboard.setData(ClipboardData(text: text));

/// Copy [entry] the way its KIND deserves, and report which of the four things
/// actually happened.
///
/// A transcript row is untouched behaviour. A picture row copies its preview
/// when it has one, and otherwise degrades to the descriptor — loudly, via the
/// returned outcome, never by quietly doing the old thing.
/// WP3 C15: copy the ORIGINAL words behind a translated/organized row.
///
/// Copies [TimelineEntry.sourceText] — the immutable `source_text`, never the
/// rendered/processed face. The caller's menu gate ([TimelineEntry.showsSourceLine])
/// only offers the action when a distinct, non-empty source exists; this
/// re-check makes the empty case a no-op instead of overwriting the user's
/// clipboard with an empty string (a copy that "succeeds" by destroying what
/// was there is the overclaiming half of "no silent failure").
Future<void> copyEntrySourceText(TimelineEntry entry, {TextCopy? text}) async {
  final String source = entry.sourceText ?? '';
  if (source.isEmpty) return;
  await (text ?? _systemTextCopy)(source);
}

Future<ImageCopyOutcome> copyEntryToClipboard(
  TimelineEntry entry, {
  ImageClipboardPort? image,
  TextCopy? text,
}) async {
  final TextCopy copyText = text ?? _systemTextCopy;
  if (!entry.isImage) {
    await copyText(entry.displayText);
    return ImageCopyOutcome.copiedText;
  }

  // Same decode the tile renders from, same cache — copying the row you are
  // looking at must not pay for a second decode of the identical bytes.
  final Uint8List? png = decodedThumbnail(entry.thumbB64);
  if (png == null) {
    await copyText(entry.displayText);
    return ImageCopyOutcome.noPreviewCopiedText;
  }

  try {
    await (image ?? const MethodChannelImageClipboard()).copyPng(
      png,
      label: entry.displayText,
    );
    return ImageCopyOutcome.copiedPreview;
  } on Object catch (e) {
    // The channel is missing (a platform we have not wired), the provider is
    // misconfigured, or the OS said no. The user still gets SOMETHING, and gets
    // told it is not the picture.
    debugPrint('[flowmic.image] clipboard image copy failed: $e');
    await copyText(entry.displayText);
    return ImageCopyOutcome.platformRefusedCopiedText;
  }
}
