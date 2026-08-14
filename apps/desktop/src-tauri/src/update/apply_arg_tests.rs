// Tests for `apply_arg.rs` — the mover's contract with itself.
//
// 🔴 The important one here is `the_mover_is_intercepted_before_the_instance_lock`,
// which reads `lib.rs` as DATA. Nothing about the types, and no other test in this
// crate, would go red if those two lines were swapped — and swapping them produces
// a DEADLOCK against the very process the mover is waiting for.

use super::*;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fm-update-mover-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn the_flag_is_recognised_in_both_spellings() {
    assert_eq!(
        job_path_from_args(&args(&["FlowMic.exe", APPLY_UPDATE_ARG, "C:\\j.json"])),
        Some(PathBuf::from("C:\\j.json")),
    );
    assert_eq!(
        job_path_from_args(&args(&["FlowMic.exe", &format!("{APPLY_UPDATE_ARG}=C:\\j.json")])),
        Some(PathBuf::from("C:\\j.json")),
    );
}

/// 🔴 A normal launch must not be mistaken for a mover — including the OTHER
/// flag this binary already understands. A false positive here means the app
/// silently refuses to start.
#[test]
fn an_ordinary_launch_is_never_a_mover() {
    assert_eq!(job_path_from_args(&args(&["FlowMic.exe"])), None);
    assert_eq!(job_path_from_args(&args(&["FlowMic.exe", "--flowmic-autostart"])), None);
    // A flag with no value is not a job. Starting a mover with nothing to move
    // would make it wait 90 seconds and then annotate somebody's breadcrumb.
    assert_eq!(job_path_from_args(&args(&["FlowMic.exe", APPLY_UPDATE_ARG])), None);
    assert_eq!(job_path_from_args(&args(&["FlowMic.exe", &format!("{APPLY_UPDATE_ARG}=")])), None);
    // A prefix that merely starts the same way is a different flag.
    assert_eq!(job_path_from_args(&args(&["FlowMic.exe", "--flowmic-apply-update-later", "x"])), None);
}

/// 🔴🔴 THE ORDERING GUARD.
///
/// The mover intercept must appear in `run()` BEFORE `single_instance::acquire`.
/// If it does not, the mover asks for a lock the app still holds, is refused,
/// returns early, and never performs the swap — while the app has already exited
/// expecting to be replaced. Nothing times out. Nothing is logged as a failure.
/// The user sees an update that silently never happens.
///
/// Read as data because there is no type, trait or ordinary test that can see
/// statement order inside a function. This is the same technique
/// `form_tests.rs` uses against `publish.mjs`, applied to our own source.
#[test]
fn the_mover_is_intercepted_before_the_instance_lock() {
    let lib = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("lib.rs");
    let raw = std::fs::read_to_string(&lib)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", lib.display()));

    // 🔴 COMMENTS ARE STRIPPED FIRST, and this is not a detail — the first
    // version of this test did not do it and was RED on correct code. The
    // intercept call site carries a long comment explaining that it must not be
    // moved below `single_instance::acquire`, so a raw text search found that
    // PROSE at byte 6089 and the real call at 7094, and concluded the order was
    // wrong. A literal-anchor guard that reads comments is asserting something
    // about the documentation, not about the program — and the comment most
    // likely to fool it is the one written to explain the very rule it guards.
    let text: String = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    let intercept = text.find("apply_arg::intercept()").unwrap_or_else(|| {
        panic!(
            "`run()` in {} no longer calls the mover intercept. If it moved, the swap chain is \
             broken: a process started with {APPLY_UPDATE_ARG} would run the whole application \
             instead of moving anything",
            lib.display(),
        )
    });
    let acquire = text.find("single_instance::acquire").unwrap_or_else(|| {
        panic!("`run()` in {} no longer acquires the instance lock", lib.display())
    });
    assert!(
        intercept < acquire,
        "the mover intercept (byte {intercept}) must come BEFORE single_instance::acquire \
         (byte {acquire}) — a lock-gated mover deadlocks against the app it is waiting for",
    );

    // …and before the window/sidecar bring-up, for the same family of reasons.
    if let Some(builder) = text.find("tauri::Builder::default()") {
        assert!(intercept < builder, "the mover must never reach the Tauri builder");
    }
}

/// A job written by the app is read back by the mover — same `derive`, same
/// build. This is what「no CLI contract between two versions」means in practice.
#[test]
fn a_job_survives_the_trip_through_a_file() {
    let dir = tmp("job");
    let install = dir.join("FlowMic");
    std::fs::create_dir_all(&install).unwrap();
    let job = super::super::swap::plan(&install, "0.2.60", "0.2.59", "FlowMic-portable").unwrap();

    let p = dir.join("job.json");
    std::fs::write(&p, serde_json::to_string_pretty(&job).unwrap()).unwrap();
    assert_eq!(read_job(&p).unwrap(), job);
}

/// 🔴 An unreadable job makes the mover do NOTHING — it must never guess at
/// paths. A mover that improvised a target would be renaming directories chosen
/// by a parse error.
#[test]
fn an_unreadable_job_is_not_improvised() {
    let dir = tmp("badjob");
    let p = dir.join("job.json");
    std::fs::write(&p, b"{ nope").unwrap();
    assert!(read_job(&p).is_none());
    assert!(read_job(&dir.join("absent.json")).is_none());
}

/// The mover runs from OUTSIDE the install directory, and its copy is named so
/// it can never be mistaken for an install.
///
/// Structural: the install directory is the thing being renamed away, so a mover
/// living inside it would be renaming the ground it stands on — and its own image
/// lock would be why the rename fails.
#[test]
fn the_mover_lives_outside_any_install_directory() {
    let d = mover_dir();
    let s = d.to_string_lossy().replace('\\', "/");
    assert!(s.ends_with("/updates/mover"), "unexpected mover dir: {s}");
    // The RUN directory is `…/Programs/FlowMic` (scripts/install-local.mjs); the
    // mover must not be under it. One path segment separates the two roots and
    // that separation is the point.
    assert!(!s.contains("/Programs/"), "the mover must not live in the run directory: {s}");
    assert_ne!(MOVER_EXE_NAME, super::super::form::PORTABLE_EXE_NAME);
    assert_ne!(MOVER_EXE_NAME, super::super::form::MSI_EXE_NAME);
}
