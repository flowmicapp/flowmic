// SPEC-REF: apps/mobile/lib/src/session/image_send_controller.dart
//
// The image chain's VOCABULARY — why a send did not happen, how that is carried
// to the banner, and the picker seam. Split out of image_send_controller.dart
// when that file reached the 800-line source cap, on the same terms as the
// manual_delivery_host.dart split before it:
//
//   · every declaration below is byte-for-byte what it was in that file, doc
//     comments included — nothing added, removed, renamed or re-typed;
//   · image_send_controller.dart `export`s this file, so every existing
//     `import '.../image_send_controller.dart'` keeps resolving these names.
//
// Stated explicitly because a split is the easiest place to smuggle a change
// into: a reader diffing these against git history should find only a move.

import 'dart:typed_data';

import 'image_payload.dart';

/// Why an image send did not happen. Distinct from [ComposeSendFailure]
/// because the actions differ: a denied photo permission is fixed in the OS
/// settings, an over-budget picture is fixed by choosing a different one, and
/// neither is the 「未连接」("not connected") the text path talks about.
enum ImageSendFailure {
  /// The transport is down. The tile is inert for this, so it is a race guard.
  notConnected,

  /// Retained for switch exhaustiveness. The cloud path used to raise this
  /// (§6.2-6 withhold); owner 2026-07-31 made local save the answer instead,
  /// so [pickAndSend] no longer produces it.
  noPcTarget,

  /// The OS refused access to the photo library. The user must grant it — a
  /// picker that opens onto nothing and closes again is the silent failure
  /// this exists to prevent.
  permissionDenied,

  /// The picker itself failed (plugin/channel error). The raw message rides
  /// along so an unknown platform error is shown rather than swallowed.
  pickerFailed,

  /// The file was empty or unreadable.
  emptyFile,

  /// Not a PNG/JPEG/WebP. Refused by SIGNATURE, not by file name.
  unsupportedFormat,

  /// Still past the send budget after the picker's resize.
  tooLarge,

  /// The cloud leg produced a picture over [kCloudImageBytesMax] (owner
  /// 2026-08-01:「云端中继可以在手机端…增加最大不能大于 1M 的容量限制」("the cloud
  /// relay can add a cap of no more than 1M on the phone side…")).
  ///
  /// 🔴 Its sentence must never claim the cloud rejected anything — nothing on
  /// the relay checks this, and saying otherwise would be this repo's #1 red
  /// line (把没做成的说成做成了 — "saying a thing that wasn't done was done"). What
  /// is true is that THIS phone declined to
  /// send it, and that the same picture goes through over the LAN.
  ///
  /// Deliberately NOT [tooLarge] and NOT [originalTooLarge]: those two are about
  /// the wire budget, which this picture is nowhere near. This one is a policy
  /// on one channel, and its fix is 「换局域网」("switch to LAN") — a third action.
  cloudImageTooLarge,

  /// The user asked for the original image and the untouched file is past the send budget.
  ///
  /// 🔴 Deliberately NOT [tooLarge], on the same precedent as
  /// `INJECT_PC_UNSPECIFIED` vs `INJECT_PC_MISMATCH`: the two need different
  /// actions from the user. [tooLarge] says 「换一张更小的」("pick a smaller one")
  /// — the only thing left
  /// to try. This one has a one-tap fix that does not change the picture at all:
  /// untick the original-image option and the compressed version fits. Collapsing them would tell the
  /// user to go find another photo when the photo was never the problem.
  ///
  /// 🔴 And the rescue ladder MUST NOT run for it. Silently shipping a shrunken
  /// re-encode to someone who explicitly asked for the original is the mirror of
  /// 把没做成的说成做成了("saying a thing that wasn't done was done") — they get
  /// something else AND are not told.
  originalTooLarge,

  /// The socket rejected the emit — the frame never left the phone.
  wireFailed,

  /// RCA-v3: the pre-send probe found the link dead and the automatic
  /// reconnect-and-retry also failed. Nothing was sent; the picture row stays
  /// on the phone.
  linkDown,

