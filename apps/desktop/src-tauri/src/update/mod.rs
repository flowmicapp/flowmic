// UP-3a — the desktop in-app update CORE.
//
// SPEC-REF:
//   docs/decisions/2026-08-02-in-app-update-both-ends.md (owner 2026-08-02)
//   docs/strategy/2026-08-02-l4-in-app-update-design.md  (the implementation design)
//   apps/server-core/src/http/update-routes.ts           (the contract consumed)
//
// ── WHAT IS HERE AND WHAT IS NOT ────────────────────────────────────────────
//
// HERE (UP-3a): the manifest DTO + parser, the version compare, the fetch and
// its outcome taxonomy, the download, the SHA-256 gate, install-form detection,
// and the plan that falls out of all of it.
//
// NOT HERE (UP-3b): every UI string, the four-locale mapping, launching
// msiexec, self-exit, the `update-pending.json` breadcrumb, and any in-place
// swap of a portable copy. This module is deliberately tauri-free so that all
// of the above is unit-tested under `cargo test --lib` with no WebView2
// toolchain — the same split `forensic.rs` and `app_dirs.rs` already use. Only a
// `#[tauri::command]` wrapper belongs behind the `app` feature.
//
// ── 🔴 NOTHING HERE HAS BEEN PROVEN ON A REAL MACHINE ───────────────────────
//
// Every claim below is unit-tested and NONE of it is real-machine-proven. No
// manifest has ever been served to this code, no installer has ever been
// downloaded by it, and no MSI install form has been classified from a genuine
// `current_exe()` in production. [measured 2026-08-08, dev-pc-a]
// `GET https://flowmic.app/api/updates/latest` answers **404
// `{"error":"not_found"}`** — the manifest route is not mounted on the VPS
// today, so the entire happy path is untestable end-to-end until somebody
// deploys one. That 404 is itself an outcome this code names honestly
// (`NoManifestOnServer`), which is the one part of the chain today's terrain
// can exercise.
//
// ── THE ONE RULE THAT ORGANISES ALL OF IT ───────────────────────────────────
//
// 🔴 未知 ≠ 最新 ("unknown ≠ latest"). Exactly one value in this module
// renders as 「已是最新」("already up to date"):
// `UpdateVerdict::UpToDate`. Every failure is a different sentence, and
// `failure.rs` has a test asserting none of them can be worded as that one.

pub mod archive;
pub mod download;
pub mod failure;
pub mod fetch;
pub mod form;
pub mod manifest;
pub mod version;

// ── UP-3b ───────────────────────────────────────────────────────────────────
/// The mover process: the flag, the job file, and the swap it performs.
pub mod apply_arg;
/// `update-pending.json` — the only channel from「after we exited」back to
/// 「the next time we run」.
pub mod breadcrumb;
/// DEFLATE-capable unpacking. 🔴 Exists because the real portable bundle is
/// DEFLATE and `portable::zip` is STORE-only — see that module's header.
pub mod extract;
/// `msiexec` hand-off.
pub mod msi;
/// The auto-check toggle and 「上次成功检查于 …」("last successful check at …").
pub mod prefs;
/// 🔴 The portable in-place swap: preflight, the rename dance, the rollback.
pub mod swap;

pub use archive::{read_shape, verify_root, ArchiveShape};
pub use download::{download_and_verify, sha256_file, sweep_stale, updates_dir, SweepReport, VerifiedPackage};
pub use failure::UpdateFailure;
pub use fetch::{fetch_manifest, manifest_url, MANIFEST_PATH};
pub use form::{can_replace_file, classify_exe_path, current_install_form, InstallForm};
pub use manifest::{parse_manifest, UpdateArtifact, UpdateManifest, UpdatePlatform};
pub use version::{evaluate, UpdateVerdict, Version};

pub use apply_arg::{intercept, APPLY_UPDATE_ARG};
pub use breadcrumb::{Breadcrumb, PendingKind, PendingOutcome};
pub use extract::{extract_into, ExtractReport};
pub use prefs::UpdatePrefs;
pub use swap::{SwapJob, SwapOutcome};

/// The top-level directory name inside the WINDOWS portable archive.
///
/// 🔴 This is the *caller's expectation*, passed to `archive::verify_root` — that
/// module deliberately holds no such constant, because the one `portable-zip`
/// kind covers two shapes (`FlowMic-portable/` on Windows, `FlowMic.app/` on
/// macOS [measured 2026-08-08]) and a default would make one platform silently
/// wrong. It lives HERE, next to the Windows-only swap that consumes it, and the
/// swap tests use LITERAL names so that moving this constant cannot move both
/// sides of an assertion at once.
pub const WINDOWS_PORTABLE_ROOT: &str = "FlowMic-portable";

