// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request.image_b64 /
//     image_mime — F-2350 additive field-add, NO new event)
//   packages/protocol/src/protocol-schemas-inject.ts (InjectImageBase64Schema:
//     max 5_500_000 + canonical base64; InjectImageMimeSchema)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md Wave 2 T-4 ① (pick image → send image)
//   CLAUDE.md red line: no silent failure — an image that cannot be sent says WHY and how
//     big it was; it is never silently truncated and never silently dropped.
//
// The pure half of the image chain: bytes → (mime, canonical base64, label).
// No Flutter, no plugin, no I/O — so every rule below is unit-provable, which
// matters because these rules are the ones that decide whether a frame the
// server will accept ever leaves the phone.

import 'dart:convert';
import 'dart:typed_data';

import 'instance_probe.dart' show ServerChannel;

/// The three mimes the protocol admits (InjectImageMimeSchema). There is no
/// fourth — an image the phone cannot name is refused rather than guessed at.
enum ImageMime {
  png('image/png', 'PNG'),
  jpeg('image/jpeg', 'JPEG'),
  webp('image/webp', 'WEBP');

  const ImageMime(this.wire, this.label);

  /// The exact `image_mime` wire literal.
  final String wire;

  /// Short display name for the timeline row's face.
  final String label;
}

/// The file suffix a queued picture's bytes are parked under on disk.
///
/// Cosmetic — nothing ever reads the extension back (the item's `image_mime` is
/// the authority, and it is what rides the wire). It exists so a developer
/// looking in the app's blob directory can tell what they are looking at, which
/// is the whole reason `OutboxBlobStore.put` takes one. Derived from the enum
/// rather than split off the mime string so a new member has to answer here.
String imageBlobExtension(ImageMime mime) => switch (mime) {
  ImageMime.png => 'png',
  ImageMime.jpeg => 'jpg',
  ImageMime.webp => 'webp',
};

/// Mirror of the protocol's hard ceiling on `image_b64`. A payload at or under
/// this passes zod; one character over is rejected at the server boundary.
///
/// It is a FIELD cap — `z.string().max(5_500_000)` applied to the `image_b64`
/// property alone (protocol-schemas-inject.ts) — and it is mirrored in two more
/// places that all have to agree: the desktop's Rust parse
/// (src-tauri/src/inject/image.rs `INJECT_IMAGE_B64_MAX`) and this constant.
/// Raising it is a PROTOCOL change (three ends + a relay deploy), which is
/// exactly why [kInjectImageB64Budget] is the number that moves instead.
const int kInjectImageB64Max = 5500000;