  /// The PC could not be reached over http (LAN ingress), even after one
  /// immediate retry on a fresh connection. [detail] carries the raw error.
  pcUnreachable,

  /// The server said the room has no PC right now.
  pcOffline,

  /// The frame reached the PC's server and was relayed, but no verdict came
  /// back inside the wait window — whether it pasted is unknown, and that is
  /// exactly what the row says.
  noAnswer,

  /// The server refused the upload (auth / malformed / over cap). [detail]
  /// carries its own words — an unexplained refusal reads as a bug.
  rejected,

  /// RV-05: the SERVER held this delivery out and said it may be retried — the
  /// PC just released this phone (PAIR_RELEASED), another phone holds the
  /// capsule (PC_BUSY), or the inject table was momentarily full.
  ///
  /// Kept apart from [rejected] because the actions differ: this one is fixed by
  /// waiting (the outcome carries how long), and — the part that made it a red
  /// line — it is NOT the PC's verdict on this picture. Nothing about this
  /// delivery reached the timeline server-side, so the row must stay unsynced
  /// and reflushable.
  serverRefused,
}

/// One failed image send, as the banner needs to describe it. [detail] carries
/// the real numbers (or the platform's raw message) so the user is never told
/// merely 「失败了」("it failed").
class ImageSendOutcome {
  const ImageSendOutcome({required this.reason, this.detail, this.retryAfterMs});

  final ImageSendFailure reason;

  /// Size text for [ImageSendFailure.tooLarge], the platform message for
  /// [ImageSendFailure.pickerFailed], the server's own code for
  /// [ImageSendFailure.serverRefused], null otherwise.
  final String? detail;

  /// How long the server said to wait ([ImageSendFailure.serverRefused] only).
  /// A separate field rather than words inside [detail] so the banner can phrase
  /// the wait in each of the four languages instead of pasting a number in.
  final int? retryAfterMs;

  @override
  bool operator ==(Object other) =>
      other is ImageSendOutcome &&
      other.reason == reason &&
      other.detail == detail &&
      other.retryAfterMs == retryAfterMs;

  @override
  int get hashCode => Object.hash(reason, detail, retryAfterMs);
}

/// Why the original-image tick box is not on offer (owner 2026-08-01). Rendered IN THE
/// PLACE THE TICK BOX WOULD HAVE OCCUPIED — red line R8 says a control that changes
/// nothing is worse than none, and B3-9 set the precedent for the other half:
/// when the affordance is gone, its explanation stands where it stood.
enum ImageOriginalBlock {
  /// This delivery goes out over the relay. Fixable: join the LAN.
  cloudChannel,

  /// `/api/health` has not answered yet. NOT the same sentence: the app must
  /// not assert 「你在云端」("you're on the cloud") about a channel it could not read.
  channelUnknown,
}

/// Thrown by an [ImagePickerPort] when the OS refused photo access. A distinct
/// type (rather than a null return) because "the user said no" and "the user
/// cancelled" must not collapse into the same silence.
class ImagePickDenied implements Exception {
  const ImagePickDenied();
}

/// The photo-picking seam. Production is PlatformImagePicker
/// (platform_image_picker.dart, the only file that imports the plugin); tests
/// pass a fake, which is what keeps this whole contract provable headless.
abstract class ImagePickerPort {
  /// Pick ONE image and return its bytes, produced under [spec].
  ///
  /// The port takes the SPEC, not a policy flag: which tier a send uses is
  /// decided once in [imagePickSpecFor] (compressed / cloud-compressed /
  /// original), so neither this seam nor its production implementation has an
  /// opinion that could disagree with the controller's.
  ///
  /// Returns null when the user cancelled. Throws [ImagePickDenied] when photo
  /// access was refused; any other throw is surfaced as
  /// [ImageSendFailure.pickerFailed] with its message.
  Future<Uint8List?> pickImage(ImagePickSpec spec);
}
