// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §6 (the fork risk on a
//     store channel)
//   CLAUDE.md red line: no silent failures (both directions banned)
//
// ── WHAT THIS FLAG TURNS OFF, AND WHY THE DEFAULT IS 「OFF」────────────────────────────────
//
// 【secondhand, verify against the actual Play policy text before going to the
// store】Google Play's Device and Network Abuse
// policy forbids a Play-distributed app from downloading and installing an
// APK to update itself. ⇒ the store build must not contain this path at all.
//
// 🔴 **Default off, and the direction must not be reversed** (design §6 has
// already thought through the failure direction, this round does not
// overturn it):
//   · forgetting to add the define ⇒ **loses the feature**, degrades to the
//     status quo (the user keeps using the version they have);
//   · if the default were on, a Play build that forgot to add the define ⇒
//     **ships a package that violates policy**.
// One is our own loss, the other is a consequence someone else bears on our
// behalf. **The failure direction decides the default.**
//
// ── ⚠️ AN ABSENT CAPABILITY MUST BE VISIBLE, NEVER SILENT ────────────────────────────
//
// When the flag is off, the settings page **still renders that section**,
// just replaced with a plain sentence (「this version does not include in-app
// updates」). **The whole section must NOT be hidden** — a feature that
// quietly disappeared and a feature that was never built
// look identical to the user, while to us they are two different things.
//
// ── 🔴 The half this round **did NOT** do, and what it is blocking ──────────────────────
//
// Design §6 wants **two independent gates**: ① the build-time flag (this
// file),
// ② a runtime safety net — `getInstallSourceInfo()` / `getInstallerPackageName()`:
// when the install source is `com.android.vending` ⇒ unconditionally turn off
// the self-install path, no matter what the flag says.
// The reasoning is 「the build flag is a human decision (can be forgotten),
// the runtime criterion is mechanical (cannot be forgotten)」.
//
// **② was deliberately NOT built this round.** Not an oversight, because:
//   · it needs a platform call beyond `device_info_plus`, and this repo
//     currently **has no Play build at all
//     to verify it against**;
//   · design §6 itself spells out its reverse danger: a sideloaded package's
//     install source is the browser / a package installer /
//     `null`, **too strict a criterion would kill the feature on the one
//     build it exists to serve**.
//   · ⇒ **a policy gate never verified on a real device** is worse than a
//     debt written down plainly: it would give people the illusion,
//     before launch, that
//     「this has already been secured」, while whether it actually blocks
//     anything, or mis-blocks something, nobody has checked.
//
// 🔴 **So this is a debt blocking the Play build, not a nice-to-have**:
// **no store-channel APK may ship until ② lands and is verified on a real Play track.**
//
// ── 🔴 IN-PLACE CORRECTION (2026-08-19, ST-1) — ② EXISTS NOW, AND THE DEBT
// ABOVE IS PART PAID. The paragraph stays because its argument is still the
// reason ② is shaped the way it is. ─────────────────────────────────────────
//
// ② is `install_source.dart`, wired into `UpdateController.selfUpdateUsable`
// and rendered by the settings card as its own sentence. Its criterion is an
// ALLOW-LIST of store installer packages precisely because of the reverse
// danger named above: unknown / empty / null installer ⇒ the feature stays ON,
// so a sideloaded copy cannot lose it. `package_info_plus` 9.x surfaces
// `getInstallSourceInfo()` as `installerStore`, so the platform call this
// paragraph was waiting for turned out to need no plugin of our own.
//
// ⚠️ **The second half of the sentence is still owed**: 「verified on a real
// Play track」 has NOT happened — there is no track yet. What exists is a
// decision tested in both directions on a probe we control
// (`test/update_install_source_gate_test.dart`). That is the code-shaped hole
// closed, not the field observation.
//
// 🔴 And ② is no longer the FIRST line of defence, which is the bigger change
// here: the store artifact is now a separate Gradle flavour whose manifest does
// not declare `REQUEST_INSTALL_PACKAGES` at all
// (`android/app/src/store/AndroidManifest.xml`). That is a BUILD fact — it does
// not depend on a runtime probe answering correctly on someone else's phone.
// ⇒ the paragraph below (「the build-time flag doesn't reach this line」) is what
// changed: that line is no longer in the shared manifest.
//
// ── ⚠️ Another debt: this round only has 「check + notify」, no 「download +
// install」──────────────────────
//
// So the flag right now actually turns off **the entire update section** (it
// does not even issue a check). Once the download/install half
// (the second half of design §5.1) lands, this constant's **meaning will
// narrow** to 「only turns off the self-install path」,
// that day requires coming back to re-read this file's header — do not
// inherit today's reading.
//
// ── 🔴🔴 THE BUILD-TIME FLAG DOES NOT REACH THIS LINE (UP-2b, 2026-08-08, [measured]) ────────────────
//
// The sentence above, 「⇒ forgetting to add the define ⇒ **loses the
// feature**, degrades to the status quo」, **holds only for the Dart code**,
// and UP-2b is the first time it stops covering every surface. **This is not
// a deduction, it is a line this round actually added:**
//
//     android/app/src/main/AndroidManifest.xml:
//       <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
//
// 🔴 **It is a line in the static manifest, with no define standing in front of it.**
// `--dart-define=FLOWMIC_SELF_UPDATE=0` makes AOT tree-shake out the
// download/install half
// (that part still holds), but **the compiled APK declares this permission
// regardless** — including some future
// store build. And what Play reviews is **the declaration**, not 「whether
// that code path is ever actually reached」.
//
// ⇒ **The failure direction is reversed on this surface**: the Dart half is
// 「forget it ⇒ our own loss」,
// the manifest half is 「do nothing ⇒ someone else bears the consequence on
// our behalf」. **The same flag, two opposite directions.**
// The reasoning above is not wrong, what is wrong is **treating it as a
// conclusion about the whole build**.
//
// ⚠️ **This round deliberately does not invent a Gradle flavor /
// manifestPlaceholder to hide this line.**
// The reason is verbatim the same source as debt ② above: this repo
// **has no Play build at all to verify it against**,
// and an unverified-on-real-device channel fork is worse than a debt written
// down plainly — it would give people
// the illusion that 「this has already been secured」, while whether the fork
// was even done correctly, nobody has checked.
// **⇒ Record the debt, do not paper over it.**
//
// 🔴 **So it folds into debt ② rather than opening a new one**: the sentence
// above,
// 「**no store-channel APK may ship until ② lands and is verified on a real
// Play track**」 stands as-is,
// and it now **has one more thing that must be resolved together**: how this
// manifest permission should be removed per channel.
// That day's first question is not 「how to add a flavor」, but 「once added,
// **who** tells me it is actually gone」
// — UP-7's answer is **reading the artifact's bytes**
// (`scripts/apk-self-update-marker.mjs`),
// this one's answer should be the same shape: **read the manifest inside the
// APK, not the build command**.
//
// ── 🔴 IN-PLACE CORRECTION (2026-08-19, ST-1) — THAT DAY CAME, AND THE
// PARAGRAPH ABOVE PREDICTED THE ANSWER CORRECTLY. ─────────────────────────
//
// The flavour fork exists (`android/app/src/{direct,store}/AndroidManifest.xml`,
// the `channel` dimension in `android/app/build.gradle.kts`), so the coordinate
// quoted above is now wrong in one word: the permission line is no longer in
// `src/main/`, it is in `src/direct/`. **The store artifact cannot declare it,
// because it was never merged in** — not because anyone remembered to strip it.
//
// And the question this paragraph said to ask first — 「once added, WHO tells me
// it is actually gone」 — is answered the way it asked for:
// `scripts/store-channel-gate.mjs` reads the artifact (aapt for the permission,
// a byte scan with a control marker for the self-updater), never the build
// command. Its drill is `scripts/st1-store-channel-gate.test.mjs`.
//
// ⚠️ Still owed, and not to be read as done: a real Play track. Both gates are
// proven against artifacts and probes here; neither has been observed on a
// package Google actually delivered.

