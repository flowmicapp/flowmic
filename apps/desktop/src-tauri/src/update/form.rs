// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.2 (the three
//     run-time shapes)
//
// Which shape is this running copy — installed by the MSI, a portable/loose
// copy, or a developer build?
//
// ⚠️ NAMING: this module is `update::form`, NOT `portable`. `crate::portable`
// already exists and means DATA portability (FPR v1 export/import, doc 16) — a
// completely unrelated sense of the word. Overloading it would have put two
// meanings on one path segment in a repo whose headline bug shape is「一个东西
// 回答了两个问题」("one thing answers two questions").
//
// ── THE ONE RULE THAT MAKES THIS MEASUREMENT WORTH ANYTHING ─────────────────
//
// 🔴 The judgement is made from the RUNNING PROCESS'S REAL PATH
// (`std::env::current_exe`) — never a compile-time constant, never a value
// written at install time into a config file. The repo's law:「一份测量有多硬，
// 取决于产生它的机制是不是产品会走的那条路」("how solid a measurement is
// depends on whether the mechanism that produced it is a path the product
// actually takes"). An install-time flag answers
//「what did the installer believe when it ran」, which is a different question
// from「what am I now」, and they diverge exactly when somebody copies the folder
// — i.e. in the case this function exists to detect.
//
// The pure predicate takes the path as an ARGUMENT so it can be tested against
// fabricated directories, the same split `sidecar::node_runtime::bundled_node_beside`
// uses and for the same reason: a function that only ever consults the real
// `current_exe()` can only be asked about the machine it is running on.

use std::path::{Component, Path, PathBuf};

/// The executable name the MSI installs.
///
/// 🔴 Pinned to `CARGO_PKG_NAME` by a test below rather than asserted in a
/// comment — Tauri names the installed binary after the Cargo bin target, so a
/// package rename would silently make this string stop matching anything and
/// every MSI install would classify as `Unknown` (i.e. quietly demote itself to
///「只提示」("notify-only") forever, with no gate going red).
///
/// [measured 2026-08-08, dev-pc-a] `C:\Program Files\FlowMic\flowmic-desktop.exe`
/// exists on this machine with `FileVersion=0.1.5`, registered under
/// `InstallLocation=C:\Program Files\FlowMic\`.
pub const MSI_EXE_NAME: &str = "flowmic-desktop.exe";

/// The executable name the PORTABLE bundle carries.
///
/// 🔴 `scripts/publish.mjs` renames the built binary on the way into the bundle
/// (`stage(exePath, PORTABLE, 'FlowMic.exe')`), so the two forms are told apart
/// by a name that only exists because one line of a Node script says so. That
/// line is read as data by a test below — the same technique
/// `node_runtime.rs::the_bundled_runtime_name_matches_the_pin_declaration` uses
/// against `bundled-node.mjs`, and for the same reason: a comment saying「两边
/// 保持一致」("the two sides stay in sync") is an anti-façade ④ claim about
/// somebody else's file.
///
/// [measured 2026-08-08, dev-pc-a] the process running right now is
/// `C:\Users\builder\AppData\Local\Programs\FlowMic\FlowMic.exe`,
/// `FileVersion=0.2.59` — i.e. owner is STILL on the portable form, as design
/// §4.1 found on 2026-08-02. That reading is six days newer than the design's.
pub const PORTABLE_EXE_NAME: &str = "FlowMic.exe";

