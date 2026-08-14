package app.flowmic.android

import androidx.core.content.FileProvider

/**
 * W8-5 — one FileProvider subclass per authority. Both classes are empty on
 * purpose; the only thing that matters is that they are DIFFERENT classes.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. Two `<provider>` entries may not share one
 * `android:name`, even when their authorities differ. `ActivityThread` caches
 * provider instances by class name, so the second authority reuses the instance
 * created for the first one — and `ContentProvider.mAuthority` was already fixed
 * to the first authority in `attachInfo`. Every incoming URI is then checked in
 * `ContentProvider.validateIncomingAuthority`, which throws:
 *
 *     SecurityException: The authority app.flowmic.android.update.fileprovider
 *     does not match the one of the contentProvider:
 *     app.flowmic.android.clipboard.fileprovider
 *
 * ⚠️ The message above is written with TODAY's authorities. The real one was
 * captured on 0.2.59/0.2.60, when this app's id was still the pre-migration
 * one (P0-PKG, 2026-08-12); the verbatim capture is kept where
 * records are kept — docs/strategy/2026-08-10-up2b-selfupdate-fileprovider-blocker.md
 * — rather than pinning a dead identifier into a shipping source file.
 *
 * i.e. our own provider refuses our own URI. The system installer then reports
 * "Cannot parse package … Assuming defaults" and the user reads
 * "解析软件包时出现问题" ("there was a problem parsing the package") — a message
 * that says nothing about authorities.
 *
 * ⚠️ `dumpsys package providers` lists BOTH authorities as registered, which is
 * true and answers a different question: it reports what the manifest declared
 * (PackageManager's static table), not how many instances the app process built.
 * Measured on a real tablet 2026-08-10; the trap cost one wrong root cause.
 *
 * ⚠️ These classes are named in AndroidManifest.xml and nowhere else. They are
 * never constructed by our code — grep for a caller and you will find none, and
 * that is correct here: the framework instantiates them from the manifest entry.
 * `verify/lint/android-provider-classes.mjs` is what keeps the manifest and this
 * file from drifting apart, since nothing else would notice.
 */
class ClipboardFileProvider : FileProvider()

/** See [ClipboardFileProvider] — separate class, separate authority. */
class UpdateFileProvider : FileProvider()