/// The build-time switch's define name.
/// The packaging command = `make -C apps/mobile release`
/// (= `flutter build apk --release --dart-define=FLOWMIC_SELF_UPDATE=1`).
///
/// 🔴 **UP-7 (2026-08-08): forgetting to add this define now goes red, and the
/// gate is not on this command.**
/// The file-header section above thought through the failure direction —
/// forget it ⇒ lose the feature — but did not say this
/// **is also silent to us**: AOT tree-shakes the entire update module out,
/// the build succeeds,
/// exits 0, every gate is green, **nothing anywhere says it is gone**. That
/// is exactly how 0.2.59 shipped.
/// ⇒ `scripts/publish.mjs` now **reads the APK's bytes**: a package that
/// cannot find `kUpdateManifestPath`
/// (`/api/updates/latest`, see update_check.dart) is **refused entry into `publish/`**.
/// The measurements in both directions, the control string, and 「how this
/// gate should be split per channel rather than weakened, the day a store
/// version ships」
/// are all in `scripts/apk-self-update-marker.mjs`'s file header.
///
/// ⚠️ **That gate recognizes the string, not this define** (it can only read
/// the bytes). So the line below,
/// 「the download/install half must keep this `const`」, now has one more
/// corollary: **if the update module
/// ever stops containing that string, the gate will go red on a good
/// package** — the correct move then is **to redo the measurement in both
/// directions and swap the marker**, not to delete the gate.
const String kSelfUpdateDefineKey = 'FLOWMIC_SELF_UPDATE';

