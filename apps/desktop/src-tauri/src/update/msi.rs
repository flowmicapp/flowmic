// UP-3b — the MSI hand-off.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.3 ④ / ⑥, §4.4
//
// ── 🔴 LAUNCH THE INSTALLER *BEFORE* EXITING ────────────────────────────────
//
// Design §4.3 ④b gives the reason, and it is not the one people expect. The
// obvious reason is that Windows will not overwrite a running program — true, but
// secondary. The real one:
//
// > 「我们退出之后就没有进程能再启动任何东西了 ⇒ 拉起安装器必须发生在退出之前。」
// > ("once we exit, there is no process left that can start anything ⇒
// > launching the installer must happen before we exit.")
//
// There is no later. Once this process is gone, nothing on the machine is under
// any obligation to start an installer, and the user sees an application that
// closed itself for no reason. msiexec is spawned DETACHED so it survives us, and
// then we exit through the normal shutdown path.
//
// ── 🔴 WE DID NOT PROMISE A RELAUNCH, AND THAT WAS THE BUG ──────────────────
//
// The original text of this section is worth keeping, because it was RIGHT about
// the mechanism and wrong about what to do with it:
//
// > [measured, design §4.1] the default Tauri WiX template carries no
// > launch-after-install (none of the 20 MSIs inspected had any
// > `WixShellExecTarget` property). So the UI says 「安装完成后请重新打开
// > FlowMic」and not「安装完成后会自动重新打开」. … If a relaunch is ever wanted,
// > §4.3 ⑥ says the correct mechanism is to make the MSI carry it (a WiX change
// > on the artifact side), not to invent a second one here.
//
// 🔴 [measured, owner report 2026-08-17, MSI install of 0.3.7] what the honest
// sentence bought was an honest description of a bad product: 「点了关闭并升级，
// 出现安装窗口后就没了后续，新版本也没启动起来」 ("I pressed close-and-upgrade,
// an installer window appeared and then nothing, and the new version never
// started"). The install SUCCEEDED. Not promising a relaunch does not make the
// missing relaunch acceptable — and the instruction that stood in for it was
// printed on a window that this very chain then closes.
//
// owner's ruling the same day: 「关键是如果是关闭并升级和重启要真的能拉起来，
// 或者要提醒用户如何启动」 ("the point is that close-and-upgrade must really
// bring it back, or else tell the user how to start it"). Both halves are done —
// the relaunch below, and copy that still names the Start-menu route for the case
// where it does not happen.
//
// ── HOW, WITHOUT A WiX CHANGE ───────────────────────────────────────────────
//
// The old note's alternative (make the MSI relaunch us) was rejected here for a
// reason it could not have known: the MSI is built by `tauri build`, so a
// custom action would be a build-time dependency on a template we do not own,
// and it would ship in the artifact — i.e. a fix that can only be tested by
// producing a signed installer. What we do instead reuses the machinery the
// PORTABLE chain already proved on this machine: a detached copy of the CURRENT
// binary, which outlives us, does the waiting, and starts the app afterwards.
//
// 🔴 THE RUNNER SPAWNS msiexec AND WAITS ON IT AS ITS OWN CHILD. That is why
// there is no process-handle code here: 「has the installer finished」 is answered
// by `Child::wait`, the one answer that cannot be wrong, instead of by polling a
// pid (which can be recycled) or a file (which changes mid-install).
//
// 🔴 AND IT RELAUNCHES WHATEVER THE INSTALLER SAID. Success, user-declined UAC,
// or a rolled-back failure — all three end with the user's application back on
// screen, because in all three cases an executable is sitting at that path and
// the alternative is the exact complaint above. The exit code is not discarded:
// it goes to the forensic log and, when it is not a success, onto the breadcrumb,
// so the next launch says 「上次的更新没有完成」 rather than pretending.
//
// ⚠️ **UAC happens after we are gone.** `ALLUSERS=1` [measured §4.1] means every
// install is per-machine, so msiexec will always prompt. The user can decline it,
// and when they do, nothing is installed — which is precisely the state the
// breadcrumb exists to explain on the next launch.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::apply_arg::{job_path_for, note_outcome_for, spawn_detached};
use super::failure::UpdateFailure;

/// `msiexec` — resolved through `PATH` deliberately.
///
/// ⚠️ This is the one place this file departs from the standing lesson of
/// `sidecar::node_runtime` (「问版本，不要排顺序」("ask the version, don't
/// rely on ordering"), and「不要依赖宿主机碰巧装了什么」("don't depend on
/// whatever the host happens to have installed")). It departs for a reason
/// that does not generalise: `msiexec.exe` is a
/// Windows component in `System32`, not something a user may or may not have
/// installed. A machine where it is missing or shadowed cannot install an MSI by
/// any route, including the manual one we would fall back to.
const MSIEXEC: &str = "msiexec.exe";