/// The phone's OWN send budget, deliberately below [kInjectImageB64Max].
/// Over budget is a LOUD refusal, never a silent truncation.
///
/// ── 4,000,000 → 5,200,000 (owner 2026-08-01:「本轮就把额度抬上去」 ("raise the
/// quota this round")) ────────────
///
/// ⚠️⚠️ THE REASON THAT USED TO SIT HERE WAS FALSE, AND IT IS WHY THE SLACK WAS
/// 1.5 MILLION CHARACTERS WIDE. It read: 「The slack absorbs the JSON envelope +
/// socket.io framing that ride along with the base64, so a payload this side of
/// the budget cannot be the thing that fails on the wire」. Kept as a correction
/// rather than re-typed (anti-façade ④ — a comment that argues for a design is a
/// greppable assertion, and this one was the whole justification for the number).
///
/// It is false twice over:
///   · [kInjectImageB64Max] is a **field** cap, not a frame cap. An envelope
///     cannot push `image_b64` over its own `.max()` — nothing else is counted.
///   · The framing it names is **21 bytes** (`42["inject:request",…]`), measured.
///
/// MEASURED (card B4-1, every non-image field pinned at its schema maximum and the
/// object serialised):
///
/// | riding along with the picture              | bytes   |
/// |--------------------------------------------|---------|
/// | `thumb_b64` at THUMB_B64_MAX_CHARS          | 200,014 |
/// | every other field at its cap, plus JSON     |     573 |
/// | socket.io + engine.io framing               |      21 |
/// | **total**                                   | **200,608** |
///
/// THE REAL CHAIN, tightest link first (each verified in source, not inherited):
///
///   1. `image_b64` **5,500,000** — zod field cap / desktop Rust mirror.
///      🔴 THE BINDING LINK.
///   2. whole frame **8,000,000** — socket engine `MAX_HTTP_BUFFER_BYTES`
///      (server.ts) and the LAN http ingress `MAX_INJECT_UPLOAD_BYTES`
///      (inject-routes.ts, 413 INJECT_FRAME_TOO_LARGE). At link 1's cap the
///      frame is 71.3 % of this (73.8 % on the http leg, whose body carries
///      `thumb_b64` twice) ⇒ **not binding, with 2.3 MB to spare**.
///   3. cloud relay nginx `client_max_body_size` **25m = 26,214,400** —
///      read live off the box with `nginx -T` on 2026-08-01, not from the repo
///      mirror (that file's own header says 「机器是真相，仓里是主张」 ("the machine
///      is the truth, the repo is the assertion")).
///      Not binding, and not even on the path: the phone is websocket-only
///      (socket_core.dart `'transports': ['websocket']`) and
///      `client_max_body_size` bounds HTTP request bodies, not ws frames.
///
/// ⇒ SO WHY IS THERE ANY SLACK AT ALL? One reason, and it is a real one: **the
/// phone has to be the end that refuses.** Link 1 rejecting is anonymous and
/// silent at the
/// zod boundary and a log line on the desktop; this budget rejecting is a
/// sentence with the real byte count in it. 300,000 characters (5.45 %) is
/// enough, because the string the phone measures is the same string the
/// boundary measures — `base64Encode` output is ASCII, so there is no
/// re-encoding drift to absorb, which is precisely what the old reason imagined.
///
/// AT 5,200,000: raw bytes admitted = 3,900,000; frame = 5,400,608 B (67.5 % of
/// link 2). A real 8 MP camera original measured off a device — 3,206,853 B ⇒
/// 4,275,804 b64 chars — now PASSES at 82.2 % of budget, where at 4,000,000 it
/// was refused at 106.9 %. That refusal is what owner asked to remove.
///
/// 🔴 Raising this ABOVE [kInjectImageB64Max] is not a bigger version of this
/// change — it is a protocol change plus a relay deploy. Stop and escalate.
const int kInjectImageB64Budget = 5200000;

