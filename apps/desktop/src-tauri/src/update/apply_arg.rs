// UP-3b — the mover process: how it is started, and what it does.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.3 ④b/④c, §4.4
//   docs/decisions/2026-08-05-owner-build-and-release-additions.md
//     (owner **2026-08-04 ②**「便携版真原地升级」("the portable edition truly
//     upgrades in place") — see swap.rs on the date)
//
// ── 🔴 THE MOVER IS A COPY OF THE *CURRENT* BINARY, NOT THE NEW ONE ─────────
//
// This is the single most load-bearing decision in the file, and it is easy to
// get backwards because the other choice looks more natural (「the new build
// should install itself」).
//
//   • A copy of the CURRENT binary runs code that THIS build tested. The job
//     file below is written by one `derive` and read by the same `derive`,
//     compiled together, in one binary. There is no contract between two
//     versions, therefore no version skew to get wrong.
//   • A copy of the NEW binary would mean version N hands arguments to version
//     N+1's parser, forever, for every future N. That is a CLI contract with an
//     unbounded compatibility surface — and one that can only be tested by
//     having two real builds, which is exactly the condition that does not exist
//     while you are writing it.
//
// ── 🔴 AND IT MUST BE INTERCEPTED AT THE VERY TOP OF `main()` ───────────────
//
// Before the single-instance lock. Before any window. Before the sidecar.
//
// The failure mode if this is done late is not a crash, it is a DEADLOCK, and it
// deadlocks against the very thing it is waiting for: the mover waits for the app
// to release its image lock, while `single_instance::acquire` refuses the mover
// because the app still holds the instance lock — and the app is waiting to be
// replaced. Nothing times out; the user watches an update that never happens.
//
// The ordering is asserted two ways rather than trusted: a literal-anchor test
// reads `lib.rs` and fails if `acquire` appears before the intercept, and the
// real-machine evidence for this card ran a mover to completion **while another
// FlowMic held that exact lock**. A lock-gated mover could not have finished.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::breadcrumb;
use super::failure::UpdateFailure;
use super::swap::{self, SwapJob, SwapOutcome};

/// The flag. Long and product-prefixed so it cannot collide with a Tauri, WebView
/// or OS-injected argument.
pub const APPLY_UPDATE_ARG: &str = "--flowmic-apply-update";

/// Directory the mover runs from — deliberately NOT the install directory.
///
/// 🔴 Structural, not tidiness: the install directory is the thing being renamed
/// away. A mover living inside it would be renaming the ground it stands on, and
/// its own image lock would be the reason the rename fails.
pub fn mover_dir() -> PathBuf {
    crate::app_dirs::local_home().join("updates").join("mover")
}

/// File name of the mover copy. Distinct from `FlowMic.exe` so that a stray copy
/// is identifiable in a process list and can never be mistaken for an install.
pub const MOVER_EXE_NAME: &str = "FlowMic-update-mover.exe";
/// File name of the job file.
pub const JOB_FILE_NAME: &str = "swap-job.json";

/// Is this process a mover, and if so which job?
///
/// **Pure** — takes the argument list rather than reading `std::env::args`, so the
/// parse is testable against fabricated command lines. Matches `--flag value`;
/// a flag with no value is `None`, because a mover with no job is not a mover.
pub fn job_path_from_args(args: &[String]) -> Option<PathBuf> {
    job_path_for(APPLY_UPDATE_ARG, args)
}

/// The same parse, for any of this crate's job-carrying flags.
///
/// Generalised (0.3.8) when the MSI chain grew its own detached helper — see
/// `msi::RUN_INSTALLER_ARG`. One parser, so the two flags cannot acquire
/// different opinions about `--flag=value`; a second copy is how the two would
/// drift, and the drift would only show up as a detached process that quietly
/// starts the normal app instead of doing its job.
pub fn job_path_for(flag: &str, args: &[String]) -> Option<PathBuf> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == flag {
            return it.next().map(PathBuf::from);
        }
        // `--flag=value` — accepted because it is the spelling a human debugging
        // this will reach for first, and refusing it would produce a process that
        // silently starts the normal app instead of moving anything.
        if let Some(rest) = a.strip_prefix(&format!("{flag}=")) {
            if !rest.is_empty() {
                return Some(PathBuf::from(rest));
            }
        }
    }
    None
}