/// The flag that turns a copy of this binary into the installer runner. Long and
/// product-prefixed for the same reason `APPLY_UPDATE_ARG` is.
pub const RUN_INSTALLER_ARG: &str = "--flowmic-run-installer";

/// File name of the runner's job. Deliberately NOT `swap-job.json`: the two
/// detached helpers share a directory, and a stale job of the wrong shape must
/// fail to parse rather than be half-understood.
const JOB_FILE_NAME: &str = "install-job.json";

/// What the runner needs to know. Everything is decided by the app, while it is
/// still on screen and can still report a problem.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallJob {
    /// The verified package. Only `VerifiedPackage` produces this path.
    pub package: PathBuf,
    /// What to start afterwards — the running copy's own path. An MSI upgrade
    /// replaces the file at that path, so it names the NEW build once the
    /// installer is done and the OLD one if the installer did nothing.
    pub relaunch_exe: PathBuf,
    /// For the forensic line and for deciding whether the breadcrumb on disk is
    /// this attempt's to annotate.
    pub from: String,
    pub to: String,
}

/// `/i` install, `/passive` = a progress bar and no questions. **Not `/quiet`**:
/// a silent install of a package that then wants a reboot, or fails, would give
/// the user no signal at all.
///
/// A function rather than an inline vector so the argument shape can be asserted
/// without running an installer.
fn installer_args(package: &Path) -> Vec<String> {
    vec![
        "/i".to_string(),
        // Passed as ONE argument, unquoted. `Command` does the escaping; adding
        // our own quotes here would produce a literally-quoted path that msiexec
        // cannot open — and the path routinely contains spaces
        // (`C:\Users\<name>\AppData\Local\FlowMic\updates\…`).
        package.display().to_string(),
        "/passive".to_string(),
    ]
}

/// Windows Installer's own success codes.
///
/// `3010` is 「installed, and Windows wants a reboot」 — a success, and treating it
/// as a failure would tell a user their update did not happen when it did. Every
/// other code is not-a-success as far as we are concerned; we do not enumerate
/// them, because the number itself goes into the record and a partial table would
/// only invite an incorrect sentence for the codes it forgot.
fn installer_succeeded(code: Option<i32>) -> bool {
    matches!(code, Some(0) | Some(3010))
}

/// How long the runner will keep looking for the executable after the installer
/// has finished. Windows Installer replaces the file during its own run, so in
/// practice it is there the moment `wait` returns; the budget exists for the
/// machine where a virus scanner holds it for a moment, not for a design where
/// it might never appear.
const RELAUNCH_APPEAR_BUDGET: Duration = Duration::from_secs(30);
const RELAUNCH_POLL: Duration = Duration::from_millis(250);

/// What the runner did, in the words the forensic log and the breadcrumb use.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    /// The installer reported success and something was started.
    InstalledAndRelaunched,
    /// The installer did NOT report success. The user's application was started
    /// anyway (see the header) and the code is on the breadcrumb.
    RefusedButRelaunched { code: Option<i32> },
    /// We could not start anything afterwards. The one outcome where the user is
    /// left looking at nothing, so it is named rather than folded into the above.
    NotRelaunched { detail: String },
    /// msiexec itself never ran.
    InstallerNotStarted { detail: String },
}