/// This machine's key into the manifest's `platforms` map.
///
/// Built by translating Rust's OS/arch spelling into the release chain's, rather
/// than matched against a hard-coded list. The two are different vocabularies
/// for one fact (`x86_64` vs `x64`, `aarch64` vs `arm64`), and translating
/// covers combinations the whitelist has not reached yet: a Windows-on-ARM build
/// produces `windows-arm64`, which simply is not in any manifest, and the
/// resulting `NoBuildForThisPlatform` is the true sentence. A whitelist would
/// have had to answer `None` and then invent a different, less accurate one.
///
/// [measured 2026-08-08] the release chain's whitelist is
/// `PORTABLE_PLATFORMS = new Set(['windows-x64', 'macos-arm64', 'linux-x64'])`
/// in `scripts/pack-portable.mjs`, plus `windows-x64` / `android` from
/// `build-update-manifest.mjs::classify`. A test below reads that declaration as
/// DATA and asserts this machine's key is in it — the `bundled-node.mjs`
/// technique, not a comment claiming the two agree.
pub fn platform_key() -> String {
    // ⚠️ Only the ARCH half needs translating, and that asymmetry is easy to
    // misread as an oversight. The manifest's OS words are spelled exactly as
    // Rust spells them (`windows` / `macos` / `linux`), while its arch words are
    // spelled as Node does (`x64` / `arm64`, vs Rust's `x86_64` / `aarch64`) —
    // because the keys are minted by a Node script. Compare
    // `sidecar::node_runtime`'s test helpers, which have the OPPOSITE problem
    // and must translate BOTH halves (`win32` / `darwin`); the comment there
    // records that translating only the arch half is precisely the mistake that
    // was made and caught. Writing the identity arm for the OS here would say so
    // out loud, but clippy refuses it as a needless match, so it is said here.
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{}-{arch}", std::env::consts::OS)
}

/// Which artifact kinds THIS running form can fetch and verify.
///
/// 🔴 Read the name carefully: this answers 「我们能下载并校验哪一种」
/// ("which kind can we download and verify"), **not**
/// 「我们会拿它做什么」("what will we do with it"). Whether a verified `portable-zip` is then swapped into
/// place or merely revealed in a folder is design §4.5's OPEN owner question
/// ((a) switch to MSI / (b) build a portable self-updater / (c) notify only) —
/// and it is not answered here, because this core has no business inventing a
/// ruling. UP-3b receives the form in the plan and branches on the answer owner
/// gives.
///
/// Returned in PREFERENCE order.
pub fn fetchable_kinds(form: &InstallForm) -> &'static [&'static str] {
    match form {
        InstallForm::MsiInstalled { .. } => &["msi"],
        InstallForm::Portable => &["portable-zip"],
        // We do not know what we are, so we do not choose a package for this
        // machine. `Dev` never gets here (it does not check at all).
        InstallForm::Dev | InstallForm::Unknown | InstallForm::UnsupportedPlatform => &[],
    }
}

