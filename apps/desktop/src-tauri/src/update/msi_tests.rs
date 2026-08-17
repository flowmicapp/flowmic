// Tests for the MSI hand-off and the installer runner.
//
// 🔴 WHAT THESE CAN AND CANNOT SEE. Nothing here starts msiexec or a real
// process — the three seams of `run_install_with` exist precisely so the
// branches that matter can be driven at all. What that buys, branch by branch:
//   · a declined UAC prompt (msiexec exits 1602) — unreachable in a test that
//     insists on a real installer, and it is the single most likely outcome on a
//     user's machine;
//   · an executable that never comes back — reachable only by lying to the
//     filesystem, which is what a fake `appeared` is;
//   · 「could not start anything」 — the one outcome where the user is left
//     looking at nothing, and therefore the one worth pinning hardest.
// What they cannot judge is whether `msiexec.exe /i <pkg> /passive` actually
// installs anything on Windows. That is a real-install question and it is
// registered as such, not implied by a green run here.

use super::*;
use std::cell::RefCell;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fm-msi-run-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn job() -> InstallJob {
    InstallJob {
        package: PathBuf::from(r"C:\Users\A B\AppData\Local\FlowMic\updates\FlowMic_0.3.8_x64_zh-CN.msi"),
        relaunch_exe: PathBuf::from(r"C:\Program Files\FlowMic\FlowMic.exe"),
        from: "0.3.7".to_string(),
        to: "0.3.8".to_string(),
    }
}

/// A breadcrumb this attempt is entitled to annotate (`to` matches the job).
fn write_crumb(dir: &Path, to: &str) {
    super::super::breadcrumb::write_in(
        dir,
        &super::super::breadcrumb::Breadcrumb {
            from: "0.3.7".to_string(),
            to: to.to_string(),
            kind: super::super::breadcrumb::PendingKind::Msi,
            started_at: "2026-08-17T00:00:00.000Z".to_string(),
            detail: None,
        },
    )
    .unwrap();
}

fn crumb_detail(dir: &Path) -> Option<String> {
    super::super::breadcrumb::read_in(dir).and_then(|c| c.detail)
}

/// 🔴 The package path goes through as ONE argument, unquoted.
///
/// Asserted on the vector rather than on a spawn, because the mistake this
/// guards is invisible at the call site and only shows up as「安装程序打不开
/// 这个文件」("the installer can't open this file") on a machine whose user
/// name has a space in it. Note the literal space in the fixture — that is the
/// whole point of the fixture.
#[test]
fn the_package_path_is_one_unquoted_argument() {
    let p = Path::new(r"C:\Users\A B\AppData\Local\FlowMic\updates\FlowMic_0.2.60_x64_zh-CN.msi");
    let args = installer_args(p);
    assert_eq!(args.len(), 3);
    assert!(!args[1].starts_with('"'), "the path must not carry quotes of our own");
    assert!(args[1].contains("A B"), "the space must survive as part of one argument");
    // /passive, never /quiet — see the module header.
    assert_eq!(args[2], "/passive");
    assert!(!args.iter().any(|a| a == "/quiet"));
}

/// 3010 is「installed, and Windows wants a reboot」. Calling it a failure would
/// tell a user their update did not happen on the one machine where it most
/// visibly did.
#[test]
fn a_reboot_required_install_is_a_success_and_a_declined_one_is_not() {
    assert!(installer_succeeded(Some(0)));
    assert!(installer_succeeded(Some(3010)));
    assert!(!installer_succeeded(Some(1602)), "1602 = the user declined");
    assert!(!installer_succeeded(Some(1603)));
    assert!(!installer_succeeded(None), "killed before it could report is not a success");
}

/// The whole point of the card: close-and-upgrade really brings the app back.
#[test]
fn a_successful_install_starts_the_application_again() {
    let dir = scratch("ok");
    let j = job();
    write_crumb(&dir, &j.to);
    let started = RefCell::new(Vec::<PathBuf>::new());

    let out = run_install_with(
        &j,
        &dir,
        |_| Ok(Some(0)),
        |_| true,
        |exe| {
            started.borrow_mut().push(exe.to_path_buf());
            Ok(4242)
        },
    );

    assert_eq!(out, InstallOutcome::InstalledAndRelaunched);
    assert_eq!(started.borrow().as_slice(), &[j.relaunch_exe.clone()]);
    // Nothing to explain: the update worked, so the breadcrumb keeps its silence
    // and the next launch reports a completed update by version alone.
    assert_eq!(crumb_detail(&dir), None);
}