/// Read a job file.
pub fn read_job(path: &Path) -> Option<SwapJob> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Perform one swap, start to finish. **This is the whole mover.**
///
/// Returns the outcome so the caller can set an exit code — but note that
/// **nobody reads that exit code**: the mover is detached and its parent is gone.
/// The channel that matters is the breadcrumb.
///
/// A thin binding of [`run_swap_with`] to this machine. The sequence itself lives
/// there, where the three inputs that would otherwise make it unobservable are
/// parameters.
pub fn run_swap(job: &SwapJob) -> SwapOutcome {
    run_swap_with(job, swap::WAIT_TIMEOUT, &crate::app_dirs::local_home(), relaunch)
}

/// The mover's sequence, with its three machine-dependent inputs handed in: how
/// long to wait for the image lock, where the breadcrumb lives, and how to start
/// a program.
///
/// Parameters for the reason every other seam in this module is one
/// (`spawn_mover` takes `source_exe`, `swap::prepare` takes `breadcrumb_dir`,
/// `breadcrumb::write_in` takes the directory): a function that can only consult
/// the real 90-second budget, the real `%LOCALAPPDATA%` and a real detached
/// `CreateProcess` can only be asked about the machine it happens to be running
/// on — and the branch that most needs asking is the one that takes 90 seconds to
/// reach and then leaves no observable trace at all.
fn run_swap_with(
    job: &SwapJob,
    wait_timeout: Duration,
    breadcrumb_dir: &Path,
    mut launch: impl FnMut(&Path) -> std::io::Result<u32>,
) -> SwapOutcome {
    crate::forensic::record(
        "update",
        &format!("mover start — {} → {} (pid {})", job.from, job.to, std::process::id()),
    );

    // Wait for the app to really let go. `can_replace_file`, not「did the PID
    // vanish」— see swap.rs.
    //
    // 🔴 THE TIMEOUT MINTS AN OUTCOME AND FALLS THROUGH — it does not return.
    //
    // The recovery that every failure needs — put the user's application back on
    // screen, take the staging tree with us — is written ONCE, in the `Failed`
    // arm below, and the `nothing_moved:` prefix minted here is exactly what that
    // arm reads. An early return mints the string and then never reaches the rule
    // that acts on it: the user watched FlowMic close, nothing comes back, and
    // ~103 MB is left beside the install directory. That was the shipped
    // behaviour, and it is why this is an expression feeding the one match rather
    // than two lines copied into a branch — a second recovery block is how the
    // two drift apart later.
    let outcome = if swap::wait_replaceable(&job.wait_exe, wait_timeout) {
        swap::apply_swap(job)
    } else {
        SwapOutcome::Failed {
            detail: "nothing_moved:timeout_waiting_for_lock".to_string(),
            rolled_back: false,
        }
    };

    match &outcome {
        SwapOutcome::Swapped => {
            crate::forensic::record("update", "mover swapped the install directory");
            // 🔴 Relaunch BEFORE cleanup. Deleting ~103 MB of backup can take a
            // moment, and the user is currently staring at no application at all.
            match launch(&job.relaunch_exe) {
                Ok(pid) => crate::forensic::record(
                    "update",
                    &format!("mover relaunched FlowMic (pid {pid})"),
                ),
                Err(e) => crate::forensic::record(
                    "update",
                    &format!("mover could NOT relaunch FlowMic ({e}) — the new copy is in place, it just is not running"),
                ),
            }
            let (backup, staging) = swap::cleanup(job);
            crate::forensic::record(
                "update",
                &format!("mover cleanup — backup removed: {backup}, staging removed: {staging}"),
            );
        }
        SwapOutcome::Failed { detail, rolled_back } => {
            crate::forensic::record(
                "update",
                &format!("mover FAILED — {detail} (rolled back: {rolled_back})"),
            );
            note_outcome_for(&job.to, breadcrumb_dir, detail);
            // The old tree is back (or never left). Start it, so the user gets
            // their application back without having to find the icon themselves.
            if *rolled_back || detail.starts_with("nothing_moved") {
                let _ = launch(&job.relaunch_exe);
            }
            let _ = std::fs::remove_dir_all(&job.staging_dir);
        }
    }
    outcome
}