/// Longest edge the picker is asked to produce, and the JPEG quality it
/// re-encodes at. This IS the 「压缩/尺寸约束」 ("compression/size constraint")
/// stage: the platform picker does a
/// native decode → scale → re-compress, which is why the phone needs no image
/// codec of its own (and why this card adds exactly one dependency).
///
/// owner 2026-07-27:「压缩图片放宽到 1080P 左右的尺寸，如果大于这个尺寸就压缩到
/// 此尺寸以下，如果是小于这个尺寸，就压缩 70% 左右」 ("relax the compressed image to
/// around 1080P in size; if it's larger than this size, compress it down below
/// this size; if it's smaller than this size, compress it to around 70%").
/// Both halves of that fall out
/// of these two numbers, because the picker applies them independently:
///
///   · a picture LARGER than the box is scaled to FIT it (aspect preserved), so
///     1920 as both maxWidth and maxHeight means「1080p class in either
///     orientation」 — a landscape 4000×3000 lands at 1920×1440, a portrait
///     3000×4000 at 1440×1920;
///   · a picture already inside the box is NOT scaled at all — it is only
///     re-encoded at [kImagePickQuality], which is the「小于这个尺寸就压缩」
///     ("if it's smaller than this size, compress it") half
///     (owner's original wording said 70%; the number is now 92 — see the
///     measurement block below).
///
/// ⚠️ The example dimensions in the bullet above are the 1920-era ones and are
/// kept because they still illustrate HOW the box works. The box itself is now
/// 3456, which is the whole point of the correction below: at 3456 a phone
/// screenshot is 「a picture already inside the box」 and takes the second
/// bullet, not the first.
///
/// ── 1920/85 → 3456/92, owner 2026-08-01 (card B4-1) ────────────────────────────
///
/// owner:「现在传过去的图基本看不清内容」 ("the images being sent now are basically
/// unreadable"). Three quality killers were found, all
/// inside the plugin's native path (image_picker_android 0.8.13+17,
/// ImageResizer.java, read verbatim):
///
///   1. 🔴 **The scale has no filter.** `:79` calls
///      `createScaledBitmap(bmp, w, h, /* filter = */ false)` — nearest
///      neighbour. For text this is destructive: thin strokes vanish whole.
///      **Not reachable through the plugin's API.**
///   2. 🔴 **1920 bounds the LONG edge.** `calculateTargetSize` mins each axis
///      then corrects for aspect, so a 1440×3120 portrait screenshot came out
///      **886×1920** — the text at **0.6153×** — and then ate killer 1.
///   3. 🔴 **Opaque ⇒ JPEG.** `:181` `saveAsPNG = bitmap.hasAlpha()`. owner's
///      handset confirmed on the real device: the timeline row's own face reads
///      `🖼 JPEG · …` (that face comes from [sniffImageMime]'s magic bytes, so
///      it cannot be a naming coincidence).
///
/// ⇒ **1920 → 3456 removes killers 1 and 2 together**: every phone screenshot
/// (longest edge ≤ ~3216 on the tallest handsets shipping) now falls INSIDE the
/// box, `shouldDownscale` is false, and `createScaledBitmap` degenerates to an
/// identity transform — a scale of 1.0 maps each destination pixel to exactly
/// one source pixel, so 「no filter」 stops mattering. Only a photo above 3456
/// is still scaled, and continuous-tone content tolerates it as text does not.
///
/// ⚠️⚠️ THE B3-2b MEASUREMENT BLOCK THAT USED TO SIT HERE JUSTIFIED 70 → 85,
/// AND ITS TEXT SAMPLE DID NOT GO THROUGH THE CODE PATH IT WAS MEASURING.
/// Kept as a correction rather than re-typed (anti-façade ④). It read a table of
/// 22 samples whose only text row was a **1920×1080 (landscape) screenshot,
/// 158 KB → 214 KB**. Run that through `calculateTargetSize(1920,1080,1920,
/// 1920)`: `shouldDownscaleWidth = 1920 < 1920` is false and
/// `shouldDownscaleHeight = 1920 < 1080` is false ⇒ **`shouldDownscale` is
/// false and the picture is never scaled at all.** That sample therefore
/// measured the JPEG cost ONLY, and never touched killers 1 or 2 — the two that
/// owner was actually looking at. Raising 70 → 85 changed the lightest of the
/// three, which is why owner still said 「基本看不清」 ("basically unreadable")
/// afterwards.
/// **Rule: how solid a measurement is depends on whether the mechanism that
/// produced it is the path the product actually takes.**
///
/// MEASURED (card B4-1, 2026-08-01 — same honest caveat as before: Pillow/
/// libjpeg-turbo simulating the plugin's algorithm ported line-by-line, NOT an
/// on-device run. Source images: a real 1600×2560 Android screenshot pulled off
/// a device, and a real 3264×2448 camera original):
///
/// | sample (real device screenshot, 1600×2560)      | bytes   | % of budget |
/// |-------------------------------------------------|---------|-------------|
/// | current  1200×1920 nearest + q85                 | 421 KB  |  14.1 %     |
/// | 3456  1600×2560 native  + q92                    | 763 KB  |  25.5 %     |
/// | (PNG lossless, for reference)                    |1141 KB  |  39.0 %     |
///
/// | worst case: a >3456 photo, scaled to 3456 + q92  | 2088 KB |  71.3 %     |
///
/// ⇒ 92 costs ~1.8× over 85 and the worst reachable case still leaves 28 % of
/// [kInjectImageB64Budget] free. 4096 was measured too and rejected: it leaves
/// only 6.5 %, and a 48 MP sensor is noisier than the 8 MP sample.
///
/// 🔴 **WHAT NO PARAMETER HERE CAN FIX — the next person must not go looking.**
/// Android's `Bitmap.compress(JPEG, q)` builds `SkJpegEncoder::Options` and sets
/// **only** `fQuality` (AOSP `libs/hwui/hwui/Bitmap.cpp`); the struct's
/// `fDownsample` therefore keeps its default `Downsample::k420`, and Skia ties
/// it to nothing (no 「quality ≥ 90 ⇒ 4:4:4」 branch exists). **Chroma is always
/// 4:2:0 on the JPEG branch and there is no API to change it**, so the colour
/// fringing around coloured text cannot be tuned away — it can only be avoided
/// by not being on the JPEG branch at all. Do not spend another round raising
/// [kImagePickQuality] hoping to fix coloured edges.
///
/// The original-image escape hatch (owner 2026-08-01, platform_image_picker.dart) bypasses
/// BOTH constants by omitting them; see that file for why omitting is not the
/// same as passing a large number.
const double kImagePickMaxEdge = 3456;
const int kImagePickQuality = 92;