/// The runner's sequence, with its machine-dependent parts handed in.
///
/// Parameterised for the same reason `apply_arg::run_swap_with` is: the branches
/// that matter most (a declined UAC prompt, an executable that never comes back)
/// are the ones that cannot be reached from a test if this function insists on
/// starting a real installer and a real process. Production binds all three to
/// the real machine in [`run_install`].
pub(crate) fn run_install_with(
    job: &InstallJob,
    crumb_dir: &Path,
    install: impl FnOnce(&Path) -> std::io::Result<Option<i32>>,
    mut appeared: impl FnMut(&Path) -> bool,
    mut launch: impl FnMut(&Path) -> std::io::Result<u32>,
) -> InstallOutcome {
    crate::forensic::record(
        "update",
        &format!(
            "installer runner start — {} → {} (pid {}), package {}",
            job.from,
            job.to,
            std::process::id(),
            job.package.display()
        ),
    );

    let code = match install(&job.package) {
        Ok(code) => code,
        Err(e) => {
            let detail = format!("installer_not_started:{}", e.kind());
            crate::forensic::record("update", &format!("installer runner — msiexec would not start ({e})"));
            note_outcome_for(&job.to, crumb_dir, &detail);
            // 🔴 Still put the application back. Nothing was installed, so the
            // old build is intact, and 「it closed itself and never came back」 is
            // the complaint this whole card exists to remove.
            let _ = launch(&job.relaunch_exe);
            return InstallOutcome::InstallerNotStarted { detail };
        }
    };

    let ok = installer_succeeded(code);
    crate::forensic::record(
        "update",
        &format!(
            "installer runner — msiexec exited with {} ({})",
            code.map(|c| c.to_string()).unwrap_or_else(|| "no code".to_string()),
            if ok { "success" } else { "NOT a success" }
        ),
    );

    // Wait for the executable to be there. Not for「the version changed」: reading
    // a version off a file we are about to run answers a different question than
    // 「can this be started」, and getting it wrong in the pessimistic direction
    // costs the user their application.
    if !appeared(&job.relaunch_exe) {
        let detail = format!(
            "not_relaunched:missing_exe:{}",
            code.map(|c| c.to_string()).unwrap_or_else(|| "nocode".to_string())
        );
        crate::forensic::record(
            "update",
            &format!(
                "installer runner — {} never appeared; nothing was started",
                job.relaunch_exe.display()
            ),
        );
        note_outcome_for(&job.to, crumb_dir, &detail);
        return InstallOutcome::NotRelaunched { detail };
    }

    match launch(&job.relaunch_exe) {
        Ok(pid) => {
            crate::forensic::record("update", &format!("installer runner relaunched FlowMic (pid {pid})"));
            if ok {
                InstallOutcome::InstalledAndRelaunched
            } else {
                // The app is back, but it is the OLD one. Say so on the
                // breadcrumb, or the next launch reports a completed update.
                note_outcome_for(
                    &job.to,
                    crumb_dir,
                    &format!(
                        "installer_refused:{}",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "nocode".to_string())
                    ),
                );
                InstallOutcome::RefusedButRelaunched { code }
            }
        }
        Err(e) => {
            let detail = format!("not_relaunched:spawn:{}", e.kind());
            crate::forensic::record(
                "update",
                &format!("installer runner could NOT start FlowMic ({e}) — it is installed, it just is not running"),
            );
            note_outcome_for(&job.to, crumb_dir, &detail);
            InstallOutcome::NotRelaunched { detail }
        }
    }
}

/// A thin binding of [`run_install_with`] to this machine.
fn run_install(job: &InstallJob) -> InstallOutcome {
    run_install_with(
        job,
        &crate::app_dirs::local_home(),
        |package| {
            // 🔴 A CHILD, not a detached process: waiting on it is the whole job.
            std::process::Command::new(MSIEXEC)
                .args(installer_args(package))
                .status()
                .map(|s| s.code())
        },
        |exe| {
            let deadline = Instant::now() + RELAUNCH_APPEAR_BUDGET;
            loop {
                if exe.exists() {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(RELAUNCH_POLL);
            }
        },
        |exe| spawn_detached(exe, &[]),
    )
}

/// Stage the runner and start it. Called by the app, just before it exits.
///
/// 🔴 `source_exe` MUST be the currently running binary, for exactly the reason
/// `apply_arg::spawn_mover`'s must: this build's code reads a job this build's
/// code wrote, compiled together, with no cross-version contract in between.
pub fn spawn_installer_runner(job: &InstallJob, source_exe: &Path) -> Result<u32, UpdateFailure> {
    let fail = |detail: String| UpdateFailure::InstallerNotLaunched { detail };
    let dir = super::apply_arg::mover_dir();
    std::fs::create_dir_all(&dir).map_err(|e| fail(format!("mkdir:{}", e.kind())))?;

    let runner = dir.join(super::apply_arg::MOVER_EXE_NAME);
    std::fs::copy(source_exe, &runner).map_err(|e| fail(format!("copy:{}", e.kind())))?;

    let job_path = dir.join(JOB_FILE_NAME);
    let json = serde_json::to_string_pretty(job).map_err(|e| fail(format!("serialize:{e}")))?;
    std::fs::write(&job_path, json).map_err(|e| fail(format!("write_job:{}", e.kind())))?;

    spawn_detached(&runner, &[RUN_INSTALLER_ARG.to_string(), job_path.display().to_string()])
        .map_err(|e| fail(format!("spawn:{}", e.kind())))
}

/// 🔴 The interception point, beside `apply_arg::intercept` and under the same
/// rule: FIRST statement of `run()`, before the single-instance lock, before any
/// window. A runner that took the instance lock would be holding the lock the app
/// it is about to start needs.
pub fn intercept() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(job_path) = job_path_for(RUN_INSTALLER_ARG, &args) else {
        return false;
    };
    crate::forensic::init_default();
    match std::fs::read_to_string(&job_path).ok().and_then(|s| serde_json::from_str::<InstallJob>(&s).ok()) {
        Some(job) => {
            run_install(&job);
        }
        None => crate::forensic::record(
            "update",
            &format!(
                "installer runner started with an unreadable job file at {} — doing nothing",
                job_path.display()
            ),
        ),
    }
    true
}

#[cfg(test)]
#[path = "msi_tests.rs"]
mod tests;
