// UP-3b — 🔴 the portable in-place swap.
//
// SPEC-REF:
//   docs/decisions/2026-08-05-owner-build-and-release-additions.md
//     ⚠️ read the DATE qualifier: the ruling this file implements is
//     **owner 2026-08-04 ②「便携版真原地升级」**("the portable edition truly
//     upgrades in place"), which SUPERSEDES design §4.5's
//     default of (c) 通知即可 ("notify is enough"). CLAUDE.md records that
//     these two ② are different
//     rulings in different numbering schemes and that dropping the date has
//     already caused one window to fuse them.
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.4 (getting back to
//     a usable state)
//
// ── THE ONE PARAGRAPH THAT MATTERS ──────────────────────────────────────────
//
// Design §4.4 chose msiexec over a hand-written mover with an argument that
// applies with FULL force to this file, and it is quoted here rather than
// paraphrased because this file is the thing it warned about:
//
// > 「我们自己写的搬运工，回滚也得我们自己写 —— 而**没被真机跑过的回滚等于没有
// >  回滚**。」("If we write our own mover, we have to write our own rollback
// > too — and **a rollback that has never run on a real machine is the same as
// > having no rollback**.")
//
// The owner's ruling took the choice away, not the warning. So: the rollback is
// written, and it is exercised by a test that watches a mid-swap failure leave
// the install directory byte-for-byte intact — the reverse control, not the happy
// path. A rollback whose only evidence is that it compiles is the thing §4.4 says
// does not exist.
//
// ── WHY A RENAME DANCE AND NOT A COPY ───────────────────────────────────────
//
// Everything below happens INSIDE ONE DIRECTORY (`install_dir`'s parent), and
// that constraint is load-bearing in three separate ways:
//
//   1. A rename within a volume is a directory-entry edit — near-instant and
//      atomic. A cross-volume "rename" is silently a copy + delete, which for a
//      ~103 MB tree means seconds of a half-existing install and a whole new
//      failure mode (partial copy, disk full at 90%).
//   2. `fs::rename` on Windows REFUSES an existing destination. That is why the
//      old tree must move OUT before the new one moves IN, and it is what makes
//      the window of "no install directory at all" exactly one rename wide.
//   3. It means the preflight probe — create a sibling, rename it, delete it —
//      tests the exact permission the real operation needs, on the exact
//      directory it needs it on.
//
// ── AND WHY NONE OF IT RUNS IN THE APP ──────────────────────────────────────
//
// Windows lets you rename a directory containing a running image, but not delete
// or overwrite that image. More to the point, after the swap the old binary is
// gone and something has to start the new one. So the mover is a separate
// process; see `apply_arg.rs` for what that process is and why it is a copy of
// THIS binary.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::failure::UpdateFailure;
use super::form::can_replace_file;

/// Files that must be present in a staged tree before we will put it in place.
///
/// 🔴 This list is not a guess and it is not maintained by good intentions: a
/// test below reads `scripts/install-local.mjs`'s own `REQUIRED_FILES` as DATA
/// and asserts the two agree. That script has been deciding what a complete
/// portable copy is for several versions; a second, quietly diverging opinion in
/// Rust is the「一个东西回答了两个问题」("one thing answers two questions") shape, and the divergence would only ever
/// be discovered by shipping a broken swap.
pub const REQUIRED_STAGED_FILES: &[&str] = &[
    "FlowMic.exe",
    "node.exe",
    "resources/server.js",
    "resources/package.json",
    // ENG-1 / fix-028 — the sherpa addon ships beside the sidecar because the
    // stock STT seed is `builtin-sherpa-local`. A portable copy without it
    // installs, starts, and then dies on its first utterance with
    // "Cannot find module 'sherpa-onnx-node'" (the 0.2.61 shape), so an
    // in-place UPDATE that dropped it would turn a working install into that.
    // The native binary is named, not the package dir: the half-staged shape
    // (glue present, native absent) resolves and still cannot transcribe.
    "resources/node_modules/sherpa-onnx-node/package.json",
    "resources/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node",
];

/// How long the mover waits for the app's image lock to clear.
///
/// Generous because the cost of being wrong is asymmetric: waiting too long shows
/// the user a few extra seconds with no window, while giving up too early aborts
/// an update that was about to succeed. Antivirus scanners routinely hold an
/// image open for seconds after exit.
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(90);
/// Poll interval while waiting.
pub const WAIT_POLL: Duration = Duration::from_millis(250);

/// Everything the mover needs, in one file.
///
/// 🔴 **The mover is a copy of the CURRENT binary** (see `apply_arg.rs`), so this
/// struct is written and read by the same `derive` in the same build. That is the
/// strongest available form of「there is no CLI contract between two versions」:
/// there is no version skew to get wrong because both ends were compiled together.
/// Passing four paths as command-line arguments would have re-introduced exactly
/// the quoting-and-ordering contract this avoids — and one of those paths is
/// `C:\Users\…\AppData\Local\Programs\FlowMic`, which contains spaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapJob {
    /// The directory being replaced — the running copy's own home.
    pub install_dir: PathBuf,
    /// The unpacked new tree. Becomes `install_dir`.
    pub staged_root: PathBuf,
    /// Where the old tree is parked. Deleted on success, renamed back on failure.
    pub backup_dir: PathBuf,
    /// The staging parent, removed on the way out. Kept separate from
    /// `staged_root` because the latter is renamed AWAY and cannot clean up after
    /// itself.
    pub staging_dir: PathBuf,
    /// The file whose replaceability means "the app has really let go".
    pub wait_exe: PathBuf,
    /// What to start when the new tree is in place.
    pub relaunch_exe: PathBuf,
    pub from: String,
    pub to: String,
}

