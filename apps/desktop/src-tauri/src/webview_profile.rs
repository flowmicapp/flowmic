//! P0-PKG — carry the WebView2 `localStorage` across the identifier rename.
//!
//! # What actually moves when a Tauri identifier changes
//!
//! Measured, not assumed (dev-pc-a, 2026-08-12). Tauri v2 resolves an
//! unset webview `data_directory` to `LocalData/<identifier>`
//! (tauri 2.11.5, `manager/webview.rs`, the 「in `windows`, we need to force a
//! data_directory」 block → `PathResolver::app_local_data_dir`, which joins
//! `config.identifier`). Line numbers are deliberately omitted: that file is a
//! vendored dependency, so a version bump moves them and nothing in this repo
//! would notice. So on Windows the
//! browser profile lives at `%LOCALAPPDATA%\<identifier>\EBWebView` and the
//! rename `cloud.flowmic.desktop` → `app.flowmic.windows` moves it. On disk
//! before the migration: 58 MB total, of which `Default\Local Storage` was 56 KB.
//!
//! 🔴 THE POINT: `localStorage` lives inside that profile, and this product keeps
//! REAL state there — not just preferences. Enumerated, because the first draft
//! of this header undersold it and that mattered:
//!
//!   * `flowmic.history.cache` — **the PC timeline itself**. `timeline-store.ts`
//!     says in as many words that renaming that key 「would empty every existing
//!     timeline」 and refuses to rename it for that reason. Moving the DIRECTORY
//!     it lives in does exactly what renaming the key would do.
//!   * `flowmic.ui.llm.config` and `flowmic.ui.stt.routings` — **provider API
//!     keys in cleartext** (`LlmConfigModel.api_key`, `Routing.api_key`). Losing
//!     them logs nobody out, but it silently disables the user's own engines; and
//!     it means this migration copies secrets between directories, which is why
//!     it is registered on the sensitive-surface audit queue.
//!   * `flowmic.pairing.lan_host`, `flowmic.ui.locale`, `flowmic.ui.theme`,
//!     `flowmic.capsule.pos`, `flowmic.settings.queue`,
//!     `flowmic.portable.preserved` — device-local choices and an unsent queue.
//!
//! Ship the rename with nothing else and every one of those silently resets, with
//! no message anywhere saying why.
//!
//! # What does NOT move, and why that decided the design
//!
//! Everything that would have been serious is keyed on the PRODUCT NAME, not on
//! the identifier — `app_dirs.rs` joins the constant `"FlowMic"`:
//!
//! | state | location | moved by the rename? |
//! |---|---|---|
//! | cloud credentials (`socket::credentials`, DPAPI) | `%LOCALAPPDATA%\FlowMic\credentials.bin` | **no** |
//! | sidecar DB + standalone secret | `%APPDATA%\FlowMic\` | **no** |
//! | forensic log, dedup ledger, update breadcrumb | `%LOCALAPPDATA%\FlowMic\` | **no** |
//! | WebView2 profile — PC timeline, provider keys, prefs | `%LOCALAPPDATA%\<identifier>\EBWebView` | **yes** |
//!
//! 🔴 ORIGINAL CLAIM, CORRECTED IN PLACE: this table first read 「login state and
//! the timeline survive on their own」. The login half is true and measured. The
//! timeline half was WRONG — the desktop timeline is `localStorage`, i.e. inside
//! the directory that moves. The mistake came from reading `app_dirs.rs`, seeing
//! a DB under `%APPDATA%\FlowMic`, and assuming the rows the user sees come from
//! it. ⇒ The rule this cost: 「where does this data live」 has to be answered by
//! the writer, not by the nearest plausible store.
//!
//! ⇒ So this module MIGRATES rather than invalidates, and migrates the 56 KB that
//! carries meaning instead of copying a 58 MB tree of regenerable caches.
//!
//! Also measured, because it is the question everybody asks next: the MSI
//! **UpgradeCode** is `uuid5(DNS, "<productName>.exe.app.x64")` (tauri-bundler
//! 2.9.4, `bundle/windows/msi/mod.rs`, the `upgrade_code` fallback) — product
//! name, not identifier. The new MSI still upgrades the old install in place;
//! only the per-build package GUID, which is derived from the identifier and is
//! meant to be unique per build anyway, changes. Android
//! is the opposite case and is handled by copy, not by code (see CHANGELOG).
//!
//! # Rules this migration obeys
//!
//! * **Idempotent** — it acts only when the destination `Local Storage` does not
//!   exist yet. A second launch is a no-op that says so.
//! * **Never destructive** — the legacy directory is never deleted or moved,
//!   only read. If this migration is wrong, nothing has been lost; the old
//!   profile is still on disk to look at.
//! * **Never fatal** — a failed copy degrades to "fresh profile", which is the
//!   state the user would have had anyway. It is recorded, loudly, in forensics.
//!
//! # What this module deliberately does NOT do
//!
//! It does not touch cookies, IndexedDB, caches or `Local State`. Only
//! `Default/Local Storage`. Widening it would mean copying a live Chromium
//! profile, and a half-copied profile is a worse failure than a fresh one.
//!
//! ⚠️ **Windows only, and by mechanism rather than by `#[cfg]`.** The whole thing
//! keys on `%LOCALAPPDATA%`, which no other platform sets. macOS does not use a
//! `data_directory` at all (WKWebView), and the first macOS `.app` was never
//! launched (`app_dirs.rs`), so there is no macOS state to carry. Linux WOULD be
//! affected (`dirs::data_local_dir()`), and is knowingly not covered here — the
//! same open account `app_dirs.rs` already registers for Linux. Written without
//! a `cfg(not(windows))` arm on purpose: this box cannot compile one, so a branch
//! here would be a promise no gate in this repo could check.

