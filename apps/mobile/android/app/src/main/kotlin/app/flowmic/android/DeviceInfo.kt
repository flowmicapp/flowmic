package app.flowmic.android

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * owner 2026-07-27:「获取手机型号再结合唯一码来作为名称」("get the phone model and
 * combine it with a unique code to use as the name").
 *
 * Returns the raw parts and NOTHING else — every naming decision (brand
 * de-duplication, cleaning, capping, hashing) lives in Dart's device_label.dart
 * so the rules are unit-tested without a handset. This file is the thin edge.
 *
 * ANDROID_ID is a per-app-signing-key, per-device value that survives app
 * reinstalls, which is exactly the stability the name needs — the old
 * pairing-uuid suffix changed on every re-pair. It is a real identifier, so it
 * is NOT sent anywhere: Dart hashes it to 16 bits before it reaches the wire.
 * getString() is deprecated-adjacent for ad tracking, not for this; the lint is
 * suppressed with that reasoning rather than silenced.
 */
object DeviceInfo {
    /**
     * Must match `MethodChannelDeviceInfo.channel` on the Dart side.
     *
     * 🔴 P0-PKG: the namespace is owned by `scripts/package-ids.mjs`
     * (`METHOD_CHANNEL_NAMESPACE`). Kotlin cannot import it, so
     * `verify/lint/package-id-family.mjs` reads this literal and compares.
     * A one-sided edit does not degrade the feature — `invokeMethod` raises
     * MissingPluginException and this one runs at app start.
     */
    const val CHANNEL = "app.flowmic/device_info"

    @SuppressLint("HardwareIds")
    fun handle(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "identity") {
            result.notImplemented()
            return
        }
        // A missing part is reported as null, never as a placeholder string —
        // Dart decides what an unknown device is called.
        val androidId = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (e: Throwable) {
            null
        }
        result.success(
            mapOf(
                "manufacturer" to Build.MANUFACTURER,
                "model" to Build.MODEL,
                "seed" to androidId,
            ),
        )
    }
}
