import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Internal release keystore (repo `.local/` is gitignored; regenerate with
// `node scripts/gen-keystore.mjs`). storeFile inside key.properties is
// repo-root-relative.
val repoRoot = rootProject.projectDir.resolve("../../..").normalize()
val keystoreProperties = Properties()
val keystorePropertiesFile = repoRoot.resolve(".local/keystore/key.properties")
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

/**
 * 08-MOBILE-SPEC §8 versionCode governance: major*1e6 + minor*1e4 + patch.
 *
 * FAILS THE BUILD on anything that is not a plain three-part version, rather
 * than falling back to 1. A fallback here would be the exact defect this
 * function exists to remove — it would produce a shippable APK whose version
 * says nothing, and nobody would notice until two builds turned out to be
 * indistinguishable to Android.
 *
 * The per-part ceilings are what the formula can encode without carrying into
 * the next field; exceeding one silently would make 0.1.10000 and 0.2.0 the
 * same number.
 */
fun versionCodeFrom(name: String?): Int {
    val v = name ?: error("versionCode: flutter.versionName is null — refusing to guess")
    val m = Regex("""^(\d+)\.(\d+)\.(\d+)$""").matchEntire(v.trim())
        ?: error("versionCode: '$v' is not major.minor.patch (08-MOBILE-SPEC §8)")
    val (major, minor, patch) = m.destructured.toList().map(String::toInt)
    require(minor < 100) { "versionCode: minor $minor overflows the *1e4 field" }
    require(patch < 10000) { "versionCode: patch $patch overflows the *1 field" }
    return major * 1_000_000 + minor * 10_000 + patch
}

android {
    // P0-PKG (2026-08-12): reverse-DNS of the product domain `flowmic.app`.
    // SSOT = scripts/package-ids.mjs (`PACKAGE_IDS.android`); Gradle cannot
    // import it, so verify/lint/package-id-family.mjs reads this literal.
    namespace = "app.flowmic.android"
    // S7 (0.3.0): pinned, not inherited from `flutter.compileSdkVersion`.
    //
    // WHY: before this change these three were `flutter.compileSdkVersion` /
    // `flutter.minSdkVersion` / `flutter.targetSdkVersion` — whatever the Flutter
    // SDK on the machine currently building defaults to. That drifts silently:
    // a Flutter upgrade (or a different machine/CI runner with a different
    // Flutter install) changes the shipped targetSdk with no diff in THIS file
    // to review, which is exactly the "human-memory-shaped hole" this card
    // exists to close — nobody remembers to re-check Play's target API
    // requirement against whatever the toolchain happens to default to today.
    //
    // VALUES CHOSEN: 36 / 24 / 36. Read from the Flutter SDK actually installed
    // on this machine — Flutter 3.41.9 (`flutter --version`), whose gradle
    // defaults live in
    // <flutter-sdk>/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt:
    //   compileSdkVersion = 36, minSdkVersion = 24, targetSdkVersion = 36
    // (measured 2026-08-04: read that file directly, not assumed). So pinning
    // to these numbers changes nothing about what gets built TODAY — it only
    // stops it from changing tomorrow without a reviewable diff.
    //
    // Google Play requires targetSdk 36 for app updates from 2026-08-31 (task
    // card S7). 36 already satisfies that, with the pin now making it a fact
    // this file states rather than a fact the currently-installed Flutter
    // version happens to imply.
    //
    // ── RE-MEASURED 2026-08-19 (store-review approval playbook, the
    // "targetSdk / AAB / 64 bit" row of its store-policy table) ──────────────
    // That row still reads "targetSdk=36, INHERITED, not pinned" and recommends
    // pinning it. THE ROW IS STALE — the pin above landed with S7. Two methods
    // were used to check, and neither of them was reading a comment:
    //   · ARTEFACT: `aapt dump badging` on the release APK this tree built
    //     reports `compileSdkVersion='36'`, `sdkVersion:'24'` (badging spells
    //     minSdk that way) and `targetSdkVersion:'36'`;
    //   · TOOLCHAIN: the Flutter SDK this tree builds with (`local.properties`
    //     `flutter.sdk`) reports 3.41.8, and its FlutterExtension.kt still
    //     defaults to 36 / 24 / 36.
    // ⚠️ The paragraph above says 3.41.9; the measured version is 3.41.8. The
    // original line is left standing because it was true where it was written
    // and the CONCLUSION it supports is unchanged — what matters is what the
    // defaults ARE, not which patch release supplied them. Recorded rather than
    // silently overwritten, because a version string in a comment is precisely
    // the kind of fact that expires without anyone noticing.
    //
    // 🔴 THE PIN IS DRILLED, NOT REMEMBERED. scripts/android-sdk-pin.test.mjs
    // (auto-discovered by `pnpm verify:scripts`, which is part of
    // `pnpm verify:delivery`) goes red if any of the three below stops being an
    // integer literal or goes back to `flutter.<x>SdkVersion`. Read that
    // drill's header before changing a number: it states plainly which question
    // it answers (this file's SOURCE) and which it does not (the bytes of the
    // built package), and it holds the artefact measurement quoted above, which
    // must be re-taken if a number here changes.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // P0-PKG (2026-08-12). 🔴 A NEW applicationId IS A NEW APP TO ANDROID:
        // it does not update over the id every build up to 0.2.61 shipped — it
        // installs BESIDE it, with its own data directory, its own signature
        // check, and its own FileProvider authorities
        // (`${applicationId}.clipboard.fileprovider` / `.update.fileprovider`
        // in AndroidManifest.xml move with it).
        //
        // 🔴 THE HONEST INSTRUCTION IS UNINSTALL-THEN-INSTALL, and the only
        // channel that can reach an affected user is the release notes — the
        // app doing the updating is the ALREADY-SHIPPED one, whose copy we
        // cannot change. The note is pre-written in CHANGELOG.md's 0.2.62
        // section, which `scripts/publish-download-center.mjs` turns into the
        // download page's 「更新说明」("update notes") and uploads as RELEASE_NOTES.md.
        // Deliberately NOT faked as an in-app 「updating…」: a new package id
        // installs a SECOND app beside the old one, and pretending otherwise
        // would be 「把没做成的事说成做成了」("claiming something got done when it did not").
        //
        // SSOT = scripts/package-ids.mjs (`PACKAGE_IDS.android`).
        applicationId = "app.flowmic.android"
        // Pinned — see the S7 comment on `compileSdk` above for why and where
        // these numbers were read from (Flutter 3.41.9 FlutterExtension.kt
        // defaults: minSdk 24, targetSdk 36; Play requires targetSdk 36 from
        // 2026-08-31).
        minSdk = 24
        targetSdk = 36
        // 08-MOBILE-SPEC §8: versionCode = major*1e6 + minor*1e4 + patch,
        // 「gradle 强校验三段式」("gradle hard-validates the three-part form"). HISTORY (fixed, kept as the why): it was
        // specified from the start of the rewrite but went unimplemented, so
        // every APK up to that point carried versionCode 1 and no two builds
        // could be told apart at the Android package level — the 13 册 (doc 13) D5
        // lesson ("cannot tell new from old by the version number") in a different field, since Android
        // keys upgrade semantics on versionCode, not on versionName.
        //
        // Derived from versionName rather than from a separate pubspec `+N`
        // suffix, so the number CANNOT drift from the version the 8-face
        // bump-version.mjs already keeps in sync. 0.1.11 → 10011, 0.2.0 → 20000
        // (monotonic across the whole 0.1.x line).
        versionCode = versionCodeFrom(flutter.versionName)
        versionName = flutter.versionName
    }

    // ── ST-1 (2026-08-19): the store channel and the direct channel are two
    // ARTIFACTS, not one artifact built twice ──────────────────────────────
    //
    // 🔴 THE FACT THAT FORCED THIS. Play's Device and Network Abuse policy
    // forbids a store-delivered app from downloading and installing an APK to
    // update itself. Our self-update needs `REQUEST_INSTALL_PACKAGES`, and that
    // is a line in a STATIC manifest — `lib/src/update/self_update_flag.dart`'s
    // header measured exactly this and wrote it down: the build-time define
    // tree-shakes the Dart half, and **the manifest line is not behind any
    // define**. So a store build made from the same source declares a
    // restricted permission we may not ask Play to accept.
    //
    // The flavour source sets are what make that impossible rather than
    // remembered: `src/direct/AndroidManifest.xml` declares the permission and
    // `src/store/` does not, so the store artifact cannot carry it by accident.
    // Nobody has to remember a flag at the right moment.
    //
    // ⚠️ TWO CONSEQUENCES, BOTH DELIBERATE:
    //   · a bare `flutter build apk --release` now FAILS ("you must specify a
    //     --flavor"). That command is the one that silently shipped 0.2.59
    //     without self-update; it is better as an error than as a build;
    //   · the output filename gains the flavour (`app-direct-release.apk`).
    //     scripts/publish.mjs looks for that name, and refuses a store artifact
    //     staged as the public download (scripts/publish-apk-gates.mjs).
    //
    // ⚠️ `applicationId` is the SAME for both on purpose: to Android these must
    // be the same app, or a user moving between channels installs a second copy
    // beside the first (the P0-PKG comment above is what that costs). What
    // genuinely diverges is the SIGNING KEY once Play App Signing is enabled —
    // that is a distribution fact we state on the download page, not something
    // an id suffix could fix.
    flavorDimensions += "channel"
    productFlavors {
        create("direct") {
            dimension = "channel"
        }
        create("store") {
            dimension = "channel"
        }
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = repoRoot.resolve(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            // 没有静默失败 ("no silent failure"): a requested release build without the internal
            // keystore is an error, not a silent fall-back to debug keys
            // (signature drift would force reinstalls on every switch). The
            // check is gated on the task request so debug builds still
            // configure on machines without the keystore.
            val wantsRelease = gradle.startParameter.taskRequests.any { req ->
                req.args.any { it.contains("Release", ignoreCase = true) }
            }
            if (!keystorePropertiesFile.exists()) {
                if (wantsRelease) {
                    throw GradleException(
                        "release keystore missing: run `node scripts/gen-keystore.mjs` " +
                            "(expected ${keystorePropertiesFile})"
                    )
                }
            } else {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

dependencies {
    // owner 2026-07-27 image copy: androidx.core.content.FileProvider, used by
    // ImageClipboard.kt. It already arrives transitively (the Flutter embedding
    // and image_picker_android both pull it), but a transitive artifact is not a
    // promise about the COMPILE classpath — declared explicitly so a plugin
    // dependency change cannot break our own source. Gradle resolves to the
    // highest requested version, so this never downgrades anyone.
    implementation("androidx.core:core-ktx:1.13.1")
}

flutter {
    source = "../.."
}
