// Part of image_send_controller.dart — REQ-12-09 09-J: delivering a picture the
// phone ALREADY has (a light-record (轻记录) image row the user ticked in the
// 「+」 panel).
//
// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` file-size (SRC_MAX = 800) went red at 819 when this leg landed.
// The split is the one image_send_http.dart already made in this exact file, on
// the same convention: the controller keeps a one-line delegate under the
// original name (`sendStoredImage`), the body becomes a top-level function
// taking the receiver explicitly, and the private members it uses are reached
// through `c.` — which a `part` may do because it shares the library's privacy
// scope. **No member was widened to make this compile, and none may be.**
//
// 🔴 THE ONE THING TO CHECK WHEN EDITING THIS FILE: it must keep ending in
// `c._send(...)`. Design §7-3 is a red line about ADDRESSING, not about tidiness
// — `outbox_destination.dart` guarantees 「结构上不存在一条能送到别的机器的分支」
// ("structurally, there is no branch that can deliver to a different
// machine"),
// and that guarantee is a property of the one emission path. A second
// `enqueueImage` / `emitInject` here would make it a stale true sentence with
// nothing going red.

part of 'image_send_controller.dart';

/// REQ-12-09 09-J — deliver [note]'s picture as its OWN message and its OWN row.
///
/// owner 2026-08-12: 「Images must be sendable in new line, not merging to text
/// line.」 One call = one delivery = one row. The 「+」 panel calls this once per
/// ticked picture, sequentially; N pictures are N of these, never a batch and
/// never merged into the composed text message.
///
/// 🔴 IT ADDS NO EMISSION POINT. The body ends in [ImageSendController._send],
/// the same method `pickAndSend` ends in — so the enqueue, the D10
/// row-before-emit, the `target_pc_id` stamp and the LAN-vs-relay choice are all
/// the ones that were already proven.
///
/// 🔴 IT DOES NOT TOUCH [note]. The light record keeps its own id, its own bytes
/// and its own status byte for byte (design §7-4): being quoted into a new
/// message does not change what already happened to it. What travels is a COPY
/// of the bytes under a brand-new `request_id`, and the new row is that copy's
/// row — so tapping to open the full picture (点开大图) on either of them shows
/// the same picture from its own file.
///
/// Returns null on success, else the fail-loud reason (also parked on
/// [ImageSendController.failure] for the banner), exactly like `pickAndSend`.
Future<ImageSendFailure?> imageSendStoredPicture(
  ImageSendController c,
  TimelineEntry note,
) async {
  // A second call while one is in flight is dropped rather than queued — the
  // same guard `pickAndSend` uses, and the reason the panel awaits each picture
  // before starting the next.
  if (c._sending) return null;
  // Defensive, and this is the call site [ImageSendFailure.noPcTarget]'s doc
  // says it was retained for: the panel draws no tick boxes on a cloud instance,
  // so reaching here means something upstream changed, and the honest answer is
  // a named refusal rather than a delivery to nowhere.
  if (c._host.noPcTarget) return c._raise(ImageSendFailure.noPcTarget);
  if (!c._host.canCompose) return c._raise(ImageSendFailure.notConnected);

  c._sending = true;
  // RV-97 ③ — one conclusion on screen at a time. The user asked again, so the
  // answer to 「上一次怎么样了」("how did the last one go") is about to be replaced.
  c._failure = null;
  c._failureCoveredIds = const <String>{};
  c._failureInstanceId = null;
  c._host.deliveryNotify();
  try {
    c._setProgress(const ImageSendProgress(ImageSendStage.preparing));
    // The ROW's own door (`pathFor(clientId)`), not the queue's — a light record
    // has no queue item and never had one (row_image_lookup.dart's header is the
    // argument for why that door exists).
    final Uint8List? bytes = await rowImageBytes(c._rowImages, note);
    // 🔴 NOT a should-never-happen. The panel's tick box asks the same question,
    // but it asks it when the list loads, and the file can be gone by now.
    // `emptyFile` is the honest existing code (「这张图读不出内容」 / "this
    // picture's content can't be read") and it is
    // LOUD, because a picture the user ticked and did not get is exactly the
    // 「把没做成的说成做成了」("claiming something succeeded when it didn't") half
    // of the red line.
    if (bytes == null || bytes.isEmpty) {
      return c._raise(ImageSendFailure.emptyFile);
    }
    // owner 2026-08-01 cloud 1M, checked on the REAL bytes. Repeated here rather
    // than inherited from `pickAndSend`, because these bytes never went through
    // the picker's cloud tier at all — they were compressed for a note, under
    // whatever channel that instance had.
    if (!imageOriginalAllowed(c._liveChannel()) &&
        bytes.length > kCloudImageBytesMax) {
      return c._raise(
        ImageSendFailure.cloudImageTooLarge,
        detail: formatBytes(bytes.length),
      );
    }
    // `note.thumbB64` — the preview the note was born with. Re-encoding one here
    // would let the new row show a subtly different picture from the note it
    // came from, for no gain.
    //
    // `original: false`: the user ticked a note, they did not ask for an
    // untouched file, so the rescue ladder MAY shrink an over-budget picture —
    // that is what it is for. Passing true would disable the ladder AND would be
    // claiming an original-image (原图) request nobody made.
    return await c._send(bytes, note.thumbB64, original: false);
  } finally {
    c._sending = false;
    // Identical to `pickAndSend`'s: a failure banner replaces the bar, and only
    // the socket wait survives this frame (its inject:result / watchdog clears
    // it).
    if (c._failure != null ||
        c.progress.value?.stage != ImageSendStage.waitingSocketAck) {
      c._setProgress(null);
    }
    c._host.deliveryNotify();
  }
}
