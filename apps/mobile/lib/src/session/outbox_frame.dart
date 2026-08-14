// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request, F-2350 image fields)
//   apps/mobile/lib/src/signaling/wire_payloads.dart (InjectRequestPayload —
//     the constructor whose assert this file exists to satisfy)
//   CLAUDE.md red line: never cross-wire IDs / no silent failure (banned in both directions)
//
// ── ONE BUILDER FOR 「一条排队的投递长成什么帧」("what frame a queued delivery
// turns into") ──────────────────────────────
//
// WHY THIS IS ITS OWN FILE. The builder used to live inside `outboxSend`, which
// is a `part of chat_controller.dart` and takes a ChatController. That made the
// frame unbuildable — and therefore un-assertable — by anything that is not the
// whole controller: the queue's own suite could only ever check what the queue
// HANDED the host, never what actually went on the wire. G-6 is exactly the bug
// that lives in the gap between those two questions (the queue handed the bytes
// over correctly; the host dropped them), and a suite that cannot ask the second
// one is a suite that could not have caught it.
//
// 🔴 EVERY IDENTITY COMES FROM THE ITEM, never from 「现在是什么」("what things
// are right now"): `request_id`
// (minted once at enqueue), `created_at` (the instant the user spoke) and `mode`
// (the row's own). The ONE value from the live world is [targetPcId], which the
// queue resolved by verifying the connection against the item's frozen machine —
// see outbox_destination.dart for why that is a verification and not a lookup.

import 'dart:convert';
import 'dart:typed_data';

import '../signaling/wire_payloads.dart';
import 'outbox_item.dart';

/// Why a queued item could not be turned into a frame at all.
///
/// A sum type rather than a null, for the same reason `OutboxAddress` is one:
/// 「建不出来」("could not be built") and 「建出来了但是空的」("was built but is
/// empty") must not share a value.
enum OutboxFrameRefusal {
  /// An image item arrived without its bytes. Structurally impossible when the
  /// queue is doing its job (it settles such an item terminally before it ever
  /// reaches a send), so this firing means the bug is upstream.
  imageBytesMissing,

  /// An image item arrived without `image_mime` — the other half of the pairing.
  imageMimeMissing,
}

/// Build the `inject:request` for one queued delivery, or refuse to.
///
/// 🔴 WHY REFUSING IS THE WHOLE POINT (G-6). `source:'image'` and
/// `image_b64`/`image_mime` are bound to each other in BOTH directions — by
/// `InjectRequestSchema`'s superRefine on the server, and by
/// [InjectRequestPayload]'s own constructor assert on the phone. A frame that
/// breaks the pairing is not 「少了一个字段」("missing a field"): in debug the
/// assert kills the app,
/// and in release the server answers `INJECT_FRAME_INVALID`, which
/// [isTerminalRefusalCode] treats as TERMINAL — the item is settled `refused`
/// and never retried. One drain, and the user's picture is gone for good.
///
/// So this returns null rather than building a frame it knows is invalid, and
/// the caller leaves the item `queued` — i.e. the picture survives to be
/// delivered by a build in which the upstream bug is fixed.
///
/// [entryCaption] is RV-68's image-row words, read off the row that produced
/// them and passed through here untouched; this function never invents one.
/// [origin] is 🔴 L8's stamp — live speech vs. automatic backfill (owner
/// 2026-08-02). It is PUSHED
/// in rather than computed here, and deliberately: 「这一帧算不算现场」("whether
/// this frame counts as live") depends on
/// WHEN the drain is putting it on the wire and on whether the user pressed
/// something, and neither is a property of the item. The queue decides it once, in
/// `DeliveryOutbox._attempt`, from the item's frozen `created_at` and the attempt's
/// own instant — see outbox_inject_origin.dart for the whole rule.
InjectRequestPayload? buildOutboxInjectFrame({
  required OutboxItem item,
  required String targetPcId,
  required InjectOrigin origin,
  Uint8List? imageBytes,
  String? entryCaption,
  void Function(OutboxFrameRefusal reason)? onRefused,
}) {
  final bool isImage = item.kind == OutboxPayloadKind.image;
  final String? mime = item.imageMime;
  if (isImage && (imageBytes == null || imageBytes.isEmpty)) {
    onRefused?.call(OutboxFrameRefusal.imageBytesMissing);
    return null;
  }
  if (isImage && (mime == null || mime.isEmpty)) {
    onRefused?.call(OutboxFrameRefusal.imageMimeMissing);
    return null;
  }
  return InjectRequestPayload(
    text: item.text,
    source: injectSourceFromWire(item.source),
    // 🔴 L8. The queue's judgement, passed straight through — this builder never
    // re-derives it. A drain that carries the sentence the user just pressed ➤ on
    // AND three items from last night's outage stamps them differently, in one
    // pass, which is only possible because the answer is per-ITEM and not per-drain.
    injectOrigin: origin,
    requestId: item.requestId,
    // 🔴 The WIRE key, not the settle anchor. Null ⇒ `toJson` omits the field
    // entirely, which is what a delivery covering rows it did not build must
    // send: one id on a frame covering N rows makes the PC write that row's
    // truth over all N (see OutboxItem.entryId's correction block).
    entryId: item.wireEntryId,
    mode: flowModeFromWire(item.mode),
    // Canonical base64 — exactly what image_payload.dart produces (no `data:`
    // prefix, no newlines: `base64Encode`'s own output form). The wire BUDGET
    // was already proven at enqueue, on these same bytes.
    imageB64: isImage ? base64Encode(imageBytes!) : null,
    imageMime: isImage ? mime : null,
    createdAt: item.createdAt,
    sourceText: item.sourceText,
    entryType: item.entryType,
    thumbB64: item.thumbB64,
    deviceLabel: item.deviceLabel,
    durationMs: item.durationMs,
    targetPcId: targetPcId,
    // Bound by the schema's superRefine to `entry_type:'image'`, so it may only
    // ride an image frame. Empty is normalised to absent by the caller: the
    // field is `NonEmpty`, and an empty string is not 「没有说明」("no caption") but a frame
    // the server rejects.
    entryCaption: isImage ? entryCaption : null,
  );
}

/// Wire literal → enum, for a queued item being re-hydrated off disk.
///
/// An UNRECOGNISED value falls back to `manual`, which is the honest reading:
/// the item was enqueued by an explicit delivery, and `manual` is the source
/// that claims the least (it never enters the desktop's INJ-1 byte window and
/// carries no image obligations). It cannot silently become `image` — that
/// pairing is asserted by InjectRequestPayload's constructor.
InjectSource injectSourceFromWire(String s) {
  for (final InjectSource v in InjectSource.values) {
    if (v.name == s) return v;
  }
  return InjectSource.manual;
}

/// Wire literal → [FlowMode]. Red line 「三模式锁定，永无第四模式」("the three
/// modes are locked, there is never a fourth"): the enum has
/// exactly three members, so a fourth cannot be constructed here. An
/// unreadable value falls back to `realtime` — the mode that applies no
/// transform, i.e. the one that cannot misrepresent what was said.
FlowMode flowModeFromWire(String s) {
  for (final FlowMode v in FlowMode.values) {
    if (v.name == s) return v;
  }
  return FlowMode.realtime;
}
