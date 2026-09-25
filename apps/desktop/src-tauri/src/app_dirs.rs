//! Where this product's per-user files live, per platform — ONE answer per role.
//!
//! # Why this module exists (MAC-01)
//!
//! Three call sites used to each ask the OS the same question in their own words:
//!
//! | site | asked | answer on macOS (before this module) |
//! |---|---|---|
//! | `sidecar::io::default_home` | `%APPDATA%` else temp | `$TMPDIR/FlowMic` |
//! | `forensic::resolve_path` | `%LOCALAPPDATA%` else temp | `$TMPDIR/FlowMic` |
//! | `socket::credentials::default_path` | `%LOCALAPPDATA%` else temp | `$TMPDIR/FlowMic` |
//!
//! Each fallback was written as a courtesy for "tests / non-Windows dev", and each
//! was correct for that purpose. Put a real macOS product on top of them and the
//! same line means something else: macOS prunes `$TMPDIR` (`/var/folders/...`)
//! on an age policy, so the DB, the pairing credentials, the instance lock and the
//! forensic log all evaporate on their own schedule. The pairing a user completed
//! last week is simply gone, and the forensic log that would have explained it went
//! with it.
//!
//! ⇒ The bug was never in any one of those three lines. It was that "where does
//! this platform keep user data" had three implementations and no owner. This
//! module is the owner.
//!
//! # The two roles are kept distinct on purpose
//!
//! Windows splits roaming (`%APPDATA%`) from local (`%LOCALAPPDATA%`), and this
//! product uses the split: the DB + standalone secret are roaming-side, the
//! forensic log + credential blob are local-side. macOS has no such split —
//! `~/Library/Application Support/FlowMic` is the correct home for both. So on
//! macOS the two functions below deliberately return the SAME directory.
//!
//! 🔴 That collapse is a real behavioural difference, not a detail: on macOS the
//! forensic log and the DB become directory siblings. Nothing in the product reads
//! a file by "the other role's directory", so this is safe today — but if anyone
//! ever distinguishes the two dirs by identity rather than by role, macOS will be
//! the platform where that breaks. Stated here so it is greppable rather than
//! discovered.
//!
//! # No migration path is shipped, and here is the evidence for why
//!
//! A migration would only be needed if some macOS user already has data under
//! `$TMPDIR`. Nobody does: the first macOS `.app` was built on 2026-08-06 and
//! **was never launched** — see `docs/archive/strategy/2026-08-06-macmini-onboarding-findings.md`
//! §5, which states in as many words 「没有验证它能跑起来 …没有启动过 `.app`」
//! ("never verified it can run ... never launched the `.app`").
//! ⇒ There is no on-disk state to move. Writing a migration for it would be
//! inventing a recovery path for a state no machine is in.
//!
//! # Linux was knowingly NOT fixed by MAC-01 — historical open account
//!
//! Linux still lands on the `temp_dir()` fallback. That is the same defect this
//! module fixes for macOS, and a Linux portable build IS a standing owner ruling
//! (`docs/decisions/2026-08-05-owner-build-and-release-additions.md` ①). It is left
//! open deliberately: this window has a macOS box to verify on and no Linux box, and
//! a behaviour change on a platform nobody can run is not a fix, it is an untested
//! guess. Registered as an open account in the W3 ledger. The shape of the fix is
//! known (`$XDG_DATA_HOME` else `~/.local/share`), which is exactly why it should be
//! done by someone who can watch it work.
//!
//! L-1 (2026-09-21) closes that directory account: Linux data, configuration,
//! diagnostic state and the instance lock have separate XDG roles. The legacy
//! roaming/local accessors below remain for existing callers; both carry data
//! on Linux. Locale persistence calls config_home, forensics calls state_home,
//! and single_instance calls instance_home. No old temporary files are deleted.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(windows)]
#[cfg(test)]
mod windows_tests;

/// The app-data name used on every platform. One constant so a rename cannot land
/// on some directories and miss others.
const APP_DIR_NAME: &str = "FlowMic";

/// macOS per-user application-support root: `~/Library/Application Support`.
/// `None` when `HOME` is unset (a stripped environment), so callers keep their
/// existing fallback rather than assembling a nonsense path from an empty string.
#[cfg(target_os = "macos")]
fn macos_app_support() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    if home.is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join("Library").join("Application Support"))
}

