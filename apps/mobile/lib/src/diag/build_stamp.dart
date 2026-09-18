// Card SC-5 — which commit was this APK built from?
//
// ── WHY (risk R1 of the ship-chain redesign) ────────────────────────────────
//
// The release chain now starts `make -C apps/mobile release` at t=0, in
// parallel with the gate, against warm Gradle caches. Nothing in the old chain
// could tell whether the APK being staged came from the commit the gate receipt
// names: a build started one commit early, a lane merged mid-flight, a warm
// cache that reused an old libapp.so — each ships bytes the receipt does not
// describe, and each looks exactly like a correct round. server-core, stt-cloud
// and the web dist already stamp their commit; the APK and the desktop exe did
// not.
//
// ── THE SHAPE, AND WHY IT MIRRORS kSelfUpdateEnabled ────────────────────────
//
// Same mechanism as `self_update_flag.dart`: a `--dart-define` read through
// `String.fromEnvironment`, kept `const` so the value is folded into a string
// constant that survives into `lib/<abi>/libapp.so`. That constant is what
// `scripts/publish.mjs` GATE 0f reads out of the APK BYTES — it never runs this
// code, exactly as the self-update marker gate never runs the app. "The build
// went through our script" and "the bytes carry this commit" are different
// claims and only the second is worth gating on.
//
// ⚠️ It must stay `const` and it must stay REFERENCED (the startup diagnostics
// line below is what references it). A `final` would be dead weight in a store
// build; an unreferenced const would be tree-shaken away and the gate would read
// every good APK as unstamped.
//
// ── THE FOUR VALUES ─────────────────────────────────────────────────────────
//
//   <sha40>          a clean checkout   -> publishable
//   dirty-<sha40>    FLOWMIC_ALLOW_DIRTY_BUILD=1 -> GATE 0f refuses by name
//   nogit            FLOWMIC_BUILD_ALLOW_NO_GIT=1 -> GATE 0f refuses by name
//   unstamped-dev    no define at all (a plain `flutter build`/`flutter test`)
//
// The rule that produces the first three lives in ONE place,
// scripts/build-stamp/require-clean-sha.mjs, and reaches this file through
// `scripts/build-stamp/with-build-sha.mjs` substituting `{sha}` into the
// Makefile release line.
//
// 🔴 NOT USER-VISIBLE COPY, deliberately. This is a diagnostics line in the
// trail that already exists (`diag_log.dart`), not a string on a screen: it
// answers a support question ("which build is this phone running"), and the
// product has no place where a commit id would mean anything to a user.

/// The define name. Quoted by apps/mobile/Makefile and by the byte gate.
const String kBuildShaDefineKey = 'FLOWMIC_BUILD_SHA';

const String _rawBuildSha = String.fromEnvironment(kBuildShaDefineKey);

/// The commit this build was made from, or `unstamped-dev` when no define
/// reached the build. `unstamped-dev` is NOT an error here — `flutter test` and
/// a debug build are not artifacts — it is an error at publish time, which is
/// where GATE 0f refuses it by name.
const String kBuildSha = _rawBuildSha == '' ? 'unstamped-dev' : _rawBuildSha;

/// The literal the gate scans the APK bytes for: `flowmic-build-sha:<value>`.
///
/// A prefix rather than a bare sha, so a byte scan can tell "stamped with the
/// wrong commit" from "not stamped at all" — two states with two different
/// fixes. The prefix is spelled identically in
/// scripts/build-stamp/require-clean-sha.mjs (`STAMP_PREFIX`) and in
/// apps/desktop/src-tauri/src/build_stamp.rs; `test/build_stamp_test.dart`
/// reads that node file and pins the pair, because a rename with nothing
/// checking would make the gate read every good APK as blind.
const String kBuildShaStamp = 'flowmic-build-sha:$kBuildSha';
