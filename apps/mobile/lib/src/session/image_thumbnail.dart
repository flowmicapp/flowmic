// SPEC-REF:
//   packages/protocol/src/protocol-schemas-sync.ts (HistoryItemSchema.thumb_b64
//     — bounded inline thumbnail, longest edge 256 px, base64 without prefix)
//   docs/rebuild/05-DATA-MODEL.md §1 (the timeline is the product's 本体
//     / "ontology / the thing itself")
//
// owner 2026-07-27:「PC和手机端包括后面的WEB端都要能查看这个截图的缩略图」("the
// PC and phone side, and the WEB side that comes later, must all be able to
// view this screenshot's thumbnail").
//
// A picture row used to sync as an ordinary row whose text was its own
// descriptor — 「🖼 PNG · 78 KB」 — so every surface showed a sentence where a
// picture had been. The row now carries a thumbnail.
//
// A THUMBNAIL, not the original, and the reasoning is the ruling: the timeline
// is the product's 本体("the thing itself") and a row you cannot recognise is
// worthless, but shipping
// the full picture on every history:list would turn a sync into a file transfer.
// 256 px on the longest edge is enough to recognise a screenshot at a glance and
// small enough that a hundred rows stay a list.
//
// Zero new dependencies: dart:ui already decodes, scales (one axis → aspect
// preserved) and re-encodes to PNG. The generation is best-effort — a picture we
// cannot thumbnail still sends, it just has no preview. Losing the DELIVERY
// because a preview failed would be the wrong trade entirely.

import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// Longest edge of the generated thumbnail, in pixels.
const int kThumbMaxEdge = 256;

/// Hard ceiling on the encoded base64, mirroring HistoryItemSchema's `.max()`.
/// A thumbnail over this is DROPPED rather than sent: the boundary would reject
/// the whole row, and a rejected row loses the delivery record too.
const int kThumbB64Max = 200_000;

/// The seam: tests supply a fake so no test needs a real image codec.
typedef ThumbnailEncoder = Future<String?> Function(Uint8List bytes);

/// Decode → scale so the LONGEST edge is ≤ [kThumbMaxEdge] → re-encode PNG →
/// base64.
///
/// Protocol + SPEC pin longest-edge 256 px. Constraining only [targetWidth]
/// leaves a portrait screenshot at 256-wide × full height — nearly the original
/// — which is what blew owner-measured thumb_b64 to ~126K chars. dart:ui's
/// codec scales proportionally when only one axis is set, so we pick the long
/// axis (width if landscape/square, height if portrait) and leave the other
/// unset. Images already within the bound are left at native size (no upscale).
///
/// Returns null when the bytes cannot be decoded, the codec yields nothing, or
/// the result would exceed [kThumbB64Max]. Every one of those is "no preview",
/// never "no send".
Future<String?> encodeThumbnail(Uint8List bytes) async {
  if (bytes.isEmpty) return null;
  try {
    // Dimensions come from the ENCODED header, never from a decode: a probe
    // decode would be at native size (a 12 MP screenshot ≈ 48 MB of RGBA) and
    // this runs right after the photo picker backgrounded us — the exact moment
    // this handset is least willing to hand out memory. ImageDescriptor reads
    // width/height without rasterising, so the only decode is the scaled one.
    final ui.ImmutableBuffer buffer = await ui.ImmutableBuffer.fromUint8List(
      bytes,
    );
    final int srcW;
    final int srcH;
    final ui.ImageDescriptor desc = await ui.ImageDescriptor.encoded(buffer);
    try {
      srcW = desc.width;
      srcH = desc.height;
    } finally {
      // Both halves, descriptor first: the descriptor reads through the buffer.
      // A throw here degrades to 「no preview」 via the catch below — it must
      // never cost the DELIVERY (same trade as the file header states).
      desc.dispose();
      buffer.dispose();
    }

    int? targetWidth;
    int? targetHeight;
    if (srcW >= srcH) {
      if (srcW > kThumbMaxEdge) targetWidth = kThumbMaxEdge;
    } else {
      if (srcH > kThumbMaxEdge) targetHeight = kThumbMaxEdge;
    }

    final ui.Codec codec = await ui.instantiateImageCodec(
      bytes,
      targetWidth: targetWidth,
      targetHeight: targetHeight,
    );
    final ui.FrameInfo frame = await codec.getNextFrame();
    final ByteData? png = await frame.image.toByteData(
      format: ui.ImageByteFormat.png,
    );
    frame.image.dispose();
    codec.dispose();
    if (png == null) return null;
    final String b64 = base64Encode(png.buffer.asUint8List());
    if (b64.length > kThumbB64Max) {
      debugPrint(
        '[flowmic.image] thumbnail ${b64.length}B over cap — sent without preview',
      );
      return null;
    }
    return b64;
  } on Object catch (e) {
    // A codec that refuses these bytes is not a reason to lose the picture.
    debugPrint('[flowmic.image] thumbnail failed: $e');
    return null;
  }
}