/// Why we can only point at a download page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManualReason {
    // 🔴 `PortableForm` USED TO BE HERE AND HAS BEEN REMOVED (UP-3b, 2026-08-08).
    //
    // Two reasons, and the second is the one that matters:
    //
    //  1. owner **2026-08-04 ②** rules that the portable edition must do a REAL
    //     in-place upgrade, which supersedes design §4.5's default of (c)
    //     只提示 ("notify-only").
    //     `swap.rs` implements it, so 「你运行的是免安装版，在线升级暂不支持它」
    //     ("you're running the no-install edition; online upgrade doesn't
    //     support it yet")
    //     is no longer a true sentence on Windows.
    //
    //  2. 🔴 **It never had a producer, even in UP-3a** [measured 2026-08-08:
    //     `grep -rn PortableForm src/` → one definition, one unreachable `match`
    //     arm, two test mentions, zero production paths]. `plan_from_manifest`
    //     only reaches the `ManualReason` branch when `fetchable_kinds(form)` is
    //     EMPTY, and `fetchable_kinds(Portable)` returns `["portable-zip"]` —
    //     never empty. So the arm was dead the day it was written.
    //
    // ⇒ this repo's precedent:「没有生产方的用户可见字符串要跟着生产方一起走」
    // ("a user-visible string with no producer must be retired along with its
    // producer") (the
    // `CLOUD_SESSION_NO_HISTORY` precedent). Keeping it would have obliged the
    // four-locale table to carry a sentence for a state that cannot occur — a
    // façade with a translation budget.
    //
    // ⚠️ The test that should have caught this accepted EITHER branch
    // (`mod_tests.rs::a_portable_copy_is_never_offered_the_installer` matched
    // `Available` OR `ManualOnly{PortableForm}`), so it was green whichever way
    // the code went. A test that admits both answers pins neither.
    /// We could not determine the install form. Saying 「你运行的是免安装版」
    /// ("you're running the no-install edition") to
    /// somebody who is not would be a status word whose evidence does not
    /// support it (R11).
    UnknownForm,
    /// This platform has no desktop update chain yet (design §6).
    UnsupportedPlatform,
    /// 🔴 **THE OPEN-SET DEGRADATION.** The manifest has a newer version and
    /// artifacts, and not one of them is a kind this build knows how to fetch.
    ///
    /// This is the variant that keeps a future `dmg` — or anything else the
    /// release chain invents after this binary shipped — from becoming a crash,
    /// a 「已是最新」("already up to date"), or a state the user cannot leave.
    /// A closed set in exactly
    /// this position produced the 0.2.48 P0 (an unknown code meant「still owed」
    /// forever, so the phone said 「待投递」("still to be delivered") and never converged) and was
    /// re-created a second time this month.
    ///
    /// `offered` lists what the manifest DID carry, so the sentence can name it
    /// and a support log shows whether the vocabulary drifted.
    NoFetchableKind { offered: Vec<String> },
}

/// What to do, given a manifest and this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdatePlan {
    /// A dev build. We contacted nothing and concluded nothing. 🔴 This is NOT
    /// 「已是最新」("already up to date") — it is 「我们没有看」("we haven't
    /// looked"), and the UI must say so (or say nothing
    /// at all), never the former.
    NotChecked { form: InstallForm },
    /// The manifest's version is equal to or lower than ours.
    /// 🔴 The ONLY plan that may be rendered as 「已是最新」("already up to date").
    UpToDate { current: Version },
    /// A newer version exists and we have an artifact we can fetch and verify.
    ///
    /// `form` rides along so UP-3b can pick the action without re-deriving it —
    /// one answer to 「我是什么形态」("what shape am I"), computed once.
    Available {
        form: InstallForm,
        current: Version,
        latest: Version,
        artifact: UpdateArtifact,
        notes_url: Option<String>,
    },
    /// A newer version exists; we cannot go further than pointing at a page.
    ///
    /// 🔴 Note what this variant still carries: `latest` and `notes_url`. A
    /// degradation that dropped them would leave the user with 「有更新但我不能
    /// 告诉你是什么」("there's an update but I can't tell you what it is")
    /// — a state they cannot act on OR leave.
    ManualOnly {
        form: InstallForm,
        current: Version,
        latest: Version,
        notes_url: Option<String>,
        reason: ManualReason,
    },
}

impl UpdatePlan {
    /// A stable tag for forensic lines and UP-3b's string table. Exhaustive.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::NotChecked { .. } => "not_checked",
            Self::UpToDate { .. } => "up_to_date",
            Self::Available { .. } => "available",
            Self::ManualOnly { .. } => "manual_only",
        }
    }
}