/// How the swap ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapOutcome {
    /// `install_dir` now holds the new tree.
    Swapped,
    /// It does not. `rolled_back` answers the only question a user has left.
    ///
    /// 🔴 `rolled_back: false` covers two situations and they are NOT the same
    /// night for the user: nothing had moved yet (harmless), or the rollback
    /// itself failed (the install directory is not there). `detail` distinguishes
    /// them — `nothing_moved:…` vs `rollback_failed:…` — because a single boolean
    /// that answers「is your app still installed」with「no」in both cases would be
    /// this repo's headline bug shape.
    Failed { detail: String, rolled_back: bool },
}

/// Can this location be updated in place — asked of the filesystem, now?
///
/// Creates a sibling directory next to `install_dir`, renames it, and deletes it.
/// Those are the three operations the real swap performs, on the one directory
/// whose permissions decide the outcome (`fs::rename` needs write access on the
/// PARENT, for both the source and the destination name).
///
/// 🔴 **This must run BEFORE we exit, and its whole value is the timing.** A
/// portable copy can be sitting in `C:\Program Files\`, on a read-only share, or
/// in a directory an administrator has locked down. Discovering that AFTER the
/// app has quit means the user watches FlowMic close and never come back, with
/// the explanation trapped in a process that no longer exists. Failing here costs
/// them a sentence; failing later costs them their application.
///
/// ⚠️ **A sample, not a guarantee** — the same caveat `can_replace_file` carries.
/// It proves the parent was writable a moment ago. It cannot prove that
/// `install_dir` itself is free of foreign handles, and nothing can: that is why
/// the mover still checks every rename's result and rolls back.
pub fn preflight(install_dir: &Path) -> Result<(), UpdateFailure> {
    let refuse = |detail: String| UpdateFailure::LocationNotUpdatable { detail };
    if !install_dir.is_dir() {
        return Err(refuse("install_dir_missing".to_string()));
    }
    let Some(parent) = install_dir.parent() else {
        // A drive root has no parent to rename within. Real: somebody unzipped
        // the bundle to `D:\`.
        return Err(refuse("no_parent".to_string()));
    };
    let probe = parent.join(format!(".flowmic-preflight-{}", unique_suffix()));
    let renamed = parent.join(format!(".flowmic-preflight-{}-r", unique_suffix()));
    if let Err(e) = std::fs::create_dir(&probe) {
        return Err(refuse(format!("create:{}", e.kind())));
    }
    if let Err(e) = std::fs::rename(&probe, &renamed) {
        let _ = std::fs::remove_dir(&probe);
        return Err(refuse(format!("rename:{}", e.kind())));
    }
    if let Err(e) = std::fs::remove_dir(&renamed) {
        // We could rename but not clean up. Not fatal to the update — say so and
        // continue, rather than refusing over a leftover empty directory.
        crate::forensic::record(
            "update",
            &format!("preflight probe left behind (remove: {}) — continuing", e.kind()),
        );
    }
    Ok(())
}

