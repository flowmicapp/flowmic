import Flutter
import Foundation
import UIKit

/// Card CR-2 (owner 2026-08-29) — the iOS half of the screen-wake channel, the
/// mirror of `android/app/src/main/kotlin/app/flowmic/android/ScreenWake.kt`.
///
/// owner made this a go/no-go before the feature was designed: 「安卓和 iOS 持续
/// 的能够去不会息屏，这个很重要，做不到的话我们这个功能就不做了」 ("on Android
/// and iOS, being able to keep the screen from turning off — this is important;
/// if we cannot do it, we do not build this feature").
///
/// ── WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────────────
///
/// `isIdleTimerDisabled` stops the display from dimming and locking on its own.
/// It needs no permission and no entitlement, and — the part that matters for
/// the product shape — it applies only while this app is the active one. It
/// does NOT keep the app running in the background; that would be
/// `UIBackgroundModes: audio`, which is an entitlement and a review
/// conversation, and the owner's scoping of continuous recording (a meeting on
/// the table, a video on a second device) is what let us not need it.
///
/// ⇒ pressing the side button, switching apps and taking a call all still pause
/// the capture, and pausing is the right answer to each: the user chose it. The
/// only failure this removes is the one nobody chose — the screen going dark by
/// itself.
///
/// ── 🔴 THE RE-ASSERT, AND WHY IT IS NOT DEFENSIVE PROGRAMMING ───────────────
///
/// UIKit does not guarantee that a disabled idle timer survives a trip through
/// the background. A hold set once, before a phone call, can come back released
/// with nothing reporting it — and the shape of that defect is the worst kind
/// this repo knows: it works the FIRST time and fails the second, so it passes
/// every test anybody thinks to run by hand. The Dart side therefore re-asserts
/// the hold on the return-from-background edge it already owns, and this file
/// stays a plain setter so there is exactly one place that decides when.
enum ScreenWake {
  /// Must match `MethodChannelScreenWake.channel` on the Dart side.
  ///
  /// 🔴 P0-PKG: the namespace is owned by `scripts/package-ids.mjs`
  /// (`METHOD_CHANNEL_NAMESPACE` / `METHOD_CHANNELS.screenWake`). Swift cannot
  /// import it, so `verify/lint/package-id-family.mjs` reads this literal and
  /// compares — a drift between the two sides is a MissingPluginException at
  /// run time, not a build failure on either side.
  static let channel = "app.flowmic/screen_wake"

  static func register(messenger: FlutterBinaryMessenger) {
    let ch = FlutterMethodChannel(name: channel, binaryMessenger: messenger)
    ch.setMethodCallHandler { call, result in
      guard call.method == "setEnabled" else { result(FlutterMethodNotImplemented); return }
      let args = call.arguments as? [String: Any]
      let on = args?["on"] as? Bool ?? false
      // UIApplication is main-thread-only. The channel handler already runs
      // there, and asserting it costs nothing next to the cost of being wrong:
      // a UIKit write off the main thread is undefined behaviour, not an error.
      if Thread.isMainThread {
        UIApplication.shared.isIdleTimerDisabled = on
        result(true)
      } else {
        DispatchQueue.main.async {
          UIApplication.shared.isIdleTimerDisabled = on
          result(true)
        }
      }
    }
  }
}