/// Turn a fetched manifest into a plan. **Pure** — no IO, so every branch of the
/// §3 failure table is unit-testable against fabricated manifests.
///
/// `locale` is the APP's UI language (design §4.3: 「按 App 的界面语言设置选，不
/// 跟随 OS locale」("chosen according to the App's UI language setting, not
/// following OS locale") — a product red line, not a preference).
pub fn plan_from_manifest(
    manifest: &UpdateManifest,
    form: &InstallForm,
    locale: &str,
) -> Result<UpdatePlan, UpdateFailure> {
    if !form.should_check() {
        return Ok(UpdatePlan::NotChecked { form: form.clone() });
    }
    let Some(current) = Version::current() else {
        return Err(UpdateFailure::OwnVersionUnreadable { raw: env!("CARGO_PKG_VERSION").to_string() });
    };
    let key = platform_key();
    let Some(entry) = manifest.platform(&key) else {
        return Err(UpdateFailure::NoBuildForThisPlatform {
            platform: key,
            available: manifest.platform_keys(),
        });
    };

    // 🔴 The version check comes BEFORE artifact selection, and the order is
    // load-bearing. Reversed, a machine already on the latest version whose
    // platform ships only an unrecognised `kind` would be told 「有新版本，去下载
    // 页」("there's a new version, go to the download page") about the version it is already running.
    let latest = match evaluate(current, entry.version) {
        UpdateVerdict::UpToDate { current } => return Ok(UpdatePlan::UpToDate { current }),
        UpdateVerdict::UpdateAvailable { latest, .. } => latest,
    };

    let notes_url = entry.notes_url.clone();
    let manual = |reason: ManualReason| UpdatePlan::ManualOnly {
        form: form.clone(),
        current,
        latest,
        notes_url: notes_url.clone(),
        reason,
    };

    let kinds = fetchable_kinds(form);
    if kinds.is_empty() {
        // ⚠️ `Portable` cannot reach here — `fetchable_kinds` gives it
        // `["portable-zip"]`, so `kinds` is non-empty. Named in the comment
        // rather than given an arm, because an arm would be a sentence for a
        // state that cannot occur (see `ManualReason`'s header).
        return Ok(manual(match form {
            InstallForm::UnsupportedPlatform => ManualReason::UnsupportedPlatform,
            _ => ManualReason::UnknownForm,
        }));
    }
    match entry.pick(kinds, locale) {
        Some(artifact) => Ok(UpdatePlan::Available {
            form: form.clone(),
            current,
            latest,
            artifact: artifact.clone(),
            notes_url,
        }),
        // The open-set degradation. Never a crash, never 「已是最新」("already up to date").
        None => Ok(manual(ManualReason::NoFetchableKind { offered: entry.kinds() })),
    }
}

/// Fetch the manifest from `base` and decide what to do.
///
/// `base` is a parameter with no default in this crate — see
/// `fetch::manifest_url` for why (`shell/cloud.rs`'s standing rule that the
/// endpoint default lives in `@flowmic/protocol`, never as a Rust literal).
///
/// A dev build short-circuits BEFORE any network call: design §4.2 says 「完全
/// 不检查更新」("do not check for updates at all"), and a request that is made and then ignored is still a request.
pub fn check(base: &str, form: &InstallForm, locale: &str) -> Result<UpdatePlan, UpdateFailure> {
    if !form.should_check() {
        return Ok(UpdatePlan::NotChecked { form: form.clone() });
    }
    let manifest = fetch_manifest(base)?;
    plan_from_manifest(&manifest, form, locale)
}

/// The registered install locations for our `UpgradeCode`, from the Windows
/// registry.
///
/// 🔴 Gated on `app` because `winreg` is an optional dependency enabled only by
/// that feature. It deliberately does NOT exist under the lean build rather than
/// returning an empty `Vec` there: a friendly empty default is exactly the shape
/// doc 13 §7 F1 ② forbids, and here it would silently demote every MSI install to
/// `Unknown` in any build that forgot the feature. Callers in the lean build
/// must pass their own slice, which the tests do.
///
/// ⚠️ **[unverified] on a real machine.** The UpgradeCode below is design §4.1's
/// measured value [measured 2026-08-02], and this lookup has never run in
/// production — it lands with UP-3b. The path it reads
/// (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<ProductCode>`)
/// is where this machine's 0.1.5 entry genuinely lives [measured 2026-08-08,
/// dev-pc-a: `InstallLocation=C:\Program Files\FlowMic\`], but reading it
/// through `winreg` from inside the app is not the same act as reading it with
/// PowerShell from outside, and only the first one counts.
#[cfg(all(windows, feature = "app"))]
pub fn registered_install_dirs() -> Vec<std::path::PathBuf> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let mut out = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for root in [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ] {
        let Ok(key) = hklm.open_subkey(root) else { continue };
        for name in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey(&name) else { continue };
            // Match on the product name rather than the ProductCode: design
            // §4.1 measured that the ProductCode changes with EVERY version and
            // every language, so pinning one would match exactly one build.
            let display: String = sub.get_value("DisplayName").unwrap_or_default();
            if display != "FlowMic" {
                continue;
            }
            let loc: String = sub.get_value("InstallLocation").unwrap_or_default();
            if !loc.trim().is_empty() {
                out.push(std::path::PathBuf::from(loc.trim_end_matches(['\\', '/'])));
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