/// A per-attempt suffix. Not security-relevant — it only has to stop two attempts
/// (or a leftover from a crashed one) from colliding on a name.
fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Where the pieces of one attempt live, all siblings of `install_dir`.
pub fn plan(install_dir: &Path, to: &str, from: &str, staged_root_name: &str) -> Option<SwapJob> {
    let parent = install_dir.parent()?;
    let staging_dir = parent.join(format!(".flowmic-update-{to}-{}", unique_suffix()));
    let exe_name = install_dir.join(super::form::PORTABLE_EXE_NAME);
    Some(SwapJob {
        staged_root: staging_dir.join(staged_root_name),
        backup_dir: parent.join(format!(".flowmic-backup-{from}-{}", unique_suffix())),
        staging_dir,
        wait_exe: exe_name.clone(),
        relaunch_exe: exe_name,
        install_dir: install_dir.to_path_buf(),
        from: from.to_string(),
        to: to.to_string(),
    })
}

/// Is a staged tree actually a FlowMic?
///
/// 🔴 Checked because `verify_root` answers a DIFFERENT question. That one says
/// 「the archive's top level is the directory I expected」; this one says 「the
/// files that make the product work are present」. An archive could satisfy the
/// first and be an empty directory. We are about to delete the user's working
/// copy — the last look before that happens should be at what is going in, not at
/// what it is called.
pub fn sanity_check_staged(root: &Path) -> Result<(), UpdateFailure> {
    let mut missing = Vec::new();
    for rel in REQUIRED_STAGED_FILES {
        let p = rel.split('/').fold(root.to_path_buf(), |acc, seg| acc.join(seg));
        // Zero bytes counts as missing: a truncated write leaves a file that
        // `exists()` is perfectly happy with, and a 0-byte `FlowMic.exe` would
        // pass a presence check and then fail to start with no explanation.
        let ok = std::fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
        if !ok {
            missing.push((*rel).to_string());
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(UpdateFailure::StagedTreeIncomplete { missing })
    }
}

/// A staged, checked, breadcrumbed swap that is ready to hand to a mover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub job: SwapJob,
    pub extracted: super::extract::ExtractReport,
}

/// 🔴 **Everything that must succeed BEFORE this process is allowed to exit.**
///
/// The ORDER of these steps is the card, not an implementation detail:
///
/// ```text
///   1. preflight        ← can this location be replaced at all?
///   2. verify_root      ← is the archive shaped the way we believe?
///   3. extract          ← ~103 MB onto the disk
///   4. sanity check     ← is what came out a FlowMic?
///   5. breadcrumb       ← the last thing, because it announces an attempt
/// ```
///
/// Preflight is first because it is the only check whose value is entirely in
/// its TIMING. Every other failure here is discovered while the app is still on
/// screen and can say so; an unwritable location discovered after the exit is a
/// user watching their application close and not come back.
///
/// 🔴 A reverse control in `swap_tests.rs` deletes step 1 and watches this go
/// red — the assertion is not「it returned an error」but「it returned an error
/// AND no staging directory and no breadcrumb exist」, i.e. nothing that leads to
/// an exit has happened yet. Without step 1, an install directory that was moved
/// or deleted while the app ran gets a full extraction and a breadcrumb, and the
/// failure surfaces only in the mover — after everything is gone.
///
/// `breadcrumb_dir` is a parameter for the usual reason: a function that only
/// consults the real `%LOCALAPPDATA%` can only be asked about this machine.
pub fn prepare(
    install_dir: &Path,
    archive: &Path,
    expected_root: &str,
    from: &str,
    to: &str,
    breadcrumb_dir: &Path,
) -> Result<Prepared, UpdateFailure> {
    // 1. 🔴 FIRST. See above.
    preflight(install_dir)?;

    // 2. The archive is what we think it is. `expected_root` is required by
    //    `archive::verify_root` precisely so this line cannot be written without
    //    stating a belief that can be wrong.
    super::archive::verify_root(archive, expected_root)?;

    let Some(job) = plan(install_dir, to, from, expected_root) else {
        return Err(UpdateFailure::LocationNotUpdatable { detail: "no_parent".to_string() });
    };

    // 3. Onto the disk. From here on, failures must clean up after themselves —
    //    a half-extracted staging directory left beside the install directory is
    //    ~100 MB of litter that the next attempt would collide with.
    let extracted = match super::extract::extract_into(archive, &job.staging_dir) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&job.staging_dir);
            return Err(e);
        }
    };

    // 4. Is it a product? Asked immediately before the user's working copy
    //    becomes replaceable.
    if let Err(e) = sanity_check_staged(&job.staged_root) {
        let _ = std::fs::remove_dir_all(&job.staging_dir);
        return Err(e);
    }

    // 5. Last, because writing it is the moment an attempt becomes a thing that
    //    happened. A breadcrumb written earlier and then abandoned would make the
    //    NEXT launch report a failed update that never actually started.
    if let Err(e) = super::breadcrumb::write_in(
        breadcrumb_dir,
        &super::breadcrumb::Breadcrumb {
            from: from.to_string(),
            to: to.to_string(),
            kind: super::breadcrumb::PendingKind::Portable,
            started_at: super::prefs::now_iso8601(),
            detail: None,
        },
    ) {
        let _ = std::fs::remove_dir_all(&job.staging_dir);
        return Err(UpdateFailure::CannotWrite { detail: format!("breadcrumb:{}", e.kind()) });
    }

    Ok(Prepared { job, extracted })
}