/// Append a detached helper's verdict to the breadcrumb the app left behind.
///
/// 🔴 This is the ONLY way a failure that happened after the app exited can reach
/// a user. Read-modify-write rather than a fresh file: the app owns `from`/`to`
/// and the helper owns `detail`, and inventing the first two here would put a
/// second author on fields that already have one.
///
/// `dir` is a parameter for the same reason `breadcrumb::write_in`'s is — and for
/// one more: a test that reached this line while it resolved `%LOCALAPPDATA%`
/// itself would be rewriting the developer's own pending-update file.
///
/// ⚠️ `to` rather than a whole job (0.3.8): both detached helpers annotate the
/// same file now, and 「is this attempt mine to annotate」 is the same question
/// for both. The MSI runner passes its own `to` — see `msi::run_install_with`.
pub(crate) fn note_outcome_for(to: &str, dir: &Path, detail: &str) {
    let Some(mut crumb) = breadcrumb::read_in(dir) else {
        // No breadcrumb to annotate. Do not fabricate one: a breadcrumb the app
        // never wrote would claim an attempt the app does not know it made.
        crate::forensic::record(
            "update",
            &format!("helper has no breadcrumb to annotate (detail was: {detail})"),
        );
        return;
    };
    if crumb.to != to {
        // Somebody else's attempt. Leave it alone.
        return;
    }
    crumb.detail = Some(detail.to_string());
    let _ = breadcrumb::write_in(dir, &crumb);
}

