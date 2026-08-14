// SPEC-REF:
//   apps/mobile/lib/src/session/image_payload.dart (kInjectImageB64Budget —
//     the ceiling this ladder exists to satisfy; kImagePickMaxEdge — the size
//     the picker was ASKED to produce)
//   docs/decisions/2026-07-29-image-frame-reject-receipt.md
//   CLAUDE.md red line: no silent failure
//
// owner 2026-07-27 ruling (quoted in image_payload.dart): "relax the picture
// compression to around 1080p — if it's bigger than that, compress it down
// below that size" (「压缩图片放宽到 1080P 左右的尺寸，如果大于这个尺寸就压缩到
// 此尺寸以下」). The picker is ASKED to do this
// natively (maxWidth/maxHeight/imageQuality) — but on 2026-07-29 the owner's
// real phone put a >5.5M-char image_b64 on the wire, i.e. the plugin handed
// back bytes nothing had shrunk, and every camera photo died: 5.5M–8M chars at
// the server's zod boundary (dropped, then unanswered), >8M at the engine cap
// (connection killed, no trace anywhere). This ladder makes the owner's ruling
// unconditional: when picked bytes still blow the send budget, the app itself
// re-scales until they fit — MEASURING the real result at every rung rather
// than trusting any dimension math (a PNG re-encode of a busy photo can be
// larger than the JPEG it came from — measurement absorbs that).
//
// ⚠️ 2026-08-01 CORRECTION. This paragraph used to end 「portrait targetWidth
// overshoots the long edge — measurement absorbs all of it」, which was a
// knowing wave-through of a real defect: every portrait picture was UPSCALED at
// the first rung. Measurement absorbed the SIZE, not the wasted native-size
// decode. See [downscaleTargetAxis] for the fix and the reasoning.
//
// dart:ui is the only codec the app carries (same zero-dependency reasoning as
// the thumbnail), and it encodes PNG only — so a rescued send goes out as PNG.
// sniffImageMime runs on the RESULT, and the row's descriptor is built from the
// bytes actually sent, so nothing anywhere claims the original went out.

import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// The seam: production is [downscalePngForSend]; tests inject a fake so the
/// ladder is provable headless (dart:ui's codec is unavailable in the plain
/// test binding — the ThumbnailEncoder seam exists for the same reason).
typedef ImageDownscaler =
    Future<Uint8List?> Function(Uint8List bytes, int targetEdge);

/// Which axis [downscalePngForSend] constrains, and to what. Exactly one of the
/// two is non-null (or both null = leave at native size).
///
/// ── 🔴 2026-08-01 (card B4-1 §5.4): THIS USED TO BE `targetWidth: targetEdge`,
///    UNCONDITIONALLY, AND THAT IS AN UPSCALE ON EVERY PORTRAIT PICTURE ────────
///
/// A rung is a LONG-EDGE bound — that is what owner's 1080p-class ruling means
/// and what [kThumbMaxEdge] already means in image_thumbnail.dart. Pinning
/// `targetWidth` instead pins the SHORT edge on a portrait picture, so a
/// 1440×3120 screenshot at rung 1920 came out **1920×4160** — bigger than the
/// input, on a ladder whose entire job is to make things smaller. The next rung
/// then had to undo it.
///
/// This is the SAME bug image_thumbnail.dart was corrected for (its doc comment
/// spells out 「Constraining only targetWidth leaves a portrait screenshot at
/// 256-wide × full height — nearly the original」), and the old code here even
/// said so out loud — 「portrait targetWidth overshoots the long edge —
/// measurement absorbs all of it」 — i.e. it was KNOWN and waved through because
/// the ladder measures every rung. Measurement caught the size; it could not
/// catch the wasted decode of a 1920×4160 RGBA buffer (≈32 MB) at the exact
/// moment the photo picker has just backgrounded the app (RV-60).
///
/// Pure on purpose: dart:ui's codec is unavailable in the plain test binding, so
/// the axis choice is the only part of [downscalePngForSend] that can be pinned
/// headless — and it is the part that was wrong.
@visibleForTesting
({int? targetWidth, int? targetHeight}) downscaleTargetAxis(
  int srcWidth,
  int srcHeight,
  int targetEdge,
) {
  if (srcWidth >= srcHeight) {
    // Landscape / square: width IS the long edge.
    return (
      targetWidth: srcWidth > targetEdge ? targetEdge : null,
      targetHeight: null,
    );
  }
  // Portrait: height is the long edge. Never upscale a picture that already fits.
  return (
    targetWidth: null,
    targetHeight: srcHeight > targetEdge ? targetEdge : null,
  );
}

/// Decode → scale so the LONGEST edge is at most [targetEdge] (aspect
/// preserved) → re-encode PNG. Returns null when the bytes cannot be decoded or
/// encoded — the caller treats that rung as unusable and keeps stepping.
Future<Uint8List?> downscalePngForSend(Uint8List bytes, int targetEdge) async {
  try {
    // Dimensions come from the ENCODED header, never from a probe decode — the
    // same reason image_thumbnail.dart reads them this way: a native-size decode
    // right after the picker backgrounded us is the allocation most likely to be
    // refused. ImageDescriptor reads width/height without rasterising.
    final int srcWidth;
    final int srcHeight;
    final ui.ImmutableBuffer buffer = await ui.ImmutableBuffer.fromUint8List(
      bytes,
    );
    final ui.ImageDescriptor desc = await ui.ImageDescriptor.encoded(buffer);
    try {
      srcWidth = desc.width;
      srcHeight = desc.height;
    } finally {
      // Both halves, descriptor first: the descriptor reads through the buffer.
      desc.dispose();
      buffer.dispose();
    }
    final ({int? targetWidth, int? targetHeight}) axis = downscaleTargetAxis(
      srcWidth,
      srcHeight,
      targetEdge,
    );
    final ui.Codec codec = await ui.instantiateImageCodec(
      bytes,
      targetWidth: axis.targetWidth,
      targetHeight: axis.targetHeight,
    );
    final ui.FrameInfo frame = await codec.getNextFrame();
    final ByteData? png = await frame.image.toByteData(
      format: ui.ImageByteFormat.png,
    );
    frame.image.dispose();
    codec.dispose();
    return png?.buffer.asUint8List();
  } on Object catch (e) {
    debugPrint('[flowmic.image] downscale($targetEdge) failed: $e');
    return null;
  }
}

/// The rungs. 1920 first: when the plugin's own resize DID work, the first rung
/// reproduces the owner's 1080p-class ruling and usually already fits. The tail
/// exists because a PNG re-encode of a detailed photo can stay heavy — each
/// rung is measured, never assumed.
const List<int> kDownscaleLadder = <int>[1920, 1440, 1080, 800, 600];

/// Exact base64 length of [byteLength] raw bytes, computed without paying for
/// an encode at every rung.
int b64LengthOf(int byteLength) => ((byteLength + 2) ~/ 3) * 4;

/// Walk the ladder until a rung's output fits [budget] as base64. Returns null
/// when no rung fits — the caller's loud tooLarge refusal then still happens,
/// with the real numbers in it.
Future<Uint8List?> downscaleToBudget(
  Uint8List bytes, {
  required int budget,
  ImageDownscaler downscaler = downscalePngForSend,
}) async {
  for (final int edge in kDownscaleLadder) {
    final Uint8List? candidate = await downscaler(bytes, edge);
    if (candidate == null || candidate.isEmpty) continue;
    if (b64LengthOf(candidate.length) <= budget) return candidate;
  }
  return null;
}
