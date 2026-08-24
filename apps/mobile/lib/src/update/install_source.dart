// Gate ② — WHERE THIS COPY CAME FROM, asked at runtime.
//
// `self_update_flag.dart` is gate ①: a build-time define that decides whether
// this binary contains the self-install path at all. Its own header names the
// half that was never built, and calls it a debt that blocks any store build:
//
//     ② a runtime safety net — `getInstallSourceInfo()`: when the install
//     source is `com.android.vending` ⇒ unconditionally turn off the
//     self-install path, no matter what the flag says.
//     「the build flag is a human decision (can be forgotten), the runtime
//     criterion is mechanical (cannot be forgotten)」
//
// This file is ②.
//
// ── 🔴 THE DIRECTION THAT MATTERS, AND WHY THE TEST IS AN ALLOW-LIST ────────
//
// The obvious implementation is 「suppress unless the installer looks like a
// sideload」. It is the wrong way round, and gate ①'s header already warned
// about it: a sideloaded package's install source is a browser, a package
// installer, another app, or **null** — so a criterion built on recognising
// sideloads kills the feature on the ONE distribution channel it exists to
// serve, and it does so silently, on someone else's phone.
//
// So the question this file asks is narrow and positive: **is this copy known
// to have come from a store that ships its own updates?** Anything else —
// unknown installer, empty string, null, an OEM package manager, a file
// manager, our own APK handed over by another app — is NOT a store, and the
// feature stays on. Being wrong in that direction costs a redundant update
// prompt beside Play's own; being wrong in the other direction costs the
// feature for everyone who installed the way we tell people to install.
//
// ⚠️ `com.google.android.feedback` is in the set on purpose: it is the historic
// installing package for Play-delivered apps on some Android versions and still
// appears in the wild. Leaving it out would mean the store build keeps its
// self-install path exactly on the devices where the field is least modern.
//
// ── WHAT IT DOES *NOT* DO ──────────────────────────────────────────────────
//
// It does not hide the update section, and it does not reuse gate ①'s sentence.
// 「this build was made without the feature」 and 「this copy came from Play, so
// Play updates it」 are two different facts about two different packages, and
// this repo does not let one value answer two questions. The card renders the
// second one (`AppStrings.updateFromStoreNote`).
//
// ── HONESTY ABOUT WHAT IS PROVEN ───────────────────────────────────────────
//
// 🔴 The rule is enforced and unit-tested in both directions here, and it has
// NOT been observed on a real Play install — we have no Play track yet. What is
// tested is the decision, on a probe we control. Gate ①'s header refuses to
// call an unverified policy gate "secured", and that refusal stands: this file
// removes the code-shaped hole, not the need to watch the first real store
// install. The store CHANNEL's own defence is that its APK does not declare
// REQUEST_INSTALL_PACKAGES at all (android/app/src/direct/AndroidManifest.xml),
// which is a build fact and needs no runtime luck.
//
// SPEC-REF:
//   apps/mobile/lib/src/update/self_update_flag.dart (gate ①, and this debt)
//   docs/strategy/2026-08-19-store-review-approval-playbook.md §2-1
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §6

import 'package:package_info_plus/package_info_plus.dart';

/// Installer package names that mean 「a store delivered this, and the store
/// updates it」. An allow-list, never a deny-list — see this file's header.
const Set<String> kStoreInstallerPackages = <String>{
  'com.android.vending',
  'com.google.android.feedback',
};

/// Answers 「which package installed us」. Null / empty = unknown, which is NOT
/// a store.
typedef InstallerStoreProbe = Future<String?> Function();

/// The production probe: `package_info_plus` surfaces Android's
/// `getInstallSourceInfo()` as `installerStore` (9.x), so no platform channel
/// of our own is needed.
Future<String?> readInstallerStore() async {
  final PackageInfo info = await PackageInfo.fromPlatform();
  return info.installerStore;
}

/// Answers 「what is this package called」. Null / empty = we could not ask.
typedef PackageNameProbe = Future<String?> Function();

/// The production probe. Same one call `readInstallerStore` makes.
Future<String?> readPackageName() async {
  final PackageInfo info = await PackageInfo.fromPlatform();
  return info.packageName;
}

/// Where to send someone whose copy came from a store, most-direct first
/// (0.3.28, owner 2026-08-23: 「如可以在应用商店更新就尝试直转」 — "if the app store
/// can update it, try to go straight there").
///
/// 🔴 TWO CANDIDATES, NOT ONE, and the order is the whole point. `market://` is
/// the direct handoff — it opens the Play app on the listing with no browser in
/// between — but it resolves to nothing on a device with no Play Services,
/// which in this product's market is not an edge case, it is common. The
/// `https://` form is a universal link Play claims when installed and an
/// ordinary web page when it is not, so it always lands somewhere. Offering
/// only the first is a dead tap for a large share of users; offering only the
/// second sends everyone through a browser they did not need.
///
/// Empty list = we could not learn our own package name, so there is nothing
/// honest to point at. The caller then keeps the plain sentence it already had
/// rather than showing a control that goes nowhere.
///
/// ⚠️ **Unproven against a real store install, and it cannot be proven yet** —
/// this product is on no store (owner 2026-08-23). What is tested is the
/// construction, on a probe we control; the first real store install is still
/// the thing that has to be watched. Same honesty the gate ② header keeps
/// about itself.
Future<List<String>> storeListingUrls({PackageNameProbe? probe}) async {
  String? name;
  try {
    name = await (probe ?? readPackageName)();
  } catch (_) {
    return const <String>[];
  }
  final String id = (name ?? '').trim();
  if (id.isEmpty) return const <String>[];
  return <String>[
    'market://details?id=$id',
    'https://play.google.com/store/apps/details?id=$id',
  ];
}

/// True when this copy came from a store that ships its own updates ⇒ the
/// self-install path must stay shut whatever gate ① says.
///
/// A probe that throws answers 「unknown」, deliberately: an exception here is
/// our own plumbing failing, and letting it disable the feature would turn a
/// bug in this file into a silent capability loss on every phone.
Future<bool> installedFromStore({InstallerStoreProbe? probe}) async {
  String? installer;
  try {
    installer = await (probe ?? readInstallerStore)();
  } catch (_) {
    return false;
  }
  final String name = (installer ?? '').trim().toLowerCase();
  if (name.isEmpty) return false;
  return kStoreInstallerPackages.contains(name);
}