/// Start a program, detached, and do not wait for it.
///
/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` so the child outlives us and is
/// not signalled with us.
///
/// ⚠️ **A residual risk, stated rather than assumed away**: a child inherits Job
/// Object membership, so if some ancestor had put THIS process into a job with
/// `KILL_ON_JOB_CLOSE`, the mover would die with us. `CREATE_BREAKAWAY_FROM_JOB`
/// is deliberately NOT used to prevent that — it makes `CreateProcess` FAIL
/// outright when the job forbids breakaway, which would convert a rare
/// hypothetical into a common real failure. This product's own job usage is
/// child-only (`sidecar::job::bind` opens the child by pid and assigns only it),
/// so we are not in one by our own doing.
pub fn spawn_detached(exe: &Path, args: &[String]) -> std::io::Result<u32> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|c| c.id())
}

fn relaunch(exe: &Path) -> std::io::Result<u32> {
    spawn_detached(exe, &[])
}

/// Stage a mover and start it. Called by the app, just before it exits.
///
/// Copies `source_exe` into `mover_dir()`, writes the job beside it, and starts
/// it detached. Returns the mover's pid for the forensic record.
///
/// 🔴 `source_exe` MUST be the currently running binary — see the module header
/// for why it is this one and not the new build. It is a PARAMETER rather than an
/// internal `current_exe()` call for the reason every other seam in this module
/// is (`form::classify_exe_path` takes the registered directories,
/// `archive::verify_root` takes the expected root, `breadcrumb::write_in` takes
/// the directory): a function that can only consult the real process can only be
/// exercised against the machine it happens to be running on. Production has
/// exactly one caller and it passes `std::env::current_exe()`.
pub fn spawn_mover(job: &SwapJob, source_exe: &Path) -> Result<u32, UpdateFailure> {
    let fail = |detail: String| UpdateFailure::MoverNotLaunched { detail };
    let dir = mover_dir();
    std::fs::create_dir_all(&dir).map_err(|e| fail(format!("mkdir:{}", e.kind())))?;

    let current = source_exe.to_path_buf();
    let mover = dir.join(MOVER_EXE_NAME);
    // A previous mover copy may still be on disk; overwrite it. If one is somehow
    // still RUNNING, the copy fails and we say so rather than starting a stale
    // binary against a fresh job.
    std::fs::copy(&current, &mover).map_err(|e| fail(format!("copy:{}", e.kind())))?;

    let job_path = dir.join(JOB_FILE_NAME);
    let json = serde_json::to_string_pretty(job).map_err(|e| fail(format!("serialize:{e}")))?;
    std::fs::write(&job_path, json).map_err(|e| fail(format!("write_job:{}", e.kind())))?;

    spawn_detached(&mover, &[APPLY_UPDATE_ARG.to_string(), job_path.display().to_string()])
        .map_err(|e| fail(format!("spawn:{}", e.kind())))
}

/// 🔴 The interception point. Call this as the FIRST statement of `run()`.
///
/// Returns `true` when this process was a mover and has finished its work — the
/// caller must then return immediately, having started no window, no sidecar and
/// above all having taken no lock.
///
/// Forensics are initialised HERE rather than relying on the caller, because the
/// caller's initialisation happens further down the function this returns before.
/// A mover that left no trace would be indistinguishable from one that never ran.
pub fn intercept() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(job_path) = job_path_from_args(&args) else {
        return false;
    };
    crate::forensic::init_default();
    match read_job(&job_path) {
        Some(job) => {
            run_swap(&job);
        }
        None => crate::forensic::record(
            "update",
            &format!("mover started with an unreadable job file at {} — doing nothing", job_path.display()),
        ),
    }
    true
}

#[cfg(test)]
#[path = "apply_arg_tests.rs"]
mod tests;

/// 🔴 `run_swap`'s recovery — what actually happens to the user after each
/// outcome, driven end to end rather than reasoned about.
///
/// These go through `run_swap_with`, and its three parameters are what make the
/// coverage possible at all: the 90-second budget becomes 5 ms, the breadcrumb
/// lands in a throwaway directory instead of this machine's `%LOCALAPPDATA%`,
/// and「start a program」becomes a recorder instead of a detached process that
/// nothing can observe. Before those existed the timeout branch was unreachable
/// from a test, and it shipped never relaunching anything.
#[cfg(test)]
mod run_swap_tests {
    use super::*;
    use std::cell::RefCell;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fm-mover-run-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A breadcrumb this attempt is entitled to annotate (`to` matches the job).
    fn crumb_for(job: &SwapJob) -> breadcrumb::Breadcrumb {
        breadcrumb::Breadcrumb {
            from: job.from.clone(),
            to: job.to.clone(),
            kind: breadcrumb::PendingKind::Portable,
            started_at: "2026-08-10T00:00:00.000Z".to_string(),
            detail: None,
        }
    }

    /// 🔴 THE ONE THIS FILE GOT WRONG.
    ///
    /// Something held the image lock past the budget, so nothing moved. The
    /// install is intact and the update simply did not happen — but the user
    /// watched FlowMic close to make room for it, and at this instant is looking
    /// at no application at all. Both effects are asserted because the shipped
    /// code produced NEITHER: the timeout returned before the `Failed` arm that
    /// relaunches and removes the staging tree, so the app stayed closed and
    /// ~103 MB was left beside the install directory.
    #[test]
    fn a_timeout_still_brings_the_app_back_and_takes_the_staging_tree_with_it() {
        let dir = scratch("timeout");
        let install = dir.join("FlowMic");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("keep.txt"), b"untouched").unwrap();

        let mut job = swap::plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();
        // Nothing can ever make this replaceable: `can_replace_file` answers
        // false for a path that is not there, by design. A file held open would
        // be a closer reproduction, but `share_mode(0)` is Windows-only and this
        // file has no `cfg` sites — the branch under test is identical either
        // way, since `wait_replaceable` only ever sees a bool.
        job.wait_exe = dir.join("a-lock-that-never-clears.exe");

        // The staging tree the real failure left behind, in miniature.
        std::fs::create_dir_all(&job.staged_root).unwrap();
        std::fs::write(job.staging_dir.join("staged.bin"), b"the new tree").unwrap();
        breadcrumb::write_in(&dir, &crumb_for(&job)).unwrap();

        let launched: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
        let outcome = run_swap_with(&job, Duration::from_millis(5), &dir, |exe: &Path| {
            launched.borrow_mut().push(exe.to_path_buf());
            Ok(4242)
        });

        // ① The user gets their application back.
        assert_eq!(
            launched.into_inner(),
            vec![job.relaunch_exe.clone()],
            "a mover that gave up must still start the install it never replaced — \
             the user is staring at no application at all",
        );
        // ② …and the ~103 MB goes with us.
        assert!(
            !job.staging_dir.exists(),
            "the staging tree must not survive a swap that never happened: {}",
            job.staging_dir.display(),
        );
        // ③ The verdict still reaches the breadcrumb — the only channel a failure
        //    after the app's exit has — and says nothing moved.
        assert_eq!(
            breadcrumb::read_in(&dir).unwrap().detail.as_deref(),
            Some("nothing_moved:timeout_waiting_for_lock"),
        );
        // ④ `rolled_back: false` because nothing was ever parked. Claiming a
        //    rollback here would be a different lie.
        assert_eq!(
            outcome,
            SwapOutcome::Failed {
                detail: "nothing_moved:timeout_waiting_for_lock".to_string(),
                rolled_back: false,
            },
        );
        // And the install directory was never touched.
        assert_eq!(std::fs::read(install.join("keep.txt")).unwrap(), b"untouched");
    }

    /// The reverse control: with the lock free, the same call performs the real
    /// swap. Routing the timeout into the shared `Failed` arm must not have moved
    /// anything on the path that works.
    ///
    /// 🔴 The ordering assertion is the point of the recorder here: it asks
    /// whether the backup still exists AT THE MOMENT the relaunch is attempted.
    /// Relaunch comes BEFORE cleanup because deleting ~103 MB takes a moment the
    /// user would spend looking at nothing, and no ordinary assertion on the
    /// final state can see the difference — both orders end with the backup gone.
    #[test]
    fn a_free_lock_still_swaps_then_relaunches_before_it_cleans_up() {
        let dir = scratch("swapped");
        let install = dir.join("FlowMic");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("old.txt"), b"old").unwrap();
        // `plan` points `wait_exe` at this; an existing writable file is
        // replaceable, so the wait is satisfied on its first poll.
        std::fs::write(install.join(super::super::form::PORTABLE_EXE_NAME), b"MZ").unwrap();

        let job = swap::plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();
        std::fs::create_dir_all(&job.staged_root).unwrap();
        std::fs::write(job.staged_root.join("new.txt"), b"new").unwrap();
        breadcrumb::write_in(&dir, &crumb_for(&job)).unwrap();

        let seen: RefCell<Vec<(PathBuf, bool)>> = RefCell::new(Vec::new());
        let outcome = run_swap_with(&job, Duration::from_millis(5), &dir, |exe: &Path| {
            seen.borrow_mut().push((exe.to_path_buf(), job.backup_dir.exists()));
            Ok(7)
        });

        assert_eq!(outcome, SwapOutcome::Swapped);
        assert_eq!(
            seen.into_inner(),
            vec![(job.relaunch_exe.clone(), true)],
            "the new install must be started ONCE, and while the backup is still \
             there — i.e. before cleanup, not after it",
        );
        assert_eq!(std::fs::read(install.join("new.txt")).unwrap(), b"new");
        assert!(!install.join("old.txt").exists(), "the old tree must be gone from the install dir");
        assert!(!job.backup_dir.exists() && !job.staging_dir.exists(), "cleanup must have run");
        // A success has nothing to say to the breadcrumb — the next launch reads
        // it by comparing versions, not by trusting a note from the mover.
        assert_eq!(breadcrumb::read_in(&dir).unwrap().detail, None);
    }
}