// ── decode cache (owner 2026-07-27:「页面会疯狂闪烁」/ "the page flickers like
// mad") ────────────────────────
//
// `Image.memory(base64Decode(row.thumbB64))` looks harmless and is not.
// MemoryImage's identity is its `bytes` object, compared by REFERENCE — so a
// fresh Uint8List on every build is a different ImageProvider every time, and
// Flutter answers by evicting the decoded frame and decoding again. The chat
// page rebuilds on every stt:interim, i.e. several times a second while you are
// speaking, so a picture row in view re-decoded continuously: the 「疯狂闪烁」
// ("flickering like mad").
//
// The fix is to return the SAME Uint8List instance for the same base64, which
// makes MemoryImage equal to its predecessor and the re-decode never happens.
// (`gaplessPlayback` at the call site is the belt to this brace: it holds the
// last frame if a reload ever does occur, so a flash cannot come back silently
// through some other path.)

/// How many decoded previews to keep. Each is ≤200 KB by schema, so 32 is a
/// few MB worst case, and a timeline shows far fewer than that at once. Bounded
/// on purpose: an unbounded cache keyed by user content is a slow leak.
const int kThumbCacheMax = 32;

/// Insertion-ordered so the OLDEST entry is the one evicted (Dart Maps preserve
/// insertion order, which is all an LRU-by-age needs here).
///
/// A null value means "known absent" (undecodable / empty). Failures are cached
/// too — otherwise a corrupt row re-decodes (and re-logs) on every frame.
final Map<String, Uint8List?> _thumbCache = <String, Uint8List?>{};

/// Decode a stored thumbnail ONCE and keep handing back the same bytes.
///
/// Returns null when there is no preview or the stored base64 will not decode —
/// the caller renders its descriptor instead, exactly as it does for a row that
/// never had one. Failures are cached as absent too, so a corrupt row does not
/// re-attempt (and re-log) on every frame.
Uint8List? decodedThumbnail(String? b64) {
  if (b64 == null || b64.isEmpty) return null;
  // containsKey, not `hit != null`: a cached null is a real answer (absent).
  if (_thumbCache.containsKey(b64)) return _thumbCache[b64];
  final Uint8List bytes;
  try {
    bytes = base64Decode(b64);
  } on FormatException {
    _cacheThumb(b64, null);
    return null;
  }
  if (bytes.isEmpty) {
    _cacheThumb(b64, null);
    return null;
  }
  _cacheThumb(b64, bytes);
  return bytes;
}

void _cacheThumb(String key, Uint8List? value) {
  if (_thumbCache.length >= kThumbCacheMax) {
    _thumbCache.remove(_thumbCache.keys.first);
  }
  _thumbCache[key] = value;
}

/// Test seam: whether [b64] is already in the cache (including absent/null).
@visibleForTesting
bool thumbnailCacheContains(String b64) => _thumbCache.containsKey(b64);

/// Test seam: drop everything (no production caller — the cache is bounded and
/// process-lifetime by design).
@visibleForTesting
void clearThumbnailCache() => _thumbCache.clear();