use std::path::{Path, PathBuf};

/// The identifier this build ships on Windows.
///
/// Mirrors `tauri.conf.json`'s `identifier`, whose SSOT is
/// `scripts/package-ids.mjs` (`PACKAGE_IDS.windows`). Rust cannot read the
/// config before the Tauri builder exists — and this migration must run BEFORE
/// the first webview is created — so the value is stated here and pinned by
/// [`tests::current_leaf_matches_tauri_conf`], which reads the JSON.
pub const CURRENT_PROFILE_LEAF: &str = "app.flowmic.windows";

/// The identifier this product shipped under before 2026-08-12.
///
/// 🔴 This is the one place in the product where a retired identifier is
/// legitimate, and it has to stay legitimate forever: it is the only address at
/// which a pre-migration user's state can be found.
/// `verify/lint/package-id-family.mjs` exempts THIS FILE BY NAME for exactly
/// this constant — see `LEGACY_DESKTOP_WEBVIEW_DIR` in the SSOT.
pub const LEGACY_PROFILE_LEAF: &str = "cloud.flowmic.desktop";

/// The subtree carried over, relative to a profile root.
const CARRIED: [&str; 3] = ["EBWebView", "Default", "Local Storage"];

/// What a migration attempt did. Every arm is something the forensic log can
/// state as a fact — there is no "nothing happened" that could mean two things.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No `%LOCALAPPDATA%`: not the platform this applies to.
    NotApplicable,
    /// The legacy profile does not exist — a machine that never ran an old build.
    NoLegacyProfile,
    /// The destination already has local storage; a previous run did this.
    AlreadyPresent,
    /// Files copied.
    Migrated { files: usize, bytes: u64 },
    /// Tried and failed. The user gets a fresh profile; the reason is recorded.
    Failed(String),
}