/// 🔴 The most likely real outcome, and the one the old chain handled worst: the
/// user declines the UAC prompt. Nothing is installed — and they still get their
/// application back, with the reason recorded rather than a silent old version
/// pretending to be new.
#[test]
fn a_declined_uac_prompt_still_gives_the_user_their_application_back() {
    let dir = scratch("declined");
    let j = job();
    write_crumb(&dir, &j.to);
    let started = RefCell::new(0u32);

    let out = run_install_with(
        &j,
        &dir,
        |_| Ok(Some(1602)),
        |_| true,
        |_| {
            *started.borrow_mut() += 1;
            Ok(7)
        },
    );

    assert_eq!(out, InstallOutcome::RefusedButRelaunched { code: Some(1602) });
    assert_eq!(*started.borrow(), 1, "the old build must be started, not left closed");
    assert_eq!(
        crumb_detail(&dir).as_deref(),
        Some("installer_refused:1602"),
        "the next launch must be able to say the update did not complete",
    );
}

/// msiexec would not start at all. Nothing was installed, so the old build is
/// intact — start it.
#[test]
fn an_installer_that_never_starts_does_not_cost_the_user_their_application() {
    let dir = scratch("nostart");
    let j = job();
    write_crumb(&dir, &j.to);
    let started = RefCell::new(0u32);

    let out = run_install_with(
        &j,
        &dir,
        |_| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "msiexec")),
        |_| true,
        |_| {
            *started.borrow_mut() += 1;
            Ok(9)
        },
    );

    assert!(matches!(out, InstallOutcome::InstallerNotStarted { .. }));
    assert_eq!(*started.borrow(), 1);
    assert!(crumb_detail(&dir).unwrap().starts_with("installer_not_started:"));
}

/// The one outcome where the user really is left with nothing. It must be named
/// on the breadcrumb — this is the only channel that survives our exit.
#[test]
fn an_executable_that_never_reappears_is_recorded_and_not_pretended_away() {
    let dir = scratch("gone");
    let j = job();
    write_crumb(&dir, &j.to);
    let started = RefCell::new(0u32);

    let out = run_install_with(
        &j,
        &dir,
        |_| Ok(Some(0)),
        |_| false,
        |_| {
            *started.borrow_mut() += 1;
            Ok(1)
        },
    );

    assert!(matches!(out, InstallOutcome::NotRelaunched { .. }));
    assert_eq!(*started.borrow(), 0, "nothing may be started from a path that is not there");
    assert_eq!(crumb_detail(&dir).as_deref(), Some("not_relaunched:missing_exe:0"));
}

/// A spawn that fails after a good install. The bytes are in place; only the
/// window is missing, and the sentence must say exactly that much.
#[test]
fn a_failed_spawn_after_a_good_install_is_reported_as_installed_but_not_running() {
    let dir = scratch("nospawn");
    let j = job();
    write_crumb(&dir, &j.to);

    let out = run_install_with(
        &j,
        &dir,
        |_| Ok(Some(0)),
        |_| true,
        |_| Err(std::io::Error::other("denied")),
    );

    assert!(matches!(out, InstallOutcome::NotRelaunched { .. }));
    assert!(crumb_detail(&dir).unwrap().starts_with("not_relaunched:spawn:"));
}

/// 🔴 Somebody else's breadcrumb is not ours to annotate. Two updates cannot be
/// in flight at once by design, but a stale file from a previous attempt can be,
/// and overwriting it would put this run's verdict on that run's versions.
#[test]
fn a_breadcrumb_for_a_different_version_is_left_alone() {
    let dir = scratch("other");
    write_crumb(&dir, "9.9.9");

    run_install_with(&job(), &dir, |_| Ok(Some(1602)), |_| true, |_| Ok(1));

    assert_eq!(crumb_detail(&dir), None, "the other attempt's breadcrumb must be untouched");
}

/// The runner's flag parses with both spellings, through the SAME parser the
/// mover uses — one implementation, so they cannot acquire different opinions.
#[test]
fn the_runner_flag_is_read_by_the_shared_parser() {
    let space = vec![RUN_INSTALLER_ARG.to_string(), r"C:\j\install-job.json".to_string()];
    let equals = vec![format!("{RUN_INSTALLER_ARG}=C:\\j\\install-job.json")];
    assert_eq!(
        job_path_for(RUN_INSTALLER_ARG, &space),
        Some(PathBuf::from(r"C:\j\install-job.json")),
    );
    assert_eq!(
        job_path_for(RUN_INSTALLER_ARG, &equals),
        Some(PathBuf::from(r"C:\j\install-job.json")),
    );
    // A normal launch must never be mistaken for a runner.
    assert_eq!(job_path_for(RUN_INSTALLER_ARG, &["--flowmic-autostart".to_string()]), None);
    // And the two flags must not answer for each other.
    assert_eq!(job_path_for(super::super::apply_arg::APPLY_UPDATE_ARG, &space), None);
}