// ── Cloud-channel image policy (owner 2026-08-01) ─────────────────────────────
//
// docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md
// owner, verbatim: 「原图选项只在本地局域网才有」("the original-image option only
// exists on the local LAN") 「云端中继只能发压缩后的图，因为要考虑
// 云端的流量成本或网速」("the cloud relay can only send compressed images, because
// cloud bandwidth cost or network speed has to be considered") 「云端中继可以在手机端和 WEB CONSOLE 端增加最大不能大于 1M
// 的容量限制」("the cloud relay can add a cap of no more than 1M on both the
// phone and the WEB CONSOLE side").
//
// 🔴 WHAT THIS IS AND IS NOT. This is the phone declining to PRODUCE an
// oversized picture on the cloud leg. It is **not** a limit the cloud enforces:
// another client, or a modified build, is not bound by any of it. The server
// half is RV-87 (next round — it needs a new error code, i.e. a protocol change
// and a relay deploy). Anywhere you are tempted to write 「云端限制了 1M」
// ("the cloud limits it to 1M"), the
// true sentence is 「手机端不再提供、也不再产生超限图片」("the phone side no longer
// offers, and no longer produces, an over-limit picture").

/// Longest edge / quality asked for when the delivery goes out over the CLOUD
/// relay. Deliberately the pre-0.2.34 production pair rather than a new number:
/// it is the one tier this repo has already measured end to end.
///
/// MEASURED (card B4-1): at 1920/q85 a real 1600×2560 Android screenshot encodes
/// to 154,841–421,480 B and a real 3264×2448 camera original to 386,489 B —
/// every one of them far under [kCloudImageBytesMax]. That is the judgement:
/// this tier makes 「under 1M」 the NATURAL outcome, so the ceiling below is a
/// guard that should essentially never fire, not a routine gate.
///
/// ⚠️ Which is exactly why the ceiling still has to be CHECKED. 「Parameters
/// that make it small」 is not a proof that it is small — B3-2b's own noise
/// upper bound at this tier was ~2 MB. Measure, then refuse by name.
const double kCloudImagePickMaxEdge = 1920;
const int kCloudImagePickQuality = 85;