/// The legacy ROAMING-role home: standalone DB and secret, passed to the sidecar
/// as FLOWMIC_HOME. Linux locale and lock consumers now use their own roles.
///
/// - Windows: `%APPDATA%\FlowMic` (unchanged — this is the shipped behaviour).
/// - macOS: `~/Library/Application Support/FlowMic`.
/// - Linux: XDG data, requiring validated storage at production startup.
/// - Other platforms, or stripped Windows/macOS env: the historical temp fallback.
pub fn roaming_home() -> PathBuf {
    #[cfg(target_os = "linux")]
    { linux::required(linux::Role::Data) }
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(APP_DIR_NAME);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(base) = macos_app_support() {
            return base.join(APP_DIR_NAME);
        }
    }
    #[cfg(not(target_os = "linux"))]
    { std::env::temp_dir().join(APP_DIR_NAME) }
}

/// The legacy LOCAL-role home: credential blob and existing persistent local
/// data. Linux forensics now uses state_home separately.
///
/// - Windows: `%LOCALAPPDATA%\FlowMic` (unchanged — this is the shipped behaviour).
/// - macOS: `~/Library/Application Support/FlowMic` — same dir as `roaming_home`,
///   see the module header.
/// - Linux: XDG data, requiring validated storage at production startup.
/// - Other platforms, or stripped Windows/macOS env: the historical temp fallback.
pub fn local_home() -> PathBuf {
    #[cfg(target_os = "linux")]
    { linux::required(linux::Role::Data) }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join(APP_DIR_NAME);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(base) = macos_app_support() {
            return base.join(APP_DIR_NAME);
        }
    }
    #[cfg(not(target_os = "linux"))]
    { std::env::temp_dir().join(APP_DIR_NAME) }
}

/// Check all persistent roles before startup initializes any consumer. Linux
/// refuses a stripped environment by name rather than inventing a temporary home.
pub fn validate_environment() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    { linux::initialize()?; }
    Ok(())
}

/// User choices, currently the locale mirrored from the WebView.
pub fn config_home() -> PathBuf {
    #[cfg(target_os = "linux")]
    { linux::required(linux::Role::Config) }
    #[cfg(not(target_os = "linux"))]
    { roaming_home() }
}

/// Diagnostic state. Fallible so forensic initialization can report a missing
/// home on stderr without panicking or changing the main flow's outcome.
pub fn state_home() -> std::io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    { linux::current(linux::Role::State) }
    #[cfg(not(target_os = "linux"))]
    { Ok(local_home()) }
}

/// Lock identity: Linux runtime directory, falling back to persistent state.
/// Windows/macOS retain the exact old path (Windows production uses a mutex).
pub fn instance_home() -> PathBuf {
    #[cfg(target_os = "linux")]
    { linux::required(linux::Role::Runtime) }
    #[cfg(not(target_os = "linux"))]
    { roaming_home() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both roles must end in the app dir on every platform — a fallback that
    /// forgot the leaf would scatter files into the temp root itself.
    #[test]
    fn both_roles_end_in_the_app_dir() {
        assert_eq!(roaming_home().file_name().unwrap(), APP_DIR_NAME);
        assert_eq!(local_home().file_name().unwrap(), APP_DIR_NAME);
    }

    /// The point of the card, asserted per platform rather than as a tautology.
    ///
    /// 🔴 A test that only said "the path is absolute" would have been GREEN on the
    /// broken behaviour too — `$TMPDIR/FlowMic` is absolute. The criterion has to be
    /// "is it under the directory macOS does not prune", which means naming it.
    #[test]
    fn macos_lands_under_application_support_not_tmpdir() {
        #[cfg(target_os = "macos")]
        {
            // Only meaningful when HOME is present; when it is not, the documented
            // behaviour IS the temp fallback and asserting otherwise would be wrong.
            if super::macos_app_support().is_some() {
                for p in [roaming_home(), local_home()] {
                    let s = p.to_string_lossy().to_string();
                    assert!(
                        s.contains("/Library/Application Support/"),
                        "macOS data must live under Application Support, got {s}"
                    );
                    assert!(
                        !s.starts_with("/var/folders/"),
                        "macOS data must NOT live under the pruned $TMPDIR, got {s}"
                    );
                }
            }
        }
        #[cfg(windows)]
        {
            // Windows behaviour is explicitly unchanged by this card; assert that,
            // so a future edit to the macOS branch cannot quietly move Windows too.
            if std::env::var("APPDATA").is_ok() {
                assert!(!roaming_home().starts_with(std::env::temp_dir()));
            }
            if std::env::var_os("LOCALAPPDATA").is_some() {
                assert!(!local_home().starts_with(std::env::temp_dir()));
            }
        }
    }
}
