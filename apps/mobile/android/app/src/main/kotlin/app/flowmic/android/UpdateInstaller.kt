package app.flowmic.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Card UP-2b — hand an ALREADY-VERIFIED apk to the system package installer.
 *
 * This object installs nothing. Android has no silent-install path for an
 * ordinary app (that needs a platform signature or device-owner status), so the
 * best outcome here is "the system installer accepted the URI and the user is
 * now looking at its confirm dialog". The Dart side names that
 * `handedToInstaller`, never "installed" — see update_installer.dart.
 *
 * 🔴 THE HASH IS THE ONLY GATE, AND IT IS NOT ENFORCED HERE. Whatever path Dart
 * passes is handed over as-is. The verification lives in update_download.dart,
 * whose result type only exposes a File when sha256 matched. This is stated so
 * nobody later "simplifies" by calling this channel from somewhere else.
 *
 * ⚠️ Deliberately NOT described as making the update chain secure: a compromised
 * VPS can serve a malicious apk together with a matching sha256. Code signing
 * closes that, and it does not exist yet.
 *
 * Every failure path calls `result.error`, never `result.success` — a channel
 * that silently did nothing would look exactly like a successful hand-off.
 */
object UpdateInstaller {
    /** Must match `MethodChannelUpdateInstaller.channel` on the Dart side. */
    const val CHANNEL = "app.flowmic/update_installer"

    /**
     * Appended to the applicationId — matches the SECOND `<provider>` in the
     * manifest. It is a separate authority from `.clipboard.fileprovider` on
     * purpose: that provider's paths file says in so many words that widening
     * it would expose the rest of the cache to whatever app reads the
     * clipboard. Two jobs, two authorities, two paths files.
     *
     * 🔴 W8-5: that list used to stop one item short of what Android needs —
     * two CLASSES as well. Both providers named androidx.core.content.
     * FileProvider, so this authority never got its own instance and the
     * hand-off below died inside our own provider. Measured on a real tablet
     * 2026-08-10; mechanism in FlowMicFileProviders.kt.
     */
    private const val AUTHORITY_SUFFIX = ".update.fileprovider"

    /** Must match `kInstallHandedOff` / `kInstallPermissionRequired` in Dart. */
    private const val HANDED_OFF = "handed_off"
    private const val PERMISSION_REQUIRED = "permission_required"

    private const val APK_MIME = "application/vnd.android.package-archive"

    fun handle(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "installApk") {
            result.notImplemented()
            return
        }
        val path = call.argument<String>("path")
        if (path.isNullOrBlank()) {
            result.error("NO_PATH", "no apk path was passed", null)
            return
        }
        val file = File(path)
        if (!file.isFile) {
            // The verified download is gone (cleaned up, or another process
            // removed it). Saying "handed off" here would be the overclaim half
            // of the fail-loud red line.
            result.error("NO_FILE", "not a file: $path", null)
            return
        }

        // API 26+ made "install unknown apps" a PER-APP user grant. Without it
        // startActivity() opens the installer and the user is told, by the
        // system, that this app is not allowed — a dead end with no way back.
        // So: take them to the exact settings screen and SAY that is what
        // happened. This is the one failure on this path the user can fix.
        // Below API 26 there is no per-app grant (it is a single global
        // setting), so this branch does not apply and must not be faked.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            val settings = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(settings)
            } catch (e: Throwable) {
                // Some OEM builds ship without that screen. Reporting
                // PERMISSION_REQUIRED anyway would tell the user to go somewhere
                // we could not take them and that may not exist.
                result.error("NO_PERMISSION_SCREEN", e.message ?: e.javaClass.name, null)
                return
            }
            result.success(PERMISSION_REQUIRED)
            return
        }

        try {
            // Throws IllegalArgumentException when `file` is not under a root
            // declared in res/xml/flowmic_update_paths.xml — which is exactly
            // how a drift between kUpdateDownloadDirName (Dart) and that XML
            // becomes a NAMED refusal instead of a broken URI handed onward.
            val uri = FileProvider.getUriForFile(
                context,
                context.packageName + AUTHORITY_SUFFIX,
                file,
            )
            val install = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                // The installer is a different process; without this it cannot
                // read our private file and the install fails with a permission
                // denial that looks like a corrupt package.
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                // Started from the application context, not an Activity.
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(install)
            result.success(HANDED_OFF)
        } catch (e: Throwable) {
            result.error("INSTALL_FAILED", e.message ?: e.javaClass.name, null)
        }
    }
}