/// owner:「最大不能大于 1M」("must not be larger than 1M"), resolved to 1 MiB rather than 1,000,000.
///
/// The tie-break is [formatBytes]: it is 1024-based, so 1,048,576 renders as
/// 「1.0 MB」 — the refusal sentence, the row face and this constant then all say
/// the same number. At 1,000,000 the user would be refused 「over 1 MB」 by a
/// message reading 「977 KB」. ⚠️ Flagged for owner: this is the one place the
/// word 「1M」 had to be turned into an exact integer.
const int kCloudImageBytesMax = 1048576;

/// The three plugin arguments, chosen TOGETHER.
///
/// They are one object rather than three parameters because `shouldScale` in
/// ImageResizer.java is `maxWidth != null || maxHeight != null || quality < 100`
/// — passing two of the three puts the picker back on the decode → scale →
/// re-encode path, and the bytes are then not the original. Making them
/// inseparable is what stops that from being a call-site mistake.
class ImagePickSpec {
  /// Ask the plugin to fit [maxEdge] and re-encode at [quality].
  const ImagePickSpec.compressed(this.maxEdge, this.quality);

  /// Ask for nothing ⇒ `shouldScale == false` ⇒ the picked file, byte for byte.
  const ImagePickSpec.original() : maxEdge = null, quality = null;

  final double? maxEdge;
  final int? quality;

  bool get isOriginal => maxEdge == null && quality == null;

  @override
  bool operator ==(Object other) =>
      other is ImagePickSpec &&
      other.maxEdge == maxEdge &&
      other.quality == quality;

  @override
  int get hashCode => Object.hash(maxEdge, quality);
}

/// THE one question 「can this delivery carry an original」, asked of the LIVE
/// channel and answered **fail-closed**.
///
/// `null` is 「the /api/health probe could not tell us」 — the same unknown the
/// header chip renders as ABSENT rather than guessing. An unknown channel is
/// treated as cloud here, because the cost of guessing wrong in the other
/// direction is precisely what owner ruled against (an original-image crossing the
/// relay). One expression, used by the controller AND by the panel, so the
/// control the user sees and the rule the send applies cannot disagree.
bool imageOriginalAllowed(ServerChannel? channel) =>
    channel == ServerChannel.lan;

/// THE one place that answers 「what parameters does THIS send use」.
///
/// [cloud] is 「this delivery goes out over the relay」 — decided from the live
/// channel, never from a user preference, and **fail-closed**: an unknown
/// channel counts as cloud, because offering the original image on a channel
/// we cannot prove is LAN is the exact thing owner ruled against.
///
/// [original] is honoured ONLY off the cloud leg. It is re-checked here rather
/// than trusted from the UI: the panel decides before the system picker opens,
/// and the channel can change while it is open.
ImagePickSpec imagePickSpecFor({required bool cloud, required bool original}) {
  if (cloud) {
    return const ImagePickSpec.compressed(
      kCloudImagePickMaxEdge,
      kCloudImagePickQuality,
    );
  }
  if (original) return const ImagePickSpec.original();
  return const ImagePickSpec.compressed(kImagePickMaxEdge, kImagePickQuality);
}

/// Why an image could not become a payload. Each reason reads differently
/// because each needs a different action from the user.
enum ImageRejection {
  /// The file was empty / unreadable.
  empty,

  /// The bytes match none of the three admitted signatures (HEIC, GIF, BMP, a
  /// renamed non-image…). Refused rather than sent as something it is not.
  unsupportedFormat,

  /// Even after the picker's resize the payload is past the send budget.
  tooLarge,
}

/// A validated, ready-to-emit image payload.
class ImagePayload {
  const ImagePayload({
    required this.mime,
    required this.b64,
    required this.byteLength,
  });

  final ImageMime mime;

  /// Canonical base64 — exactly what `image_b64` carries (no `data:` prefix,
  /// no newlines: Dart's `base64Encode` emits precisely this form).
  final String b64;

  /// Size of the ENCODED picture in bytes (not of the base64).
  final int byteLength;

  /// The immutable face this delivery gets on the timeline. See
  /// [imageEntryLabel] for why it is locale-neutral.
  String get label => imageEntryLabel(mime, byteLength);
}

