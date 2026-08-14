package app.flowmic.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * owner 2026-07-27:「手机端的复制也只是复制文字」("copying on the phone side is
 * also just copying text").
 *
 * Flutter's `Clipboard` is text-only. Putting an IMAGE on the Android clipboard
 * requires a `content://` URI, so the bytes are written to a private cache file
 * and handed over as a FileProvider URI via [ClipData.newUri]. The system
 * clipboard service grants the pasting app read access to that URI on its own —
 * which is why the provider is `exported=false` + `grantUriPermissions=true` and
 * we do not (and must not) grant anything to a specific package here.
 *
 * Every failure path calls `result.error`, never `result.success`: the Dart side
 * falls back to a text copy AND says so. A channel that silently did nothing
 * would look exactly like a successful copy — the failure this whole feature
 * exists to remove.
 */
object ImageClipboard {
    /** Must match `MethodChannelImageClipboard.channel` on the Dart side. */
    const val CHANNEL = "app.flowmic/image_clipboard"

    /** Appended to the applicationId — matches the manifest `<provider>`. */
    private const val AUTHORITY_SUFFIX = ".clipboard.fileprovider"

    /** Must match `<cache-path path="…">` in res/xml/flowmic_clipboard_paths.xml. */
    private const val DIR = "clipboard"

    /**
     * ONE file, overwritten on every copy. The clipboard holds at most one
     * preview at a time, so a per-copy filename would leak into the cache
     * forever with nothing ever reading the older ones.
     */
    private const val FILE = "flowmic-preview.png"

    fun handle(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "copyPng") {
            result.notImplemented()
            return
        }
        val png = call.argument<ByteArray>("png")
        if (png == null || png.isEmpty()) {
            result.error("EMPTY_IMAGE", "no image bytes were passed", null)
            return
        }
        val label = call.argument<String>("label") ?: "FlowMic"
        try {
            val dir = File(context.cacheDir, DIR)
            if (!dir.exists() && !dir.mkdirs()) {
                result.error("CACHE_DIR", "could not create ${dir.absolutePath}", null)
                return
            }
            val file = File(dir, FILE)
            file.writeBytes(png)

            val uri = FileProvider.getUriForFile(
                context,
                context.packageName + AUTHORITY_SUFFIX,
                file,
            )
            // newUri asks the ContentResolver for the type; FileProvider answers
            // image/png from the .png extension, which is what makes a pasting
            // app treat this as a picture rather than a file attachment.
            val clip = ClipData.newUri(context.contentResolver, label, uri)
            val clipboard =
                context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            if (clipboard == null) {
                result.error("NO_CLIPBOARD", "clipboard service unavailable", null)
                return
            }
            clipboard.setPrimaryClip(clip)
            result.success(null)
        } catch (e: Throwable) {
            result.error("COPY_FAILED", e.message ?: e.javaClass.name, null)
        }
    }
}
