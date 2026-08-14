// P0-PKG (G1) — THE single source of truth for this product's platform
// identifiers. One file answers 「what is this app called to the operating
// system」 for every platform we ship.
//
// SPEC-REF:
//   docs/decisions/2026-08-11-owner-bundle-id-family-app-flowmic.md   (the family)
//   docs/decisions/2026-08-12-owner-p0-app-flowmic-package-id-before-0262.md (P0)
//   docs/decisions/2026-08-12-owner-p0-pkg-deep-fix-and-anti-revert.md (anti-revert)
//   docs/strategy/2026-08-12-p0-app-flowmic-package-id-migration.md   (G1–G4)
//   verify/lint/package-id-family.mjs  (G2 — the gate that reads THIS file and
//                                       walks every surface listed below)
//
// ── WHY A FILE, WHEN FOUR STRINGS WOULD FIT IN FOUR CONFIGS ──────────────────
//
// Because they already did fit in four configs, and that is precisely how the
// repo lost them. Measured 2026-08-12 (dev-pc-a): the owner had ruled the
// family on 08-11, a Mac had been edited to `app.flowmic.ios`, the findings doc
// said so — and `git log -S 'app.flowmic.ios' -- apps/mobile` was EMPTY. The
// string existed on one machine and nowhere in the repository, so the next
// checkout/rsync/tool run restored `cloud.flowmic.*` without anybody making a
// mistake. That is the shape of 「回潮」: not a typo, but a value with no owner.
//
// 🔴 This module is only half the fix. A constant nobody is forced to agree with
// is a suggestion. The other half is `verify/lint/package-id-family.mjs`, which
// reads THIS file and then goes and looks at gradle / pbxproj / tauri.conf /
// Dart / Kotlin. Change a value here without changing the surfaces and the gate
// goes red; change a surface without changing this file and the gate goes red.
// Neither direction is allowed to be quiet.
//
// ── WHY .mjs AND NOT packages/protocol ──────────────────────────────────────
//
// These strings are NOT protocol. Nothing about them crosses the wire, and
// `packages/protocol` is consumed through a built `dist/` (CLAUDE.md records
// twice what a stale dist does to a gate). The consumers here are node scripts
// and one lint, so a plain ESM module in `scripts/` — the same placement and the
// same "scripts share config from scripts/" precedent as `bump-version.mjs`'s
// FACES table — is the honest home.
//
// ⚠️ Dart and Kotlin cannot import an .mjs. They carry hand-written mirrors, and
// the mirrors are held by machines, not by memory:
//   • the G2 gate reads the Dart and Kotlin literals and compares them here;
//   • apps/mobile/test/method_channel_namespace_mirror_test.dart reads THIS FILE
//     as text from `flutter test` (same handle as
//     restriction_reason_copy_mirror_test.dart reading a .ts).

/**
 * The shipped identifier per platform. Reverse-DNS of the product domain
 * `flowmic.app` (owner, 2026-08-11).
 *
 * 🔴 Each platform gets its OWN leaf. The alternative — one id for all four —
 * was rejected upstream: iOS and macOS bundle ids share a namespace with the
 * developer account, and a single string would make 「which build is this」
 * unanswerable from the id alone.
 */
export const PACKAGE_IDS = Object.freeze({
  ios: 'app.flowmic.ios',
  android: 'app.flowmic.android',
  macos: 'app.flowmic.mac',
  windows: 'app.flowmic.windows',
});

/**
 * The iOS unit-test target's bundle id. Named here rather than derived at the
 * two call sites, because 「the tests target」 is a surface the gate has to be
 * able to assert exactly — a suffix invented independently in the pbxproj is a
 * second answer to the same question.
 */
export const IOS_TEST_BUNDLE_ID = `${PACKAGE_IDS.ios}.RunnerTests`;

/**
 * The namespace every Flutter MethodChannel name hangs off, shared by Dart and
 * Kotlin.
 *
 * 🔴 NOT a platform id, and deliberately not `PACKAGE_IDS.android`. A channel
 * name is a private contract between two halves of the SAME process; binding it
 * to the Android application id would mean the iOS half of a future channel had
 * to answer to the word 「android」. The family root is the honest root.
 *
 * 🔴 A mismatch between the two halves is not a degraded feature — the platform
 * side is simply never reached, `invokeMethod` raises MissingPluginException,
 * and on the device-info path that lands at app start. Both sides move in ONE
 * commit; the gate refuses a tree where they disagree.
 */
export const METHOD_CHANNEL_NAMESPACE = 'app.flowmic';

/** The three channels this app defines, as full wire names. */
export const METHOD_CHANNELS = Object.freeze({
  deviceInfo: `${METHOD_CHANNEL_NAMESPACE}/device_info`,
  imageClipboard: `${METHOD_CHANNEL_NAMESPACE}/image_clipboard`,
  updateInstaller: `${METHOD_CHANNEL_NAMESPACE}/update_installer`,
});

/**
 * The Kotlin source package for the Android host code, and the directory that
 * has to match it.
 *
 * Kotlin does not require the directory to mirror the package — it compiles
 * either way — which is exactly why this is stated: a package/dir split is
 * invisible to the compiler and visible to every human reading the tree.
 */
export const ANDROID_KOTLIN_PACKAGE = PACKAGE_IDS.android;
export const ANDROID_KOTLIN_DIR = 'apps/mobile/android/app/src/main/kotlin/app/flowmic/android';

/**
 * Identifiers this product used BEFORE the migration, kept so the gate can name
 * them rather than pattern-match a whole domain.
 *
 * 🔴 These are banned on product surfaces and MUST stay readable here. The gate
 * needs the exact strings to forbid, and 「the forbidden value is written down in
 * exactly one place, next to the value that replaced it」 is the only arrangement
 * where the ban and the replacement cannot drift apart.
 *
 * ⚠️ They are NOT banned in `docs/` — a decision record that cannot say what it
 * decided against is not a record (CLAUDE.md: 文档面绝不做全局正则).
 */
export const LEGACY_PACKAGE_IDS = Object.freeze([
  'cloud.flowmic.flowmic', // Android applicationId + namespace, iOS bundle id
  'cloud.flowmic.desktop', // Tauri identifier (Windows + macOS bundles)
]);

/** The legacy MethodChannel namespace. Same reasoning as above. */
export const LEGACY_METHOD_CHANNEL_NAMESPACE = 'cloud.flowmic';

/**
 * The legacy Windows/Linux WebView2 profile directory leaf.
 *
 * Tauri v2 resolves an unset `data_directory` to `LocalData/<identifier>`
 * (tauri 2.11.5, `manager/webview.rs` → `path::app_local_data_dir`),
 * so changing the identifier MOVES the browser profile — and `localStorage`
 * lives inside it. Measured on dev-pc-a 2026-08-12:
 * `%LOCALAPPDATA%\cloud.flowmic.desktop\EBWebView` exists, 58 MB, of which
 * `Default/Local Storage` is 56 KB.
 *
 * The desktop's first-run migration (`src-tauri/src/webview_profile.rs`) needs
 * this old name forever; it is the only place in the product where a legacy id
 * is legitimate, and the gate exempts that file BY NAME for this reason.
 */
export const LEGACY_DESKTOP_WEBVIEW_DIR = 'cloud.flowmic.desktop';

/** All four target ids as a flat array (gate + scripts convenience). */
export const ALL_PACKAGE_IDS = Object.freeze(Object.values(PACKAGE_IDS));