/// What shape this running copy is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallForm {
    /// Running out of a build tree or the artifact area. 🔴 **Check nothing at all.**
    /// An update prompt on a dev build is pure noise, and `publish/` is the
    /// artifact area (RV-73) which nobody is allowed to run from anyway.
    Dev,
    /// Installed by the MSI, corroborated by the registry's `InstallLocation`.
    /// The only form the full download → verify → msiexec → self-exit chain
    /// applies to.
    MsiInstalled { install_dir: PathBuf },
    /// A portable bundle or a loose copy. Notify + open the download page;
    /// no in-place swap (design §4.5 (c) — and 🔴 that is still an OPEN owner
    /// question, see the module note in `mod.rs`).
    Portable,
    /// 🔴 We could not tell. **This is a distinct FACT, not a synonym for
    /// `Portable`**, even though it earns the same conservative behaviour.
    ///
    /// It is reachable and not theoretical: `msiexec /a` extracts a
    /// `flowmic-desktop.exe` to an arbitrary folder with no registry entry, and
    /// this repo has actually done that to inspect MSI payloads. Collapsing it
    /// into `Portable` would make a support log say「便携版」("portable
    /// edition") about a machine that
    /// is not running one, which is R11's failure — a status word whose evidence
    /// does not support it.
    Unknown,
    /// A platform that has no desktop update chain yet. macOS needs its own
    /// (design §6: Sparkle, or the same manifest with a `.dmg`); Linux likewise.
    ///
    /// Distinct from `Unknown` because the sentences differ: 「我们判断不出这份
    /// 拷贝是什么形态」("we cannot tell what shape this copy is") vs「这个平台的
    /// 自动更新还没做」("automatic updates for this platform have not been built
    /// yet"). The second is true and
    /// actionable; the first would be a lie on macOS, where we can see perfectly
    /// well what we are.
    UnsupportedPlatform,
}

impl InstallForm {
    /// Should we contact the manifest endpoint at all?
    ///
    /// Only `Dev` says no, and it says no absolutely — design §4.2's 「完全不检查
    /// 更新」("do not check for updates at all"). Every other form checks,
    /// because「有新版本」("there's a new version") is useful even when we
    /// cannot install it for you.
    pub fn should_check(&self) -> bool {
        !matches!(self, Self::Dev)
    }

    /// A stable tag for forensic lines and UP-3b's string table. Exhaustive,
    /// no wildcard arm — same mechanism as `UpdateFailure::tag`.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::MsiInstalled { .. } => "msi",
            Self::Portable => "portable",
            Self::Unknown => "unknown",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

/// Lower-case the path components on case-insensitive filesystems only.
///
/// Windows compares paths case-insensitively; macOS's default volume does too
/// but can be case-sensitive; Linux does not. Getting this wrong in the strict
/// direction means `C:\PROGRAM FILES\FlowMic\` fails to match
/// `C:\Program Files\FlowMic\` and a real MSI install classifies as `Unknown` —
/// a silent demotion, which is the failure mode with no symptom.
fn norm(s: &str) -> String {
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s.to_string()
    }
}

/// All components of a path, normalised. Includes the drive prefix and root, so
/// `C:\a` and `\a` cannot compare equal.
fn components(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| match c {
            Component::Normal(s) => norm(&s.to_string_lossy()),
            other => norm(&other.as_os_str().to_string_lossy()),
        })
        .collect()
}

/// Is `exe` strictly inside `dir`?
///
/// Compared COMPONENT-WISE rather than as a string prefix. A string prefix test
/// would say that `C:\Program Files\FlowMic-old\app.exe` lives under
/// `C:\Program Files\FlowMic` — the classic prefix-without-a-boundary bug, and
/// here it would hand `MsiInstalled` (⇒ we launch msiexec) to a copy that is not
/// the installed one.
fn is_under(dir: &Path, exe: &Path) -> bool {
    let d = components(dir);
    let e = components(exe);
    !d.is_empty() && e.len() > d.len() && e[..d.len()] == d[..]
}

/// Is this path inside a build tree or the artifact area?
///
/// Component-wise, again for the boundary reason: a substring search for
/// `publish` matches `C:\Users\publisher\FlowMic\FlowMic.exe`, and a substring
/// search for `target\release` matches nothing on a `/`-separated path. Checking
/// components handles both separators for free, which matters because the
/// manifest-driven update chain is meant to work on macOS and Linux too.
fn is_dev_path(exe: &Path) -> bool {
    let c = components(exe);
    // `publish/` — RV-73's artifact area. Running from it is already forbidden;
    // offering it an update would be advice about a directory nobody should be
    // standing in.
    if c.iter().any(|x| x == "publish") {
        return true;
    }
    // `target/debug` or `target/release`, ADJACENT. Not merely "contains
    // `release`" — the portable bundle could legitimately be unpacked into a
    // folder somebody named `release`.
    c.windows(2).any(|w| w[0] == "target" && (w[1] == "debug" || w[1] == "release"))
}

