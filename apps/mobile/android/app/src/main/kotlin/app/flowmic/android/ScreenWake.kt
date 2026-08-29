package app.flowmic.android

import android.app.Activity
import android.view.WindowManager
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Card CR-2 (owner 2026-08-29) — keep the screen awake for the length of a
 * continuous transcription.
 *
 * owner asked for this as a go/no-go before the feature was designed: 「安卓和
 * iOS 持续的能够去不会息屏，这个很重要，做不到的话我们这个功能就不做了」 ("on
 * Android and iOS, being able to keep the screen from turning off — this is
 * important; if we cannot do it, we do not build this feature"). The answer is
 * these six lines, which is why the feature exists.
 *
 * ── WHAT THIS IS, AND THE THING IT IS NOT ───────────────────────────────────
 *
 * `FLAG_KEEP_SCREEN_ON` stops the display from timing out WHILE OUR WINDOW IS
 * VISIBLE. It needs no permission (it is NOT `WAKE_LOCK` — that is a different
 * API with a manifest entry and a store conversation), it is released by the
 * platform when the window goes away, and it does not keep the app alive.
 *
 * 🔴 THAT LIMIT IS THE DESIGN, not a shortfall. Continuous recording is scoped
 * to scenarios where the phone stays in front of the user (a meeting on the
 * table, a video playing on a second device), and the honest failure it removes
 * is the ONE that no user chose: the screen going dark by itself. Pressing the
 * power button, switching apps and taking a call all still pause the capture,
 * and pausing is the correct answer to each of them — the app already treats
 * `AppLifecycleState.paused` that way and tells the PC.
 *
 * ── WHY THE ACTIVITY AND NOT THE APPLICATION CONTEXT ────────────────────────
 *
 * Window flags belong to a window, and only the Activity has one. The three
 * sibling channels take `applicationContext` because they do context work;
 * handing this one an application context would compile and do nothing, which
 * is the failure mode this file most wants to avoid — a wake that silently is
 * not one looks identical to a wake that is.
 */
object ScreenWake {
    /** Must match `MethodChannelScreenWake.channel` on the Dart side.
     *
     *  🔴 P0-PKG: the namespace is owned by `scripts/package-ids.mjs`
     *  (`METHOD_CHANNEL_NAMESPACE` / `METHOD_CHANNELS.screenWake`). Kotlin
     *  cannot import it, so `verify/lint/package-id-family.mjs` reads this
     *  literal and compares — a drift between the two sides is not a compile
     *  error on either, it is a MissingPluginException at run time. */
    const val CHANNEL = "app.flowmic/screen_wake"

    /**
     * `setEnabled(on: Boolean)` — hold or release the flag. Idempotent on both
     * platforms: `addFlags` of a flag already set, and `clearFlags` of one that
     * is not, are both no-ops, so the Dart side never has to track whether it
     * already asked.
     *
     * Returns `true` on success. It returns rather than answering `null`
     * because the Dart side draws a face off this: the recording panel may only
     * say 「屏幕保持常亮」 ("the screen will stay on") when the platform
     * actually agreed. A promise about the screen that we did not verify is the
     * same shape as a promise about audio that nothing backs.
     */
    fun handle(activity: Activity?, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "setEnabled") { result.notImplemented(); return }
        val on = call.argument<Boolean>("on") ?: false
        // No activity means no window means nothing to set. Answer honestly
        // instead of pretending: FlutterActivity can be detached (backgrounded
        // teardown), and in that state the screen is not being held by us.
        val window = activity?.window
        if (window == null) { result.success(false); return }
        if (on) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        result.success(true)
    }
}
