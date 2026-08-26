// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §8 (first-PTT microphone permission, F-2063)
//   card U2 — see mic_permission.dart for the whole argument.
//
// The microphone's production port. The whole implementation — the plugin call,
// the MissingPluginException handling and the status MAPPING (which is policy,
// not mechanics) — moved to permission/platform_permission.dart in card CAM-1
// so the camera could reuse it instead of carrying a second copy of the same
// judgements.
//
// 🔴 This class stays, as a NAME rather than an implementation: it is what
// every composition root already asks for, and keeping it means the extraction
// changed no call site. Every DECISION still lives in mic_permission.dart
// against the closed [MicPermissionProbe] vocabulary.
import 'package:permission_handler/permission_handler.dart' as ph;

import '../permission/platform_permission.dart';
import 'mic_permission.dart';

class PlatformMicPermission extends PlatformOsPermission implements MicPermissionPort {
  const PlatformMicPermission() : super(ph.Permission.microphone);
}