impl Outcome {
    /// One line for the forensic log. A migration nobody can see in the log is a
    /// migration nobody can debug (red line: no silent failure, in both directions).
    pub fn describe(&self) -> String {
        match self {
            Outcome::NotApplicable => "no %LOCALAPPDATA% — nothing to carry".into(),
            Outcome::NoLegacyProfile => {
                format!("no legacy profile at {LEGACY_PROFILE_LEAF} — nothing to carry")
            }
            Outcome::AlreadyPresent => {
                format!("{CURRENT_PROFILE_LEAF} already has Local Storage — no-op")
            }
            Outcome::Migrated { files, bytes } => format!(
                "carried {files} file(s) / {bytes} byte(s) of localStorage from \
                 {LEGACY_PROFILE_LEAF} to {CURRENT_PROFILE_LEAF} (legacy directory left intact)"
            ),
            Outcome::Failed(why) => format!(
                "FAILED to carry localStorage from {LEGACY_PROFILE_LEAF}: {why} — \
                 this launch starts from a fresh profile (UI locale/theme, LAN endpoint, \
                 capsule position reset); the legacy directory was NOT touched"
            ),
        }
    }
}

/// Append the carried subtree to a profile root.
fn carried_dir(root: &Path) -> PathBuf {
    CARRIED.iter().fold(root.to_path_buf(), |p, seg| p.join(seg))
}

/// Pure decision: given a LocalData root, should anything be copied and from
/// where to where?
///
/// Split out from the I/O so the precedence is provable in `cargo test` without
/// touching this machine's real `%LOCALAPPDATA%` — the same discipline
/// `socket::channel` and `app_dirs` already follow.
pub fn plan(local_data: Option<&Path>, legacy: &str, current: &str) -> Result<(PathBuf, PathBuf), Outcome> {
    let Some(base) = local_data else {
        return Err(Outcome::NotApplicable);
    };
    // A rename to the same name is not a migration. Guarded rather than assumed:
    // if some future edit points both constants at one value, silently copying a
    // directory onto itself is the worst available behaviour.
    if legacy == current {
        return Err(Outcome::AlreadyPresent);
    }
    let src = carried_dir(&base.join(legacy));
    let dst = carried_dir(&base.join(current));
    if dst.exists() {
        return Err(Outcome::AlreadyPresent);
    }
    if !src.is_dir() {
        return Err(Outcome::NoLegacyProfile);
    }
    Ok((src, dst))
}

/// Copy the files of one flat directory. `Local Storage/leveldb` is one level
/// down, so this recurses — but only within the subtree `plan` chose.
fn copy_tree(src: &Path, dst: &Path, files: &mut usize, bytes: &mut u64) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to, files, bytes)?;
        } else {
            // A stale Chromium `LOCK` in a copied profile is harmless (leveldb
            // re-acquires it), but copying it is pointless, and a `LOG` from
            // another install is actively misleading in a bug report.
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "LOCK" || name == "LOG" || name == "LOG.old" {
                continue;
            }
            *bytes += std::fs::copy(&from, &to)?;
            *files += 1;
        }
    }
    Ok(())
}

/// Carry `localStorage` from the legacy profile if — and only if — this machine
/// has one and the new profile does not.
///
/// Call BEFORE the Tauri builder creates any window. Never panics, never fails
/// the launch.
pub fn migrate(local_data: Option<&Path>) -> Outcome {
    let (src, dst) = match plan(local_data, LEGACY_PROFILE_LEAF, CURRENT_PROFILE_LEAF) {
        Ok(pair) => pair,
        Err(outcome) => return outcome,
    };
    let mut files = 0usize;
    let mut bytes = 0u64;
    match copy_tree(&src, &dst, &mut files, &mut bytes) {
        Ok(()) => Outcome::Migrated { files, bytes },
        Err(e) => {
            // Leave whatever was written: WebView2 will treat a partial leveldb
            // as corrupt and start fresh, which is the documented degradation.
            // Removing it here would be a second filesystem operation on an error
            // path that just proved the filesystem is not cooperating.
            Outcome::Failed(e.to_string())
        }
    }
}

