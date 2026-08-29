// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §2 (the go/no-go research), §4.G (「随会话开关，不是随页面开关」 — held for the
//     length of the SESSION, not the length of the page)
//   docs/rebuild/08-MOBILE-SPEC.md §2 (the continuous-recording block)
//   android/app/src/main/kotlin/app/flowmic/android/ScreenWake.kt
//   ios/Runner/ScreenWake.swift
//   scripts/package-ids.mjs METHOD_CHANNELS.screenWake (the wire name's owner)
//
// ── KEEPING THE SCREEN ON FOR A LONG RECORDING ──────────────────────────────
//
// owner 2026-08-29 made this the gate on the whole feature: 「安卓和 iOS 持续的
// 能够去不会息屏，这个很重要，做不到的话我们这个功能就不做了」. Both platforms
// have a permission-free API for it, which is why continuous recording exists
// and why it needs neither an Android foreground service nor an iOS
// background-audio entitlement.
//
// 🔴 WHAT IT SOLVES IS NARROWER THAN "the recording keeps running", and the
// narrowness is the design. Backgrounding this app already pauses capture
// honestly (`ui/app_lifecycle_bridge.dart` — only `paused` counts, and it emits
// `audio:pause` so the PC collapses its capsule). Every route into that state
// is a USER ACTION — the side/power button, switching apps, taking a call — and
// pausing is the right answer to each. The screen timing out on its own is the
// ONE route nobody chose, and it is the only one this file removes.
//
// ── 🔴 WHY A HOLDER OBJECT AND NOT TWO FUNCTIONS ────────────────────────────
//
// The failure mode of a wake lock is that somebody forgets to release it, and
// the punishment is silent: no exception, no log, no red test — just a phone
// that never sleeps for the rest of the day. A bare `enable()/disable()` pair
// makes that failure one missed early-return away on any of the five paths a
// continuous recording can end (stop button, tier cap, quota, link death, page
// disposal).
//
// So the state lives in ONE object with an idempotent [release], the session
// owns it for exactly its own lifetime, and `screen_wake_test.dart` walks every
// termination path and asserts the platform was told to let go. The test is the
// mechanism; this comment is only its reasoning.
//
// ── 🔴 `isHeld` IS AN OBSERVATION, NOT AN INTENTION ─────────────────────────
//
// The recording panel shows 「屏幕保持常亮」 ("the screen will stay on"), which
// is a claim about the device. It may only be drawn when the platform actually
// agreed, so [isHeld] flips on the PLATFORM'S answer and never on our request.
// An older host, a detached Activity or a missing channel all degrade to「not
// held」— the recording continues (a wake is a convenience, not a precondition)
// and the face simply is not shown. Same rule as the link-loss retention copy:
// the sentence about the device is only said when the device did the thing.

import 'dart:async';

import 'package:flutter/services.dart';

import '../diag/diag_log.dart' show diag;

/// The platform seam. Production is [MethodChannelScreenWake]; tests pass a
/// fake and never touch a channel.
abstract interface class ScreenWakePort {
  /// Ask the platform to hold ([on] true) or release the screen.
  ///
  /// Returns whether the platform DID it. Implementations must not throw: a
  /// screen that will not stay awake is a degraded convenience, and turning it
  /// into an exception would put a recording at the mercy of a window flag.
  Future<bool> setEnabled(bool on);
}

/// The production port. Idempotent on both platforms (`addFlags` of a flag
/// already set and `clearFlags` of one that is not are both no-ops), so this
/// layer does not have to remember what it last asked for.
class MethodChannelScreenWake implements ScreenWakePort {
  const MethodChannelScreenWake();

  /// 🔴 P0-PKG: mirrored by hand in Kotlin and Swift, and compared across all
  /// three by `verify/lint/package-id-family.mjs`. The wire name's owner is
  /// `scripts/package-ids.mjs`; Dart cannot import it either.
  static const MethodChannel channel = MethodChannel('app.flowmic/screen_wake');

  @override
  Future<bool> setEnabled(bool on) async {
    try {
      final bool? ok = await channel.invokeMethod<bool>('setEnabled', <String, Object?>{'on': on});
      return ok ?? false;
    } on Object catch (e) {
      // MissingPluginException on a host that predates the channel, and
      // PlatformException for anything the native side refused. Both mean the
      // same thing to this layer — the screen is not being held by us — and
      // neither may reach the caller: nothing about a recording should end
      // because a display flag did not take.
      diag('screen_wake.failed', <String, Object?>{'on': on, 'error': e.toString()});
      return false;
    }
  }
}

/// One recording's claim on the screen.
///
/// Create it when a continuous recording starts, [release] it on every path
/// that ends one. Both verbs are idempotent, so a path that releases twice — or
/// a `dispose` that runs after an explicit stop — costs nothing.
class ScreenWakeHold {
  ScreenWakeHold({ScreenWakePort port = const MethodChannelScreenWake()}) : _port = port;

  final ScreenWakePort _port;
  bool _held = false;

  /// Whether the PLATFORM is holding the screen right now.
  ///
  /// 🔴 Read this before drawing any 「screen stays on」 face. It is false when
  /// we asked and were refused, which is exactly the case where the face would
  /// be a lie.
  bool get isHeld => _held;

  /// Hold the screen. Safe to call when already held.
  Future<void> hold() async {
    if (_held) return;
    _held = await _port.setEnabled(true);
    diag('screen_wake.hold', <String, Object?>{'held': _held});
  }

  /// Let go. Safe to call when not held, and safe to call twice.
  ///
  /// 🔴 `_held` is cleared even if the platform answers false. The flag means
  /// 「we are holding it」, and after a release attempt we are not — whether the
  /// call succeeded or the window had already gone away. Keeping it true on a
  /// failed release would make the next [hold] a no-op, which is the one way
  /// this class could strand a real hold.
  Future<void> release() async {
    if (!_held) return;
    _held = false;
    final bool ok = await _port.setEnabled(false);
    diag('screen_wake.release', <String, Object?>{'platform_ok': ok});
  }

  /// Re-apply the hold after a trip through the background.
  ///
  /// 🔴 NOT DEFENSIVE PROGRAMMING — see `ios/Runner/ScreenWake.swift`. UIKit
  /// does not guarantee that a disabled idle timer survives backgrounding, and
  /// a hold that quietly lapses produces the worst defect shape this repo
  /// knows: correct the first time, wrong the second, invisible to any test
  /// somebody runs by hand once.
  ///
  /// A no-op when we are not holding, so the lifecycle edge can call it
  /// unconditionally and never has to know what the session is doing.
  Future<void> reassertAfterForeground() async {
    if (!_held) return;
    final bool ok = await _port.setEnabled(true);
    // If the platform now refuses, we are honestly no longer holding it — the
    // face goes away rather than outliving the fact it describes.
    _held = ok;
    diag('screen_wake.reassert', <String, Object?>{'held': _held});
  }
}