/// 🔴 **Both spellings are recognized, and that is not leniency — it is
/// plugging a silent failure.**
///
/// `bool.fromEnvironment` **only recognizes the literals `true` / `false`** —
/// any other value (including `1`)
/// silently falls back to the default `false`. And the command written in
/// design §6 and in the card is
/// `--dart-define=FLOWMIC_SELF_UPDATE=1`: **type that command exactly as
/// documented, and the feature silently
/// does not exist** — the build succeeds, the package still ships, only that
/// section forever shows 「this version does not include in-app updates」.
///
/// That is exactly this repo's red line's second direction (reporting
/// something that did not happen as having happened — here it is the
/// reverse:
/// something that DID happen quietly vanishes), and **no gate catches it at
/// all**: dart-define does not go through lint,
/// does not go through type checking, does not go through tests. So both
/// `=true` and `=1` are recognized here.
///
/// ⚠️ All three are `const` ⇒ the whole branch can be tree-shaken out when
/// off. When writing the download/install half,
/// **it must stay `const`**: switching to `final` would leave that code in
/// the package, and as far as Play policy
/// is concerned, 「whether that code is in the package」 and 「whether it can
/// ever be reached」 are not the same question.
const bool _selfUpdateBoolForm = bool.fromEnvironment(kSelfUpdateDefineKey);
const String _selfUpdateRawForm = String.fromEnvironment(kSelfUpdateDefineKey);

/// Whether this build carries in-app updates. **Default false.**
const bool kSelfUpdateEnabled = _selfUpdateBoolForm || _selfUpdateRawForm == '1';

// ── The NOTIFY-ONLY switch (iOS, owner 2026-08-20) ──────────────────────────
//
// iOS ships through TestFlight / the App Store, and the 2026-08-19 phase-2
// ruling makes self-INSTALL and a store channel mutually exclusive. What the
// owner asked for on 2026-08-20 is the half that is compatible with a store:
// **check + notify** — a dot and a sentence pointing at the store page, never
// a download, never an installer.
//
// 🔴 Why this is a SECOND define rather than `Platform.isIOS` at runtime:
// `scripts/store-channel-gate.mjs` asserts the marker string
// `/api/updates/latest` is ABSENT from the Android store artifact, and today
// that absence is delivered by Dart TFA folding `kSelfUpdateEnabled == false`
// through UpdateController's final field until `checkForUpdate` is dead code.
// A runtime `Platform.isIOS` branch is not foldable — it would leave the
// check path (and its marker string) alive in every Android build and turn
// the store gate red. A const that no Android build command passes keeps the
// folding intact.
//
// ⚠️ The failure direction is UP-7's, and the same debt applies: forget the
// define on an iOS build ⇒ the feature silently does not exist (build green,
// exit 0). The command that carries it is `make -C apps/mobile release-ios`.
// There is deliberately NO byte-gate reading the IPA yet: iOS archives are
// produced on the mac line outside scripts/publish.mjs, and this repo's own
// rule says an artifact gate never verified against a real artifact is worse
// than a debt written down plainly. The debt lives in the Makefile target's
// header; the day the mac line stages IPAs through a script, give it the
// apk-self-update-marker shape (feature string + control string).

/// The notify-only switch's define name. The iOS packaging command =
/// `make -C apps/mobile release-ios`
/// (= `flutter build ipa --release --dart-define=FLOWMIC_UPDATE_NOTIFY=1`).
const String kUpdateNotifyDefineKey = 'FLOWMIC_UPDATE_NOTIFY';

// Both spellings, same reason as kSelfUpdateEnabled above: the documented
// command says `=1`, and `bool.fromEnvironment` silently defaults on it.
const bool _updateNotifyBoolForm = bool.fromEnvironment(kUpdateNotifyDefineKey);
const String _updateNotifyRawForm = String.fromEnvironment(kUpdateNotifyDefineKey);

/// Whether this build checks for updates and NOTIFIES, without any install
/// path. **Default false.** It gates nothing but the check: the install chain
/// stays behind [kSelfUpdateEnabled] + the store probe, and
/// `UpdateController.canInstall` structurally cannot come true from this flag
/// alone.
const bool kUpdateNotifyOnlyEnabled = _updateNotifyBoolForm || _updateNotifyRawForm == '1';