/// The outcome of turning picked bytes into a payload: exactly one of the two
/// fields is non-null.
class ImageEncodeResult {
  const ImageEncodeResult.ok(ImagePayload this.payload)
    : rejection = null,
      b64Length = 0,
      byteLength = 0;
  const ImageEncodeResult.rejected(
    ImageRejection this.rejection, {
    this.b64Length = 0,
    this.byteLength = 0,
  }) : payload = null;

  final ImagePayload? payload;
  final ImageRejection? rejection;

  /// How long the base64 actually was, for the over-budget message. The user is
  /// told the real number rather than 「太大了」("too big").
  final int b64Length;

  /// How big the picture actually was, same reason.
  final int byteLength;
}

/// Identify a picture by its magic bytes. The picker reports a file name, not a
/// mime, and a name can lie — the signature cannot. Byte-for-byte the same
/// three checks the desktop runs (src-tauri/src/inject/image.rs), so the two
/// ends agree on what "a PNG" is.
ImageMime? sniffImageMime(List<int> bytes) {
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0D &&
      bytes[5] == 0x0A &&
      bytes[6] == 0x1A &&
      bytes[7] == 0x0A) {
    return ImageMime.png;
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xFF &&
      bytes[1] == 0xD8 &&
      bytes[2] == 0xFF) {
    return ImageMime.jpeg;
  }
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 && // R
      bytes[1] == 0x49 && // I
      bytes[2] == 0x46 && // F
      bytes[3] == 0x46 && // F
      bytes[8] == 0x57 && // W
      bytes[9] == 0x45 && // E
      bytes[10] == 0x42 && // B
      bytes[11] == 0x50) {
    return ImageMime.webp;
  }
  return null;
}

/// Turn picked bytes into a payload, or say exactly why not.
///
/// The order is deliberate: identify FIRST (so an unsupported format is named
/// as such rather than reported as a size problem), then encode, then measure
/// against the budget. Nothing here shrinks or crops the picture — the resize
/// happened in the picker, and quietly sending less than the user chose would
/// be its own kind of lie.
ImageEncodeResult encodeImagePayload(Uint8List bytes) {
  if (bytes.isEmpty) {
    return const ImageEncodeResult.rejected(ImageRejection.empty);
  }
  final ImageMime? mime = sniffImageMime(bytes);
  if (mime == null) {
    return ImageEncodeResult.rejected(
      ImageRejection.unsupportedFormat,
      byteLength: bytes.length,
    );
  }
  final String b64 = base64Encode(bytes);
  if (b64.length > kInjectImageB64Budget) {
    return ImageEncodeResult.rejected(
      ImageRejection.tooLarge,
      b64Length: b64.length,
      byteLength: bytes.length,
    );
  }
  return ImageEncodeResult.ok(
    ImagePayload(mime: mime, b64: b64, byteLength: bytes.length),
  );
}

/// The timeline face of an image delivery, e.g. `🖼 PNG · 214 KB`.
///
/// LOCALE-NEUTRAL on purpose. This string becomes the row's `source_text`,
/// which is immutable — so a translated version would be frozen at whichever
/// language happened to be selected the moment the picture was sent, and would
/// then read wrong forever after the user switches the UI language. The repo already
/// takes this route for technical faces (AppStrings.recSegments is `seg N` in
/// both languages); the emoji carries the meaning that words would have.
String imageEntryLabel(ImageMime mime, int byteLength) =>
    '🖼 ${mime.label} · ${formatBytes(byteLength)}';

/// Human byte size, e.g. `812 B` / `214 KB` / `1.2 MB`. Used in the row face
/// AND in the over-budget failure message, so the number the user is refused
/// over is the same number they see everywhere else.
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final double kb = bytes / 1024;
  if (kb < 1024) return '${kb.round()} KB';
  return '${(kb / 1024).toStringAsFixed(1)} MB';
}