/// The real entry point: reads `%LOCALAPPDATA%` and records the outcome.
pub fn migrate_from_env() -> Outcome {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let outcome = migrate(base.as_deref());
    crate::forensic::record("webview-profile", &outcome.describe());
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowmic-webview-profile-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_legacy(base: &Path) {
        let ls = carried_dir(&base.join(LEGACY_PROFILE_LEAF));
        std::fs::create_dir_all(ls.join("leveldb")).unwrap();
        std::fs::write(ls.join("leveldb").join("000005.ldb"), b"rows").unwrap();
        std::fs::write(ls.join("leveldb").join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        std::fs::write(ls.join("leveldb").join("LOCK"), b"").unwrap();
    }

    /// 🔴 The card's whole point: the constant here and the shipped config must
    /// be the same string. A Rust constant that has drifted from `tauri.conf.json`
    /// would send the migration to a directory the webview never uses — and it
    /// would do so silently, reporting a successful copy.
    #[test]
    fn current_leaf_matches_tauri_conf() {
        let conf = include_str!("../tauri.conf.json");
        let needle = format!("\"identifier\": \"{CURRENT_PROFILE_LEAF}\"");
        assert!(
            conf.contains(&needle),
            "tauri.conf.json does not declare {needle} — the migration would target a \
             directory the webview does not use"
        );
    }

    #[test]
    fn no_localappdata_is_not_applicable() {
        assert_eq!(migrate(None), Outcome::NotApplicable);
    }

    #[test]
    fn a_machine_with_no_legacy_profile_is_left_alone() {
        let base = tmp("nolegacy");
        assert_eq!(migrate(Some(&base)), Outcome::NoLegacyProfile);
        assert!(!base.join(CURRENT_PROFILE_LEAF).exists());
    }

    #[test]
    fn carries_local_storage_and_leaves_the_legacy_tree_intact() {
        let base = tmp("carry");
        seed_legacy(&base);
        let out = migrate(Some(&base));
        // LOCK is skipped on purpose, so the count is 2 rather than 3 — asserted
        // as a number so the skip cannot silently stop happening.
        assert_eq!(out, Outcome::Migrated { files: 2, bytes: 4 + 16 });
        let dst = carried_dir(&base.join(CURRENT_PROFILE_LEAF));
        assert_eq!(std::fs::read(dst.join("leveldb").join("000005.ldb")).unwrap(), b"rows");
        assert!(!dst.join("leveldb").join("LOCK").exists());
        // Non-destructive, asserted rather than intended.
        assert!(carried_dir(&base.join(LEGACY_PROFILE_LEAF)).join("leveldb").join("000005.ldb").exists());
    }

    #[test]
    fn running_twice_copies_once() {
        let base = tmp("idempotent");
        seed_legacy(&base);
        assert!(matches!(migrate(Some(&base)), Outcome::Migrated { .. }));
        assert_eq!(migrate(Some(&base)), Outcome::AlreadyPresent);
    }

    /// A user who already has state under the NEW id must never have it
    /// overwritten by a stale legacy profile — that would be the migration
    /// destroying newer data while reporting success.
    #[test]
    fn an_existing_new_profile_wins() {
        let base = tmp("newwins");
        seed_legacy(&base);
        let dst = carried_dir(&base.join(CURRENT_PROFILE_LEAF));
        std::fs::create_dir_all(dst.join("leveldb")).unwrap();
        std::fs::write(dst.join("leveldb").join("000005.ldb"), b"newer").unwrap();
        assert_eq!(migrate(Some(&base)), Outcome::AlreadyPresent);
        assert_eq!(std::fs::read(dst.join("leveldb").join("000005.ldb")).unwrap(), b"newer");
    }

    /// Degenerate config guard — see `plan`.
    #[test]
    fn identical_leaves_never_copy() {
        let base = tmp("same");
        seed_legacy(&base);
        assert_eq!(
            plan(Some(&base), LEGACY_PROFILE_LEAF, LEGACY_PROFILE_LEAF).unwrap_err(),
            Outcome::AlreadyPresent
        );
    }

    /// Every arm has to be sayable. An outcome whose description is empty would
    /// produce a forensic line that reads as「nothing was recorded」.
    #[test]
    fn every_outcome_says_something() {
        for o in [
            Outcome::NotApplicable,
            Outcome::NoLegacyProfile,
            Outcome::AlreadyPresent,
            Outcome::Migrated { files: 1, bytes: 2 },
            Outcome::Failed("disk full".into()),
        ] {
            assert!(!o.describe().is_empty());
        }
    }
}