/// Classify an executable path against a set of registered install locations.
///
/// `registered_install_dirs` is what the Windows registry says about our
/// `UpgradeCode`. It is a PARAMETER and not a lookup performed inside, for two
/// reasons: it makes the whole rule testable against fabricated directories, and
/// the registry crate (`winreg`) is `app`-gated, so a lookup here would drag
/// this module out of the lean build that its tests run under.
///
/// An EMPTY slice means「we did not find any registration」and is handled
/// honestly: a `flowmic-desktop.exe` with no matching registration becomes
/// `Unknown`, never `MsiInstalled`. That direction is the safe one — the wrong
/// guess would launch `msiexec` against a machine where the product is not
/// registered.
pub fn classify_exe_path(exe: &Path, registered_install_dirs: &[PathBuf]) -> InstallForm {
    // 🔴 Dev wins over everything, including the filename tests below — a dev
    // build IS named `flowmic-desktop.exe`, so any other order would classify
    // `target\release\flowmic-desktop.exe` as an installed copy and start
    // offering to run msiexec over a developer's working tree.
    if is_dev_path(exe) {
        return InstallForm::Dev;
    }
    if !cfg!(windows) {
        return InstallForm::UnsupportedPlatform;
    }
    let Some(name) = exe.file_name().map(|n| norm(&n.to_string_lossy())) else {
        return InstallForm::Unknown;
    };
    if name == norm(MSI_EXE_NAME) {
        return match registered_install_dirs.iter().find(|d| is_under(d, exe)) {
            Some(dir) => InstallForm::MsiInstalled { install_dir: dir.clone() },
            // Extracted with `msiexec /a`, or moved out of the install dir.
            // Named honestly rather than guessed either way.
            None => InstallForm::Unknown,
        };
    }
    if name == norm(PORTABLE_EXE_NAME) {
        // Design §4.2's criterion is 「不在任何已注册 InstallLocation 下」("not
        // under any registered InstallLocation"). Kept
        // literally: a `FlowMic.exe` sitting inside a registered install
        // directory is a shape we have never produced, and calling it
        //「portable」would be asserting something we have no evidence for.
        if registered_install_dirs.iter().any(|d| is_under(d, exe)) {
            return InstallForm::Unknown;
        }
        return InstallForm::Portable;
    }
    InstallForm::Unknown
}

/// Classify THIS process.
///
/// 🔴 `current_exe()` — see the module header. A failure to read it is
/// `Unknown`, which suppresses the install chain; guessing `Portable` would be
/// inventing a fact about the machine from the absence of one.
pub fn current_install_form(registered_install_dirs: &[PathBuf]) -> InstallForm {
    match std::env::current_exe() {
        Ok(p) => classify_exe_path(&p, registered_install_dirs),
        Err(_) => InstallForm::Unknown,
    }
}

/// Can this file be REPLACED right now?
///
/// 🔴 This is deliberately not「is FlowMic running?」, and the difference is the
/// whole reason the function exists. `scripts/install-local.mjs` already learned
/// it the expensive way and asks the same question the same way (it opens the
/// target with `r+`): a PID can vanish while a file handle lingers, an
/// antivirus scanner can hold an image open for seconds after exit, and a second
/// user session can be running the same binary invisibly. 「Did the process
/// exit」 is a proxy; 「can I open this for writing」 is the actual precondition,
/// asked of the actual OS, about the actual file.
///
/// ⚠️ **Opens for WRITE, never for create or truncate.** Requesting write access
/// is the entire measurement — on Windows a running executable's image lock
/// denies exactly that — but a stray `.truncate(true)` here would empty the very
/// binary we are asking about. The flags below are load-bearing; do not "tidy"
/// them into `File::create`.
///
/// `false` for a path that does not exist, which is correct for the caller's
/// question: you cannot replace what is not there, and the caller should be
/// creating rather than replacing.
///
/// ⚠️ **Inherently a sample, not a guarantee.** It answers「was this replaceable
/// a moment ago」. Nothing stops the lock appearing one instruction later, so a
/// caller must still handle the write failing. Its value is refusing early and
/// nameably rather than half-way through a swap.
pub fn can_replace_file(path: &Path) -> bool {
    std::fs::OpenOptions::new().write(true).open(path).is_ok()
}

#[cfg(test)]
#[path = "form_tests.rs"]
mod tests;