/// Poll `ready` until it answers true or `timeout` elapses.
///
/// The predicate is INJECTED so the waiting logic is testable without a real
/// image lock — the alternative is a test that either sleeps for 90 real seconds
/// or does not test the timeout at all.
pub fn wait_until(mut ready: impl FnMut() -> bool, timeout: Duration, poll: Duration) -> bool {
    let start = Instant::now();
    loop {
        if ready() {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(poll);
    }
}

/// Wait for the old executable to become replaceable.
///
/// 🔴 **`can_replace_file`, not「did the PID vanish」.** `form.rs` states the
/// reason at length and `scripts/install-local.mjs` learned it the expensive way:
/// a PID can disappear while a handle lingers, an antivirus scanner can hold an
/// image open for seconds after exit, and a second user session can be running
/// the same binary invisibly. 「Has the process exited」 is a proxy for the thing
/// we need; 「can I open this for writing」 IS the thing we need, asked of the OS,
/// about the file.
pub fn wait_replaceable(exe: &Path, timeout: Duration) -> bool {
    wait_until(|| can_replace_file(exe), timeout, WAIT_POLL)
}

/// The rename dance. **The only function that moves the user's install.**
///
/// ```text
///   rename install_dir → backup_dir      ① after this, there is no install dir
///   rename staged_root → install_dir     ② after this, the new one is live
///        └ on failure: rename backup_dir → install_dir   (rollback)
/// ```
///
/// Between ① and ② the product is not installed anywhere. That window is one
/// directory-entry edit wide and it cannot be removed — Windows will not let the
/// new tree take a name that is still occupied. What CAN be done is make sure it
/// is never left open, which is what the rollback is for.
///
/// Takes no side effects beyond those renames: no relaunch, no cleanup, no
/// logging of its own. That is what lets the test drive it against two throwaway
/// directories and inspect the result file-by-file.
pub fn apply_swap(job: &SwapJob) -> SwapOutcome {
    // ① Park the old tree.
    if let Err(e) = std::fs::rename(&job.install_dir, &job.backup_dir) {
        // Nothing has moved. The install directory is untouched, which is the
        // one thing worth saying.
        return SwapOutcome::Failed {
            detail: format!("nothing_moved:park:{}", e.kind()),
            rolled_back: false,
        };
    }
    // ② Put the new tree in its place.
    if let Err(e) = std::fs::rename(&job.staged_root, &job.install_dir) {
        let park_err = e.kind();
        // 🔴 The rollback. Not optional, not best-effort-and-shrug: at this exact
        // instant the user has no application.
        return match std::fs::rename(&job.backup_dir, &job.install_dir) {
            Ok(()) => SwapOutcome::Failed {
                detail: format!("install:{park_err}"),
                rolled_back: true,
            },
            Err(re) => SwapOutcome::Failed {
                // The worst branch on this path, and it gets its own words. The
                // old tree still EXISTS — at `backup_dir` — so the sentence a
                // user needs is not「it's gone」but「it is over there」.
                detail: format!("rollback_failed:{park_err}/{}", re.kind()),
                rolled_back: false,
            },
        };
    }
    SwapOutcome::Swapped
}

/// Remove the leftovers of a completed swap. Best effort, by design.
///
/// A backup we could not delete costs disk space; failing the update over it
/// would cost the user their update. The counts are returned so a forensic line
/// can say what was left behind, which is the difference between best-effort and
/// silent.
pub fn cleanup(job: &SwapJob) -> (bool, bool) {
    let backup = std::fs::remove_dir_all(&job.backup_dir).is_ok();
    let staging = std::fs::remove_dir_all(&job.staging_dir).is_ok();
    (backup, staging)
}

#[cfg(test)]
#[path = "swap_tests.rs"]
mod tests;
