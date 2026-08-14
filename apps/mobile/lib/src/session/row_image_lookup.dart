// SPEC-REF:
//   docs/decisions/2026-08-01-image-two-sizes-both-ends.md (owner, dictated
//     final ruling: "after double-tapping you should be able to preview the
//     relatively large picture... both ends have two sizes" 「双击之后能够预览
//     相对大的图……两边都有两个尺寸」)
//   docs/decisions/2026-07-31-image-resend-byte-sources.md (why there is no
//     original image on the phone)
//
// "Open the big picture" (点开大图) — a timeline row asking for ITS OWN
// picture, at the size that was actually delivered.
//
// ── WHY THIS IS NOT A METHOD ON THE QUEUE ────────────────────────────────────
//
// The bytes belong to the ROW (outbox_blob_store.dart's header states the
// ownership and why it had to be stated). Reaching them through `DeliveryOutbox`
// would tie "can this picture be viewed" to "is this delivery still in the
// queue" — two different questions, and the queue's answer is the one that is
// scheduled to disappear: owner has ruled it over-designed and opened an audit
// window to shrink it (doc 15 G-12). A drained, delivered, long-forgotten row
// must still open its picture, so the lookup goes straight to the store with
// the row's own id.
//
// ── 🔴 WHAT THE USER SEES, AND WHAT THEY DO NOT ──────────────────────────────
//
// This is the picture that WAS SENT — Size B, the same bytes that landed in the
// PC's focused window. It is NOT the album original, and that gap is owner's own
// fallback, not an omission: `image_picker_android` copies the picked file into
// a cache and throws the album Uri away (`FileUtils.getPathFromUri`), so no
// later code on this phone can get back to the original, and owner has ruled
// against a native picker rewrite ("no native rewrite — this item is closed
// here, not deferred" «不做原生改造，此条到此了结不是押后»).
//
// 📌 BUT WHEN THE USER TICKED "original image", THE TWO ARE THE SAME FILE. That
// path sends the picked bytes untouched (ImageSendController._send: the rescue
// ladder is skipped for `original`), and the queue persists exactly what the
// wire carried — so on the LAN leg Size B **is** the original, byte for byte.
// Which is why the preview must never be labelled "compressed image" (压缩图):
// on a good day it is the real thing.

import 'dart:typed_data';

import '../timeline/timeline_entry.dart';
import 'outbox_blob_store.dart';

/// The big picture for [entry], or null when this row has none on this phone.
///
/// Null is a normal answer, not a failure: a transcript row, a row from before
/// RV-93 (whose bytes were deleted on delivery by the ruling owner has since
/// revoked), or a picture whose file was removed from outside the app. The
/// caller falls back to the 256 px preview the row already carries — never to a
/// blank frame, and never to an error, because "only the small picture is
/// available" (只有小图) is a smaller picture, not a broken one.
Future<Uint8List?> rowImageBytes(
  OutboxBlobStore images,
  TimelineEntry entry,
) async {
  if (!entry.isImage) return null;
  // `clientId`, not `id`. The row id is `loc_<device>_<clientId>`; the file is
  // named by the `request_id`, and for a picture row the request id IS the
  // client id — ImageSendController mints one string and hands it to both
  // (`buildDeliveryRow(clientId: requestId)` / `enqueueImage(requestId:)`).
  // Using `id` here would look plausible and find nothing, every time.
  final String? path = await images.pathFor(entry.clientId);
  if (path == null) return null;
  return images.read(path);
}
