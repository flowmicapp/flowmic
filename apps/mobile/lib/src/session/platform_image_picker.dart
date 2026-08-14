// SPEC-REF:
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4 ① (dependency: image_picker, only this one added)
//   CLAUDE.md red line: no silent failures — a denied photo permission is a NAMED failure,
//     never a picker that opens onto nothing.
//
// The ONLY file in the app that imports `image_picker`. Everything else talks to
// [ImagePickerPort], which is what lets the whole image chain be tested without
// a platform channel.
//
// Resize + re-compression happen HERE, in the plugin's native path: the phone
// carries no image codec of its own, which is the whole reason this card adds
// exactly one dependency. `maxWidth`/`maxHeight`/`imageQuality` make the plugin
// decode → scale → re-encode before it ever hands us bytes, so the payload is
// already inside the send budget by construction (image_payload.dart still
// measures it and refuses loudly if it is not).
//
// ── ORIGINAL vs COMPRESSED: ONE CALL SITE, TWO ARGUMENT SETS (owner 2026-08-01) ─────────
//
// owner:「let the user decide whether to send the original image」. The
// 「original」 path is NOT a second compression
// chain and must never become one — it is the SAME `ImagePicker().pickImage`
// call with three arguments omitted. From ImageResizer.java:42 (verified
// verbatim, plugin 0.8.13+17):
//
//     boolean shouldScale = maxWidth != null || maxHeight != null
//                         || imageQuality < 100;
//     if (!shouldScale) { return imagePath; }        // ← returns the original file as-is
//
// so omitting all three makes the plugin hand back the picked file BYTE FOR
// BYTE — no decode, no scale, no re-encode. A screenshot arrives as its
// original PNG, a photo as its original JPEG.
//
// 🔴 Two functions each calling the picker would be the repo's #1 bug shape
// (one
// problem, two answers): the two would drift, and 「which argument set
// actually ran」 would have two
// answers. There is one call, and [original] chooses its arguments.
//
// PERMISSIONS. On Android 13+ image_picker uses the system Photo Picker, which
// grants access to the single chosen item and needs no runtime permission at
// all; on Android 12 and below it falls back to a document/gallery intent
// covered by the READ_EXTERNAL_STORAGE declaration in AndroidManifest.xml
// (maxSdkVersion=32). When the OS DOES refuse, the plugin raises a
// PlatformException whose code we translate into [ImagePickDenied] so the UI
// can say 「photo library access was denied」 with an actionable instruction —
// the R6-R5 lock-screen
// lesson: a capability the OS took away must be reported, not absorbed.

import 'dart:typed_data';

import 'package:flutter/services.dart' show PlatformException;
import 'package:image_picker/image_picker.dart';

import 'image_payload.dart';
import 'image_send_controller.dart';

/// PlatformException codes the plugin uses for a refused photo library.
/// `photo_access_denied` is the documented one; the others are the Android /
/// iOS variants seen in the wild. An unrecognised code is NOT swallowed — it
/// falls through to [ImageSendFailure.pickerFailed], which surfaces it verbatim.
const Set<String> kPhotoDeniedCodes = <String>{
  'photo_access_denied',
  'camera_access_denied',
  'invalid_image_permission',
};

class PlatformImagePicker implements ImagePickerPort {
  const PlatformImagePicker();

  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async {
    try {
      final XFile? file = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        // 🔴 null, not 「a very large number」. `shouldScale` tests for null; any
        // number at all — even one no picture could exceed — puts the plugin
        // back on the decode → scale → re-encode path and the bytes are no
        // longer the original. [ImagePickSpec] is what keeps the three
        // inseparable; this file carries NO policy of its own — which tier a
        // send uses is decided once, in `imagePickSpecFor`.
        maxWidth: spec.maxEdge,
        maxHeight: spec.maxEdge,
        imageQuality: spec.quality,
        // We need pixels, not EXIF. Skipping full metadata avoids asking for
        // the broader photo-library entitlement on iOS for no benefit.
        requestFullMetadata: false,
      );
      if (file == null) return null; // user cancelled
      return await file.readAsBytes();
    } on PlatformException catch (e) {
      if (kPhotoDeniedCodes.contains(e.code)) throw const ImagePickDenied();
      rethrow;
    }
  }
}
